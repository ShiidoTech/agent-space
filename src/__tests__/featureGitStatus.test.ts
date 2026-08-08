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
		mockExecSync.mockReturnValueOnce(" M src/index.ts\n");
		expect(computeGitStatus(baseInput)).toBe("modified");
		expect(mockExecSync).toHaveBeenCalledTimes(1);
	});

	it("modified takes priority over other states", () => {
		mockExecSync.mockReturnValueOnce(" M src/index.ts\n");
		expect(computeGitStatus(baseInput)).toBe("modified");
		expect(mockExecSync).toHaveBeenCalledTimes(1);
	});

	it('returns "merged" when an advanced feature is ancestor of base', () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("bbb222\n")
			.mockReturnValueOnce("");

		expect(computeGitStatus({ ...baseInput, createdFromSha: "000000" })).toBe(
			"merged",
		);
	});

	it('returns "new" when an untouched feature only became behind base', () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("bbb222\n")
			.mockReturnValueOnce("")
			.mockReturnValueOnce("0\n");

		expect(computeGitStatus({ ...baseInput, createdFromSha: "aaa111" })).toBe(
			"new",
		);
	});

	it("keeps the old merged behavior when reflog history is incomplete", () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("bbb222\n")
			.mockReturnValueOnce("")
			.mockReturnValueOnce("bbb222\n")
			.mockReturnValueOnce("0\n");

		expect(computeGitStatus(baseInput)).toBe("merged");
	});

	it('returns "ahead" when feature has commits beyond base', () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("3\n");
		expect(computeGitStatus(baseInput)).toBe("ahead");
	});

	it('returns "ahead" when merge-base throws but feature has commits', () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("bbb222\n")
			.mockImplementationOnce(() => {
				throw new Error("exit code 1");
			})
			.mockReturnValueOnce("5\n");
		expect(computeGitStatus(baseInput)).toBe("ahead");
	});

	it('returns "new" when no changes at all', () => {
		mockExecSync
			.mockReturnValueOnce("")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("aaa111\n")
			.mockReturnValueOnce("0\n");
		expect(computeGitStatus(baseInput)).toBe("new");
	});

	it('returns "new" when all git commands fail', () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("git not found");
		});
		expect(computeGitStatus(baseInput)).toBe("new");
	});

	it("runs git status in worktreePath", () => {
		mockExecSync.mockReturnValueOnce(" M file.ts\n");
		computeGitStatus(baseInput);
		expect(mockExecSync).toHaveBeenNthCalledWith(
			1,
			"git status --porcelain",
			expect.objectContaining({ cwd: baseInput.worktreePath }),
		);
	});

	it("returns cached result on second call within TTL", () => {
		mockExecSync.mockReturnValueOnce(" M file.ts\n");
		expect(computeGitStatus(baseInput)).toBe("modified");
		expect(computeGitStatus(baseInput)).toBe("modified");
		expect(mockExecSync).toHaveBeenCalledTimes(1);
	});

	it("invalidates cache for a specific branch", () => {
		mockExecSync.mockReturnValueOnce(" M file.ts\n");
		computeGitStatus(baseInput);
		invalidateGitStatusCache(baseInput.featureBranch);
		mockExecSync.mockReturnValueOnce(" M file.ts\n");
		computeGitStatus(baseInput);
		expect(mockExecSync).toHaveBeenCalledTimes(2);
	});
});
