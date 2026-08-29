import type { FeatureSnapshot } from "../features/featureSnapshot";
import type { AgentRuntimeEvidence } from "../features/runtimeObservation";
import type { Agent } from "../types";
import type { AgentObservation } from "./observation/types";

export type FleetRollupBucket =
	| "needsYou"
	| "failed"
	| "readyForReview"
	| "working"
	| "unknown";

export interface FleetRollupItem {
	readonly bucket: FleetRollupBucket;
	readonly featureId: string;
	readonly agentId: string;
}

export interface FleetRollup {
	readonly needsYou: number;
	readonly failed: number;
	readonly readyForReview: number;
	readonly working: number;
	readonly unknown: number;
	readonly items: readonly FleetRollupItem[];
}

export interface FleetAgentInput {
	readonly agent: Agent;
	readonly observation: AgentObservation;
	readonly runtime?: AgentRuntimeEvidence;
}

/** Shared, provider-neutral fleet projection. Lifecycle and delivery stay out. */
export function projectFleetRollup(
	inputs: readonly FleetAgentInput[],
): FleetRollup {
	const counts = {
		needsYou: 0,
		failed: 0,
		readyForReview: 0,
		working: 0,
		unknown: 0,
	};
	const items: FleetRollupItem[] = [];
	for (const input of inputs) {
		const { agent, observation } = input;
		const bindingDegraded =
			agent.sessionBinding?.state === "ambiguous" ||
			agent.sessionBinding?.state === "unverified";
		const runtimeLost =
			input.runtime?.tmuxAlive.status === "known" &&
			input.runtime.tmuxAlive.value === false &&
			agent.status === "running";
		let bucket: FleetRollupBucket;
		if (
			observation.lifecycle.state === "running" &&
			observation.attention.state === "waiting_for_user"
		) {
			bucket = "needsYou";
		} else if (
			observation.lifecycle.state === "errored" ||
			(observation.lifecycle.state === "running" &&
				(observation.attention.state === "failed" ||
					bindingDegraded ||
					runtimeLost))
		) {
			bucket = "failed";
		} else if (
			observation.lifecycle.state === "running" &&
			observation.review.pending
		) {
			bucket = "readyForReview";
		} else if (
			observation.lifecycle.state === "running" &&
			observation.attention.state === "working"
		) {
			bucket = "working";
		} else {
			bucket = "unknown";
		}
		counts[bucket] += 1;
		items.push({ bucket, featureId: agent.featureId, agentId: agent.id });
	}
	return { ...counts, items };
}

export function projectSnapshotFleetRollup(
	snapshots: readonly FeatureSnapshot[],
	observe: (agent: Agent, snapshot: FeatureSnapshot) => AgentObservation,
): FleetRollup {
	const inputs: FleetAgentInput[] = [];
	for (const snapshot of snapshots) {
		if (snapshot.runtime.agents.status !== "known") continue;
		for (const evidence of snapshot.runtime.agents.value) {
			inputs.push({
				agent: evidence.agent as Agent,
				observation: observe(evidence.agent as Agent, snapshot),
				runtime: evidence,
			});
		}
	}
	return projectFleetRollup(inputs);
}

export function formatFleetRollup(rollup: FleetRollup): string {
	const parts = [
		[rollup.needsYou, "need you"],
		[rollup.failed, "failed"],
		[rollup.readyForReview, "ready for review"],
		[rollup.working, "working"],
		[rollup.unknown, "unknown"],
	] as const;
	return (
		parts
			.filter(([count]) => count > 0)
			.map(([count, label]) => `${count} ${label}`)
			.join(" · ") || "No active agents"
	);
}
