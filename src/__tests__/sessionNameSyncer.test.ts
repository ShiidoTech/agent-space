import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agents/agentManager";
import { SessionNameSyncer } from "../agents/sessionNameSyncer";
import { ClaudeSessionProvider } from "../agents/sessionProviders/claudeSessionProvider";
import { CodexSessionProvider } from "../agents/sessionProviders/codexSessionProvider";
import { ProjectManager } from "../projects/projectManager";
import { GlobalStore } from "../storage/globalStore";
import type { Agent, Feature } from "../types";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

/** Assert agent has a sessionId and return it (avoids non-null assertions). */
function sid(agent: Agent): string {
	if (!agent.sessionId) throw new Error("expected agent to have sessionId");
	return agent.sessionId;
}

function createTestProjectManager(
	repoRoot: string,
	features: Feature[],
): { projectManager: ProjectManager; agentManager: AgentManager } {
	const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "sns-storage-"));
	const globalStore = new GlobalStore(storagePath);
	const projectManager = new ProjectManager(globalStore, storagePath);
	const project = projectManager.addProject(repoRoot, "test-project");

	const ctx = projectManager.getContext(project.id);
	if (!ctx) throw new Error("context should exist");
	ctx.store.saveFeatures(features);

	const projectManager2 = new ProjectManager(globalStore, storagePath);
	const ctx2 = projectManager2.getContext(project.id);
	if (!ctx2) throw new Error("context should exist");

	return { projectManager: projectManager2, agentManager: ctx2.agentManager };
}

