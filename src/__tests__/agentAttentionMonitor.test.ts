import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentAttentionMonitor,
	type AgentAttentionMonitorDeps,
} from "../agents/attention/agentAttentionMonitor";
import type {
	AgentAttentionAlert,
	AttentionWatchedAgent,
} from "../agents/attention/agentAttentionNotifier";

describe("AgentAttentionMonitor", () => {
	const workingAgent: AttentionWatchedAgent = {
		id: "a1",
		name: "Agent 1",
		featureId: "f1",
		featureName: "Feature One",
		attentionStatus: "working",
	};

	const waitingAgent: AttentionWatchedAgent = {
		...workingAgent,
		attentionStatus: "waiting_for_user",
		attentionReason: "Asked a question",
	};

	let collect: ReturnType<typeof vi.fn<() => AttentionWatchedAgent[]>>;
	let onAlert: ReturnType<typeof vi.fn<(alert: AgentAttentionAlert) => void>>;
	let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

	function buildMonitor(
		options: { pollIntervalMs: number; nudgeDebounceMs?: number } = {
			pollIntervalMs: 5000,
		},
	): AgentAttentionMonitor {
		const deps: AgentAttentionMonitorDeps = { collect, onAlert, onError };
		return new AgentAttentionMonitor(deps, options);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		collect = vi.fn(() => [workingAgent]);
		onAlert = vi.fn();
		onError = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls on its own clock and fires on the working -> waiting_for_user transition alone", async () => {
		const monitor = buildMonitor({ pollIntervalMs: 5000 });
		monitor.start();

		await vi.advanceTimersByTimeAsync(5000);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(onAlert).not.toHaveBeenCalled();

		// Only the provider-side attention changed — no Feature/Project
		// mutation, no coordinator change. The next poll tick observes the
		// transition itself and notifies exactly once.
		collect.mockReturnValue([waitingAgent]);
		await vi.advanceTimersByTimeAsync(5000);

		expect(onAlert).toHaveBeenCalledTimes(1);
		expect(onAlert).toHaveBeenCalledWith({
			agentId: "a1",
			agentName: "Agent 1",
			featureId: "f1",
			featureName: "Feature One",
			reason: "Asked a question",
		});

		// Still waiting on later ticks: deduplicated, no repeated alert.
		await vi.advanceTimersByTimeAsync(15000);
		expect(onAlert).toHaveBeenCalledTimes(1);

		monitor.dispose();
	});

	it("nudge triggers a coalesced scan off the caller's stack", async () => {
		const monitor = buildMonitor({
			pollIntervalMs: 60000,
			nudgeDebounceMs: 100,
		});
		monitor.start();

		collect.mockReturnValue([waitingAgent]);
		monitor.nudge();
		monitor.nudge();
		monitor.nudge();

		// Not synchronous on the caller's stack:
		expect(collect).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(onAlert).toHaveBeenCalledTimes(1);

		monitor.dispose();
	});

	it("ignores nudges before start and after dispose", async () => {
		const monitor = buildMonitor({
			pollIntervalMs: 60000,
			nudgeDebounceMs: 50,
		});
		monitor.nudge();
		await vi.advanceTimersByTimeAsync(200);
		expect(collect).not.toHaveBeenCalled();

		monitor.start();
		monitor.dispose();
		monitor.nudge();
		await vi.advanceTimersByTimeAsync(200);
		expect(collect).not.toHaveBeenCalled();

		// Poll timer is gone too.
		await vi.advanceTimersByTimeAsync(120000);
		expect(collect).not.toHaveBeenCalled();
	});

	it("isolates collector and alert-handler errors from the polling loop", async () => {
		const monitor = buildMonitor({ pollIntervalMs: 1000 });
		monitor.start();

		collect.mockImplementation(() => {
			throw new Error("probe boom");
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onAlert).not.toHaveBeenCalled();

		collect.mockReturnValue([waitingAgent]);
		onAlert.mockImplementation(() => {
			throw new Error("surface boom");
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(onError).toHaveBeenCalledTimes(2);

		// Loop is still alive after both failures.
		onAlert.mockImplementation(() => {});
		collect.mockReturnValue([]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(collect).toHaveBeenCalledTimes(3);

		monitor.dispose();
	});
});
