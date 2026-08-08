import { execSync } from "node:child_process";
import type { GitAwareStatus } from "../types";

export interface GitStatusInput {
	featureBranch: string;
	baseBranch: string;
	worktreePath: string;
	repoRoot: string;
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
			`git reflog show --reverse --format=%H "${featureBranch}"`,
			repoRoot,
		)
			.split(/\r?\n/)
			.filter(Boolean);
		if (reflog.length === 0) return null;
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
			const moved = branchMovedSinceCreation(featureBranch, repoRoot);
			if (moved !== false) {
				// If git() didn't throw, feature is ancestor of base. Treat it as
				// merged unless reflog proves the branch never moved from creation.
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
	const { featureBranch, baseBranch, worktreePath, repoRoot } = input;

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
				await gitCmd(
					`git reflog show --reverse --format=%H "${featureBranch}"`,
					repoRoot,
				)
			)
				.split(/\r?\n/)
				.filter(Boolean);
			if (reflog.length === 0) return null;
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
			const moved = await branchMovedSinceCreationAsync();
			if (moved !== false) {
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
