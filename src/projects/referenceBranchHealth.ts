import type { GitReader, GitReadResult } from "../git/gitClient";
import { defaultGitClient } from "../git/gitClient";

export type ReferenceBranchHealthState =
	| "current"
	| "behind"
	| "ahead"
	| "diverged"
	| "different_unknown"
	| "unknown"
	| "missing";

export type ReferenceBranchObservationSource =
	| "local_branch"
	| "remote_tracking_ref"
	| "remote_head";

export interface ReferenceBranchProvenance {
	readonly source: ReferenceBranchObservationSource;
	readonly ref: string;
	/** Human-readable backend identity, for example `git ls-remote`. */
	readonly backend: string;
}

export type ReferenceBranchRefObservation =
	| {
			readonly status: "known";
			readonly sha: string;
			readonly observedAt: string;
			readonly provenance: ReferenceBranchProvenance;
	  }
	| {
			readonly status: "missing";
			readonly observedAt: string;
			readonly provenance: ReferenceBranchProvenance;
	  }
	| {
			readonly status: "unknown";
			readonly reason: string;
			readonly detail?: string;
			readonly observedAt: string;
			readonly provenance: ReferenceBranchProvenance;
	  };

export type RemoteBranchHeadObservation = ReferenceBranchRefObservation;

export interface RemoteBranchHeadRequest {
	readonly repoPath: string;
	readonly remoteName: string;
	readonly branch: string;
}

export interface NormalizedReferenceBranch {
	readonly branch: string;
	readonly remoteName: string;
}

/** Normalize historical `origin/main` / full remote refs for project health. */
export function normalizeReferenceBranch(
	configured: string,
	defaultRemote = "origin",
): NormalizedReferenceBranch {
	const fullRemote = /^refs\/remotes\/([^/]+)\/(.+)$/u.exec(configured);
	if (fullRemote) {
		return { remoteName: fullRemote[1], branch: fullRemote[2] };
	}
	const defaultPrefix = `${defaultRemote}/`;
	if (configured.startsWith(defaultPrefix)) {
		return {
			remoteName: defaultRemote,
			branch: configured.slice(defaultPrefix.length),
		};
	}
	return { remoteName: defaultRemote, branch: configured };
}

/**
 * Injected boundary for a real remote observation. Implementations may cache,
 * but must expose the timestamp and provenance of the value they return.
 */
export interface RemoteBranchHeadSource {
	observe(
		request: RemoteBranchHeadRequest,
	): Promise<RemoteBranchHeadObservation>;
	invalidate?(): void;
}

export type ReferenceBranchRelation =
	| {
			readonly state: "current";
			readonly localOnly: 0;
			readonly comparedOnly: 0;
	  }
	| {
			readonly state: "behind" | "ahead" | "diverged";
			readonly localOnly: number;
			readonly comparedOnly: number;
	  }
	| {
			readonly state: "different_unknown" | "unknown" | "missing";
			readonly reason: ReferenceBranchRelationReason;
			readonly detail?: string;
	  };

export type ReferenceBranchRelationReason =
	| "local_branch_missing"
	| "compared_ref_missing"
	| "local_branch_unknown"
	| "compared_ref_unknown"
	| "remote_object_not_available_locally"
	| "comparison_failed";

export interface ReferenceBranchFreshness {
	readonly status: "fresh" | "stale" | "unknown";
	readonly observedAt: string;
	readonly ageMs?: number;
	readonly staleAfterMs: number;
}

/**
 * Complete read-only evidence for the reference branch of one registered
 * project. `state` always reflects `verifiedRemoteRelation`, never the possibly
 * stale remote-tracking ref.
 */
export interface ProjectReferenceBranchHealth {
	readonly repoPath: string;
	readonly branch: string;
	readonly remoteName: string;
	readonly local: ReferenceBranchRefObservation;
	readonly remoteTracking: ReferenceBranchRefObservation;
	readonly verifiedRemote: RemoteBranchHeadObservation;
	readonly remoteTrackingRelation: ReferenceBranchRelation;
	readonly verifiedRemoteRelation: ReferenceBranchRelation;
	readonly state: ReferenceBranchHealthState;
	readonly remoteFreshness: ReferenceBranchFreshness;
	readonly observedAt: string;
}

