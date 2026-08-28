import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentAttentionMonitor,
	type AgentAttentionMonitorDeps,
} from "../agents/attention/agentAttentionMonitor";
import type {
	AgentOperationalTransition,
	AttentionWatchedAgent,
} from "../agents/attention/agentOperationalTransitions";

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

	let collect: ReturnType<
		typeof vi.fn<() => Promise<readonly AttentionWatchedAgent[]>>
	>;
	let onTransition: ReturnType<
		typeof vi.fn<(transition: AgentOperationalTransition) => void>
	>;
	let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

	function buildMonitor(
		options: { pollIntervalMs: number; nudgeDebounceMs?: number } = {
			pollIntervalMs: 5000,
		},
	): AgentAttentionMonitor {
		const deps: AgentAttentionMonitorDeps = { collect, onTransition, onError };
		return new AgentAttentionMonitor(deps, options);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		collect = vi.fn(async () => [workingAgent]);
		onTransition = vi.fn();
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
		// The very first sighting of "working" is itself a working_started
		// transition.
		expect(onTransition).toHaveBeenCalledTimes(1);
		expect(onTransition).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "working_started", agentId: "a1" }),
		);
		onTransition.mockClear();

		// Only the provider-side attention changed — no Feature/Project
		// mutation, no coordinator change. The next poll tick observes the
		// transition itself and notifies exactly once.
		collect.mockResolvedValue([waitingAgent]);
		await vi.advanceTimersByTimeAsync(5000);

		expect(onTransition).toHaveBeenCalledTimes(1);
		expect(onTransition).toHaveBeenCalledWith({
			kind: "attention_required",
			agentId: "a1",
			agentName: "Agent 1",
			featureId: "f1",
			featureName: "Feature One",
			reason: "Asked a question",
		});

		// Still waiting on later ticks: deduplicated, no repeated transition.
		await vi.advanceTimersByTimeAsync(15000);
		expect(onTransition).toHaveBeenCalledTimes(1);

		monitor.dispose();
	});

	it("nudge triggers a coalesced scan off the caller's stack", async () => {
		const monitor = buildMonitor({
			pollIntervalMs: 60000,
			nudgeDebounceMs: 100,
		});
		monitor.start();

		collect.mockResolvedValue([waitingAgent]);
		monitor.nudge();
		monitor.nudge();
		monitor.nudge();

		// Not synchronous on the caller's stack:
		expect(collect).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(onTransition).toHaveBeenCalledTimes(1);

		monitor.dispose();
	});

	it("coalesces in-flight scans instead of stacking them", async () => {
		const monitor = buildMonitor({ pollIntervalMs: 1000 });
		monitor.start();

		let release!: (agents: readonly AttentionWatchedAgent[]) => void;
		collect.mockReturnValue(
			new Promise<readonly AttentionWatchedAgent[]>((resolve) => {
				release = resolve;
			}),
		);

		// Two ticks elapse while the first collection is still in flight:
		// no second concurrent scan is started.
		await vi.advanceTimersByTimeAsync(2000);
		expect(collect).toHaveBeenCalledTimes(1);

		release([waitingAgent]);
		await vi.advanceTimersByTimeAsync(0);
		expect(onTransition).toHaveBeenCalledTimes(1);

		// Collection finished — the loop resumes scanning on later ticks.
		collect.mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(collect).toHaveBeenCalledTimes(2);

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

	it("isolates collector and transition-handler errors from the polling loop", async () => {
		const monitor = buildMonitor({ pollIntervalMs: 1000 });
		monitor.start();

		collect.mockRejectedValue(new Error("probe boom"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onTransition).not.toHaveBeenCalled();

		collect.mockResolvedValue([waitingAgent]);
		onTransition.mockImplementation(() => {
			throw new Error("surface boom");
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(onError).toHaveBeenCalledTimes(2);

		// Loop is still alive after both failures.
		onTransition.mockImplementation(() => {});
		collect.mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(collect).toHaveBeenCalledTimes(3);

		monitor.dispose();
	});
});
