import { describe, expect, it } from "vitest";
import type { FeatureDeliveryObservation } from "../features/featureSnapshot";
import {
	evaluateIntegration,
	type MergedHeadGitEvidence,
} from "../features/integrationEvaluator";
import type { FeatureGitObservations } from "../git/featureGitObservations";
import { known, unknown } from "../git/featureGitObservations";
import type { GitHubObservation } from "../github/githubObservation";
import {
	type PullRequestObservation,
	resolvePullRequest,
} from "../github/pullRequest";

const CREATED = "1".repeat(40);
const FEATURE = "2".repeat(40);
const BASE = "3".repeat(40);
const PR_HEAD = "4".repeat(40);

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

function pull(
	overrides: Partial<PullRequestObservation> & {
		state: "open" | "closed" | "merged";
	},
): PullRequestObservation {
	return {
		number: 1,
		url: "https://github.com/shiidotech/agent-space/pull/1",
		draft: false,
		headRef: "feat/x",
		headSha: PR_HEAD,
		baseRef: "main",
		...overrides,
	};
}

function githubKnown(
	pulls: readonly PullRequestObservation[],
): GitHubObservation {
	const resolution = resolvePullRequest(pulls, PR_HEAD, "main");
	return {
		provider: "github",
		status: "known",
		pulls,
		resolution,
		repository: {
			status: "known",
			identity: {
				owner: "shiidotech",
				repo: "agent-space",
				remoteName: "origin",
				remoteUrl: "https://github.com/shiidotech/agent-space.git",
				urlKind: "https",
			},
		},
		queriedHeadSha: PR_HEAD,
		expectedBaseRef: "main",
		observedAt: "2026-08-10T00:00:00.000Z",
	};
}

function mergedHeadProof(ancestor = true): MergedHeadGitEvidence {
	const feature = { ref: "refs/heads/feat/x", sha: FEATURE };
	return {
		mergedHeadSha: PR_HEAD,
		relation: known({
			ancestor: { ref: PR_HEAD, sha: PR_HEAD },
			descendant: feature,
			isAncestor: ancestor,
		}),
		commitsAfter: known({
			ancestorSha: PR_HEAD,
			descendantSha: FEATURE,
			count: 2,
		}),
	};
}

function delivery(
	overrides: Partial<FeatureDeliveryObservation> = {},
): FeatureDeliveryObservation {
	const head = { ref: "feat/audit_and_go", sha: PR_HEAD };
	const active = { ref: "feat/feature_cockpit", sha: FEATURE };
	return {
		branchRef: head.ref,
		head: known(head),
		activeRelation: known({
			ancestor: head,
			descendant: active,
			isAncestor: true,
		}),
		commitsAfter: known({
			ancestorSha: PR_HEAD,
			descendantSha: FEATURE,
			count: 1,
		}),
		...overrides,
	};
}

