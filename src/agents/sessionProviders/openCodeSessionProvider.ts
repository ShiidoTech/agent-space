import { execSync } from "node:child_process";
import type { SessionInfo, SessionProvider } from "./types";

export class OpenCodeSessionProvider implements SessionProvider {
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
 * Newest opencode session started in `cwd` that is not among `knownIds`.
 * `knownIds` is the pre-launch snapshot, so only sessions created after the
 * launch are ever returned.
 */
export function newestSessionIdForDirectory(
	cwd: string,
	knownIds?: Set<string>,
): string | undefined {
	const provider = new OpenCodeSessionProvider();
	for (const s of provider.scanSessions()) {
		if (s.projectPath === cwd && s.sessionId && !knownIds?.has(s.sessionId)) {
			return s.sessionId;
		}
	}
	return undefined;
}
