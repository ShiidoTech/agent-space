import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/agentManager";
import { CodingToolRegistry } from "../agents/codingToolRegistry";
import { OpenCodeSessionProvider } from "../agents/sessionProviders/openCodeSessionProvider";
import { Store } from "../storage/store";
import type { Feature } from "../types";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(() => ""),
	execFile: vi.fn(),
}));

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}));

import { execFile, execSync } from "node:child_process";
import * as vscode from "vscode";

const mockExecSync = vi.mocked(execSync);
const mockExecFile = vi.mocked(execFile);

function mockConfig(values: Record<string, unknown> = {}) {
	(
		vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>
	).mockReturnValue({
		get: (key: string, defaultValue?: unknown) =>
			key in values ? values[key] : defaultValue,
	});
}

describe("AgentManager", () => {
	let tmpDir: string;
	let store: Store;
	let manager: AgentManager;
	let tmux: {
		sessionName: ReturnType<typeof vi.fn>;
		legacySessionName: ReturnType<typeof vi.fn>;
		adoptSession: ReturnType<typeof vi.fn>;
		isSessionAlive: ReturnType<typeof vi.fn>;
		getPaneStatus: ReturnType<typeof vi.fn>;
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
			isSessionAlive: vi.fn(() => true),
			getPaneStatus: vi.fn(() => null),
		};
		manager = new AgentManager(
			store,
			tmpDir,
			path.join(tmpDir, ".worktrees"),
			tmux as never,
			undefined,
			new CodingToolRegistry(),
		);
		mockExecSync.mockReset();
		mockExecFile.mockReset();
		mockConfig();
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

		it("pre-assigns a session id for a claude-family tool declared via codingTools", () => {
			mockConfig({
				codingTools: [
					{
						id: "claude-work",
						name: "Claude Work",
						command: "claude-work",
						family: "claude",
					},
				],
			});
			const claudeManager = new AgentManager(
				store,
				tmpDir,
				path.join(tmpDir, ".worktrees"),
				tmux as never,
				undefined,
				new CodingToolRegistry(),
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

		it("freezes the project-declared Hermes profile at creation", () => {
			const hermesManager = new AgentManager(
				store,
				tmpDir,
				path.join(tmpDir, ".worktrees"),
				tmux as never,
				{ providers: { hermes: { profile: "iqv2" } } },
				new CodingToolRegistry(),
			);
			const agent = hermesManager.createAgent(feature, "hermes");
			expect(agent.hermesProfile).toBe("iqv2");
			expect(store.loadAgents("f1")[0]?.hermesProfile).toBe("iqv2");
		});

		it("freezes Hermes' active profile at creation when project declares none", () => {
			const originalEnv = { ...process.env };
			const hermesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "am-hermes-"));
			try {
				process.env.HERMES_HOME = hermesRoot;
				fs.writeFileSync(path.join(hermesRoot, "active_profile"), "coder\n");

				const hermesManager = new AgentManager(
					store,
					tmpDir,
					path.join(tmpDir, ".worktrees"),
					tmux as never,
					undefined,
					new CodingToolRegistry(),
				);
				const agent = hermesManager.createAgent(feature, "hermes");
				expect(agent.hermesProfile).toBe("coder");
				expect(store.loadAgents("f1")[0]?.hermesProfile).toBe("coder");
			} finally {
				process.env = { ...originalEnv };
				fs.rmSync(hermesRoot, { recursive: true, force: true });
			}
		});

		it("persists explicit default profile for Hermes agents with no other source", () => {
			const originalEnv = { ...process.env };
			const hermesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "am-hermes-"));
			try {
				process.env.HERMES_HOME = hermesRoot;

				const hermesManager = new AgentManager(
					store,
					tmpDir,
					path.join(tmpDir, ".worktrees"),
					tmux as never,
					undefined,
					new CodingToolRegistry(),
				);
				const agent = hermesManager.createAgent(feature, "hermes");
				// Even the implicit default is persisted explicitly so every
				// launch goes through -p default and a later `hermes profile
				// use` cannot silently move the session.
				expect(agent.hermesProfile).toBe("default");
				expect(store.loadAgents("f1")[0]?.hermesProfile).toBe("default");
			} finally {
				process.env = { ...originalEnv };
				fs.rmSync(hermesRoot, { recursive: true, force: true });
			}
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

		it("keeps the legacy session when adoption is not confirmed", () => {
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

			expect(manager.getAgents("f1")[0]?.tmuxSession).toBe("companion-f1-a1");
			expect(tmux.adoptSession).toHaveBeenCalledWith(
				"agent-space-f1-a1",
				"companion-f1-a1",
			);
			expect(store.loadAgents("f1")[0]?.tmuxSession).toBe("companion-f1-a1");
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
			tmux.adoptSession.mockReturnValue(true);

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

	describe("recordTurnCompleted / acknowledgeReview", () => {
		it("opens a review receipt that survives a reload and clears it on acknowledgement", () => {
			const agent = manager.createAgent(feature);

			manager.recordTurnCompleted(agent.id, "f1", "review-1");
			expect(manager.getAgents("f1")[0]).toMatchObject({
				pendingReviewId: "review-1",
			});

			// Persisted, not just in-memory: a fresh manager reading the same
			// store still sees it.
			const reloaded = new AgentManager(
				store,
				tmpDir,
				path.join(tmpDir, ".worktrees"),
				tmux as never,
				undefined,
				new CodingToolRegistry(),
			);
			expect(reloaded.getAgents("f1")[0]).toMatchObject({
				pendingReviewId: "review-1",
			});

			manager.acknowledgeReview(agent.id, "f1");
			expect(manager.getAgents("f1")[0].pendingReviewId).toBeUndefined();
		});

		it("overwrites an unacknowledged receipt with the latest completion", () => {
			const agent = manager.createAgent(feature);

			manager.recordTurnCompleted(agent.id, "f1", "review-1");
			manager.recordTurnCompleted(agent.id, "f1", "review-2");

			expect(manager.getAgents("f1")[0].pendingReviewId).toBe("review-2");
		});

		it("acknowledging with nothing pending is a silent no-op", () => {
			const agent = manager.createAgent(feature);

			expect(() => manager.acknowledgeReview(agent.id, "f1")).not.toThrow();
			expect(manager.getAgents("f1")[0].pendingReviewId).toBeUndefined();
		});

		// PR2 review round 2, blocker 2: the receipt must live in its own file
		// so a self-write can never be mistaken for a structural agents.json
		// change (add/remove an agent) by cross-window sync.
		it("never writes the receipt into agents.json", () => {
			const agent = manager.createAgent(feature);

			manager.recordTurnCompleted(agent.id, "f1", "review-1");

			const raw = JSON.parse(
				fs.readFileSync(
					path.join(tmpDir, "features", "f1", "agents.json"),
					"utf-8",
				),
			);
			expect(raw.agents[0].pendingReviewId).toBeUndefined();
			const inbox = JSON.parse(
				fs.readFileSync(
					path.join(tmpDir, "features", "f1", "review-inbox.json"),
					"utf-8",
				),
			);
			expect(inbox.pending[agent.id]).toBe("review-1");
		});

		it("recording completion for an unknown agent is a silent no-op", () => {
			expect(() =>
				manager.recordTurnCompleted("ghost", "f1", "review-1"),
			).not.toThrow();
			const inboxPath = path.join(
				tmpDir,
				"features",
				"f1",
				"review-inbox.json",
			);
			expect(fs.existsSync(inboxPath)).toBe(false);
		});
	});

	describe("peekPendingReviewId / acknowledgeReviewIfMatches (PR2 review round 3)", () => {
		it("peek is empty until a review-inbox read or write has happened in this process", () => {
			const agent = manager.createAgent(feature);
			expect(manager.peekPendingReviewId("f1", agent.id)).toBeUndefined();
		});

		it("recordTurnCompleted immediately updates the in-memory peek, without a read", () => {
			const agent = manager.createAgent(feature);
			manager.recordTurnCompleted(agent.id, "f1", "review-1");
			expect(manager.peekPendingReviewId("f1", agent.id)).toBe("review-1");
		});

		it("a getAgents*/getAgent read also refreshes the in-memory peek", () => {
			const agent = manager.createAgent(feature);
			const reloaded = new AgentManager(
				store,
				tmpDir,
				path.join(tmpDir, ".worktrees"),
				tmux as never,
				undefined,
				new CodingToolRegistry(),
			);
			// Written by a different manager instance sharing the same store —
			// `reloaded` has no in-memory knowledge of it yet.
			manager.recordTurnCompleted(agent.id, "f1", "review-1");
			expect(reloaded.peekPendingReviewId("f1", agent.id)).toBeUndefined();

			reloaded.getAgents("f1");
			expect(reloaded.peekPendingReviewId("f1", agent.id)).toBe("review-1");
		});

		it("clears the receipt only when it matches the expected id", () => {
			const agent = manager.createAgent(feature);
			manager.recordTurnCompleted(agent.id, "f1", "review-1");

			manager.acknowledgeReviewIfMatches(agent.id, "f1", "review-mismatch");
			expect(manager.getAgents("f1")[0].pendingReviewId).toBe("review-1");

			manager.acknowledgeReviewIfMatches(agent.id, "f1", "review-1");
			expect(manager.getAgents("f1")[0].pendingReviewId).toBeUndefined();
		});

		// The exact race the reviewer's round-3 finding describes: a focus
		// click captures R1 as the receipt to acknowledge; before that
		// deferred acknowledgement runs, a newer completion R2 arrives. R2
		// must survive the stale acknowledgement of R1.
		it("a stale acknowledgement for an earlier receipt never clears a newer one", () => {
			const agent = manager.createAgent(feature);
			manager.recordTurnCompleted(agent.id, "f1", "review-1");
			const expectedReviewId = manager.peekPendingReviewId("f1", agent.id);

			// A newer completion races in before the (deferred, in the real
			// AgentFocusService flow) acknowledgement of review-1 runs.
			manager.recordTurnCompleted(agent.id, "f1", "review-2");

			// biome-ignore lint/style/noNonNullAssertion: captured above, guaranteed defined
			manager.acknowledgeReviewIfMatches(agent.id, "f1", expectedReviewId!);

			expect(manager.getAgents("f1")[0].pendingReviewId).toBe("review-2");
		});
	});

	describe("deleteAgent", () => {
		it("removes agent", () => {
			const agent = manager.createAgent(feature);
			manager.deleteAgent(agent.id, "f1");
			expect(manager.getAgents("f1")).toHaveLength(0);
		});

		it("clears a pending review receipt so it cannot leak onto a later agent reusing the id space", () => {
			const agent = manager.createAgent(feature);
			manager.recordTurnCompleted(agent.id, "f1", "review-1");

			manager.deleteAgent(agent.id, "f1");

			const inbox = JSON.parse(
				fs.readFileSync(
					path.join(tmpDir, "features", "f1", "review-inbox.json"),
					"utf-8",
				),
			);
			expect(inbox.pending[agent.id]).toBeUndefined();
		});
	});

	describe("removeAgentWorktreeForFinish", () => {
		it("keeps the agent record while removing its worktree", async () => {
			const perAgentFeature: Feature = {
				...feature,
				isolation: "per-agent",
			};
			mockExecSync.mockReturnValue(Buffer.from(""));
			const agent = manager.createAgent(perAgentFeature);
			mockExecFile.mockImplementation(((
				_callbackFile: string,
				_callbackArgs: readonly string[],
				_callbackOptions: unknown,
				callback: (
					error: Error | null,
					result?: { stdout: string; stderr: string },
				) => void,
			) => {
				callback(null, { stdout: "", stderr: "" });
			}) as never);

			expect(
				await manager.removeAgentWorktreeForFinish(agent.id, "f1"),
			).toMatchObject({ removed: true, worktreePath: agent.worktreePath });
			expect(manager.getAgents("f1")).toHaveLength(1);
		});

		it("keeps Git protection for a clean assessment when the agent worktree becomes dirty", async () => {
			const perAgentFeature: Feature = {
				...feature,
				isolation: "per-agent",
			};
			mockExecSync.mockReturnValue(Buffer.from(""));
			const agent = manager.createAgent(perAgentFeature);
			fs.mkdirSync(agent.worktreePath as string, { recursive: true });
			mockExecSync.mockReset();
			mockExecSync.mockImplementation(() => {
				throw new Error("contains modified files");
			});
			mockExecFile.mockImplementation(((
				_callbackFile: string,
				_callbackArgs: readonly string[],
				_callbackOptions: unknown,
				callback: (
					error: Error | null,
					result?: { stdout: string; stderr: string },
				) => void,
			) => {
				callback(new Error("contains modified files"));
			}) as never);

			expect(
				await manager.removeAgentWorktreeForFinish(agent.id, "f1", false),
			).toMatchObject({ removed: false });
			expect(
				mockExecFile.mock.calls.some(
					([file, args]) =>
						file === "git" && Array.isArray(args) && args.includes("--force"),
				),
			).toBe(false);
			expect(manager.getAgents("f1")).toHaveLength(1);
		});
	});

	describe("deleteAllAgents", () => {
		it("removes all agents for a feature", () => {
			manager.createAgent(feature);
			manager.createAgent(feature);
			manager.deleteAllAgents("f1");
			expect(manager.getAgents("f1")).toHaveLength(0);
		});

		it("clears pending review receipts for every removed agent", () => {
			const agentA = manager.createAgent(feature);
			const agentB = manager.createAgent(feature);
			manager.recordTurnCompleted(agentA.id, "f1", "review-a");
			manager.recordTurnCompleted(agentB.id, "f1", "review-b");

			manager.deleteAllAgents("f1");

			const inbox = JSON.parse(
				fs.readFileSync(
					path.join(tmpDir, "features", "f1", "review-inbox.json"),
					"utf-8",
				),
			);
			expect(inbox.pending).toEqual({});
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

		it("clears a pending review receipt so it cannot resurface if the agent is reopened", () => {
			const agent = manager.createAgent(feature);
			manager.recordTurnCompleted(agent.id, "f1", "review-1");

			manager.closeAgent(agent.id, "f1");
			expect(manager.getAgents("f1")[0].pendingReviewId).toBeUndefined();

			manager.reopenAgent(agent.id, feature);
			expect(manager.getAgents("f1")[0].pendingReviewId).toBeUndefined();
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

	describe("getAgents attention observation (integration)", () => {
		it("exposes the startup read model without probing the provider", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const agent = manager.createAgent(feature, "opencode");
			manager.markAgentStarted(agent.id, feature.id);
			manager.updateAgentSessionId(agent.id, feature.id, "ses_startup");
			mockExecSync.mockReset();

			const agents = manager.getAgentsReadModel(feature.id);

			expect(mockExecSync).not.toHaveBeenCalled();
			expect(agents[0]).toMatchObject({
				id: agent.id,
				sessionId: "ses_startup",
			});
		});

		it("collapses repeated observation of the same agent within one window to a single provider read", () => {
			// Reproduces the real fan-out path: reconcilePresence's 15s timer, a
			// sidebar re-render, and SessionBinder's own 15s timer can all call
			// AgentManager.getAgents() for the same feature within the same
			// window. None of them know about each other. Each call implicitly
			// resolves attention (getAgents -> withAttentionStatus), and for a
			// provider like OpenCode that means a raw read per call (a SQLite
			// query, or an `opencode db` subprocess as a fallback) unless it is
			// deduplicated below the AgentManager layer.
			mockExecSync.mockReturnValue(Buffer.from(""));
			const agent = manager.createAgent(feature, "opencode");
			manager.markAgentStarted(agent.id, feature.id);
			manager.updateAgentSessionId(agent.id, feature.id, "ses_abc123");
			mockExecSync.mockReset();

			const attentionRead = vi
				.spyOn(OpenCodeSessionProvider.prototype, "readAttention")
				.mockReturnValue({
					status: "working",
					evidence: "opencode.assistant.working",
				});

			// Simulate the 3 independent consumers reading this agent within the
			// same logical tick.
			const fromReconcilePresence = manager.getAgents(feature.id);
			const fromSidebarRender = manager.getAgents(feature.id);
			const fromSessionBinderLikeRead = manager.getAgents(feature.id);

			expect(attentionRead).toHaveBeenCalledTimes(1);
			for (const agents of [
				fromReconcilePresence,
				fromSidebarRender,
				fromSessionBinderLikeRead,
			]) {
				expect(agents[0]?.attentionStatus).toBe("working");
			}
			attentionRead.mockRestore();
		});
	});
});
