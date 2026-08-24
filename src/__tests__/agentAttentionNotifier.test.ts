import { describe, expect, it } from "vitest";

import {
	type AttentionWatchedAgent,
	AgentAttentionNotifier,
} from "../agents/attention/agentAttentionNotifier";

function agent(
	id: string,
	attentionStatus: string,
	extra?: Partial<AttentionWatchedAgent>,
): AttentionWatchedAgent {
	return {
		id,
		name: `Agent ${id}`,
		featureId: "f1",
		featureName: "Feature One",
		attentionStatus,
		...extra,
	};
}

describe("AgentAttentionNotifier", () => {
	it("alerts the first time an agent is observed waiting", () => {
		const notifier = new AgentAttentionNotifier();

		const alerts = notifier.scan([agent("a1", "waiting_for_user")]);

		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({
			agentId: "a1",
			agentName: "Agent a1",
			featureId: "f1",
			featureName: "Feature One",
		});
	});

	it("does not repeat while the agent keeps waiting", () => {
		const notifier = new AgentAttentionNotifier();
		notifier.scan([agent("a1", "waiting_for_user")]);

		const alerts = notifier.scan([agent("a1", "waiting_for_user")]);

		expect(alerts).toEqual([]);
	});

	it("re-alerts after the agent left and re-entered the waiting state", () => {
		const notifier = new AgentAttentionNotifier();
		notifier.scan([agent("a1", "waiting_for_user")]);
		notifier.scan([agent("a1", "working")]);

		const alerts = notifier.scan([agent("a1", "waiting_for_user")]);

		expect(alerts).toHaveLength(1);
	});

	it("forgets an agent missing from a scan, so reappearing alerts once more", () => {
		const notifier = new AgentAttentionNotifier();
		notifier.scan([agent("a1", "waiting_for_user")]);

		expect(notifier.scan([])).toEqual([]);
		expect(notifier.scan([agent("a1", "waiting_for_user")])).toHaveLength(1);
	});

	it("never alerts for other attention statuses", () => {
		const notifier = new AgentAttentionNotifier();

		const alerts = notifier.scan([
			agent("w", "working"),
			agent("i", "idle"),
			agent("f", "failed"),
			agent("d", "done"),
			agent("u", "unknown"),
		]);

		expect(alerts).toEqual([]);
	});

	it("carries the attention reason into the alert when present", () => {
		const notifier = new AgentAttentionNotifier();

		const alerts = notifier.scan([
			agent("a1", "waiting_for_user", {
				attentionReason: "Claude asked via AskUserQuestion",
			}),
		]);

		expect(alerts[0]?.reason).toBe("Claude asked via AskUserQuestion");
	});
});
