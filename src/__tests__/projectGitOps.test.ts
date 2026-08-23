import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
	stat: vi.fn(),
	readFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import type { GitReader, GitReadResult } from "../git/gitClient";
import {
	assessWorktreeBranchDeletion,
	deleteWorktreeBranch,
	updateBaseBranch,
} from "../projects/projectGitOps";
import type { ProjectReferenceBranchHealth } from "../projects/referenceBranchHealth";

interface ExecFileMock {
	mockImplementation(fn: (...args: unknown[]) => unknown): void;
	mockReset(): void;
}
const execFileMock = vi.mocked(execFile) as unknown as ExecFileMock;
const statMock = vi.mocked(stat);
const readFileMock = vi.mocked(readFile);

type GitResponse = string | Error;

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

function result(overrides: Partial<GitReadResult> = {}): GitReadResult {
	return {
		argv: [],
		cwd: "/repo",
		exitCode: 0,
		signal: null,
		stdout: "",
		stderr: "",
		...overrides,
	};
}

function health(
	overrides: Partial<ProjectReferenceBranchHealth> = {},
): ProjectReferenceBranchHealth {
	return {
		repoPath: "/repo",
		branch: "main",
		remoteName: "origin",
		local: {
			status: "known",
			sha: "a".repeat(40),
			observedAt: "2026-01-01T00:00:00.000Z",
			provenance: {
				source: "local_branch",
				ref: "refs/heads/main",
				backend: "git show-ref",
			},
		},
		remoteTracking: {
			status: "known",
			sha: "b".repeat(40),
			observedAt: "2026-01-01T00:00:00.000Z",
			provenance: {
				source: "remote_tracking_ref",
				ref: "refs/remotes/origin/main",
				backend: "git show-ref",
			},
		},
		verifiedRemote: {
			status: "known",
			sha: "b".repeat(40),
			observedAt: "2026-01-01T00:00:00.000Z",
			provenance: {
				source: "remote_head",
				ref: "refs/heads/main",
				backend: "git ls-remote",
			},
		},
		remoteTrackingRelation: { state: "behind", localOnly: 0, comparedOnly: 4 },
		verifiedRemoteRelation: { state: "behind", localOnly: 0, comparedOnly: 4 },
		state: "behind",
		remoteFreshness: {
			status: "fresh",
			observedAt: "2026-01-01T00:00:00.000Z",
			staleAfterMs: 300_000,
		},
		observedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("updateBaseBranch", () => {
	function reader(
		handler: (argv: readonly string[]) => GitReadResult,
	): GitReader {
		return {
			readSync: vi.fn(),
			read: vi.fn(async (argv) => handler(argv)) as GitReader["read"],
		};
	}

	it("reports already_current when the relation is current", async () => {
		const git = reader(() => result());
		const outcome = await updateBaseBranch(
			git,
			"/repo",
			health({
				verifiedRemoteRelation: {
					state: "current",
					localOnly: 0,
					comparedOnly: 0,
				},
			}),
		);
		expect(outcome).toEqual({ status: "already_current" });
		expect(git.read).not.toHaveBeenCalled();
	});

	it("refuses when the verified remote head is unknown", async () => {
		const git = reader(() => result());
		const outcome = await updateBaseBranch(
			git,
			"/repo",
			health({
				verifiedRemote: {
					status: "unknown",
					reason: "remote_query_failed",
					observedAt: "2026-01-01T00:00:00.000Z",
					provenance: {
						source: "remote_head",
						ref: "refs/heads/main",
						backend: "git ls-remote",
					},
				},
			}),
		);
		expect(outcome.status).toBe("error");
		expect(git.read).not.toHaveBeenCalled();
	});

	it("fetches and fast-forwards when HEAD is on the base branch", async () => {
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result();
			if (argv[0] === "symbolic-ref") return result({ stdout: "main" });
			if (argv[0] === "merge") return result();
			return result();
		});
		const outcome = await updateBaseBranch(git, "/repo", health());
		expect(outcome).toEqual({ status: "updated", method: "fast_forward" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["fetch", "origin", "main"],
			["status", "--porcelain"],
			["symbolic-ref", "--short", "HEAD"],
			["merge", "--ff-only", "FETCH_HEAD"],
		]);
	});

	it("aborts on a dirty working tree without merging", async () => {
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result({ stdout: " M src/x.ts\n" });
			return result();
		});
		const confirmMerge = vi.fn(async () => true);
		const outcome = await updateBaseBranch(git, "/repo", health(), {
			confirmMerge,
		});
		expect(outcome.status).toBe("error");
		expect(confirmMerge).not.toHaveBeenCalled();
	});

	it("merges only after explicit confirmation when fast-forward is impossible", async () => {
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result();
			if (argv[0] === "symbolic-ref") return result({ stdout: "main" });
			if (argv[0] === "merge" && argv[1] === "--ff-only") {
				return result({ exitCode: 1, stderr: "Not possible to fast-forward" });
			}
			if (argv[0] === "merge") return result();
			return result();
		});
		const confirmMerge = vi.fn(async () => true);
		const outcome = await updateBaseBranch(git, "/repo", health(), {
			confirmMerge,
		});
		expect(outcome).toEqual({ status: "updated", method: "merge" });
		expect(confirmMerge).toHaveBeenCalledTimes(1);
	});

	it("cancels the merge when the human declines", async () => {
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result();
			if (argv[0] === "symbolic-ref") return result({ stdout: "main" });
			if (argv[0] === "merge") {
				return result({ exitCode: 1, stderr: "Not possible to fast-forward" });
			}
			return result();
		});
		const confirmMerge = vi.fn(async () => false);
		const outcome = await updateBaseBranch(git, "/repo", health(), {
			confirmMerge,
		});
		expect(outcome.status).toBe("error");
	});

	it("fast-forwards the local ref when HEAD is on another branch", async () => {
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result();
			if (argv[0] === "symbolic-ref") return result({ stdout: "feat/other" });
			if (argv[0] === "rev-parse") return result({ stdout: "c".repeat(40) });
			if (argv[0] === "merge-base") return result();
			if (argv[0] === "worktree") return result();
			if (argv[0] === "update-ref") return result();
			return result();
		});
		const outcome = await updateBaseBranch(git, "/repo", health());
		expect(outcome).toEqual({ status: "updated", method: "fast_forward" });
		expect(vi.mocked(git.read).mock.calls).toContainEqual([
			["worktree", "list", "--porcelain"],
			expect.anything(),
		]);
		expect(vi.mocked(git.read).mock.calls).toContainEqual([
			["update-ref", "refs/heads/main", "FETCH_HEAD", "c".repeat(40)],
			expect.anything(),
		]);
	});

	it("refuses to move a branch checked out in another worktree", async () => {
		const porcelainOutput = [
			"worktree /repo",
			`HEAD ${"c".repeat(40)}`,
			"branch refs/heads/main",
			"",
			"worktree /repo/.worktrees/elsewhere",
			`HEAD ${"d".repeat(40)}`,
			"branch refs/heads/main",
			"",
		].join("\n");
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result();
			if (argv[0] === "symbolic-ref") return result({ stdout: "feat/other" });
			if (argv[0] === "rev-parse") return result({ stdout: "c".repeat(40) });
			if (argv[0] === "merge-base") return result();
			if (argv[0] === "worktree") {
				return result({ stdout: porcelainOutput });
			}
			return result();
		});
		const outcome = await updateBaseBranch(git, "/repo", health());
		expect(outcome.status).toBe("error");
		expect((outcome as { message: string }).message).toContain(
			"checked out in worktree",
		);
		expect(
			vi.mocked(git.read).mock.calls.some(([argv]) => argv[0] === "update-ref"),
		).toBe(false);
	});

	it("fails closed when the worktree list cannot be read", async () => {
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result();
			if (argv[0] === "symbolic-ref") return result({ stdout: "feat/other" });
			if (argv[0] === "rev-parse") return result({ stdout: "c".repeat(40) });
			if (argv[0] === "merge-base") return result();
			if (argv[0] === "worktree") {
				return result({ exitCode: 128, stderr: "fatal: not a git repository" });
			}
			return result();
		});
		const outcome = await updateBaseBranch(git, "/repo", health());
		expect(outcome.status).toBe("error");
		expect((outcome as { message: string }).message).toContain("Cannot verify");
		expect(
			vi.mocked(git.read).mock.calls.some(([argv]) => argv[0] === "update-ref"),
		).toBe(false);
	});

	it("refuses to move the local ref when the remote is not a descendant", async () => {
		const git = reader((argv) => {
			if (argv[0] === "fetch") return result();
			if (argv[0] === "status") return result();
			if (argv[0] === "symbolic-ref") return result({ stdout: "feat/other" });
			if (argv[0] === "rev-parse") return result({ stdout: "c".repeat(40) });
			if (argv[0] === "merge-base") return result({ exitCode: 1 });
			return result();
		});
		const outcome = await updateBaseBranch(git, "/repo", health());
		expect(outcome.status).toBe("error");
		expect(
			vi.mocked(git.read).mock.calls.some(([argv]) => argv[0] === "update-ref"),
		).toBe(false);
	});
});

