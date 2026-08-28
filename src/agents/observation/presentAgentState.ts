import type { AgentObservation, PresentedAgentState } from "./types";

/**
 * The only primary-state hierarchy used by Home and the Feature Sidebar.
 * Session binding is deliberately absent: it is a health dimension, not the
 * answer to "what should I understand about this agent now?".
 */
export function presentAgentState(
	observation: AgentObservation,
): PresentedAgentState {
	const { lifecycle, attention, review } = observation;

	if (lifecycle.state === "errored") {
		return {
			label: "Error",
			tone: "error",
			detail: lifecycleDetail(observation),
		};
	}
	if (lifecycle.state === "done") {
		return { label: "Done", tone: "muted" };
	}
	if (lifecycle.state === "stopped") {
		return { label: "Stopped", tone: "muted" };
	}
	if (lifecycle.state === "unknown") {
		return {
			label: "Unknown",
			tone: "warning",
			detail: lifecycle.reason ?? "Agent lifecycle could not be observed",
		};
	}
	// Priority (issue #120, PR2 review round 2, blocker 3): Needs you > Failed
	// > Ready for review > Working > Idle/Unknown/Unsupported. A pending
	// review receipt is independent of the current runtime attention
	// reading — it stays true until the user actually opens this agent, so
	// it must win over "Working" (an autonomous next turn already started)
	// and over "Unknown"/"Unsupported" (the provider went quiet or lost
	// structured evidence) alike, not just over plain "Idle". Only the two
	// higher-priority live-attention states can still eclipse it.
	if (attention.state === "waiting_for_user") {
		return { label: "Needs you", tone: "warning", detail: attention.reason };
	}
	if (attention.state === "failed") {
		return { label: "Failed", tone: "error", detail: attention.reason };
	}
	if (review.pending && lifecycle.state === "running") {
		return {
			label: "Ready for review",
			tone: "review",
			detail: attention.reason ?? "Finished a turn — not yet reviewed",
		};
	}
	switch (attention.state) {
		case "working":
			return { label: "Working", tone: "working", detail: attention.reason };
		case "idle":
			if (lifecycle.state === "running") {
				return { label: "Idle", tone: "normal", detail: attention.reason };
			}
			break;
		case "unsupported":
			if (lifecycle.state === "running") {
				return {
					label: "Running",
					tone: "normal",
					detail: attention.reason ?? "Activity tracking unavailable",
				};
			}
			break;
	}

	if (lifecycle.state === "starting") {
		return { label: "Starting", tone: "normal" };
	}
	if (lifecycle.state === "running") {
		return {
			label: "Unknown",
			tone: "muted",
			detail: attention.reason ?? "No current attention evidence",
		};
	}
	return { label: "Unknown", tone: "muted" };
}

function lifecycleDetail(observation: AgentObservation): string | undefined {
	return observation.attention.reason ?? observation.session.detail;
}
