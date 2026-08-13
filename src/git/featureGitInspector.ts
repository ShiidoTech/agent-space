import * as path from "node:path";
import {
	type AncestryObservation,
	type CommitComparison,
	type FeatureDiffFile,
	type FeatureDiffObservation,
	type FeatureGitObservations,
	type GitObservation,
	type GitWorktreeObservation,
	known,
	type ObservedCommit,
	type UpstreamObservation,
	unknown,
	type WorktreeChanges,
} from "./featureGitObservations";
import {
	defaultGitClient,
	type GitReader,
	type GitReadResult,
} from "./gitClient";

export interface FeatureGitInspectionInput {
	readonly repoRoot: string;
	readonly worktreePath: string;
	readonly featureBranch: string;
	readonly baseRef?: string;
	readonly createdFromSha?: string;
}

export interface FeatureGitProjectObservation {
	readonly repository: GitObservation<{ readonly root: string }>;
	readonly worktrees: GitObservation<readonly GitWorktreeObservation[]>;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function successful(result: GitReadResult): boolean {
	return result.exitCode === 0 && !result.error;
}

function message(result: GitReadResult): string | undefined {
	return result.stderr.trim() || result.error?.message;
}

function parseStatus(output: string): WorktreeChanges {
	const staged: string[] = [];
	const unstaged: string[] = [];
	const untracked: string[] = [];
	const conflicted: string[] = [];
	const entries = output.split("\0");

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!entry) continue;
		const code = entry.slice(0, 2);
		const file = entry.slice(3);
		if (code === "??") {
			untracked.push(file);
		} else if (CONFLICT_CODES.has(code)) {
			conflicted.push(file);
		} else {
			if (code[0] !== " ") staged.push(file);
			if (code[1] !== " ") unstaged.push(file);
		}
		if (code[0] === "R" || code[0] === "C") index += 1;
	}

	return { staged, unstaged, untracked, conflicted };
}

function parseWorktrees(output: string): readonly GitWorktreeObservation[] {
	const records: GitWorktreeObservation[] = [];
	let current:
		| {
				path?: string;
				headSha?: string;
				branchRef?: string;
				detached?: boolean;
				bare?: boolean;
				prunable?: boolean;
		  }
		| undefined;

	for (const field of output.split(/\r?\n/)) {
		if (!field) continue;
		const separator = field.indexOf(" ");
		const key = separator < 0 ? field : field.slice(0, separator);
		const value = separator < 0 ? "" : field.slice(separator + 1);
		if (key === "worktree") {
			if (current?.path) records.push(completeWorktree(current));
			current = { path: value };
		} else if (current) {
			if (key === "HEAD") current.headSha = value;
			if (key === "branch") current.branchRef = value;
			if (key === "detached") current.detached = true;
			if (key === "bare") current.bare = true;
			if (key === "prunable") current.prunable = true;
		}
	}
	if (current?.path) records.push(completeWorktree(current));
	return records;
}

function completeWorktree(value: {
	path?: string;
	headSha?: string;
	branchRef?: string;
	detached?: boolean;
	bare?: boolean;
	prunable?: boolean;
}): GitWorktreeObservation {
	return {
		path: value.path ?? "",
		headSha: value.headSha ?? null,
		branchRef: value.branchRef ?? null,
		detached: value.detached ?? false,
		bare: value.bare ?? false,
		prunable: value.prunable ?? false,
	};
}

export class FeatureGitInspector {
	constructor(private readonly git: GitReader = defaultGitClient) {}

	async observeProject(
		repoRoot: string,
	): Promise<FeatureGitProjectObservation> {
		const repositoryResult = await this.git.read(
			["rev-parse", "--show-toplevel"],
			{ cwd: repoRoot },
		);
		const repository = successful(repositoryResult)
			? known({ root: repositoryResult.stdout.trim() })
			: unknown("not_a_repository", message(repositoryResult), {
					root: repoRoot,
				});
		const worktreesResult = await this.git.read(
			["worktree", "list", "--porcelain"],
			{ cwd: repoRoot },
		);
		const worktrees = successful(worktreesResult)
			? known(parseWorktrees(worktreesResult.stdout))
			: unknown("git_command_failed", message(worktreesResult));
		return { repository, worktrees };
	}

