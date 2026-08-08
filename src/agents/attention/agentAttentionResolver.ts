import type { Agent, AgentAttentionStatus } from "../../types";
import type { CodingToolRegistry } from "../codingToolRegistry";
import type { ProviderAttentionSignal } from "../providers/types";
import type { TmuxIntegration } from "../tmux";

export interface AgentAttentionSnapshot {
	status: AgentAttentionStatus;
	reason: string;
	source: "lifecycle" | "tmux" | "provider" | "fallback";
}

export interface AgentAttentionResolverOptions {
	[key: string]: unknown;
}

/**
 * Resolve the human-attention state of an agent from current evidence.
 *
 * Important: this is deliberately conservative. A live CLI process does not
 * prove that the model is working, and a quiet terminal does not prove that it
 * is waiting for the user. Precise states are emitted only from lifecycle
 * facts or structured provider events. Everything else degrades to idle or
 * unknown instead of guessing.
 */
export class AgentAttentionResolver {
	constructor(
		private readonly tmux: TmuxIntegration,
		private readonly toolRegistry: CodingToolRegistry,
		_options: AgentAttentionResolverOptions = {},
	) {}

	resolve(agent: Agent): AgentAttentionSnapshot {
		if (agent.status === "done") {
			return {
				status: "done",
				reason: "Agent was explicitly marked done",
				source: "lifecycle",
			};
		}
		if (agent.status === "errored" || agent.lastError) {
			return {
				status: "failed",
				reason: "Agent lifecycle recorded a failure",
				source: "lifecycle",
			};
		}
		if (agent.hasStarted !== true) {
			return {
				status: "unknown",
				reason: "Agent has not started yet",
				source: "lifecycle",
			};
		}

		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(agent.featureId, agent.id);
		let alive = false;
		try {
			alive = this.tmux.isSessionAlive?.(sessionName) ?? false;
		} catch {
			alive = false;
		}
		if (!alive) {
			return {
				status: "unknown",
				reason: "No live tmux session is available",
				source: "tmux",
			};
		}

		let pane: ReturnType<TmuxIntegration["getPaneStatus"]> = null;
		try {
			pane = this.tmux.getPaneStatus?.(sessionName) ?? null;
		} catch {
			pane = null;
		}
		if (pane?.dead) {
			if (pane.exitCode !== 0) {
				return {
					status: "failed",
					reason: `tmux pane exited with code ${pane.exitCode}`,
					source: "tmux",
				};
			}
			return {
				status: "idle",
				reason: "tmux pane exited cleanly",
				source: "tmux",
			};
		}

		const tool = this.toolRegistry.resolveAgentTool(agent.toolId);
		const providerSignal = this.readProviderSignal(tool, agent.sessionId);
		if (providerSignal) {
			return {
				status: providerSignal.status,
				reason: `Provider emitted ${providerSignal.evidence}`,
				source: "provider",
			};
		}

		return {
			status: "unknown",
			reason: "Session is alive but no structured activity signal is available",
			source: "fallback",
		};
	}

	private readProviderSignal(
		tool: import("../../types").CodingTool,
		sessionId: string | null,
	): ProviderAttentionSignal | null {
		if (!sessionId) return null;
		return (
			this.toolRegistry.getStructuredAttentionSignal?.(tool, sessionId) ?? null
		);
	}
}