export interface ProjectReferenceBranchObserverOptions {
	readonly git?: GitReader;
	readonly remote: RemoteBranchHeadSource;
	readonly now?: () => Date;
	readonly staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Read-only project reference-branch observer. It never fetches, updates refs,
 * checks out a branch, or modifies the working tree.
 */
export class ProjectReferenceBranchObserver {
	private readonly git: GitReader;
	private readonly remote: RemoteBranchHeadSource;
	private readonly now: () => Date;
	private readonly staleAfterMs: number;

	constructor(options: ProjectReferenceBranchObserverOptions) {
		this.git = options.git ?? defaultGitClient;
		this.remote = options.remote;
		this.now = options.now ?? (() => new Date());
		this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
	}

	async observe(request: {
		repoPath: string;
		branch: string;
		remoteName?: string;
	}): Promise<ProjectReferenceBranchHealth> {
		const remoteName = request.remoteName ?? "origin";
		const observedAt = this.now().toISOString();
		const localRef = `refs/heads/${request.branch}`;
		const remoteTrackingRef = `refs/remotes/${remoteName}/${request.branch}`;
		const repository = await this.git.read(["rev-parse", "--show-toplevel"], {
			cwd: request.repoPath,
		});

		if (!succeeded(repository)) {
			const detail = gitFailureDetail(repository);
			const local = unknownRef("local_branch", localRef, observedAt, detail);
			const remoteTracking = unknownRef(
				"remote_tracking_ref",
				remoteTrackingRef,
				observedAt,
				detail,
			);
			const verifiedRemote = unknownRef(
				"remote_head",
				localRef,
				observedAt,
				"Repository unavailable; remote was not queried.",
			);
			const relation: ReferenceBranchRelation = {
				state: "unknown",
				reason: "local_branch_unknown",
				detail,
			};
			return {
				repoPath: request.repoPath,
				branch: request.branch,
				remoteName,
				local,
				remoteTracking,
				verifiedRemote,
				remoteTrackingRelation: relation,
				verifiedRemoteRelation: relation,
				state: "unknown",
				remoteFreshness: freshness(
					verifiedRemote.observedAt,
					this.now(),
					this.staleAfterMs,
				),
				observedAt,
			};
		}

		const [local, remoteTracking, verifiedRemote] = await Promise.all([
			observeLocalRef(
				this.git,
				request.repoPath,
				localRef,
				"local_branch",
				observedAt,
			),
			observeLocalRef(
				this.git,
				request.repoPath,
				remoteTrackingRef,
				"remote_tracking_ref",
				observedAt,
			),
			this.remote.observe({
				repoPath: request.repoPath,
				remoteName,
				branch: request.branch,
			}),
		]);

		const remoteTrackingRelation = await compareLocalRefs(
			this.git,
			request.repoPath,
			local,
			remoteTracking,
			false,
		);
		const verifiedRemoteRelation = sameKnownCommit(
			remoteTracking,
			verifiedRemote,
		)
			? remoteTrackingRelation
			: await compareLocalRefs(
					this.git,
					request.repoPath,
					local,
					verifiedRemote,
					true,
				);

		return {
			repoPath: request.repoPath,
			branch: request.branch,
			remoteName,
			local,
			remoteTracking,
			verifiedRemote,
			remoteTrackingRelation,
			verifiedRemoteRelation,
			state: verifiedRemoteRelation.state,
			remoteFreshness: freshness(
				verifiedRemote.observedAt,
				this.now(),
				this.staleAfterMs,
			),
			observedAt,
		};
	}
}

export interface GitLsRemoteBranchHeadSourceOptions {
	readonly git?: GitReader;
	readonly now?: () => Date;
	readonly ttlMs?: number;
}

/** Verifies a remote head with `git ls-remote`; this does not update local refs. */
export class GitLsRemoteBranchHeadSource implements RemoteBranchHeadSource {
	private readonly git: GitReader;
	private readonly now: () => Date;
	private readonly ttlMs: number;
	private generation = 0;
	private readonly cache = new Map<
		string,
		{ readonly at: number; readonly observation: RemoteBranchHeadObservation }
	>();
	private readonly inFlight = new Map<
		string,
		{
			readonly generation: number;
			readonly result: Promise<RemoteBranchHeadObservation>;
		}
	>();

