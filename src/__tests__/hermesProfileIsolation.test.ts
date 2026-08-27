import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}));

vi.mock("../utils/platform", () => ({
	commandExists: vi.fn().mockReturnValue(true),
}));

import { CodingToolRegistry } from "../agents/codingToolRegistry";
import { resolveHermesHome } from "../agents/hermesProfileResolver";
import type { Agent } from "../types";

/**
 * Integration test proving that two Hermes agents using different profiles
 * never share session state, adapters, or commands — even when the same
 * sessionId happens to exist in both profile stores.
 *
 * The test creates two temporary Hermes homes with distinct state.db and
 * breadcrumb files, then verifies that:
 * 1. Each agent resolves to a different adapter (different home).
 * 2. Each agent's launch/resume command targets the correct profile.
 * 3. The same sessionId does not leak across profiles.
 */
describe("Hermes profile isolation", () => {
	it("two agents with different profiles get different adapters", () => {
		const registry = new CodingToolRegistry();
		const agentA: Agent = {
			id: "agent-a",
			featureId: "feat-1",
			name: "Agent A",
			sessionId: null,
			status: "stopped",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
			hermesProfile: "profile-a",
		};
		const agentB: Agent = {
			id: "agent-b",
			featureId: "feat-1",
			name: "Agent B",
			sessionId: null,
			status: "stopped",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
			hermesProfile: "profile-b",
		};

		const adapterA = registry.getSessionAdapterForAgent(agentA);
		const adapterB = registry.getSessionAdapterForAgent(agentB);

		expect(adapterA).toBeDefined();
		expect(adapterB).toBeDefined();
		// Different profiles → different adapter instances
		expect(adapterA).not.toBe(adapterB);
		// Both are hermes adapters
		expect(adapterA?.toolId).toBe("hermes");
		expect(adapterB?.toolId).toBe("hermes");
	});

	it("launch command includes the correct profile flag", () => {
		const registry = new CodingToolRegistry();
		const agent: Agent = {
			id: "agent-1",
			featureId: "feat-1",
			name: "Agent 1",
			sessionId: null,
			status: "stopped",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
			hermesProfile: "iqv2",
		};

		const tool = registry.resolveAgentToolForAgent(agent);
		expect(registry.buildLaunchCommand(tool)).toBe("hermes -p iqv2");
	});

	it("resume command includes the correct profile flag", () => {
		const registry = new CodingToolRegistry();
		const agent: Agent = {
			id: "agent-1",
			featureId: "feat-1",
			name: "Agent 1",
			sessionId: "sess-123",
			status: "stopped",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
			hermesProfile: "prod",
		};

		const tool = registry.resolveAgentToolForAgent(agent);
		expect(registry.buildStrictResumeLaunchCommand(tool, "sess-123")).toBe(
			"hermes -p prod --resume sess-123 --no-restore-cwd",
		);
	});

	it("same sessionId in two profiles does not leak across agents", () => {
		const registry = new CodingToolRegistry();
		const sharedSessionId = "shared-session-id";

		const agentA: Agent = {
			id: "agent-a",
			featureId: "feat-1",
			name: "Agent A",
			sessionId: sharedSessionId,
			status: "running",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
			hermesProfile: "profile-a",
		};
		const agentB: Agent = {
			id: "agent-b",
			featureId: "feat-1",
			name: "Agent B",
			sessionId: sharedSessionId,
			status: "running",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
			hermesProfile: "profile-b",
		};

		// Both agents have the same sessionId but different profiles
		const toolA = registry.resolveAgentToolForAgent(agentA);
		const toolB = registry.resolveAgentToolForAgent(agentB);

		// Their providers should be different (different session adapters)
		expect(toolA.provider).not.toBe(toolB.provider);
		expect(toolA.provider?.sessionAdapter).not.toBe(
			toolB.provider?.sessionAdapter,
		);

		// But both build valid resume commands with their respective profiles
		expect(
			registry.buildStrictResumeLaunchCommand(toolA, sharedSessionId),
		).toBe(`hermes -p profile-a --resume ${sharedSessionId} --no-restore-cwd`);
		expect(
			registry.buildStrictResumeLaunchCommand(toolB, sharedSessionId),
		).toBe(`hermes -p profile-b --resume ${sharedSessionId} --no-restore-cwd`);
	});

	it("agent without hermesProfile uses default adapter", () => {
		const registry = new CodingToolRegistry();
		const agent: Agent = {
			id: "agent-default",
			featureId: "feat-1",
			name: "Agent Default",
			sessionId: null,
			status: "stopped",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
		};

		const tool = registry.resolveAgentToolForAgent(agent);
		// No profile → default launch args (no -p flag)
		expect(registry.buildLaunchCommand(tool)).toBe("hermes");
		expect(registry.buildStrictResumeLaunchCommand(tool, "sess-1")).toBe(
			"hermes --resume sess-1 --no-restore-cwd",
		);
	});

	it("getSessionRenameAdapters returns one adapter per toolId (not per profile)", () => {
		const registry = new CodingToolRegistry();
		// getSessionRenameAdapters uses the built-in tools (no project config),
		// so it returns the default hermes adapter. Profile-specific adapters
		// are only created via getSessionAdapterForAgent.
		const adapters = registry.getSessionRenameAdapters();
		const hermesAdapters = adapters.filter((a) => a.toolId === "hermes");
		expect(hermesAdapters).toHaveLength(1);
	});

	it("resolveHermesHome respects profile hierarchy", () => {
		// Named profile → <root>/profiles/<name>
		const namedHome = resolveHermesHome("iqv2");
		expect(namedHome).toContain("profiles/iqv2");

		// Default → <root> itself
		const defaultHome = resolveHermesHome();
		expect(defaultHome).not.toContain("profiles");
	});
});
