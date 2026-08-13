import { describe, expect, it } from "vitest";
import {
	type FeatureCockpitPrimaryAction,
	presentFeatureCockpit,
} from "../features/featureCockpitPresentation";
import type { FeatureSnapshot } from "../features/featureSnapshot";
import { known, unknown } from "../git/featureGitObservations";
import type { PullRequestObservation } from "../github/pullRequest";
import { resolvePullRequest } from "../github/pullRequest";
import type { ProjectReferenceBranchHealth } from "../projects/referenceBranchHealth";

const SHA = {
	created: "1".repeat(40),
	feature: "2".repeat(40),
	base: "3".repeat(40),
};

function pull(
	state: PullRequestObservation["state"],
	overrides: Partial<PullRequestObservation> = {},
): PullRequestObservation {
	return {
		number: 74,
		url: "https://github.com/ShiidoTech/agent-space/pull/74",
		state,
		draft: false,
		headRef: "feat/x",
		headSha: SHA.feature,
		baseRef: "main",
		...overrides,
	};
}

function snapshot(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
	const feature = { ref: "feat/x", sha: SHA.feature };
	const base = { ref: "main", sha: SHA.base };
	const githubPulls: PullRequestObservation[] = [];
	return {
		projectId: "p1",
		feature: {
			id: "f1",
			name: "Feature",
			branch: "feat/x",
			worktreePath: "/repo/.worktrees/x",
			status: "active",
			color: "blue",
			isolation: "shared",
			createdAt: "2026-08-12T00:00:00.000Z",
			createdFromSha: SHA.created,
		},
		source: { status: "known" },
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
			creationPoint: known({ ref: SHA.created, sha: SHA.created }),
			creationPointInFeature: known({
				ancestor: { ref: SHA.created, sha: SHA.created },
				descendant: feature,
				isAncestor: true,
			}),
			upstream: known({ branchRef: "feat/x", upstream: null }),
			upstreamDivergence: known(null),
			featureDelta: known({
				left: base,
				right: feature,
				leftOnly: 0,
				rightOnly: 2,
			}),
			featureDiff: known({
				base,
				feature,
				files: [
					{ path: "src/a.ts", insertions: 12, deletions: 0 },
					{ path: "src/b.ts", insertions: 8, deletions: 4 },
					{ path: "src/c.ts", insertions: 0, deletions: 0 },
				],
				filesChanged: 3,
				insertions: 20,
				deletions: 4,
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
		github: {
			provider: "github",
			status: "known",
			pulls: githubPulls,
			resolution: resolvePullRequest(githubPulls, SHA.feature, "main"),
			repository: {
				status: "known",
				identity: {
					owner: "ShiidoTech",
					repo: "agent-space",
					remoteName: "origin",
					remoteUrl: "https://github.com/ShiidoTech/agent-space.git",
					urlKind: "https",
				},
			},
			queriedHeadSha: SHA.feature,
			expectedBaseRef: "main",
			observedAt: "2026-08-12T09:00:00.000Z",
		},
		integration: {
			status: "known",
			outcome: "not_integrated",
			evidence: { feature, base },
		},
		runtime: {
			agents: { status: "known", value: [] },
			services: { status: "known", value: [] },
		},
		attention: [],
		observedAt: "2026-08-12T09:01:00.000Z",
		...overrides,
	};
}

function withPull(
	input: FeatureSnapshot,
	selectedPull: PullRequestObservation,
): FeatureSnapshot {
	return {
		...input,
		github: {
			...input.github,
			status: "known",
			pulls: [selectedPull],
			resolution: resolvePullRequest([selectedPull], SHA.feature, "main"),
		} as FeatureSnapshot["github"],
	};
}

function referenceHealth(
	state: ProjectReferenceBranchHealth["state"] = "current",
	freshness: ProjectReferenceBranchHealth["remoteFreshness"]["status"] = "fresh",
): ProjectReferenceBranchHealth {
	return {
		state,
		verifiedRemoteRelation:
			state === "current"
				? { state: "current", localOnly: 0, comparedOnly: 0 }
				: state === "ahead" || state === "behind" || state === "diverged"
					? { state, localOnly: 1, comparedOnly: 1 }
					: { state, reason: "comparison_failed" },
		remoteFreshness: {
			status: freshness,
			observedAt: "2026-08-12T09:00:00.000Z",
			staleAfterMs: 300_000,
		},
	} as ProjectReferenceBranchHealth;
}

describe("presentFeatureCockpit", () => {
	it("keeps working-tree categories separate from committed work", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			git: {
				...base.git,
				workingTree: known({
					staged: ["staged.ts"],
					unstaged: ["unstaged.ts"],
					untracked: ["new.ts"],
					conflicted: ["conflict.ts"],
				}),
			},
		});

		expect(result.work.workingTree).toMatchObject({
			status: "known",
			pending: 4,
			staged: ["staged.ts"],
			unstaged: ["unstaged.ts"],
			untracked: ["new.ts"],
			conflicted: ["conflict.ts"],
			tone: "error",
		});
		expect(result.work.committed).toMatchObject({
			featureCommits: 2,
			filesChanged: 3,
			files: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
			insertions: 20,
			deletions: 4,
		});
	});

	it("never turns unknown work evidence into clean or zero", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			git: {
				...base.git,
				workingTree: unknown("git_command_failed"),
				featureDelta: unknown("git_command_failed"),
			},
		});

		expect(result.work.workingTree).toEqual({
			status: "unknown",
			label: "Unknown",
		});
		expect(result.work.committed).toEqual({
			status: "unknown",
			label: "Unknown",
		});
	});

	it("orients Feature and base-only commits and does not claim not pushed", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			git: {
				...base.git,
				featureDelta: known({
					left: { ref: "main", sha: SHA.base },
					right: { ref: "feat/x", sha: SHA.feature },
					leftOnly: 3,
					rightOnly: 5,
				}),
			},
		});

		expect(result.work.committed).toMatchObject({
			featureCommits: 5,
			baseCommits: 3,
		});
		expect(result.delivery.tracking.label).toBe(
			"Push state unknown · tracking branch not configured",
		);
	});

	it.each([
		["open", false, "PR #74 open main"],
		["open", true, "PR #74 draft main"],
		["merged", false, "PR #74 merged into main"],
		["closed", false, "PR #74 closed without merge · target main"],
	] as const)("presents %s PR evidence", (state, draft, expected) => {
		const result = presentFeatureCockpit(
			withPull(snapshot(), pull(state, { draft })),
		);
		expect(result.delivery.pullRequest.label).toBe(expected);
	});

	it("shows an up-to-date delivery PR separately from continuation work", () => {
		const base = snapshot();
		const deliverySha = "4".repeat(40);
		const activeSha = SHA.feature;
		const deliveryHead = { ref: "feat/audit_and_go", sha: deliverySha };
		const activeHead = { ref: "feat/feature_cockpit", sha: activeSha };
		const selectedPull = pull("open", {
			headRef: "feat/audit_and_go",
			headSha: deliverySha,
		});
		const withDeliveryPull = withPull(
			{
				...base,
				feature: {
					...base.feature,
					branch: "feat/feature_cockpit",
					primaryBranchRef: "feat/audit_and_go",
				},
				delivery: {
					branchRef: "feat/audit_and_go",
					head: known(deliveryHead),
					activeRelation: known({
						ancestor: deliveryHead,
						descendant: activeHead,
						isAncestor: true,
					}),
					commitsAfter: known({
						ancestorSha: deliverySha,
						descendantSha: activeSha,
						count: 1,
					}),
				},
			},
			selectedPull,
		);
		const current: FeatureSnapshot = {
			...withDeliveryPull,
			github: {
				...withDeliveryPull.github,
				status: "known",
				pulls: [selectedPull],
				resolution: resolvePullRequest([selectedPull], deliverySha, "main"),
				queriedHeadSha: deliverySha,
			} as FeatureSnapshot["github"],
		};
		const result = presentFeatureCockpit(current);

		expect(result.delivery.pullRequest.label).toBe("PR #74 open main");
		expect(result.delivery.source).toEqual({
			label: `feat/audit_and_go @${deliverySha.slice(0, 12)}`,
			tone: "warning",
			detail: "feat/feature_cockpit: 1 commit beyond delivery",
		});
	});

	it("presents an explicitly modeled deliveredVia source with neutral tone", () => {
		const base = snapshot();
		const deliverySha = "5".repeat(40);
		const viaSha = "6".repeat(40);
		const via = {
			ref: "dev/improvements",
			sha: viaSha,
		};
		const result = presentFeatureCockpit({
			...base,
			feature: {
				...base.feature,
				branch: "dev/improvements",
				primaryBranchRef: "fix/1203",
			},
			delivery: {
				branchRef: "fix/1203",
				head: known({ ref: "fix/1203", sha: deliverySha }),
				activeRelation: known({
					ancestor: { ref: "fix/1203", sha: deliverySha },
					descendant: via,
					isAncestor: true,
				}),
				commitsAfter: known({
					ancestorSha: deliverySha,
					descendantSha: viaSha,
					count: 18,
				}),
				deliveredVia: {
					branchRef: "dev/improvements",
					head: via,
					pullNumber: 1203,
				},
			},
		});

		expect(result.delivery.source).toEqual({
			label: `fix/1203 @${deliverySha.slice(0, 12)}`,
			tone: "normal",
			detail: `Delivered via dev/improvements @${viaSha.slice(0, 12)} · PR #1203 · 18 commits on dev/improvements beyond fix/1203`,
		});
	});

	it("keeps an unknown continuation relation unknown", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			delivery: {
				branchRef: "feat/audit_and_go",
				head: known({ ref: "feat/audit_and_go", sha: "4".repeat(40) }),
				activeRelation: unknown("ancestry_unknown"),
				commitsAfter: unknown("git_command_failed"),
			},
		});

		expect(result.delivery.source).toMatchObject({
			tone: "warning",
			detail: "Active branch relation unknown",
		});
		expect(result.primaryAction.kind).toBe("refresh_evidence");
	});

	it("does not turn unavailable GitHub evidence into no PR", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			github: {
				provider: "github",
				status: "unavailable",
				reason: "authentication_missing",
				repository: base.github.repository,
				observedAt: base.observedAt,
			},
		});
		expect(result.delivery.pullRequest.label).toBe("PR state unavailable");
	});

	it("shows post-integration work even though it is informational evidence", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			integration: {
				status: "known",
				outcome: "new_work_after_integration",
				evidence: {
					github: { status: "known", commitsAfterIntegration: 2 },
				},
			},
			attention: [
				{
					code: "new_work_after_integration",
					severity: "info",
					summary: "New work after integration",
					detail: "Two commits were created later.",
					evidence: {},
				},
			],
		});
		expect(result.alerts[0]?.code).toBe("new_work_after_integration");
		expect(result.delivery.integration.label).toBe(
			"Integrated, then 2 new commits",
		);
	});

	it("summarizes runtime without presenting done-count as progress", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			runtime: {
				agents: {
					status: "known",
					value: [
						{
							agent: {
								id: "a1",
								featureId: "f1",
								name: "Worker",
								sessionId: null,
								status: "running",
								attentionStatus: "working",
								createdAt: base.observedAt,
							},
							tmuxAlive: known(true),
						},
						{
							agent: {
								id: "a2",
								featureId: "f1",
								name: "Reviewer",
								sessionId: null,
								status: "running",
								attentionStatus: "waiting_for_user",
								createdAt: base.observedAt,
							},
							tmuxAlive: known(true),
						},
					],
				},
				services: {
					status: "known",
					value: [
						{
							service: {
								id: "s1",
								featureId: "f1",
								name: "dev",
								command: "npm run dev",
								tmuxSession: "svc",
								status: "running",
								createdAt: base.observedAt,
							},
							tmuxAlive: known(true),
						},
					],
				},
			},
		});
		expect(result.runtime.label).toBe(
			"2 agents running · 1 needs you · 1 service running",
		);
	});

	it("keeps a running unsupported provider visible without inventing activity", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			runtime: {
				agents: {
					status: "known",
					value: [
						{
							agent: {
								id: "a1",
								featureId: "f1",
								name: "Generic",
								sessionId: null,
								status: "running",
								attentionStatus: "unsupported",
								createdAt: base.observedAt,
							},
							tmuxAlive: known(true),
						},
					],
				},
				services: { status: "known", value: [] },
			},
		});

		expect(result.runtime.label).toBe(
			"1 agent running · 0 need you · 0 services running · 1 without activity signal",
		);
		expect(result.runtime.tone).toBe("warning");
	});

	it.each<
		[
			string,
			(input: FeatureSnapshot) => FeatureSnapshot,
			FeatureCockpitPrimaryAction["kind"],
		]
	>([
		[
			"unknown evidence",
			(input) => ({
				...input,
				attention: [
					{
						code: "git_observation_unknown",
						severity: "error",
						summary: "Git unavailable",
						detail: "offline",
						evidence: {},
					},
				],
			}),
			"refresh_evidence",
		],
		[
			"working tree",
			(input) => ({
				...input,
				attention: [
					{
						code: "working_tree_changes",
						severity: "warning",
						summary: "Pending",
						detail: "pending",
						evidence: {},
					},
				],
			}),
			"open_workspace",
		],
		["no PR with commits", (input) => input, "create_pull_request"],
	])("selects the primary action for %s", (_name, arrange, expected) => {
		expect(presentFeatureCockpit(arrange(snapshot())).primaryAction.kind).toBe(
			expected,
		);
	});

	it("offers review finish only on proven integration and a clean known tree", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			integration: {
				status: "known",
				outcome: "integrated_by_pull_request",
				evidence: {},
			},
		});
		expect(result.primaryAction.kind).toBe("review_finish");
	});

	it("requires a fresh current remote base before finishing ancestry-only integration", () => {
		const base = snapshot({
			integration: {
				status: "known",
				outcome: "integrated_by_ancestry",
				evidence: {},
			},
		});

		expect(presentFeatureCockpit(base).primaryAction.kind).toBe(
			"open_workspace",
		);
		expect(
			presentFeatureCockpit(base, referenceHealth("ahead")).primaryAction.kind,
		).toBe("open_workspace");
		expect(
			presentFeatureCockpit(base, referenceHealth("current", "stale"))
				.primaryAction.kind,
		).toBe("open_workspace");
		expect(
			presentFeatureCockpit(base, referenceHealth()).primaryAction.kind,
		).toBe("review_finish");
	});

	it("shares one Ready to finish summary for a merged PR present in the local base", () => {
		const selectedPull = pull("merged");
		const base = withPull(
			snapshot({
				integration: {
					status: "known",
					outcome: "integrated_by_ancestry",
					evidence: {},
				},
			}),
			selectedPull,
		);

		expect(presentFeatureCockpit(base, referenceHealth()).summary).toEqual({
			label: "Ready to finish",
			tone: "normal",
			detail: "PR #74 merged · present in main",
		});
	});

	it("keeps a local-only integration explicit when remote completion is not proven", () => {
		const result = presentFeatureCockpit(
			snapshot({
				integration: {
					status: "known",
					outcome: "integrated_by_ancestry",
					evidence: {},
				},
			}),
		);

		expect(result.summary).toEqual({
			label: "Integrated locally",
			tone: "normal",
			detail: "The Feature revision is present in the local target branch.",
		});
	});

	it("uses Needs you as the shared summary when an intervention is required", () => {
		const result = presentFeatureCockpit({
			...snapshot(),
			attention: [
				{
					code: "working_tree_changes",
					severity: "warning",
					summary: "Pending changes",
					detail: "Two files are not committed.",
					evidence: {},
				},
			],
		});

		expect(result.summary).toEqual({
			label: "Needs you",
			tone: "warning",
			detail: "Pending changes — Two files are not committed.",
		});
	});

	it("refreshes essential unknown working-tree evidence before proposing delivery", () => {
		const base = snapshot();
		expect(
			presentFeatureCockpit({
				...base,
				git: { ...base.git, workingTree: unknown("git_command_failed") },
			}).primaryAction.kind,
		).toBe("refresh_evidence");
	});

	it.each([
		[
			"HEAD unavailable",
			(base: FeatureSnapshot) => ({
				...base.git,
				head: unknown("head_unknown"),
			}),
		],
		[
			"HEAD differs from Feature ref",
			(base: FeatureSnapshot) => ({
				...base.git,
				head: known({ ref: "HEAD", sha: "9".repeat(40) }),
			}),
		],
		[
			"upstream divergence unavailable",
			(base: FeatureSnapshot) => ({
				...base.git,
				upstream: known({
					branchRef: "feat/x",
					upstream: { ref: "origin/feat/x", sha: "4".repeat(40) },
				}),
				upstreamDivergence: unknown("git_command_failed"),
			}),
		],
	])("refreshes before publishing when %s", (_name, alterGit) => {
		const base = snapshot();
		expect(
			presentFeatureCockpit({ ...base, git: alterGit(base) }).primaryAction
				.kind,
		).toBe("refresh_evidence");
	});

	it("marks upstream lag as actionable and does not promote Create PR", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			git: {
				...base.git,
				upstream: known({
					branchRef: "feat/x",
					upstream: { ref: "origin/feat/x", sha: "4".repeat(40) },
				}),
				upstreamDivergence: known({
					left: { ref: "origin/feat/x", sha: "4".repeat(40) },
					right: { ref: "feat/x", sha: SHA.feature },
					leftOnly: 3,
					rightOnly: 0,
				}),
			},
		});

		expect(result.delivery.tracking.tone).toBe("warning");
		expect(result.primaryAction.kind).toBe("open_workspace");
	});

	it("opens the agent before a simultaneous workspace problem", () => {
		const base = snapshot();
		const result = presentFeatureCockpit({
			...base,
			attention: [
				{
					code: "agent_waiting_for_user",
					severity: "warning",
					summary: "Agent needs you",
					detail: "input required",
					evidence: { agentId: "a1" },
				},
				{
					code: "working_tree_changes",
					severity: "warning",
					summary: "Pending",
					detail: "pending",
					evidence: {},
				},
			],
		});

		expect(result.primaryAction).toMatchObject({
			kind: "open_agent",
			agentId: "a1",
		});
	});

	it("opens an observed open PR when no higher-priority intervention exists", () => {
		const result = presentFeatureCockpit(withPull(snapshot(), pull("open")));
		expect(result.primaryAction).toMatchObject({
			kind: "open_pull_request",
			number: 74,
		});
	});
});
