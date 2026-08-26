import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Cap aligned across the sync and async CLI paths (truncated JSON fails parse -> []). */
const CLI_MAX_BUFFER = 4 * 1024 * 1024;

/** How long a failed db-path resolution is cached before retrying (ms). */
const DB_PATH_RETRY_TTL = 60_000;

// ---------------------------------------------------------------------------
// Fallback observability — one-shot events
// ---------------------------------------------------------------------------

export type FallbackEventKind =
	| "sqlite_module_unavailable"
	| "db_missing"
	| "open_failed"
	| "query_failed";

export type FallbackReporter = (kind: FallbackEventKind) => void;

let fallbackReporter: FallbackReporter | null = null;
const reportedKinds = new Set<FallbackEventKind>();

/** Register a one-shot reporter for fallback events. */
export function setFallbackReporter(reporter: FallbackReporter): void {
	fallbackReporter = reporter;
}

/** Reset one-shot state so the same event can fire again.  Test-only. */
export function resetFallbackReporting(): void {
	reportedKinds.clear();
}

/** Reset the OpenCode DB path cache.  Test-only. */
export function resetOpenCodeDbPathCache(): void {
	cachedOpenCodeDbPath = undefined;
	lastDbPathFailureAt = 0;
}

function reportFallback(kind: FallbackEventKind): void {
	if (reportedKinds.has(kind)) return;
	reportedKinds.add(kind);
	if (fallbackReporter) fallbackReporter(kind);
}

export interface SqliteRow {
	[column: string]: unknown;
}

export interface SqliteStatementLike {
	all(...params: unknown[]): SqliteRow[];
}

export interface SqliteDatabaseLike {
	prepare(sql: string): SqliteStatementLike;
	exec(sql: string): void;
	close(): void;
}

type SqliteDatabaseConstructor = new (
	path: string,
	options?: { readOnly?: boolean },
) => SqliteDatabaseLike;

export type SqliteModule = { DatabaseSync: SqliteDatabaseConstructor };

export interface SqliteCliFallback {
	/** Synchronous CLI query used only when the in-process SQLite read is unavailable. */
	execSync(sql: string): unknown[];
	/** Asynchronous CLI query used only on the async observation path. */
	execAsync(sql: string): Promise<unknown[]>;
}

/**
 * Load `node:sqlite` defensively. Older extension-host runtimes predate it, so
 * callers must always provide a CLI fallback. The result is memoized: once the
 * module is found (or confirmed missing) we never re-require it.
 */
let sqliteModule: { DatabaseSync: SqliteDatabaseConstructor } | undefined;
let sqliteModuleChecked = false;

export function loadSqlite():
	| { DatabaseSync: SqliteDatabaseConstructor }
	| undefined {
	if (sqliteModuleChecked) return sqliteModule;
	sqliteModuleChecked = true;
	try {
		sqliteModule = require("node:sqlite") as {
			DatabaseSync: SqliteDatabaseConstructor;
		};
	} catch {
		sqliteModule = undefined;
		reportFallback("sqlite_module_unavailable");
	}
	return sqliteModule;
}

/**
 * Read-only SQLite handle with a subprocess CLI fallback.
 *
 * The in-process `node:sqlite` read is the normal path; a single connection is
 * opened lazily and reused. A transient open/read failure (e.g. a briefly locked
 * WAL file) is NEVER sticky: we fall back for that call and retry the direct
 * read on the next call, so the provider recovers on its own instead of staying
 * broken until restart. The CLI fallback is exclusively a compatibility net, not
 * a contention strategy — it must not be the steady-state path.
 */
export class SqliteReadOnlyDb {
	private db: SqliteDatabaseLike | null = null;

	constructor(
		private readonly dbPath: string | undefined,
		private readonly cli?: SqliteCliFallback,
		private readonly sqliteOverride?: {
			DatabaseSync: SqliteDatabaseConstructor;
		} | null,
	) {}