describe("SessionNameSyncer", () => {
	let tmpDir: string;
	let projectsDir: string;
	let codexSessionsDir: string;
	let codexSessionIndexPath: string;
	let claudeProvider: ClaudeSessionProvider;
	let codexProvider: CodexSessionProvider;

	const feature: Feature = {
		id: "f1",
		name: "auth",
		branch: "feat/auth",
		worktreePath: "/tmp/worktrees/auth",
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-03-04T00:00:00.000Z",
	};

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sns-test-"));
		projectsDir = path.join(tmpDir, "projects");
		codexSessionsDir = path.join(tmpDir, "codex-sessions");
		codexSessionIndexPath = path.join(tmpDir, "session_index.jsonl");
		fs.mkdirSync(projectsDir, { recursive: true });
		fs.mkdirSync(codexSessionsDir, { recursive: true });
		claudeProvider = new ClaudeSessionProvider(projectsDir);
		codexProvider = new CodexSessionProvider(
			codexSessionsDir,
			codexSessionIndexPath,
		);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function makeSyncer() {
		return new SessionNameSyncer([claudeProvider, codexProvider]);
	}

	function writeJsonlFile(
		sessionId: string,
		lines: string[],
		dir = "-home-test-project",
	) {
		const dirPath = path.join(projectsDir, dir);
		fs.mkdirSync(dirPath, { recursive: true });
		fs.writeFileSync(
			path.join(dirPath, `${sessionId}.jsonl`),
			`${lines.join("\n")}\n`,
		);
	}

	function appendToJsonl(
		sessionId: string,
		line: string,
		dir = "-home-test-project",
	) {
		const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
		fs.appendFileSync(filePath, `${line}\n`);
	}

	function customTitleEvent(title: string, sessionId = "test-session") {
		return JSON.stringify({
			type: "custom-title",
			customTitle: title,
			sessionId,
		});
	}

	function aiTitleEvent(title: string, sessionId = "test-session") {
		return JSON.stringify({
			type: "ai-title",
			aiTitle: title,
			sessionId,
		});
	}

	function messageEvent(content: string) {
		return JSON.stringify({
			type: "human",
			message: { content },
		});
	}

	function writeCodexSessionIndex(lines: string[]) {
		fs.writeFileSync(codexSessionIndexPath, `${lines.join("\n")}\n`);
	}

	function writeCodexSession(sessionId: string, lines: string[]) {
		const dir = path.join(codexSessionsDir, "2026", "08", "09");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `rollout-${sessionId}.jsonl`),
			`${lines.join("\n")}\n`,
		);
	}

	describe("handles multiple custom-title events", () => {
		it("takes the LAST custom-title from the file", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			writeJsonlFile(sid(agent), [
				customTitleEvent("first-name", sid(agent)),
				messageEvent("some work"),
				customTitleEvent("second-name", sid(agent)),
				messageEvent("more work"),
				customTitleEvent("final-name", sid(agent)),
			]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("final-name");

			syncer.dispose();
		});
	});

	describe("skips agents with status done", () => {
		it("does not rename done agents", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);
			agentManager.updateAgentStatus(agent.id, "f1", "done");

			writeJsonlFile(sid(agent), [
				customTitleEvent("should-not-apply", sid(agent)),
			]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("Agent 1");

			syncer.dispose();
		});
	});

	describe("skips agents without registered provider", () => {
		it("does not process agents with toolId other than claude or codex", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature, "copilot");

			// Even if a JSONL file exists with matching sessionId, copilot agents should be skipped
			if (agent.sessionId) {
				writeJsonlFile(agent.sessionId, [
					customTitleEvent("copilot-name", agent.sessionId),
				]);
			}

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("Agent 1");

			syncer.dispose();
		});

		it("processes agents with toolId claude", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature, "claude");

			writeJsonlFile(sid(agent), [customTitleEvent("claude-name", sid(agent))]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("claude-name");

			syncer.dispose();
		});

		it("processes agents with toolId codex", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature, "codex");
			agentManager.updateAgentSessionId(agent.id, "f1", "codex-session");

			writeCodexSessionIndex([
				JSON.stringify({
					id: "codex-session",
					thread_name: "codex-name",
					updated_at: "2026-03-06T16:28:46.350986641Z",
				}),
			]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("codex-name");

			syncer.dispose();
		});

		it("renames Codex agents from the response_item user message shape", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature, "codex");
			agentManager.updateAgentSessionId(agent.id, "f1", "codex-real-shape");

			writeCodexSession("codex-real-shape", [
				JSON.stringify({
					type: "session_meta",
					payload: { id: "codex-real-shape", cwd: "/tmp/project" },
				}),
				JSON.stringify({
					type: "response_item",
					payload: {
						type: "message",
						role: "user",
						content: [
							{
								type: "input_text",
								text: "Diagnose the session title sync",
							},
						],
					},
				}),
			]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			expect(agentManager.getAgents("f1")[0].name).toBe(
				"Diagnose the session title sync",
			);
			syncer.dispose();
		});

		it("processes agents with undefined toolId (backward compat)", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			// createAgent with no toolId → agent gets sessionId
			const agent = agentManager.createAgent(feature);

			writeJsonlFile(sid(agent), [customTitleEvent("legacy-name", sid(agent))]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("legacy-name");

			syncer.dispose();
		});
	});

	describe("findSessionFile (via ClaudeSessionProvider)", () => {
		it("locates file across project dirs", () => {
			const sessionId = "abc-123-def";

			writeJsonlFile(
				sessionId,
				[messageEvent("hello")],
				"-home-user-project-a",
			);

			const found = claudeProvider.findSessionFile(sessionId);
			expect(found).toBe(
				path.join(projectsDir, "-home-user-project-a", `${sessionId}.jsonl`),
			);
		});

		it("returns null for missing session", () => {
			const found = claudeProvider.findSessionFile("nonexistent-session-id");
			expect(found).toBeNull();
		});

		it("caches found paths", () => {
			const sessionId = "cached-session";

			writeJsonlFile(sessionId, [messageEvent("hello")]);

			const first = claudeProvider.findSessionFile(sessionId);
			const second = claudeProvider.findSessionFile(sessionId);
			expect(first).toBe(second);
		});
	});

	describe("onAgentRenamed callback", () => {
		it("fires callback when agent is renamed via syncAll", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			writeJsonlFile(sid(agent), [
				customTitleEvent("callback-test", sid(agent)),
			]);

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);
			syncer.syncAll();

			expect(callback).toHaveBeenCalledOnce();

			syncer.dispose();
		});
	});

	describe("syncAll re-reads and renames unnamed agents", () => {
		it("renames unnamed agents on syncAll", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			// No JSONL at startup
			const syncer = makeSyncer();
			syncer.start(projectManager);

			expect(agentManager.getAgents("f1")[0].name).toBe("Agent 1");

			// Now write JSONL and call syncAll
			writeJsonlFile(sid(agent), [customTitleEvent("synced-name", sid(agent))]);

			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("synced-name");

			syncer.dispose();
		});

		it("does not overwrite user-given names on syncAll", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);
			agentManager.renameAgent(agent.id, "f1", "Custom Name");

			writeJsonlFile(sid(agent), [customTitleEvent("synced-name", sid(agent))]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("Custom Name");

			syncer.dispose();
		});
	});

	describe("clearFeature clears cached state", () => {
		it("cleans up state for a feature's agents", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			writeJsonlFile(sid(agent), [
				customTitleEvent("will-be-cleared", sid(agent)),
			]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			expect(agentManager.getAgents("f1")[0].name).toBe("will-be-cleared");

			syncer.clearFeature("f1");

			// After clearing, agent is renamed back and syncAll should re-read
			agentManager.renameAgent(agent.id, "f1", "Agent 1");
			syncer.syncAll();

			expect(agentManager.getAgents("f1")[0].name).toBe("will-be-cleared");

			syncer.dispose();
		});
	});

	describe("truncates long titles", () => {
		it("truncates titles longer than 40 chars", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			const longTitle =
				"this-is-a-very-long-title-that-should-definitely-be-truncated-by-syncer";
			writeJsonlFile(sid(agent), [customTitleEvent(longTitle, sid(agent))]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name.length).toBeLessThanOrEqual(40);
			expect(agents[0].name).toMatch(/\u2026$/);

			syncer.dispose();
		});

		it("does not truncate short titles", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			writeJsonlFile(sid(agent), [customTitleEvent("short", sid(agent))]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("short");

			syncer.dispose();
		});
	});

	describe("readTitle (via ClaudeSessionProvider)", () => {
		it("reads last custom-title from a large file", () => {
			// Create a large file with many message events and one custom-title near the end
			const lines: string[] = [];
			for (let i = 0; i < 500; i++) {
				lines.push(
					messageEvent(
						`message number ${i} with some padding to make it bigger`,
					),
				);
			}
			lines.push(customTitleEvent("found-at-end"));

			const dir = path.join(projectsDir, "-test-dir");
			fs.mkdirSync(dir, { recursive: true });
			const filePath = path.join(dir, "big-session.jsonl");
			fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

			const title = claudeProvider.readTitle(filePath);
			expect(title).toBe("found-at-end");
		});

		it("returns null when no custom-title exists", () => {
			const dir = path.join(projectsDir, "-test-dir");
			fs.mkdirSync(dir, { recursive: true });
			const filePath = path.join(dir, "no-title.jsonl");
			fs.writeFileSync(
				filePath,
				`${[messageEvent("hello"), messageEvent("world")].join("\n")}\n`,
			);

			const title = claudeProvider.readTitle(filePath);
			expect(title).toBeNull();
		});

		it("uses the latest ai-title when no custom-title exists", () => {
			const dir = path.join(projectsDir, "-test-dir");
			fs.mkdirSync(dir, { recursive: true });
			const filePath = path.join(dir, "ai-title.jsonl");
			fs.writeFileSync(
				filePath,
				`${[aiTitleEvent("first"), messageEvent("work"), aiTitleEvent("latest")].join("\n")}\n`,
			);

			expect(claudeProvider.readTitle(filePath)).toBe("latest");
		});

		it("keeps custom-title ahead of automatic ai-title", () => {
			const dir = path.join(projectsDir, "-test-dir");
			fs.mkdirSync(dir, { recursive: true });
			const filePath = path.join(dir, "custom-priority.jsonl");
			fs.writeFileSync(
				filePath,
				`${[customTitleEvent("chosen"), aiTitleEvent("automatic")].join("\n")}\n`,
			);

			expect(claudeProvider.readTitle(filePath)).toBe("chosen");
		});

		it("uses an index summary only for the matching session id", () => {
			const dir = path.join(projectsDir, "-test-dir");
			fs.mkdirSync(dir, { recursive: true });
			const sessionId = "indexed-session";
			fs.writeFileSync(
				path.join(dir, `${sessionId}.jsonl`),
				`${messageEvent("hello")}\n`,
			);
			fs.writeFileSync(
				path.join(dir, "sessions-index.json"),
				JSON.stringify({
					version: 1,
					entries: [
						{ sessionId, summary: "indexed summary" },
						{ sessionId: "other", summary: "wrong summary" },
					],
				}),
			);

			expect(claudeProvider.readName(sessionId)).toBe("indexed summary");
		});

		it("returns null for empty file", () => {
			const dir = path.join(projectsDir, "-test-dir");
			fs.mkdirSync(dir, { recursive: true });
			const filePath = path.join(dir, "empty.jsonl");
			fs.writeFileSync(filePath, "");

			const title = claudeProvider.readTitle(filePath);
			expect(title).toBeNull();
		});
	});

	describe("syncAgentOnFocus", () => {
		it("renames agent when JSONL title changes after start", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			writeJsonlFile(sid(agent), [messageEvent("hello")]);

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);

			expect(agentManager.getAgents("f1")[0].name).toBe("Agent 1");

			// Append a custom-title event after start
			appendToJsonl(sid(agent), customTitleEvent("focus-rename", sid(agent)));

			syncer.syncAgentOnFocus(agent.id);

			const agents = agentManager.getAgents("f1");
			expect(agents[0].name).toBe("focus-rename");
			expect(callback).toHaveBeenCalled();

			syncer.dispose();
		});

		it("no-op when title is unchanged (cached)", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);

			writeJsonlFile(sid(agent), [
				customTitleEvent("cached-title", sid(agent)),
			]);

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);
			syncer.syncAll();

			// syncAll renames and caches the title
			expect(callback).toHaveBeenCalledOnce();
			callback.mockClear();

			// syncAgentOnFocus should not rename again since title is cached
			syncer.syncAgentOnFocus(agent.id);
			expect(callback).not.toHaveBeenCalled();

			syncer.dispose();
		});

		it("no-op for unknown agentId", () => {
			const { projectManager } = createTestProjectManager(tmpDir, [feature]);

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);

			syncer.syncAgentOnFocus("nonexistent-agent-id");
			expect(callback).not.toHaveBeenCalled();

			syncer.dispose();
		});

		it("skips done agents", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);
			agentManager.updateAgentStatus(agent.id, "f1", "done");

			writeJsonlFile(sid(agent), [
				customTitleEvent("should-not-apply", sid(agent)),
			]);

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);

			syncer.syncAgentOnFocus(agent.id);
			expect(callback).not.toHaveBeenCalled();
			expect(agentManager.getAgents("f1")[0].name).toBe("Agent 1");

			syncer.dispose();
		});

		it("skips agents without registered provider", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature, "copilot");

			if (agent.sessionId) {
				writeJsonlFile(agent.sessionId, [
					customTitleEvent("copilot-name", agent.sessionId),
				]);
			}

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);

			syncer.syncAgentOnFocus(agent.id);
			expect(callback).not.toHaveBeenCalled();
			expect(agentManager.getAgents("f1")[0].name).toBe("Agent 1");

			syncer.dispose();
		});

		it("renames codex agent when session index changes after start", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature, "codex");
			agentManager.updateAgentSessionId(agent.id, "f1", "codex-focus");

			writeCodexSessionIndex([
				JSON.stringify({
					id: "codex-focus",
					thread_name: "before-focus",
					updated_at: "2026-03-06T16:28:46.350986641Z",
				}),
			]);

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);
			syncer.syncAll();

			writeCodexSessionIndex([
				JSON.stringify({
					id: "codex-focus",
					thread_name: "after-focus",
					updated_at: "2026-03-06T16:29:46.350986641Z",
				}),
			]);

			syncer.syncAgentOnFocus(agent.id);

			expect(agentManager.getAgents("f1")[0].name).toBe("after-focus");
			expect(callback).toHaveBeenCalledTimes(2);

			syncer.dispose();
		});

		it("preserves user-given names when focus sync discovers a title", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);
			agentManager.renameAgent(agent.id, "f1", "My Custom Name");

			writeJsonlFile(sid(agent), [messageEvent("hello")]);

			const syncer = makeSyncer();
			const callback = vi.fn();
			syncer.onAgentRenamed(callback);
			syncer.start(projectManager);

			// Startup should preserve user-given name (no title in JSONL yet)
			expect(agentManager.getAgents("f1")[0].name).toBe("My Custom Name");
			expect(callback).not.toHaveBeenCalled();

			// Now a title appears in the JSONL
			appendToJsonl(sid(agent), customTitleEvent("jsonl-title", sid(agent)));

			// Focus sync must not overwrite the user-given name.
			syncer.syncAgentOnFocus(agent.id);
			expect(agentManager.getAgents("f1")[0].name).toBe("My Custom Name");
			expect(callback).not.toHaveBeenCalled();

			syncer.dispose();
		});

		it("updates a name previously assigned by the syncer", () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);
			writeJsonlFile(sid(agent), [aiTitleEvent("first title", sid(agent))]);

			const syncer = makeSyncer();
			syncer.start(projectManager);
			syncer.syncAll();
			expect(agentManager.getAgents("f1")[0].name).toBe("first title");

			appendToJsonl(sid(agent), aiTitleEvent("updated title", sid(agent)));
			syncer.syncAgentOnFocus(agent.id);

			expect(agentManager.getAgents("f1")[0].name).toBe("updated title");
			syncer.dispose();
		});
	});

	describe("async observation boundary", () => {
		it("claude async.readName resolves a custom title", async () => {
			const sessionId = "async-claude-title";
			writeJsonlFile(sessionId, [
				customTitleEvent("async-claude-title", sessionId),
			]);

			expect(await claudeProvider.async.readName(sessionId)).toBe(
				"async-claude-title",
			);
		});

		it("claude async.hasSession resolves for an existing transcript", async () => {
			const sessionId = "async-claude-has";
			writeJsonlFile(sessionId, [messageEvent("hello")]);

			expect(await claudeProvider.async.hasSession(sessionId)).toBe(true);
			expect(await claudeProvider.async.hasSession("missing-session")).toBe(
				false,
			);
		});

		it("claude async.scanSessions finds transcripts with their project path", async () => {
			const sessionId = "async-claude-scan";
			writeJsonlFile(sessionId, [
				JSON.stringify({
					type: "assistant",
					sessionId,
					cwd: "/tmp/project",
					timestamp: "2026-03-06T16:28:46.000Z",
				}),
			]);

			const sessions = await claudeProvider.async.scanSessions({ fresh: true });
			const session = sessions.find((s) => s.sessionId === sessionId);
			expect(session?.projectPath).toBe("/tmp/project");
		});

		it("codex async.readName resolves a thread name from the index", async () => {
			const sessionId = "async-codex-title";
			writeCodexSessionIndex([
				JSON.stringify({
					id: sessionId,
					thread_name: "async-codex-title",
					updated_at: "2026-03-06T16:28:46.350986641Z",
				}),
			]);

			expect(await codexProvider.async.readName(sessionId)).toBe(
				"async-codex-title",
			);
		});

		it("codex async.hasSession resolves for an existing rollout", async () => {
			const sessionId = "async-codex-has";
			writeCodexSession(sessionId, [
				JSON.stringify({
					type: "session_meta",
					payload: { id: sessionId, cwd: "/tmp/project" },
				}),
			]);

			expect(await codexProvider.async.hasSession(sessionId)).toBe(true);
			expect(await codexProvider.async.hasSession("missing-session")).toBe(
				false,
			);
		});

		it("codex async.scanSessions finds rollouts", async () => {
			const sessionId = "async-codex-scan";
			writeCodexSession(sessionId, [
				JSON.stringify({
					type: "session_meta",
					payload: { id: sessionId, cwd: "/tmp/project" },
				}),
			]);

			const sessions = await codexProvider.async.scanSessions();
			expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);
		});

		it("periodic poll renames an unnamed agent through the async boundary", async () => {
			const { projectManager, agentManager } = createTestProjectManager(
				tmpDir,
				[feature],
			);
			const agent = agentManager.createAgent(feature);
			writeJsonlFile(sid(agent), [
				customTitleEvent("async-rename", sid(agent)),
			]);

			const syncer = makeSyncer();
			syncer.start(projectManager, 10);

			// The periodic pass reads through the async boundary, so poll for
			// the rename instead of racing a fixed sleep.
			const deadline = Date.now() + 2000;
			let name = agentManager.getAgents("f1")[0]?.name;
			while (name !== "async-rename" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
				name = agentManager.getAgents("f1")[0]?.name;
			}

			expect(name).toBe("async-rename");
			syncer.dispose();
		});

		it("serializes overlapping ticks while a pass is in flight", async () => {
			vi.useFakeTimers();
			try {
				const { projectManager, agentManager } =
					createTestProjectManager(tmpDir, [feature]);
				const agent = agentManager.createAgent(feature);
				if (!agent.sessionId) throw new Error("expected session id");

				let readNameAsyncCalls = 0;
				let resolveTitle: ((title: string | null) => void) | undefined;
				const titleDeferred = new Promise<string | null>((resolve) => {
					resolveTitle = resolve;
				});
				const stubAdapter = {
					toolId: "claude",
					readName: () => null,
					async: {
						readName: () => {
							readNameAsyncCalls += 1;
							return titleDeferred;
						},
					},
				};

				const syncer = new SessionNameSyncer([stubAdapter]);
				syncer.start(projectManager, 50);

				await vi.advanceTimersByTimeAsync(50);
				expect(readNameAsyncCalls).toBe(1);

				// A second tick while the first pass is still suspended on the
				// async read shares the in-flight pass instead of rescanning.
				await vi.advanceTimersByTimeAsync(50);
				expect(readNameAsyncCalls).toBe(1);

				resolveTitle!("async-in-flight");
				await vi.advanceTimersByTimeAsync(0);
				await vi.runAllTicks();

				expect(agentManager.getAgents("f1")[0]?.name).toBe(
					"async-in-flight",
				);
				syncer.dispose();
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
