import type {
	AncestryObservation,
	FeatureGitObservations,
	GitObservation,
	GitUnknownReason,
	ObservedCommit,
} from "../git/featureGitObservations";
import type { GitHubObservation } from "../github/githubObservation";
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
	/** Delivery ref and its separately observed relation to the active checkout. */
	readonly delivery?: FeatureDeliveryObservation;
	readonly github: GitHubObservation;
	readonly integration: IntegrationEvaluation;
	readonly runtime: FeatureRuntimeObservation;
	readonly attention: readonly AttentionProblem[];
	readonly observedAt: string;
}

export interface FeatureDeliveryObservation {
	readonly branchRef: string;
	readonly head: GitObservation<ObservedCommit>;
	readonly activeRelation: GitObservation<AncestryObservation>;
	readonly commitsAfter: GitObservation<{
		readonly ancestorSha: string;
		readonly descendantSha: string;
		readonly count: number;
	}>;
	/**
	 * Explicit delivery source: the branch through which the delivered work was
	 * actually carried and proven integrated by a merged pull request. The
	 * delivery `branchRef` remains the feature's historical branch; `deliveredVia`
	 * records the branch that GitHub proved as the merged PR head (e.g. an agent
	 * checked out a continuation branch and delivered there).
	 */
	readonly deliveredVia?: FeatureDeliveredVia;
}

export interface FeatureDeliveredVia {
	readonly branchRef: string;
	readonly head: ObservedCommit;
	readonly pullNumber: number;
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

/**
 * Legacy badge projection for screens that predate FeatureSnapshot semantics.
 * Deliberately a projection: FeatureSnapshot / IntegrationEvaluation /
 * GitHubObservation remain the source of truth and no new logic ever derives
 * state from GitAwareStatus.
 */
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
	switch (snapshot.integration.outcome) {
		case "integrated_by_ancestry":
		case "integrated_to_other_base":
			return "integrated";
		case "integrated_by_pull_request":
			return "merged";
		case "no_feature_commits":
			return "new";
		case "not_integrated":
		case "pull_request_open":
		case "new_work_after_integration":
			return "ahead";
	}
	return snapshot.git.featureDelta.status === "known" &&
		snapshot.git.featureDelta.value.rightOnly > 0
		? "ahead"
		: "unknown";
}

/**
 * Reasons a re-observation can plausibly fail purely transiently (a slow or
 * momentarily overloaded git subprocess) rather than proving the fact is
 * actually unavailable. Only these fall back to the previously known value.
 */
const TRANSIENT_GIT_REASONS: ReadonlySet<GitUnknownReason> = new Set([
	"git_command_failed",
	"repository_unavailable",
]);

/**
 * Do not let a transient read failure regress a known fact back to unknown.
 * Applied field-by-field so a single flaky `git` subprocess call cannot wipe
 * out unrelated evidence that was previously proven.
 */
export function preferKnownGit(
	previous: FeatureGitObservations | undefined,
	next: FeatureGitObservations,
): FeatureGitObservations {
	if (!previous) return next;
	const merged = { ...next };
	for (const key of Object.keys(next) as (keyof FeatureGitObservations)[]) {
		const nextField = next[key] as GitObservation<unknown>;
		const previousField = previous[key] as GitObservation<unknown>;
		if (
			nextField.status === "unknown" &&
			TRANSIENT_GIT_REASONS.has(nextField.reason) &&
			previousField?.status === "known"
		) {
			(merged as Record<string, unknown>)[key] = previousField;
		}
	}
	return merged;
}

export function preferKnownDelivery(
	previous: FeatureDeliveryObservation | undefined,
	next: FeatureDeliveryObservation,
): FeatureDeliveryObservation {
	if (!previous || previous.branchRef !== next.branchRef) return next;
	const preferField = <T>(
		nextField: GitObservation<T>,
		previousField: GitObservation<T>,
	): GitObservation<T> =>
		nextField.status === "unknown" &&
		TRANSIENT_GIT_REASONS.has(nextField.reason) &&
		previousField.status === "known"
			? previousField
			: nextField;
	return {
		...next,
		head: preferField(next.head, previous.head),
		activeRelation: preferField(next.activeRelation, previous.activeRelation),
		commitsAfter: preferField(next.commitsAfter, previous.commitsAfter),
	};
}

/** A GitHub API/network error keeps the last known PR evidence visible. */
export function preferKnownGithub(
	previous: GitHubObservation | undefined,
	next: GitHubObservation,
): GitHubObservation {
	if (next.status === "error" && previous?.status === "known") return previous;
	return next;
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
