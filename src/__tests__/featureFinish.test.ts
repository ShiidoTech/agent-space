import { describe, expect, it, vi } from "vitest";
import {
	assessFeatureFinish,
	planFeatureFinishRemovals,
	verifySessionsStopped,
} from "../features/featureFinish";
import type { IntegrationEvaluation } from "../features/integrationEvaluator";
import * as worktreeSafety from "../git/worktreeSafety";
import type { ProjectContext } from "../projects/projectManager";
import type { Agent, Feature } from "../types";

function gitResult(stdout: string) {
	return {
		argv: [],
		cwd: "/repo",
		exitCode: 0,
		signal: null,
		stdout,
		stderr: "",
	};
}

function feature(): Feature {
	return {
		id: "f1",
		name: "Feature",
		branch: "feat/f1",
		worktreePath: "/worktrees/f1",
		status: "active",
		color: "blue",
		isolation: "per-agent",
		createdAt: "2026-08-12T00:00:00.000Z",
	};
}

function agent(id: string): Agent {
	return {
		id,
		featureId: "f1",
		name: id,
		status: "stopped",
		sessionId: null,
		worktreePath: `/worktrees/${id}`,
		createdAt: "2026-08-12T00:00:00.000Z",
	};
}

const notIntegrated: IntegrationEvaluation = {
	status: "known",
	outcome: "not_integrated",
	evidence: {},
};

function finishEvidence(integration: IntegrationEvaluation = notIntegrated) {
	return { integration };
}

function context(
	worktreeOutput: string,
	agents: readonly Agent[] = [],
): ProjectContext {
	return {
		project: { id: "p1", name: "Project", repoPath: "/repo" },
		gitClient: {
			readSync: (args: readonly string[]) =>
				args[0] === "symbolic-ref"
					? gitResult("feat/f1\n")
					: gitResult(worktreeOutput),
		},
		featureManager: {
			getBaseBranchName: () => "main",
			getWorktreeBase: () => "/worktrees",
		},
		agentManager: {
			getAgents: () => agents,
			getAgentBranchName: (_feature: Feature, id: string) =>
				`feat/f1/agent-${id}`,
		},
	} as unknown as ProjectContext;
}

