import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/platform", () => ({
	commandExists: vi.fn(),
}));

import { commandExists } from "../utils/platform";

const mockCommandExists = vi.mocked(commandExists);

import {
	BUILTIN_CODING_TOOLS,
	BUILTIN_PROVIDERS,
	CodingToolRegistry,
	resolveSessionStoreDir,
} from "../agents/codingToolRegistry";

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
}));

import * as vscode from "vscode";

function mockConfig(values: Record<string, unknown> = {}) {
	(
		vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>
	).mockReturnValue({
		get: (key: string, defaultValue?: unknown) =>
			key in values ? values[key] : defaultValue,
	});
}

describe("CodingToolRegistry", () => {
	let registry: CodingToolRegistry;

	beforeEach(() => {
		registry = new CodingToolRegistry();
		mockConfig();
	});

	describe("getTools", () => {
		it("returns 5 built-in tools by default", () => {
			const tools = registry.getTools();
			expect(tools).toHaveLength(5);
			expect(tools.map((t) => t.id)).toEqual([
				"claude",
				"codex",
				"copilot",
				"opencode",
				"hermes",
			]);
		});

		it("merges user custom tools", () => {
			mockConfig({
				codingTools: [{ id: "aider", name: "Aider", command: "aider" }],
			});
			const tools = registry.getTools();
			expect(tools).toHaveLength(6);
			expect(tools[5].id).toBe("aider");
		});

		it("user tools override builtins by id", () => {
			mockConfig({
				codingTools: [
					{
						id: "claude",
						name: "My Claude",
						command: "claude",
						args: ["--model", "opus"],
					},
				],
			});
			const tools = registry.getTools();
			expect(tools).toHaveLength(5);
			const claude = tools.find((t) => t.id === "claude");
			expect(claude?.name).toBe("My Claude");
			expect(claude?.args).toEqual(["--model", "opus"]);
		});

		it("removes a built-in tool when disabled via enabled:false", () => {
			mockConfig({
				codingTools: [{ id: "claude", enabled: false }],
			});
			const tools = registry.getTools();
			expect(tools.map((t) => t.id)).toEqual([
				"codex",
				"copilot",
				"opencode",
				"hermes",
			]);
		});
	});

	describe("provider capabilities", () => {
		it("declares Hermes as launch-only until structured support is proven", () => {
			const hermes = BUILTIN_PROVIDERS.find(
				(provider) => provider.id === "hermes",
			);
			expect(hermes?.capabilities).toMatchObject({
				launch: true,
				resume: false,
				sessionDiscovery: false,
				sessionNaming: false,
			});
		});

		it("keeps a local Claude launcher on its own session store", () => {
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "claude-perso-registry-"),
			);
			try {
				const projectsDir = path.join(configDir, "projects", "project");
				fs.mkdirSync(projectsDir, { recursive: true });
				fs.writeFileSync(
					path.join(projectsDir, "local-session.jsonl"),
					JSON.stringify({ type: "result" }),
				);
				mockConfig({
					codingTools: [
						{
							id: "claude-perso",
							name: "Claude perso",
							command: "claude-perso",
							family: "claude",
							sessionsDir: configDir,
						},
					],
				});
				const tool = registry.resolveAgentTool("claude-perso");
				const provider = registry.getProvider(tool);

				expect(provider.capabilities.sessionNaming).toBe(true);
				expect(provider.getAttentionSignal?.("local-session")).toEqual({
					status: "idle",
					evidence: "claude.result",
				});
			} finally {
				fs.rmSync(configDir, { recursive: true, force: true });
			}
		});

		it("accepts a sessionsDir that already points at the projects directory", () => {
			// Both spellings are natural, so both have to work. When only the
			// provider normalised `<root>/projects` and capability probing did not,
			// the registry looked for `<root>/projects/projects`, found nothing, and
			// advertised naming and attention as unavailable for a profile it could
			// in fact read — a misconfiguration that looked like a silent agent.
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "claude-projects-registry-"),
			);
			try {
				const projectsDir = path.join(configDir, "projects");
				fs.mkdirSync(path.join(projectsDir, "project"), { recursive: true });
				fs.writeFileSync(
					path.join(projectsDir, "project", "local-session.jsonl"),
					JSON.stringify({ type: "result" }),
				);
				mockConfig({
					codingTools: [
						{
							id: "claude-perso",
							name: "Claude perso",
							command: "claude-perso",
							family: "claude",
							sessionsDir: projectsDir,
						},
					],
				});
				const tool = registry.resolveAgentTool("claude-perso");
				const provider = registry.getProvider(tool);

				expect(provider.capabilities.sessionNaming).toBe(true);
				expect(provider.capabilities.sessionDiscovery).toBe(true);
				expect(provider.getAttentionSignal?.("local-session")).toMatchObject({
					status: "idle",
					evidence: "claude.result",
				});
				expect(resolveSessionStoreDir("claude", projectsDir)).toBe(projectsDir);
			} finally {
				fs.rmSync(configDir, { recursive: true, force: true });
			}
		});

		it("reports a Claude store that does not exist as not session-capable", () => {
			mockConfig({
				codingTools: [
					{
						id: "claude-ghost",
						name: "Claude ghost",
						command: "claude-ghost",
						family: "claude",
						sessionsDir: path.join(os.tmpdir(), "agent-space-absent-profile"),
					},
				],
			});
			const provider = registry.getProvider(
				registry.resolveAgentTool("claude-ghost"),
			);

			expect(provider.capabilities.sessionNaming).toBe(false);
			expect(provider.capabilities.sessionDiscovery).toBe(false);
		});
	});

	describe("getTool", () => {
		it("finds a built-in tool by id", () => {
			const tool = registry.getTool("copilot");
			expect(tool).toBeDefined();
			expect(tool?.name).toBe("GitHub Copilot");
		});

		it("returns undefined for unknown id", () => {
			expect(registry.getTool("nonexistent")).toBeUndefined();
		});
	});

	describe("getDefaultToolId", () => {
		it("returns undefined when unset", () => {
			expect(registry.getDefaultToolId()).toBeUndefined();
		});

		it("returns configured default", () => {
			mockConfig({ defaultTool: "copilot" });
			expect(registry.getDefaultToolId()).toBe("copilot");
		});
	});

	describe("getAvailableTools", () => {
		it("returns only tools found on PATH", () => {
			mockCommandExists.mockImplementation((command) => command === "codex");
			expect(registry.getAvailableTools().map((tool) => tool.id)).toEqual([
				"codex",
			]);
		});
	});

	describe("getAvailableToolsPreferredFirst", () => {
		it("moves the configured default to the front when it is available", () => {
			mockConfig({ defaultTool: "copilot" });
			mockCommandExists.mockImplementation(
				(command) => command === "codex" || command === "copilot",
			);

			expect(
				registry.getAvailableToolsPreferredFirst().map((tool) => tool.id),
			).toEqual(["copilot", "codex"]);
		});

		it("keeps the original order when the default is unavailable", () => {
			mockConfig({ defaultTool: "claude" });
			mockCommandExists.mockImplementation(
				(command) => command === "codex" || command === "copilot",
			);

			expect(
				registry.getAvailableToolsPreferredFirst().map((tool) => tool.id),
			).toEqual(["codex", "copilot"]);
		});
	});

	describe("getPreferredAvailableTool", () => {
		it("falls back to the first available tool when no default is configured", () => {
			mockCommandExists.mockImplementation(
				(command) => command === "codex" || command === "opencode",
			);
			expect(registry.getPreferredAvailableTool()?.id).toBe("codex");
		});

		it("prefers the configured default when it is available", () => {
			mockConfig({ defaultTool: "copilot" });
			mockCommandExists.mockImplementation((command) => command === "copilot");
			expect(registry.getPreferredAvailableTool()?.id).toBe("copilot");
		});

		it("does not fall back when the configured default is missing", () => {
			mockConfig({ defaultTool: "claude" });
			mockCommandExists.mockImplementation((command) => command === "codex");
			expect(registry.getPreferredAvailableTool()).toBeUndefined();
		});

		it("uses only the project allowlist and project default", () => {
			mockCommandExists.mockImplementation(
				(command) => command === "opencode" || command === "codex",
			);
			const config = {
				agents: { enabled: ["opencode", "claude-perso"], default: "opencode" },
			};
			expect(registry.getAvailableTools(config).map((tool) => tool.id)).toEqual(
				["opencode"],
			);
			expect(registry.getPreferredAvailableTool(config)?.id).toBe("opencode");
			expect(
				registry.getUnavailableTools(config).map((tool) => tool.id),
			).toEqual([]);
			expect(registry.getUnknownProjectAgentIds(config)).toEqual([
				"claude-perso",
			]);
		});

		it("returns undefined when no tools are available", () => {
			mockCommandExists.mockReturnValue(false);
			expect(registry.getPreferredAvailableTool()).toBeUndefined();
		});
	});

	describe("resolveAgentTool", () => {
		it("returns claude for undefined toolId", () => {
			const tool = registry.resolveAgentTool(undefined);
			expect(tool.id).toBe("claude");
		});

		it("returns the matching tool for a valid toolId", () => {
			const tool = registry.resolveAgentTool("opencode");
			expect(tool.id).toBe("opencode");
			expect(tool.command).toBe("opencode");
		});

		it("never substitutes builtin claude for an unknown toolId", () => {
			const tool = registry.resolveAgentTool("nonexistent");
			expect(tool.id).toBe("nonexistent");
			expect(tool.command).toBe("nonexistent");
			expect(tool.family).toBe("generic");
		});

		it("preserves a claude-prefixed identity for an unresolved tool", () => {
			const tool = registry.resolveAgentTool("claude-variant");
			expect(tool.id).toBe("claude-variant");
			expect(tool.command).toBe("claude-variant");
			expect(tool.family).toBe("claude");
		});
	});

	describe("buildLaunchCommand", () => {
		it("returns just the command when no args", () => {
			const tool = BUILTIN_CODING_TOOLS[0];
			expect(registry.buildLaunchCommand(tool)).toBe("claude");
		});

		it("joins command and args", () => {
			const tool = {
				id: "custom",
				name: "Custom",
				command: "my-tool",
				args: ["--flag", "value"],
			};
			expect(registry.buildLaunchCommand(tool)).toBe("my-tool --flag value");
		});

		it("returns just the command when args is empty array", () => {
			const tool = {
				id: "custom",
				name: "Custom",
				command: "my-tool",
				args: [],
			};
			expect(registry.buildLaunchCommand(tool)).toBe("my-tool");
		});

		it("appends --session-id for claude tool when sessionId provided", () => {
			const tool = BUILTIN_CODING_TOOLS[0];
			expect(registry.buildLaunchCommand(tool, "abc-123")).toBe(
				"claude --session-id abc-123",
			);
		});

		it("includes --session-id after custom args for claude", () => {
			mockConfig({
				codingTools: [
					{
						id: "claude",
						name: "Claude",
						command: "claude",
						args: ["--model", "opus"],
					},
				],
			});
			const tool = registry.resolveAgentTool("claude");
			expect(registry.buildLaunchCommand(tool, "abc-123")).toBe(
				"claude --model opus --session-id abc-123",
			);
		});

		it("ignores sessionId for non-claude tools", () => {
			const tool = {
				id: "copilot",
				name: "Copilot",
				command: "copilot",
			};
			expect(registry.buildLaunchCommand(tool, "abc-123")).toBe("copilot");
		});

		it("omits --session-id when sessionId is null", () => {
			const tool = BUILTIN_CODING_TOOLS[0];
			expect(registry.buildLaunchCommand(tool, null)).toBe("claude");
		});

		it("deep-merges custom args over a built-in (delta-only config)", () => {
			mockConfig({
				codingTools: [
					{
						id: "claude",
						args: ["--model", "opus"],
					},
				],
			});
			const tool = registry.resolveAgentTool("claude");
			// Built-in identity/fields kept, args overridden, then session-id.
			expect(tool).toMatchObject({
				id: "claude",
				name: "Claude Code",
				command: "claude",
			});
			expect(registry.buildLaunchCommand(tool, "abc-123")).toBe(
				"claude --model opus --session-id abc-123",
			);
		});

		it("supports a wrapped/custom claude-family CLI declared via config", () => {
			mockConfig({
				codingTools: [
					{
						id: "wrapped-claude",
						command: "my-claude",
						args: ["--profile", "work"],
						family: "claude",
					},
				],
			});
			const tool = registry.resolveAgentTool("wrapped-claude");
			// Resumed through its own executable, never the plain `claude`.
			expect(registry.buildLaunchCommand(tool, "abc-123")).toBe(
				"my-claude --profile work --session-id abc-123",
			);
			expect(registry.buildResumeLaunchCommand(tool, "abc-123")).toBe(
				"my-claude --resume abc-123",
			);
			expect(registry.buildResumeLaunchCommand(tool, "abc-123")).toContain(
				"my-claude --resume",
			);
		});

		it("prefixes env vars as shell assignments when launching", () => {
			const tool = {
				id: "custom",
				name: "Custom",
				command: "my-tool",
				env: { CLAUDE_CONFIG_DIR: "/home/user/.config/my-claude" },
			};
			expect(registry.buildLaunchCommand(tool)).toBe(
				"CLAUDE_CONFIG_DIR='/home/user/.config/my-claude' my-tool",
			);
		});
	});

	describe("buildResumeLaunchCommand", () => {
		it("returns claude --resume <id> when claude tool has sessionId", () => {
			const tool = registry.resolveAgentTool("claude");
			expect(registry.buildResumeLaunchCommand(tool, "sess-123")).toBe(
				"claude --resume sess-123",
			);
		});

		it("returns fresh launch when claude tool has no sessionId", () => {
			const tool = registry.resolveAgentTool("claude");
			expect(registry.buildResumeLaunchCommand(tool)).toBe("claude");
			expect(registry.buildResumeLaunchCommand(tool, null)).toBe("claude");
		});

		it("returns fresh launch for copilot tool (no resume support)", () => {
			const tool = registry.resolveAgentTool("copilot");
			expect(registry.buildResumeLaunchCommand(tool)).toBe("copilot");
		});

		it("continues the latest opencode session when no sessionId is known", () => {
			const tool = registry.resolveAgentTool("opencode");
			expect(registry.buildResumeLaunchCommand(tool)).toBe(
				"opencode --continue",
			);
			expect(registry.buildResumeLaunchCommand(tool, null)).toBe(
				"opencode --continue",
			);
		});

		it("resumes the exact opencode session by id when one is known", () => {
			const tool = registry.resolveAgentTool("opencode");
			expect(registry.buildResumeLaunchCommand(tool, "sess-456")).toBe(
				"opencode --session sess-456",
			);
		});

		it("returns plain launch for custom tools", () => {
			const tool = {
				id: "aider",
				name: "Aider",
				command: "aider",
				args: ["--model", "opus"],
			};
			expect(registry.buildResumeLaunchCommand(tool)).toBe(
				"aider --model opus",
			);
		});

		it("resumes a wrapped claude-family CLI with its own executable and profile, never plain claude", () => {
			const tool = {
				id: "wrapped-claude",
				name: "Wrapped Claude",
				command: "my-claude",
				family: "claude" as const,
			};
			expect(registry.buildResumeLaunchCommand(tool, "sess-123")).toBe(
				"my-claude --resume sess-123",
			);
			expect(registry.buildResumeLaunchCommand(tool, "sess-123")).toContain(
				"my-claude --resume",
			);
		});

		it("applies env vars on resume as well", () => {
			const tool = {
				id: "wrapped-claude",
				name: "Wrapped Claude",
				command: "my-claude",
				family: "claude" as const,
				env: { CLAUDE_CONFIG_DIR: "/home/user/.config/my-claude" },
			};
			expect(registry.buildResumeLaunchCommand(tool, "sess-123")).toBe(
				"CLAUDE_CONFIG_DIR='/home/user/.config/my-claude' my-claude --resume sess-123",
			);
		});

		it("uses an explicit resumeCommand template when provided", () => {
			const tool = {
				id: "custom",
				name: "Custom",
				command: "my-tool",
				resumeCommand: "{command} continue {sessionId}",
			};
			expect(registry.buildResumeLaunchCommand(tool, "sess-1")).toBe(
				"my-tool continue sess-1",
			);
		});
	});

	describe("isClaudeFamilyTool", () => {
		it("lets the provider own initial conversation identity", () => {
			expect(registry.createInitialConversationId("claude")).toMatch(
				/^[0-9a-f-]{36}$/,
			);
			expect(registry.createInitialConversationId("codex")).toBeNull();
			expect(registry.createInitialConversationId("opencode")).toBeNull();
			expect(registry.createInitialConversationId("copilot")).toBeNull();
		});

		it("is true for the default tool", () => {
			expect(registry.isClaudeFamilyTool(undefined)).toBe(true);
		});

		it("is true for a custom tool with arbitrary id/command and family claude", () => {
			mockConfig({
				codingTools: [
					{
						id: "wrapped-claude",
						name: "Wrapped",
						command: "my-claude",
						family: "claude",
					},
				],
			});
			expect(registry.isClaudeFamilyTool("wrapped-claude")).toBe(true);
		});

		it("is false for non-claude tools", () => {
			expect(registry.isClaudeFamilyTool("codex")).toBe(false);
			expect(registry.isClaudeFamilyTool("copilot")).toBe(false);
		});

		it("custom claude-family tool gets full Claude behavior via own executable", () => {
			mockConfig({
				codingTools: [
					{
						id: "wrapped-claude",
						name: "Wrapped",
						command: "my-claude",
						family: "claude",
					},
				],
			});
			const tool = registry.resolveAgentTool("wrapped-claude");
			// The provider preassigns the id, then launch and resume go through the
			// tool's own executable, never plain claude.
			expect(registry.isClaudeFamilyTool("wrapped-claude")).toBe(true);
			expect(registry.createInitialConversationId("wrapped-claude")).toMatch(
				/^[0-9a-f-]{36}$/,
			);
			expect(registry.buildLaunchCommand(tool, "abc-123")).toBe(
				"my-claude --session-id abc-123",
			);
			expect(registry.buildResumeLaunchCommand(tool, "abc-123")).toBe(
				"my-claude --resume abc-123",
			);
		});
	});

	describe("isToolAvailable", () => {
		it("returns true when command exists", () => {
			mockCommandExists.mockReturnValue(true);
			const tool = BUILTIN_CODING_TOOLS[0];
			expect(registry.isToolAvailable(tool)).toBe(true);
			expect(mockCommandExists).toHaveBeenCalledWith("claude");
		});

		it("returns false when command not found", () => {
			mockCommandExists.mockReturnValue(false);
			const tool = BUILTIN_CODING_TOOLS[0];
			expect(registry.isToolAvailable(tool)).toBe(false);
		});
	});

	describe("getStructuredAttentionSignal caching", () => {
		function toolWithFakeProvider(
			getAttentionSignal: (
				sessionId: string,
			) => { status: "working"; evidence: string } | undefined,
		) {
			return {
				id: "fake",
				name: "Fake",
				command: "fake",
				provider: {
					id: "fake",
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
					conversationIdentity: { ownership: "provider_assigned" as const },
					getAttentionSignal,
				},
			};
		}

		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("serves repeated reads for the same session from a single provider call", () => {
			const getAttentionSignal = vi.fn().mockReturnValue({
				status: "working",
				evidence: "test.evidence",
			});
			const tool = toolWithFakeProvider(getAttentionSignal);

			// Sidebar render, reconcilePresence and sessionBinder all ask for the
			// same session within the same logical tick — this must not spawn a
			// fresh provider read (an `opencode db` subprocess in production) for
			// each caller.
			registry.getStructuredAttentionSignal(tool, "session-1");
			registry.getStructuredAttentionSignal(tool, "session-1");
			registry.getStructuredAttentionSignal(tool, "session-1");

			expect(getAttentionSignal).toHaveBeenCalledTimes(1);
		});

		it("re-reads once the cache entry expires", () => {
			const getAttentionSignal = vi.fn().mockReturnValue({
				status: "working",
				evidence: "test.evidence",
			});
			const tool = toolWithFakeProvider(getAttentionSignal);

			registry.getStructuredAttentionSignal(tool, "session-1");
			vi.advanceTimersByTime(4_001);
			registry.getStructuredAttentionSignal(tool, "session-1");

			expect(getAttentionSignal).toHaveBeenCalledTimes(2);
		});

		it("keys the cache per session, not just per provider", () => {
			const getAttentionSignal = vi.fn().mockReturnValue({
				status: "working",
				evidence: "test.evidence",
			});
			const tool = toolWithFakeProvider(getAttentionSignal);

			registry.getStructuredAttentionSignal(tool, "session-1");
			registry.getStructuredAttentionSignal(tool, "session-2");

			expect(getAttentionSignal).toHaveBeenCalledTimes(2);
		});
	});
});
