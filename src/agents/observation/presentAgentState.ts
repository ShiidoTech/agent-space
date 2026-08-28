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
	switch (attention.state) {
		case "waiting_for_user":
			return { label: "Needs you", tone: "warning", detail: attention.reason };
		case "failed":
			return { label: "Failed", tone: "error", detail: attention.reason };
		case "working":
			return { label: "Working", tone: "working", detail: attention.reason };
		case "idle":
			if (lifecycle.state === "running") {
				if (review.pending) {
					return {
						label: "Ready for review",
						tone: "review",
						detail: attention.reason ?? "Finished a turn — not yet reviewed",
					};
				}
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
