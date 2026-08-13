import { describe, expect, it } from "vitest";
import { evaluateAttention } from "../features/attentionEvaluator";
import type { IntegrationEvaluation } from "../features/integrationEvaluator";
import {
	knownRuntime,
	observeFeatureRuntime,
	unknownRuntime,
} from "../features/runtimeObservation";
import type { FeatureGitObservations } from "../git/featureGitObservations";
import { known } from "../git/featureGitObservations";
import type { Agent, Service } from "../types";

const feature = { ref: "feat/x", sha: "2".repeat(40) };
const base = { ref: "main", sha: "3".repeat(40) };

function git(): FeatureGitObservations {
	return {
		repository: known({ root: "/repo" }),
		worktree: known({ path: "/worktree", present: true }),
		branch: known({
			expected: "feat/x",
			actual: "feat/x",
			detached: false,
			matchesExpected: true,
		}),
		head: known(feature),
		feature: known(feature),
		base: known(base),
		creationPoint: known({ ref: "1".repeat(40), sha: "1".repeat(40) }),
		creationPointInFeature: known({
			ancestor: { ref: "1".repeat(40), sha: "1".repeat(40) },
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
	};
}

const integration: IntegrationEvaluation = {
	status: "known",
	outcome: "not_integrated",
	evidence: { feature, base },
};

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: null,
		status: "running",
		createdAt: "2026-08-10T00:00:00.000Z",
		...overrides,
	};
}

function service(overrides: Partial<Service> = {}): Service {
	return {
		id: "s1",
		featureId: "f1",
		name: "API",
		command: "npm start",
		tmuxSession: "service-s1",
		status: "running",
		createdAt: "2026-08-10T00:00:00.000Z",
		...overrides,
	};
}

describe("AttentionEvaluator", () => {
	it("returns structured Git and runtime problems with stable codes", () => {
		const observedGit = {
			...git(),
			branch: known({
				expected: "feat/x",
				actual: "other",
				detached: false,
				matchesExpected: false,
			}),
			workingTree: known({
				staged: ["a.ts"],
				unstaged: [],
				untracked: [],
				conflicted: ["b.ts"],
			}),
		};
		const runtime = observeFeatureRuntime({
			agents: knownRuntime([agent({ attentionStatus: "waiting_for_user" })]),
			services: knownRuntime([service({ status: "errored" })]),
		});
		const problems = evaluateAttention({
			git: observedGit,
			integration,
			runtime,
		});
		expect(problems.map((entry) => entry.code)).toEqual([
			"branch_mismatch",
			"working_tree_conflicted",
			"working_tree_changes",
			"agent_waiting_for_user",
			"service_failed",
		]);
		expect(
			problems.every(
				(entry) => entry.summary && entry.detail && entry.evidence,
			),
		).toBe(true);
	});

	it("does not turn unknown tmux evidence into a missing-terminal problem", () => {
		const runtime = observeFeatureRuntime({
			agents: knownRuntime([agent()]),
			services: knownRuntime([service()]),
		});
		expect(evaluateAttention({ git: git(), integration, runtime })).toEqual([]);
	});

	it("reports failed runtime reads explicitly", () => {
		const runtime = observeFeatureRuntime({
			agents: unknownRuntime("read_failed", "agent read failed"),
			services: unknownRuntime("read_failed", "service read failed"),
		});
		expect(
			evaluateAttention({ git: git(), integration, runtime }).map(
				(entry) => entry.code,
			),
		).toEqual(["agent_runtime_unknown", "service_runtime_unknown"]);
	});

	it("does not raise continuation_outside_delivery when integration is proven", () => {
		const deliverySha = "5".repeat(40);
		const runtime = observeFeatureRuntime({
			agents: knownRuntime([agent()]),
			services: knownRuntime([service()]),
		});
		const input = {
			git: git(),
			runtime,
			delivery: {
				branchRef: "fix/1203",
				head: known({ ref: "fix/1203", sha: deliverySha }),
				activeRelation: known({
					ancestor: { ref: "fix/1203", sha: deliverySha },
					descendant: feature,
					isAncestor: true,
				}),
				commitsAfter: known({
					ancestorSha: deliverySha,
					descendantSha: feature.sha,
					count: 18,
				}),
			},
		};
		for (const outcome of [
			"integrated_by_ancestry",
			"integrated_by_pull_request",
		] as const) {
			const problems = evaluateAttention({
				...input,
				integration: {
					status: "known" as const,
					outcome,
					evidence: { feature, base },
				},
			});
			expect(problems.map((entry) => entry.code)).not.toContain(
				"continuation_outside_delivery",
			);
		}
	});

	it("raises continuation_outside_delivery when commits are not proven integrated", () => {
		const deliverySha = "5".repeat(40);
		const runtime = observeFeatureRuntime({
			agents: knownRuntime([agent()]),
			services: knownRuntime([service()]),
		});
		const problems = evaluateAttention({
			git: git(),
			runtime,
			integration: {
				status: "known",
				outcome: "not_integrated",
				evidence: { feature, base },
			},
			delivery: {
				branchRef: "fix/1203",
				head: known({ ref: "fix/1203", sha: deliverySha }),
				activeRelation: known({
					ancestor: { ref: "fix/1203", sha: deliverySha },
					descendant: feature,
					isAncestor: true,
				}),
				commitsAfter: known({
					ancestorSha: deliverySha,
					descendantSha: feature.sha,
					count: 18,
				}),
			},
		});
		expect(problems.map((entry) => entry.code)).toContain(
			"continuation_outside_delivery",
		);
	});
});