	constructor(options: GitLsRemoteBranchHeadSourceOptions = {}) {
		this.git = options.git ?? defaultGitClient;
		this.now = options.now ?? (() => new Date());
		this.ttlMs = options.ttlMs ?? DEFAULT_STALE_AFTER_MS;
	}

	invalidate(): void {
		this.generation += 1;
		this.cache.clear();
		this.inFlight.clear();
	}

	async observe(
		request: RemoteBranchHeadRequest,
	): Promise<RemoteBranchHeadObservation> {
		const cacheKey = `${request.repoPath}\u0000${request.remoteName}\u0000${request.branch}`;
		const now = this.now();
		const cached = this.cache.get(cacheKey);
		if (cached && now.getTime() - cached.at < this.ttlMs) {
			return cached.observation;
		}
		const currentGeneration = this.generation;
		const pending = this.inFlight.get(cacheKey);
		if (pending?.generation === currentGeneration) return pending.result;

		const result = this.queryRemote(request, now).then((observation) => {
			if (this.generation === currentGeneration) {
				this.cache.set(cacheKey, {
					at: now.getTime(),
					observation,
				});
			}
			return observation;
		});
		this.inFlight.set(cacheKey, {
			generation: currentGeneration,
			result,
		});
		const clearPending = () => {
			if (this.inFlight.get(cacheKey)?.result === result) {
				this.inFlight.delete(cacheKey);
			}
		};
		void result.then(clearPending, clearPending);
		return result;
	}

	private async queryRemote(
		request: RemoteBranchHeadRequest,
		now: Date,
	): Promise<RemoteBranchHeadObservation> {
		const observedAt = now.toISOString();
		const ref = `refs/heads/${request.branch}`;
		const provenance: ReferenceBranchProvenance = {
			source: "remote_head",
			ref,
			backend: "git ls-remote",
		};
		const result = await this.git.read(
			["ls-remote", "--heads", request.remoteName, ref],
			{ cwd: request.repoPath, timeoutMs: 5_000 },
		);
		if (!succeeded(result)) {
			return {
				status: "unknown",
				reason: "remote_query_failed",
				detail: gitFailureDetail(result),
				observedAt,
				provenance,
			};
		}

		const lines = result.stdout
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length === 0) {
			return {
				status: "missing",
				observedAt,
				provenance,
			};
		}
		if (lines.length !== 1) {
			return {
				status: "unknown",
				reason: "ambiguous_remote_response",
				detail: `Expected one ref, received ${lines.length}.`,
				observedAt,
				provenance,
			};
		}

		const [sha, returnedRef, ...extra] = lines[0].split(/\s+/u);
		if (
			extra.length > 0 ||
			returnedRef !== ref ||
			!/^[0-9a-f]{40,64}$/iu.test(sha)
		) {
			return {
				status: "unknown",
				reason: "invalid_remote_response",
				detail:
					"The remote response did not contain the requested branch head.",
				observedAt,
				provenance,
			};
		}

		return {
			status: "known",
			sha,
			observedAt,
			provenance,
		};
	}
}

async function observeLocalRef(
	git: GitReader,
	repoPath: string,
	ref: string,
	source: "local_branch" | "remote_tracking_ref",
	observedAt: string,
): Promise<ReferenceBranchRefObservation> {
	const provenance: ReferenceBranchProvenance = {
		source,
		ref,
		backend: "git show-ref",
	};
	const result = await git.read(["show-ref", "--verify", "--hash", ref], {
		cwd: repoPath,
	});
	if (succeeded(result)) {
		const sha = result.stdout.trim();
		if (/^[0-9a-f]{40,64}$/iu.test(sha)) {
			return { status: "known", sha, observedAt, provenance };
		}
		return {
			status: "unknown",
			reason: "invalid_local_ref",
			detail: `Git returned an invalid object id for ${ref}.`,
			observedAt,
			provenance,
		};
	}
	if (result.exitCode === 1) {
		return { status: "missing", observedAt, provenance };
	}
	return {
		status: "unknown",
		reason: "local_ref_query_failed",
		detail: gitFailureDetail(result),
		observedAt,
		provenance,
	};
}