describe("Feature Finish", () => {
	it("assesses deletion against the positively linked active checkout", () => {
		const continued: Feature = {
			...feature(),
			branch: "feat/feature_cockpit",
			primaryBranchRef: "feat/f1",
			branchLinks: [
				{
					ref: "feat/f1",
					role: "primary",
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "legacy_record",
				},
				{
					ref: "feat/feature_cockpit",
					role: "continuation",
					linkedAt: "2026-08-12T09:35:00.000Z",
					source: "reflog_checkout",
				},
			],
		};
		const deletion = vi
			.spyOn(worktreeSafety, "checkWorktreeDeletionSafety")
			.mockReturnValue({
				worktreePath: "/worktrees/f1",
				safe: true,
				forceable: true,
				insideBase: true,
				statusObserved: true,
				refsObserved: true,
				integrationObserved: true,
				localCommitsObserved: true,
				dirty: false,
				hasLocalCommits: false,
				unmerged: false,
				workingTreeStatus: "",
				localCommitCount: 0,
				featureSha: "1".repeat(40),
				baseSha: "2".repeat(40),
				reasons: [],
			});
		const ctx = context("worktree /repo\n\nworktree /worktrees/f1\n");
		ctx.gitClient.readSync = (args: readonly string[]) =>
			args[0] === "symbolic-ref"
				? gitResult("feat/feature_cockpit\n")
				: gitResult("worktree /repo\n\nworktree /worktrees/f1\n");

		const assessment = assessFeatureFinish(ctx, continued, finishEvidence());

		expect(assessment.checks[0]).toMatchObject({
			kind: "feature",
			branch: "feat/feature_cockpit",
		});
		expect(deletion).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "feat/feature_cockpit" }),
		);
	});

	it("keeps the declared branch when legacy links do not list it", () => {
		const legacyLinks: Feature = {
			...feature(),
			branchLinks: [
				{
					ref: "feat/old-primary",
					role: "primary",
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "legacy_record",
				},
			],
		};
		const deletion = vi
			.spyOn(worktreeSafety, "checkWorktreeDeletionSafety")
			.mockReturnValue({
				worktreePath: "/worktrees/f1",
				safe: true,
				forceable: true,
				insideBase: true,
				statusObserved: true,
				refsObserved: true,
				integrationObserved: true,
				localCommitsObserved: true,
				dirty: false,
				hasLocalCommits: false,
				unmerged: false,
				workingTreeStatus: "",
				localCommitCount: 0,
				featureSha: "1".repeat(40),
				baseSha: "2".repeat(40),
				reasons: [],
			});
		const ctx = context("worktree /repo\n\nworktree /worktrees/f1\n");

		assessFeatureFinish(ctx, legacyLinks, finishEvidence());

		expect(deletion).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "feat/f1" }),
		);
	});

	it("uses an active registered checkout even when persisted links are stale", () => {
		const stale: Feature = {
			...feature(),
			branch: "feat/old-player",
			branchLinks: [
				{
					ref: "feat/old-player",
					role: "primary",
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "legacy_record",
				},
			],
		};
		const deletion = vi
			.spyOn(worktreeSafety, "checkWorktreeDeletionSafety")
			.mockReturnValue({
				worktreePath: "/worktrees/f1",
				safe: true,
				forceable: true,
				insideBase: true,
				statusObserved: true,
				refsObserved: true,
				integrationObserved: true,
				localCommitsObserved: true,
				dirty: false,
				hasLocalCommits: false,
				unmerged: false,
				workingTreeStatus: "",
				localCommitCount: 0,
				featureSha: "1".repeat(40),
				baseSha: "2".repeat(40),
				reasons: [],
			});
		const ctx = context("worktree /repo\n\nworktree /worktrees/f1\n");
		ctx.gitClient.readSync = (args: readonly string[]) =>
			args[0] === "symbolic-ref"
				? gitResult("feat/current-player\n")
				: gitResult("worktree /repo\n\nworktree /worktrees/f1\n");

		const assessment = assessFeatureFinish(ctx, stale, finishEvidence());

		expect(assessment.safe).toBe(true);
		expect(deletion).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "feat/current-player" }),
		);
	});

	it("uses the branch recorded in the Git worktree inventory when symbolic-ref fails", () => {
		const deletion = vi
			.spyOn(worktreeSafety, "checkWorktreeDeletionSafety")
			.mockReturnValue({
				worktreePath: "/worktrees/f1",
				safe: true,
				forceable: true,
				insideBase: true,
				statusObserved: true,
				refsObserved: true,
				integrationObserved: true,
				localCommitsObserved: true,
				dirty: false,
				hasLocalCommits: false,
				unmerged: false,
				workingTreeStatus: "",
				localCommitCount: 0,
				featureSha: "1".repeat(40),
				baseSha: "2".repeat(40),
				reasons: [],
			});
		const ctx = context(
				"worktree /repo\nbranch refs/heads/main\n\nworktree /worktrees/f1\nbranch refs/heads/feat/f1\n",
			);
		ctx.gitClient.readSync = (args: readonly string[]) =>
				args[0] === "symbolic-ref"
					? { ...gitResult(""), exitCode: 1 }
					: gitResult(
							"worktree /repo\nbranch refs/heads/main\n\nworktree /worktrees/f1\nbranch refs/heads/feat/f1\n",
						);

		const assessment = assessFeatureFinish(ctx, feature(), finishEvidence());

		expect(assessment.safe).toBe(true);
		expect(deletion).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "feat/f1" }),
		);
	});

	it("uses the declared branch when symbolic-ref has a non-detached read failure", () => {
		const deletion = vi
			.spyOn(worktreeSafety, "checkWorktreeDeletionSafety")
			.mockReturnValue({
				worktreePath: "/worktrees/f1",
				safe: true,
				forceable: true,
				insideBase: true,
				statusObserved: true,
				refsObserved: true,
				integrationObserved: true,
				localCommitsObserved: true,
				dirty: false,
				hasLocalCommits: false,
				unmerged: false,
				workingTreeStatus: "",
				localCommitCount: 0,
				featureSha: "1".repeat(40),
				baseSha: "2".repeat(40),
				reasons: [],
			});
		const ctx = context("worktree /repo\n\nworktree /worktrees/f1\n");
		ctx.gitClient.readSync = (args: readonly string[]) =>
			args[0] === "symbolic-ref"
				? { ...gitResult(""), exitCode: null, error: new Error("timeout") }
				: gitResult("worktree /repo\n\nworktree /worktrees/f1\n");

		const assessment = assessFeatureFinish(ctx, feature(), finishEvidence());

		expect(assessment.safe).toBe(true);
		expect(deletion).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "feat/f1" }),
		);
	});

	it("resumes after earlier worktrees were removed while records were preserved", () => {
		const agents = [agent("a1"), agent("a2")];
		const readSync = vi.fn(
			(args: readonly string[], options?: { readonly cwd?: string }) => {
				if (args[0] === "worktree") {
					return gitResult("worktree /repo\n\nworktree /worktrees/a2\n");
				}
				return gitResult(
					options?.cwd === "/worktrees/f1" ? "feat/f1\n" : "feat/f1/agent-a2\n",
				);
			},
		);
		vi.spyOn(worktreeSafety, "checkWorktreeDeletionSafety").mockReturnValue({
			worktreePath: "/worktrees/a2",
			safe: true,
			forceable: true,
			insideBase: true,
			statusObserved: true,
			refsObserved: true,
			integrationObserved: true,
			localCommitsObserved: true,
			dirty: false,
			hasLocalCommits: false,
			unmerged: false,
			workingTreeStatus: "",
			localCommitCount: 0,
			featureSha: "1".repeat(40),
			baseSha: "2".repeat(40),
			reasons: [],
		});
		vi.spyOn(worktreeSafety, "checkBranchRetentionSafety").mockReturnValue({
			branch: "feat/f1",
			baseBranch: "main",
			refsObserved: true,
			integrationObserved: true,
			localCommitsObserved: true,
			featureSha: "1".repeat(40),
			baseSha: "2".repeat(40),
			hasLocalCommits: false,
			localCommitCount: 0,
			unmerged: false,
			forceable: true,
			safe: true,
			reasons: [],
		});
		const ctx = {
			project: { id: "p1", name: "Project", repoPath: "/repo" },
			gitClient: { readSync },
			featureManager: {
				getBaseBranchName: () => "main",
				getWorktreeBase: () => "/worktrees",
			},
			agentManager: {
				getAgents: () => agents,
				getAgentBranchName: (_feature: Feature, id: string) =>
					`feat/f1/agent-${id}`,
			},
		} as unknown as ProjectContext;

		const assessment = assessFeatureFinish(
			ctx,
			feature(),
			finishEvidence(),
			(candidate) => candidate === "/worktrees/a2",
		);

		expect(assessment.safe).toBe(true);
		expect(assessment.checks).toMatchObject([
			{ kind: "feature", disposition: "already_removed" },
			{ kind: "agent", agentId: "a1", disposition: "already_removed" },
			{ kind: "agent", agentId: "a2", disposition: "registered" },
		]);
	});

	it("surfaces unique commits on an already absent worktree", () => {
		vi.spyOn(worktreeSafety, "checkBranchRetentionSafety").mockReturnValue({
			branch: "feat/f1",
			baseBranch: "main",
			refsObserved: true,
			integrationObserved: true,
			localCommitsObserved: true,
			featureSha: "1".repeat(40),
			baseSha: "2".repeat(40),
			hasLocalCommits: true,
			localCommitCount: 2,
			unmerged: true,
			forceable: true,
			safe: false,
			reasons: ["Branch feat/f1 has 2 commits not in main."],
		});
		const ctx = {
			project: { id: "p1", name: "Project", repoPath: "/repo" },
			gitClient: { readSync: () => gitResult("worktree /repo\n") },
			featureManager: {
				getBaseBranchName: () => "main",
				getWorktreeBase: () => "/worktrees",
			},
			agentManager: { getAgents: () => [] },
		} as unknown as ProjectContext;

		const assessment = assessFeatureFinish(
			ctx,
			feature(),
			finishEvidence(),
			() => false,
		);

		expect(assessment.safe).toBe(false);
		expect(assessment.forceable).toBe(true);
		expect(assessment.reasons.join("\n")).toContain("2 commits");
	});

	it("blocks an absent worktree when its branch cannot be proven", () => {
		vi.spyOn(worktreeSafety, "checkBranchRetentionSafety").mockReturnValue({
			branch: "feat/f1",
			baseBranch: "main",
			refsObserved: false,
			integrationObserved: false,
			localCommitsObserved: false,
			hasLocalCommits: false,
			unmerged: false,
			forceable: false,
			safe: false,
			reasons: ["Could not resolve branch feat/f1 and base main."],
		});
		const ctx = {
			project: { id: "p1", name: "Project", repoPath: "/repo" },
			gitClient: { readSync: () => gitResult("worktree /repo\n") },
			featureManager: {
				getBaseBranchName: () => "main",
				getWorktreeBase: () => "/worktrees",
			},
			agentManager: { getAgents: () => [] },
		} as unknown as ProjectContext;

		const assessment = assessFeatureFinish(
			ctx,
			feature(),
			finishEvidence(),
			() => false,
		);

		expect(assessment.safe).toBe(false);
		expect(assessment.forceable).toBe(false);
		expect(assessment.reasons.join("\n")).toContain("Could not resolve");
	});

	it("blocks an unregistered path that still has files instead of hiding residue", () => {
		const ctx = {
			project: { id: "p1", name: "Project", repoPath: "/repo" },
			gitClient: { readSync: () => gitResult("worktree /repo\n") },
			featureManager: {
				getBaseBranchName: () => "main",
				getWorktreeBase: () => "/worktrees",
			},
			agentManager: { getAgents: () => [] },
		} as unknown as ProjectContext;

		const assessment = assessFeatureFinish(
			ctx,
			feature(),
			finishEvidence(),
			() => true,
		);

		expect(assessment.safe).toBe(false);
		expect(assessment.forceable).toBe(false);
		expect(assessment.checks[0]).toMatchObject({ disposition: "residue" });
		expect(assessment.reasons.join("\n")).toContain("files remain on disk");
	});

	it("accepts an exact merged PR as integration proof for a clean squash-merged Feature", () => {
		const headSha = "1".repeat(40);
		vi.spyOn(worktreeSafety, "checkWorktreeDeletionSafety").mockReturnValue({
			worktreePath: "/worktrees/f1",
			safe: false,
			forceable: true,
			insideBase: true,
			statusObserved: true,
			refsObserved: true,
			integrationObserved: true,
			localCommitsObserved: true,
			dirty: false,
			hasLocalCommits: true,
			unmerged: true,
			workingTreeStatus: "",
			localCommitCount: 1,
			featureSha: headSha,
			baseSha: "2".repeat(40),
			reasons: ["Branch feat/f1 is not an ancestor of main."],
		});
		const integration: IntegrationEvaluation = {
			status: "known",
			outcome: "integrated_by_pull_request",
			evidence: {
				feature: { ref: "feat/f1", sha: headSha },
				github: {
					status: "known",
					expectedBaseRef: "main",
					baseMatch: true,
					pull: {
						number: 74,
						url: "https://example.test/pull/74",
						state: "merged",
						draft: false,
						headRef: "feat/f1",
						headSha,
						baseRef: "main",
					},
				},
			},
		};

		const assessment = assessFeatureFinish(
			context("worktree /repo\n\nworktree /worktrees/f1\n"),
			feature(),
			finishEvidence(integration),
		);

		expect(assessment).toMatchObject({
			safe: true,
			forceable: true,
			reasons: [],
		});
		expect(planFeatureFinishRemovals(assessment)).toEqual([
			{
				kind: "feature",
				worktreePath: "/worktrees/f1",
				force: false,
				acceptedPullRequestHeadSha: headSha,
			},
		]);
	});

	it("keeps post-integration work explicit and forceable", () => {
		vi.spyOn(worktreeSafety, "checkWorktreeDeletionSafety").mockReturnValue({
			worktreePath: "/worktrees/f1",
			safe: false,
			forceable: true,
			insideBase: true,
			statusObserved: true,
			refsObserved: true,
			integrationObserved: true,
			localCommitsObserved: true,
			dirty: false,
			hasLocalCommits: true,
			unmerged: true,
			workingTreeStatus: "",
			localCommitCount: 2,
			featureSha: "2".repeat(40),
			baseSha: "3".repeat(40),
			reasons: ["Branch feat/f1 has 2 commits not in main."],
		});
		const assessment = assessFeatureFinish(
			context("worktree /repo\n\nworktree /worktrees/f1\n"),
			feature(),
			finishEvidence({
				status: "known",
				outcome: "new_work_after_integration",
				evidence: {},
			}),
		);

		expect(assessment).toMatchObject({ safe: false, forceable: true });
		expect(planFeatureFinishRemovals(assessment)[0]).toMatchObject({
			force: true,
		});
		expect(assessment.reasons.join("\n")).toContain("2 commits");
	});

	it("fails closed when GitHub integration evidence is unavailable", () => {
		vi.spyOn(worktreeSafety, "checkWorktreeDeletionSafety").mockReturnValue({
			worktreePath: "/worktrees/f1",
			safe: false,
			forceable: true,
			insideBase: true,
			statusObserved: true,
			refsObserved: true,
			integrationObserved: true,
			localCommitsObserved: true,
			dirty: false,
			hasLocalCommits: true,
			unmerged: true,
			workingTreeStatus: "",
			localCommitCount: 1,
			featureSha: "1".repeat(40),
			baseSha: "2".repeat(40),
			reasons: ["Branch feat/f1 is not an ancestor of main."],
		});
		const assessment = assessFeatureFinish(
			context("worktree /repo\n\nworktree /worktrees/f1\n"),
			feature(),
			finishEvidence({
				status: "unknown",
				reason: "integration_unknown",
				detail: "GitHub unavailable",
				evidence: {},
			}),
		);

		expect(assessment).toMatchObject({ safe: false, forceable: false });
		expect(assessment.reasons.join("\n")).toContain("GitHub unavailable");
	});

	it("plans force independently for a risky Feature and a clean agent", () => {
		const risky = {
			worktreePath: "/worktrees/f1",
			safe: false,
			forceable: true,
			insideBase: true,
			statusObserved: true,
			refsObserved: true,
			integrationObserved: true,
			localCommitsObserved: true,
			dirty: true,
			hasLocalCommits: false,
			unmerged: false,
			workingTreeStatus: " M changed.ts",
			localCommitCount: 0,
			featureSha: "1".repeat(40),
			baseSha: "2".repeat(40),
			reasons: ["Uncommitted changes detected: M changed.ts"],
		};
		const clean = {
			...risky,
			worktreePath: "/worktrees/a1",
			safe: true,
			dirty: false,
			workingTreeStatus: "",
			reasons: [],
		};
		vi.spyOn(worktreeSafety, "checkWorktreeDeletionSafety")
			.mockReturnValueOnce(risky)
			.mockReturnValueOnce(clean);
		const assessment = assessFeatureFinish(
			context(
				"worktree /repo\n\nworktree /worktrees/f1\n\nworktree /worktrees/a1\n",
				[agent("a1")],
			),
			feature(),
			finishEvidence(),
		);

		expect(planFeatureFinishRemovals(assessment)).toEqual([
			{
				kind: "feature",
				worktreePath: "/worktrees/f1",
				force: true,
			},
			{
				kind: "agent",
				agentId: "a1",
				worktreePath: "/worktrees/a1",
				force: false,
			},
		]);
	});

	it("requires positive proof that every tracked session stopped", () => {
		const sessions = new Set(["agent-space-f1-a1"]);
		expect(
			verifySessionsStopped(sessions, {
				status: "unknown",
				detail: "tmux unavailable",
			}),
		).toMatchObject({ status: "blocked" });
		expect(
			verifySessionsStopped(sessions, {
				status: "known",
				sessions: ["agent-space-f1-a1"],
			}),
		).toMatchObject({ status: "blocked" });
		expect(
			verifySessionsStopped(sessions, { status: "known", sessions: [] }),
		).toEqual({ status: "verified" });
	});
});
