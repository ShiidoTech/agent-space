import type { FeatureDiffFile } from "../git/featureGitObservations";
import type { ProjectReferenceBranchHealth } from "../projects/referenceBranchHealth";
import type { AttentionProblem } from "./attentionEvaluator";
import type { FeatureSnapshot } from "./featureSnapshot";

export type FeatureCockpitTone = "normal" | "muted" | "warning" | "error";

export interface FeatureCockpitWork {
	readonly workingTree:
		| { readonly status: "unknown"; readonly label: "Unknown" }
		| {
				readonly status: "known";
				readonly label: string;
				readonly pending: number;
				readonly staged: readonly string[];
				readonly unstaged: readonly string[];
				readonly untracked: readonly string[];
				readonly conflicted: readonly string[];
				readonly tone: FeatureCockpitTone;
		  };
	readonly committed:
		| { readonly status: "unknown"; readonly label: "Unknown" }
		| {
				readonly status: "known";
				readonly label: string;
				readonly featureCommits: number;
				readonly baseCommits: number;
				readonly files?: readonly FeatureDiffFile[];
				readonly filesChanged?: number;
				readonly insertions?: number;
				readonly deletions?: number;
		  };
}

export interface FeatureCockpitDelivery {
	readonly source: {
		readonly label: string;
		readonly tone: FeatureCockpitTone;
		readonly detail?: string;
	};
	readonly target: { readonly label: string; readonly detail?: string };
	readonly tracking: {
		readonly label: string;
		readonly tone: FeatureCockpitTone;
	};
	readonly pullRequest: {
		readonly label: string;
		readonly tone: FeatureCockpitTone;
		readonly number?: number;
		readonly url?: string;
	};
	readonly integration: {
		readonly label: string;
		readonly tone: FeatureCockpitTone;
		readonly detail?: string;
	};
}

export type FeatureCockpitPrimaryAction =
	| { readonly kind: "refresh_evidence"; readonly label: "Refresh evidence" }
	| {
			readonly kind: "open_agent";
			readonly label: string;
			readonly agentId: string;
	  }
	| { readonly kind: "open_workspace"; readonly label: "Continue in VS Code" }
	| {
			readonly kind: "open_pull_request";
			readonly label: string;
			readonly number: number;
	  }
	| { readonly kind: "create_pull_request"; readonly label: "Create PR" }
	| { readonly kind: "review_finish"; readonly label: "Review finish" };

export interface FeatureCockpitPresentation {
	/** One human-facing state shared by every Feature surface. */
	readonly summary: {
		readonly label: string;
		readonly tone: FeatureCockpitTone;
		readonly detail?: string;
	};
	readonly alerts: readonly AttentionProblem[];
	readonly hiddenAlertCount: number;
	readonly work: FeatureCockpitWork;
	readonly delivery: FeatureCockpitDelivery;
	readonly runtime: {
		readonly label: string;
		readonly tone: FeatureCockpitTone;
	};
	readonly primaryAction: FeatureCockpitPrimaryAction;
	readonly observedAt: string;
}

const DECISIONAL_INFO = new Set([
	"new_work_after_integration",
	"pull_request_head_mismatch",
]);

const REFRESH_EVIDENCE_CODES = new Set([
	"feature_source_unknown",
	"git_observation_unknown",
	"worktree_missing",
	"worktree_observation_unknown",
	"working_tree_unknown",
	"integration_unknown",
	"agent_runtime_unknown",
	"service_runtime_unknown",
]);

const OPEN_WORKSPACE_CODES = new Set([
	"working_tree_conflicted",
	"working_tree_changes",
	"detached_head",
	"branch_mismatch",
	"pull_request_head_mismatch",
	"new_work_after_integration",
	"continuation_outside_delivery",
]);

/**
 * Shared human state shown whenever the Feature has an actionable attention
 * problem. Each problem maps to a specific state so the sidebar badge and the
 * Feature page headline say *what* is wrong rather than the catch-all
 * "Needs you". "Needs you" is reserved for cases where an agent is genuinely
 * waiting on the user (or has failed and needs a decision).
 */
