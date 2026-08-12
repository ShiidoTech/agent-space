import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(() => ""),
}));

import { execSync } from "node:child_process";
import {
	checkBranchRetentionSafety,
	checkWorktreeDeletionSafety,
} from "../git/worktreeSafety";

const mockExecSync = vi.mocked(execSync);

describe("checkWorktreeDeletionSafety", () => {
	const repoRoot = "/repo";
	const worktreeBase = "/worktrees";
	const worktreePath = "/worktrees/feature-x";
	const featureSha = "a".repeat(40);
	const baseSha = "b".repeat(40);

	beforeEach(() => {
		mockExecSync.mockReset();
	});

	function gitError(status: number): Error & { status: number } {
		return Object.assign(new Error(`git exited with ${status}`), { status });
	}

	function mockCleanMerged(): void {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockReturnValueOnce("")
			.mockReturnValueOnce("0\n");
	}

	it("is safe when inside base and clean and merged", () => {
		mockCleanMerged();

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(true);
		expect(result.forceable).toBe(true);
		expect(result.statusObserved).toBe(true);
		expect(result.refsObserved).toBe(true);
		expect(result.integrationObserved).toBe(true);
		expect(result.localCommitsObserved).toBe(true);
		expect(result.reasons).toEqual([]);
	});

	it("is unsafe when the path is outside the allowed base", () => {
		mockCleanMerged();

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath: "/elsewhere/feature-x",
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.forceable).toBe(false);
		expect(result.reasons.join()).toContain("outside the allowed base");
	});

	it("is unsafe when the worktree has uncommitted changes", () => {
		mockExecSync
			.mockReturnValueOnce(" M src/index.ts\n")
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockReturnValueOnce("")
			.mockReturnValueOnce("0\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.forceable).toBe(true);
		expect(result.reasons.join()).toContain("Uncommitted changes");
	});

	it("is unsafe when the branch has local commits not on the base", () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockImplementationOnce(() => {
				throw gitError(1);
			})
			.mockReturnValueOnce("3\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.reasons.join()).toContain("has 3 commits that are not on");
	});

	it("treats an already-merged branch as safe", () => {
		mockCleanMerged();

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath: path.join(worktreeBase, "feature-x"),
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(true);
	});

	it("blocks deletion when git status cannot be observed", () => {
		mockExecSync
			.mockImplementationOnce(() => {
				throw gitError(128);
			})
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockReturnValueOnce("")
			.mockReturnValueOnce("0\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.statusObserved).toBe(false);
		expect(result.reasons.join()).toContain("git status failed");
	});

	it("blocks deletion when the feature branch is unknown", () => {
		mockExecSync.mockReturnValueOnce("");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.refsObserved).toBe(false);
		expect(result.integrationObserved).toBe(false);
		expect(result.localCommitsObserved).toBe(false);
		expect(result.reasons.join()).toContain("feature branch is unknown");
	});

	it("blocks deletion when the base branch is unknown", () => {
		mockExecSync.mockReturnValueOnce("");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
		});

		expect(result.safe).toBe(false);
		expect(result.refsObserved).toBe(false);
		expect(result.integrationObserved).toBe(false);
		expect(result.localCommitsObserved).toBe(false);
		expect(result.reasons.join()).toContain("base branch is unknown");
	});

	it("blocks deletion when a ref cannot be resolved", () => {
		mockExecSync.mockReturnValueOnce("").mockImplementationOnce(() => {
			throw gitError(128);
		});

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/missing",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.refsObserved).toBe(false);
		expect(result.reasons.join()).toContain("could not be resolved");
	});

	it("blocks deletion when the base ref cannot be resolved", () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockImplementationOnce(() => {
				throw gitError(128);
			});

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "missing-base",
		});

		expect(result.safe).toBe(false);
		expect(result.refsObserved).toBe(false);
		expect(result.reasons.join()).toContain("could not be resolved");
	});

	it("blocks deletion when ref resolution returns malformed output", () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce("not-a-sha\n")
			.mockReturnValueOnce(`${baseSha}\n`);

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.refsObserved).toBe(false);
		expect(result.reasons.join()).toContain("could not be resolved");
	});

	it("blocks deletion when ancestry inspection fails unexpectedly", () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockImplementationOnce(() => {
				throw gitError(128);
			});

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.refsObserved).toBe(true);
		expect(result.integrationObserved).toBe(false);
		expect(result.reasons.join()).toContain("ancestry inspection failed");
	});

	it("blocks deletion when the ahead count cannot be observed", () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockReturnValueOnce("")
			.mockImplementationOnce(() => {
				throw gitError(128);
			});

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.integrationObserved).toBe(true);
		expect(result.localCommitsObserved).toBe(false);
		expect(result.reasons.join()).toContain("commit inspection failed");
	});

	it("blocks deletion when Git returns a malformed ahead count", () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockReturnValueOnce("")
			.mockReturnValueOnce("not-a-count\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.integrationObserved).toBe(true);
		expect(result.localCommitsObserved).toBe(false);
		expect(result.reasons.join()).toContain("commit inspection failed");
	});
});

describe("checkBranchRetentionSafety", () => {
	const featureSha = "a".repeat(40);
	const baseSha = "b".repeat(40);

	beforeEach(() => mockExecSync.mockReset());

	it("allows forgetting an absent worktree only after proving its branch integrated", () => {
		mockExecSync
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockReturnValueOnce("")
			.mockReturnValueOnce("0\n");

		expect(
			checkBranchRetentionSafety({
				repoRoot: "/repo",
				branch: "feature/x",
				baseBranch: "main",
			}),
		).toMatchObject({ safe: true, forceable: true, localCommitCount: 0 });
	});

	it("surfaces retained unique commits as a known force decision", () => {
		mockExecSync
			.mockReturnValueOnce(`${featureSha}\n`)
			.mockReturnValueOnce(`${baseSha}\n`)
			.mockImplementationOnce(() => {
				throw Object.assign(new Error("not ancestor"), { status: 1 });
			})
			.mockReturnValueOnce("4\n");

		const result = checkBranchRetentionSafety({
			repoRoot: "/repo",
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result).toMatchObject({
			safe: false,
			forceable: true,
			hasLocalCommits: true,
			localCommitCount: 4,
			unmerged: true,
		});
		expect(result.reasons.join("\n")).toContain("Git branch will be preserved");
	});

	it("blocks when the retained branch cannot be resolved", () => {
		mockExecSync.mockImplementationOnce(() => {
			throw Object.assign(new Error("missing"), { status: 128 });
		});

		expect(
			checkBranchRetentionSafety({
				repoRoot: "/repo",
				branch: "feature/missing",
				baseBranch: "main",
			}),
		).toMatchObject({ safe: false, forceable: false, refsObserved: false });
	});
});
