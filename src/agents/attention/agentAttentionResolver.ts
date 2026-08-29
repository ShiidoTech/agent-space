import type { Agent, AgentAttentionStatus, AgentStatus } from "../../types";
import type { CodingToolRegistry } from "../codingToolRegistry";
import { openCodeBackendManager } from "../codingToolRegistry";
import type { ProviderAttentionSignal } from "../providers/types";
import type { TmuxIntegration } from "../tmux";

export interface AgentAttentionSnapshot {
	status: AgentAttentionStatus | "unsupported";
	reason: string;
	observedAt?: string;
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

	resolve(agent: Agent, lifecycleState?: AgentStatus): AgentAttentionSnapshot {
		if ((lifecycleState ?? agent.status) === "done") {
			return {
				status: "done",
				reason: "Agent was explicitly marked done",
				source: "lifecycle",
			};
		}
		if ((lifecycleState ?? agent.status) === "errored" || agent.lastError) {
			return {
				status: "failed",
				reason: "Agent lifecycle recorded a failure",
				source: "lifecycle",
			};
		}
		if (lifecycleState === "stopped") {
			return {
				status: "unknown",
				reason: "No live tmux session is available",
				source: "tmux",
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

		const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
		const provider = this.toolRegistry.getProvider
			? this.toolRegistry.getProvider(tool)
			: tool.provider;
		if (
			provider &&
			!Object.values(provider.capabilities.attention).some(Boolean)
		) {
			return {
				status: "unsupported",
				reason: "Activity tracking is unsupported by this provider",
				source: "provider",
			};
		}
		const providerSignal = this.readProviderSignal(
			tool,
			agent.sessionId,
			agent.worktreePath,
		);
		if (providerSignal) {
			const age = describeAge(providerSignal.observedAt);
			return {
				status: providerSignal.status,
				reason: `Provider emitted ${providerSignal.evidence}${age ? ` ${age}` : ""}`,
				source: "provider",
				observedAt: providerSignal.observedAt,
			};
		}

		// No structured evidence is not the same as "nothing is happening".
		// Reporting idle here made a misconfigured provider, an unbound session
		// and a genuinely quiet agent look identical, and hid exactly the state
		// the user needs to see. Say unknown, and say why.
		return {
			status: "unknown",
			reason: unboundReason(agent),
			source: "fallback",
		};
	}

	/**
	 * Non-blocking twin of {@link resolve}: identical decision tree and
	 * identical semantics, but the tmux probes run through the async helpers
	 * (`isSessionAliveAsync` / `getPaneStatusAsync`) so background observers
	 * (attention monitoring) never block the Extension Host on a subprocess.
	 */
	async resolveAsync(
		agent: Agent,
		lifecycleState?: AgentStatus,
	): Promise<AgentAttentionSnapshot> {
		if ((lifecycleState ?? agent.status) === "done") {
			return {
				status: "done",
				reason: "Agent was explicitly marked done",
				source: "lifecycle",
			};
		}
		if ((lifecycleState ?? agent.status) === "errored" || agent.lastError) {
			return {
				status: "failed",
				reason: "Agent lifecycle recorded a failure",
				source: "lifecycle",
			};
		}
		if (lifecycleState === "stopped") {
			return {
				status: "unknown",
				reason: "No live tmux session is available",
				source: "tmux",
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
			alive = (await this.tmux.isSessionAliveAsync?.(sessionName)) ?? false;
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

		let pane: Awaited<ReturnType<TmuxIntegration["getPaneStatusAsync"]>> = null;
		try {
			pane = (await this.tmux.getPaneStatusAsync?.(sessionName)) ?? null;
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

		const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
		const provider = this.toolRegistry.getProvider
			? this.toolRegistry.getProvider(tool)
			: tool.provider;
		if (
			provider &&
			!Object.values(provider.capabilities.attention).some(Boolean)
		) {
			return {
				status: "unsupported",
				reason: "Activity tracking is unsupported by this provider",
				source: "provider",
			};
		}
		const providerSignal = await this.readProviderSignalAsync(
			tool,
			agent.sessionId,
			agent.worktreePath,
		);
		if (providerSignal) {
			const age = describeAge(providerSignal.observedAt);
			return {
				status: providerSignal.status,
				reason: `Provider emitted ${providerSignal.evidence}${age ? ` ${age}` : ""}`,
				source: "provider",
				observedAt: providerSignal.observedAt,
			};
		}

		return {
			status: "unknown",
			reason: unboundReason(agent),
			source: "fallback",
		};
	}

	private async readProviderSignalAsync(
		tool: import("../../types").CodingTool,
		sessionId: string | null,
		agentCwd?: string,
	): Promise<ProviderAttentionSignal | null> {
		if (!sessionId) return null;
		return (
			(await this.toolRegistry.getStructuredAttentionSignalAsync?.(
				tool,
				sessionId,
				agentCwd,
			)) ?? null
		);
	}

	private readProviderSignal(
		tool: import("../../types").CodingTool,
		sessionId: string | null,
		cwd?: string,
	): ProviderAttentionSignal | null {
		if (!sessionId) return null;
		return (
			this.toolRegistry.getStructuredAttentionSignal?.(tool, sessionId, cwd) ??
			null
		);
	}
}

/**
 * Explain an absent signal in the agent's own terms. The binding state is the
 * usual answer: no session bound means there is nothing to read, which is a
 * different problem from a provider that reports nothing.
 */
function unboundReason(agent: Agent): string {
	const binding = agent.sessionBinding;
	if (!agent.sessionId) {
		return binding?.detail
			? `No provider session bound yet — ${lowerFirst(binding.detail)}`
			: "No provider session is bound to this agent yet";
	}
	if (binding?.state === "unverified") {
		return `Bound session id is not in the provider store — ${lowerFirst(binding.detail)}`;
	}
	if (binding?.state === "ambiguous") {
		return `Cannot tell which provider session belongs to this agent — ${lowerFirst(binding.detail)}`;
	}
	if (binding?.state === "unsupported") {
		return "This provider exposes no structured activity signal";
	}
	return "Session is alive but the provider reported no structured activity";
}

/**
 * Report how long the current state has held, when the provider timestamps its
 * events. This is presentation only: an old `working` is still `working`,
 * because silence is not evidence that a human is being waited on.
 */
function describeAge(observedAt: string | undefined): string | null {
	if (!observedAt) return null;
	const parsed = Date.parse(observedAt);
	if (Number.isNaN(parsed)) return null;
	const seconds = Math.floor((Date.now() - parsed) / 1000);
	if (seconds < 0) return null;
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

function lowerFirst(value: string): string {
	return value.charAt(0).toLowerCase() + value.slice(1);
}
