import { execSync } from "node:child_process";
import type {
	SessionInfo,
	SessionProvider,
	SessionRenameAdapter,
} from "./types";

export interface OpenCodeAttentionSignal {
	status: "working" | "waiting_for_user" | "idle" | "failed";
	reason: string;
}

/**
 * In-memory reservation of opencode session ids picked by a capture. opencode
 * session ids are globally unique, so a flat set is enough: once a session is
 * claimed by one capture, no concurrent capture for the same cwd can select
 * it again. Reserved ids are never released — a session belongs to exactly one
 * agent for the lifetime of the process.
 */
const claimedSessionIds = new Set<string>();

/** Reset the in-memory claim registry. Exposed for tests. */
export function resetClaimedOpenCodeSessionIds(): void {
	claimedSessionIds.clear();
}

export class OpenCodeSessionProvider
	implements SessionProvider, SessionRenameAdapter
{
	readonly toolId = "opencode";

	scanSessions(): SessionInfo[] {
		try {
			const raw = execSync(
				'opencode db "SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC LIMIT 20" --format json',
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
					reason: `OpenCode is waiting on the ${tool} tool`,
				};
			}

			const message = parseJsonRecord(row.message_data);
			if (!message) return null;
			const role = typeof message.role === "string" ? message.role : "";
			if (role === "user") {
				return {
					status: "working",
					reason:
						"OpenCode has received user input and has not completed a response",
				};
			}
			if (role !== "assistant") return null;

			if (message.error) {
				return {
					status: "failed",
					reason: "OpenCode recorded an error on the current assistant turn",
				};
			}

			const time = asRecord(message.time);
			if (time && time.completed !== undefined && time.completed !== null) {
				return {
					status: "idle",
					reason: "OpenCode completed its current turn",
				};
			}

			return {
				status: "working",
				reason: "OpenCode has an assistant turn in progress",
			};
		} catch {
			return null;
		}
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
 * Atomically claim the newest opencode session started in `cwd` that is not
 * among `knownIds` (the pre-launch snapshot) and not already claimed by a
 * concurrent capture. The scan and the claim happen in one synchronous step,
 * so two captures polling the same cwd can never both select the same
 * session: the first one reserves it, the others skip it and keep polling
 * until a newer session appears.
 */
export function claimNewestSessionIdForDirectory(
	cwd: string,
	knownIds: Set<string>,
): string | undefined {
	const provider = new OpenCodeSessionProvider();
	for (const s of provider.scanSessions()) {
		if (
			s.projectPath === cwd &&
			s.sessionId &&
			!knownIds.has(s.sessionId) &&
			!claimedSessionIds.has(s.sessionId)
		) {
			claimedSessionIds.add(s.sessionId);
			return s.sessionId;
		}
	}
	return undefined;
}
