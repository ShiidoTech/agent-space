import * as path from "node:path";
import type { SessionCorrelationContext, SessionInfo } from "./types";

/**
 * Clock tolerance when comparing a provider's session timestamp with the
 * launch time Agent Space recorded. Providers and the extension can disagree
 * by a second or two; more than this and the session predates the launch.
 * Shared with `SessionBinder`'s own candidate filtering so both paths agree
 * on what "born after this agent launched" means.
 */
export const LAUNCH_SKEW_MS = 5_000;

function samePath(left: string, right: string): boolean {
	if (!left || !right) return false;
	return path.resolve(left) === path.resolve(right);
}

function toMs(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The one session a provider that assigns its own session ids (Codex,
 * OpenCode) can safely report as owned by this launch: it must sit in the
 * agent's cwd, be absent from every id already attributed elsewhere
 * (baseline + taken by sibling agents), and not predate the agent's launch
 * (within clock skew).
 *
 * This is deliberately the same evidence `SessionBinder`'s internal
 * `candidatesFor` already computes — surfaced here so a provider's
 * `correlateOwnedSession` can reach the same verdict instead of every fresh
 * session staying "ambiguous" until a human explicitly attaches it, which is
 * how Agent Space's original (pre-fail-closed) Codex watcher behaved for the
 * common case of one agent per worktree.
 *
 * Real ambiguity is never guessed at: a second unclaimed candidate, or none,
 * still yields `undefined`, leaving the agent's binding state as `ambiguous`
 * so it can be resolved with `agentSpace.attachProviderSession` instead of a
 * silent wrong guess.
 */
export function singleUnclaimedCandidate(
	sessions: readonly SessionInfo[],
	context: SessionCorrelationContext,
): string | undefined {
	const candidates = sessions.filter((session) => {
		if (!samePath(session.projectPath, context.cwd)) return false;
		if (context.knownSessionIds.has(session.sessionId)) return false;
		if (context.launchedAtMs === undefined) return true;
		const createdMs = toMs(session.created);
		return (
			createdMs === null || createdMs >= context.launchedAtMs - LAUNCH_SKEW_MS
		);
	});
	return candidates.length === 1 ? candidates[0].sessionId : undefined;
}