const PROBLEM_STATE_LABELS: Record<string, string> = {
	// An agent is actively waiting on the user.
	agent_waiting_for_user: "Needs you",
	agent_failed: "Agent failed",
	agent_tmux_missing: "Agent terminal missing",
	service_failed: "Service failed",
	service_tmux_missing: "Service terminal missing",
	// Working tree / committed state.
	working_tree_changes: "In progress",
	working_tree_conflicted: "Merge conflicts",
	working_tree_unknown: "Evidence unavailable",
	// Workspace / branch problems.
	detached_head: "Detached HEAD",
	branch_mismatch: "Unexpected branch",
	worktree_missing: "Worktree missing",
	worktree_observation_unknown: "Evidence unavailable",
	// Unavailable evidence / runtime.
	feature_source_unknown: "Evidence unavailable",
	git_observation_unknown: "Evidence unavailable",
	integration_unknown: "Evidence unavailable",
	agent_runtime_unknown: "Runtime unknown",
	service_runtime_unknown: "Runtime unknown",
	// Delivery / upstream.
	upstream_unknown: "Evidence unavailable",
	delivery_relation_unknown: "Evidence unavailable",
	active_delivery_diverged: "Delivery diverged",
	feature_diverged: "Diverged",
	continuation_outside_delivery: "Work outside delivery",
	new_work_after_integration: "New work after integration",
	// Pull requests.
	pull_request_ambiguous: "Several PRs",
	pull_request_base_mismatch: "PR base mismatch",
	pull_request_head_mismatch: "PR head mismatch",
};

function presentProblemState(problem: AttentionProblem): string {
	return PROBLEM_STATE_LABELS[problem.code] ?? "Needs attention";
}

export function presentFeatureCockpit(
	snapshot: FeatureSnapshot,
	referenceHealth?: ProjectReferenceBranchHealth,
): FeatureCockpitPresentation {
	const actionable = snapshot.attention
		.filter(
			(item) =>
				item.severity === "error" ||
				item.severity === "warning" ||
				DECISIONAL_INFO.has(item.code),
		)
		.sort((left, right) => alertPriority(left) - alertPriority(right));
	const alerts = actionable.slice(0, 3);
	const primaryAction = choosePrimaryAction(snapshot, referenceHealth);

	return {
		summary: presentSummary(snapshot, alerts, primaryAction),
		alerts,
		hiddenAlertCount: Math.max(0, actionable.length - alerts.length),
		work: presentWork(snapshot),
		delivery: presentDelivery(snapshot),
		runtime: presentRuntime(snapshot),
		primaryAction,
		observedAt: snapshot.observedAt,
	};
}

function presentSummary(
	snapshot: FeatureSnapshot,
	alerts: readonly AttentionProblem[],
	primaryAction: FeatureCockpitPrimaryAction,
): FeatureCockpitPresentation["summary"] {
	const primaryAlert = alerts[0];
	if (primaryAlert) {
		return {
			label: presentProblemState(primaryAlert),
			tone: primaryAlert.severity === "error" ? "error" : "warning",
			detail: `${primaryAlert.summary} — ${primaryAlert.detail}`,
		};
	}
	if (
		snapshot.git.workingTree.status === "known" &&
		(snapshot.git.workingTree.value.staged.length > 0 ||
			snapshot.git.workingTree.value.unstaged.length > 0 ||
			snapshot.git.workingTree.value.untracked.length > 0 ||
			snapshot.git.workingTree.value.conflicted.length > 0)
	) {
		return {
			label: "In progress",
			tone: "normal",
			detail: "The worktree contains changes that are not committed yet.",
		};
	}

	switch (primaryAction.kind) {
		case "refresh_evidence":
			return {
				label: "Evidence unavailable",
				tone: "warning",
				detail: "Refresh before deciding what to do next.",
			};
		case "open_agent":
			return { label: "Needs you", tone: "warning" };
		case "open_pull_request":
			return {
				label: `PR #${primaryAction.number} open`,
				tone: "normal",
				detail: "Delivery is awaiting review or integration.",
			};
		case "create_pull_request":
			return {
				label: "Ready for PR",
				tone: "normal",
				detail: "Committed Feature work has no pull request.",
			};
		case "review_finish":
			return {
				label: "Ready to finish",
				tone: "normal",
				detail: presentCompletionProof(snapshot),
			};
		case "open_workspace":
			break;
	}

	if (
		snapshot.integration.status === "known" &&
		snapshot.integration.outcome === "new_work_after_integration"
	) {
		return {
			label: "New work after integration",
			tone: "warning",
			detail:
				"The active checkout contains work beyond the delivered revision.",
		};
	}
	if (
		snapshot.integration.status === "known" &&
		snapshot.integration.outcome === "integrated_by_ancestry"
	) {
		return {
			label: "Integrated locally",
			tone: "normal",
			detail: "The Feature revision is present in the local target branch.",
		};
	}
	if (
		snapshot.integration.status === "known" &&
		snapshot.integration.outcome === "no_feature_commits"
	) {
		const featureSha = snapshot.git.feature;
		const base = snapshot.git.base;
		// `no_feature_commits` fires when the Feature tip equals its creation
		// point and is already reachable from the target branch. If the target
		// branch has moved past that commit, the Feature's work is in the base —
		// it is integrated, not "not started". Only a Feature still parked
		// exactly on the current base tip has genuinely not started.
		const baseMovedPast =
			featureSha.status === "known" &&
			base.status === "known" &&
			featureSha.value.sha.toLowerCase() !== base.value.sha.toLowerCase();
		return baseMovedPast
			? {
					label: "Integrated",
					tone: "normal",
					detail:
						"The Feature branch is already in the target branch; no pending commits.",
				}
			: { label: "Not started", tone: "muted" };
	}
	return { label: "In progress", tone: "normal" };
}

