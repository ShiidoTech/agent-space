import { execSync } from "node:child_process";
import type { GitAwareStatus } from "../types";

export interface GitStatusInput {
	featureBranch: string;
	baseBranch: string;
	worktreePath: string;
	repoRoot: string;
	createdFromSha?: string;
}

function git(command: string, cwd: string): string {
	return execSync(command, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function branchMovedSinceCreation(
	featureBranch: string,
	repoRoot: string,
): boolean | null {
	try {
		const reflog = git(
			`git reflog show --format=%H "${featureBranch}"`,
			repoRoot,
		)
			.split(/\r?\n/)
			.filter(Boolean);
		// A single entry is not enough to distinguish a new branch from a
		// reflog whose older entries have expired.
		if (reflog.length < 2) return null;
		return reflog[0] !== reflog[reflog.length - 1];
	} catch {
		// Reflog may be disabled or unavailable. Preserve the previous merged
		// heuristic rather than inventing a status from missing history.
		return null;
	}
}

// -- TTL cache for computeGitStatus -----------------------------------------
const GIT_STATUS_TTL_MS = 10_000;

interface CachedGitStatus {
	result: GitAwareStatus;
	timestamp: number;
}

const gitStatusCache = new Map<string, CachedGitStatus>();

function cacheKey(input: GitStatusInput): string {
	return `${input.featureBranch}:${input.baseBranch}:${input.worktreePath}`;
}

export function invalidateGitStatusCache(featureBranch?: string): void {
	if (featureBranch) {
		for (const key of gitStatusCache.keys()) {
			if (key.startsWith(`${featureBranch}:`)) {
				gitStatusCache.delete(key);
			}
		}
	} else {
		gitStatusCache.clear();
	}
}

export function gitStatusLabel(status: GitAwareStatus): string {
	switch (status) {
		case "new":
			return "New";
		case "modified":
			return "Modified";
		case "ahead":
			return "Ahead";
		case "merged":
			return "Merged";
		default:
			return status;
	}
}

// -- Base branch git state (the comparison branch for all features) --------

export interface BaseBranchGitState {
	branch: string;
	dirty: boolean;
	/** Commits ahead of the tracked remote (0 when no remote tracking). */
	ahead: number;
	/** Commits behind the tracked remote (0 when no remote tracking). */
	behind: number;
	/** Last commit short sha + subject, e.g. "abc1234 fix: x". */
	lastCommit: string;
	hasRemote: boolean;
}

const GIT_STATE_TTL_MS = 10_000;
const baseStateCache = new Map<
	string,
	{ result: BaseBranchGitState; timestamp: number }
>();

function gitQuiet(command: string, cwd: string): string | null {
	try {
		return execSync(command, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.trim()
			.split(/\r?\n/)[0];
	} catch {
		return null;
	}
}

/**
 * Git state of the project's base branch — the branch every feature is
 * compared against. Fail-closed: every field degrades to a safe default
 * (dirty=false, ahead=0, behind=0) rather than throwing.
 */
export function computeBaseBranchGitState(
	repoRoot: string,
	branch: string,
): BaseBranchGitState {
	const key = `${repoRoot}:${branch}`;
	const cached = baseStateCache.get(key);
	if (cached && Date.now() - cached.timestamp < GIT_STATE_TTL_MS) {
		return cached.result;
	}

	const dirty = (gitQuiet("git status --porcelain", repoRoot) ?? "").length > 0;

	// origin/<branch> may not exist yet; both counts degrade to 0.
	const counts =
		gitQuiet(
			`git rev-list --left-right --count "origin/${branch}"...${branch}`,
			repoRoot,
		) ?? "";
	const [behindRaw, aheadRaw] = counts.split(/\s+/);
	const behind = Number.parseInt(behindRaw ?? "0", 10);
	const ahead = Number.parseInt(aheadRaw ?? "0", 10);
	const hasRemote =
		gitQuiet(
			`git rev-parse --verify --quiet "refs/remotes/origin/${branch}"`,
			repoRoot,
		) !== null;

	const lastCommit =
		gitQuiet(`git log -1 --format=%h%x20%s "${branch}"`, repoRoot) ?? "";

	const result: BaseBranchGitState = {
		branch,
		dirty,
		ahead: Number.isFinite(ahead) ? ahead : 0,
		behind: Number.isFinite(behind) ? behind : 0,
		lastCommit,
		hasRemote,
	};
	baseStateCache.set(key, { result, timestamp: Date.now() });
	return result;
}

export function invalidateBaseBranchGitState(repoRoot?: string): void {
	if (repoRoot) {
		for (const key of baseStateCache.keys()) {
			if (key.startsWith(`${repoRoot}:`)) {
				baseStateCache.delete(key);
			}
		}
	} else {
		baseStateCache.clear();
	}
}

export function computeGitStatus(input: GitStatusInput): GitAwareStatus {
	const key = cacheKey(input);
	const cached = gitStatusCache.get(key);
	if (cached && Date.now() - cached.timestamp < GIT_STATUS_TTL_MS) {
		return cached.result;
	}

	const result = computeGitStatusUncached(input);
	gitStatusCache.set(key, { result, timestamp: Date.now() });
	return result;
}

function computeGitStatusUncached(input: GitStatusInput): GitAwareStatus {
	const { featureBranch, baseBranch, worktreePath, repoRoot } = input;

	// Check modified first: uncommitted changes take priority since they
	// represent unsaved work the user needs to act on regardless of branch state
	try {
		const status = git("git status --porcelain", worktreePath);
		if (status.length > 0) {
			return "modified";
		}
	} catch {
		// Can't determine, continue
	}

	// Check merged: feature branch is ancestor of base AND they differ.
	// A never-moved feature branch becomes an ancestor as soon as the base
	// advances, but that is not a merge. The branch reflog lets us distinguish
	// that no-op feature from a branch that actually advanced before integration.
	try {
		const featureSha = git(`git rev-parse "${featureBranch}"`, repoRoot);
		const baseSha = git(`git rev-parse "${baseBranch}"`, repoRoot);
		if (featureSha !== baseSha) {
			git(
				`git merge-base --is-ancestor "${featureBranch}" "${baseBranch}"`,
				repoRoot,
			);
			const moved = input.createdFromSha
				? featureSha !== input.createdFromSha
				: branchMovedSinceCreation(featureBranch, repoRoot);
			if (moved === true) {
				// Only positive evidence that the feature branch moved supports
				// classifying an ancestor branch as merged.
				return "merged";
			}
		}
	} catch {
		// Not merged, continue checking
	}

	// Check ahead: commits on feature not on base
	try {
		const count = git(
			`git rev-list --count "${baseBranch}..${featureBranch}"`,
			repoRoot,
		);
		if (Number.parseInt(count, 10) > 0) {
			return "ahead";
		}
	} catch {
		// Can't determine, continue
	}

	return "new";
}

// -- Async variant -----------------------------------------------------------
export async function computeGitStatusAsync(
	input: GitStatusInput,
): Promise<GitAwareStatus> {
	const key = cacheKey(input);
	const cached = gitStatusCache.get(key);
	if (cached && Date.now() - cached.timestamp < GIT_STATUS_TTL_MS) {
		return cached.result;
	}

	const { execAsync } = await import("../utils/platform");
	const { featureBranch, baseBranch, worktreePath, repoRoot, createdFromSha } =
		input;

	const gitOpts = {
		encoding: "utf-8" as const,
		stdio: ["ignore", "pipe", "pipe"] as const,
	};

	async function gitCmd(command: string, cwd: string): Promise<string> {
		const { stdout } = await execAsync(command, { cwd, ...gitOpts });
		return stdout.trim();
	}

	async function branchMovedSinceCreationAsync(): Promise<boolean | null> {
		try {
			const reflog = (
				await gitCmd(`git reflog show --format=%H "${featureBranch}"`, repoRoot)
			)
				.split(/\r?\n/)
				.filter(Boolean);
			if (reflog.length < 2) return null;
			return reflog[0] !== reflog[reflog.length - 1];
		} catch {
			return null;
		}
	}

	let result: GitAwareStatus = "new";

	// Check modified
	try {
		const status = await gitCmd("git status --porcelain", worktreePath);
		if (status.length > 0) {
			result = "modified";
			gitStatusCache.set(key, { result, timestamp: Date.now() });
			return result;
		}
	} catch {
		// Can't determine, continue
	}

	// Check merged
	try {
		const featureSha = await gitCmd(
			`git rev-parse "${featureBranch}"`,
			repoRoot,
		);
		const baseSha = await gitCmd(`git rev-parse "${baseBranch}"`, repoRoot);
		if (featureSha !== baseSha) {
			await gitCmd(
				`git merge-base --is-ancestor "${featureBranch}" "${baseBranch}"`,
				repoRoot,
			);
			const moved = createdFromSha
				? featureSha !== createdFromSha
				: await branchMovedSinceCreationAsync();
			if (moved === true) {
				result = "merged";
				gitStatusCache.set(key, { result, timestamp: Date.now() });
				return result;
			}
		}
	} catch {
		// Not merged, continue checking
	}

	// Check ahead
	try {
		const count = await gitCmd(
			`git rev-list --count "${baseBranch}..${featureBranch}"`,
			repoRoot,
		);
		if (Number.parseInt(count, 10) > 0) {
			result = "ahead";
		}
	} catch {
		// Can't determine, continue
	}

	gitStatusCache.set(key, { result, timestamp: Date.now() });
	return result;
}
