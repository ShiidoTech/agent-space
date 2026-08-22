import { stat, readFile } from "node:fs/promises";
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
 * Fail-closed filesystem presence check: only ENOENT/ENOTDIR prove that a
 * path is absent. Any other error (EACCES, EPERM, EIO, …) leaves the
 * existence unverifiable instead of assuming the worktree is already gone.
 */
type PathPresence =
	| { readonly present: true }
	| { readonly present: false; readonly confirmedAbsent: true }
	| {
			readonly present: false;
			readonly confirmedAbsent: false;
			readonly reason: string;
	  };

async function checkPathPresence(worktreePath: string): Promise<PathPresence> {
	try {
		await stat(worktreePath);
		return { present: true };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { present: false, confirmedAbsent: true };
		}
		return {
			present: false,
			confirmedAbsent: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

interface WorktreeListEntry {
	path: string;
	/** Full ref (`refs/heads/<name>`); absent when the worktree is detached. */
	branch?: string;
}

/** Parse `git worktree list --porcelain` output. */
function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
	const entries: WorktreeListEntry[] = [];
	let current: WorktreeListEntry | undefined;
	for (const rawLine of porcelain.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length) };
			entries.push(current);
		} else if (line.startsWith("branch ") && current) {
			current.branch = line.slice("branch ".length);
		}
	}
	return entries;
}

type WorktreeBranchPairing =
	| { readonly status: "matched" }
	| { readonly status: "mismatch"; readonly actual?: string }
	| { readonly status: "unverifiable" };

/**
 * Prove with authoritative Git evidence that `worktreePath` really has
 * `branchRef` checked out, so a request can never pair worktree A with
 * branch B just because both pass their checks independently.
 */
