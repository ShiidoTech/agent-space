import { describe, expect, it } from "vitest";

import {
	AgentOperationalTransitionDetector,
	type AttentionWatchedAgent,
} from "../agents/attention/agentOperationalTransitions";

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

describe("AgentOperationalTransitionDetector", () => {
	it("emits attention_required the first time an agent is observed waiting", () => {
		const detector = new AgentOperationalTransitionDetector();

		const transitions = detector.scan([agent("a1", "waiting_for_user")]);

		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			kind: "attention_required",
			agentId: "a1",
			agentName: "Agent a1",
			featureId: "f1",
			featureName: "Feature One",
		});
	});

	it("does not repeat attention_required while the agent keeps waiting", () => {
		const detector = new AgentOperationalTransitionDetector();
		detector.scan([agent("a1", "waiting_for_user")]);

		const transitions = detector.scan([agent("a1", "waiting_for_user")]);

		expect(transitions).toEqual([]);
	});

	it("re-emits attention_required after the agent left and re-entered the waiting state", () => {
		const detector = new AgentOperationalTransitionDetector();
		detector.scan([agent("a1", "waiting_for_user")]);
		detector.scan([agent("a1", "working")]);

		const transitions = detector.scan([agent("a1", "waiting_for_user")]);

		expect(transitions).toHaveLength(1);
		expect(transitions[0]?.kind).toBe("attention_required");
	});

	it("forgets an agent missing from a scan, so reappearing transitions once more", () => {
		const detector = new AgentOperationalTransitionDetector();
		detector.scan([agent("a1", "waiting_for_user")]);

		expect(detector.scan([])).toEqual([]);
		expect(detector.scan([agent("a1", "waiting_for_user")])).toHaveLength(1);
	});

	it("carries the attention reason into the transition when present", () => {
		const detector = new AgentOperationalTransitionDetector();

		const transitions = detector.scan([
			agent("a1", "waiting_for_user", {
				attentionReason: "Claude asked via AskUserQuestion",
			}),
		]);

		expect(transitions[0]?.reason).toBe("Claude asked via AskUserQuestion");
	});

	it("emits failed the first time an agent is observed failed, once per episode", () => {
		const detector = new AgentOperationalTransitionDetector();

		expect(detector.scan([agent("a1", "failed")])[0]?.kind).toBe("failed");
		expect(detector.scan([agent("a1", "failed")])).toEqual([]);

		// Recovers, then fails again: a new episode alerts once more.
		detector.scan([agent("a1", "working")]);
		expect(detector.scan([agent("a1", "failed")])[0]?.kind).toBe("failed");
	});

	it("emits working_started the first time an agent is observed working, once per episode", () => {
		const detector = new AgentOperationalTransitionDetector();

		expect(detector.scan([agent("a1", "working")])[0]?.kind).toBe(
			"working_started",
		);
		expect(detector.scan([agent("a1", "working")])).toEqual([]);
	});

	it("emits turn_completed only on a working -> provider-sourced idle edge, never spamming an already-idle agent", () => {
		const detector = new AgentOperationalTransitionDetector();

		// Idle without ever having been seen working: no completion invented.
		expect(
			detector.scan([agent("a1", "idle", { attentionSource: "provider" })]),
		).toEqual([]);
		// Still idle on the next tick: nothing.
		expect(
			detector.scan([agent("a1", "idle", { attentionSource: "provider" })]),
		).toEqual([]);

		detector.scan([agent("a1", "working")]);
		const transitions = detector.scan([
			agent("a1", "idle", { attentionSource: "provider" }),
		]);
		expect(transitions).toHaveLength(1);
		expect(transitions[0]?.kind).toBe("turn_completed");

		// Repeated idle polls in the same episode: no duplicate.
		expect(
			detector.scan([agent("a1", "idle", { attentionSource: "provider" })]),
		).toEqual([]);
	});

	// PR #122 review, blocker 2: a clean tmux pane exit also resolves to
	// `attentionStatus: "idle"` (AgentAttentionResolver, source "tmux"), but
	// that is not provider-native proof a turn actually completed. Issue
	// #120's own rule: no notification invented from terminal silence.
	it("never emits turn_completed for an idle reading sourced from tmux liveness instead of provider evidence", () => {
		const detector = new AgentOperationalTransitionDetector();
		detector.scan([agent("a1", "working", { attentionSource: "provider" })]);

		const transitions = detector.scan([
			agent("a1", "idle", { attentionSource: "tmux" }),
		]);

		expect(transitions).toEqual([]);
	});

	it("never emits turn_completed for an idle reading with no source at all", () => {
		const detector = new AgentOperationalTransitionDetector();
		detector.scan([agent("a1", "working", { attentionSource: "provider" })]);

		const transitions = detector.scan([agent("a1", "idle")]);

		expect(transitions).toEqual([]);
	});

	it("never emits turn_completed for a working agent settling into lifecycle done", () => {
		const detector = new AgentOperationalTransitionDetector();
		detector.scan([agent("a1", "working")]);

		const transitions = detector.scan([agent("a1", "done")]);

		expect(transitions).toEqual([]);
	});

	it("never emits for unknown/unsupported attention statuses", () => {
		const detector = new AgentOperationalTransitionDetector();

		const transitions = detector.scan([
			agent("u", "unknown"),
			agent("s", "unsupported"),
			agent("d", "done"),
		]);

		expect(transitions).toEqual([]);
	});
});
