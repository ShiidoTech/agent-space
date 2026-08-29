import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, Feature } from "../types";
import type { CodingToolRegistry } from "./codingToolRegistry";
import { openCodeBackendManager } from "./codingToolRegistry";
import { reconnectOpenCodeAgent } from "./openCodeReattach";
import type { TmuxIntegration } from "./tmux";

export interface OpenCodeRuntimeReconcilerDeps {
	projectManager: ProjectManager;
	tmux: TmuxIntegration;
	toolRegistry: CodingToolRegistry;
}

/**
 * Live (mid-session) recovery for OpenCode backends that die while VS Code
 * stays open. `runtimeRestorer` only runs once, at activation; this handles
 * the case where `opencode serve` crashes afterwards.
 *
 * Wired to `openCodeBackendManager.onBackendLost`: on an unexpected exit for
 * a worktree, every surviving OpenCode agent whose tmux pane is still alive
 * for that worktree is reconnected to the freshly-ensured replacement
 * backend — never just the one agent that happens to trigger the ensure().
 *
 * Coalesced per worktree so a burst of lost-events (or an event racing an
 * explicit `ensure()` elsewhere) never spawns more than one backend or
 * respawns the same pane twice. Does not retry on failure — a backend that
 * cannot be restarted is left blocked, not looped on.
 */
export class OpenCodeRuntimeReconciler {
	private readonly inFlight = new Map<string, Promise<void>>();
	private unsubscribe?: () => void;

	constructor(private readonly deps: OpenCodeRuntimeReconcilerDeps) {}

	start(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = openCodeBackendManager.onBackendLost((worktreePath) => {
			void this.reconcileWorktree(worktreePath);
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/** Exposed for tests; also used internally on a `onBackendLost` event. */
	async reconcileWorktree(worktreePath: string): Promise<void> {
		const inFlight = this.inFlight.get(worktreePath);
		if (inFlight) return inFlight;

		const run = this.reconcileWorktreeUnlocked(worktreePath).finally(() => {
			if (this.inFlight.get(worktreePath) === run) {
				this.inFlight.delete(worktreePath);
			}
		});
		this.inFlight.set(worktreePath, run);
		return run;
	}

	private async reconcileWorktreeUnlocked(worktreePath: string): Promise<void> {
		let changed = false;
		try {
			for (const { ctx, feature, agent } of openCodeAgentsForWorktree(
				this.deps.projectManager,
				worktreePath,
			)) {
				const sessionName =
					agent.tmuxSession ?? this.deps.tmux.sessionName(feature.id, agent.id);
				if (!(await this.deps.tmux.isSessionAliveAsync(sessionName))) {
					// Nothing to reconnect — the ordinary restore path (or the user)
					// owns bringing this agent's runtime back.
					continue;
				}
				const tool = this.deps.toolRegistry.resolveAgentToolForAgent(agent);
				if (tool.id !== "opencode") continue;

				const result = await reconnectOpenCodeAgent(
					agent,
					tool,
					worktreePath,
					sessionName,
					this.deps,
				);
				if (result.kind === "reconnected") {
					changed = true;
					ctx.agentManager.recordRestoreOutcomeReadModel(agent.id, feature.id, {
						state: "reattached",
						at: new Date().toISOString(),
					});
				} else if (result.kind === "blocked") {
					changed = true;
					ctx.agentManager.recordRestoreOutcomeReadModel(agent.id, feature.id, {
						state: "blocked",
						reason: result.reason,
						at: new Date().toISOString(),
					});
					console.warn(
						`[OpenCodeRuntimeReconciler] ${agent.id} not reconnected: ${result.reason}`,
					);
				}
			}
		} finally {
			if (changed) this.deps.projectManager.notifyChange();
		}
	}
}

function* openCodeAgentsForWorktree(
	projectManager: ProjectManager,
	worktreePath: string,
): Generator<{ ctx: ProjectContext; feature: Feature; agent: Agent }> {
	for (const ctx of projectManager.getAllContexts()) {
		const base = ctx.featureManager.getBaseFeature(ctx.project.id);
		const persisted = ctx.store.loadFeatures();
		for (const feature of [base, ...persisted]) {
			for (const agent of ctx.agentManager.getAgentsReadModel(feature.id)) {
				if (agent.status === "done" || agent.status === "errored") continue;
				if (agent.hasStarted !== true) continue;
				const cwd = agent.worktreePath ?? feature.worktreePath;
				if (cwd !== worktreePath) continue;
				yield { ctx, feature, agent };
			}
		}
	}
}