async function verifyWorktreeBranchPairing(
	git: GitReader,
	repoRoot: string,
	worktreePath: string,
	branchRef: string,
): Promise<WorktreeBranchPairing> {
	const list = await git.read(["worktree", "list", "--porcelain"], {
		cwd: repoRoot,
	});
	if (list.exitCode !== 0 || list.error) return { status: "unverifiable" };
	const expected = `refs/heads/${branchRef}`;
	const wanted = path.resolve(worktreePath);
	for (const entry of parseWorktreeList(list.stdout)) {
		if (path.resolve(entry.path) !== wanted) continue;
		if (entry.branch === expected) return { status: "matched" };
		return {
			status: "mismatch",
			actual: entry.branch?.replace(/^refs\/heads\//, ""),
		};
	}
	return { status: "mismatch" };
}

type BranchCheckoutProbe =
	| { readonly status: "ok"; readonly worktreePath?: string }
	| { readonly status: "unverifiable" };

/**
 * Find a worktree other than `repoPath` that has `branch` checked out.
 * Moving a checked-out branch under another worktree's feet corrupts it,
 * so callers must refuse while such a checkout exists.
 */
async function probeBranchCheckedOutElsewhere(
	git: GitReader,
	repoPath: string,
	branch: string,
): Promise<BranchCheckoutProbe> {
	const list = await git.read(["worktree", "list", "--porcelain"], {
		cwd: repoPath,
	});
	if (list.exitCode !== 0 || list.error) return { status: "unverifiable" };
	const branchRef = `refs/heads/${branch}`;
	const repoResolved = path.resolve(repoPath);
	for (const entry of parseWorktreeList(list.stdout)) {
		if (entry.branch !== branchRef) continue;
		if (path.resolve(entry.path) !== repoResolved) {
			return { status: "ok", worktreePath: entry.path };
		}
	}
	return { status: "ok" };
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

	// Moving a branch that another worktree has checked out corrupts that
	// worktree; refuse while such a checkout exists.
	const checkout = await probeBranchCheckedOutElsewhere(git, repoPath, branch);
	if (checkout.status === "unverifiable") {
		return {
			status: "error",
			message: `Cannot verify that ${branch} is not checked out in another worktree; git worktree list failed.`,
		};
	}
	if (checkout.worktreePath) {
		return {
			status: "error",
			message: `Branch ${branch} is checked out in worktree ${checkout.worktreePath}; update it from there or switch that worktree to another branch first.`,
		};
	}

	// Atomic ref move: the old SHA is part of the update-ref arguments, so a
	// concurrent move of the branch since `local` was resolved fails the call
	// instead of silently writing under another writer's feet.
	const updated = await git.read(
		["update-ref", `refs/heads/${branch}`, "FETCH_HEAD", local.stdout.trim()],
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
	/**
	 * Feature owning this ref (primary branch, active branch or branch link).
	 * Feature-owned branches are never deletable from the worktree list even
	 * when the button was hidden: the command revalidates the link itself.
	 */
	readonly ownedByFeatureId?: string;
}

export interface WorktreeBranchDeletionAssessment {
	readonly deletable: boolean;
	readonly reasons: readonly string[];
	/**
	 * Present when the worktree lives outside Agent Space's managed base. The
	 * branch may still be deletable, but the caller must reinforce the human
	 * confirmation (foreign tool ownership + activity recency evidence).
	 */
	readonly foreign?: {
		/** Dated evidence of the last observable activity, when any was found. */
		readonly lastActivity?: ForeignWorktreeActivity;
	};
}

/** Dated evidence of the last observable activity in a foreign worktree. */
export interface ForeignWorktreeActivity {
	/** ISO timestamp of the most recent observed activity. */
	readonly observedAt: string;
	/** Age in milliseconds at assessment time. */
	readonly ageMs: number;
	/** Human-readable provenance, e.g. "git index" or "last commit". */
	readonly source: string;
}

/**
 * Read-only assessment of whether a worktree branch can be deleted. Nothing is
 * modified; callers confirm with the human before calling `deleteWorktreeBranch`.
 */
export async function assessWorktreeBranchDeletion(
	input: DeleteWorktreeBranchInput,
	git: GitReader,
): Promise<WorktreeBranchDeletionAssessment> {
	const { repoRoot, worktreeBase, worktreePath, branchRef, baseBranch } = input;

	if (input.ownedByFeatureId) {
		return {
			deletable: false,
			reasons: [
				`Branch ${branchRef} belongs to Feature ${input.ownedByFeatureId} and cannot be deleted while the Feature record exists.`,
			],
		};
	}
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
	const presence = await checkPathPresence(worktreePath);
	if (!presence.present) {
		if (presence.confirmedAbsent) {
			// Nothing exists at the path, so even outside the managed base there
			// is no live directory to protect — only possibly a stale Git
			// registration ("prunable"). Integration checks alone decide.
			if (baseBranch) {
				// The worktree is already gone (pruned residue): only the branch
				// ref remains, and it must still be fully integrated.
				const retention = await checkBranchRetentionSafety({
					repoRoot,
					branch: branchRef,
					baseBranch,
				});
				return { deletable: retention.safe, reasons: retention.reasons };
			}
			return {
				deletable: false,
				reasons: [
					"The base branch is unknown; integration cannot be verified.",
				],
			};
		}
		return {
			deletable: false,
			reasons: [
				`Cannot verify whether ${worktreePath} still exists (${presence.reason}). Refusing to delete a possibly-live worktree.`,
			],
		};
	}
	// A live worktree outside the managed base (typically created by another
	// tool such as Claude Code) is no longer refused outright: content safety
	// evidence (clean tree, full integration) stays mandatory, and the caller
	// must reinforce the human confirmation using the attached activity data.
	const foreign = !isWorktreePathSafe(worktreePath, worktreeBase);

	// Authoritative pairing: the worktree at worktreePath must actually have
	// branchRef checked out. Guards against pairing worktree A + branch B.
	const pairing = await verifyWorktreeBranchPairing(
		git,
		repoRoot,
		worktreePath,
		branchRef,
	);
	if (pairing.status === "unverifiable") {
		return {
			deletable: false,
			reasons: [
				`Cannot verify the branch checked out in ${worktreePath}; git worktree list failed.`,
			],
		};
	}
	if (pairing.status === "mismatch") {
		return {
			deletable: false,
			reasons: [
				`Worktree ${worktreePath} does not have branch ${branchRef} checked out (observed: ${pairing.actual ?? "detached"}). Refusing to delete an unrelated branch.`,
			],
		};
	}

	const safety = await checkWorktreeDeletionSafety({
		repoRoot,
		worktreeBase,
		worktreePath,
		branch: branchRef,
		baseBranch,
		...(foreign ? { allowOutsideBase: true } : {}),
	});
	if (foreign && safety.safe) {
		const lastActivity = await observeForeignLastActivity(
			git,
			repoRoot,
			worktreePath,
			branchRef,
		);
		return {
			deletable: true,
			reasons: safety.reasons,
			foreign: { ...(lastActivity ? { lastActivity } : {}) },
		};
	}
	return { deletable: safety.safe, reasons: safety.reasons };
}

/**
 * Best-effort dating of the last observable activity inside a foreign
 * worktree, so the human can judge whether a session may still be running.
 * Unknown evidence simply yields `undefined` — it never blocks the flow.
 */
async function observeForeignLastActivity(
	git: GitReader,
	repoRoot: string,
	worktreePath: string,
	branchRef: string,
): Promise<ForeignWorktreeActivity | undefined> {
	const candidates: Array<{ atMs: number; source: string }> = [];
	try {
		const dotGit = await readFile(path.join(worktreePath, ".git"), "utf8");
		const match = /^gitdir:\s*(.+)$/mu.exec(dotGit);
		if (match) {
			const gitdir = path.resolve(worktreePath, match[1].trim());
			const info = await stat(path.join(gitdir, "index"));
			candidates.push({ atMs: info.mtimeMs, source: "git index" });
		}
	} catch {
		// No gitdir pointer or unreadable index: commit date may still apply.
	}
	try {
		const committed = await git.read(
			["log", "-1", "--format=%ct", branchRef],
			{ cwd: repoRoot },
		);
		if (committed.exitCode === 0 && !committed.error) {
			const seconds = Number.parseInt(committed.stdout.trim(), 10);
			if (Number.isSafeInteger(seconds) && seconds > 0) {
				candidates.push({ atMs: seconds * 1000, source: "last commit" });
			}
		}
	} catch {
		// Unreadable commit date is tolerated.
	}
	if (candidates.length === 0) return undefined;
	const newest = candidates.reduce((a, b) => (b.atMs > a.atMs ? b : a));
	return {
		observedAt: new Date(newest.atMs).toISOString(),
		ageMs: Math.max(0, Date.now() - newest.atMs),
		source: newest.source,
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
	const assessment = await assessWorktreeBranchDeletion(input, git);
	if (!assessment.deletable) {
		return { status: "not_deletable", reasons: assessment.reasons };
	}

	const { repoRoot, worktreePath, branchRef } = input;
	const presence = await checkPathPresence(worktreePath);
	if (!presence.present && !presence.confirmedAbsent) {
		return {
			status: "error",
			message: `Cannot verify whether ${worktreePath} still exists (${presence.reason}).`,
		};
	}

	// Runs even when the path is confirmed absent: `git worktree remove`
	// clears the stale registration left by a manually deleted directory, so
	// the branch deletion below cannot fail with "checked out at".
	const removal = await git.read(["worktree", "remove", worktreePath], {
		cwd: repoRoot,
	});
	if (removal.exitCode !== 0 || removal.error) {
		return {
			status: "error",
			message: `git worktree remove failed: ${gitError(removal, "git worktree remove failed.")}`,
		};
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
