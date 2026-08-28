export interface AttentionWatchedAgent {
	readonly id: string;
	readonly name: string;
	readonly featureId?: string;
	readonly featureName?: string;
	readonly attentionStatus?: string;
	readonly attentionReason?: string;
}

export type AgentOperationalTransitionKind =
	| "working_started"
	| "attention_required"
	| "turn_completed"
	| "failed";

export interface AgentOperationalTransition {
	readonly kind: AgentOperationalTransitionKind;
	readonly agentId: string;
	readonly agentName: string;
	readonly featureId?: string;
	readonly featureName?: string;
	readonly reason?: string;
}

/**
 * Detects provider-neutral operational transitions across repeated scans of
 * the agent fleet: {@link AgentOperationalTransitionKind}. Pure state
 * machine — no VS Code imports — so the notification policy stays
 * unit-testable and the host decides how to surface each transition.
 *
 * Deliberately narrow (issue #120, section B): only transitions derivable
 * from `attentionStatus` alone are emitted here. `runtime_lost` and
 * `binding_degraded` need session-binding evidence that isn't part of
 * {@link AttentionWatchedAgent} yet, so they're left for a later slice
 * rather than guessed at from an agent's mere absence from a scan — an
 * agent can just as well be missing because a running feature/agent was
 * legitimately stopped by the user, and inventing a transition from silence
 * would violate the "no notification is invented from terminal silence"
 * rule.
 *
 * Dedup rule: one transition per continuous episode of a given status. An
 * agent that leaves a status and re-enters it later transitions again; an
 * agent absent from a scan is forgotten, so reappearing in the same status
 * transitions once more (matches the pre-existing waiting-only behavior).
 */
export class AgentOperationalTransitionDetector {
	private lastStatus = new Map<string, string | undefined>();

	scan(agents: readonly AttentionWatchedAgent[]): AgentOperationalTransition[] {
		const nextStatus = new Map<string, string | undefined>();
		const transitions: AgentOperationalTransition[] = [];

		for (const agent of agents) {
			const previous = this.lastStatus.get(agent.id);
			const current = agent.attentionStatus;
			nextStatus.set(agent.id, current);

			const kind = transitionKind(previous, current);
			if (!kind) continue;
			transitions.push({
				kind,
				agentId: agent.id,
				agentName: agent.name,
				...(agent.featureId ? { featureId: agent.featureId } : {}),
				...(agent.featureName ? { featureName: agent.featureName } : {}),
				...(agent.attentionReason ? { reason: agent.attentionReason } : {}),
			});
		}

		this.lastStatus = nextStatus;
		return transitions;
	}
}

function transitionKind(
	previous: string | undefined,
	current: string | undefined,
): AgentOperationalTransitionKind | undefined {
	switch (current) {
		case "waiting_for_user":
			return previous !== "waiting_for_user" ? "attention_required" : undefined;
		case "failed":
			return previous !== "failed" ? "failed" : undefined;
		// A completed turn is distinguishable from Agent Space lifecycle
		// `done` (issue #120, section D): only a working -> idle edge counts,
		// never idle/unknown/unsupported settling into "done".
		case "idle":
			return previous === "working" ? "turn_completed" : undefined;
		case "working":
			return previous !== "working" ? "working_started" : undefined;
		default:
			return undefined;
	}
}
