import type { FeatureGitObservations } from "../git/featureGitObservations";
import type { GitHubObservation } from "../github/githubObservation";
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
	readonly github?: GitHubObservation;
	readonly integration: IntegrationEvaluation;
	readonly runtime: FeatureRuntimeObservation;
	readonly source?: {
		readonly status: "known" | "unknown";
		readonly reason?: string;
		readonly detail?: string;
	};
	readonly isBaseFeature?: boolean;
}

export function evaluateAttention(
	input: AttentionEvaluationInput,
): readonly AttentionProblem[] {
	const problems: AttentionProblem[] = [];
	const { git, runtime } = input;
	if (input.source?.status === "unknown") {
		problems.push(
			problem(
				"feature_source_unknown",
				"error",
				"Feature source state unavailable",
				input.source.detail ??
					"The persisted feature list could not be read; membership may be stale.",
				{ reason: input.source.reason },
			),
		);
	}

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

	// GitHub pull-request problems. "GitHub not configured" is a normal,
	// informational condition — never a permanent red error the user cannot act
	// on. Severity follows how concretely the user can fix the state.
	if (!input.isBaseFeature && input.github) {
		const github = input.github;
		const integrationOutcome =
			input.integration.status === "known"
				? input.integration.outcome
				: undefined;

		if (
			github.status === "unavailable" ||
			github.status === "error" ||
			(github.status === "unknown" &&
				github.reason !== "ambiguous_pull_requests")
		) {
			problems.push(
				problem(
					"pull_request_observation_unavailable",
					"info",
					"Pull request state unavailable",
					detailFor(github) ??
						"GitHub pull request evidence is unavailable; integration may not be fully verified.",
					githubStatusEvidence(github),
				),
			);
		}

		if (github.status === "known" && github.resolution.outcome === "selected") {
			const pull = github.resolution.pull;
			const expectedBaseRef = github.expectedBaseRef;
			if (expectedBaseRef !== undefined && pull.baseRef !== expectedBaseRef) {
				problems.push(
					problem(
						"pull_request_base_mismatch",
						"warning",
						"Pull request targets a different base branch",
						`PR #${pull.number} targets "${pull.baseRef}", but Agent Space's base is "${expectedBaseRef}". The PR does not integrate towards the expected target.`,
						{
							number: pull.number,
							prBase: pull.baseRef,
							agentSpaceBase: expectedBaseRef,
						},
					),
				);
			}
			if (
				pull.state === "open" &&
				input.git.feature.status === "known" &&
				pull.headSha.toLowerCase() !== input.git.feature.value.sha.toLowerCase()
			) {
				problems.push(
					problem(
						"pull_request_head_mismatch",
						"info",
						"Local head differs from PR head",
						`PR #${pull.number} is at @${pull.headSha.slice(0, 12)}, while the local feature head is @${input.git.feature.value.sha.slice(0, 12)}.`,
						{
							number: pull.number,
							prHeadSha: pull.headSha,
							localHeadSha: input.git.feature.value.sha,
						},
					),
				);
			}
		}

		if (
			github.status === "unknown" &&
			github.reason === "ambiguous_pull_requests"
		) {
			problems.push(
				problem(
					"pull_request_ambiguous",
					"warning",
					"Multiple pull request candidates",
					"Several pull requests match this feature and none was selected automatically.",
					{
						numbers: github.pulls?.map((pull) => pull.number) ?? [],
					},
				),
			);
		}

		if (integrationOutcome === "new_work_after_integration") {
			const githubEvidence = input.integration.evidence.github;
			problems.push(
				problem(
					"new_work_after_integration",
					"info",
					"New work after integration",
					"The feature branch contains commits that were created after its pull request was merged.",
					{
						commitsAfterIntegration: githubEvidence?.commitsAfterIntegration,
					},
				),
			);
		}
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

function detailFor(observation: GitHubObservation): string | undefined {
	if (observation.status === "error") return observation.detail;
	if (observation.status === "unavailable") return observation.detail;
	if (observation.status === "unknown") return observation.detail;
	return undefined;
}

function githubStatusEvidence(
	observation: GitHubObservation,
): Readonly<Record<string, unknown>> {
	switch (observation.status) {
		case "known":
			return { status: observation.status };
		case "unavailable":
			return { status: observation.status, reason: observation.reason };
		case "unknown":
			return { status: observation.status, reason: observation.reason };
		case "error":
			return {
				status: observation.status,
				reason: observation.reason,
				detail: observation.detail,
			};
	}
}

export class AttentionEvaluator {
	evaluate(input: AttentionEvaluationInput): readonly AttentionProblem[] {
		return evaluateAttention(input);
	}
}
