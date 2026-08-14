import type {
	AncestryObservation,
	FeatureGitObservations,
	GitObservation,
	ObservedCommit,
} from "../git/featureGitObservations";
import type {
	GitHubObservation,
	GitHubObservationStatus,
} from "../github/githubObservation";
import type { PullRequestObservation } from "../github/pullRequest";
import type { FeatureDeliveryObservation } from "./featureSnapshot";

export interface IntegrationEvidence {
	readonly createdFromSha?: string;
	readonly feature?: ObservedCommit;
	readonly base?: ObservedCommit;
	readonly creationPoint?: ObservedCommit;
	readonly ancestor?: ObservedCommit;
	readonly descendant?: ObservedCommit;
	readonly observed?: Readonly<Record<string, unknown>>;
	readonly delivery?: IntegrationDeliveryEvidence;
	/**
	 * GitHub-side proof kept distinct from the local Git SHAs. Local Git and
	 * GitHub never silently fuse: each SHA's provenance is preserved here.
	 */
	readonly github?: IntegrationGithubEvidence;
}

export interface IntegrationDeliveryEvidence {
	readonly branchRef: string;
	readonly head?: ObservedCommit;
	readonly headStatus: "known" | "unknown";
	readonly activeRelation?: AncestryObservation;
	readonly activeRelationStatus: "known" | "unknown";
	readonly commitsAfter?: number;
}

export interface IntegrationGithubEvidence {
	readonly status: GitHubObservationStatus;
	readonly reason?: string;
	readonly detail?: string;
	readonly expectedBaseRef?: string;
	/** The selected pull request when one was resolved. */
	readonly pull?: PullRequestObservation;
	/** Whether the selected PR's base matches Agent Space's expected base. */
	readonly baseMatch?: boolean;
	/** Local resolution of the merged PR head as an observed commit. */
	readonly mergedHead?: ObservedCommit;
	readonly mergedHeadIsAncestor?: boolean;
	readonly commitsAfterIntegration?: number;
}

export type IntegrationOutcome =
	| "no_feature_commits"
	| "not_integrated"
	| "integrated_by_ancestry"
	| "integrated_by_pull_request"
	| "integrated_to_other_base"
	| "pull_request_open"
	| "new_work_after_integration";

export type IntegrationUnknownReason =
	| "ancestry_unknown"
	| "creation_point_unknown"
	| "creation_point_invalid"
	| "evidence_mismatch"
	| "integration_unknown"
	| "integrated_head_rewritten"
	| "ambiguous_pull_requests";

export type IntegrationEvaluation =
	| {
			readonly status: "known";
			readonly outcome: IntegrationOutcome;
			readonly evidence: IntegrationEvidence;
	  }
	| {
			readonly status: "unknown";
			readonly reason: IntegrationUnknownReason;
			readonly detail?: string;
			readonly evidence: IntegrationEvidence;
	  };

/**
 * Local Git proof relating a merged PR head to the current feature head.
 * Produced by FeatureGitInspector, never by GitHub: it answers "is the merged
 * head an ancestor of our local work, and how much work sits after it?".
 */
export interface MergedHeadGitEvidence {
	readonly mergedHeadSha: string;
	readonly relation: GitObservation<AncestryObservation>;
	readonly commitsAfter: GitObservation<{
		readonly ancestorSha: string;
		readonly descendantSha: string;
		readonly count: number;
	}>;
}

export interface IntegrationEvaluationInput {
	readonly git: FeatureGitObservations;
	readonly github?: GitHubObservation;
	readonly createdFromSha?: string;
	readonly mergedHead?: MergedHeadGitEvidence;
	readonly delivery?: FeatureDeliveryObservation;
}

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * Evaluate feature integration by combining local commit-graph evidence with
 * GitHub pull-request evidence.
 *
 * Ordering matters:
 * - a proven local ancestry always wins (it is the strongest, non-refutable
 *   statement);
 * - otherwise GitHub explains the not-in-base state (squash merge, open PR,
 *   new work after a merge, rewritten branch);
 * - when GitHub cannot be observed, the conclusion stays `unknown`: a squash
 *   merge cannot be ruled out from Git alone.
 */
