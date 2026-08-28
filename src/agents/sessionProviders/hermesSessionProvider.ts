import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
	ProviderAttentionSignal,
	ProviderSessionAdapter,
} from "../providers/types";
import { TmuxIntegration } from "../tmux";
import { SqliteReadOnlyDb } from "./sqliteRead";
import type { SessionCorrelationContext, SessionInfo } from "./types";

const execFileAsync = promisify(execFile);

interface HermesBreadcrumb {
	session_id?: unknown;
	cwd?: unknown;
	ts?: unknown;
}

/**
 * Resolves the pty device path of an Agent Space tmux pane. Mirrors the
 * terminal identity simply that Hermes computes inside the pane, so Agent Space
 * can derive the exact `$HERMES_HOME/terminal-sessions/<terminal-id>` of its
 * own agent's two panes. Injected so unit tests can substitute a fixed pane
 * tty without talking to tmux.
 */
export interface HermesPaneTtyResolver {
	getPaneTty?(sessionName: string): string | null;
	getPaneTtyAsync?(sessionName: string): Promise<string | null>;
}

/**
 * The env vars Hermes consults (in order) when it cannot derive a tty path —
 * mirrored verbatim from `hermes_cli/terminal_breadcrumbs.py`.
 */
const HERMES_TERMINAL_ENV_VARS = [
	"ZELLIJ_PANE_ID",
	"TMUX_PANE",
	"KITTY_WINDOW_ID",
	"WEZTERM_PANE",
	"TERM_SESSION_ID",
	"WT_SESSION",
] as const;

/** Failure end-reasons Hermes natively records on a session row. */
const HERMES_FAILURE_END_REASONS = new Set([
	"error",
	"failed",
	"failure",
	"crash",
	"exception",
	"tool_error",
	"interrupted_by_error",
]);

/** Hermes records the owning session and cwd for every interactive terminal. */
export class HermesSessionProvider implements ProviderSessionAdapter {
	readonly toolId = "hermes";
	private readonly home: string;
	private readonly sqlite: SqliteReadOnlyDb;
	private readonly paneTty: HermesPaneTtyResolver;
	private sessionColumns: string[] | undefined;