function presentCompletionProof(snapshot: FeatureSnapshot): string {
	const local =
		snapshot.integration.status === "known" &&
		(snapshot.integration.outcome === "integrated_by_ancestry" ||
			snapshot.integration.outcome === "integrated_by_pull_request")
			? `present in ${snapshot.git.base.status === "known" ? snapshot.git.base.value.ref : "local target"}`
			: undefined;
	const github = snapshot.github;
	if (
		github.status === "known" &&
		github.resolution.outcome === "selected" &&
		github.resolution.pull.state === "merged"
	) {
		return `PR #${github.resolution.pull.number} merged${local ? ` · ${local}` : ""}`;
	}
	return local ?? "Integration is proven and the working tree is clean.";
}

function presentWork(snapshot: FeatureSnapshot): FeatureCockpitWork {
	const workingTree = snapshot.git.workingTree;
	const working: FeatureCockpitWork["workingTree"] =
		workingTree.status === "unknown"
			? { status: "unknown", label: "Unknown" }
			: (() => {
					const changes = workingTree.value;
					const pending =
						changes.staged.length +
						changes.unstaged.length +
						changes.untracked.length +
						changes.conflicted.length;
					return {
						status: "known" as const,
						label: pending === 0 ? "Clean" : `${pending} pending`,
						pending,
						staged: changes.staged,
						unstaged: changes.unstaged,
						untracked: changes.untracked,
						conflicted: changes.conflicted,
						tone:
							changes.conflicted.length > 0
								? ("error" as const)
								: pending > 0
									? ("warning" as const)
									: ("normal" as const),
					};
				})();

	const delta = snapshot.git.featureDelta;
	const diff = snapshot.git.featureDiff;
	const committed: FeatureCockpitWork["committed"] =
		delta.status === "unknown"
			? { status: "unknown", label: "Unknown" }
			: {
					status: "known",
					label: `${delta.value.rightOnly} commit${delta.value.rightOnly === 1 ? "" : "s"} on Feature`,
					featureCommits: delta.value.rightOnly,
					baseCommits: delta.value.leftOnly,
					...(diff.status === "known"
						? {
								files: diff.value.files,
								filesChanged: diff.value.filesChanged,
								insertions: diff.value.insertions,
								deletions: diff.value.deletions,
							}
						: {}),
				};
	return { workingTree: working, committed };
}

