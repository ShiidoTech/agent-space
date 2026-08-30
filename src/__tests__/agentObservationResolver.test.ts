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

import { commandExists, execFile, execFileAsync } from "../utils/platform";

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

	describe("resolveAsync (P0 zero-I/O UI mandate: single attention source)", () => {
		const toolRegistryStub = {
			resolveAgentTool: vi.fn(() => ({ id: "generic", provider: undefined })),
			resolveAgentToolForAgent: vi.fn(() => ({
				id: "generic",
				provider: undefined,
			})),
			getProvider: vi.fn(() => undefined),
		} as never;

		it("never recomputes attention — preserves previousAttention verbatim, no tmux/provider probe", async () => {
			const resolver = new AgentObservationResolver(
				new TmuxIntegration(),
				toolRegistryStub,
			);

			const observation = await resolver.resolveAsync(agent(), true, {
				status: "working",
				reason: "Provider emitted working evidence",
				source: "provider",
				observedAt: "2026-01-01T00:00:00.000Z",
			});

			expect(observation.attention).toEqual({
				state: "working",
				reason: "Provider emitted working evidence",
				observedAt: "2026-01-01T00:00:00.000Z",
			});
			// AgentAttentionMonitor is the sole attention prober — this method
			// must not touch tmux/provider evidence to compute attention itself.
			expect(execFileAsync).not.toHaveBeenCalled();
		});

		it("falls back to an honest 'not yet observed' when no previous attention was ever committed", async () => {
			const resolver = new AgentObservationResolver(
				new TmuxIntegration(),
				toolRegistryStub,
			);

			const observation = await resolver.resolveAsync(agent(), true);

			expect(observation.attention).toEqual({
				state: "unknown",
				reason: "Not yet observed",
				observedAt: undefined,
			});
			expect(execFileAsync).not.toHaveBeenCalled();
		});
	});
});