async function compareLocalRefs(
	git: GitReader,
	repoPath: string,
	local: ReferenceBranchRefObservation,
	compared: ReferenceBranchRefObservation,
	requireRemoteObjectCheck: boolean,
): Promise<ReferenceBranchRelation> {
	if (local.status === "missing") {
		return { state: "missing", reason: "local_branch_missing" };
	}
	if (local.status === "unknown") {
		return {
			state: "unknown",
			reason: "local_branch_unknown",
			detail: local.detail,
		};
	}
	if (compared.status === "missing") {
		return { state: "missing", reason: "compared_ref_missing" };
	}
	if (compared.status === "unknown") {
		return {
			state: "unknown",
			reason: "compared_ref_unknown",
			detail: compared.detail,
		};
	}
	if (local.sha.toLowerCase() === compared.sha.toLowerCase()) {
		return { state: "current", localOnly: 0, comparedOnly: 0 };
	}

	if (requireRemoteObjectCheck) {
		const remoteObject = await git.read(
			["cat-file", "-e", `${compared.sha}^{commit}`],
			{ cwd: repoPath },
		);
		if (!succeeded(remoteObject)) {
			return {
				state: "different_unknown",
				reason: "remote_object_not_available_locally",
				detail:
					"The verified remote head differs, but its commit is not available in the local object database.",
			};
		}
	}

	const comparison = await git.read(
		["rev-list", "--left-right", "--count", `${local.sha}...${compared.sha}`],
		{ cwd: repoPath },
	);
	if (!succeeded(comparison)) {
		return {
			state: "unknown",
			reason: "comparison_failed",
			detail: gitFailureDetail(comparison),
		};
	}
	const counts = comparison.stdout.trim().split(/\s+/u);
	if (counts.length !== 2) {
		return {
			state: "unknown",
			reason: "comparison_failed",
			detail: "Git returned invalid divergence counts.",
		};
	}
	const localOnly = Number.parseInt(counts[0], 10);
	const comparedOnly = Number.parseInt(counts[1], 10);
	if (
		!Number.isSafeInteger(localOnly) ||
		localOnly < 0 ||
		!Number.isSafeInteger(comparedOnly) ||
		comparedOnly < 0
	) {
		return {
			state: "unknown",
			reason: "comparison_failed",
			detail: "Git returned invalid divergence counts.",
		};
	}
	if (localOnly === 0 && comparedOnly === 0) {
		return { state: "current", localOnly: 0, comparedOnly: 0 };
	}
	if (localOnly === 0) {
		return { state: "behind", localOnly, comparedOnly };
	}
	if (comparedOnly === 0) {
		return { state: "ahead", localOnly, comparedOnly };
	}
	return { state: "diverged", localOnly, comparedOnly };
}

function freshness(
	observedAt: string,
	now: Date,
	staleAfterMs: number,
): ReferenceBranchFreshness {
	const timestamp = Date.parse(observedAt);
	if (!Number.isFinite(timestamp)) {
		return { status: "unknown", observedAt, staleAfterMs };
	}
	const ageMs = Math.max(0, now.getTime() - timestamp);
	return {
		status: ageMs > staleAfterMs ? "stale" : "fresh",
		observedAt,
		ageMs,
		staleAfterMs,
	};
}

function unknownRef(
	source: ReferenceBranchObservationSource,
	ref: string,
	observedAt: string,
	detail: string,
): ReferenceBranchRefObservation {
	return {
		status: "unknown",
		reason: "repository_unavailable",
		detail,
		observedAt,
		provenance: { source, ref, backend: "not_run" },
	};
}

function succeeded(result: GitReadResult): boolean {
	return result.exitCode === 0 && !result.error;
}

function sameKnownCommit(
	left: ReferenceBranchRefObservation,
	right: ReferenceBranchRefObservation,
): boolean {
	return (
		left.status === "known" &&
		right.status === "known" &&
		left.sha.toLowerCase() === right.sha.toLowerCase()
	);
}

function gitFailureDetail(result: GitReadResult): string {
	return (
		result.stderr.trim() ||
		result.error?.message ||
		`Git exited with code ${String(result.exitCode)}.`
	);
}
