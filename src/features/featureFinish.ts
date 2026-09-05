import * as fs from "node:fs";
import * as path from "node:path";
import type { TmuxSessionsObservation } from "../agents/tmux";
import {
	type BranchRetentionSafety,
	checkBranchRetentionSafety,
	checkWorktreeDeletionSafety,
	type WorktreeDeletionSafety,
} from "../git/worktreeSafety";
import type { ProjectContext } from "../projects/projectManager";
import type { Feature } from "../types";
import type { IntegrationEvaluation } from "./integrationEvaluator";

export interface FeatureFinishEvidence {
	readonly integration: IntegrationEvaluation;
}

export interface FeatureFinishCheck {
	readonly kind: "feature" | "agent";
	readonly agentId?: string;
	readonly branch?: string;
	readonly worktreePath: string;
	readonly disposition: "registered" | "already_removed" | "residue";
	readonly safety?: WorktreeDeletionSafety | BranchRetentionSafety;
	readonly safe: boolean;
	readonly forceable: boolean;
	readonly requiresForce: boolean;
	readonly acceptedPullRequestHeadSha?: string;
	readonly reasons: readonly string[];
}

export interface FeatureFinishAssessment {
	readonly checks: readonly FeatureFinishCheck[];
	readonly reasons: readonly string[];
	readonly safe: boolean;
	readonly forceable: boolean;
	readonly fingerprint: string;
	/**
	 * True when deleting the feature's Git branches is proven safe: the
	 * feature check is safe and integration proves the work already landed
	 * (merged pull request matched to the observed head, or ancestry).
	 * Unknown/stale integration never enables this — branches stay.
	 */
	readonly canDeleteBranches: boolean;
}

/** Read-only, fail-closed assessment used before and after confirmation. */
export async function assessFeatureFinish(
	ctx: ProjectContext,
	feature: Feature,
	evidence: FeatureFinishEvidence,
	pathExists: (candidate: string) => boolean = fs.existsSync,
): Promise<FeatureFinishAssessment> {
	const checks: FeatureFinishCheck[] = [];
	const worktrees = await ctx.gitClient.read(
		["worktree", "list", "--porcelain"],
		{
			cwd: ctx.project.repoPath,
		},
	);
	if (worktrees.exitCode !== 0 || worktrees.error) {
		throw new Error(
			worktrees.stderr.trim() ||
				worktrees.error?.message ||
				"Git worktree inventory is unavailable",
		);
	}
	const registeredPaths = parseRegisteredWorktreePaths(worktrees.stdout);
	const registeredBranches = parseRegisteredWorktreeBranches(worktrees.stdout);
	const featurePath = path.resolve(feature.worktreePath);
	let activeFeatureBranch: string | undefined = feature.branch;
	if (registeredPaths.has(featurePath)) {
		const branch = await observeRegisteredBranch(
			ctx,
			feature.worktreePath,
			registeredBranches.get(featurePath),
			feature.branch,
		);
		// The exact registered Feature worktree identifies the active checkout.
		// Git safety below still validates the branch ref and ancestry; stale
		// persisted branch links must not create a false "branch unknown" state.
		activeFeatureBranch = branch;
	}

	const check = async (
		kind: FeatureFinishCheck["kind"],
		worktreePath: string,
		branch: string | undefined,
		comparisonBranch: string,
		agentId?: string,
	) => {
		const resolvedPath = path.resolve(worktreePath);
		if (!registeredPaths.has(resolvedPath)) {
			const exists = pathExists(resolvedPath);
			const retentionBranch =
				kind === "feature"
					? await resolveFeatureRetentionBranch(ctx, feature, branch)
					: branch;
			const safety = exists
				? undefined
				: await checkBranchRetentionSafety({
						repoRoot: ctx.project.repoPath,
						branch: retentionBranch,
						baseBranch: comparisonBranch,
					});
			const residueReason = `Git no longer registers ${resolvedPath}, but files remain on disk. Inspect or remove this residue explicitly before finishing.`;
			const decision = exists
				? blockedDecision(residueReason)
				: finishDecision(kind, safety, evidence.integration);
			checks.push({
				kind,
				branch: retentionBranch,
				worktreePath: resolvedPath,
				disposition: exists ? "residue" : "already_removed",
				safety,
				...decision,
				...(agentId ? { agentId } : {}),
			});
			return;
		}
		const safety = await checkWorktreeDeletionSafety({
			repoRoot: ctx.project.repoPath,
			worktreeBase: ctx.featureManager.getWorktreeBase(),
			worktreePath,
			branch,
			baseBranch: comparisonBranch,
		});
		const decision = finishDecision(kind, safety, evidence.integration);
		checks.push({
			kind,
			branch,
			worktreePath: resolvedPath,
			disposition: "registered",
			safety,
			...decision,
			...(agentId ? { agentId } : {}),
		});
	};

	await check(
		"feature",
		feature.worktreePath,
		activeFeatureBranch,
		ctx.featureManager.getBaseBranchName(),
	);
	for (const agent of ctx.agentManager.getAgents(feature.id)) {
		if (!agent.worktreePath) continue;
		const registered = registeredPaths.has(path.resolve(agent.worktreePath));
		const resolvedAgentPath = path.resolve(agent.worktreePath);
		const branch = registered
			? await observeRegisteredBranch(
					ctx,
					agent.worktreePath,
					registeredBranches.get(resolvedAgentPath),
					ctx.agentManager.getAgentBranchName(feature, agent.id),
				)
			: undefined;
		await check(
			"agent",
			agent.worktreePath,
			registered
				? branch
				: ctx.agentManager.getAgentBranchName(feature, agent.id),
			activeFeatureBranch ?? feature.branch,
			agent.id,
		);
	}

	const reasons = checks.flatMap((entry) => {
		const prefix = entry.kind === "feature" ? "Feature" : "Agent";
		return entry.reasons.map((reason) => `${prefix}: ${reason}`);
	});
	const featureCheck = checks.find((entry) => entry.kind === "feature");
	const canDeleteBranches = canDeleteFeatureBranches(
		featureCheck,
		evidence.integration,
	);
	return {
		checks,
		reasons,
		safe: checks.every((entry) => entry.safe),
		forceable: checks.every((entry) => entry.forceable),
		canDeleteBranches,
		fingerprint: JSON.stringify({
			checks: checks.map(
				({
					kind,
					agentId,
					branch,
					disposition,
					safety,
					safe,
					forceable,
					requiresForce,
					acceptedPullRequestHeadSha,
				}) => ({
					kind,
					agentId,
					branch,
					disposition,
					safety,
					safe,
					forceable,
					requiresForce,
					acceptedPullRequestHeadSha,
				}),
			),
			canDeleteBranches,
			integration: evidence.integration,
		}),
	};
}

