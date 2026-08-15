import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import type {
	SessionInfo,
	SessionProvider,
	SessionRenameAdapter,
} from "./types";

export interface OpenCodeAttentionSignal {
	status: "working" | "waiting_for_user" | "idle" | "failed";
	evidence: string;
}

export class OpenCodeSessionProvider
	implements SessionProvider, SessionRenameAdapter
{
	readonly toolId = "opencode";
	private readonly execFileAsync = promisify(execFile);
	readonly async = {
		scanSessions: async (): Promise<SessionInfo[]> => {
			const rows = await this.queryAsync(
				"SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC LIMIT 200",
			);
			return rows
				.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && "id" in r)
				.map((r) => ({
					sessionId: String(r.id || ""),
					prompt: String(r.title || ""),
					created: epochMsToIso(r.time_created),
					projectPath: String(r.directory || ""),
				}));
		},
		readName: async (sessionId: string): Promise<string | null> => {
			if (!isSafeSessionId(sessionId)) return null;
			const rows = await this.queryAsync(
				`SELECT title FROM session WHERE id = '${sessionId}'`,
			);
			const title = (rows[0] as Record<string, unknown> | undefined)?.title;
			return typeof title === "string" && title.trim() ? title.trim() : null;
		},
		hasSession: async (sessionId: string): Promise<boolean> => {
			if (!isSafeSessionId(sessionId)) return false;
			return (await this.queryAsync(
				`SELECT id FROM session WHERE id = '${sessionId}'`,
			)).length > 0;
		},
	};

	private async queryAsync(sql: string): Promise<unknown[]> {
		try {
			const { stdout } = await this.execFileAsync(
				"opencode",
				["db", sql, "--format", "json"],
				{ encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
			);
			const rows: unknown = JSON.parse(stdout);
			return Array.isArray(rows) ? rows : [];
		} catch {
			return [];
		}
	}

	scanSessions(): SessionInfo[] {
		try {
			// The window covers every project on the machine, so it has to be wide
			// enough that a session started in one worktree is still visible after
			// work happens elsewhere. Binding can take minutes: opencode writes the
			// session row on the first prompt, not at launch.
			const raw = execSync(
				'opencode db "SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC LIMIT 200" --format json',
				{ encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
			);
			const rows = JSON.parse(raw);
			if (!Array.isArray(rows)) return [];

			return rows
				.filter((r: Record<string, unknown>) => r.id)
				.map((r: Record<string, unknown>) => ({
					sessionId: String(r.id || ""),
					prompt: String(r.title || ""),
					created: epochMsToIso(r.time_created),
					projectPath: String(r.directory || ""),
				}));
		} catch {
			// opencode CLI not available or query failed
			return [];
		}
	}

	readName(sessionId: string): string | null {
		if (!isSafeSessionId(sessionId)) return null;

		try {
			const raw = execSync(
				`opencode db "SELECT title FROM session WHERE id = '${sessionId}'" --format json`,
				{ encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
			);
			const rows = JSON.parse(raw);
			if (!Array.isArray(rows)) return null;
			const title = rows[0]?.title;
			if (typeof title !== "string" || !title.trim()) return null;
			return title.trim();
		} catch {
			return null;
		}
	}

	/** True when opencode still has a session row with this id. */
	hasSession(sessionId: string): boolean {
		if (!isSafeSessionId(sessionId)) return false;
		try {
			const raw = execSync(
				`opencode db "SELECT id FROM session WHERE id = '${sessionId}'" --format json`,
				{ encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
			);
			const rows = JSON.parse(raw);
			return Array.isArray(rows) && rows.length > 0;
		} catch {
			return false;
		}
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

		try {
			const raw = execSync(
				`opencode db "SELECT (SELECT data FROM message WHERE session_id = '${sessionId}' ORDER BY time_created DESC, id DESC LIMIT 1) AS message_data, (SELECT data FROM part WHERE session_id = '${sessionId}' AND message_id = (SELECT id FROM message WHERE session_id = '${sessionId}' ORDER BY time_created DESC, id DESC LIMIT 1) AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') IN ('pending', 'running') AND json_extract(data, '$.tool') IN ('question', 'plan_exit') ORDER BY time_updated DESC, id DESC LIMIT 1) AS gate_data" --format json`,
				{ encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
			);
			const rows = JSON.parse(raw);
			if (!Array.isArray(rows) || rows.length === 0) return null;

			const row = rows[0] as Record<string, unknown>;
			const gate = parseJsonRecord(row.gate_data);
			if (gate) {
				const tool = typeof gate.tool === "string" ? gate.tool : "question";
				return {
					status: "waiting_for_user",
					evidence: `opencode.${tool}.waiting`,
				};
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
				return {
					status: "failed",
					evidence: "opencode.assistant.error",
				};
			}

			const time = asRecord(message.time);
			if (time && time.completed !== undefined && time.completed !== null) {
				return {
					status: "idle",
					evidence: "opencode.assistant.completed",
				};
			}

			return {
				status: "working",
				evidence: "opencode.assistant.working",
			};
		} catch {
			return null;
		}
	}

	async readAttentionAsync(
		sessionId: string,
	): Promise<OpenCodeAttentionSignal | null> {
		if (!isSafeSessionId(sessionId)) return null;
		const rows = await this.queryAsync(
			`SELECT (SELECT data FROM message WHERE session_id = '${sessionId}' ORDER BY time_created DESC, id DESC LIMIT 1) AS message_data, (SELECT data FROM part WHERE session_id = '${sessionId}' AND message_id = (SELECT id FROM message WHERE session_id = '${sessionId}' ORDER BY time_created DESC, id DESC LIMIT 1) AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') IN ('pending', 'running') AND json_extract(data, '$.tool') IN ('question', 'plan_exit') ORDER BY time_updated DESC, id DESC LIMIT 1) AS gate_data`,
		);
		if (rows.length === 0) return null;
		const row = rows[0] as Record<string, unknown>;
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
				evidence: "OpenCode has received user input and has not completed a response",
			};
		}
		if (role !== "assistant") return null;
		const time = parseJsonRecord(message.time);
		return time?.completed ? { status: "idle", evidence: "opencode.assistant.completed" } : { status: "working", evidence: "opencode.assistant.in_progress" };
	}
}

function isSafeSessionId(sessionId: string): boolean {
	return /^[-_a-zA-Z0-9]+$/.test(sessionId);
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
export function sessionIdsForDirectory(cwd: string): Set<string> {
	const provider = new OpenCodeSessionProvider();
	return new Set(
		provider
			.scanSessions()
			.filter((s) => s.projectPath === cwd && s.sessionId)
			.map((s) => s.sessionId),
	);
}

/**
 * Enumerate OpenCode candidates. This is intentionally best-effort and does
 * not reserve or assign a session to an Agent Space agent.
 */
export function sessionsForDirectory(
	cwd: string,
	knownIds: ReadonlySet<string> = new Set(),
): SessionInfo[] {
	const provider = new OpenCodeSessionProvider();
	return provider
		.scanSessions()
		.filter((s) => s.projectPath === cwd && !knownIds.has(s.sessionId));
}
