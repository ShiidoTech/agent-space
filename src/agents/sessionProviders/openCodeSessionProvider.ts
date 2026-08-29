import type { ProviderAttentionSignal } from "../providers/types";
import {
	OpenCodeHttpClient,
	type OpenCodeServerEvent,
} from "./openCodeHttpClient";
import {
	openCodeCliFallback,
	resolveOpenCodeDbPath,
	type SqliteModule,
	SqliteReadOnlyDb,
} from "./sqliteRead";
import type {
	AsyncSessionObservationAdapter,
	ProviderConversationReceipt,
	SessionCorrelationContext,
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
	/**
	 * Base URL of a controlled OpenCode server for this worktree.
	 * When set, acquireConversation / resumeConversation use the HTTP API
	 * instead of SQLite candidate scanning.
	 */
	serverUrl?: string;
	/** Server password for authenticated endpoints. */
	serverPassword?: string;
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
	private readonly httpClient?: OpenCodeHttpClient;
	/** Base URL of the controlled OpenCode server, when available. */
	readonly serverUrl?: string;
	/** Per-session SSE event listeners, keyed by sessionId. */
	private readonly eventUnsubscribers = new Map<string, () => void>();
	/** Latest attention signal per session, driven by SSE events. */
	private readonly sseAttention = new Map<string, ProviderAttentionSignal>();

	constructor(options: OpenCodeSessionProviderOptions = {}) {
		const dbPath = options.dbPath ?? resolveOpenCodeDbPath();
		this.sqlite = new SqliteReadOnlyDb(
			dbPath,
			openCodeCliFallback(),
			options.sqliteOverride,
		);
		this.serverUrl = options.serverUrl;
		if (options.serverUrl) {
			this.httpClient = new OpenCodeHttpClient(
				options.serverUrl,
				options.serverPassword,
			);
		}
	}

	readonly async: AsyncSessionObservationAdapter & {
		scanSessions: () => Promise<SessionInfo[]>;
		readName: (sessionId: string) => Promise<string | null>;
		hasSession: (sessionId: string) => Promise<boolean>;
		correlateOwnedSession: (
			context: SessionCorrelationContext,
		) => Promise<string | undefined>;
	} = {
		scanSessions: async (): Promise<SessionInfo[]> => this.scanSessionsAsync(),
		readName: async (sessionId: string): Promise<string | null> =>
			this.readNameAsync(sessionId),
		hasSession: async (sessionId: string): Promise<boolean> =>
			this.hasSessionAsync(sessionId),
		correlateOwnedSession: async (
			context: SessionCorrelationContext,
		): Promise<string | undefined> => {
			if (!this.httpClient) return undefined;
			return this.correlateOwnedSessionAsync(context);
		},
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
		// Check the HTTP server first when available.
		if (this.httpClient) {
			try {
				return await this.httpClient.hasSession(sessionId);
			} catch {
				// Fall through to SQLite.
			}
		}
		return (
			(
				await this.sqlite.queryAsync("SELECT id FROM session WHERE id = ?", [
					sessionId,
				])
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
	 * Create a new session via the controlled OpenCode server.
	 * This is the authoritative source of session identity — the id returned
	 * here is persisted immediately and never inferred later.
	 */
	async acquireConversation(
		context: SessionCorrelationContext,
	): Promise<ProviderConversationReceipt | undefined> {
		if (!this.httpClient) return undefined;
		try {
			const { sessionId, proof } = await this.httpClient.createSession(
				context.cwd,
			);
			if (!sessionId) return undefined;
			// Start consuming SSE events for this session.
			this.startSseEventStream(sessionId);
			return { sessionId, proof };
		} catch {
			return undefined;
		}
	}

	/**
	 * Reconnect to an existing session on the controlled OpenCode server.
	 * Returns true if the session exists on the server.
	 */
	async resumeConversation(sessionId: string): Promise<boolean> {
		if (!this.httpClient) return false;
		try {
			const exists = await this.httpClient.hasSession(sessionId);
			if (exists) {
				this.startSseEventStream(sessionId);
			}
			return exists;
		} catch {
			return false;
		}
	}

	/**
	 * Start consuming SSE events for a specific session. Events are mapped
	 * to `ProviderAttentionSignal` and cached in `sseAttention`.
	 */
	private startSseEventStream(sessionId: string): void {
		if (this.eventUnsubscribers.has(sessionId)) return;
		if (!this.httpClient) return;
		const unsubscribe = this.httpClient.onSessionEvents(sessionId, (event) =>
			this.handleSseEvent(sessionId, event),
		);
		this.eventUnsubscribers.set(sessionId, unsubscribe);
	}

	private handleSseEvent(sessionId: string, event: OpenCodeServerEvent): void {
		const signal = mapSseEventToAttentionSignal(event);
		if (signal) {
			this.sseAttention.set(sessionId, signal);
		}
	}

	/**
	 * Correlate a session via the HTTP server: look for a session in the
	 * server whose `directory` matches the worktree. This is the async path
	 * used by the periodic reconcile pass.
	 */
	private async correlateOwnedSessionAsync(
		context: SessionCorrelationContext,
	): Promise<string | undefined> {
		if (!this.httpClient) return undefined;
		try {
			const sessions = await this.httpClient.listSessions();
			const match = sessions.find(
				(s) =>
					s.directory === context.cwd && !context.knownSessionIds.has(s.id),
			);
			return match?.id;
		} catch {
			return undefined;
		}
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
		// SSE-derived signal takes precedence over SQLite.
		const sseSignal = this.sseAttention.get(sessionId);
		if (sseSignal) return sseSignal;
		const rows = this.sqlite.querySync(GATE_SQL, [
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
		// SSE-derived signal takes precedence over SQLite.
		const sseSignal = this.sseAttention.get(sessionId);
		if (sseSignal) return sseSignal;
		const rows = await this.sqlite.queryAsync(GATE_SQL, [
			sessionId,
			sessionId,
			sessionId,
		]);
		if (rows.length === 0) return null;
		return parseAttentionRow(rows[0] as Record<string, unknown>);
	}

	/**
	 * Clear all state for a specific session (SSE events, caches).
	 * Called when a session is unbound or the backend shuts down.
	 */
	clearSessionState(sessionId: string): void {
		const unsub = this.eventUnsubscribers.get(sessionId);
		if (unsub) {
			unsub();
			this.eventUnsubscribers.delete(sessionId);
		}
		this.sseAttention.delete(sessionId);
	}

	dispose(): void {
		for (const unsub of this.eventUnsubscribers.values()) {
			unsub();
		}
		this.eventUnsubscribers.clear();
		this.sseAttention.clear();
		this.sqlite.dispose();
	}
}

/**
 * Map an OpenCode server SSE event to a `ProviderAttentionSignal`.
 *
 * The exact event shapes depend on the OpenCode server version. The mapping
 * is intentionally conservative: only clearly identified events produce a
 * signal, everything else is silently ignored.
 */
function mapSseEventToAttentionSignal(
	event: OpenCodeServerEvent,
): ProviderAttentionSignal | undefined {
	const eventType = event.type;
	const observedAt = event.timestamp;

	if (
		eventType === "session.status" ||
		eventType === "session.working" ||
		eventType === "message.start" ||
		eventType === "assistant.start"
	) {
		return {
			status: "working",
			evidence: `opencode.sse.${eventType}`,
			observedAt,
		};
	}
	if (
		eventType === "session.idle" ||
		eventType === "session.completed" ||
		eventType === "message.complete" ||
		eventType === "assistant.complete" ||
		eventType === "turn.complete"
	) {
		return {
			status: "idle",
			evidence: `opencode.sse.${eventType}`,
			observedAt,
		};
	}
	if (
		eventType === "permission.asked" ||
		eventType === "session.waiting" ||
		eventType === "question.asked"
	) {
		return {
			status: "waiting_for_user",
			evidence: `opencode.sse.${eventType}`,
			observedAt,
		};
	}
	if (
		eventType === "session.error" ||
		eventType === "message.error" ||
		eventType === "assistant.error"
	) {
		return {
			status: "failed",
			evidence: `opencode.sse.${eventType}`,
			observedAt,
		};
	}
	return undefined;
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