/**
 * Branch deletion eligibility: the feature check itself must be safe, and
 * integration must prove the branch already landed. A squash-merge leaves
 * the local tip unmerged, so only a matched merged-PR proof (or true
 * ancestry) unlocks deletion — never an unknown/stale state.
 */
function canDeleteFeatureBranches(
	featureCheck: FeatureFinishCheck | undefined,
	integration: IntegrationEvaluation,
): boolean {
	if (!featureCheck?.safe || !featureCheck.branch) return false;
	if (integration.status !== "known") return false;
	if (integration.outcome === "integrated_by_ancestry") return true;
	return (
		integration.outcome === "integrated_by_pull_request" &&
		typeof featureCheck.acceptedPullRequestHeadSha === "string"
	);
}

async function resolveFeatureRetentionBranch(
	ctx: ProjectContext,
	feature: Feature,
	declaredBranch: string | undefined,
): Promise<string | undefined> {
	const candidates = new Set<string>();
	if (declaredBranch) candidates.add(declaredBranch);
	const name = feature.name.trim().replace(/\s+/gu, "-").toLowerCase();
	if (name) {
		candidates.add(`feature/${name}`);
		candidates.add(`feat/${name}`);
	}
	const refs = await ctx.gitClient.read(
		["for-each-ref", "--format=%(refname:short)", "refs/heads"],
		{ cwd: ctx.project.repoPath },
	);
	if (refs.exitCode === 0 && !refs.error) {
		const available = refs.stdout
			.split(/\r?\n/u)
			.map((ref) => ref.trim())
			.filter((ref) => ref.length > 0 && candidates.has(ref));
		if (declaredBranch && available.includes(declaredBranch))
			return declaredBranch;
		const derived = available.filter((ref) => ref !== declaredBranch);
		return derived.length === 1 ? derived[0] : undefined;
	}
	const resolved: string[] = [];
	for (const candidate of candidates) {
		const observed = await ctx.gitClient.read(
			["rev-parse", "--verify", `${candidate}^{commit}`],
			{ cwd: ctx.project.repoPath },
		);
		if (observed.exitCode === 0 && !observed.error && observed.stdout.trim()) {
			resolved.push(candidate);
		}
	}
	if (declaredBranch && resolved.includes(declaredBranch))
		return declaredBranch;
	return resolved.length === 1 ? resolved[0] : undefined;
}

