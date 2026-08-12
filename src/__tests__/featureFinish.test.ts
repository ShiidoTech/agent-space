import { describe, expect, it, vi } from "vitest";
import {
	assessFeatureFinish,
	verifySessionsStopped,
} from "../features/featureFinish";
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

describe("Feature Finish", () => {
	it("resumes after earlier worktrees were removed while records were preserved", () => {
		const agents = [agent("a1"), agent("a2")];
		const readSync = vi.fn((args: readonly string[]) => {
			if (args[0] === "worktree") {
				return gitResult("worktree /repo\n\nworktree /worktrees/a2\n");
			}
			return gitResult("feat/f1/agent-a2\n");
		});
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

		const assessment = assessFeatureFinish(ctx, feature(), () => false);

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

		const assessment = assessFeatureFinish(ctx, feature(), () => false);

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

		const assessment = assessFeatureFinish(ctx, feature(), () => true);

		expect(assessment.safe).toBe(false);
		expect(assessment.forceable).toBe(false);
		expect(assessment.checks[0]).toMatchObject({ disposition: "residue" });
		expect(assessment.reasons.join("\n")).toContain("files remain on disk");
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
