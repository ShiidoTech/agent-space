import {
	LEGACY_TMUX_SESSION_PREFIX,
	TMUX_SESSION_PREFIX,
} from "../agents/tmux";

export type LiveTmuxSessionStatus =
	| "tracked"
	| "conflict"
	| "untracked_agent_space"
	| "foreign";

export function isAgentSpaceSession(session: string): boolean {
	return (
		session.startsWith(`${TMUX_SESSION_PREFIX}-`) ||
		session.startsWith(`${LEGACY_TMUX_SESSION_PREFIX}-`)
	);
}

export function classifyLiveTmuxSession(
	session: string,
	owners: string[] | undefined,
): LiveTmuxSessionStatus {
	if (!isAgentSpaceSession(session)) return "foreign";
	if (!owners || owners.length === 0) return "untracked_agent_space";
	return owners.length > 1 ? "conflict" : "tracked";
}
