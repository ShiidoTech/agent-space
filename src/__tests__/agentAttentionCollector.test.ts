import { describe, expect, it, vi } from "vitest";
import {
	type AttentionCollectableContext,
	collectWatchedAgents,
} from "../agents/attention/agentAttentionCollector";
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

		const watched = await collectWatchedAgents([ctx]);

		// No Git reconciliation:
		expect(ctx.featureManager.getFeatures).not.toHaveBeenCalled();
		expect(ctx.featureManager.listFeaturesCached).toHaveBeenCalledTimes(1);
		// No synchronous tmux/provider probing:
		expect(ctx.agentManager.getAgents).not.toHaveBeenCalled();

		// Read-model pre-filter: only the feature with a running agent is probed.
		expect(ctx.agentManager.getAgentsAsync).toHaveBeenCalledTimes(1);
		expect(ctx.agentManager.getAgentsAsync).toHaveBeenCalledWith("f1");

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

	it("skips every feature when no agent is running — zero probes at all", async () => {
		const ctx = buildContext({ f1: [idleAgent] });

		const watched = await collectWatchedAgents([ctx]);

		expect(ctx.agentManager.getAgentsAsync).not.toHaveBeenCalled();
		expect(watched).toEqual([]);
	});

	it("collects across several project contexts", async () => {
		const ctx1 = buildContext({ f1: [runningAgent] });
		const ctx2 = buildContext({ f2: [idleAgent] });

		const watched = await collectWatchedAgents([ctx1, ctx2]);

		expect(watched).toHaveLength(1);
		expect(watched[0]?.featureId).toBe("f1");
	});
});
