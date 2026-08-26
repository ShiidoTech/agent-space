import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import {
	checkBranchRetentionSafety,
	checkWorktreeDeletionSafety,
} from "../git/worktreeSafety";

interface ExecFileMock {
	mockImplementation(fn: (...args: unknown[]) => unknown): void;
	mockReset(): void;
}
const execFileMock = vi.mocked(execFile) as unknown as ExecFileMock;

type GitResponse = string | Error;

/** Consume one mock response per execFile invocation, callback-style. */
function mockGitSequence(...responses: GitResponse[]): void {
	const queue = [...responses];
	execFileMock.mockImplementation((...args: unknown[]) => {
		const callback = args[3] as
			| ((error: Error | null, result: unknown) => void)
			| undefined;
		const next = queue.shift();
		if (next instanceof Error) {
			callback?.(next, null);
			return;
		}
		callback?.(null, { stdout: next, stderr: "" });
	});
}

function gitError(code: number): Error & { code: number } {
	return Object.assign(new Error(`git exited with ${code}`), { code });
}

describe("checkWorktreeDeletionSafety", () => {
	const repoRoot = "/repo";
	const worktreeBase = "/worktrees";
	const worktreePath = "/worktrees/feature-x";
	const featureSha = "a".repeat(40);
	const baseSha = "b".repeat(40);

	beforeEach(() => {
		execFileMock.mockReset();
	});

	function mockCleanMerged(): void {
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", "0\n");
	}

	it("is safe when inside base and clean and merged", async () => {
		mockCleanMerged();

		const result = await checkWorktreeDeletionSafety({
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

	it("is unsafe when the path is outside the allowed base", async () => {
		mockCleanMerged();

		const result = await checkWorktreeDeletionSafety({
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

	it("is unsafe when the worktree has uncommitted changes", async () => {
		mockGitSequence(
			" M src/index.ts\n",
			`${featureSha}\n`,
			`${baseSha}\n`,
			"",
			"0\n",
		);

		const result = await checkWorktreeDeletionSafety({
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

	it("is unsafe when the branch has local commits not on the base", async () => {
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, gitError(1), "3\n");

		const result = await checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(false);
		expect(result.reasons.join()).toContain("has 3 commits that are not on");
	});

	it("treats an already-merged branch as safe", async () => {
		mockCleanMerged();

		const result = await checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath: path.join(worktreeBase, "feature-x"),
			branch: "feature/x",
			baseBranch: "main",
		});

		expect(result.safe).toBe(true);
	});

	it("blocks deletion when git status cannot be observed", async () => {
		mockGitSequence(
			gitError(128),
			`${featureSha}\n`,
			`${baseSha}\n`,
			"",
			"0\n",
		);

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when the feature branch is unknown", async () => {
		mockGitSequence("");

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when the base branch is unknown", async () => {
		mockGitSequence("");

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when a ref cannot be resolved", async () => {
		mockGitSequence("", gitError(128));

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when the base ref cannot be resolved", async () => {
		mockGitSequence("", `${featureSha}\n`, gitError(128));

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when ref resolution returns malformed output", async () => {
		mockGitSequence("", "not-a-sha\n", `${baseSha}\n`);

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when ancestry inspection fails unexpectedly", async () => {
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, gitError(128));

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when the ahead count cannot be observed", async () => {
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", gitError(128));

		const result = await checkWorktreeDeletionSafety({
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

	it("blocks deletion when Git returns a malformed ahead count", async () => {
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", "not-a-count\n");

		const result = await checkWorktreeDeletionSafety({
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

	beforeEach(() => execFileMock.mockReset());

	it("allows forgetting an absent worktree only after proving its branch integrated", async () => {
		mockGitSequence(`${featureSha}\n`, `${baseSha}\n`, "", "0\n");

		await expect(
			checkBranchRetentionSafety({
				repoRoot: "/repo",
				branch: "feature/x",
				baseBranch: "main",
			}),
		).resolves.toMatchObject({
			safe: true,
			forceable: true,
			localCommitCount: 0,
		});
	});

	it("surfaces retained unique commits as a known force decision", async () => {
		mockGitSequence(`${featureSha}\n`, `${baseSha}\n`, gitError(1), "4\n");

		const result = await checkBranchRetentionSafety({
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

	it("blocks when the retained branch cannot be resolved", async () => {
		mockGitSequence(gitError(128));

		await expect(
			checkBranchRetentionSafety({
				repoRoot: "/repo",
				branch: "feature/missing",
				baseBranch: "main",
			}),
		).resolves.toMatchObject({
			safe: false,
			forceable: false,
			refsObserved: false,
		});
	});
});
