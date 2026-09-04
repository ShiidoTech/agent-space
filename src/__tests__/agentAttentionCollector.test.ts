import { describe, expect, it, vi } from "vitest";
import {
	type AttentionCollectableContext,
	collectWatchedAgents,
} from "../agents/attention/agentAttentionCollector";
import { AgentOperationalTransitionDetector } from "../agents/attention/agentOperationalTransitions";
import type { Agent, Feature } from "../types";

describe("collectWatchedAgents (non-blocking contract)", () => {
	const featureA: Feature = {
		id: "f1",
		name: "Feature One",
		branch: "feat/one",
		worktreePath: "/repo/feature-one",
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-03-06T00:00:00Z",
	};
	const featureB = { ...featureA, id: "f2", name: "Feature Two" };

	const runningAgent: Agent = {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: "session-1",
		toolId: "claude",
		status: "running",
		createdAt: "2026-03-06T00:00:00Z",
	};
	const idleAgent: Agent = {
		...runningAgent,
		id: "a2",
		featureId: "f2",
		name: "Agent 2",
		status: "idle",
	};

	function observeTmuxPanesAsyncMock() {
		return vi.fn(async () => ({
			status: "known" as const,
			panes: new Map(),
		}));
	}

	function buildContext(agentsByFeature: Record<string, Agent[]>) {
		const getFeatures = vi.fn();
		const listFeaturesCached = vi.fn(() => [featureA, featureB]);
		const getAgents = vi.fn();
		const getAgentsReadModel = vi.fn((featureId: string) =>
			(agentsByFeature[featureId] ?? []).map((agent) => ({ ...agent })),
		);
		const getAgentsAsync = vi.fn(async (featureId: string) =>
			(agentsByFeature[featureId] ?? []).map((agent) => ({
				...agent,
				attentionStatus:
					agent.status === "running" ? "waiting_for_user" : "idle",
				attentionReason: "Asked a question",
			})),
		);
		const ctx = {
			featureManager: { getFeatures, listFeaturesCached },
			agentManager: { getAgents, getAgentsReadModel, getAgentsAsync },
		} as never as AttentionCollectableContext & {
			featureManager: { getFeatures: ReturnType<typeof vi.fn> };
			agentManager: { getAgents: ReturnType<typeof vi.fn> };
		};
		return ctx;
	}

	it("a scan never touches Git-reconciling or synchronous probing APIs", async () => {
		const ctx = buildContext({
			f1: [runningAgent],
			f2: [idleAgent],
		});

		const observeTmuxPanesAsync = observeTmuxPanesAsyncMock();
		const watched = await collectWatchedAgents([ctx], observeTmuxPanesAsync);

		// No Git reconciliation:
		expect(ctx.featureManager.getFeatures).not.toHaveBeenCalled();
		expect(ctx.featureManager.listFeaturesCached).toHaveBeenCalledTimes(1);
		// No synchronous tmux/provider probing:
		expect(ctx.agentManager.getAgents).not.toHaveBeenCalled();

		// Exactly one canonical tmux sweep for the whole scan (P0 mandate):
		expect(observeTmuxPanesAsync).toHaveBeenCalledTimes(1);

		// Read-model pre-filter: only the feature with a running agent is probed.
		expect(ctx.agentManager.getAgentsAsync).toHaveBeenCalledTimes(1);
		expect(ctx.agentManager.getAgentsAsync).toHaveBeenCalledWith("f1", {
			status: "known",
			panes: expect.any(Map),
		});

		expect(watched).toEqual([
			{
				id: "a1",
				name: "Agent 1",
				featureId: "f1",
				featureName: "Feature One",
				attentionStatus: "waiting_for_user",
				attentionReason: "Asked a question",
			},
		]);
	});

	it("skips every feature when no agent is running — zero probes at all, including tmux", async () => {
		const ctx = buildContext({ f1: [idleAgent] });
		const observeTmuxPanesAsync = observeTmuxPanesAsyncMock();

		const watched = await collectWatchedAgents([ctx], observeTmuxPanesAsync);

		expect(ctx.agentManager.getAgentsAsync).not.toHaveBeenCalled();
		expect(observeTmuxPanesAsync).not.toHaveBeenCalled();
		expect(watched).toEqual([]);
	});

	it("collects across several project contexts with a single shared tmux sweep", async () => {
		const ctx1 = buildContext({ f1: [runningAgent] });
		const ctx2 = buildContext({ f2: [idleAgent] });
		const observeTmuxPanesAsync = observeTmuxPanesAsyncMock();

		const watched = await collectWatchedAgents(
			[ctx1, ctx2],
			observeTmuxPanesAsync,
		);

		expect(watched).toHaveLength(1);
		expect(watched[0]?.featureId).toBe("f1");
		expect(observeTmuxPanesAsync).toHaveBeenCalledTimes(1);
	});

	it("issues exactly one tmux sweep for a scan spanning ten running agents across several features", async () => {
		const agentsByFeature: Record<string, Agent[]> = {};
		for (let i = 0; i < 10; i++) {
			const featureId = i % 2 === 0 ? "f1" : "f2";
			agentsByFeature[featureId] = [
				...(agentsByFeature[featureId] ?? []),
				{ ...runningAgent, id: `a${i}`, featureId, status: "running" },
			];
		}
		const ctx = buildContext(agentsByFeature);
		const observeTmuxPanesAsync = observeTmuxPanesAsyncMock();

		await collectWatchedAgents([ctx], observeTmuxPanesAsync);

		expect(observeTmuxPanesAsync).toHaveBeenCalledTimes(1);
	});

	// PR #133 review, fail-path blocker: a failed canonical sweep must be
	// passed through to getAgentsAsync() as-is, never re-attempted per agent
	// — one failed sweep call stays one call, not one plus N retries.
	it("still issues exactly one tmux sweep for ten running agents when the canonical sweep itself fails", async () => {
		const agentsByFeature: Record<string, Agent[]> = {};
		for (let i = 0; i < 10; i++) {
			const featureId = i % 2 === 0 ? "f1" : "f2";
			agentsByFeature[featureId] = [
				...(agentsByFeature[featureId] ?? []),
				{ ...runningAgent, id: `a${i}`, featureId, status: "running" },
			];
		}
		const ctx = buildContext(agentsByFeature);
		const observeTmuxPanesAsync = vi.fn(async () => ({
			status: "unknown" as const,
			detail: "tmux: unexpected transient failure",
		}));

		await collectWatchedAgents([ctx], observeTmuxPanesAsync);

		expect(observeTmuxPanesAsync).toHaveBeenCalledTimes(1);
		// The failed sweep result is what getAgentsAsync() actually receives —
		// not silently swapped for "no sweep supplied".
		expect(ctx.agentManager.getAgentsAsync).toHaveBeenCalledWith("f1", {
			status: "unknown",
			detail: "tmux: unexpected transient failure",
		});
		expect(ctx.agentManager.getAgentsAsync).toHaveBeenCalledWith("f2", {
			status: "unknown",
			detail: "tmux: unexpected transient failure",
		});
	});

	// PR #122 review, blocker 1: AgentManager.recordAgentFailure() sets
	// lifecycle status "errored". A single-agent Feature must not be
	// dropped by the pre-filter the instant that happens, or the `failed`
	// operational transition (and its notification) can never be observed.
	it("still probes a feature whose only agent just recorded a lifecycle failure", async () => {
		const erroredAgent: Agent = {
			...runningAgent,
			id: "a3",
			status: "errored",
			lastError: "Agent crashed",
		};
		const ctx = buildContext({ f1: [erroredAgent] });

		const watched = await collectWatchedAgents(
			[ctx],
			observeTmuxPanesAsyncMock(),
		);

		expect(ctx.agentManager.getAgentsAsync).toHaveBeenCalledWith("f1", {
			status: "known",
			panes: expect.any(Map),
		});
		expect(watched).toHaveLength(1);
		expect(watched[0]?.id).toBe("a3");
	});

	it("still skips a feature whose agents are all definitively quiescent (stopped/done)", async () => {
		const stoppedAgent: Agent = {
			...runningAgent,
			id: "a4",
			status: "stopped",
		};
		const doneAgent: Agent = { ...runningAgent, id: "a5", status: "done" };
		const ctx = buildContext({ f1: [stoppedAgent, doneAgent] });

		const watched = await collectWatchedAgents(
			[ctx],
			observeTmuxPanesAsyncMock(),
		);

		expect(ctx.agentManager.getAgentsAsync).not.toHaveBeenCalled();
		expect(watched).toEqual([]);
	});

	it("end-to-end: a single agent going errored produces exactly one failed transition", async () => {
		const detector = new AgentOperationalTransitionDetector();
		const runningCtx = buildContext({ f1: [runningAgent] });

		// First tick: agent is running/working — no failure yet.
		let transitions = detector.scan(
			await collectWatchedAgents([runningCtx], observeTmuxPanesAsyncMock()),
		);
		expect(transitions.some((t) => t.kind === "failed")).toBe(false);

		// The agent crashes: lifecycle flips to "errored" (as
		// AgentManager.recordAgentFailure would persist), and the async
		// probe now reports attentionStatus "failed" from the lifecycle
		// short-circuit in AgentAttentionResolver.
		const erroredCtx = buildContext({
			f1: [{ ...runningAgent, status: "errored", lastError: "Agent crashed" }],
		});
		(
			erroredCtx.agentManager.getAgentsAsync as ReturnType<typeof vi.fn>
		).mockImplementation(async () => [
			{
				...runningAgent,
				attentionStatus: "failed",
				attentionReason: "Agent lifecycle recorded a failure",
				attentionSource: "lifecycle",
			},
		]);

		transitions = detector.scan(
			await collectWatchedAgents([erroredCtx], observeTmuxPanesAsyncMock()),
		);
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({ kind: "failed", agentId: "a1" });

		// Repeated polls in the same episode: no duplicate.
		transitions = detector.scan(
			await collectWatchedAgents([erroredCtx], observeTmuxPanesAsyncMock()),
		);
		expect(transitions.filter((t) => t.kind === "failed")).toEqual([]);
	});
});