	private open(): SqliteDatabaseLike | null {
		if (this.db) return this.db;
		if (!this.dbPath) {
			reportFallback("db_missing");
			return null;
		}

		const sqlite =
			this.sqliteOverride !== undefined
				? (this.sqliteOverride ?? undefined)
				: loadSqlite();
		if (!sqlite) {
			reportFallback("sqlite_module_unavailable");
			return null;
		}
		if (!existsSync(this.dbPath)) {
			reportFallback("db_missing");
			return null;
		}

		try {
			this.db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true });
			// Belt and braces: enforce read-only even on runtimes that ignore the
			// constructor option (unknown options are silently dropped pre-22.x).
			this.db.exec("PRAGMA query_only = ON");
			return this.db;
		} catch {
			// Transient (locked/compacted file): fall back and retry next time.
			reportFallback("open_failed");
			try {
				this.db?.close();
			} catch {
				// best-effort
			}
			this.db = null;
			return null;
		}
	}

	querySync(sql: string, params: unknown[] = []): unknown[] {
		const db = this.open();
		let sqliteFailed = !db;
		if (db) {
			try {
				return db.prepare(sql).all(...params);
			} catch {
				// Fall through to the CLI net below.
				sqliteFailed = true;
			}
		}
		if (this.cli) {
			try {
				const rows = this.cli.execSync(interpolate(sql, params));
				if (sqliteFailed) reportFallback("query_failed");
				return rows;
			} catch {
				return [];
			}
		}
		reportFallback("query_failed");
		return [];
	}

	async queryAsync(sql: string, params: unknown[] = []): Promise<unknown[]> {
		const db = this.open();
		let sqliteFailed = !db;
		if (db) {
			try {
				return db.prepare(sql).all(...params);
			} catch {
				// Fall through to the CLI net below.
				sqliteFailed = true;
			}
		}
		if (this.cli) {
			try {
				const rows = await this.cli.execAsync(interpolate(sql, params));
				if (sqliteFailed) reportFallback("query_failed");
				return rows;
			} catch {
				return [];
			}
		}
		reportFallback("query_failed");
		return [];
	}

	dispose(): void {
		if (this.db) {
			try {
				this.db.close();
			} catch {
				// best-effort
			}
			this.db = null;
		}
	}
}

/**
 * Render a parameterized statement for a CLI that does not support bound
 * parameters. Every value reaching this point is provider-controlled (a
 * `isSafeSessionId`-validated session id or a hard-coded literal), so a simple
 * single-quote escape is sufficient and safe.
 */
function interpolate(sql: string, params: unknown[]): string {
	let i = 0;
	return sql.replace(/\?/g, () => {
		const value = params[i++];
		if (typeof value === "number" && Number.isFinite(value)) {
			return String(value);
		}
		return `'${String(value ?? "").replace(/'/g, "''")}'`;
	});
}

/**
 * Resolve the OpenCode SQLite database path through `opencode db path`.
 * A successful result is cached for the process lifetime.  A failed attempt is
 * cached for {@link DB_PATH_RETRY_TTL} ms so the extension can recover if
 * opencode is installed after the extension host starts.
 *
 * Triple-state cache:
 * - `undefined` = never tried or failure cached (fall through to TTL check / execFileSync)
 * - `string`    = success cached (return immediately, never retry)
 */
let cachedOpenCodeDbPath: string | undefined;
let lastDbPathFailureAt = 0;

/** @internal Visible for testing only. */
export function resolveOpenCodeDbPath(
	execFn: typeof execFileSync = execFileSync,
): string | undefined {
	if (cachedOpenCodeDbPath !== undefined) return cachedOpenCodeDbPath;
	if (
		lastDbPathFailureAt > 0 &&
		Date.now() - lastDbPathFailureAt < DB_PATH_RETRY_TTL
	) {
		return undefined;
	}
	try {
		const raw = execFn("opencode", ["db", "path"], {
			encoding: "utf-8",
			timeout: 5_000,
			maxBuffer: CLI_MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		cachedOpenCodeDbPath = raw || undefined;
		lastDbPathFailureAt = 0;
	} catch {
		cachedOpenCodeDbPath = undefined;
		lastDbPathFailureAt = Date.now();
		return undefined;
	}
	return cachedOpenCodeDbPath;
}

/**
 * Build the OpenCode CLI fallback (used only when direct SQLite is unavailable).
 * Both paths spawn argument vectors (never a shell), so provider-controlled SQL
 * can never reach an interpreter.
 */
export function openCodeCliFallback(): SqliteCliFallback {
	return {
		execSync: (sql) => {
			const raw = execFileSync("opencode", ["db", sql, "--format", "json"], {
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: CLI_MAX_BUFFER,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const rows: unknown = JSON.parse(raw);
			return Array.isArray(rows) ? rows : [];
		},
		execAsync: async (sql) => {
			const { stdout } = await execFileAsync(
				"opencode",
				["db", sql, "--format", "json"],
				{ encoding: "utf8", timeout: 5_000, maxBuffer: CLI_MAX_BUFFER },
			);
			const rows: unknown = JSON.parse(stdout);
			return Array.isArray(rows) ? rows : [];
		},
	};
}
