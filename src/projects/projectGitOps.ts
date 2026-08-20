import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { GitReader } from "../git/gitClient";
import {
	checkBranchRetentionSafety,
	checkWorktreeDeletionSafety,
} from "../git/worktreeSafety";
import { isWorktreePathSafe } from "../utils/worktreeGuard";
import type { ProjectReferenceBranchHealth } from "./referenceBranchHealth";

export type BaseBranchUpdateResult =
	| { readonly status: "updated"; readonly method: "fast_forward" | "merge" }
	| { readonly status: "already_current" }
	| { readonly status: "error"; readonly message: string };

export type WorktreeBranchDeleteResult =
	| { readonly status: "deleted"; readonly branch: string }
	| { readonly status: "not_deletable"; readonly reasons: readonly string[] }
	| { readonly status: "error"; readonly message: string };

export interface BaseBranchUpdateOptions {
	/**
	 * Called only when a plain fast-forward is impossible because the local
	 * branch carries commits absent from the remote (diverged). Returning
	 * `true` authorizes a merge commit; `false` aborts the update.
	 */
	confirmMerge?: () => Promise<boolean>;
}

function gitError(
	result: { readonly stderr: string; readonly error?: Error },
	fallback: string,
): string {
	return result.stderr.trim() || result.error?.message || fallback;
}

/**
 * Update the project's reference ("main working") branch from its verified
 * remote: `git fetch`, then fast-forward the local branch when possible.
 * A diverged local branch is only merged after explicit human confirmation.
 */
