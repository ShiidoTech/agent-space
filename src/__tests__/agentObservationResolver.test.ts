import { describe, expect, it, vi } from "vitest";
import { AgentObservationResolver } from "../agents/observation/agentObservationResolver";
import { TmuxIntegration } from "../agents/tmux";
import type { Agent } from "../types";

vi.mock("../utils/platform", () => ({
	commandExists: vi.fn(() => false),
	exec: vi.fn(),
	execAsync: vi.fn(),
	execFile: vi.fn(),
	execFileAsync: vi.fn(),
}));

import { commandExists, execFile } from "../utils/platform";

function agent(): Agent {
	return {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		status: "running",
		hasStarted: true,
		sessionId: null,
		createdAt: new Date(0).toISOString(),
	};
}

describe("AgentObservationResolver", () => {
	it("keeps a failed typed tmux observation unknown instead of claiming stopped", () => {
		const resolver = new AgentObservationResolver(new TmuxIntegration(), {
			resolveAgentTool: vi.fn(() => ({ id: "generic", provider: undefined })),
			resolveAgentToolForAgent: vi.fn(() => ({
				id: "generic",
				provider: undefined,
			})),
			getProvider: vi.fn(() => undefined),
		} as never);

		expect(resolver.resolve(agent()).lifecycle).toEqual({
			state: "unknown",
			source: "tmux",
			reason: "tmux observation failed: tmux is not available",
		});
	});

	it("marks a started agent stopped when tmux proves there is no server", () => {
		vi.mocked(commandExists).mockReturnValue(true);
		vi.mocked(execFile).mockImplementation(() => {
			throw Object.assign(new Error("tmux exited"), {
				status: 1,
				stderr: "no server running on /tmp/tmux-1000/default",
			});
		});
		const resolver = new AgentObservationResolver(new TmuxIntegration(), {
			resolveAgentTool: vi.fn(() => ({ id: "generic", provider: undefined })),
			resolveAgentToolForAgent: vi.fn(() => ({
				id: "generic",
				provider: undefined,
			})),
			getProvider: vi.fn(() => undefined),
		} as never);

		expect(resolver.resolve(agent()).lifecycle).toEqual({
			state: "stopped",
			source: "tmux",
		});
	});
});
