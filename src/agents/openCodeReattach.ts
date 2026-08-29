import type { Agent, CodingTool } from "../types";
import { execAsync } from "../utils/platform";
import type { CodingToolRegistry } from "./codingToolRegistry";
import { openCodeBackendManager } from "./codingToolRegistry";
import { sessionIsProven } from "./sessionProven";
import type { TmuxIntegration } from "./tmux";

export interface OpenCodeReattachDeps {
	tmux: TmuxIntegration;
	toolRegistry: CodingToolRegistry;
}

export type OpenCodeReattachResult =
	| { kind: "reconnected" }
	/** Already pointed at the current backend instance — nothing to do. */
	| { kind: "skipped" }
	| { kind: "blocked"; reason: string };

/**
 * Per-agent memory of which backend instance its tmux pane's `opencode
 * attach` was last successfully pointed at. Process-local only: a fresh
 * Extension Host (reload) starts with an empty map, which is exactly right —
 * `OpenCodeBackendManager` is also fresh then, so every surviving OpenCode
 * pane genuinely does need reconnecting once.
 */
const lastReconnectedInstance = new Map<string, string>();

/** Test seam: forget an agent's tracked instance (e.g. after it is removed). */
export function forgetOpenCodeReattachState(agentId: string): void {
	lastReconnectedInstance.delete(agentId);
}

/** Test seam: reset all tracked instances between test cases. */
export function resetOpenCodeReattachStateForTests(): void {
	lastReconnectedInstance.clear();
}

/**
 * Reconnect a live OpenCode tmux pane to the worktree's current, healthy
 * backend, in place (via `tmux respawn-pane`) rather than kill+recreate.
 * Preserves the tmux session name/VS Code terminal binding and the exact
 * persisted `sessionId` — never starts a fresh conversation.
 *
 * Fail-closed: any missing precondition (no sessionId, unprovable session,
 * backend cannot be ensured, no resume command) returns `blocked` and never
 * falls back to a silent fresh launch.
 */
export async function reconnectOpenCodeAgent(
	agent: Agent,
	tool: CodingTool,
	cwd: string,
	sessionName: string,
	deps: OpenCodeReattachDeps,
): Promise<OpenCodeReattachResult> {
	if (!agent.sessionId) {
		return {
			kind: "blocked",
			reason:
				"No provider session id is persisted; the OpenCode runtime was not reconnected",
		};
	}
	if (!(await sessionIsProven(deps, tool, agent))) {
		return {
			kind: "blocked",
			reason:
				"Persisted session id could not be verified in the provider store; refusing an unattributable reconnect",
		};
	}

	let handle: Awaited<ReturnType<typeof openCodeBackendManager.ensure>>;
	try {
		handle = await openCodeBackendManager.ensure(cwd);
	} catch (error) {
		return {
			kind: "blocked",
			reason: `OpenCode backend could not be started; agent runtime not reconnected (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	if (lastReconnectedInstance.get(agent.id) === handle.instanceId) {
		return { kind: "skipped" };
	}

	const resumeCommand = deps.toolRegistry.buildStrictResumeLaunchCommand(
		tool,
		agent.sessionId,
		cwd,
	);
	if (!resumeCommand) {
		return {
			kind: "blocked",
			reason:
				"Provider could not build a resume command for the persisted session; the OpenCode runtime was not reconnected",
		};
	}

	try {
		try {
			await deps.tmux.respawnSessionCommandAsync(
				sessionName,
				resumeCommand,
				cwd,
			);
		} catch {
			// respawn-pane unavailable/failed — fall back to kill+recreate, the
			// only case where the whole tmux session is torn down for OpenCode.
			deps.tmux.killSession(sessionName);
			await execAsync(deps.tmux.createCommand(sessionName, resumeCommand), {
				cwd,
			});
		}
		await deps.tmux.configureSessionAsync(sessionName);
	} catch (error) {
		return {
			kind: "blocked",
			reason: `tmux session could not be reconnected to the new backend: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (!(await deps.tmux.isSessionAliveAsync(sessionName))) {
		return {
			kind: "blocked",
			reason: "the reconnected tmux session did not stay alive",
		};
	}

	lastReconnectedInstance.set(agent.id, handle.instanceId);
	return { kind: "reconnected" };
}
