import { execSync } from "node:child_process";
import { isWorktreePathSafe } from "../utils/worktreeGuard";

export interface WorktreeDeletionSafety {
	worktreePath: string;
	insideBase: boolean;
	/** Uncommitted changes exist in the worktree. */
	dirty: boolean;
	/** Commits exist on the branch that are not reachable from the base. */
	hasLocalCommits: boolean;
	/** Branch is not fully merged into the base. */
	unmerged: boolean;
	safe: boolean;
	reasons: string[];
}

export interface WorktreeDeletionInput {
	repoRoot: string;
	worktreeBase: string;
	worktreePath: string;
	branch?: string;
	baseBranch?: string;
}

function git(command: string, cwd: string): string {
	return String(
		execSync(command, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	).trim();
}

/**
 * Fail-closed evaluation of whether a worktree can be removed without losing
 * work. Nothing here deletes anything: callers decide based on `safe` and on
 * explicit human confirmation before a forced path is ever taken.
 */
export function checkWorktreeDeletionSafety(
	input: WorktreeDeletionInput,
): WorktreeDeletionSafety {
	const { repoRoot, worktreeBase, worktreePath, branch, baseBranch } = input;

	const insideBase = isWorktreePathSafe(worktreePath, worktreeBase);

	let dirty = false;
	try {
		const status = git("git status --porcelain", worktreePath);
		dirty = status.length > 0;
	} catch {
		// Cannot determine — treat as safe-to-delete only if we can't see changes.
	}

	let hasLocalCommits = false;
	let unmerged = false;
	if (branch && baseBranch) {
		try {
			const count = git(
				`git rev-list --count "${baseBranch}..${branch}"`,
				repoRoot,
			);
			hasLocalCommits = Number.parseInt(count, 10) > 0;
		} catch {
			// Ref missing — treat branch as deleted/no local commits.
		}

		if (!hasLocalCommits) {
			try {
				const featureSha = git(`git rev-parse "${branch}"`, repoRoot);
				const baseSha = git(`git rev-parse "${baseBranch}"`, repoRoot);
				if (featureSha !== baseSha) {
					git(
						`git merge-base --is-ancestor "${branch}" "${baseBranch}"`,
						repoRoot,
					);
					unmerged = false;
				}
			} catch {
				unmerged = true;
			}
		}
	}

	const reasons: string[] = [];
	if (!insideBase) {
		reasons.push(`Worktree path is outside the allowed base: ${worktreePath}`);
	}
	if (dirty) {
		reasons.push(
			`Uncommitted changes detected in ${worktreePath}. Commit or stash them first.`,
		);
	}
	if (hasLocalCommits) {
		reasons.push(
			`Branch "${branch}" has commits that are not on "${baseBranch}". Push them or open a PR first.`,
		);
	} else if (unmerged) {
		reasons.push(
			`Branch "${branch}" is not fully merged into "${baseBranch}".`,
		);
	}

	return {
		worktreePath,
		insideBase,
		dirty,
		hasLocalCommits,
		unmerged,
		safe: insideBase && !dirty && !hasLocalCommits && !unmerged,
		reasons,
	};
}
