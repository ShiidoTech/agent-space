import { describe, expect, it, vi } from "vitest";
import type { CodingAgentProvider } from "../agents/providers/types";
import { restoreAgentRuntimes } from "../agents/runtimeRestorer";
import type { TmuxIntegration } from "../agents/tmux";
import type { Agent, Feature } from "../types";

const execAsyncMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../utils/platform", () => ({ execAsync: execAsyncMock }));

const feature: Feature = {
	id: "f1",
	name: "Feature",
	branch: "feat/f1",
	worktreePath: "/repo/f1",
	status: "active",
	color: "blue",
	isolation: "shared",
	createdAt: "2026-01-01T00:00:00.000Z",
};

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "a1",
		featureId: "f1",
		name: "Agent",
		sessionId: "ses_1",
		tmuxSession: "agent-space-f1-a1",
		toolId: "opencode",
		status: "running",
		hasStarted: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function provider(hasSession = true): CodingAgentProvider {
	return {
		id: "opencode",
		conversationIdentity: { ownership: "provider_assigned" },
		capabilities: {
			launch: true,
			resume: true,
			sessionDiscovery: true,
			sessionNaming: true,
			attention: {
				"attention.working": true,
				"attention.waitingForUser": true,
				"attention.idle": true,
				"attention.failed": true,
			},
		},
		sessionAdapter: {
			toolId: "opencode",
			readName: () => null,
			scanSessions: () => [],
			async: { hasSession: async () => hasSession },
		},
	};
}

function tmux(alive: Set<string>): TmuxIntegration {
	return {
		isAvailableAsync: async () => true,
		sessionName: (featureId: string, agentId: string) =>
			`agent-space-${featureId}-${agentId}`,
		legacySessionName: () => "legacy",
		adoptSessionAsync: async (name: string) => alive.has(name),
		createCommand: (name: string, command: string) => {
			alive.add(name);
			return `${name}:${command}`;
		},
		configureSessionAsync: async () => undefined,
		isSessionAliveAsync: async (name: string) => alive.has(name),
	} as unknown as TmuxIntegration;
}

function deps(
	agents: Agent[],
	providerValue: CodingAgentProvider,
	alive = new Set<string>(),
) {
	const records: Array<{ id: string; state: string }> = [];
	const context = {
		project: { id: "p1" },
		featureManager: { getBaseFeature: () => feature },
		store: { loadFeatures: () => [] },
		agentManager: {
			getAgentsReadModel: () => agents,
			updateAgentStatusReadModel: vi.fn(),
			recordRestoreOutcomeReadModel: (
				id: string,
				_featureId: string,
				value: { state: string },
			) => records.push({ id, state: value.state }),
		},
	};
	const tool = {
		id: "opencode",
		name: "OpenCode",
		command: "opencode",
		family: "opencode" as const,
		provider: providerValue,
	};
	const exec = vi.fn(async () => undefined);
	return {
		records,
		deps: {
			projectManager: { getAllContexts: () => [context] },
			tmux: tmux(alive),
			toolRegistry: {
				resolveAgentToolForAgent: () => tool,
				getProvider: () => providerValue,
				buildStrictResumeLaunchCommand: (_tool: unknown, id: string) =>
					`opencode --session ${id}`,
			},
		} as never,
		exec,
	};
}

describe("runtime restore", () => {
	it("treats a live direct OpenCode tmux as survived without respawn", async () => {
		const setup = deps([agent()], provider(), new Set(["agent-space-f1-a1"]));
		const report = await restoreAgentRuntimes(setup.deps);

		expect(report.reattached).toHaveLength(1);
		expect(report.resumed).toHaveLength(0);
		expect(setup.exec).not.toHaveBeenCalled();
	});

	it("resumes only a proven OpenCode session with the native TUI", async () => {
		const setup = deps([agent()], provider(true));
		const report = await restoreAgentRuntimes(setup.deps);

		expect(report.resumed).toHaveLength(1);
		expect(execAsyncMock).toHaveBeenCalled();
	});

	it("blocks an unlinked OpenCode agent without a fresh fallback", async () => {
		const setup = deps([agent({ sessionId: null })], provider());
		const report = await restoreAgentRuntimes(setup.deps);

		expect(report.blocked).toHaveLength(1);
		expect(setup.records[0]?.state).toBe("blocked");
		expect(setup.exec).not.toHaveBeenCalled();
	});
});