describe("deleteWorktreeBranch", () => {
	const repoRoot = "/repo";
	const worktreeBase = "/repo/.worktrees";
	const featureSha = "a".repeat(40);
	const baseSha = "b".repeat(40);

	beforeEach(() => {
		execFileMock.mockReset();
		statMock.mockReset();
		readFileMock.mockReset();
	});

	/** `git worktree list --porcelain` proving worktreePath ↔ branchRef. */
	function porcelain(worktreePath: string, branchRef: string): string {
		return [
			`worktree ${repoRoot}`,
			`HEAD ${"b".repeat(40)}`,
			"branch refs/heads/main",
			"",
			`worktree ${worktreePath}`,
			`HEAD ${"a".repeat(40)}`,
			`branch refs/heads/${branchRef}`,
			"",
		].join("\n");
	}

	function readerOk(
		worktreePath = `${worktreeBase}/feat/x`,
		branchRef = "feat/x",
	): GitReader {
		return {
			readSync: vi.fn(),
			read: vi.fn(async (argv) =>
				argv[0] === "worktree" && argv[1] === "list"
					? result({ stdout: porcelain(worktreePath, branchRef) })
					: result(),
			) as GitReader["read"],
		};
	}

	it("never deletes the base branch", async () => {
		const outcome = await deleteWorktreeBranch(readerOk(), {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "main",
			baseBranch: "main",
		});
		expect(outcome.status).toBe("not_deletable");
		expect(
			(outcome as { reasons: readonly string[] }).reasons.join(),
		).toContain("base branch");
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("refuses to remove the main working tree", async () => {
		const outcome = await deleteWorktreeBranch(readerOk(), {
			repoRoot,
			worktreeBase,
			worktreePath: repoRoot,
			branchRef: "feat/x",
			baseBranch: "main",
		});
		expect(outcome.status).toBe("not_deletable");
		expect(
			(outcome as { reasons: readonly string[] }).reasons.join(),
		).toContain("main working tree");
	});

	it("evaluates a live foreign worktree instead of refusing when clean and integrated", async () => {
		statMock.mockResolvedValue({ mtimeMs: Date.now() } as never);
		readFileMock.mockResolvedValue("gitdir: /repo/.git/worktrees/foreign\n");
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", "0\n");
		const foreignPath = "/tmp/foreign/agent-worktree";
		const git = readerOk(foreignPath, "recover/x");
		const assessment = await assessWorktreeBranchDeletion(
			{
				repoRoot,
				worktreeBase,
				worktreePath: foreignPath,
				branchRef: "recover/x",
				baseBranch: "main",
			},
			git,
		);
		expect(assessment.deletable).toBe(true);
		expect(assessment.foreign?.lastActivity?.source).toBe("git index");
	});

	it("falls back to the commit date when the gitdir pointer is unreadable", async () => {
		statMock.mockResolvedValue({} as never);
		readFileMock.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", "0\n");
		const foreignPath = "/tmp/foreign/agent-worktree";
		const git: GitReader = {
			readSync: vi.fn(),
			read: vi.fn(async (argv) =>
				argv[0] === "worktree"
					? result({ stdout: porcelain(foreignPath, "recover/x") })
					: argv[0] === "log"
						? result({ stdout: `${Math.floor(Date.now() / 1000)}\n` })
						: result(),
			) as GitReader["read"],
		};
		const assessment = await assessWorktreeBranchDeletion(
			{
				repoRoot,
				worktreeBase,
				worktreePath: foreignPath,
				branchRef: "recover/x",
				baseBranch: "main",
			},
			git,
		);
		expect(assessment.deletable).toBe(true);
		expect(assessment.foreign?.lastActivity?.source).toBe("last commit");
	});

	it("surfaces data-loss evidence for a dirty live foreign worktree", async () => {
		statMock.mockResolvedValue({} as never);
		mockGitSequence(
			" M src/x.ts\n",
			`${featureSha}\n`,
			`${baseSha}\n`,
			"",
			"3\n",
		);
		const foreignPath = "/tmp/foreign/agent-worktree";
		const git = readerOk(foreignPath, "recover/x");
		const assessment = await assessWorktreeBranchDeletion(
			{
				repoRoot,
				worktreeBase,
				worktreePath: foreignPath,
				branchRef: "recover/x",
				baseBranch: "main",
			},
			git,
		);
		expect(assessment.deletable).toBe(true);
		expect(assessment.reasons.join("\n")).toContain("Uncommitted changes");
		expect(assessment.dataLoss?.dirtyFiles).toEqual(["src/x.ts"]);
		expect(assessment.dataLoss?.unmergedCommits).toBe(3);
		expect(assessment.foreign).toBeDefined();
	});

	it("deletes an integrated live foreign worktree through the normal flow", async () => {
		statMock.mockResolvedValue({ mtimeMs: Date.now() } as never);
		readFileMock.mockResolvedValue("gitdir: /repo/.git/worktrees/foreign\n");
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", "0\n");
		const foreignPath = "/tmp/foreign/agent-worktree";
		const git = readerOk(foreignPath, "recover/x");
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: foreignPath,
			branchRef: "recover/x",
			baseBranch: "main",
		});
		expect(outcome).toEqual({ status: "deleted", branch: "recover/x" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "list", "--porcelain"],
			["log", "-1", "--format=%ct", "recover/x"],
			["worktree", "remove", foreignPath],
			["branch", "-d", "recover/x"],
		]);
	});

	it("removes the worktree and deletes the branch when safe", async () => {
		statMock.mockResolvedValue({} as never);
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", "0\n");
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
		});
		expect(outcome).toEqual({ status: "deleted", branch: "feat/x" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "list", "--porcelain"],
			["worktree", "remove", `${worktreeBase}/feat/x`],
			["branch", "-d", "feat/x"],
		]);
	});

	it("deletes a dirty worktree with --force once the loss is acknowledged", async () => {
		statMock.mockResolvedValue({} as never);
		mockGitSequence(
			" M src/x.ts\n",
			`${featureSha}\n`,
			`${baseSha}\n`,
			"",
			"0\n",
		);
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
			acknowledgedLoss: { dirtyFiles: ["src/x.ts"] },
		});
		expect(outcome).toEqual({ status: "deleted", branch: "feat/x" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "list", "--porcelain"],
			["worktree", "remove", "--force", `${worktreeBase}/feat/x`],
			["branch", "-d", "feat/x"],
		]);
	});

	it("never escalates when the tree became dirty after a non-destructive confirmation", async () => {
		statMock.mockResolvedValue({} as never);
		mockGitSequence(
			" M src/x.ts\n",
			`${featureSha}\n`,
			`${baseSha}\n`,
			"",
			"0\n",
		);
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
			acknowledgedLoss: {},
		});
		expect(outcome.status).toBe("confirmation_required");
		const calls = vi.mocked(git.read).mock.calls.map(([argv]) => argv);
		expect(
			calls.some((argv) => argv[0] === "worktree" && argv[1] === "remove"),
		).toBe(false);
		expect(calls.some((argv) => argv[0] === "branch")).toBe(false);
	});

	it("requires reconfirmation when more commits became unmerged than acknowledged", async () => {
		statMock.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockGitSequence(`${featureSha}\n`, `${baseSha}\n`, gitError(1), "5\n");
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/gone`,
			branchRef: "feat/gone",
			baseBranch: "main",
			acknowledgedLoss: { unmergedCommits: 3 },
		});
		expect(outcome.status).toBe("confirmation_required");
		expect(vi.mocked(git.read)).not.toHaveBeenCalled();
	});

	it("downgrades to safe forms when the acknowledged loss disappeared", async () => {
		statMock.mockResolvedValue({} as never);
		mockGitSequence("", `${featureSha}\n`, `${baseSha}\n`, "", "0\n");
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
			acknowledgedLoss: { dirtyFiles: ["src/x.ts"] },
		});
		expect(outcome).toEqual({ status: "deleted", branch: "feat/x" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "list", "--porcelain"],
			["worktree", "remove", `${worktreeBase}/feat/x`],
			["branch", "-d", "feat/x"],
		]);
	});

	it("deletes an already-gone worktree branch when fully merged", async () => {
		statMock.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockGitSequence(`${featureSha}\n`, `${baseSha}\n`, "", "0\n");
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/gone`,
			branchRef: "feat/gone",
			baseBranch: "main",
		});
		expect(outcome).toEqual({ status: "deleted", branch: "feat/gone" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "remove", `${worktreeBase}/feat/gone`],
			["branch", "-d", "feat/gone"],
		]);
	});

	it("deletes a stale out-of-base registration when fully integrated", async () => {
		statMock.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockGitSequence(`${featureSha}\n`, `${baseSha}\n`, "", "0\n");
		const foreignPath = "/tmp/foreign/agent-space-recovery";
		const git = readerOk(foreignPath, "recover/x");
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: foreignPath,
			branchRef: "recover/x",
			baseBranch: "main",
		});
		expect(outcome).toEqual({ status: "deleted", branch: "recover/x" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "remove", foreignPath],
			["branch", "-d", "recover/x"],
		]);
	});

	it("forces deletion of an unmerged stale out-of-base registration once acknowledged", async () => {
		statMock.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockGitSequence(`${featureSha}\n`, `${baseSha}\n`, gitError(1), "3\n");
		const foreignPath = "/tmp/foreign/agent-space-recovery";
		const git = readerOk(foreignPath, "recover/x");
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: foreignPath,
			branchRef: "recover/x",
			baseBranch: "main",
			acknowledgedLoss: { unmergedCommits: 3 },
		});
		expect(outcome).toEqual({ status: "deleted", branch: "recover/x" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "remove", foreignPath],
			["branch", "-D", "recover/x"],
		]);
	});

	it("marks integration unknown and still deletes when refs cannot be resolved", async () => {
		statMock.mockResolvedValue({} as never);
		mockGitSequence("", gitError(1));
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
			acknowledgedLoss: { integrationUnknown: true },
		});
		expect(outcome).toEqual({ status: "deleted", branch: "feat/x" });
		expect(vi.mocked(git.read).mock.calls.map(([argv]) => argv)).toEqual([
			["worktree", "list", "--porcelain"],
			["worktree", "remove", `${worktreeBase}/feat/x`],
			["branch", "-D", "feat/x"],
		]);
	});

	it("refuses when the worktree path is paired with a different branch", async () => {
		statMock.mockResolvedValue({} as never);
		const git = readerOk(`${worktreeBase}/feat/x`, "feat/other");
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
		});
		expect(outcome.status).toBe("not_deletable");
		expect(
			(outcome as { reasons: readonly string[] }).reasons.join(),
		).toContain("does not have branch feat/x checked out");
		expect(
			vi
				.mocked(git.read)
				.mock.calls.some(
					([argv]) => argv[0] === "worktree" && argv[1] === "remove",
				),
		).toBe(false);
	});

	it("fails closed when the worktree directory is unreadable", async () => {
		statMock.mockRejectedValue(
			Object.assign(new Error("EACCES: permission denied, stat"), {
				code: "EACCES",
			}),
		);
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
		});
		expect(outcome.status).toBe("not_deletable");
		expect(
			(outcome as { reasons: readonly string[] }).reasons.join(),
		).toContain("Cannot verify whether");
		expect(vi.mocked(git.read).mock.calls.length).toBe(0);
	});

	it("refuses to delete a branch owned by a feature", async () => {
		const git = readerOk();
		const outcome = await deleteWorktreeBranch(git, {
			repoRoot,
			worktreeBase,
			worktreePath: `${worktreeBase}/feat/x`,
			branchRef: "feat/x",
			baseBranch: "main",
			ownedByFeatureId: "f2",
		});
		expect(outcome.status).toBe("not_deletable");
		expect(
			(outcome as { reasons: readonly string[] }).reasons.join(),
		).toContain("belongs to Feature f2");
		expect(vi.mocked(git.read).mock.calls.length).toBe(0);
	});
});
