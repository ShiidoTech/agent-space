import type { Agent } from "../../types";
import { AgentAttentionResolver } from "../attention/agentAttentionResolver";
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
		const tool = this.toolRegistry.resolveAgentTool(agent.toolId);

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
		};
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