function presentDelivery(snapshot: FeatureSnapshot): FeatureCockpitDelivery {
	const base = snapshot.git.base;
	const target =
		base.status === "known"
			? {
					label: base.value.ref,
					detail: `@${base.value.sha.slice(0, 12)}`,
				}
			: { label: "Unknown" };
	const upstream = snapshot.git.upstream;
	const divergence = snapshot.git.upstreamDivergence;
	let tracking: FeatureCockpitDelivery["tracking"];
	if (upstream.status === "unknown" || divergence.status === "unknown") {
		tracking = { label: "Push state unknown", tone: "warning" };
	} else if (upstream.value.upstream === null || divergence.value === null) {
		tracking = {
			label: "Push state unknown · tracking branch not configured",
			tone: "muted",
		};
	} else {
		tracking = {
			label:
				divergence.value.rightOnly === 0 && divergence.value.leftOnly === 0
					? `Matches local tracking ref ${upstream.value.upstream.ref} · remote head not verified`
					: `${divergence.value.rightOnly} ahead · ${divergence.value.leftOnly} behind local ${upstream.value.upstream.ref} · remote head not verified`,
			tone:
				divergence.value.leftOnly > 0 || divergence.value.rightOnly > 0
					? "warning"
					: "muted",
		};
	}

	return {
		source: presentDeliverySource(snapshot),
		target,
		tracking,
		pullRequest: presentPullRequest(snapshot),
		integration: presentIntegration(snapshot),
	};
}

function presentDeliverySource(
	snapshot: FeatureSnapshot,
): FeatureCockpitDelivery["source"] {
	const delivery = snapshot.delivery;
	if (!delivery) {
		return {
			label: snapshot.feature.primaryBranchRef ?? snapshot.feature.branch,
			tone: "muted",
			detail: "Delivery relation not observed",
		};
	}
	if (delivery.head.status === "unknown") {
		return {
			label: delivery.branchRef,
			tone: "warning",
			detail: "Delivery head unknown",
		};
	}
	const head = `@${delivery.head.value.sha.slice(0, 12)}`;
	const via = delivery.deliveredVia;
	if (via && via.branchRef !== delivery.branchRef) {
		const count =
			delivery.commitsAfter.status === "known"
				? delivery.commitsAfter.value.count
				: undefined;
		const beyond =
			count !== undefined && count > 0
				? ` · ${count} commit${count === 1 ? "" : "s"} on ${snapshot.feature.branch} beyond ${delivery.branchRef}`
				: "";
		return {
			label: `${delivery.branchRef} ${head}`,
			tone: "normal",
			detail: `Delivered via ${via.branchRef} @${via.head.sha.slice(0, 12)} · PR #${via.pullNumber}${beyond}`,
		};
	}
	if (delivery.activeRelation.status === "unknown") {
		return {
			label: `${delivery.branchRef} ${head}`,
			tone: "warning",
			detail: "Active branch relation unknown",
		};
	}
	if (!delivery.activeRelation.value.isAncestor) {
		return {
			label: `${delivery.branchRef} ${head}`,
			tone: "warning",
			detail: `${snapshot.feature.branch} does not descend from delivery`,
		};
	}
	if (delivery.commitsAfter.status === "unknown") {
		return {
			label: `${delivery.branchRef} ${head}`,
			tone: "warning",
			detail: "Commits after delivery unknown",
		};
	}
	const count = delivery.commitsAfter.value.count;
	return {
		label: `${delivery.branchRef} ${head}`,
		tone: count > 0 ? "warning" : "normal",
		detail:
			count > 0
				? `${snapshot.feature.branch}: ${count} commit${count === 1 ? "" : "s"} beyond delivery`
				: snapshot.feature.branch === delivery.branchRef
					? "Active branch is the delivery branch"
					: `${snapshot.feature.branch} matches delivery head`,
	};
}

function presentPullRequest(
	snapshot: FeatureSnapshot,
): FeatureCockpitDelivery["pullRequest"] {
	const github = snapshot.github;
	if (github.status === "known") {
		if (github.resolution.outcome === "no_pr") {
			return { label: "No PR observed", tone: "muted" };
		}
		if (github.resolution.outcome === "ambiguous") {
			return { label: "Several PR candidates", tone: "warning" };
		}
		const pull = github.resolution.pull;
		const state =
			pull.state === "open"
				? pull.draft
					? "draft"
					: "open"
				: pull.state === "merged"
					? "merged into"
					: "closed without merge · target";
		return {
			label: `PR #${pull.number} ${state} ${pull.baseRef}`,
			tone:
				pull.state === "closed"
					? "warning"
					: pull.state === "merged"
						? "normal"
						: "normal",
			number: pull.number,
			url: pull.url,
		};
	}
	if (
		github.status === "unknown" &&
		github.reason === "ambiguous_pull_requests"
	) {
		return { label: "Several PR candidates", tone: "warning" };
	}
	return { label: "PR state unavailable", tone: "muted" };
}

