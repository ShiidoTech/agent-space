import { describe, expect, it } from "vitest";

import { presentOperationalNotification } from "../agents/attention/agentOperationalNotificationPolicy";
import type { AgentOperationalTransition } from "../agents/attention/agentOperationalTransitions";

function transition(
	kind: AgentOperationalTransition["kind"],
	extra?: Partial<AgentOperationalTransition>,
): AgentOperationalTransition {
	return {
		kind,
		agentId: "a1",
		agentName: "Agent 1",
		featureId: "f1",
		featureName: "Feature One",
		...extra,
	};
}

describe("presentOperationalNotification", () => {
	it("presents attention_required as a warning gated by notifyWhenAgentsNeedYou, with a Focus terminal action", () => {
		const presentation = presentOperationalNotification(
			transition("attention_required"),
		);
		expect(presentation).toMatchObject({
			severity: "warning",
			message: "Agent 1 needs you (Feature One)",
			actionLabel: "Focus terminal",
			configKey: "notifyWhenAgentsNeedYou",
		});
	});

	it("presents turn_completed as an information notice gated by notifyOnTurnCompleted, with an Open agent action", () => {
		const presentation = presentOperationalNotification(
			transition("turn_completed"),
		);
		expect(presentation).toMatchObject({
			severity: "information",
			message: "Agent 1 finished a turn (Feature One)",
			actionLabel: "Open agent",
			configKey: "notifyOnTurnCompleted",
		});
	});

	it("presents failed as an error gated by notifyOnAgentFailure, with an Open agent action", () => {
		const presentation = presentOperationalNotification(transition("failed"));
		expect(presentation).toMatchObject({
			severity: "error",
			message: "Agent 1 failed (Feature One)",
			actionLabel: "Open agent",
			configKey: "notifyOnAgentFailure",
		});
	});

	it("has no default notification for working_started", () => {
		expect(
			presentOperationalNotification(transition("working_started")),
		).toBeUndefined();
	});

	it("omits the feature suffix when the transition carries no feature name", () => {
		const presentation = presentOperationalNotification(
			transition("attention_required", { featureName: undefined }),
		);
		expect(presentation?.message).toBe("Agent 1 needs you");
	});
});