	async inspect(
		input: FeatureGitInspectionInput,
		projectObservation?: FeatureGitProjectObservation,
	): Promise<FeatureGitObservations> {
		const project =
			projectObservation ?? (await this.observeProject(input.repoRoot));
		if (project.repository.status === "unknown") {
			return this.unavailable(
				input,
				project.repository.reason === "not_a_repository"
					? "not_a_repository"
					: "repository_unavailable",
				project.repository.message,
			);
		}

		const repository = project.repository;
		const worktrees = project.worktrees;
		const targetPath = path.resolve(input.worktreePath);
		const worktree =
			worktrees.status === "known"
				? known({
						path: targetPath,
						present: worktrees.value.some(
							(entry) => path.resolve(entry.path) === targetPath,
						),
					})
				: unknown("git_command_failed", worktrees.message, {
						path: targetPath,
					});

		// These reads are independent. Keeping them serial made the first snapshot
		// unnecessarily expensive, especially for repositories with large graphs.
		const [base, resolvedFeature, worktreeHead, creationPoint] = await Promise.all([
			input.baseRef
				? this.resolveCommit(input.baseRef, input.repoRoot, "base")
				: Promise.resolve(unknown("base_unknown", "No base ref was observed")),
			this.resolveCommit(input.featureBranch, input.repoRoot, "feature"),
			worktree.status === "known" && worktree.value.present
				? this.resolveCommit("HEAD", input.worktreePath, "head")
				: Promise.resolve(unknown("worktree_missing")),
			input.createdFromSha
				? this.resolveCommit(input.createdFromSha, input.repoRoot, "creation")
				: Promise.resolve(unknown("creation_point_unknown")),
		]);
		const feature = resolvedFeature.status === "known" ? resolvedFeature : worktreeHead;
		const [
			creationPointInFeature,
			featureDelta,
			featureDiff,
			upstream,
			featureInBase,
		] = await Promise.all([
			this.observeAncestry(creationPoint, feature, input.repoRoot),
			this.compare(base, feature, input.repoRoot),
			this.observeFeatureDiff(base, feature, input.repoRoot),
			this.observeUpstream(input.featureBranch, input.repoRoot),
			this.observeAncestry(feature, base, input.repoRoot),
		]);
		const upstreamDivergence =
			upstream.status === "known" && upstream.value.upstream === null
				? known(null)
				: upstream.status === "known"
					? await this.compare(
							known(upstream.value.upstream as ObservedCommit),
							feature,
							input.repoRoot,
						)
					: upstream;
		if (worktree.status === "unknown" || !worktree.value.present) {
			const missing =
				worktree.status === "unknown"
					? worktree
					: unknown("worktree_missing", undefined, { path: targetPath });
			return {
				repository,
				worktree,
				branch: missing,
				head: missing,
				feature,
				base,
				creationPoint,
				creationPointInFeature,
				upstream,
				upstreamDivergence,
				featureDelta,
				featureDiff,
				workingTree: missing,
				worktrees,
				featureInBase,
			};
		}

		const branchResult = await this.git.read(
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			{ cwd: input.worktreePath },
		);
		const branch = successful(branchResult)
			? known({
					expected: input.featureBranch,
					actual: branchResult.stdout.trim(),
					detached: false,
					matchesExpected: branchResult.stdout.trim() === input.featureBranch,
				})
			: branchResult.exitCode === 1 && branchResult.signal === null
				? known({
						expected: input.featureBranch,
						actual: null,
						detached: true,
						matchesExpected: false,
					})
				: unknown("git_command_failed", message(branchResult), {
						expected: input.featureBranch,
					});
		const head = await this.resolveCommit("HEAD", input.worktreePath, "head");
		const statusResult = await this.git.read(
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			{ cwd: input.worktreePath },
		);
		const workingTree = successful(statusResult)
			? known(parseStatus(statusResult.stdout))
			: unknown("git_command_failed", message(statusResult));

		return {
			repository,
			worktree,
			branch,
			head,
			feature,
			base,
			creationPoint,
			creationPointInFeature,
			upstream,
			upstreamDivergence,
			featureDelta,
			featureDiff,
			workingTree,
			worktrees,
			featureInBase,
		};
	}

	private async resolveCommit(
		ref: string,
		cwd: string,
		role: "base" | "head" | "feature" | "creation",
	): Promise<GitObservation<ObservedCommit>> {
		const result = await this.git.read(
			["rev-parse", "--verify", `${ref}^{commit}`],
			{
				cwd,
			},
		);
		if (successful(result)) return known({ ref, sha: result.stdout.trim() });
		return unknown(
			role === "base"
				? "base_unknown"
				: role === "creation"
					? "creation_point_invalid"
					: role === "feature"
						? "ref_not_found"
						: "unborn_head",
			message(result),
			{ ref },
		);
	}