export function evaluateIntegration(
	input: IntegrationEvaluationInput,
): IntegrationEvaluation {
	const { git, github, createdFromSha } = input;
	const evidence = buildBaseEvidence(git, createdFromSha, input.delivery);

	const inputError = checkAncestryInput(git, createdFromSha, evidence);
	if (inputError) return inputError;

	if (
		git.featureInBase.status === "known" &&
		git.featureInBase.value.isAncestor
	) {
		// A feature tip proven reachable from the base already proves that all
		// commits reachable from that feature branch are integrated. Older
		// persisted Features may not have a creation SHA, but that metadata is
		// not needed for this direct ancestry proof.
		if (!createdFromSha) {
			return {
				status: "known",
				outcome: "integrated_by_ancestry",
				evidence,
			};
		}
		return evaluateByAncestry(git, createdFromSha, evidence);
	}
	return evaluateByRemote(
		git,
		github,
		input.mergedHead,
		input.delivery,
		evidence,
	);
}

export class IntegrationEvaluator {
	evaluate(input: IntegrationEvaluationInput): IntegrationEvaluation {
		return evaluateIntegration(input);
	}
}

function evaluateByAncestry(
	git: FeatureGitObservations,
	createdFromSha: string | undefined,
	evidence: IntegrationEvidence,
): IntegrationEvaluation {
	if (!createdFromSha) {
		return { status: "unknown", reason: "creation_point_unknown", evidence };
	}
	if (!FULL_SHA.test(createdFromSha)) {
		return { status: "unknown", reason: "creation_point_invalid", evidence };
	}
	if (
		git.creationPoint.status === "unknown" ||
		git.creationPointInFeature.status === "unknown"
	) {
		const creationUnknown =
			git.creationPoint.status === "unknown" &&
			git.creationPoint.reason === "creation_point_invalid";
		return {
			status: "unknown",
			reason: creationUnknown
				? "creation_point_invalid"
				: "creation_point_unknown",
			detail:
				git.creationPoint.status === "unknown"
					? git.creationPoint.message
					: git.creationPointInFeature.status === "unknown"
						? git.creationPointInFeature.message
						: undefined,
			evidence,
		};
	}
	if (git.feature.status === "unknown") {
		return { status: "unknown", reason: "ancestry_unknown", evidence };
	}
	if (
		git.creationPoint.value.sha.toLowerCase() !==
			createdFromSha.toLowerCase() ||
		git.creationPointInFeature.value.ancestor.sha !==
			git.creationPoint.value.sha ||
		git.creationPointInFeature.value.descendant.sha !== git.feature.value.sha
	) {
		return { status: "unknown", reason: "evidence_mismatch", evidence };
	}
	if (!git.creationPointInFeature.value.isAncestor) {
		return { status: "unknown", reason: "creation_point_invalid", evidence };
	}
	if (
		git.feature.value.sha.toLowerCase() ===
		git.creationPoint.value.sha.toLowerCase()
	) {
		return { status: "known", outcome: "no_feature_commits", evidence };
	}
	return { status: "known", outcome: "integrated_by_ancestry", evidence };
}