	constructor(hermesHome?: string, paneTtyResolver?: HermesPaneTtyResolver) {
		this.home =
			hermesHome ??
			process.env.HERMES_HOME ??
			path.join(os.homedir(), ".hermes");
		this.sqlite = new SqliteReadOnlyDb(path.join(this.home, "state.db"));
		this.paneTty = paneTtyResolver ?? new TmuxIntegration();
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
		correlateOwnedSession: async (
			context: SessionCorrelationContext,
		): Promise<string | undefined> => this.correlateOwnedSessionAsync(context),
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

	/**
	 * Exact, deterministic Hermes ownership proof (issue #120 section A / PR3).
	 *
	 * Agent Space launches each Hermes agent inside its own dedicated tmux
	 * session (`agent-space-<feature>-<agent>`). Hermes, in turn, drops one
	 * per-terminal breadcrumb under `$HERMES_HOME/terminal-sessions/<terminal-id>`
	 * keyed by the pane's tty device path (mirroring its own
	 * `get_terminal_id()`). By reading this agent's own pane tty and deriving
	 * the same terminal id, Agent Space proves exactly which Hermes session
	 * belongs to this agent's pane — no newest-session, cwd, order or count
	 * heuristic. It is fail-closed: without a readable pane tty, a matching
	 * breadcrumb, or a session that still exists and is not already owned, it
	 * returns `undefined` rather than adopting an ambiguous session.
	 */
	correlateOwnedSession(
		context: SessionCorrelationContext,
	): string | undefined {
		const terminalId = this.resolveTerminalId(context.tmuxSession);
		if (!terminalId) return undefined;
		const crumb = this.readBreadcrumbFile(terminalId);
		if (!crumb) return undefined;
		const sessionId =
			typeof crumb.session_id === "string" ? crumb.session_id : "";
		if (!sessionId) return undefined;
		// Already attributed to another agent (or in the pre-launch baseline) —
		// never adopt it; ownership must be exclusive.
		if (context.knownSessionIds.has(sessionId)) return undefined;
		// The session must still exist in the Hermes store, or the breadcrumb is
		// reporting a deleted parent.
		if (!this.hasSession(sessionId)) return undefined;
		return sessionId;
	}

	private async correlateOwnedSessionAsync(
		context: SessionCorrelationContext,
	): Promise<string | undefined> {
		const terminalId = await this.resolveTerminalIdAsync(context.tmuxSession);
		if (!terminalId) return undefined;
		const crumb = this.readBreadcrumbFile(terminalId);
		if (!crumb) return undefined;
		const sessionId =
			typeof crumb.session_id === "string" ? crumb.session_id : "";
		if (!sessionId) return undefined;
		if (context.knownSessionIds.has(sessionId)) return undefined;
		// Async-only existence check so the background binder path never blocks
		// the Extension Host on a subprocess (a readable store answers without
		// spawning anything).
		if (!(await this.hasSessionAsync(sessionId))) return undefined;
		return sessionId;
	}

	/**
	 * Hermes-native structured attention for the dimensions its durable store
	 * records authoritatively. A session whose row shows a `ended_at` and a
	 * failure `end_reason` is a real Hermes-terminating failure (never an
	 * inference from terminal silence). For every other state
	 * (`working`, `waiting_for_user`, `idle`/`turn_completed`) Hermes does not
	 * persist an authoritative phase, so Agent Space deliberately reports
	 * nothing (→ `unknown`/`unsupported`) instead of inventing one.
	 */
	getAttentionSignal(sessionId: string): ProviderAttentionSignal | undefined {
		if (!isSafeSessionId(sessionId)) return undefined;
		const { endedAt, endReason } = this.readSessionEnd(sessionId);
		// A failure is only a Hermes-native fact when the session actually
		// terminated (`ended_at`) with a failure `end_reason`. An active session
		// (no end) is never reported as failed, and no other state is invented.
		if (
			endedAt != null &&
			endReason &&
			HERMES_FAILURE_END_REASONS.has(endReason)
		) {
			return {
				status: "failed",
				evidence: `Hermes session ended (${endReason})`,
			};
		}
		return undefined;
	}

	async getAttentionSignalAsync(
		sessionId: string,
	): Promise<ProviderAttentionSignal | undefined> {
		return this.getAttentionSignal(sessionId);
	}

	/**
	 * Derive the Hermes terminal id for an Agent Space tmux session by reading
	 * the pane's pty path. Within tmux the pane always owns a pty, so this
	 * mirrors the tty-device branch of Hermes' `get_terminal_id()` exactly.
	 *
	 * Ownership proof must come EXCLUSIVELY from the pane identified by
	 * `context.tmuxSession`. If that pane has no readable tty, return
	 * `undefined` — never fall back to `process.env` (the Extension Host's own
	 * terminal, which could be a *different* tmux/zellij pane with a valid but
	 * unrelated Hermes session).
	 */
	private resolveTerminalId(tmuxSession?: string): string | undefined {
		if (!tmuxSession) return undefined;
		const tty = this.paneTty.getPaneTty?.(tmuxSession) ?? null;
		if (!tty) return undefined;
		return deriveHermesTerminalId(tty);
	}

	private async resolveTerminalIdAsync(
		tmuxSession?: string,
	): Promise<string | undefined> {
		if (!tmuxSession) return undefined;
		const tty =
			(await this.paneTty.getPaneTtyAsync?.(tmuxSession)) ??
			this.paneTty.getPaneTty?.(tmuxSession) ??
			null;
		if (!tty) return undefined;
		return deriveHermesTerminalId(tty);
	}

	private readBreadcrumbFile(terminalId: string): HermesBreadcrumb | undefined {
		try {
			const raw = fs.readFileSync(
				path.join(this.breadcrumbDirectory, terminalId),
				"utf8",
			);
			const value = JSON.parse(raw) as HermesBreadcrumb;
			return typeof value.session_id === "string" ? value : undefined;
		} catch {
			return undefined;
		}
	}

	/** Read `end_reason`/`ended_at` defensively: tolerant of older/minimal `sessions` schemas. */
	private readSessionEnd(sessionId: string): {
		endedAt: number | null;
		endReason: string | null;
	} {
		const columns = this.sessionColumns ?? this.readSessionColumns();
		this.sessionColumns = columns;
		if (!columns.includes("end_reason"))
			return { endedAt: null, endReason: null };
		const rows = this.sqlite.querySync(
			"SELECT ended_at, end_reason FROM sessions WHERE id = ?",
			[sessionId],
		);
		const row = rows[0] as Record<string, unknown> | undefined;
		const endReason =
			typeof row?.end_reason === "string" && row.end_reason.trim()
				? row.end_reason.trim().toLowerCase()
				: null;
		const endedAt =
			typeof row?.ended_at === "number" && Number.isFinite(row.ended_at)
				? row.ended_at
				: null;
		return { endedAt, endReason };
	}

	private readSessionColumns(): string[] {
		try {
			const rows = this.sqlite.querySync(
				"PRAGMA table_info(sessions)",
			) as Array<Record<string, unknown>>;
			return rows
				.map((row) => (typeof row.name === "string" ? row.name : ""))
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	dispose(): void {
		this.sqlite.dispose();
	}
}

function isSafeSessionId(sessionId: string): boolean {
	return /^[a-zA-Z0-9_-]+$/u.test(sessionId);
}

/**
 * Sanitize a tty/terminal path exactly as Hermes' `_sanitize()` in
 * `hermes_cli/terminal_breadcrumbs.py`: strip whitespace, strip leading/trailing
 * slashes, replace anything outside `[A-Za-z0-9._-]` with `-`, cap at 120 chars.
 * Two Agent Space panes therefore produce two distinct, stable ids.
 */
export function sanitizeHermesTerminalPart(raw: string): string {
	return raw
		.trim()
		.replace(/^[/]+|[/]+$/g, "")
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.slice(0, 120);
}

/** The terminal id Hermes writes for a pane whose pty path is `ttyPath`. */
export function deriveHermesTerminalId(ttyPath: string): string {
	return `tty-${sanitizeHermesTerminalPart(ttyPath)}`;
}

/**
 * The terminal id Hermes would use when it cannot read a tty, derived from the
 * first multiplexer/emulator env var present (mirrors Hermes' fallback branch).
 *
 * Available as a helper for diagnostic/other uses ONLY. It MUST NOT be used as
 * an Agent Space ownership proof: it reads the calling process's environment
 * (potentially the Extension Host's own terminal), not the pane identified by
 * an agent's `context.tmuxSession`. `correlateOwnedSession` deliberately never
 * calls it (see {@link HermesSessionProvider.resolveTerminalId}).
 */
export function deriveHermesTerminalIdFromEnv(): string | undefined {
	for (const varName of HERMES_TERMINAL_ENV_VARS) {
		const value = process.env[varName];
		if (value) {
			return `${varName.toLowerCase()}-${sanitizeHermesTerminalPart(value)}`;
		}
	}
	return undefined;
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
