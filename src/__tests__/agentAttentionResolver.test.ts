import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAttentionResolver } from "../agents/attention/agentAttentionResolver";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import { ClaudeSessionProvider } from "../agents/sessionProviders/claudeSessionProvider";
import { CodexSessionProvider } from "../agents/sessionProviders/codexSessionProvider";
import type { TmuxIntegration } from "../agents/tmux";
import type { Agent, CodingTool } from "../types";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-space-attention-"));
	tempDirs.push(dir);
	return dir;
}

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "agent-1",
		featureId: "feature-1",
		name: "Agent 1",
		sessionId: "session-1",
		tmuxSession: "agent-space-feature-1-agent-1",
		toolId: "claude",
		status: "running",
		hasStarted: true,
		createdAt: new Date(0).toISOString(),
		...overrides,
	};
}

function tmux(overrides: Partial<TmuxIntegration> = {}): TmuxIntegration {
	return {
		sessionName: () => "agent-space-feature-1-agent-1",
		isSessionAlive: () => true,
		getPaneStatus: () => ({ dead: false, exitCode: 0 }),
		...overrides,
	} as TmuxIntegration;
}

function registry(tool: CodingTool): CodingToolRegistry {
	return {
		resolveAgentTool: () => tool,
	} as CodingToolRegistry;
}

function writeJsonl(filePath: string, rows: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		"utf-8",
	);
}

describe("AgentAttentionResolver", () => {
	it("keeps terminal lifecycle facts authoritative", () => {
		const resolver = new AgentAttentionResolver(
			tmux(),
			registry({ id: "generic", name: "Generic", command: "generic" }),
		);

		expect(resolver.resolve(agent({ status: "done" })).status).toBe("done");
		expect(
			resolver.resolve(
				agent({ status: "errored", lastError: "launch failed" }),
			).status,
		).toBe("failed");
		expect(
			resolver.resolve(agent({ status: "stopped", hasStarted: false })).status,
		).toBe("unknown");
	});

	it("does not preserve stale running state after the tmux session disappears", () => {
		const resolver = new AgentAttentionResolver(
			tmux({ isSessionAlive: () => false }),
			registry({ id: "generic", name: "Generic", command: "generic" }),
		);

		const snapshot = resolver.resolve(agent({ status: "running" }));
		expect(snapshot.status).toBe("unknown");
		expect(snapshot.source).toBe("tmux");
	});

	it("uses idle rather than inventing a precise state for an unsupported live CLI", () => {
		const resolver = new AgentAttentionResolver(
			tmux(),
			registry({ id: "generic", name: "Generic", command: "generic" }),
		);

		expect(resolver.resolve(agent({ toolId: "generic" })).status).toBe("idle");
	});

	it("maps Claude end_turn to waiting_for_user", () => {
		const root = tempDir();
		const projectsDir = path.join(root, "projects");
		const sessionFile = path.join(projectsDir, "project", "session-1.jsonl");
		writeJsonl(sessionFile, [
			{
				type: "user",
				sessionId: "session-1",
				message: { role: "user", content: "fix it" },
			},
			{
				type: "assistant",
				sessionId: "session-1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					stop_reason: "end_turn",
				},
			},
		]);

		const resolver = new AgentAttentionResolver(
			tmux(),
			registry({
				id: "claude",
				name: "Claude Code",
				command: "claude",
				family: "claude",
			}),
			{
				claudeProviderFactory: () => new ClaudeSessionProvider(projectsDir),
			},
		);

		expect(resolver.resolve(agent()).status).toBe("waiting_for_user");
	});

	it("maps Claude tool continuation to working and AskUserQuestion to waiting", () => {
		const root = tempDir();
		const projectsDir = path.join(root, "projects");
		const sessionFile = path.join(projectsDir, "project", "session-1.jsonl");
		const provider = new ClaudeSessionProvider(projectsDir);
		const resolver = new AgentAttentionResolver(
			tmux(),
			registry({
				id: "claude",
				name: "Claude Code",
				command: "claude",
				family: "claude",
			}),
			{ claudeProviderFactory: () => provider },
		);

		writeJsonl(sessionFile, [
			{
				type: "assistant",
				sessionId: "session-1",
				message: {
					content: [{ type: "tool_use", name: "Read" }],
					stop_reason: "tool_use",
				},
			},
		]);
		expect(resolver.resolve(agent()).status).toBe("working");

		writeJsonl(sessionFile, [
			{
				type: "assistant",
				sessionId: "session-1",
				message: {
					content: [{ type: "tool_use", name: "AskUserQuestion" }],
					stop_reason: "tool_use",
				},
			},
		]);
		expect(resolver.resolve(agent()).status).toBe("waiting_for_user");
	});

	it("ignores a newer Claude row that explicitly belongs to another session", () => {
		const root = tempDir();
		const projectsDir = path.join(root, "projects");
		const sessionFile = path.join(projectsDir, "project", "session-1.jsonl");
		writeJsonl(sessionFile, [
			{
				type: "assistant",
				sessionId: "session-1",
				message: { content: [], stop_reason: "end_turn" },
			},
			{
				type: "assistant",
				sessionId: "different-session",
				message: { content: [], stop_reason: "tool_use" },
			},
		]);

		const resolver = new AgentAttentionResolver(
			tmux(),
			registry({
				id: "claude",
				name: "Claude Code",
				command: "claude",
				family: "claude",
			}),
			{
				claudeProviderFactory: () => new ClaudeSessionProvider(projectsDir),
			},
		);

		expect(resolver.resolve(agent()).status).toBe("waiting_for_user");
	});

	it("maps Codex structured turn lifecycle and user-attention events", () => {
		const sessionsDir = tempDir();
		const sessionId = "019f5ab3-2ab3-7da3-b727-f5646b23bac6";
		const sessionFile = path.join(
			sessionsDir,
			`rollout-2026-07-13T16-58-44-${sessionId}.jsonl`,
		);
		const provider = new CodexSessionProvider(
			sessionsDir,
			path.join(sessionsDir, "session_index.jsonl"),
		);
		const resolver = new AgentAttentionResolver(
			tmux(),
			registry({ id: "codex", name: "Codex", command: "codex", family: "codex" }),
			{ codexProvider: provider },
		);
		const codexAgent = agent({ sessionId, toolId: "codex" });

		writeJsonl(sessionFile, [
			{ type: "session_meta", payload: { id: sessionId } },
			{ type: "event_msg", payload: { type: "task_started" } },
		]);
		expect(resolver.resolve(codexAgent).status).toBe("working");

		writeJsonl(sessionFile, [
			{ type: "session_meta", payload: { id: sessionId } },
			{ type: "event_msg", payload: { type: "task_started" } },
			{ type: "event_msg", payload: { type: "request_user_input" } },
		]);
		expect(resolver.resolve(codexAgent).status).toBe("waiting_for_user");

		writeJsonl(sessionFile, [
			{ type: "session_meta", payload: { id: sessionId } },
			{ type: "event_msg", payload: { type: "task_complete" } },
		]);
		expect(resolver.resolve(codexAgent).status).toBe("waiting_for_user");
	});

	it("treats a non-zero dead pane as failed", () => {
		const resolver = new AgentAttentionResolver(
			tmux({ getPaneStatus: () => ({ dead: true, exitCode: 17 }) }),
			registry({ id: "generic", name: "Generic", command: "generic" }),
		);

		const snapshot = resolver.resolve(agent({ toolId: "generic" }));
		expect(snapshot.status).toBe("failed");
		expect(snapshot.reason).toContain("17");
	});
});