	/**
	 * Read-only proof that one SHA is an ancestor of another in the local
	 * commit graph. Used to relate a merged PR head to the current feature
	 * head without ever fetching.
	 */
	async isCommitAncestor(
		ancestorSha: string,
		descendantSha: string,
		repoRoot: string,
	): Promise<GitObservation<AncestryObservation>> {
		const ancestor = await this.resolveCommit(ancestorSha, repoRoot, "base");
		const descendant = await this.resolveCommit(
			descendantSha,
			repoRoot,
			"feature",
		);
		return this.observeAncestry(ancestor, descendant, repoRoot);
	}

	/**
	 * Read-only count of commits reachable from `descendantSha` but not from
	 * `ancestorSha`, i.e. the amount of work after a known merged head.
	 */
	async countCommitsAfter(
		ancestorSha: string,
		descendantSha: string,
		repoRoot: string,
	): Promise<
		GitObservation<{
			readonly ancestorSha: string;
			readonly descendantSha: string;
			readonly count: number;
		}>
	> {
		const result = await this.git.read(
			["rev-list", "--count", `${ancestorSha}..${descendantSha}`],
			{ cwd: repoRoot },
		);
		if (!successful(result)) {
			return unknown("git_command_failed", message(result), {
				ancestorSha,
				descendantSha,
			});
		}
		const count = Number(result.stdout.trim());
		if (!Number.isSafeInteger(count) || count < 0) {
			return unknown("git_command_failed", "Invalid rev-list count output", {
				ancestorSha,
				descendantSha,
			});
		}
		return known({ ancestorSha, descendantSha, count });
	}

	private async observeUpstream(
		branch: string,
		cwd: string,
	): Promise<GitObservation<UpstreamObservation>> {
		const branchRef = `refs/heads/${branch}`;
		const result = await this.git.read(
			["for-each-ref", "--format=%(upstream)", branchRef],
			{ cwd },
		);
		if (!successful(result))
			return unknown("git_command_failed", message(result));
		let upstreamRef = result.stdout.trim();
		if (!upstreamRef) {
			const remoteResult = await this.git.read(
				["config", "--get", `branch.${branch}.remote`],
				{ cwd },
			);
			if (remoteResult.exitCode === 1) {
				return known({ branchRef, upstream: null });
			}
			if (!successful(remoteResult)) {
				return unknown("git_command_failed", message(remoteResult));
			}
			const mergeResult = await this.git.read(
				["config", "--get", `branch.${branch}.merge`],
				{ cwd },
			);
			if (!successful(mergeResult)) {
				return unknown("upstream_ref_missing", message(mergeResult), {
					remote: remoteResult.stdout.trim(),
				});
			}
			const remote = remoteResult.stdout.trim();
			const mergeRef = mergeResult.stdout.trim();
			upstreamRef =
				remote === "."
					? mergeRef
					: `refs/remotes/${remote}/${mergeRef.replace(/^refs\/heads\//, "")}`;
		}
		const resolved = await this.resolveCommit(upstreamRef, cwd, "base");
		if (resolved.status === "unknown") {
			return unknown("upstream_ref_missing", resolved.message, {
				ref: upstreamRef,
			});
		}
		return known({ branchRef, upstream: resolved.value });
	}

	private async compare(
		left: GitObservation<ObservedCommit>,
		right: GitObservation<ObservedCommit>,
		cwd: string,
	): Promise<GitObservation<CommitComparison>> {
		if (left.status === "unknown" || right.status === "unknown") {
			return this.comparisonUnknown(left, right);
		}
		const result = await this.git.read(
			[
				"rev-list",
				"--left-right",
				"--count",
				`${left.value.sha}...${right.value.sha}`,
			],
			{ cwd },
		);
		if (!successful(result)) {
			return unknown("git_command_failed", message(result), {
				left: left.value,
				right: right.value,
			});
		}
		const [leftOnly, rightOnly] = result.stdout.trim().split(/\s+/).map(Number);
		if (!Number.isSafeInteger(leftOnly) || !Number.isSafeInteger(rightOnly)) {
			return unknown("git_command_failed", "Invalid rev-list count output", {
				left: left.value,
				right: right.value,
			});
		}
		return known({ left: left.value, right: right.value, leftOnly, rightOnly });
	}

