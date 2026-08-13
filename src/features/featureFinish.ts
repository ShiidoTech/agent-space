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
}

/** Read-only, fail-closed assessment used before and after confirmation. */
export function assessFeatureFinish(
	ctx: ProjectContext,
	feature: Feature,
	evidence: FeatureFinishEvidence,
	pathExists: (candidate: string) => boolean = fs.existsSync,
): FeatureFinishAssessment {
	const checks: FeatureFinishCheck[] = [];
	const worktrees = ctx.gitClient.readSync(
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
		const branch = observeRegisteredBranch(
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

	const check = (
		kind: FeatureFinishCheck["kind"],
		worktreePath: string,
		branch: string | undefined,
		comparisonBranch: string,
		agentId?: string,
	) => {
		const resolvedPath = path.resolve(worktreePath);
		if (!registeredPaths.has(resolvedPath)) {
			const exists = pathExists(resolvedPath);
			const safety = exists
				? undefined
				: checkBranchRetentionSafety({
						repoRoot: ctx.project.repoPath,
						branch,
						baseBranch: comparisonBranch,
					});
			const residueReason = `Git no longer registers ${resolvedPath}, but files remain on disk. Inspect or remove this residue explicitly before finishing.`;
			const decision = exists
				? blockedDecision(residueReason)
				: finishDecision(kind, safety, evidence.integration);
			checks.push({
				kind,
				branch,
				worktreePath: resolvedPath,
				disposition: exists ? "residue" : "already_removed",
				safety,
				...decision,
				...(agentId ? { agentId } : {}),
			});
			return;
		}
		const safety = checkWorktreeDeletionSafety({
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

	check(
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
			? observeRegisteredBranch(
					ctx,
					agent.worktreePath,
					registeredBranches.get(resolvedAgentPath),
					ctx.agentManager.getAgentBranchName(feature, agent.id),
				)
			: undefined;
		check(
			"agent",
			agent.worktreePath,
			registered ? branch : ctx.agentManager.getAgentBranchName(feature, agent.id),
			activeFeatureBranch ?? feature.branch,
			agent.id,
		);
	}

	const reasons = checks.flatMap((entry) => {
		const prefix = entry.kind === "feature" ? "Feature" : "Agent";
		return entry.reasons.map((reason) => `${prefix}: ${reason}`);
	});
	return {
		checks,
		reasons,
		safe: checks.every((entry) => entry.safe),
		forceable: checks.every((entry) => entry.forceable),
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
			integration: evidence.integration,
		}),
	};
}

function observeRegisteredBranch(
	ctx: ProjectContext,
	worktreePath: string,
	inventoryBranch: string | undefined,
	declaredBranch: string,
): string | undefined {
	const symbolic = ctx.gitClient.readSync(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		{ cwd: worktreePath },
	);
	if (symbolic.exitCode === 0 && !symbolic.error) {
		return symbolic.stdout.trim() || undefined;
	}
	const current = ctx.gitClient.readSync(["branch", "--show-current"], {
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
	if (symbolic.exitCode === 1 || current.exitCode === 1) {
		const head = ctx.gitClient.readSync(["rev-parse", "--verify", "HEAD^{commit}"], {
			cwd: worktreePath,
		});
		const declared = ctx.gitClient.readSync(
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
		return blockedDecision(
			`Integration evidence is unknown (${integration.reason})${integration.detail ? `: ${integration.detail}` : "."}`,
		);
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
}

/** Per-worktree plan: a risk on one check never weakens another check. */
export function planFeatureFinishRemovals(
	assessment: FeatureFinishAssessment,
): readonly FeatureFinishRemovalPlanEntry[] {
	return assessment.checks
		.filter((check) => check.disposition === "registered")
		.map((check) => ({
			kind: check.kind,
			...(check.agentId ? { agentId: check.agentId } : {}),
			worktreePath: check.worktreePath,
			force: check.requiresForce,
			...(check.acceptedPullRequestHeadSha
				? { acceptedPullRequestHeadSha: check.acceptedPullRequestHeadSha }
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
