import { describe, expect, it, vi } from "vitest";
import { AgentAttentionResolver } from "../agents/attention/agentAttentionResolver";
import type { Agent } from "../types";

describe("AgentAttentionResolver.resolveAsync (non-blocking contract)", () => {
	const agent: Agent = {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: "session-1",
		tmuxSession: "agent-space-f1-a1",
		toolId: "opencode",
		status: "running",
		hasStarted: true,
		createdAt: "2026-03-06T00:00:00Z",
	};

	const tool = { id: "opencode" } as never;
	const provider = {
		capabilities: {
			attention: {
				working: true,
				waitingForUser: true,
				idle: true,
				failed: true,
			},
		},
	} as never;

	function buildResolver(overrides?: {
		getStructuredAttentionSignal?: ReturnType<typeof vi.fn>;
		getStructuredAttentionSignalAsync?: ReturnType<typeof vi.fn>;
	}) {
		const tmux = {
			sessionName: vi.fn(() => "agent-space-f1-a1"),
			isSessionAlive: vi.fn(),
			getPaneStatus: vi.fn(),
			isSessionAliveAsync: vi.fn(async () => true),
			getPaneStatusAsync: vi.fn(async () => ({ dead: false, exitCode: 0 })),
		};
		const toolRegistry = {
			resolveAgentTool: vi.fn(() => tool),
			getProvider: vi.fn(() => provider),
			getStructuredAttentionSignal:
				overrides?.getStructuredAttentionSignal ?? vi.fn(),
			getStructuredAttentionSignalAsync:
				overrides?.getStructuredAttentionSignalAsync ??
				vi.fn(async () => undefined),
		};
		return {
			resolver: new AgentAttentionResolver(
				tmux as never,
				toolRegistry as never,
			),
			tmux,
			toolRegistry,
		};
	}

	it("reads provider evidence through the async registry API only", async () => {
		const getStructuredAttentionSignal = vi.fn();
		const getStructuredAttentionSignalAsync = vi.fn(async () => ({
			status: "waiting_for_user" as const,
			evidence: "opencode.question.waiting",
		}));
		const { resolver, toolRegistry, tmux } = buildResolver({
			getStructuredAttentionSignal,
			getStructuredAttentionSignalAsync,
		});

		const snapshot = await resolver.resolveAsync(agent);

		expect(snapshot).toEqual({
			status: "waiting_for_user",
			reason: "Provider emitted opencode.question.waiting",
			source: "provider",
		});
		// The synchronous registry/provider path must never be taken:
		expect(getStructuredAttentionSignal).not.toHaveBeenCalled();
		expect(getStructuredAttentionSignalAsync).toHaveBeenCalledWith(
			tool,
			"session-1",
		);
		// The synchronous tmux twins must never be taken either:
		expect(tmux.isSessionAlive).not.toHaveBeenCalled();
		expect(tmux.getPaneStatus).not.toHaveBeenCalled();
		expect(tmux.isSessionAliveAsync).toHaveBeenCalledWith("agent-space-f1-a1");
		expect(toolRegistry.getStructuredAttentionSignalAsync).toBeDefined();
	});

	it("maps a dead pane to failed through the async probes without reaching the provider", async () => {
		const tmux = {
			sessionName: vi.fn(() => "agent-space-f1-a1"),
			isSessionAlive: vi.fn(),
			getPaneStatus: vi.fn(),
			isSessionAliveAsync: vi.fn(async () => true),
			getPaneStatusAsync: vi.fn(async () => ({ dead: true, exitCode: 1 })),
		};
		const toolRegistry = {
			resolveAgentTool: vi.fn(() => tool),
			getProvider: vi.fn(() => provider),
			getStructuredAttentionSignal: vi.fn(),
			getStructuredAttentionSignalAsync: vi.fn(async () => undefined),
		};
		const deadPaneResolver = new AgentAttentionResolver(
			tmux as never,
			toolRegistry as never,
		);

		const snapshot = await deadPaneResolver.resolveAsync(agent);

		expect(snapshot.status).toBe("failed");
		expect(snapshot.reason).toContain("exited with code 1");
		// Dead panes short-circuit before any provider evidence is read:
		expect(toolRegistry.getStructuredAttentionSignal).not.toHaveBeenCalled();
		expect(
			toolRegistry.getStructuredAttentionSignalAsync,
		).not.toHaveBeenCalled();
		expect(tmux.isSessionAlive).not.toHaveBeenCalled();
		expect(tmux.getPaneStatus).not.toHaveBeenCalled();
	});
});