function evaluateByRemote(
	git: FeatureGitObservations,
	github: GitHubObservation | undefined,
	mergedHead: MergedHeadGitEvidence | undefined,
	delivery: FeatureDeliveryObservation | undefined,
	evidence: IntegrationEvidence,
): IntegrationEvaluation {
	if (github?.status !== "known") {
		const info = githubObservationInfo(github);
		return {
			status: "unknown",
			reason: "integration_unknown",
			detail: github
				? `GitHub observation is ${github.status}; a squash merge cannot be ruled out.`
				: "GitHub evidence was not observed; a squash merge cannot be ruled out.",
			evidence: withGithubEvidence(evidence, {
				status: info.status,
				...(info.reason ? { reason: info.reason } : {}),
				...(info.detail ? { detail: info.detail } : {}),
			}),
		};
	}

	const resolution = github.resolution;
	const expectedBaseRef = github.expectedBaseRef;

	if (resolution.outcome === "no_pr") {
		return {
			status: "known",
			outcome: "not_integrated",
			evidence: withGithubEvidence(evidence, {
				status: "known",
				...(expectedBaseRef ? { expectedBaseRef } : {}),
			}),
		};
	}
	if (resolution.outcome === "ambiguous") {
		return {
			status: "unknown",
			reason: "ambiguous_pull_requests",
			detail:
				"Several pull request candidates exist and none can be selected deterministically.",
			evidence: withGithubEvidence(evidence, {
				status: "known",
				...(expectedBaseRef ? { expectedBaseRef } : {}),
			}),
		};
	}

	const pull = resolution.pull;
	const githubEvidence: IntegrationGithubEvidence = {
		status: "known",
		...(expectedBaseRef ? { expectedBaseRef } : {}),
		pull,
		baseMatch:
			expectedBaseRef !== undefined ? pull.baseRef === expectedBaseRef : true,
	};

	if (pull.state === "open") {
		return {
			status: "known",
			outcome: "pull_request_open",
			evidence: withGithubEvidence(evidence, githubEvidence),
		};
	}
	if (pull.state === "closed") {
		return {
			status: "known",
			outcome: "not_integrated",
			evidence: withGithubEvidence(evidence, githubEvidence),
		};
	}

	// merged:
	if (expectedBaseRef !== undefined && pull.baseRef !== expectedBaseRef) {
		return {
			status: "known",
			outcome: "integrated_to_other_base",
			evidence: withGithubEvidence(evidence, {
				...githubEvidence,
				baseMatch: false,
			}),
		};
	}

	const featureHead =
		git.feature.status === "known" ? git.feature.value.sha : undefined;
	const deliveryHead =
		delivery?.head.status === "known" ? delivery.head.value.sha : featureHead;
	if (delivery && delivery.head.status === "unknown") {
		return {
			status: "unknown",
			reason: "integration_unknown",
			detail: "The delivery branch head could not be resolved locally.",
			evidence: withGithubEvidence(evidence, githubEvidence),
		};
	}
	if (deliveryHead && sameSha(pull.headSha, deliveryHead)) {
		if (!delivery || !featureHead || sameSha(deliveryHead, featureHead)) {
			return {
				status: "known",
				outcome: "integrated_by_pull_request",
				evidence: withGithubEvidence(evidence, githubEvidence),
			};
		}
		if (delivery.activeRelation.status === "unknown") {
			return {
				status: "unknown",
				reason: "integration_unknown",
				detail:
					delivery.activeRelation.message ??
					"The active branch relation to the delivered branch is unknown.",
				evidence: withGithubEvidence(evidence, githubEvidence),
			};
		}
		if (!delivery.activeRelation.value.isAncestor) {
			return {
				status: "unknown",
				reason: "integrated_head_rewritten",
				detail: "The active branch does not descend from the delivered branch.",
				evidence: withGithubEvidence(evidence, githubEvidence),
			};
		}
		return {
			status: "known",
			outcome: "new_work_after_integration",
			evidence: withGithubEvidence(evidence, {
				...githubEvidence,
				mergedHead: { ref: delivery.branchRef, sha: deliveryHead },
				mergedHeadIsAncestor: true,
				...(delivery.commitsAfter.status === "known"
					? { commitsAfterIntegration: delivery.commitsAfter.value.count }
					: {}),
			}),
		};
	}
	if (featureHead && sameSha(pull.headSha, featureHead)) {
		return {
			status: "known",
			outcome: "integrated_by_pull_request",
			evidence: withGithubEvidence(evidence, githubEvidence),
		};
	}

	const proof = mergedHead;
	if (!proof || !sameSha(proof.mergedHeadSha, pull.headSha)) {
		return {
			status: "unknown",
			reason: "integration_unknown",
			detail:
				"The merged PR head SHA could not be tied to the local feature head.",
			evidence: withGithubEvidence(evidence, githubEvidence),
		};
	}
	const withMergedHead = withGithubEvidence(evidence, {
		...githubEvidence,
		mergedHead: { ref: pull.headSha, sha: pull.headSha },
	});
	if (proof.relation.status === "unknown") {
		return {
			status: "unknown",
			reason: "integration_unknown",
			detail:
				proof.relation.message ??
				"The merged-head relation could not be observed locally.",
			evidence: withMergedHead,
		};
	}
	const mergedHeadIsAncestor = proof.relation.value.isAncestor;
	const mergesEvidence = (
		extra?: Partial<IntegrationGithubEvidence>,
	): IntegrationEvidence =>
		withGithubEvidence(evidence, {
			...githubEvidence,
			mergedHead: { ref: pull.headSha, sha: pull.headSha },
			mergedHeadIsAncestor,
			...extra,
		});
	if (!mergedHeadIsAncestor) {
		return {
			status: "unknown",
			reason: "integrated_head_rewritten",
			detail:
				"The merged PR head is not an ancestor of the current feature head; the branch may have been rewritten.",
			evidence: mergesEvidence(),
		};
	}
	if (proof.commitsAfter.status === "known") {
		return {
			status: "known",
			outcome: "new_work_after_integration",
			evidence: mergesEvidence({
				commitsAfterIntegration: proof.commitsAfter.value.count,
			}),
		};
	}
	return {
		status: "known",
		outcome: "new_work_after_integration",
		evidence: mergesEvidence(),
	};
}

