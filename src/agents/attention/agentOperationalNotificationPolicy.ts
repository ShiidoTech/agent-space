import type { AgentOperationalTransition } from "./agentOperationalTransitions";

export type AgentOperationalNotificationSeverity =
	| "warning"
	| "information"
	| "error";

export interface AgentOperationalNotification {
	readonly severity: AgentOperationalNotificationSeverity;
	readonly message: string;
	readonly actionLabel: string;
	/** VS Code setting (under `agentSpace.`) that gates this notification. */
	readonly configKey:
		| "notifyWhenAgentsNeedYou"
		| "notifyOnTurnCompleted"
		| "notifyOnAgentFailure";
}

/**
 * Default notification policy for a normalized operational transition
 * (issue #120, section B). Pure presentation — no VS Code imports — so the
 * policy itself stays unit-testable; the host only needs to look up the
 * `configKey` setting and call the matching `vscode.window.show*Message`.
 *
 * `working_started` has no default notification: it exists in the
 * transition stream for future fleet-rollup consumers (issue #120, section
 * D — deferred), but surfacing every agent starting work by default would
 * make the cockpit noisier, not more useful.
 */
export function presentOperationalNotification(
	transition: AgentOperationalTransition,
): AgentOperationalNotification | undefined {
	const featureSuffix = transition.featureName
		? ` (${transition.featureName})`
		: "";
	switch (transition.kind) {
		case "attention_required":
			return {
				severity: "warning",
				message: `${transition.agentName} needs you${featureSuffix}`,
				actionLabel: "Focus terminal",
				configKey: "notifyWhenAgentsNeedYou",
			};
		case "turn_completed":
			return {
				severity: "information",
				message: `${transition.agentName} finished a turn${featureSuffix}`,
				actionLabel: "Open agent",
				configKey: "notifyOnTurnCompleted",
			};
		case "failed":
			return {
				severity: "error",
				message: `${transition.agentName} failed${featureSuffix}`,
				actionLabel: "Open agent",
				configKey: "notifyOnAgentFailure",
			};
		case "working_started":
			return undefined;
	}
}
