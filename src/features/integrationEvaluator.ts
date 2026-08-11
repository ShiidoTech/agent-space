import type {
	FeatureGitObservations,
	ObservedCommit,
} from "../git/featureGitObservations";

export interface IntegrationEvidence {
	readonly createdFromSha?: string;
	readonly feature?: ObservedCommit;
	readonly base?: ObservedCommit;
	readonly creationPoint?: ObservedCommit;
	readonly ancestor?: ObservedCommit;
	readonly descendant?: ObservedCommit;
	readonly observed?: Readonly<Record<string, unknown>>;
}

export type IntegrationEvaluation =
	| {
			readonly status: "known";
			readonly outcome: "integrated_by_ancestry";
			readonly evidence: IntegrationEvidence;
	  }
	| {
			readonly status: "known";
			readonly outcome: "not_integrated_by_ancestry";
			readonly evidence: IntegrationEvidence;
	  }
	| {
			readonly status: "known";
			readonly outcome: "no_feature_commits";
			readonly evidence: IntegrationEvidence;
	  }
	| {
			readonly status: "unknown";
			readonly reason:
				| "ancestry_unknown"
				| "creation_point_unknown"
				| "creation_point_invalid"
				| "evidence_mismatch";
			readonly detail?: string;
			readonly evidence: IntegrationEvidence;
	  };

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** Evaluate integration exclusively from already-observed local commit-graph data. */
export function evaluateIntegration(
	observations: FeatureGitObservations,
	createdFromSha?: string,
): IntegrationEvaluation {
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
	const evidence: IntegrationEvidence = {
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
	};

	if (observations.featureInBase.status === "unknown") {
		return {
			status: "unknown",
			reason: "ancestry_unknown",
			detail: observations.featureInBase.message,
			evidence,
		};
	}
	if (
		observations.feature.status === "unknown" ||
		observations.base.status === "unknown"
	) {
		return { status: "unknown", reason: "ancestry_unknown", evidence };
	}
	if (
		observations.featureInBase.value.ancestor.sha !==
			observations.feature.value.sha ||
		observations.featureInBase.value.descendant.sha !==
			observations.base.value.sha
	) {
		return { status: "unknown", reason: "evidence_mismatch", evidence };
	}
	if (
		observations.feature.value.sha === observations.base.value.sha &&
		observations.feature.value.sha.toLowerCase() !==
			createdFromSha?.toLowerCase()
	) {
		return { status: "unknown", reason: "ancestry_unknown", evidence };
	}

	if (!observations.featureInBase.value.isAncestor) {
		return {
			status: "known",
			outcome: "not_integrated_by_ancestry",
			evidence,
		};
	}

	if (!createdFromSha) {
		return { status: "unknown", reason: "creation_point_unknown", evidence };
	}
	if (!FULL_SHA.test(createdFromSha)) {
		return { status: "unknown", reason: "creation_point_invalid", evidence };
	}
	if (
		observations.creationPoint.status === "unknown" ||
		observations.creationPointInFeature.status === "unknown"
	) {
		return {
			status: "unknown",
			reason:
				observations.creationPoint.status === "unknown" &&
				observations.creationPoint.reason === "creation_point_invalid"
					? "creation_point_invalid"
					: "creation_point_unknown",
			detail:
				observations.creationPoint.status === "unknown"
					? observations.creationPoint.message
					: observations.creationPointInFeature.status === "unknown"
						? observations.creationPointInFeature.message
						: undefined,
			evidence,
		};
	}
	if (
		observations.creationPoint.value.sha.toLowerCase() !==
			createdFromSha.toLowerCase() ||
		observations.creationPointInFeature.value.ancestor.sha !==
			observations.creationPoint.value.sha ||
		observations.creationPointInFeature.value.descendant.sha !==
			observations.feature.value.sha
	) {
		return { status: "unknown", reason: "evidence_mismatch", evidence };
	}
	if (!observations.creationPointInFeature.value.isAncestor) {
		return { status: "unknown", reason: "creation_point_invalid", evidence };
	}
	if (
		observations.feature.value.sha.toLowerCase() ===
		observations.creationPoint.value.sha.toLowerCase()
	) {
		return { status: "known", outcome: "no_feature_commits", evidence };
	}

	return { status: "known", outcome: "integrated_by_ancestry", evidence };
}

export class IntegrationEvaluator {
	evaluate(
		observations: FeatureGitObservations,
		createdFromSha?: string,
	): IntegrationEvaluation {
		return evaluateIntegration(observations, createdFromSha);
	}
}
