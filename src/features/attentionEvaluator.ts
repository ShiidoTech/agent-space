import type { FeatureGitObservations } from "../git/featureGitObservations";
import type { IntegrationEvaluation } from "./integrationEvaluator";
import type { FeatureRuntimeObservation } from "./runtimeObservation";

export type AttentionSeverity = "info" | "warning" | "error";

export interface AttentionProblem {
	readonly code: string;
	readonly severity: AttentionSeverity;
	readonly summary: string;
	readonly detail: string;
	readonly evidence: Readonly<Record<string, unknown>>;
}

export interface AttentionEvaluationInput {
	readonly git: FeatureGitObservations;
	readonly integration: IntegrationEvaluation;
	readonly runtime: FeatureRuntimeObservation;
	readonly isBaseFeature?: boolean;
}

export function evaluateAttention(
	input: AttentionEvaluationInput,
): readonly AttentionProblem[] {
	const problems: AttentionProblem[] = [];
	const { git, runtime } = input;

	if (git.repository.status === "unknown") {
		problems.push(
			problem(
				"git_observation_unknown",
				"error",
				"Git state unavailable",
				git.repository.message ?? "The local repository could not be observed.",
				{ reason: git.repository.reason },
			),
		);
	}
	if (git.worktree.status === "known" && !git.worktree.value.present) {
		problems.push(
			problem(
				"worktree_missing",
				"error",
				"Worktree missing",
				"The feature worktree is not present in the local Git worktree list.",
				git.worktree.value,
			),
		);
	}
	if (git.worktree.status === "unknown") {
		problems.push(
			problem(
				"worktree_observation_unknown",
				"error",
				"Worktree state unavailable",
				git.worktree.message ?? "The feature worktree could not be observed.",
				{ reason: git.worktree.reason, observed: git.worktree.observed },
			),
		);
	}
	if (git.branch.status === "known" && git.branch.value.detached) {
		problems.push(
			problem(
				"detached_head",
				"error",
				"Detached HEAD",
				"The feature worktree is not attached to a branch.",
				{ ...git.branch.value },
			),
		);
	} else if (
		git.branch.status === "known" &&
		!git.branch.value.matchesExpected
	) {
		problems.push(
			problem(
				"branch_mismatch",
				"error",
				"Unexpected branch checked out",
				"The worktree is not on the feature branch that Agent Space expects.",
				{ ...git.branch.value },
			),
		);
	}
	if (git.workingTree.status === "known") {
		const changes = git.workingTree.value;
		if (changes.conflicted.length > 0) {
			problems.push(
				problem(
					"working_tree_conflicted",
					"error",
					"Merge conflicts need resolution",
					"The working tree contains conflicted files.",
					{ files: changes.conflicted },
				),
			);
		}
		if (
			changes.staged.length > 0 ||
			changes.unstaged.length > 0 ||
			changes.untracked.length > 0
		) {
			problems.push(
				problem(
					"working_tree_changes",
					"warning",
					"Uncommitted work",
					"The working tree contains staged, unstaged, or untracked changes.",
					{
						staged: changes.staged,
						unstaged: changes.unstaged,
						untracked: changes.untracked,
					},
				),
			);
		}
	} else {
		problems.push(
			problem(
				"working_tree_unknown",
				"warning",
				"Working-tree state unknown",
				git.workingTree.message ??
					"Working-tree changes could not be observed.",
				{ reason: git.workingTree.reason },
			),
		);
	}
	if (git.upstream.status === "unknown") {
		problems.push(
			problem(
				"upstream_unknown",
				"warning",
				"Upstream state unknown",
				git.upstream.message ??
					"The configured upstream ref could not be observed.",
				{ reason: git.upstream.reason, observed: git.upstream.observed },
			),
		);
	}
	if (
		git.featureDelta.status === "known" &&
		git.featureDelta.value.leftOnly > 0 &&
		git.featureDelta.value.rightOnly > 0
	) {
		problems.push(
			problem(
				"feature_diverged",
				"warning",
				"Feature and base have diverged",
				"Both refs contain commits absent from the other.",
				{ ...git.featureDelta.value },
			),
		);
	}
	if (!input.isBaseFeature && input.integration.status === "unknown") {
		problems.push(
			problem(
				"integration_unknown",
				"warning",
				"Integration state unknown",
				"Local Git evidence is insufficient to determine whether this feature was integrated.",
				{ reason: input.integration.reason, ...input.integration.evidence },
			),
		);
	}

	if (runtime.agents.status === "unknown") {
		problems.push(
			problem(
				"agent_runtime_unknown",
				"warning",
				"Agent runtime unavailable",
				runtime.agents.detail ??
					"Current agent runtime evidence could not be read.",
				{ reason: runtime.agents.reason },
			),
		);
	} else {
		for (const { agent, tmuxAlive } of runtime.agents.value) {
			if (agent.status === "errored" || agent.attentionStatus === "failed") {
				problems.push(
					problem(
						"agent_failed",
						"error",
						`${agent.name} failed`,
						agent.attentionReason ??
							agent.lastError ??
							"The agent reported a failure.",
						{ agentId: agent.id, status: agent.status },
					),
				);
			} else if (agent.attentionStatus === "waiting_for_user") {
				problems.push(
					problem(
						"agent_waiting_for_user",
						"warning",
						`${agent.name} needs attention`,
						agent.attentionReason ?? "The agent is waiting for user input.",
						{ agentId: agent.id },
					),
				);
			}
			if (
				tmuxAlive.status === "known" &&
				!tmuxAlive.value &&
				agent.status === "running"
			) {
				problems.push(
					problem(
						"agent_tmux_missing",
						"error",
						`${agent.name} terminal is missing`,
						"The agent is marked running but its tmux session is not alive.",
						{ agentId: agent.id },
					),
				);
			}
		}
	}

	if (runtime.services.status === "unknown") {
		problems.push(
			problem(
				"service_runtime_unknown",
				"warning",
				"Service runtime unavailable",
				runtime.services.detail ??
					"Current service runtime evidence could not be read.",
				{ reason: runtime.services.reason },
			),
		);
	} else {
		for (const { service, tmuxAlive } of runtime.services.value) {
			if (service.status === "errored") {
				problems.push(
					problem(
						"service_failed",
						"error",
						`${service.name} failed`,
						"The service process exited with an error.",
						{ serviceId: service.id },
					),
				);
			} else if (
				tmuxAlive.status === "known" &&
				!tmuxAlive.value &&
				service.status === "running"
			) {
				problems.push(
					problem(
						"service_tmux_missing",
						"error",
						`${service.name} terminal is missing`,
						"The service is marked running but its tmux session is not alive.",
						{ serviceId: service.id },
					),
				);
			}
		}
	}

	return problems;
}

function problem(
	code: string,
	severity: AttentionSeverity,
	summary: string,
	detail: string,
	evidence: Readonly<Record<string, unknown>>,
): AttentionProblem {
	return { code, severity, summary, detail, evidence };
}

export class AttentionEvaluator {
	evaluate(input: AttentionEvaluationInput): readonly AttentionProblem[] {
		return evaluateAttention(input);
	}
}
