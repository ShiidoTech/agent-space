export type GitObservation<T> = KnownGitObservation<T> | UnknownGitObservation;

export interface KnownGitObservation<T> {
	readonly status: "known";
	readonly value: T;
}

export interface UnknownGitObservation {
	readonly status: "unknown";
	readonly reason: GitUnknownReason;
	readonly message?: string;
	/** Partial identity that was observed before the operation became unknown. */
	readonly observed?: Readonly<Record<string, unknown>>;
}

export type GitUnknownReason =
	| "not_a_repository"
	| "repository_unavailable"
	| "worktree_missing"
	| "git_command_failed"
	| "unborn_head"
	| "ref_not_found"
	| "base_unknown"
	| "head_unknown"
	| "upstream_ref_missing"
	| "creation_point_unknown"
	| "creation_point_invalid"
	| "ancestry_unknown";

export interface ObservedCommit {
	readonly ref: string;
	readonly sha: string;
}

export interface BranchObservation {
	readonly expected: string;
	readonly actual: string | null;
	readonly detached: boolean;
	readonly matchesExpected: boolean;
}

export interface WorktreeChanges {
	readonly staged: readonly string[];
	readonly unstaged: readonly string[];
	readonly untracked: readonly string[];
	readonly conflicted: readonly string[];
}

export interface CommitComparison {
	readonly left: ObservedCommit;
	readonly right: ObservedCommit;
	/** Commits reachable only from `left`. */
	readonly leftOnly: number;
	/** Commits reachable only from `right`. */
	readonly rightOnly: number;
}

export interface UpstreamObservation {
	readonly branchRef: string;
	readonly upstream: ObservedCommit | null;
}

export interface GitWorktreeObservation {
	readonly path: string;
	readonly headSha: string | null;
	readonly branchRef: string | null;
	readonly detached: boolean;
	readonly bare: boolean;
	readonly prunable: boolean;
}

export interface AncestryObservation {
	readonly ancestor: ObservedCommit;
	readonly descendant: ObservedCommit;
	readonly isAncestor: boolean;
}

export interface FeatureDiffFile {
	readonly path: string;
	readonly oldPath?: string;
	readonly newPath?: string;
	readonly insertions: number | null;
	readonly deletions: number | null;
}

export interface FeatureDiffObservation {
	readonly base: ObservedCommit;
	readonly feature: ObservedCommit;
	readonly files: readonly FeatureDiffFile[];
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
	readonly raw: string;
}

export interface FeatureGitObservations {
	readonly repository: GitObservation<{ readonly root: string }>;
	readonly worktree: GitObservation<{
		readonly path: string;
		readonly present: boolean;
	}>;
	readonly branch: GitObservation<BranchObservation>;
	readonly head: GitObservation<ObservedCommit>;
	readonly feature: GitObservation<ObservedCommit>;
	readonly base: GitObservation<ObservedCommit>;
	readonly creationPoint: GitObservation<ObservedCommit>;
	readonly creationPointInFeature: GitObservation<AncestryObservation>;
	readonly upstream: GitObservation<UpstreamObservation>;
	readonly upstreamDivergence: GitObservation<CommitComparison | null>;
	/** Committed feature delta. This never includes working-tree changes. */
	readonly featureDelta: GitObservation<CommitComparison>;
	/** File delta for the merge-base comparison base...feature. */
	readonly featureDiff: GitObservation<FeatureDiffObservation>;
	readonly workingTree: GitObservation<WorktreeChanges>;
	readonly worktrees: GitObservation<readonly GitWorktreeObservation[]>;
	/** Raw local commit-graph evidence. Integration is evaluated elsewhere. */
	readonly featureInBase: GitObservation<AncestryObservation>;
}

export function known<T>(value: T): KnownGitObservation<T> {
	return { status: "known", value };
}

export function unknown(
	reason: GitUnknownReason,
	message?: string,
	observed?: Readonly<Record<string, unknown>>,
): UnknownGitObservation {
	return {
		status: "unknown",
		reason,
		...(message ? { message } : {}),
		...(observed ? { observed } : {}),
	};
}
