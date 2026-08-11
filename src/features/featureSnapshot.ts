import type { FeatureGitObservations } from "../git/featureGitObservations";
import type { Feature, GitAwareStatus } from "../types";
import type { AttentionProblem } from "./attentionEvaluator";
import type { IntegrationEvaluation } from "./integrationEvaluator";
import type { FeatureRuntimeObservation } from "./runtimeObservation";

/** Ephemeral, non-persisted state consumed by feature presentations. */
export interface FeatureSnapshot {
	readonly projectId: string;
	readonly feature: Readonly<Feature>;
	readonly source: FeatureSnapshotSource;
	readonly git: FeatureGitObservations;
	readonly integration: IntegrationEvaluation;
	readonly runtime: FeatureRuntimeObservation;
	readonly attention: readonly AttentionProblem[];
	readonly observedAt: string;
}

export type FeatureSnapshotSource =
	| { readonly status: "known" }
	| {
			readonly status: "unknown";
			readonly reason: "storage_read_failed";
			readonly detail: string;
	  };

export function createFeatureSnapshot(value: FeatureSnapshot): FeatureSnapshot {
	return deepFreeze(structuredClone(value));
}

export function featureSnapshotGitStatus(
	snapshot: FeatureSnapshot,
): GitAwareStatus {
	if (snapshot.git.workingTree.status === "unknown") return "unknown";
	const changes = snapshot.git.workingTree.value;
	if (
		changes.staged.length > 0 ||
		changes.unstaged.length > 0 ||
		changes.untracked.length > 0 ||
		changes.conflicted.length > 0
	) {
		return "modified";
	}
	if (
		snapshot.git.worktree.status === "unknown" ||
		!snapshot.git.worktree.value.present ||
		snapshot.git.branch.status === "unknown" ||
		!snapshot.git.branch.value.matchesExpected ||
		snapshot.git.head.status === "unknown" ||
		snapshot.git.feature.status === "unknown" ||
		snapshot.git.head.value.sha !== snapshot.git.feature.value.sha
	) {
		return "unknown";
	}
	if (snapshot.integration.status === "unknown") return "unknown";
	if (snapshot.integration.outcome === "integrated_by_ancestry")
		return "merged";
	if (snapshot.integration.outcome === "no_feature_commits") return "new";
	return snapshot.git.featureDelta.status === "known" &&
		snapshot.git.featureDelta.value.rightOnly > 0
		? "ahead"
		: "unknown";
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
	}
	return value;
}
