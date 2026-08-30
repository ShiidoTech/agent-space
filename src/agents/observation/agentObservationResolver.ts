import type { RuntimeObservation } from "../../features/runtimeObservation";
import type { Agent } from "../../types";
import {
	AgentAttentionResolver,
	type AgentAttentionSnapshot,
} from "../attention/agentAttentionResolver";
import type { CodingToolRegistry } from "../codingToolRegistry";
import type { TmuxIntegration } from "../tmux";
import type { AgentObservation } from "./types";

export class AgentObservationResolver {
	private readonly attentionResolver: AgentAttentionResolver;

	constructor(
		private readonly tmux: TmuxIntegration,
		private readonly toolRegistry: CodingToolRegistry,
	) {
		this.attentionResolver = new AgentAttentionResolver(tmux, toolRegistry);
	}

	resolve(agent: Agent): AgentObservation {
		const lifecycle = this.resolveLifecycle(agent);
		const attention = this.attentionResolver.resolve(
			agent,
			lifecycle.state === "starting" || lifecycle.state === "unknown"
				? undefined
				: lifecycle.state,
		);
		return this.assemble(agent, lifecycle, attention);
	}

	/**
	 * Non-blocking twin of {@link resolve}: identical lifecycle decision
	 * tree, probed through the async tmux helper so background observers
	 * (runtime reconciliation) never block the Extension Host on a
	 * subprocess. Used to populate `AgentManager`'s observation cache —
	 * never called from a render path.
	 *
	 * Attention is deliberately NOT recomputed here: `AgentAttentionMonitor`
	 * is the single source of attention evidence (it commits fresh values via
	 * `AgentManager.commitAttention`, on its own poll cadence, with its own
	 * provider/tmux probes). Recomputing it again on every presence tick was
	 * a second, independent prober racing the monitor for the same tmux
	 * pane and provider reads — `previousAttention` (the last value the
	 * monitor committed, read by the caller from the cache before calling
	 * this) is preserved as-is instead (P0 mandate: one attention source,
	 * not two).
	 *
	 * `knownAlive`, when given, is tmux liveness already resolved by the
	 * caller's own single global sweep for this tick — lifecycle resolution
	 * then skips its own tmux probe entirely (P0 mandate: O(1) tmux
	 * observation per tick, not one probe per agent). Passed through as the
	 * full {@link RuntimeObservation} rather than a plain boolean: a sweep
	 * that was attempted and failed (`status: "unknown"`) must resolve
	 * lifecycle to unknown directly, not fall back to probing tmux again —
	 * collapsing it to `undefined` here would be indistinguishable from "no
	 * sweep supplied" and turn one failed sweep into an O(N) retry storm.
	 */
	async resolveAsync(
		agent: Agent,
		knownAlive?: RuntimeObservation<boolean>,
		previousAttention?: AgentAttentionSnapshot,
	): Promise<AgentObservation> {
		const lifecycle = await this.resolveLifecycleAsync(agent, knownAlive);
		const attention: AgentAttentionSnapshot = previousAttention ?? {
			status: "unknown",
			reason: "Not yet observed",
			source: "fallback",
		};
		return this.assemble(agent, lifecycle, attention);
	}

	/**
	 * Zero-I/O synthesis of an observation from persisted agent fields alone
	 * — no tmux, no provider read. Used as the cache-miss default so a
	 * render path that asks for an agent's observation before the async
	 * cache has ever been populated still gets a well-formed, honestly
	 * "unknown" result instead of blocking on a live probe.
	 */
	resolveReadModel(agent: Agent): AgentObservation {
		const lifecycle = this.resolveLifecycleReadModel(agent);
		const attention: AgentAttentionSnapshot = {
			status: "unknown",
			reason: "Not yet observed",
			source: "fallback",
		};
		return this.assemble(agent, lifecycle, attention);
	}

