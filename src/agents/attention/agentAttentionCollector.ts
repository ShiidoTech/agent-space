import type { Agent, Feature } from "../../types";
import type { AttentionWatchedAgent } from "./agentOperationalTransitions";

/**
 * Minimal structural view of a project context for attention collection.
 *
 * Deliberately narrow: the collector may only touch non-blocking APIs —
 * `listFeaturesCached()` (no Git reconciliation) and `getAgentsAsync()`
 * (async tmux/provider probes). The synchronous twins (`getFeatures`,
 * `getAgents`) exist on real managers but are NOT part of this contract,
 * so tests can prove they are never called on a monitor tick.
 */
export interface AttentionCollectableContext {
	featureManager: {
		listFeaturesCached(): Feature[];
	};
	agentManager: {
		getAgentsReadModel?(featureId: string): Agent[];
		getAgentsAsync(featureId: string): Promise<Agent[]>;
	};
}

/**
 * Build the fleet snapshot for one attention-monitor scan, without ever
 * blocking the Extension Host:
 *
 * - features come from `listFeaturesCached()` — never from `getFeatures()`,
 *   which reconciles branches with synchronous Git execs;
 * - features with no `running` or `errored` agent (per the cached read
 *   model) are skipped entirely: a waiting/working/turn-completed
 *   transition can only happen on a running agent, and `errored` is kept in
 *   because `AgentManager.recordAgentFailure()` sets that lifecycle status
 *   the instant a failure is recorded — skipping it here would mean the
 *   `failed` transition (and its notification) is never observed for a
 *   Feature whose only agent just crashed. `errored` never reaches a live
 *   probe: `AgentAttentionResolver` short-circuits lifecycle-derived
 *   failures before touching tmux/provider evidence, so this costs nothing
 *   beyond the already-cheap `getAgentsAsync()` call itself. Definitively
 *   quiescent lifecycle states (`stopped`, `done`) stay excluded;
 * - remaining agents are probed through `getAgentsAsync()` — async tmux and
 *   provider evidence only, no `execSync`/`execFileSync`.
 */
export async function collectWatchedAgents(
	contexts: readonly AttentionCollectableContext[],
): Promise<AttentionWatchedAgent[]> {
	const watched: AttentionWatchedAgent[] = [];
	for (const ctx of contexts) {
		for (const feature of ctx.featureManager.listFeaturesCached()) {
			const known = ctx.agentManager.getAgentsReadModel?.(feature.id) ?? [];
			if (
				!known.some(
					(agent) => agent.status === "running" || agent.status === "errored",
				)
			) {
				continue;
			}
			const agents = await ctx.agentManager.getAgentsAsync(feature.id);
			for (const agent of agents) {
				watched.push({
					id: agent.id,
					name: agent.name,
					featureId: feature.id,
					featureName: feature.name,
					attentionStatus: agent.attentionStatus,
					attentionReason: agent.attentionReason,
					attentionSource: agent.attentionSource,
				});
			}
		}
	}
	return watched;
}
