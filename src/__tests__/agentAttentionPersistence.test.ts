import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/agentManager";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import { Store } from "../storage/store";
import type { Agent } from "../types";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}));

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent attention persistence", () => {
	it("decorates reads without writing attention fields to agents.json", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-space-attention-store-"),
		);
		tempDirs.push(dir);
		const store = new Store(dir);
		const stored: Agent = {
			id: "agent-1",
			featureId: "feature-1",
			name: "Agent 1",
			sessionId: null,
			tmuxSession: "agent-space-feature-1-agent-1",
			toolId: "generic",
			status: "running",
			hasStarted: true,
			createdAt: new Date(0).toISOString(),
		};
		store.saveAgents("feature-1", [stored]);

		const tmux = {
			sessionName: vi.fn(() => "agent-space-feature-1-agent-1"),
			legacySessionName: vi.fn(() => "companion-feature-1-agent-1"),
			adoptSession: vi.fn(() => true),
			isSessionAlive: vi.fn(() => true),
			getPaneStatus: vi.fn(() => ({ dead: false, exitCode: 0 })),
		};
		const toolRegistry = {
			resolveAgentTool: () => ({
				id: "generic",
				name: "Generic",
				command: "generic",
				family: "generic",
			}),
			isClaudeFamilyTool: () => false,
		} as unknown as CodingToolRegistry;

		const manager = new AgentManager(
			store,
			dir,
			path.join(dir, ".worktrees"),
			tmux as never,
			{},
			toolRegistry,
		);

		const read = manager.getAgents("feature-1")[0];
		expect(read.attentionStatus).toBe("unknown");
		expect(read.attentionReason).toBeTruthy();

		const persisted = store.loadAgents("feature-1")[0] as Agent;
		expect(persisted.attentionStatus).toBeUndefined();
		expect(persisted.attentionReason).toBeUndefined();
	});
});