	private comparisonUnknown(
		left: GitObservation<ObservedCommit>,
		right: GitObservation<ObservedCommit>,
	) {
		return unknown(
			left.status === "unknown" ? "base_unknown" : "head_unknown",
			undefined,
			{ left: observationEvidence(left), right: observationEvidence(right) },
		);
	}

	private async observeAncestry(
		feature: GitObservation<ObservedCommit>,
		base: GitObservation<ObservedCommit>,
		cwd: string,
	): Promise<GitObservation<AncestryObservation>> {
		if (feature.status === "unknown" || base.status === "unknown") {
			return unknown("ancestry_unknown", undefined, {
				feature: observationEvidence(feature),
				base: observationEvidence(base),
			});
		}
		const ancestry = await this.git.read(
			["merge-base", "--is-ancestor", feature.value.sha, base.value.sha],
			{ cwd },
		);
		if (ancestry.exitCode === 1) {
			return known({
				ancestor: feature.value,
				descendant: base.value,
				isAncestor: false,
			});
		}
		if (!successful(ancestry)) {
			return unknown("ancestry_unknown", message(ancestry), {
				feature: feature.value,
				base: base.value,
			});
		}
		return known({
			ancestor: feature.value,
			descendant: base.value,
			isAncestor: true,
		});
	}

	private async observeFeatureDiff(
		base: GitObservation<ObservedCommit>,
		feature: GitObservation<ObservedCommit>,
		cwd: string,
	): Promise<GitObservation<FeatureDiffObservation>> {
		if (base.status === "unknown" || feature.status === "unknown") {
			return unknown("git_command_failed", undefined, {
				base: observationEvidence(base),
				feature: observationEvidence(feature),
			});
		}
		const range = `${base.value.sha}...${feature.value.sha}`;
		const [numstat, stat] = await Promise.all([
			this.git.read(["diff", "--numstat", "-z", range], { cwd }),
			this.git.read(["diff", "--stat", range], { cwd }),
		]);
		if (!successful(numstat) || !successful(stat)) {
			return unknown("git_command_failed", message(numstat) ?? message(stat), {
				base: base.value,
				feature: feature.value,
			});
		}
		const files = parseNumstat(numstat.stdout);
		return known({
			base: base.value,
			feature: feature.value,
			files,
			filesChanged: files.length,
			insertions: files.reduce(
				(total, file) => total + (file.insertions ?? 0),
				0,
			),
			deletions: files.reduce(
				(total, file) => total + (file.deletions ?? 0),
				0,
			),
			raw: stat.stdout.trim(),
		});
	}

	private unavailable(
		input: FeatureGitInspectionInput,
		reason: "not_a_repository" | "repository_unavailable",
		detail?: string,
	): FeatureGitObservations {
		const unavailable = unknown(reason, detail, { root: input.repoRoot });
		return {
			repository: unavailable,
			worktree: unavailable,
			branch: unavailable,
			head: unavailable,
			feature: unavailable,
			base: unavailable,
			creationPoint: unavailable,
			creationPointInFeature: unavailable,
			upstream: unavailable,
			upstreamDivergence: unavailable,
			featureDelta: unavailable,
			featureDiff: unavailable,
			workingTree: unavailable,
			worktrees: unavailable,
			featureInBase: unavailable,
		};
	}
}

function parseNumstat(output: string): FeatureDiffFile[] {
	const tokens = output.split("\0");
	const files: FeatureDiffFile[] = [];
	for (let index = 0; index < tokens.length; ) {
		const record = tokens[index++];
		if (!record) continue;
		const [insertions, deletions, path] = record.split("\t");
		if (path === undefined) continue;
		const stats = {
			insertions: insertions === "-" ? null : Number(insertions),
			deletions: deletions === "-" ? null : Number(deletions),
		};
		if (path !== "") {
			files.push({ path, ...stats });
			continue;
		}
		const oldPath = tokens[index++];
		const newPath = tokens[index++];
		if (!oldPath || !newPath) continue;
		files.push({
			path: newPath,
			oldPath,
			newPath,
			...stats,
		});
	}
	return files;
}

function observationEvidence<T>(
	observation: GitObservation<T>,
): T | Readonly<Record<string, unknown>> | undefined {
	return observation.status === "known"
		? observation.value
		: observation.observed;
}

export function inspectFeatureGit(
	input: FeatureGitInspectionInput,
	git: GitReader = defaultGitClient,
): Promise<FeatureGitObservations> {
	return new FeatureGitInspector(git).inspect(input);
}