describe("IntegrationEvaluator", () => {
	describe("local ancestry path", () => {
		it("keeps a branch that is not in base unknown until GitHub says otherwise", () => {
			const result = evaluateIntegration({ git: observations(false) });
			expect(result.status).toBe("unknown");
			if (result.status === "known") return;
			expect(result.reason).toBe("integration_unknown");
			expect(result.evidence.github).toEqual({
				status: "unavailable",
				reason: "not_observed",
			});
		});

		it("requires valid creation evidence before ancestry can mean integrated", () => {
			expect(evaluateIntegration({ git: observations(true) })).toMatchObject({
				status: "unknown",
				reason: "creation_point_unknown",
			});
			expect(
				evaluateIntegration({
					git: observations(true),
					createdFromSha: "not-a-sha",
				}),
			).toMatchObject({
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
			expect(
				evaluateIntegration({ git: noCommits, createdFromSha: CREATED }),
			).toMatchObject({
				status: "known",
				outcome: "no_feature_commits",
			});
			expect(
				evaluateIntegration({
					git: observations(true),
					createdFromSha: CREATED,
				}),
			).toMatchObject({
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
			expect(
				evaluateIntegration({ git: input, createdFromSha: CREATED }),
			).toMatchObject({
				status: "unknown",
				reason: "creation_point_invalid",
			});
		});

		it("rejects ancestry evidence whose endpoints do not match observed commits", () => {
			const mismatchedAncestry = {
				...observations(true),
				featureInBase: known({
					ancestor: { ref: "stale", sha: "5".repeat(40) },
					descendant: { ref: "refs/heads/main", sha: BASE },
					isAncestor: true,
				}),
			};
			expect(
				evaluateIntegration({
					git: mismatchedAncestry,
					createdFromSha: CREATED,
				}),
			).toMatchObject({
				status: "unknown",
				reason: "evidence_mismatch",
			});

			const mismatchedCreation = {
				...observations(true),
				creationPoint: known({ ref: CREATED, sha: "6".repeat(40) }),
			};
			expect(
				evaluateIntegration({
					git: mismatchedCreation,
					createdFromSha: CREATED,
				}),
			).toMatchObject({
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
			expect(
				evaluateIntegration({ git: input, createdFromSha: CREATED }),
			).toEqual({
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

	describe("GitHub pull-request path", () => {
		it("never claims not-in-base is not integrated when GitHub is unreadable", () => {
			const github: GitHubObservation = {
				provider: "github",
				status: "unavailable",
				reason: "authentication_missing",
				repository: {
					status: "unavailable",
					reason: "no_remotes",
					observedRemotes: [],
				},
				detail: "No GitHub credentials are usable by the extension host.",
				observedAt: "2026-08-10T00:00:00.000Z",
			};
			const result = evaluateIntegration({
				git: observations(false),
				github,
			});
			expect(result.status).toBe("unknown");
			if (result.status === "known") return;
			expect(result.reason).toBe("integration_unknown");
			expect(result.evidence.github?.status).toBe("unavailable");
			expect(result.evidence.github?.reason).toBe("authentication_missing");
		});

		it("reports not integrated when no pull request exists", () => {
			expect(
				evaluateIntegration({
					git: observations(false),
					github: githubKnown([]),
				}),
			).toMatchObject({
				status: "known",
				outcome: "not_integrated",
			});
		});

		it("reports an open pull request without guessing its future", () => {
			expect(
				evaluateIntegration({
					git: observations(false),
					github: githubKnown([pull({ state: "open" })]),
				}),
			).toMatchObject({
				status: "known",
				outcome: "pull_request_open",
			});
		});

		it("compares an open PR to delivery while retaining continuation evidence", () => {
			const result = evaluateIntegration({
				git: observations(false),
				github: githubKnown([pull({ state: "open" })]),
				delivery: delivery(),
			});

			expect(result).toMatchObject({
				status: "known",
				outcome: "pull_request_open",
				evidence: {
					delivery: {
						branchRef: "feat/audit_and_go",
						head: { sha: PR_HEAD },
						activeRelation: { isAncestor: true },
						commitsAfter: 1,
					},
				},
			});
		});

		it("reports not integrated for a closed unmerged pull request", () => {
			expect(
				evaluateIntegration({
					git: observations(false),
					github: githubKnown([pull({ state: "closed" })]),
				}),
			).toMatchObject({
				status: "known",
				outcome: "not_integrated",
			});
		});

		it("recognizes a merged push whose head equals the local head", () => {
			expect(
				evaluateIntegration({
					git: observations(false),
					github: githubKnown([
						pull({ state: "merged", headSha: FEATURE, number: 1 }),
					]),
				}),
			).toMatchObject({
				status: "known",
				outcome: "integrated_by_pull_request",
			});
		});

		it("reports work after integration when the merged head is an ancestor", () => {
			const result = evaluateIntegration({
				git: observations(false),
				github: githubKnown([pull({ state: "merged", number: 1 })]),
				mergedHead: mergedHeadProof(true),
			});
			expect(result).toMatchObject({
				status: "known",
				outcome: "new_work_after_integration",
			});
		});

		it("uses delivery proof for a merged PR with an active continuation", () => {
			expect(
				evaluateIntegration({
					git: observations(false),
					github: githubKnown([pull({ state: "merged" })]),
					delivery: delivery(),
				}),
			).toMatchObject({
				status: "known",
				outcome: "new_work_after_integration",
				evidence: {
					github: { commitsAfterIntegration: 1 },
				},
			});
		});

		it("fails closed when the active relation to merged delivery is unknown", () => {
			expect(
				evaluateIntegration({
					git: observations(false),
					github: githubKnown([pull({ state: "merged" })]),
					delivery: delivery({
						activeRelation: unknown("ancestry_unknown", "graph unavailable"),
						commitsAfter: unknown("git_command_failed"),
					}),
				}),
			).toMatchObject({
				status: "unknown",
				reason: "integration_unknown",
				detail: "graph unavailable",
			});
		});

		it("keeps integration unknown when the merged head cannot be tied locally", () => {
			const result = evaluateIntegration({
				git: observations(false),
				github: githubKnown([pull({ state: "merged", number: 1 })]),
			});
			expect(result.status).toBe("unknown");
			if (result.status === "known") return;
			expect(result.reason).toBe("integration_unknown");
		});

		it("flags a merge against a different base branch", () => {
			expect(
				evaluateIntegration({
					git: observations(false),
					github: githubKnown([
						pull({ state: "merged", baseRef: "release", number: 1 }),
					]),
				}),
			).toMatchObject({
				status: "known",
				outcome: "integrated_to_other_base",
			});
		});
	});
});
