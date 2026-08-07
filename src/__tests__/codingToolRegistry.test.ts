import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/platform", () => ({
	commandExists: vi.fn(),
}));

import { commandExists } from "../utils/platform";

const mockCommandExists = vi.mocked(commandExists);

import {
	BUILTIN_CODING_TOOLS,
	CodingToolRegistry,
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

		it("falls back to the first available tool when the default is missing", () => {
			mockConfig({ defaultTool: "claude" });
			mockCommandExists.mockImplementation((command) => command === "codex");
			expect(registry.getPreferredAvailableTool()?.id).toBe("codex");
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

		it("falls back to claude for unknown toolId", () => {
			const tool = registry.resolveAgentTool("nonexistent");
			expect(tool.id).toBe("claude");
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
});
