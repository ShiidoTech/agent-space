import { describe, expect, it } from "vitest";
import {
	type FeatureSnapshot,
	featureSnapshotGitStatus,
} from "../features/featureSnapshot";
import { known } from "../git/featureGitObservations";
import type { GitHubObservation } from "../github/githubObservation";

const CREATED = "1".repeat(40);
const FEATURE = "2".repeat(40);
const BASE = "3".repeat(40);

const github: GitHubObservation = {
	provider: "github",
	status: "unavailable",
	reason: "repository_unknown",
	repository: {
		status: "unavailable",
		reason: "no_remotes",
		observedRemotes: [],
	},
	observedAt: "2026-08-10T00:00:00.000Z",
};

function snapshot(
	mutate?: (value: FeatureSnapshot) => FeatureSnapshot,
): FeatureSnapshot {
	const feature = { ref: "feat/x", sha: FEATURE };
	const base = { ref: "main", sha: BASE };
	const value: FeatureSnapshot = {
		projectId: "p1",
		source: { status: "known" },
		feature: {
			id: "f1",
			name: "Feature",
			branch: "feat/x",
			worktreePath: "/repo/.worktrees/x",
			status: "active",
			color: "blue",
			isolation: "shared",
			createdAt: "2026-08-10T00:00:00.000Z",
			createdFromSha: CREATED,
		},
		git: {
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
			upstream: known({ branchRef: "feat/x", upstream: null }),
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
			featureInBase: known({
				ancestor: feature,
				descendant: base,
				isAncestor: false,
			}),
		},
		integration: {
			status: "known",
			outcome: "not_integrated",
			evidence: { feature, base },
		},
		github,
		runtime: {
			agents: { status: "known", value: [] },
			services: { status: "known", value: [] },
		},
		attention: [],
		observedAt: "2026-08-10T00:00:00.000Z",
	};
	return mutate?.(value) ?? value;
}

describe("featureSnapshotGitStatus", () => {
	it("distinguishes local integration from a proven pull-request merge", () => {
		expect(
			featureSnapshotGitStatus(
				snapshot((value) => ({
					...value,
					integration: {
						status: "known",
						outcome: "no_feature_commits",
						evidence: {},
					},
				})),
			),
		).toBe("new");
		expect(featureSnapshotGitStatus(snapshot())).toBe("ahead");
		expect(
			featureSnapshotGitStatus(
				snapshot((value) => ({
					...value,
					integration: {
						status: "known",
						outcome: "integrated_by_ancestry",
						evidence: {},
					},
				})),
			),
		).toBe("integrated");
		expect(
			featureSnapshotGitStatus(
				snapshot((value) => ({
					...value,
					integration: {
						status: "known",
						outcome: "integrated_by_pull_request",
						evidence: {},
					},
				})),
			),
		).toBe("merged");
	});

	it.each([
		"staged",
		"unstaged",
		"untracked",
		"conflicted",
	] as const)("keeps %s working-tree evidence distinct and visible", (kind) => {
		const value = snapshot((current) => ({
			...current,
			git: {
				...current.git,
				workingTree: known({
					staged: kind === "staged" ? ["file"] : [],
					unstaged: kind === "unstaged" ? ["file"] : [],
					untracked: kind === "untracked" ? ["file"] : [],
					conflicted: kind === "conflicted" ? ["file"] : [],
				}),
			},
		}));
		expect(featureSnapshotGitStatus(value)).toBe("modified");
	});

	it.each([
		"missing",
		"mismatch",
		"detached",
		"head_mismatch",
	] as const)("keeps %s identity evidence unknown instead of reporting merged", (kind) => {
		const value = snapshot((current) => ({
			...current,
			git: {
				...current.git,
				worktree:
					kind === "missing"
						? known({ path: current.feature.worktreePath, present: false })
						: current.git.worktree,
				branch:
					kind === "mismatch" || kind === "detached"
						? known({
								expected: current.feature.branch,
								actual: kind === "detached" ? null : "other",
								detached: kind === "detached",
								matchesExpected: false,
							})
						: current.git.branch,
				head:
					kind === "head_mismatch"
						? known({ ref: "HEAD", sha: "9".repeat(40) })
						: current.git.head,
			},
			integration: {
				status: "known",
				outcome: "integrated_by_ancestry",
				evidence: {},
			},
		}));
		expect(featureSnapshotGitStatus(value)).toBe("unknown");
	});

	it("keeps an unprovable integration unknown", () => {
		const value = snapshot((current) => ({
			...current,
			integration: {
				status: "unknown",
				reason: "creation_point_unknown",
				evidence: {},
			},
		}));
		expect(featureSnapshotGitStatus(value)).toBe("unknown");
	});
});
