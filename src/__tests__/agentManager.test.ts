import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/agentManager";
import { Store } from "../storage/store";
import type { Feature } from "../types";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

const mockExecSync = vi.mocked(execSync);

describe("AgentManager", () => {
	let tmpDir: string;
	let store: Store;
	let manager: AgentManager;
	let tmux: {
		sessionName: ReturnType<typeof vi.fn>;
		legacySessionName: ReturnType<typeof vi.fn>;
		adoptSession: ReturnType<typeof vi.fn>;
	};

	const feature: Feature = {
		id: "f1",
		name: "auth",
		branch: "feat/auth",
		worktreePath: "/tmp/worktree/auth",
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-03-04T00:00:00Z",
	};

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "am-test-"));
		store = new Store(tmpDir);
		tmux = {
			sessionName: vi.fn((featureId: string, agentId: string) => {
				return `agent-space-${featureId}-${agentId}`;
			}),
			legacySessionName: vi.fn((featureId: string, agentId: string) => {
				return `companion-${featureId}-${agentId}`;
			}),
			adoptSession: vi.fn(() => false),
		};
		manager = new AgentManager(
			store,
			tmpDir,
			path.join(tmpDir, ".worktrees"),
			tmux as never,
		);
		mockExecSync.mockReset();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("createAgent", () => {
		it("creates an agent for a feature", () => {
			const agent = manager.createAgent(feature);
			expect(agent.featureId).toBe("f1");
			expect(agent.name).toBe("Agent 1");
			expect(agent.status).toBe("stopped");
			expect(agent.hasStarted).toBe(false);
		});

		it("persists agent to storage", () => {
			manager.createAgent(feature);
			const agents = store.loadAgents("f1");
			expect(agents).toHaveLength(1);
		});

		it("auto-increments default names", () => {
			manager.createAgent(feature);
			const a2 = manager.createAgent(feature);
			expect(a2.name).toBe("Agent 2");
		});

		it("persists toolId when provided", () => {
			const agent = manager.createAgent(feature, "copilot");
			expect(agent.toolId).toBe("copilot");
			const agents = store.loadAgents("f1");
			expect(agents[0].toolId).toBe("copilot");
		});

		it("persists canonical tmux session for new agents", () => {
			const agent = manager.createAgent(feature, "copilot");
			expect(agent.tmuxSession).toBe(`agent-space-f1-${agent.id}`);
			expect(store.loadAgents("f1")[0]?.tmuxSession).toBe(
				`agent-space-f1-${agent.id}`,
			);
		});

		it("leaves toolId undefined when not provided", () => {
			const agent = manager.createAgent(feature);
			expect(agent.toolId).toBeUndefined();
		});

		it("pre-assigns a session id for the claude-family built-in", () => {
			const agent = manager.createAgent(feature, "claude");
			expect(agent.sessionId).toBeTruthy();
		});

		it("pre-assigns a session id for a claude-family tool declared in config", () => {
			const claudeManager = new AgentManager(
				store,
				tmpDir,
				path.join(tmpDir, ".worktrees"),
				tmux as never,
				{
					tools: [
						{
							id: "claude-work",
							name: "Claude Work",
							command: "claude-work",
							family: "claude",
						},
					],
				},
			);
			const agent = claudeManager.createAgent(feature, "claude-work");
			expect(agent.sessionId).toBeTruthy();
		});

		it("leaves session id null for non-claude tools", () => {
			const agent = manager.createAgent(feature, "codex");
			expect(agent.sessionId).toBeNull();
		});

		it("normalizes spaced feature names for per-agent git paths", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));

			manager.createAgent(
				{
					...feature,
					name: "Auth system",
					branch: "feat/Auth-system",
					worktreePath: "/tmp/worktree/Auth-system",
					isolation: "per-agent",
				},
				"copilot",
			);

			const command = mockExecSync.mock.calls[0]?.[0];
			expect(command).toContain(".worktrees/Auth-system--");
			expect(command).toContain(' -b "feat/Auth-system/agent-');
			expect(command).toContain('"feat/Auth-system"');
		});
	});

	describe("getAgents", () => {
		it("returns agents for a feature", () => {
			manager.createAgent(feature);
			manager.createAgent(feature);
			expect(manager.getAgents("f1")).toHaveLength(2);
		});

		it("returns empty for unknown feature", () => {
			expect(manager.getAgents("unknown")).toEqual([]);
		});

		it("normalizes missing tmuxSession to the canonical name", () => {
			store.saveAgents("f1", [
				{
					id: "a1",
					featureId: "f1",
					name: "Agent 1",
					sessionId: null,
					status: "stopped",
					createdAt: "2026-03-04T00:00:00Z",
				},
			]);

			expect(manager.getAgents("f1")[0]?.tmuxSession).toBe("agent-space-f1-a1");
			expect(tmux.adoptSession).toHaveBeenCalledWith(
				"agent-space-f1-a1",
				"companion-f1-a1",
			);
			expect(store.loadAgents("f1")[0]?.tmuxSession).toBe("agent-space-f1-a1");
		});

		it("normalizes legacy stored tmuxSession to the canonical name", () => {
			store.saveAgents("f1", [
				{
					id: "a1",
					featureId: "f1",
					name: "Agent 1",
					sessionId: null,
					tmuxSession: "companion-f1-a1",
					status: "stopped",
					createdAt: "2026-03-04T00:00:00Z",
				},
			]);

			expect(manager.getAgents("f1")[0]?.tmuxSession).toBe("agent-space-f1-a1");
			expect(tmux.adoptSession).toHaveBeenCalledWith(
				"agent-space-f1-a1",
				"companion-f1-a1",
			);
		});
	});

	describe("renameAgent", () => {
		it("renames and persists", () => {
			const agent = manager.createAgent(feature);
			manager.renameAgent(agent.id, "f1", "Setup JWT middleware");
			const agents = manager.getAgents("f1");
			expect(agents[0].name).toBe("Setup JWT middleware");
		});
	});

	describe("updateAgentStatus", () => {
		it("updates status", () => {
			const agent = manager.createAgent(feature);
			manager.updateAgentStatus(agent.id, "f1", "running");
			expect(manager.getAgents("f1")[0].status).toBe("running");
		});
	});

	describe("markAgentStarted", () => {
		it("marks the agent running and clears stored failure state", () => {
			const agent = manager.createAgent(feature);
			manager.recordAgentFailure(agent.id, "f1", "boom", 7);

			manager.markAgentStarted(agent.id, "f1");

			expect(manager.getAgents("f1")[0]).toMatchObject({
				status: "running",
				hasStarted: true,
			});
			expect(manager.getAgents("f1")[0].lastError).toBeUndefined();
			expect(manager.getAgents("f1")[0].lastExitCode).toBeUndefined();
		});
	});

	describe("recordAgentFailure", () => {
		it("persists a failure state and message", () => {
			const agent = manager.createAgent(feature);

			manager.recordAgentFailure(agent.id, "f1", "Agent crashed", 23);

			expect(manager.getAgents("f1")[0]).toMatchObject({
				status: "errored",
				lastError: "Agent crashed",
				lastExitCode: 23,
			});
		});
	});

	describe("deleteAgent", () => {
		it("removes agent", () => {
			const agent = manager.createAgent(feature);
			manager.deleteAgent(agent.id, "f1");
			expect(manager.getAgents("f1")).toHaveLength(0);
		});
	});

	describe("deleteAllAgents", () => {
		it("removes all agents for a feature", () => {
			manager.createAgent(feature);
			manager.createAgent(feature);
			manager.deleteAllAgents("f1");
			expect(manager.getAgents("f1")).toHaveLength(0);
		});
	});

	describe("closeAgent", () => {
		it("marks agent status as done", () => {
			const agent = manager.createAgent(feature);
			manager.recordAgentFailure(agent.id, "f1", "boom", 9);
			manager.closeAgent(agent.id, "f1");
			expect(manager.getAgents("f1")[0].status).toBe("done");
			expect(manager.getAgents("f1")[0].lastError).toBeUndefined();
			expect(manager.getAgents("f1")[0].lastExitCode).toBeUndefined();
		});

		it("persists done status to storage", () => {
			const agent = manager.createAgent(feature);
			manager.closeAgent(agent.id, "f1");
			const agents = store.loadAgents("f1");
			expect(agents[0].status).toBe("done");
		});

		it("does not remove worktree on close (preserves for reopen)", () => {
			const perAgentFeature: Feature = {
				...feature,
				isolation: "per-agent",
			};
			mockExecSync.mockReturnValue(Buffer.from(""));
			const agent = manager.createAgent(perAgentFeature);
			mockExecSync.mockReset();

			manager.recordAgentFailure(agent.id, "f1", "boom", 11);
			manager.closeAgent(agent.id, "f1");

			expect(mockExecSync).not.toHaveBeenCalled();
			expect(manager.getAgents("f1")[0].status).toBe("done");
		});

		it("does nothing for unknown agent", () => {
			manager.createAgent(feature);
			manager.closeAgent("nonexistent", "f1");
			expect(manager.getAgents("f1")[0].status).toBe("stopped");
		});
	});

	describe("base feature session label", () => {
		it("resolves base feature IDs to the git default branch", () => {
			mockExecSync.mockReturnValue(Buffer.from("main\n"));

			const baseFeature: Feature = {
				...feature,
				id: "base:project-uuid",
				branch: "main",
			};
			const agent = manager.createAgent(baseFeature);

			// sessionName should have been called with "main" instead of "base:project-uuid"
			expect(tmux.sessionName).toHaveBeenCalledWith("main", agent.id);
		});

		it("falls back to 'main' when git rev-parse fails", () => {
			mockExecSync.mockImplementation(() => {
				throw new Error("not a git repo");
			});

			const baseFeature: Feature = {
				...feature,
				id: "base:project-uuid",
				branch: "main",
			};
			const agent = manager.createAgent(baseFeature);

			expect(tmux.sessionName).toHaveBeenCalledWith("main", agent.id);
		});
	});

	describe("isAgentBranchMerged", () => {
		it("returns true for shared agents (no worktree)", () => {
			const agent = manager.createAgent(feature);
			expect(manager.isAgentBranchMerged(agent, feature)).toBe(true);
		});

		it("returns true when git merge-base succeeds", () => {
			const perAgentFeature: Feature = {
				...feature,
				isolation: "per-agent",
			};
			mockExecSync.mockReturnValue(Buffer.from(""));
			const agent = manager.createAgent(perAgentFeature);
			mockExecSync.mockReset();

			// merge-base succeeds (exit 0)
			mockExecSync.mockReturnValue(Buffer.from(""));
			expect(manager.isAgentBranchMerged(agent, perAgentFeature)).toBe(true);
			expect(mockExecSync).toHaveBeenCalledWith(
				expect.stringContaining("git merge-base --is-ancestor"),
				expect.any(Object),
			);
		});

		it("returns false when git merge-base throws", () => {
			const perAgentFeature: Feature = {
				...feature,
				isolation: "per-agent",
			};
			mockExecSync.mockReturnValue(Buffer.from(""));
			const agent = manager.createAgent(perAgentFeature);
			mockExecSync.mockReset();

			// merge-base fails (exit 1)
			mockExecSync.mockImplementation(() => {
				throw new Error("exit code 1");
			});
			expect(manager.isAgentBranchMerged(agent, perAgentFeature)).toBe(false);
		});
	});
});
