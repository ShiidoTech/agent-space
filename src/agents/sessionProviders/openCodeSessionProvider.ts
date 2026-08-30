import {
	openCodeCliFallback,
	resolveOpenCodeDbPath,
	type SqliteModule,
	SqliteReadOnlyDb,
} from "./sqliteRead";
import type {
	AsyncSessionObservationAdapter,
	SessionInfo,
	SessionProvider,
	SessionRenameAdapter,
} from "./types";

export interface OpenCodeAttentionSignal {
	status: "working" | "waiting_for_user" | "idle" | "failed";
	evidence: string;
}

export interface OpenCodeSessionProviderOptions {
	/** Explicit SQLite database path. Defaults to the opencode data directory. */
	dbPath?: string;
	/** Injected read-only DB (test seam). Skip to use the real `node:sqlite`. */
	sqliteOverride?: SqliteModule | null;
}

/**
 * Real OpenCode schema: message carries no role column — the role lives in
 * message.data (`$.role`) and the prompt text in part.data
 * (`$.type = 'text'`, `$.text`). The scalar subquery resolves through
 * part_message_id_id_idx so no temp b-tree is built.
 */
const USER_PROMPT_SQL = `
	SELECT (
		SELECT p.data FROM part p
		WHERE p.session_id = m.session_id AND p.message_id = m.id
			AND json_extract(p.data, '$.type') = 'text'
		ORDER BY p.id ASC LIMIT 1
	) AS part_data
	FROM message m
	WHERE m.session_id = ?
		AND json_extract(m.data, '$.role') = 'user'
	ORDER BY m.time_created ASC, m.id ASC
	LIMIT 1`;

const GATE_SQL = `
	SELECT
		(SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1) AS message_data,
		(SELECT data FROM part WHERE session_id = ?
			AND message_id = (SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1)
			AND json_extract(data, '$.type') = 'tool'
			AND json_extract(data, '$.state.status') IN ('pending', 'running')
			AND json_extract(data, '$.tool') IN ('question', 'plan_exit')
			ORDER BY time_updated DESC, id DESC LIMIT 1) AS gate_data`;

