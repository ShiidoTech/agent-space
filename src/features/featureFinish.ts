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

export interface FeatureFinishCheck {
	readonly kind: "feature" | "agent";
	readonly agentId?: string;
	readonly branch?: string;
	readonly worktreePath: string;
	readonly disposition: "registered" | "already_removed" | "residue";
	readonly safety?: WorktreeDeletionSafety | BranchRetentionSafety;
	readonly reason?: string;
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
			checks.push({
				kind,
				branch,
				worktreePath: resolvedPath,
				disposition: exists ? "residue" : "already_removed",
				safety,
				...(agentId ? { agentId } : {}),
				...(exists
					? {
							reason: `Git no longer registers ${resolvedPath}, but files remain on disk. Inspect or remove this residue explicitly before finishing.`,
						}
					: {}),
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
		checks.push({
			kind,
			branch,
			worktreePath: resolvedPath,
			disposition: "registered",
			safety,
			...(agentId ? { agentId } : {}),
		});
	};

	check(
		"feature",
		feature.worktreePath,
		feature.branch,
		ctx.featureManager.getBaseBranchName(),
	);
	for (const agent of ctx.agentManager.getAgents(feature.id)) {
		if (!agent.worktreePath) continue;
		const registered = registeredPaths.has(path.resolve(agent.worktreePath));
		const branch = registered
			? ctx.gitClient.readSync(["symbolic-ref", "--quiet", "--short", "HEAD"], {
					cwd: agent.worktreePath,
				})
			: undefined;
		check(
			"agent",
			agent.worktreePath,
			registered
				? branch && branch.exitCode === 0 && !branch.error
					? branch.stdout.trim() || undefined
					: undefined
				: ctx.agentManager.getAgentBranchName(feature, agent.id),
			feature.branch,
			agent.id,
		);
	}

	const reasons = checks.flatMap((entry) => {
		const prefix = entry.kind === "feature" ? "Feature" : "Agent";
		if (entry.reason) return [`${prefix}: ${entry.reason}`];
		return (entry.safety?.reasons ?? []).map(
			(reason) => `${prefix}: ${reason}`,
		);
	});
	return {
		checks,
		reasons,
		safe: checks.every((entry) => entry.safety?.safe === true),
		forceable: checks.every(
			(entry) =>
				entry.disposition !== "residue" && entry.safety?.forceable === true,
		),
		fingerprint: JSON.stringify(
			checks.map(({ kind, agentId, branch, disposition, safety }) => ({
				kind,
				agentId,
				branch,
				disposition,
				safety,
			})),
		),
	};
}

export function parseRegisteredWorktreePaths(output: string): Set<string> {
	return new Set(
		output
			.split(/\r?\n/u)
			.filter((line) => line.startsWith("worktree "))
			.map((line) => path.resolve(line.slice("worktree ".length))),
	);
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
