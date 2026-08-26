import { existsSync } from "node:fs";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SqliteRow {
	[column: string]: unknown;
}

export interface SqliteStatementLike {
	all(...params: unknown[]): SqliteRow[];
}

export interface SqliteDatabaseLike {
	prepare(sql: string): SqliteStatementLike;
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
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		sqliteModule = require("node:sqlite") as {
			DatabaseSync: SqliteDatabaseConstructor;
		};
	} catch {
		sqliteModule = undefined;
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
		private readonly sqliteOverride?: { DatabaseSync: SqliteDatabaseConstructor } | null,
	) {}

	private open(): SqliteDatabaseLike | null {
		if (this.db) return this.db;
		if (!this.dbPath) return null;

		const sqlite =
			this.sqliteOverride !== undefined
				? this.sqliteOverride ?? undefined
				: loadSqlite();
		if (!sqlite) return null;
		if (!existsSync(this.dbPath)) return null;

		try {
			this.db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true });
			return this.db;
		} catch {
			// Transient (locked/compacted file): fall back and retry next time.
			this.db = null;
			return null;
		}
	}

	querySync(sql: string, params: unknown[] = []): unknown[] {
		const db = this.open();
		if (db) {
			try {
				return db.prepare(sql).all(...params);
			} catch {
				// Fall through to the CLI net below.
			}
		}
		if (this.cli) {
			try {
				return this.cli.execSync(interpolate(sql, params));
			} catch {
				return [];
			}
		}
		return [];
	}

	async queryAsync(sql: string, params: unknown[] = []): Promise<unknown[]> {
		const db = this.open();
		if (db) {
			try {
				return db.prepare(sql).all(...params);
			} catch {
				// Fall through to the CLI net below.
			}
		}
		if (this.cli) {
			try {
				return await this.cli.execAsync(interpolate(sql, params));
			} catch {
				return [];
			}
		}
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

let cachedOpenCodeDbPath: string | undefined | null = null;

/**
 * Resolve the OpenCode SQLite database path through `opencode db path` exactly
 * once. The CLI is the source of truth for the location, but the result is
 * cached so no read path ever re-runs it.
 */
export function resolveOpenCodeDbPath(): string | undefined {
	if (cachedOpenCodeDbPath !== null) return cachedOpenCodeDbPath;
	try {
		const raw = execSync("opencode db path", {
			encoding: "utf-8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		cachedOpenCodeDbPath = raw || undefined;
	} catch {
		cachedOpenCodeDbPath = undefined;
	}
	return cachedOpenCodeDbPath;
}

/** Build the OpenCode CLI fallback (used only when direct SQLite is unavailable). */
export function openCodeCliFallback(): SqliteCliFallback {
	return {
		execSync: (sql) => {
			const raw = execSync(`opencode db "${sql}" --format json`, {
				encoding: "utf-8",
				timeout: 5_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const rows: unknown = JSON.parse(raw);
			return Array.isArray(rows) ? rows : [];
		},
		execAsync: async (sql) => {
			const { stdout } = await execFileAsync(
				"opencode",
				["db", sql, "--format", "json"],
				{ encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
			);
			const rows: unknown = JSON.parse(stdout);
			return Array.isArray(rows) ? rows : [];
		},
	};
}
