import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isWorktreePathSafe } from "../utils/worktreeGuard";

export interface WorktreeDeletionSafety {
	worktreePath: string;
	insideBase: boolean;
	/** Whether `git status` was successfully observed in the worktree. */
	statusObserved: boolean;
	/** Whether both the feature and base refs were successfully resolved. */
	refsObserved: boolean;
	/** Whether Git successfully established the ancestry relationship. */
	integrationObserved: boolean;
	/** Whether Git successfully counted commits missing from the base. */
	localCommitsObserved: boolean;
	/** Exact observed refs used by the assessment fingerprint. */
	featureSha?: string;
	baseSha?: string;
	/** Porcelain output kept so a changed working tree invalidates confirmation. */
	workingTreeStatus?: string;
	/** Uncommitted changes exist in the worktree. */
	dirty: boolean;
	/** Commits exist on the branch that are not reachable from the base. */
	hasLocalCommits: boolean;
	localCommitCount?: number;
	/** Branch is not fully merged into the base. */
	unmerged: boolean;
	/** True only when every safety dimension was observed and the path is scoped. */
	forceable: boolean;
	safe: boolean;
	reasons: string[];
}

export interface WorktreeDeletionInput {
	repoRoot: string;
	worktreeBase: string;
	worktreePath: string;
	branch?: string;
	baseBranch?: string;
	/**
	 * Allow a caller that has already proven this exact path/branch pairing
	 * through `git worktree list` to clean up a legacy worktree outside the
	 * configured Agent Space base directory.
	 */
	allowRegisteredOutsideBase?: boolean;
}

export interface BranchRetentionSafety {
	readonly branch?: string;
	readonly baseBranch?: string;
	readonly refsObserved: boolean;
	readonly integrationObserved: boolean;
	readonly localCommitsObserved: boolean;
	readonly featureSha?: string;
	readonly baseSha?: string;
	readonly hasLocalCommits: boolean;
	readonly localCommitCount?: number;
	readonly unmerged: boolean;
	readonly forceable: boolean;
	readonly safe: boolean;
	readonly reasons: readonly string[];
}

const execFileAsync = promisify(execFile);

async function git(argv: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", argv, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	return stdout.trim();
}

function isExpectedNotAncestorError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		((error as { status?: unknown }).status === 1 ||
			(error as { code?: unknown }).code === 1)
	);
}