async function observeRegisteredBranch(
	ctx: ProjectContext,
	worktreePath: string,
	inventoryBranch: string | undefined,
	declaredBranch: string,
): Promise<string | undefined> {
	const symbolic = await ctx.gitClient.read(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		{ cwd: worktreePath },
	);
	const symbolicBranch = symbolic.stdout.trim();
	if (
		symbolic.exitCode === 0 &&
		!symbolic.error &&
		isSafeBranchName(symbolicBranch)
	) {
		return symbolicBranch;
	}
	const current = await ctx.gitClient.read(["branch", "--show-current"], {
		cwd: worktreePath,
	});
	const currentBranch = current.stdout.trim();
	if (
		current.exitCode === 0 &&
		!current.error &&
		currentBranch &&
		!currentBranch.includes("\n") &&
		!currentBranch.startsWith("worktree ")
	) {
		return currentBranch;
	}
	if (inventoryBranch) return inventoryBranch;
	// Some Git wrappers report an empty successful result (or a transport
	// failure with no numeric exit code) for a detached/unreadable checkout.
	// The exit code alone must not decide whether the SHA proof is attempted.
	// If both refs resolve to the same commit, the declared branch is observed
	// without guessing; otherwise the result remains unknown.
	if (declaredBranch) {
		const head = await ctx.gitClient.read(
			["rev-parse", "--verify", "HEAD^{commit}"],
			{
				cwd: worktreePath,
			},
		);
		const declared = await ctx.gitClient.read(
			["rev-parse", "--verify", `${declaredBranch}^{commit}`],
			{ cwd: ctx.project.repoPath },
		);
		const headSha = head.stdout.trim();
		const declaredSha = declared.stdout.trim();
		if (
			head.exitCode === 0 &&
			declared.exitCode === 0 &&
			/^[0-9a-f]{40,64}$/iu.test(headSha) &&
			/^[0-9a-f]{40,64}$/iu.test(declaredSha) &&
			headSha.toLowerCase() === declaredSha.toLowerCase()
		) {
			return declaredBranch;
		}
	}
	return undefined;
}

interface FinishDecision {
	readonly safe: boolean;
	readonly forceable: boolean;
	readonly requiresForce: boolean;
	readonly acceptedPullRequestHeadSha?: string;
	readonly reasons: readonly string[];
}

function blockedDecision(reason: string): FinishDecision {
	return {
		safe: false,
		forceable: false,
		requiresForce: false,
		reasons: [reason],
	};
}

function finishDecision(
	kind: FeatureFinishCheck["kind"],
	safety: WorktreeDeletionSafety | BranchRetentionSafety | undefined,
	integration: IntegrationEvaluation,
): FinishDecision {
	if (!safety) return blockedDecision("Deletion safety was not observed.");
	if (safety.safe) {
		return {
			safe: true,
			forceable: true,
			requiresForce: false,
			reasons: [],
		};
	}
	if (kind !== "feature") return decisionFromSafety(safety);
	// When the checkout is already gone, local branch-retention evidence is the
	// authoritative integration proof. A stale snapshot cannot turn an observed
	// ancestor relationship into an unknown finish decision.
	if ("branch" in safety && integration.status === "unknown") {
		return decisionFromSafety(safety);
	}

	if (integration.status === "unknown") {
		const integrationReason = `Integration evidence is unknown (${integration.reason})${integration.detail ? `: ${integration.detail}` : "."}`;
		return {
			safe: false,
			// A human may explicitly accept the unknown GitHub state when local
			// worktree deletion is independently forceable. Branches are retained;
			// this only removes the worktree and Agent Space records.
			forceable: safety.forceable && !("dirty" in safety && safety.dirty),
			requiresForce: safety.forceable && !("dirty" in safety && safety.dirty),
			reasons: [integrationReason, ...safety.reasons],
		};
	}
	if (integration.outcome !== "integrated_by_pull_request") {
		return decisionFromSafety(safety);
	}
	if (!integrationMatchesCurrentFeature(integration, safety)) {
		return blockedDecision(
			"The merged pull request evidence does not match the currently observed Feature head.",
		);
	}
	if (!safety.forceable) return decisionFromSafety(safety);

	const dirty = "dirty" in safety && safety.dirty;
	const reasons = dirty
		? safety.reasons.filter((reason) =>
				reason.startsWith("Uncommitted changes detected"),
			)
		: [];
	return {
		safe: !dirty,
		forceable: true,
		requiresForce: dirty,
		acceptedPullRequestHeadSha: safety.featureSha,
		reasons,
	};
}

