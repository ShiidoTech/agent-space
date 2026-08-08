import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
	computeGitStatus,
	type GitStatusInput,
	invalidateGitStatusCache,
} from "../features/featureGitStatus";

const mockExecSync = vi.mocked(execSync);

const baseInput: GitStatusInput = {
	featureBranch: "feat/auth",
	baseBranch: "main",
	worktreePath: "/repo/.worktrees/auth",
	repoRoot: "/repo",
};

describe("computeGitStatus", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
		invalidateGitStatusCache();
	});

	it('returns "modified" when worktree has uncommitted changes', () => {
		// git status --porcelain (first check now)
		mockExecSync.mockReturnValueOnce(" M src/index.ts\n");

		expect(computeGitStatus(baseInput)).toBe("modified");
		// Should stop after the first check
		expect(mockExecSync).toHaveBeenCalledTimes(1);
	});

	it("modified takes priority over merged", () => {
		// Even if feature is ancestor of base, uncommitted changes win
		mockExecSync.mockReturnValueOnce(" M src/index.ts\n");

		expect(computeGitStatus(baseInput)).toBe("modified");
		// Should not even check rev-parse
		expect(mockExecSync).toHaveBeenCalledTimes(1);
	});

	it("modified takes priority over ahead", () => {
		mockExecSync.mockReturnValueOnce(" M src/index.ts\n");

		expect(computeGitStatus(baseInput)).toBe("modified");
		expect(mockExecSync).toHaveBeenCalledTimes(1);
	});

	it('returns "merged" when an advanced feature is ancestor of base', () => {
		mockExecSync
			// git status --porcelain (clean)
			.mockReturnValueOnce("")
			// rev-parse feature
			.mockReturnValueOnce("aaa111\n")
			// rev-parse base
			.mockReturnValueOnce("bbb222\n")
			// merge-base --is-ancestor succeeds (no throw)
			.mockReturnValueOnce("")
			// reflog proves the feature moved from its creation point
			.mockReturnValueOnce("000000\naaa111\n");

		expect(computeGitStatus(baseInput)).toBe("merged");
	});

	it('returns "new" when an untouched feature only became behind base', () => {
		mockExecSync
			// git status --porcelain (clean)
			.mockReturnValueOnce("")
			// feature still points at its creation commit
			.mockReturnValueOnce("aaa111\n")
			// base advanced after feature creation
			.mockReturnValueOnce("bbb222\n")
			// the untouched feature is therefore an ancestor of base
			.mockReturnValueOnce("")
			// one reflog SHA = branch never moved since creation
			.mockReturnValueOnce("aaa111\n")
			// no feature commits beyond base
			.mockReturnValueOnce("0\n");

		expect(computeGitStatus(baseInput)).toBe("new");
		expect(mockExecSync).toHaveBeenCalledWith(
			'git reflog show --reverse --format=%H "feat/auth"',
			expect.objectContaining({ cwd: baseInput.repoRoot }),
		);
	});

	it('returns "ahead" when feature has commits beyond base', () => {
		mockExecSync
			// git status --porcelain (clean)
			.mockReturnValueOnce("")
			// merged check: same SHA → skip
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("aaa111\n")
			// rev-list --count
			.mockReturnValueOnce("3\n");

		expect(computeGitStatus(baseInput)).toBe("ahead");
	});

	it('returns "ahead" when merge-base throws (not merged) but has commits', () => {
		mockExecSync
			// git status --porcelain (clean)
			.mockReturnValueOnce("")
			// rev-parse feature
			.mockReturnValueOnce("aaa111\n")
			// rev-parse base
			.mockReturnValueOnce("bbb222\n")
			// merge-base --is-ancestor throws (not ancestor)
			.mockImplementationOnce(() => {
				throw new Error("exit code 1");
			})
			// rev-list --count
			.mockReturnValueOnce("5\n");

		expect(computeGitStatus(baseInput)).toBe("ahead");
	});

	it('returns "new" when no changes at all', () => {
		mockExecSync
			// git status --porcelain (clean)
			.mockReturnValueOnce("")
			// Same SHA
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("aaa111\n")
			// rev-list --count = 0
			.mockReturnValueOnce("0\n");

		expect(computeGitStatus(baseInput)).toBe("new");
	});

	it('returns "new" when all git commands fail', () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("git not found");
		});

		expect(computeGitStatus(baseInput)).toBe("new");
	});

	it("runs git status --porcelain in worktreePath, not repoRoot", () => {
		mockExecSync.mockReturnValueOnce(" M file.ts\n");

		computeGitStatus(baseInput);

		// First call should use worktreePath as cwd
		expect(mockExecSync).toHaveBeenNthCalledWith(
			1,
			"git status --porcelain",
			expect.objectContaining({ cwd: baseInput.worktreePath }),
		);
	});

	it("returns cached result on second call within TTL", () => {
		mockExecSync.mockReturnValueOnce(" M file.ts\n");

		const first = computeGitStatus(baseInput);
		const second = computeGitStatus(baseInput);

		expect(first).toBe("modified");
		expect(second).toBe("modified");
		// git should only have been called once
		expect(mockExecSync).toHaveBeenCalledTimes(1);
	});

	it("invalidateGitStatusCache clears cache for a specific branch", () => {
		mockExecSync.mockReturnValueOnce(" M file.ts\n");
		computeGitStatus(baseInput);
		expect(mockExecSync).toHaveBeenCalledTimes(1);

		invalidateGitStatusCache(baseInput.featureBranch);

		mockExecSync.mockReturnValueOnce(" M file.ts\n");
		computeGitStatus(baseInput);
		// Should have called git again after invalidation
		expect(mockExecSync).toHaveBeenCalledTimes(2);
	});
});
