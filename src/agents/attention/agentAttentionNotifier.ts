export interface AttentionWatchedAgent {
	readonly id: string;
	readonly name: string;
	readonly featureId?: string;
	readonly featureName?: string;
	readonly attentionStatus?: string;
	readonly attentionReason?: string;
}

export interface AgentAttentionAlert {
	readonly agentId: string;
	readonly agentName: string;
	readonly featureId?: string;
	readonly featureName?: string;
	readonly reason?: string;
}

/**
 * Detects transitions into `waiting_for_user` across repeated scans of the
 * agent fleet. Pure state machine — no VS Code imports — so the notification
 * policy stays unit-testable and the host decides how to surface each alert.
 *
 * Dedup rule: one alert per continuous waiting episode. An agent that leaves
 * the waiting state and re-enters it later alerts again; an agent absent from
 * a scan is forgotten, so reappearing while still waiting alerts once more.
 */
export class AgentAttentionNotifier {
	private waitingAgents = new Set<string>();

	scan(agents: readonly AttentionWatchedAgent[]): AgentAttentionAlert[] {
		const nowWaiting = new Set<string>();
		const alerts: AgentAttentionAlert[] = [];
		for (const agent of agents) {
			if (agent.attentionStatus !== "waiting_for_user") continue;
			nowWaiting.add(agent.id);
			if (!this.waitingAgents.has(agent.id)) {
				alerts.push({
					agentId: agent.id,
					agentName: agent.name,
					...(agent.featureId ? { featureId: agent.featureId } : {}),
					...(agent.featureName ? { featureName: agent.featureName } : {}),
					...(agent.attentionReason ? { reason: agent.attentionReason } : {}),
				});
			}
		}
		this.waitingAgents = nowWaiting;
		return alerts;
	}
}
