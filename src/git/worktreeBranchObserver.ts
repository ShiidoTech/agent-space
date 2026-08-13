import type { GitWorktreeObservation } from "./featureGitObservations";
import type { GitReader, GitReadResult } from "./gitClient";
import { defaultGitClient } from "./gitClient";

/**
 * Relation of one worktree branch to the project base branch, computed from
 * local commit-graph evidence only. Never fetched or guessed.
 */
export type WorktreeBranchBaseRelation =
	| { readonly status: "current" }
	| { readonly status: "merged" }
	| { readonly status: "ahead"; readonly commits: number }
	| {
			readonly status: "diverged";
			readonly ahead: number;
			readonly behind: number;
	  }
	| { readonly status: "unknown"; readonly reason: string };

export interface WorktreeBranchState {
	/** Short branch ref (e.g. `agent/restore-feature-cockpit`). */
	readonly ref: string;
	readonly worktreePath: string;
	readonly headSha: string;
	readonly detached: boolean;
	readonly prunable: boolean;
	readonly baseRelation: WorktreeBranchBaseRelation;
	readonly workingTree: { readonly status: "clean" | "dirty" | "unknown" };
	/** Feature whose primary/linked branch equals this ref, when known. */
	readonly linkedFeatureId?: string;
}

export interface WorktreeBranchInventory {
	readonly repoPath: string;
	readonly baseRef?: string;
	readonly status: "known" | "unknown";
	readonly reason?: string;
	readonly branches: readonly WorktreeBranchState[];
	readonly observedAt: string;
}

export interface WorktreeBranchObserverOptions {
	readonly git?: GitReader;
	readonly now?: () => Date;
}

export interface WorktreeBranchObserveRequest {
	readonly repoPath: string;
	readonly worktrees: readonly GitWorktreeObservation[];
	readonly baseRef?: string;
	/** Maps a branch ref to the Feature owning it, for cross-linking. */
	readonly featureBranches?: ReadonlyMap<string, string>;
}

const FULL_SHA = /^[0-9a-f]{40,64}$/iu;

/**
 * Read-only inventory of every branch currently attached to a worktree. The
 * input `worktrees` list is the same porcelain evidence the FeatureGitInspector
 * already produces; this observer turns it into a per-branch state report so
 * branches that are not persisted Features (e.g. agent-created branches) stay
 * visible instead of being invisible residue.
 */
export class WorktreeBranchObserver {
	private readonly git: GitReader;
	private readonly now: () => Date;

	constructor(options: WorktreeBranchObserverOptions = {}) {
		this.git = options.git ?? defaultGitClient;
		this.now = options.now ?? (() => new Date());
	}

	async observe(
		request: WorktreeBranchObserveRequest,
	): Promise<WorktreeBranchInventory> {
		const observedAt = this.now().toISOString();
		const branches: WorktreeBranchState[] = [];

		for (const worktree of request.worktrees) {
			if (worktree.bare) continue;
			const ref = shortBranchRef(worktree.branchRef);
			if (!ref || !worktree.headSha || !FULL_SHA.test(worktree.headSha)) {
				continue;
			}
			const [baseRelation, workingTree] = await Promise.all([
				this.observeBaseRelation(
					request.repoPath,
					worktree.headSha,
					request.baseRef,
				),
				this.observeWorkingTree(worktree.path),
			]);
			branches.push({
				ref,
				worktreePath: worktree.path,
				headSha: worktree.headSha,
				detached: worktree.detached,
				prunable: worktree.prunable,
				baseRelation,
				workingTree,
				...(request.featureBranches?.has(ref)
					? { linkedFeatureId: request.featureBranches.get(ref) }
					: {}),
			});
		}

		return {
			repoPath: request.repoPath,
			...(request.baseRef ? { baseRef: request.baseRef } : {}),
			status: "known",
			branches,
			observedAt,
		};
	}

	private async observeBaseRelation(
		repoPath: string,
		headSha: string,
		baseRef: string | undefined,
	): Promise<WorktreeBranchBaseRelation> {
		if (!baseRef) {
			return { status: "unknown", reason: "base_unknown" };
		}
		const baseResult = await this.git.read(
			["rev-parse", "--verify", `${baseRef}^{commit}`],
			{ cwd: repoPath },
		);
		const baseSha = baseResult.stdout.trim();
		if (!succeeded(baseResult) || !FULL_SHA.test(baseSha)) {
			return { status: "unknown", reason: "base_unknown" };
		}
		if (headSha.toLowerCase() === baseSha.toLowerCase()) {
			return { status: "current" };
		}

		const isAncestor = await this.git.read(
			["merge-base", "--is-ancestor", headSha, baseSha],
			{ cwd: repoPath },
		);
		if (isAncestor.exitCode === 0) {
			return { status: "merged" };
		}
		if (isAncestor.exitCode !== 1) {
			return {
				status: "unknown",
				reason: gitFailureDetail(isAncestor),
			};
		}

		const counts = await this.git.read(
			["rev-list", "--left-right", "--count", `${headSha}...${baseSha}`],
			{ cwd: repoPath },
		);
		if (!succeeded(counts)) {
			return { status: "unknown", reason: gitFailureDetail(counts) };
		}
		const [left, right] = counts.stdout.trim().split(/\s+/u).map(Number);
		if (
			!Number.isSafeInteger(left) ||
			left < 0 ||
			!Number.isSafeInteger(right) ||
			right < 0
		) {
			return { status: "unknown", reason: "invalid_divergence_counts" };
		}
		if (left === 0) return { status: "ahead", commits: right };
		if (right === 0) return { status: "ahead", commits: left };
		return { status: "diverged", ahead: left, behind: right };
	}

	private async observeWorkingTree(
		worktreePath: string,
	): Promise<WorktreeBranchState["workingTree"]> {
		const result = await this.git.read(
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			{ cwd: worktreePath },
		);
		if (!succeeded(result)) {
			return { status: "unknown" };
		}
		return result.stdout.length === 0
			? { status: "clean" }
			: { status: "dirty" };
	}
}

function shortBranchRef(branchRef: string | null): string | undefined {
	if (!branchRef) return undefined;
	const prefix = "refs/heads/";
	return branchRef.startsWith(prefix)
		? branchRef.slice(prefix.length)
		: undefined;
}

function succeeded(result: GitReadResult): boolean {
	return result.exitCode === 0 && !result.error;
}

function gitFailureDetail(result: GitReadResult): string {
	return (
		result.stderr.trim() ||
		result.error?.message ||
		`Git exited with code ${String(result.exitCode)}.`
	);
}