function presentIntegration(
	snapshot: FeatureSnapshot,
): FeatureCockpitDelivery["integration"] {
	const integration = snapshot.integration;
	if (integration.status === "unknown") {
		return {
			label: "Unknown",
			tone: "warning",
			detail: integration.detail ?? integration.reason,
		};
	}
	const commitsAfter = integration.evidence.github?.commitsAfterIntegration;
	switch (integration.outcome) {
		case "no_feature_commits":
			return { label: "No Feature commits", tone: "muted" };
		case "not_integrated":
			return { label: "Not integrated", tone: "warning" };
		case "integrated_by_ancestry":
			return { label: "Integrated into local base", tone: "normal" };
		case "integrated_by_pull_request":
			return { label: "Integrated by PR", tone: "normal" };
		case "integrated_to_other_base":
			return { label: "Integrated into another base", tone: "warning" };
		case "pull_request_open":
			return { label: "PR open", tone: "normal" };
		case "new_work_after_integration":
			return {
				label:
					commitsAfter === undefined
						? "Integrated, then new work"
						: `Integrated, then ${commitsAfter} new commit${commitsAfter === 1 ? "" : "s"}`,
				tone: "warning",
			};
	}
}

function presentRuntime(
	snapshot: FeatureSnapshot,
): FeatureCockpitPresentation["runtime"] {
	if (
		snapshot.runtime.agents.status === "unknown" ||
		snapshot.runtime.services.status === "unknown"
	) {
		return { label: "Runtime state unknown", tone: "warning" };
	}
	const agents = snapshot.runtime.agents.value;
	const services = snapshot.runtime.services.value;
	const running = agents.filter(
		({ agent }) => agent.status === "running",
	).length;
	const needsYou = agents.filter(
		({ agent }) =>
			agent.attentionStatus === "waiting_for_user" ||
			agent.attentionStatus === "failed" ||
			agent.status === "errored",
	).length;
	const runningServices = services.filter(
		({ service }) => service.status === "running",
	).length;
	const unknownActivity = agents.filter(
		({ agent }) =>
			agent.status === "running" &&
			(agent.attentionStatus === undefined ||
				agent.attentionStatus === "unknown"),
	).length;
	const unsupportedActivity = agents.filter(
		({ agent }) =>
			agent.status === "running" && agent.attentionStatus === "unsupported",
	).length;
	const limitations = [
		unknownActivity > 0
			? `${unknownActivity} activit${unknownActivity === 1 ? "y" : "ies"} unknown`
			: "",
		unsupportedActivity > 0
			? `${unsupportedActivity} without activity signal`
			: "",
	].filter(Boolean);
	return {
		label: `${running} agent${running === 1 ? "" : "s"} running · ${needsYou} need${needsYou === 1 ? "s" : ""} you · ${runningServices} service${runningServices === 1 ? "" : "s"} running${limitations.length > 0 ? ` · ${limitations.join(" · ")}` : ""}`,
		tone:
			needsYou > 0 || unknownActivity > 0 || unsupportedActivity > 0
				? "warning"
				: "normal",
	};
}

