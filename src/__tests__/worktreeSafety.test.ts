import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(() => ""),
}));

import { execSync } from "node:child_process";
import { checkWorktreeDeletionSafety } from "../git/worktreeSafety";

const mockExecSync = vi.mocked(execSync);

describe("checkWorktreeDeletionSafety", () => {
	const repoRoot = "/repo";
	const worktreeBase = "/worktrees";
	const worktreePath = "/worktrees/feature-x";

	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("is safe when inside base and clean and merged", () => {
		// git status clean
		mockExecSync.mockReturnValueOnce("");
		// rev-list --count base..branch = 0
		mockExecSync.mockReturnValueOnce("0\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(true);
		expect(result.reasons).toEqual([]);
	});

	it("is unsafe when the path is outside the allowed base", () => {
		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath: "/elsewhere/feature-x",
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.reasons.join()).toContain("outside the allowed base");
	});

	it("is unsafe when the worktree has uncommitted changes", () => {
		mockExecSync.mockReturnValueOnce(" M src/index.ts\n");
		mockExecSync.mockReturnValueOnce("0\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.reasons.join()).toContain("Uncommitted changes");
	});

	it("is unsafe when the branch has local commits not on the base", () => {
		mockExecSync.mockReturnValueOnce("");
		mockExecSync.mockReturnValueOnce("3\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.reasons.join()).toContain("has commits that are not on");
	});

	it("is unsafe when the branch is not merged into the base", () => {
		mockExecSync.mockReturnValueOnce(""); // clean
		mockExecSync.mockReturnValueOnce("0\n"); // no local commits ahead
		// rev-parse branch
		mockExecSync.mockReturnValueOnce("aaa111\n");
		// rev-parse base
		mockExecSync.mockReturnValueOnce("bbb222\n");
		// merge-base --is-ancestor throws → not merged
		mockExecSync.mockImplementationOnce(() => {
			throw new Error("exit code 1");
		});

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.reasons.join()).toContain("not fully merged");
	});

	it("treats an already-merged branch as safe", () => {
		mockExecSync.mockReturnValueOnce("");
		mockExecSync.mockReturnValueOnce("0\n");
		// same SHA → skip merge-base
		mockExecSync.mockReturnValueOnce("aaa111\n");
		mockExecSync.mockReturnValueOnce("aaa111\n");

		const result = checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath: path.join(worktreeBase, "feature-x"),
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(true);
	});
});