function isFullCommitSha(value: string): boolean {
	return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

/**
 * Evaluate the Git work that remains after a worktree is already absent.
 * Agent Space preserves branches, but it must still surface unique commits
 * before forgetting the human-facing Feature/Agent record.
 */
export async function checkBranchRetentionSafety(input: {
	repoRoot: string;
	branch?: string;
	baseBranch?: string;
}): Promise<BranchRetentionSafety> {
	const { repoRoot, branch, baseBranch } = input;
	let refsObserved = false;
	let integrationObserved = false;
	let localCommitsObserved = false;
	let featureSha: string | undefined;
	let baseSha: string | undefined;
	let unmerged = false;
	let hasLocalCommits = false;
	let localCommitCount: number | undefined;

	if (branch && baseBranch) {
		try {
			featureSha = await git(
				["rev-parse", "--verify", `${branch}^{commit}`],
				repoRoot,
			);
			baseSha = await git(
				["rev-parse", "--verify", `${baseBranch}^{commit}`],
				repoRoot,
			);
			refsObserved = isFullCommitSha(featureSha) && isFullCommitSha(baseSha);
		} catch {
			// Missing or unreadable refs remain unknown.
		}
	}

	if (refsObserved && featureSha && baseSha) {
		try {
			await git(
				["merge-base", "--is-ancestor", featureSha, baseSha],
				repoRoot,
			);
			integrationObserved = true;
			unmerged = false;
		} catch (error) {
			if (isExpectedNotAncestorError(error)) {
				integrationObserved = true;
				unmerged = true;
			}
		}
		try {
			const count = Number.parseInt(
				await git(
					["rev-list", "--count", `${baseSha}..${featureSha}`],
					repoRoot,
				),
				10,
			);
			if (Number.isSafeInteger(count) && count >= 0) {
				localCommitsObserved = true;
				localCommitCount = count;
				hasLocalCommits = count > 0;
			}
		} catch {
			// Unknown count blocks nominal and forced record cleanup.
		}
	}

	const reasons: string[] = [];
	if (!branch || !baseBranch)
		reasons.push("Branch comparison refs are unknown.");
	else if (!refsObserved)
		reasons.push(`Could not resolve branch ${branch} and base ${baseBranch}.`);
	if (refsObserved && !integrationObserved)
		reasons.push("Could not verify whether the branch is integrated.");
	if (refsObserved && !localCommitsObserved)
		reasons.push("Could not count commits unique to the branch.");
	if (hasLocalCommits)
		reasons.push(
			`Branch ${branch} has ${localCommitCount} commit(s) not in ${baseBranch}. The Git branch will be preserved.`,
		);
	if (unmerged)
		reasons.push(
			`Branch ${branch} is not fully integrated into ${baseBranch}. The Git branch will be preserved.`,
		);

	const forceable = refsObserved && integrationObserved && localCommitsObserved;
	return {
		branch,
		baseBranch,
		refsObserved,
		integrationObserved,
		localCommitsObserved,
		featureSha,
		baseSha,
		hasLocalCommits,
		localCommitCount,
		unmerged,
		forceable,
		safe: forceable && !hasLocalCommits && !unmerged,
		reasons,
	};
}

/**
 * Fail-closed evaluation of whether a worktree can be removed without losing
 * work. Nothing here deletes anything: callers decide based on `safe` and on
 * explicit human confirmation before a forced path is ever taken.
 */
export async function checkWorktreeDeletionSafety(
	input: WorktreeDeletionInput,
): Promise<WorktreeDeletionSafety> {
	const {
		repoRoot,
		worktreeBase,
		worktreePath,
		branch,
		baseBranch,
		allowRegisteredOutsideBase = false,
	} = input;

	const insideBase = isWorktreePathSafe(worktreePath, worktreeBase);
	const pathScoped = insideBase || allowRegisteredOutsideBase;

	let statusObserved = false;
	let dirty = false;
	let workingTreeStatus: string | undefined;
	try {
		const status = await git(["status", "--porcelain"], worktreePath);
		statusObserved = true;
		workingTreeStatus = status;
		dirty = status.length > 0;
	} catch {
		// Unknown is not clean: the reason below blocks deletion.
	}

	let refsObserved = false;
	let integrationObserved = false;
	let localCommitsObserved = false;
	let hasLocalCommits = false;
	let localCommitCount: number | undefined;
	let unmerged = false;
	let featureSha: string | undefined;
	let baseSha: string | undefined;
	if (branch && baseBranch) {
		try {
			featureSha = await git(
				["rev-parse", "--verify", `${branch}^{commit}`],
				repoRoot,
			);
			baseSha = await git(
				["rev-parse", "--verify", `${baseBranch}^{commit}`],
				repoRoot,
			);
			refsObserved = isFullCommitSha(featureSha) && isFullCommitSha(baseSha);
		} catch {
			// A missing or unreadable ref leaves integration unknown.
		}

		if (refsObserved) {
			try {
				await git(
					["merge-base", "--is-ancestor", featureSha!, baseSha!],
					repoRoot,
				);
				integrationObserved = true;
			} catch (error) {
				if (isExpectedNotAncestorError(error)) {
					integrationObserved = true;
					unmerged = true;
				}
			}
		}

		if (refsObserved) {
			try {
				const count = await git(
					["rev-list", "--count", `${baseSha}..${featureSha}`],
					repoRoot,
				);
				if (/^\d+$/.test(count)) {
					localCommitsObserved = true;
					localCommitCount = Number.parseInt(count, 10);
					hasLocalCommits = localCommitCount > 0;
				}
			} catch {
				// Unknown is not zero local commits: the reason below blocks deletion.
			}
		}
	}

	const reasons: string[] = [];
	if (!pathScoped) {
		reasons.push(`Worktree path is outside the allowed base: ${worktreePath}`);
	}
	if (!statusObserved) {
		reasons.push(
			`Cannot verify whether ${worktreePath} has uncommitted changes because git status failed.`,
		);
	}
	if (dirty) {
		reasons.push(
			`Uncommitted changes detected in ${worktreePath}:\n${workingTreeStatus ?? "(file list unavailable)"}\nCommit or stash them first.`,
		);
	}
	if (!branch) {
		reasons.push(
			"Cannot verify branch integration because the feature branch is unknown.",
		);
	} else if (!baseBranch) {
		reasons.push(
			`Cannot verify whether branch "${branch}" is integrated because the base branch is unknown.`,
		);
	} else if (!refsObserved) {
		reasons.push(
			`Cannot verify integration because branch "${branch}" or base "${baseBranch}" could not be resolved.`,
		);
	} else {
		if (!integrationObserved) {
			reasons.push(
				`Cannot verify whether branch "${branch}" is fully integrated into "${baseBranch}" because Git ancestry inspection failed.`,
			);
		}
		if (!localCommitsObserved) {
			reasons.push(
				`Cannot verify whether branch "${branch}" has commits missing from "${baseBranch}" because Git commit inspection failed.`,
			);
		} else if (hasLocalCommits) {
			reasons.push(
				`Branch "${branch}" has ${localCommitCount} commit${localCommitCount === 1 ? "" : "s"} that are not on "${baseBranch}". Push them or open a PR first.`,
			);
		} else if (integrationObserved && unmerged) {
			reasons.push(
				`Branch "${branch}" is not fully merged into "${baseBranch}".`,
			);
		}
	}

	return {
		worktreePath,
		insideBase,
		statusObserved,
		refsObserved,
		integrationObserved,
		localCommitsObserved,
		...(refsObserved && featureSha && baseSha ? { featureSha, baseSha } : {}),
		...(workingTreeStatus !== undefined ? { workingTreeStatus } : {}),
		dirty,
		hasLocalCommits,
		...(localCommitCount !== undefined ? { localCommitCount } : {}),
		unmerged,
		forceable:
			pathScoped &&
			statusObserved &&
			refsObserved &&
			integrationObserved &&
			localCommitsObserved,
		safe:
			pathScoped &&
			statusObserved &&
			refsObserved &&
			integrationObserved &&
			localCommitsObserved &&
			!dirty &&
			!hasLocalCommits &&
			!unmerged,
		reasons,
	};
}
