import { presentAgentState } from "./presentAgentState";
import type { AgentObservation, PresentedAgentState } from "./types";

export interface AgentCardSessionAction {
	kind: "ambiguous" | "unverified";
	label: "Choose session";
	title: string;
	description: string;
	className:
		| "binding-badge binding-ambiguous"
		| "binding-badge binding-unverified";
	tooltip: string;
}

/**
 * Presentation shared by Home and the Feature Sidebar.
 *
 * It keeps the stable Agent Space identity prominent, reports only facts the
 * observation proves, and turns an unresolved provider-session choice into one
 * explicit action instead of repeating the same uncertainty as two statuses.
 */
export interface AgentCardPresentation {
	name: string;
	secondaryTitle?: string;
	primaryState: PresentedAgentState;
	sessionAction?: AgentCardSessionAction;
}

export function presentAgentCard(
	observation: AgentObservation,
): AgentCardPresentation {
	const primaryState = presentPrimaryState(observation);
	const sessionAction = presentSessionAction(observation);

	return {
		name: observation.identity.agentName,
		secondaryTitle: distinctSessionTitle(
			observation.identity.agentName,
			observation.identity.sessionTitle,
		),
		primaryState,
		...(sessionAction ? { sessionAction } : {}),
	};
}

function presentPrimaryState(
	observation: AgentObservation,
): PresentedAgentState {
	const presented = presentAgentState(observation);
	if (
		observation.lifecycle.state !== "running" ||
		observation.attention.state !== "unknown"
	) {
		return presented;
	}

	return {
		label: "Running",
		tone: "normal",
		detail: observation.attention.reason
			? `Activity unknown: ${observation.attention.reason}`
			: "Activity unknown: no current provider evidence",
	};
}

function presentSessionAction(
	observation: AgentObservation,
): AgentCardSessionAction | undefined {
	if (observation.lifecycle.state === "done") return undefined;
	if (
		observation.session.state !== "ambiguous" &&
		observation.session.state !== "unverified"
	) {
		return undefined;
	}

	const detail = observation.session.detail ?? "Provider session is unresolved";
	const remediation =
		observation.session.state === "ambiguous"
			? "Agent Space will not guess. Choose the session explicitly."
			: "Choose a provider session explicitly to restore activity tracking.";

	return {
		kind: observation.session.state,
		label: "Choose session",
		title:
			observation.session.state === "ambiguous"
				? "Session needs confirmation"
				: "Provider session unavailable",
		description:
			observation.session.state === "ambiguous"
				? "Activity stays unknown until you choose the matching provider session."
				: "Choose the matching provider session to restore activity tracking.",
		className: `binding-badge binding-${observation.session.state}`,
		tooltip: `${detail} ${remediation}`,
	};
}

function distinctSessionTitle(
	name: string,
	sessionTitle: string | undefined,
): string | undefined {
	if (!sessionTitle?.trim()) return undefined;
	return normalizeIdentity(name) === normalizeIdentity(sessionTitle)
		? undefined
		: sessionTitle;
}

function normalizeIdentity(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}