export class OpenCodeSessionProvider
	implements SessionProvider, SessionRenameAdapter
{
	readonly toolId = "opencode";
	private readonly sqlite: SqliteReadOnlyDb;

	constructor(options: OpenCodeSessionProviderOptions = {}) {
		const dbPath = options.dbPath ?? resolveOpenCodeDbPath();
		this.sqlite = new SqliteReadOnlyDb(
			dbPath,
			openCodeCliFallback(),
			options.sqliteOverride,
		);
	}

	readonly async: AsyncSessionObservationAdapter & {
		scanSessions: () => Promise<SessionInfo[]>;
		readName: (sessionId: string) => Promise<string | null>;
		hasSession: (sessionId: string) => Promise<boolean>;
	} = {
		scanSessions: async (): Promise<SessionInfo[]> => this.scanSessionsAsync(),
		readName: async (sessionId: string): Promise<string | null> =>
			this.readNameAsync(sessionId),
		hasSession: async (sessionId: string): Promise<boolean> =>
			this.hasSessionAsync(sessionId),
	};

	scanSessions(): SessionInfo[] {
		const rows = this.sqlite.querySync(
			"SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC LIMIT 200",
		);
		return rows
			.filter(
				(r): r is Record<string, unknown> =>
					!!r && typeof r === "object" && "id" in r,
			)
			.map((r) => ({
				sessionId: String(r.id || ""),
				prompt: String(r.title || ""),
				created: epochMsToIso(r.time_created),
				projectPath: String(r.directory || ""),
			}));
	}

	private async scanSessionsAsync(): Promise<SessionInfo[]> {
		const rows = await this.sqlite.queryAsync(
			"SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC LIMIT 200",
		);
		return rows
			.filter(
				(r): r is Record<string, unknown> =>
					!!r && typeof r === "object" && "id" in r,
			)
			.map((r) => ({
				sessionId: String(r.id || ""),
				prompt: String(r.title || ""),
				created: epochMsToIso(r.time_created),
				projectPath: String(r.directory || ""),
			}));
	}

	readName(sessionId: string): string | null {
		if (!isSafeSessionId(sessionId)) return null;
		const title = this.readTitle(sessionId);
		if (title) return title;
		return this.readUserPrompt(sessionId);
	}

	private async readNameAsync(sessionId: string): Promise<string | null> {
		if (!isSafeSessionId(sessionId)) return null;
		const title = await this.readTitleAsync(sessionId);
		if (title) return title;
		return this.readUserPromptAsync(sessionId);
	}

	private readTitle(sessionId: string): string | null {
		const rows = this.sqlite.querySync(
			"SELECT title FROM session WHERE id = ?",
			[sessionId],
		);
		const title = (rows[0] as Record<string, unknown> | undefined)?.title;
		return typeof title === "string" && title.trim() ? title.trim() : null;
	}

	private async readTitleAsync(sessionId: string): Promise<string | null> {
		const rows = await this.sqlite.queryAsync(
			"SELECT title FROM session WHERE id = ?",
			[sessionId],
		);
		const title = (rows[0] as Record<string, unknown> | undefined)?.title;
		return typeof title === "string" && title.trim() ? title.trim() : null;
	}

	/** Fallback name source: the agent's first user prompt, when the title is still empty. */
	private readUserPrompt(sessionId: string): string | null {
		const rows = this.sqlite.querySync(USER_PROMPT_SQL, [sessionId]);
		return extractPartText(
			(rows[0] as Record<string, unknown> | undefined)?.part_data,
		);
	}

	/** Async mirror of {@link readUserPrompt}: never touches a sync subprocess. */
	private async readUserPromptAsync(sessionId: string): Promise<string | null> {
		const rows = await this.sqlite.queryAsync(USER_PROMPT_SQL, [sessionId]);
		return extractPartText(
			(rows[0] as Record<string, unknown> | undefined)?.part_data,
		);
	}

	hasSession(sessionId: string): boolean {
		if (!isSafeSessionId(sessionId)) return false;
		return (
			this.sqlite.querySync("SELECT id FROM session WHERE id = ?", [sessionId])
				.length > 0
		);
	}

	private async hasSessionAsync(sessionId: string): Promise<boolean> {
		if (!isSafeSessionId(sessionId)) return false;
		return (
			(
				await this.sqlite.queryAsyncDirect(
					"SELECT id FROM session WHERE id = ?",
					[sessionId],
				)
			).length > 0
		);
	}

	discoverSessionCandidates(
		cwd: string,
		knownSessionIds: ReadonlySet<string>,
	): SessionInfo[] {
		return sessionsForDirectory(cwd, knownSessionIds);
	}

	/**
	 * Read provider-native activity evidence without scraping terminal text.
	 *
	 * OpenCode persists each message as JSON in SQLite. An assistant message is
	 * created before generation and receives `time.completed` only when that
	 * turn settles, which gives us a durable working/idle boundary. A currently
	 * running `question`/`plan_exit` tool is an explicit human-attention gate and
	 * therefore wins over the generic in-progress assistant state.
	 */
	readAttention(sessionId: string): OpenCodeAttentionSignal | null {
		if (!isSafeSessionId(sessionId)) return null;
		const rows = this.sqlite.querySyncDirect(GATE_SQL, [
			sessionId,
			sessionId,
			sessionId,
		]);
		if (rows.length === 0) return null;
		return parseAttentionRow(rows[0] as Record<string, unknown>);
	}

	async readAttentionAsync(
		sessionId: string,
	): Promise<OpenCodeAttentionSignal | null> {
		if (!isSafeSessionId(sessionId)) return null;
		const rows = await this.sqlite.queryAsyncDirect(GATE_SQL, [
			sessionId,
			sessionId,
			sessionId,
		]);
		if (rows.length === 0) return null;
		return parseAttentionRow(rows[0] as Record<string, unknown>);
	}

	dispose(): void {
		this.sqlite.dispose();
	}
}

