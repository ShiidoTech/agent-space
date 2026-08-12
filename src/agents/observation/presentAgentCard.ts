import { presentAgentState } from "./presentAgentState";
import type { AgentObservation, PresentedAgentState } from "./types";

/**
 * Presentation shared by Home and the Feature Sidebar.
 *
 * It keeps the stable Agent Space identity prominent, reports only facts the
 * observation proves, and keeps provider-session recovery out of the normal
 * card. Ambiguous candidates are diagnostics, not conversations the user is
 * expected to identify for Agent Space.
 */
export interface AgentCardPresentation {
	name: string;
	secondaryTitle?: string;
	primaryState: PresentedAgentState;
}

export function presentAgentCard(
	observation: AgentObservation,
): AgentCardPresentation {
	const primaryState = presentPrimaryState(observation);
	return {
		name: observation.identity.agentName,
		secondaryTitle: distinctSessionTitle(
			observation.identity.agentName,
			observation.identity.sessionTitle,
		),
		primaryState,
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
