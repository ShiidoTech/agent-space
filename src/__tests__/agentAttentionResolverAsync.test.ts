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
		worktreePath: "/repo/feature-one",
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
			resolveAgentToolForAgent: vi.fn(() => tool),
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
			"/repo/feature-one",
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
			resolveAgentToolForAgent: vi.fn(() => tool),
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

	// PR #133 review, non-blocking semantic note: a session present in a
	// canonical sweep with a dead pane (remain-on-exit keeps it around) must
	// still reach exit-code classification — not be collapsed to "no live
	// tmux session" before its exit code is ever read.
	it("classifies a dead-but-present pane from a canonical sweep by its exit code, not as 'no live session'", async () => {
		const tmux = {
			sessionName: vi.fn(() => "agent-space-f1-a1"),
			isSessionAlive: vi.fn(),
			getPaneStatus: vi.fn(),
			isSessionAliveAsync: vi.fn(),
			getPaneStatusAsync: vi.fn(),
		};
		const toolRegistry = {
			resolveAgentTool: vi.fn(() => tool),
			resolveAgentToolForAgent: vi.fn(() => tool),
			getProvider: vi.fn(() => provider),
			getStructuredAttentionSignal: vi.fn(),
			getStructuredAttentionSignalAsync: vi.fn(async () => undefined),
		};
		const resolver = new AgentAttentionResolver(
			tmux as never,
			toolRegistry as never,
		);

		const snapshot = await resolver.resolveAsync(agent, undefined, {
			status: "known",
			panes: new Map([
				["agent-space-f1-a1", { dead: true, exitCode: 1, tty: null }],
			]),
		});

		expect(snapshot.status).toBe("failed");
		expect(snapshot.reason).toContain("exited with code 1");
		// The shared sweep is used exclusively — no probe of its own.
		expect(tmux.isSessionAliveAsync).not.toHaveBeenCalled();
		expect(tmux.getPaneStatusAsync).not.toHaveBeenCalled();
	});

	it("reports a session absent from the canonical sweep as no live tmux session", async () => {
		const tmux = {
			sessionName: vi.fn(() => "agent-space-f1-a1"),
			isSessionAlive: vi.fn(),
			getPaneStatus: vi.fn(),
			isSessionAliveAsync: vi.fn(),
			getPaneStatusAsync: vi.fn(),
		};
		const toolRegistry = {
			resolveAgentTool: vi.fn(() => tool),
			resolveAgentToolForAgent: vi.fn(() => tool),
			getProvider: vi.fn(() => provider),
			getStructuredAttentionSignal: vi.fn(),
			getStructuredAttentionSignalAsync: vi.fn(async () => undefined),
		};
		const resolver = new AgentAttentionResolver(
			tmux as never,
			toolRegistry as never,
		);

		const snapshot = await resolver.resolveAsync(agent, undefined, {
			status: "known",
			panes: new Map(),
		});

		expect(snapshot).toEqual({
			status: "unknown",
			reason: "No live tmux session is available",
			source: "tmux",
		});
	});

	// PR #133 review, fail-path blocker: a canonical sweep that was attempted
	// and failed must resolve to unknown directly — never fall back to this
	// resolver's own per-agent tmux probe.
	it("resolves to unknown without probing when the canonical sweep failed", async () => {
		const tmux = {
			sessionName: vi.fn(() => "agent-space-f1-a1"),
			isSessionAlive: vi.fn(),
			getPaneStatus: vi.fn(),
			isSessionAliveAsync: vi.fn(),
			getPaneStatusAsync: vi.fn(),
		};
		const toolRegistry = {
			resolveAgentTool: vi.fn(() => tool),
			resolveAgentToolForAgent: vi.fn(() => tool),
			getProvider: vi.fn(() => provider),
			getStructuredAttentionSignal: vi.fn(),
			getStructuredAttentionSignalAsync: vi.fn(async () => undefined),
		};
		const resolver = new AgentAttentionResolver(
			tmux as never,
			toolRegistry as never,
		);

		const snapshot = await resolver.resolveAsync(agent, undefined, {
			status: "unknown",
			detail: "tmux: unexpected transient failure",
		});

		expect(snapshot).toEqual({
			status: "unknown",
			reason: "tmux observation failed: tmux: unexpected transient failure",
			source: "tmux",
		});
		expect(tmux.isSessionAliveAsync).not.toHaveBeenCalled();
		expect(tmux.getPaneStatusAsync).not.toHaveBeenCalled();
	});
});