function choosePrimaryAction(
	snapshot: FeatureSnapshot,
	referenceHealth?: ProjectReferenceBranchHealth,
): FeatureCockpitPrimaryAction {
	if (
		hasEssentialUnknownEvidence(snapshot) ||
		snapshot.attention.some((item) => REFRESH_EVIDENCE_CODES.has(item.code))
	) {
		return { kind: "refresh_evidence", label: "Refresh evidence" };
	}
	const agentProblem = snapshot.attention.find(
		(item) =>
			(item.code === "agent_waiting_for_user" ||
				item.code === "agent_failed") &&
			typeof item.evidence.agentId === "string",
	);
	if (agentProblem && typeof agentProblem.evidence.agentId === "string") {
		const agentId = agentProblem.evidence.agentId;
		const agent =
			snapshot.runtime.agents.status === "known"
				? snapshot.runtime.agents.value.find(
						({ agent }) => agent.id === agentId,
					)?.agent
				: undefined;
		return {
			kind: "open_agent",
			label: `Open ${agent?.name ?? "agent"}`,
			agentId,
		};
	}
	if (snapshot.attention.some((item) => OPEN_WORKSPACE_CODES.has(item.code))) {
		return { kind: "open_workspace", label: "Continue in VS Code" };
	}
	if (
		snapshot.github.status === "known" &&
		snapshot.github.resolution.outcome === "selected" &&
		snapshot.github.resolution.pull.state === "open"
	) {
		const number = snapshot.github.resolution.pull.number;
		return {
			kind: "open_pull_request",
			label: `Open PR #${number}`,
			number,
		};
	}
	const upstreamDivergence = snapshot.git.upstreamDivergence;
	if (
		upstreamDivergence.status === "known" &&
		upstreamDivergence.value !== null &&
		upstreamDivergence.value.leftOnly > 0
	) {
		return { kind: "open_workspace", label: "Continue in VS Code" };
	}
	const workingTree = snapshot.git.workingTree;
	const clean =
		workingTree.status === "known" &&
		workingTree.value.staged.length === 0 &&
		workingTree.value.unstaged.length === 0 &&
		workingTree.value.untracked.length === 0 &&
		workingTree.value.conflicted.length === 0;
	const integrated =
		snapshot.integration.status === "known" &&
		(snapshot.integration.outcome === "integrated_by_ancestry" ||
			snapshot.integration.outcome === "integrated_by_pull_request");
	const hasBlockingAttention = snapshot.attention.some(
		(item) => item.severity === "warning" || item.severity === "error",
	);
	const remotelyDelivered =
		snapshot.integration.status === "known" &&
		(snapshot.integration.outcome === "integrated_by_pull_request" ||
			(snapshot.integration.outcome === "integrated_by_ancestry" &&
				referenceHealth?.verifiedRemoteRelation.state === "current" &&
				referenceHealth.remoteFreshness.status === "fresh"));
	if (clean && integrated && remotelyDelivered && !hasBlockingAttention) {
		return { kind: "review_finish", label: "Review finish" };
	}
	if (integrated) {
		return { kind: "open_workspace", label: "Continue in VS Code" };
	}
	const delta = snapshot.git.featureDelta;
	if (
		delta.status === "known" &&
		delta.value.rightOnly > 0 &&
		snapshot.github.status === "known" &&
		snapshot.github.resolution.outcome === "no_pr"
	) {
		return { kind: "create_pull_request", label: "Create PR" };
	}
	return { kind: "open_workspace", label: "Continue in VS Code" };
}

function hasEssentialUnknownEvidence(snapshot: FeatureSnapshot): boolean {
	return (
		snapshot.source.status === "unknown" ||
		snapshot.git.repository.status === "unknown" ||
		snapshot.git.worktree.status === "unknown" ||
		snapshot.git.branch.status === "unknown" ||
		snapshot.git.head.status === "unknown" ||
		snapshot.git.feature.status === "unknown" ||
		snapshot.git.base.status === "unknown" ||
		(snapshot.git.head.status === "known" &&
			snapshot.git.feature.status === "known" &&
			snapshot.git.head.value.sha !== snapshot.git.feature.value.sha) ||
		snapshot.git.upstream.status === "unknown" ||
		snapshot.git.upstreamDivergence.status === "unknown" ||
		snapshot.git.workingTree.status === "unknown" ||
		snapshot.git.featureDelta.status === "unknown" ||
		snapshot.delivery?.head.status === "unknown" ||
		snapshot.delivery?.activeRelation.status === "unknown" ||
		snapshot.delivery?.commitsAfter.status === "unknown" ||
		snapshot.integration.status === "unknown"
	);
}

/**
 * Priority used to pick the badge/headline alert. Explicit so a genuinely
 * user-required action is never shadowed by an earlier, equally-ranked
 * warning: an agent waiting for the user must beat an uncommitted worktree,
 * otherwise the summary would say "In progress" while the primary action is
 * "open_agent". Order: error > agent waiting > other warnings > informational.
 */
function alertPriority(problem: AttentionProblem): number {
	if (problem.severity === "error") return 0;
	if (problem.code === "agent_waiting_for_user") return 1;
	if (problem.severity === "warning") return 2;
	return 3;
}
