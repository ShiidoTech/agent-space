import type { AgentObservation, PresentedAgentState } from "./types";

/**
 * The only primary-state hierarchy used by Home and the Feature Sidebar.
 * Session binding is deliberately absent: it is a health dimension, not the
 * answer to "what should I understand about this agent now?".
 */
export function presentAgentState(
	observation: AgentObservation,
): PresentedAgentState {
	const { lifecycle, attention } = observation;
	if (observation.startup?.state === "failed") {
		return {
			label: "Startup failed",
			tone: "error",
			detail: observation.startup.error,
		};
	}
	if (observation.startup?.state === "provisioning") {
		return {
			label: "Preparing",
			tone: "normal",
			detail: currentStartupStep(observation),
		};
	}
	if (observation.startup?.state === "starting") {
		return {
			label: "Starting",
			tone: "normal",
			detail: currentStartupStep(observation),
		};
	}

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
	switch (attention.state) {
		case "waiting_for_user":
			return { label: "Needs you", tone: "warning", detail: attention.reason };
		case "failed":
			return { label: "Failed", tone: "error", detail: attention.reason };
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

function currentStartupStep(observation: AgentObservation): string | undefined {
	const startup = observation.startup;
	if (!startup) return undefined;
	return startup.steps.find((step) => step.id === startup.currentStepId)?.label;
}

function lifecycleDetail(observation: AgentObservation): string | undefined {
	return observation.attention.reason ?? observation.session.detail;
}
