import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProviderSessionAdapter } from "../providers/types";
import { SqliteReadOnlyDb } from "./sqliteRead";
import type { SessionInfo } from "./types";

const execFileAsync = promisify(execFile);

interface HermesBreadcrumb {
	session_id?: unknown;
	cwd?: unknown;
	ts?: unknown;
}

/** Hermes records the owning session and cwd for every interactive terminal. */
export class HermesSessionProvider implements ProviderSessionAdapter {
	readonly toolId = "hermes";
	private readonly home: string;
	private readonly sqlite: SqliteReadOnlyDb;

	constructor(hermesHome?: string) {
		this.home =
			hermesHome ??
			process.env.HERMES_HOME ??
			path.join(os.homedir(), ".hermes");
		this.sqlite = new SqliteReadOnlyDb(path.join(this.home, "state.db"));
	}

	private get breadcrumbDirectory(): string {
		return path.join(this.home, "terminal-sessions");
	}

	readonly async = {
		scanSessions: async (): Promise<SessionInfo[]> => this.scanSessionsAsync(),
		hasSession: async (sessionId: string): Promise<boolean> =>
			this.hasSessionAsync(sessionId),
		readName: async (sessionId: string): Promise<string | null> =>
			this.readNameAsync(sessionId),
	};

	scanSessions(): SessionInfo[] {
		const titles = this.readSessionTitles();
		const sessions = new Map<string, SessionInfo>();
		for (const breadcrumb of this.readBreadcrumbs()) {
			if (!breadcrumb.sessionId || !breadcrumb.projectPath) continue;
			sessions.set(breadcrumb.sessionId, {
				sessionId: breadcrumb.sessionId,
				prompt: titles.get(breadcrumb.sessionId) ?? "",
				created: breadcrumb.created,
				projectPath: breadcrumb.projectPath,
			});
		}
		return [...sessions.values()];
	}

	readName(sessionId: string): string | null {
		if (!isSafeSessionId(sessionId)) return null;
		const title = this.readTitleFromDb(sessionId);
		if (title) return title;
		return hermesExportTitle(sessionId);
	}

	private async readNameAsync(sessionId: string): Promise<string | null> {
		if (!isSafeSessionId(sessionId)) return null;
		const title = await this.readTitleFromDbAsync(sessionId);
		if (title) return title;
		return hermesExportTitleAsync(sessionId);
	}

	private readTitleFromDb(sessionId: string): string | null {
		const rows = this.sqlite.querySync(
			"SELECT title FROM sessions WHERE id = ?",
			[sessionId],
		);
		const title = (rows[0] as Record<string, unknown> | undefined)?.title;
		return typeof title === "string" && title.trim() ? title.trim() : null;
	}

	private async readTitleFromDbAsync(
		sessionId: string,
	): Promise<string | null> {
		const rows = await this.sqlite.queryAsync(
			"SELECT title FROM sessions WHERE id = ?",
			[sessionId],
		);
		const title = (rows[0] as Record<string, unknown> | undefined)?.title;
		return typeof title === "string" && title.trim() ? title.trim() : null;
	}

	/**
	 * SQLite-first existence check; the `hermes sessions export --dry-run`
	 * subprocess is only spawned when state.db is unreadable, so a readable
	 * database answers both `true` and `false` without any CLI cost.
	 */
	hasSession(sessionId: string): boolean {
		if (!isSafeSessionId(sessionId)) return false;
		const answered = this.hasSessionViaDb(sessionId);
		if (answered !== null) return answered;
		return hermesDryRunHasSession(sessionId);
	}

	private async hasSessionAsync(sessionId: string): Promise<boolean> {
		if (!isSafeSessionId(sessionId)) return false;
		const answered = await this.hasSessionViaDbAsync(sessionId);
		if (answered !== null) return answered;
		return hermesDryRunHasSessionAsync(sessionId);
	}

	private hasSessionViaDb(sessionId: string): boolean | null {
		const rows = this.sqlite.querySync(
			"SELECT 1 AS ok FROM sessions WHERE id = ? LIMIT 1",
			[sessionId],
		);
		return dbAnswered(this.sqlite, rows);
	}

	private async hasSessionViaDbAsync(
		sessionId: string,
	): Promise<boolean | null> {
		const rows = await this.sqlite.queryAsync(
			"SELECT 1 AS ok FROM sessions WHERE id = ? LIMIT 1",
			[sessionId],
		);
		return dbAnswered(this.sqlite, rows);
	}

	private async scanSessionsAsync(): Promise<SessionInfo[]> {
		const titles = await this.readSessionTitlesAsync();
		const sessions = new Map<string, SessionInfo>();
		for (const breadcrumb of await this.readBreadcrumbsAsync()) {
			if (!breadcrumb.sessionId || !breadcrumb.projectPath) continue;
			sessions.set(breadcrumb.sessionId, {
				sessionId: breadcrumb.sessionId,
				prompt: titles.get(breadcrumb.sessionId) ?? "",
				created: breadcrumb.created,
				projectPath: breadcrumb.projectPath,
			});
		}
		return [...sessions.values()];
	}

	/** One indexed pass over state.db: names for the picker at zero subprocess cost. */
	private readSessionTitles(): Map<string, string> {
		return toTitleMap(this.sqlite.querySync("SELECT id, title FROM sessions"));
	}