	private assemble(
		agent: Agent,
		lifecycle: AgentObservation["lifecycle"],
		attention: AgentAttentionSnapshot,
	): AgentObservation {
		const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
		return {
			identity: {
				agentName: agent.name,
				sessionTitle: agent.sessionTitle,
				providerId: tool.id,
			},
			lifecycle,
			attention: {
				state: attention.status === "done" ? "unknown" : attention.status,
				observedAt: attention.observedAt,
				reason: attention.reason,
			},
			session: {
				state: agent.sessionBinding?.state ?? "pending",
				sessionId: agent.sessionId ?? undefined,
				detail: agent.sessionBinding?.detail,
			},
			review: {
				pending: Boolean(agent.pendingReviewId),
			},
		};
	}

	/** Lifecycle facts derivable from the persisted agent alone — no tmux. */
	private resolveLifecycleReadModel(
		agent: Agent,
	): AgentObservation["lifecycle"] {
		if (agent.status === "errored") {
			return { state: "errored", source: "agentspace" };
		}
		if (agent.status === "done") {
			return { state: "done", source: "agentspace" };
		}
		if (agent.status === "stopped") {
			return { state: "stopped", source: "agentspace" };
		}
		if (agent.hasStarted !== true) {
			return { state: "starting", source: "agentspace" };
		}
		return {
			state: "unknown",
			source: "agentspace",
			reason: "Not yet observed",
		};
	}

	private async resolveLifecycleAsync(
		agent: Agent,
		knownAlive?: RuntimeObservation<boolean>,
	): Promise<AgentObservation["lifecycle"]> {
		if (agent.status === "errored") {
			return { state: "errored", source: "agentspace" };
		}
		if (agent.status === "done") {
			return { state: "done", source: "agentspace" };
		}
		if (agent.status === "stopped") {
			return { state: "stopped", source: "agentspace" };
		}
		if (agent.hasStarted !== true) {
			return { state: "starting", source: "agentspace" };
		}

		if (knownAlive) {
			if (knownAlive.status === "unknown") {
				return {
					state: "unknown",
					source: "tmux",
					reason: `tmux observation failed: ${knownAlive.detail ?? knownAlive.reason}`,
				};
			}
			return knownAlive.value
				? { state: "running", source: "tmux" }
				: { state: "stopped", source: "tmux" };
		}

		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(agent.featureId, agent.id);
		try {
			const alive = await this.tmux.isSessionAliveAsync?.(sessionName);
			return alive === false
				? { state: "stopped", source: "tmux" }
				: { state: "running", source: "agentspace" };
		} catch (error) {
			return {
				state: "unknown",
				source: "tmux",
				reason:
					error instanceof Error
						? `tmux observation failed: ${error.message}`
						: "tmux observation failed",
			};
		}
	}

	private resolveLifecycle(agent: Agent): AgentObservation["lifecycle"] {
		if (agent.status === "errored") {
			return { state: "errored", source: "agentspace" };
		}
		if (agent.status === "done") {
			return { state: "done", source: "agentspace" };
		}
		if (agent.status === "stopped") {
			return { state: "stopped", source: "agentspace" };
		}
		if (agent.hasStarted !== true) {
			return { state: "starting", source: "agentspace" };
		}

		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(agent.featureId, agent.id);
		try {
			const sessions = this.tmux.observeSessions?.();
			if (sessions?.status === "unknown") {
				return {
					state: "unknown",
					source: "tmux",
					reason: `tmux observation failed: ${sessions.detail}`,
				};
			}
			if (sessions?.status === "known") {
				return sessions.sessions.includes(sessionName)
					? { state: "running", source: "tmux" }
					: { state: "stopped", source: "tmux" };
			}
			if (this.tmux.isSessionAlive?.(sessionName) === false) {
				return { state: "stopped", source: "tmux" };
			}
		} catch (error) {
			return {
				state: "unknown",
				source: "tmux",
				reason:
					error instanceof Error
						? `tmux observation failed: ${error.message}`
						: "tmux observation failed",
			};
		}
		return { state: "running", source: "agentspace" };
	}
}
