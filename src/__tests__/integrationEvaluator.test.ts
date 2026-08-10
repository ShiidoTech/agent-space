import { describe, expect, it } from "vitest";
import { evaluateIntegration } from "../features/integrationEvaluator";
import {
	type FeatureGitObservations,
	known,
	unknown,
} from "../git/featureGitObservations";

const CREATED = "1".repeat(40);
const FEATURE = "2".repeat(40);
const BASE = "3".repeat(40);

function observations(isAncestor: boolean): FeatureGitObservations {
	const feature = { ref: "refs/heads/feat/x", sha: FEATURE };
	const base = { ref: "refs/heads/main", sha: BASE };
	return {
		repository: known({ root: "/repo" }),
		worktree: known({ path: "/repo/.worktrees/x", present: true }),
		branch: known({
			expected: "feat/x",
			actual: "feat/x",
			detached: false,
			matchesExpected: true,
		}),
		head: known(feature),
		feature: known(feature),
		base: known(base),
		creationPoint: known({ ref: CREATED, sha: CREATED }),
		creationPointInFeature: known({
			ancestor: { ref: CREATED, sha: CREATED },
			descendant: feature,
			isAncestor: true,
		}),
		upstream: known({ branchRef: feature.ref, upstream: null }),
		upstreamDivergence: known(null),
		featureDelta: known({
			left: base,
			right: feature,
			leftOnly: 0,
			rightOnly: 1,
		}),
		featureDiff: known({
			base,
			feature,
			files: [],
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			raw: "",
		}),
		workingTree: known({
			staged: [],
			unstaged: [],
			untracked: [],
			conflicted: [],
		}),
		worktrees: known([]),
		featureInBase: known({ ancestor: feature, descendant: base, isAncestor }),
	};
}

describe("IntegrationEvaluator", () => {
	it("reports local non-integration without requiring creation evidence", () => {
		const result = evaluateIntegration(observations(false));
		expect(result).toMatchObject({
			status: "known",
			outcome: "not_integrated_by_ancestry",
			evidence: {
				feature: { ref: "refs/heads/feat/x", sha: FEATURE },
				base: { ref: "refs/heads/main", sha: BASE },
				creationPoint: { ref: CREATED, sha: CREATED },
			},
		});
	});

	it("requires valid creation evidence before ancestry can mean integrated", () => {
		expect(evaluateIntegration(observations(true))).toMatchObject({
			status: "unknown",
			reason: "creation_point_unknown",
		});
		expect(evaluateIntegration(observations(true), "not-a-sha")).toMatchObject({
			status: "unknown",
			reason: "creation_point_invalid",
		});
	});

	it("distinguishes no feature commits from integrated feature commits", () => {
		const noCommits = {
			...observations(true),
			feature: known({ ref: "refs/heads/feat/x", sha: CREATED }),
			creationPointInFeature: known({
				ancestor: { ref: CREATED, sha: CREATED },
				descendant: { ref: "refs/heads/feat/x", sha: CREATED },
				isAncestor: true,
			}),
			featureInBase: known({
				ancestor: { ref: "refs/heads/feat/x", sha: CREATED },
				descendant: { ref: "refs/heads/main", sha: BASE },
				isAncestor: true,
			}),
		};
		expect(evaluateIntegration(noCommits, CREATED)).toMatchObject({
			status: "known",
			outcome: "no_feature_commits",
		});
		expect(evaluateIntegration(observations(true), CREATED)).toMatchObject({
			status: "known",
			outcome: "integrated_by_ancestry",
		});
	});

	it("never reports integration when the creation point is not on the feature", () => {
		const input = {
			...observations(true),
			creationPointInFeature: known({
				ancestor: { ref: CREATED, sha: CREATED },
				descendant: { ref: "refs/heads/feat/x", sha: FEATURE },
				isAncestor: false,
			}),
		};
		expect(evaluateIntegration(input, CREATED)).toMatchObject({
			status: "unknown",
			reason: "creation_point_invalid",
		});
	});

	it("rejects ancestry evidence whose endpoints do not match observed commits", () => {
		const mismatchedAncestry = {
			...observations(true),
			featureInBase: known({
				ancestor: { ref: "stale", sha: "4".repeat(40) },
				descendant: { ref: "refs/heads/main", sha: BASE },
				isAncestor: true,
			}),
		};
		expect(evaluateIntegration(mismatchedAncestry, CREATED)).toMatchObject({
			status: "unknown",
			reason: "evidence_mismatch",
		});

		const mismatchedCreation = {
			...observations(true),
			creationPoint: known({ ref: CREATED, sha: "5".repeat(40) }),
		};
		expect(evaluateIntegration(mismatchedCreation, CREATED)).toMatchObject({
			status: "unknown",
			reason: "evidence_mismatch",
		});
	});

	it("preserves partial ancestry evidence when the proof is unknown", () => {
		const input = {
			...observations(true),
			featureInBase: unknown("ancestry_unknown", "git failed", {
				feature: { ref: "refs/heads/feat/x", sha: FEATURE },
			}),
		};
		expect(evaluateIntegration(input, CREATED)).toEqual({
			status: "unknown",
			reason: "ancestry_unknown",
			detail: "git failed",
			evidence: {
				createdFromSha: CREATED,
				feature: { ref: "refs/heads/feat/x", sha: FEATURE },
				base: { ref: "refs/heads/main", sha: BASE },
				creationPoint: { ref: CREATED, sha: CREATED },
				observed: {
					ancestry: {
						feature: { ref: "refs/heads/feat/x", sha: FEATURE },
					},
				},
			},
		});
	});
});