	private async readSessionTitlesAsync(): Promise<Map<string, string>> {
		return toTitleMap(
			await this.sqlite.queryAsync("SELECT id, title FROM sessions"),
		);
	}

	private readBreadcrumbs(): Array<{
		sessionId: string;
		projectPath: string;
		created: string;
	}> {
		const directory = this.breadcrumbDirectory;
		let names: string[];
		try {
			names = fs.readdirSync(directory);
		} catch {
			return [];
		}

		const result: Array<{
			sessionId: string;
			projectPath: string;
			created: string;
		}> = [];
		for (const name of names) {
			try {
				const value = JSON.parse(
					fs.readFileSync(path.join(directory, name), "utf8"),
				) as HermesBreadcrumb;
				const sessionId =
					typeof value.session_id === "string" ? value.session_id : "";
				const projectPath = typeof value.cwd === "string" ? value.cwd : "";
				if (!sessionId || !projectPath) continue;
				const timestamp = typeof value.ts === "number" ? value.ts * 1000 : 0;
				result.push({
					sessionId,
					projectPath,
					created: timestamp > 0 ? new Date(timestamp).toISOString() : "",
				});
			} catch {
				// A concurrently rewritten breadcrumb is ignored until the next pass.
			}
		}
		return result;
	}

	private async readBreadcrumbsAsync(): Promise<
		Array<{ sessionId: string; projectPath: string; created: string }>
	> {
		const directory = this.breadcrumbDirectory;
		let names: string[];
		try {
			names = await fsp.readdir(directory);
		} catch {
			return [];
		}
		const result: Array<{
			sessionId: string;
			projectPath: string;
			created: string;
		}> = [];
		for (const name of names) {
			try {
				const value = JSON.parse(
					await fsp.readFile(path.join(directory, name), "utf8"),
				) as HermesBreadcrumb;
				const sessionId =
					typeof value.session_id === "string" ? value.session_id : "";
				const projectPath = typeof value.cwd === "string" ? value.cwd : "";
				if (!sessionId || !projectPath) continue;
				const timestamp = typeof value.ts === "number" ? value.ts * 1000 : 0;
				result.push({
					sessionId,
					projectPath,
					created: timestamp > 0 ? new Date(timestamp).toISOString() : "",
				});
			} catch {
				// A concurrently rewritten breadcrumb is ignored until the next pass.
			}
		}
		return result;
	}

	dispose(): void {
		this.sqlite.dispose();
	}
}

function isSafeSessionId(sessionId: string): boolean {
	return /^[a-zA-Z0-9_-]+$/u.test(sessionId);
}

/**
 * Distinguish "state.db answered: no such row" from "state.db unreadable":
 * a readable database is authoritative, an unavailable one defers to the CLI.
 */
function dbAnswered(sqlite: SqliteReadOnlyDb, rows: unknown[]): boolean | null {
	if (rows.length > 0) return true;
	return sqlite.querySync("SELECT 1 AS ok").length > 0 ? false : null;
}

/** Titles from state.db keyed by session id; blank titles are dropped. */
function toTitleMap(rows: unknown[]): Map<string, string> {
	const titles = new Map<string, string>();
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const record = row as Record<string, unknown>;
		if (typeof record.id !== "string" || !record.id) continue;
		if (typeof record.title !== "string" || !record.title.trim()) continue;
		titles.set(record.id, record.title.trim());
	}
	return titles;
}

function hermesDryRunHasSession(sessionId: string): boolean {
	try {
		const output = execFileSync(
			"hermes",
			[
				"sessions",
				"export",
				"--dry-run",
				"--session-id",
				sessionId,
				"--format",
				"jsonl",
				"-",
			],
			{ encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
		);
		return /Would export 1 session/u.test(output);
	} catch {
		return false;
	}
}

async function hermesDryRunHasSessionAsync(
	sessionId: string,
): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"hermes",
			[
				"sessions",
				"export",
				"--dry-run",
				"--session-id",
				sessionId,
				"--format",
				"jsonl",
				"-",
			],
			{ encoding: "utf8", timeout: 5_000 },
		);
		return /Would export 1 session/u.test(stdout);
	} catch {
		return false;
	}
}

function hermesExportTitle(sessionId: string): string | null {
	try {
		const raw = execFileSync(
			"hermes",
			[
				"sessions",
				"export",
				"--session-id",
				sessionId,
				"--format",
				"jsonl",
				"-",
			],
			{ encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
		);
		return parseExportTitle(raw);
	} catch {
		return null;
	}
}

async function hermesExportTitleAsync(
	sessionId: string,
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"hermes",
			[
				"sessions",
				"export",
				"--session-id",
				sessionId,
				"--format",
				"jsonl",
				"-",
			],
			{ encoding: "utf8", timeout: 5_000 },
		);
		return parseExportTitle(stdout);
	} catch {
		return null;
	}
}

function parseExportTitle(raw: string): string | null {
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const data = JSON.parse(line) as Record<string, unknown>;
			const title = data.title;
			if (typeof title === "string" && title.trim()) return title.trim();
		} catch {
			// Ignore malformed lines.
		}
	}
	return null;
}