function parseAttentionRow(
	row: Record<string, unknown>,
): OpenCodeAttentionSignal | null {
	const gate = parseJsonRecord(row.gate_data);
	if (gate) {
		const tool = typeof gate.tool === "string" ? gate.tool : "question";
		return { status: "waiting_for_user", evidence: `opencode.${tool}.waiting` };
	}

	const message = parseJsonRecord(row.message_data);
	if (!message) return null;
	const role = typeof message.role === "string" ? message.role : "";
	if (role === "user") {
		return {
			status: "working",
			evidence:
				"OpenCode has received user input and has not completed a response",
		};
	}
	if (role !== "assistant") return null;

	if (message.error) {
		return { status: "failed", evidence: "opencode.assistant.error" };
	}

	const time = asRecord(message.time);
	if (time && time.completed !== undefined && time.completed !== null) {
		return { status: "idle", evidence: "opencode.assistant.completed" };
	}

	return { status: "working", evidence: "opencode.assistant.working" };
}

function isSafeSessionId(sessionId: string): boolean {
	return /^[-_a-zA-Z0-9]+$/.test(sessionId);
}

/**
 * Extract the prompt text from a real OpenCode `part.data` payload:
 * `{"type":"text","text":"..."}`. Tolerant to JSON-string or object input.
 */
function extractPartText(value: unknown): string | null {
	const record = parseJsonRecord(value);
	if (!record) return null;
	const text = record.text;
	if (typeof text !== "string" || !text.trim()) return null;
	return text.trim().slice(0, 200);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function epochMsToIso(value: unknown): string {
	if (typeof value === "number" && value > 0) {
		return new Date(value).toISOString();
	}
	if (typeof value === "string") {
		const n = Number(value);
		if (!Number.isNaN(n) && n > 0) return new Date(n).toISOString();
		return value;
	}
	return "";
}

/**
 * Best-effort snapshot of the opencode sessions already started in `cwd`.
 * opencode generates its own session ids, so after launching a fresh agent we
 * discover the id it created in order to resume that exact session later —
 * even when several agents share the same worktree.
 *
 * Capture this set BEFORE launching: any session present here already existed
 * before the launch and must never be attributed to the new agent.
 */
export function sessionIdsForDirectory(
	cwd: string,
	options: OpenCodeSessionProviderOptions = {},
): Set<string> {
	const provider = options.dbPath
		? new OpenCodeSessionProvider(options)
		: openCodeSessionAdapter;
	try {
		return new Set(
			provider
				.scanSessions()
				.filter((s) => s.projectPath === cwd && s.sessionId)
				.map((s) => s.sessionId),
		);
	} finally {
		if (provider !== openCodeSessionAdapter) provider.dispose();
	}
}

/**
 * Enumerate OpenCode candidates. This is intentionally best-effort and does
 * not reserve or assign a session to an Agent Space agent.
 */
export function sessionsForDirectory(
	cwd: string,
	knownIds: ReadonlySet<string> = new Set(),
	options: OpenCodeSessionProviderOptions = {},
): SessionInfo[] {
	const provider = options.dbPath
		? new OpenCodeSessionProvider(options)
		: openCodeSessionAdapter;
	try {
		return provider
			.scanSessions()
			.filter((s) => s.projectPath === cwd && !knownIds.has(s.sessionId));
	} finally {
		if (provider !== openCodeSessionAdapter) provider.dispose();
	}
}

/** Shared singleton so the steady-state path reuses one read-only connection. */
export const openCodeSessionAdapter = new OpenCodeSessionProvider();