export async function updateBaseBranch(
	git: GitReader,
	repoPath: string,
	health: ProjectReferenceBranchHealth,
	options: BaseBranchUpdateOptions = {},
): Promise<BaseBranchUpdateResult> {
	const { branch, remoteName } = health;
	if (health.verifiedRemote.status !== "known") {
		return {
			status: "error",
			message: `The remote head of ${remoteName}/${branch} could not be verified; refresh the project first.`,
		};
	}
	if (health.verifiedRemoteRelation.state === "current") {
		return { status: "already_current" };
	}

	const fetch = await git.read(["fetch", remoteName, branch], {
		cwd: repoPath,
		timeoutMs: 60_000,
	});
	if (fetch.exitCode !== 0 || fetch.error) {
		return {
			status: "error",
			message: `git fetch failed: ${gitError(fetch, "git fetch failed.")}`,
		};
	}

	const status = await git.read(["status", "--porcelain"], { cwd: repoPath });
	if (status.exitCode !== 0 || status.error) {
		return {
			status: "error",
			message: `Cannot verify a clean working tree: ${gitError(status, "git status failed.")}`,
		};
	}
	if (status.stdout.trim().length > 0) {
		return {
			status: "error",
			message: `The working tree in ${repoPath} has uncommitted changes; commit or stash them before updating ${branch}.`,
		};
	}

	const head = await git.read(["symbolic-ref", "--short", "HEAD"], {
		cwd: repoPath,
	});
	if (head.exitCode === 0 && head.stdout.trim() === branch) {
		const fastForward = await git.read(["merge", "--ff-only", "FETCH_HEAD"], {
			cwd: repoPath,
		});
		if (fastForward.exitCode === 0 && !fastForward.error) {
			return { status: "updated", method: "fast_forward" };
		}
		const confirmed = options.confirmMerge
			? await options.confirmMerge()
			: false;
		if (!confirmed) {
			return {
				status: "error",
				message: `Local branch ${branch} has commits not present in ${remoteName}/${branch}; the update was cancelled.`,
			};
		}
		const merged = await git.read(["merge", "FETCH_HEAD", "--no-edit"], {
			cwd: repoPath,
		});
		if (merged.exitCode !== 0 || merged.error) {
			return {
				status: "error",
				message: `git merge failed: ${gitError(merged, "git merge failed.")}`,
			};
		}
		return { status: "updated", method: "merge" };
	}

	// HEAD is on another branch: move the local ref only when the remote
	// head is a descendant (pure fast-forward), never backwards or sideways.
	const local = await git.read(
		["rev-parse", "--verify", `${branch}^{commit}`],
		{ cwd: repoPath },
	);
	const fetched = await git.read(
		["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
		{ cwd: repoPath },
	);
	if (local.exitCode !== 0 || fetched.exitCode !== 0) {
		return {
			status: "error",
			message: `Could not resolve the refs of ${branch} after fetching.`,
		};
	}
	const ancestor = await git.read(
		["merge-base", "--is-ancestor", local.stdout.trim(), fetched.stdout.trim()],
		{ cwd: repoPath },
	);
	if (ancestor.exitCode !== 0) {
		return {
			status: "error",
			message: `Local branch ${branch} has commits absent from ${remoteName}/${branch}; check it out and merge manually.`,
		};
	}
	const updated = await git.read(
		["update-ref", `refs/heads/${branch}`, "FETCH_HEAD"],
		{ cwd: repoPath },
	);
	if (updated.exitCode !== 0 || updated.error) {
		return {
			status: "error",
			message: `git update-ref failed: ${gitError(updated, "git update-ref failed.")}`,
		};
	}
	return { status: "updated", method: "fast_forward" };
}

export interface DeleteWorktreeBranchInput {
	readonly repoRoot: string;
	readonly worktreeBase: string;
	readonly worktreePath: string;
	readonly branchRef: string;
	readonly baseBranch?: string;
}

export interface WorktreeBranchDeletionAssessment {
	readonly deletable: boolean;
	readonly reasons: readonly string[];
}

/**
 * Read-only assessment of whether a worktree branch can be deleted. Nothing is
 * modified; callers confirm with the human before calling `deleteWorktreeBranch`.
 */
export async function assessWorktreeBranchDeletion(
	input: DeleteWorktreeBranchInput,
): Promise<WorktreeBranchDeletionAssessment> {
	const { repoRoot, worktreeBase, worktreePath, branchRef, baseBranch } = input;

	if (baseBranch && branchRef === baseBranch) {
		return {
			deletable: false,
			reasons: [
				`Branch ${branchRef} is the project's base branch and cannot be deleted.`,
			],
		};
	}
	if (path.resolve(worktreePath) === path.resolve(repoRoot)) {
		return {
			deletable: false,
			reasons: ["The main working tree cannot be removed as a worktree."],
		};
	}
	if (!isWorktreePathSafe(worktreePath, worktreeBase)) {
		return {
			deletable: false,
			reasons: [`Refusing to remove worktree outside base: ${worktreePath}`],
		};
	}

	const worktreeExists = await pathExists(worktreePath);
	if (worktreeExists) {
		const safety = await checkWorktreeDeletionSafety({
			repoRoot,
			worktreeBase,
			worktreePath,
			branch: branchRef,
			baseBranch,
		});
		return { deletable: safety.safe, reasons: safety.reasons };
	}
	if (baseBranch) {
		// The worktree is already gone (pruned residue): only the branch ref
		// remains, and it must still be fully integrated before deletion.
		const retention = await checkBranchRetentionSafety({
			repoRoot,
			branch: branchRef,
			baseBranch,
		});
		return { deletable: retention.safe, reasons: retention.reasons };
	}
	return {
		deletable: false,
		reasons: ["The base branch is unknown; integration cannot be verified."],
	};
}

/**
 * Remove a finished worktree branch: `git worktree remove` then `git branch -d`.
 * Only fully integrated, clean branches are deletable; anything else is
 * reported with its safety reasons so the human can decide manually.
 */
export async function deleteWorktreeBranch(
	git: GitReader,
	input: DeleteWorktreeBranchInput,
): Promise<WorktreeBranchDeleteResult> {
	const assessment = await assessWorktreeBranchDeletion(input);
	if (!assessment.deletable) {
		return { status: "not_deletable", reasons: assessment.reasons };
	}

	const { repoRoot, worktreePath, branchRef } = input;
	const worktreeExists = await pathExists(worktreePath);
	if (worktreeExists) {
		const removal = await git.read(["worktree", "remove", worktreePath], {
			cwd: repoRoot,
		});
		if (removal.exitCode !== 0 || removal.error) {
			return {
				status: "error",
				message: `git worktree remove failed: ${gitError(removal, "git worktree remove failed.")}`,
			};
		}
	}

	const deletion = await git.read(["branch", "-d", branchRef], {
		cwd: repoRoot,
	});
	if (deletion.exitCode !== 0 || deletion.error) {
		return {
			status: "error",
			message: `git branch -d failed: ${gitError(deletion, "git branch -d failed.")}`,
		};
	}
	return { status: "deleted", branch: branchRef };
}

async function pathExists(worktreePath: string): Promise<boolean> {
	try {
		await stat(worktreePath);
		return true;
	} catch {
		return false;
	}
}