function decisionFromSafety(
	safety: WorktreeDeletionSafety | BranchRetentionSafety,
): FinishDecision {
	return {
		safe: safety.safe,
		forceable: safety.forceable,
		requiresForce: !safety.safe && safety.forceable,
		reasons: safety.reasons,
	};
}

function integrationMatchesCurrentFeature(
	integration: Extract<IntegrationEvaluation, { status: "known" }>,
	safety: WorktreeDeletionSafety | BranchRetentionSafety,
): boolean {
	if (integration.outcome !== "integrated_by_pull_request") return false;
	const observedFeature = integration.evidence.feature?.sha;
	const github = integration.evidence.github;
	const pullHead = github?.pull?.headSha;
	return (
		github?.status === "known" &&
		github.baseMatch === true &&
		github.pull?.state === "merged" &&
		typeof safety.featureSha === "string" &&
		typeof observedFeature === "string" &&
		typeof pullHead === "string" &&
		safety.featureSha.toLowerCase() === observedFeature.toLowerCase() &&
		safety.featureSha.toLowerCase() === pullHead.toLowerCase()
	);
}

export interface FeatureFinishRemovalPlanEntry {
	readonly kind: FeatureFinishCheck["kind"];
	readonly agentId?: string;
	readonly worktreePath: string;
	readonly force: boolean;
	readonly acceptedPullRequestHeadSha?: string;
	/** Delete the feature's Git branches after the worktree is gone. */
	readonly deleteBranches: boolean;
	readonly branch?: string;
}

/**
 * Per-worktree plan: a risk on one check never weakens another check.
 * With `deleteBranches`, the already-removed feature entry is kept so a
 * retry after worktree removal can still delete the branches.
 */
export function planFeatureFinishRemovals(
	assessment: FeatureFinishAssessment,
	options?: { deleteBranches?: boolean },
): readonly FeatureFinishRemovalPlanEntry[] {
	const deleteBranches =
		options?.deleteBranches === true && assessment.canDeleteBranches;
	return assessment.checks
		.filter(
			(check) =>
				check.disposition === "registered" ||
				(deleteBranches &&
					check.kind === "feature" &&
					check.disposition === "already_removed"),
		)
		.map((check) => ({
			kind: check.kind,
			...(check.agentId ? { agentId: check.agentId } : {}),
			worktreePath: check.worktreePath,
			force: check.requiresForce,
			...(check.acceptedPullRequestHeadSha
				? { acceptedPullRequestHeadSha: check.acceptedPullRequestHeadSha }
				: {}),
			deleteBranches: deleteBranches && check.kind === "feature",
			...(check.kind === "feature" && check.branch
				? { branch: check.branch }
				: {}),
		}));
}

export function parseRegisteredWorktreePaths(output: string): Set<string> {
	return new Set(
		output
			.split(/\r?\n/u)
			.filter((line) => line.startsWith("worktree "))
			.map((line) => path.resolve(line.slice("worktree ".length))),
	);
}

export function parseRegisteredWorktreeBranches(
	output: string,
): Map<string, string> {
	const branches = new Map<string, string>();
	let currentPath: string | undefined;
	for (const line of output.split(/\r?\n/u)) {
		if (line.startsWith("worktree ")) {
			currentPath = path.resolve(line.slice("worktree ".length));
			continue;
		}
		if (currentPath && line.startsWith("branch refs/heads/")) {
			branches.set(currentPath, line.slice("branch refs/heads/".length));
		}
	}
	return branches;
}

function isSafeBranchName(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) && !value.includes("..");
}

export type SessionStopVerification =
	| { readonly status: "verified" }
	| { readonly status: "blocked"; readonly reason: string };

export function verifySessionsStopped(
	trackedSessions: ReadonlySet<string>,
	observation: TmuxSessionsObservation,
): SessionStopVerification {
	if (observation.status === "unknown") {
		return {
			status: "blocked",
			reason: `stopped sessions could not be verified: ${observation.detail}`,
		};
	}
	const remaining = observation.sessions.filter((session) =>
		trackedSessions.has(session),
	);
	if (remaining.length > 0) {
		return {
			status: "blocked",
			reason: `these sessions are still running: ${remaining.join(", ")}`,
		};
	}
	return { status: "verified" };
}
