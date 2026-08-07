import { execSync } from "node:child_process";
import type {
	SessionInfo,
	SessionProvider,
	SessionRenameAdapter,
} from "./types";

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
		if (!/^[-_a-zA-Z0-9]+$/.test(sessionId)) return null;

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