function checkAncestryInput(
	git: FeatureGitObservations,
	createdFromSha: string | undefined,
	evidence: IntegrationEvidence,
): IntegrationEvaluation | null {
	if (git.featureInBase.status === "unknown") {
		return {
			status: "unknown",
			reason: "ancestry_unknown",
			detail: git.featureInBase.message,
			evidence,
		};
	}
	if (git.feature.status === "unknown" || git.base.status === "unknown") {
		return { status: "unknown", reason: "ancestry_unknown", evidence };
	}
	if (
		git.featureInBase.value.ancestor.sha !== git.feature.value.sha ||
		git.featureInBase.value.descendant.sha !== git.base.value.sha
	) {
		return { status: "unknown", reason: "evidence_mismatch", evidence };
	}
	if (
		git.feature.value.sha === git.base.value.sha &&
		git.feature.value.sha.toLowerCase() !== createdFromSha?.toLowerCase()
	) {
		return { status: "unknown", reason: "ancestry_unknown", evidence };
	}
	return null;
}

function buildBaseEvidence(
	observations: FeatureGitObservations,
	createdFromSha?: string,
	delivery?: FeatureDeliveryObservation,
): IntegrationEvidence {
	const partialEvidence = {
		...(observations.feature.status === "unknown" &&
		observations.feature.observed
			? { feature: observations.feature.observed }
			: {}),
		...(observations.base.status === "unknown" && observations.base.observed
			? { base: observations.base.observed }
			: {}),
		...(observations.featureInBase.status === "unknown" &&
		observations.featureInBase.observed
			? { ancestry: observations.featureInBase.observed }
			: {}),
	};
	return {
		...(createdFromSha ? { createdFromSha } : {}),
		...(observations.feature.status === "known"
			? { feature: observations.feature.value }
			: {}),
		...(observations.base.status === "known"
			? { base: observations.base.value }
			: {}),
		...(observations.creationPoint.status === "known"
			? { creationPoint: observations.creationPoint.value }
			: {}),
		...(observations.featureInBase.status === "known"
			? {
					ancestor: observations.featureInBase.value.ancestor,
					descendant: observations.featureInBase.value.descendant,
				}
			: {}),
		...(Object.keys(partialEvidence).length > 0
			? { observed: partialEvidence }
			: {}),
		...(delivery ? { delivery: deliveryEvidence(delivery) } : {}),
	};
}

function deliveryEvidence(
	delivery: FeatureDeliveryObservation,
): IntegrationDeliveryEvidence {
	return {
		branchRef: delivery.branchRef,
		headStatus: delivery.head.status,
		...(delivery.head.status === "known" ? { head: delivery.head.value } : {}),
		activeRelationStatus: delivery.activeRelation.status,
		...(delivery.activeRelation.status === "known"
			? { activeRelation: delivery.activeRelation.value }
			: {}),
		...(delivery.commitsAfter.status === "known"
			? { commitsAfter: delivery.commitsAfter.value.count }
			: {}),
	};
}

function withGithubEvidence(
	evidence: IntegrationEvidence,
	github: IntegrationGithubEvidence,
): IntegrationEvidence {
	return { ...evidence, github };
}

function githubObservationInfo(observation: GitHubObservation | undefined): {
	status: GitHubObservationStatus;
	reason?: string;
	detail?: string;
} {
	if (!observation) {
		return { status: "unavailable", reason: "not_observed" };
	}
	switch (observation.status) {
		case "known":
			return { status: "known" };
		case "unavailable":
			return {
				status: "unavailable",
				reason: observation.reason,
				...(observation.detail ? { detail: observation.detail } : {}),
			};
		case "unknown":
			return {
				status: "unknown",
				reason: observation.reason,
				...(observation.detail ? { detail: observation.detail } : {}),
			};
		case "error":
			return {
				status: "error",
				reason: observation.reason,
				detail: observation.detail,
			};
	}
}

function sameSha(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}
