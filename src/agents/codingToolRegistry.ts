import * as vscode from "vscode";
import type { CodingTool } from "../types";
import { commandExists } from "../utils/platform";

export const BUILTIN_CODING_TOOLS: CodingTool[] = [
	{ id: "claude", name: "Claude Code", command: "claude", family: "claude" },
	{ id: "codex", name: "Codex CLI", command: "codex", family: "codex" },
	{
		id: "copilot",
		name: "GitHub Copilot",
		command: "copilot",
		family: "generic",
	},
	{ id: "opencode", name: "OpenCode", command: "opencode", family: "opencode" },
	{
		id: "claude-perso",
		name: "Claude Perso",
		command: "claude-perso",
		family: "claude",
		sessionsDir: "~/.claude-perso",
	},
	{ id: "hermes", name: "Hermes", command: "hermes", family: "generic" },
];

function isClaudeFamily(tool: CodingTool): boolean {
	const family =
		tool.family ?? (tool.command.startsWith("claude") ? "claude" : "generic");
	return family === "claude";
}

function isCodexFamily(tool: CodingTool): boolean {
	return tool.family === "codex";
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Prefix a command with `KEY='value'` env assignments, safely quoted. */
function envPrefix(tool: CodingTool): string {
	if (!tool.env || Object.keys(tool.env).length === 0) return "";
	return `${Object.entries(tool.env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ")} `;
}

export class CodingToolRegistry {
	getTools(): CodingTool[] {
		const custom = vscode.workspace
			.getConfiguration("agentSpace")
			.get<CodingTool[]>("codingTools", []);

		const merged = new Map<string, CodingTool>();
		for (const tool of BUILTIN_CODING_TOOLS) {
			merged.set(tool.id, tool);
		}
		for (const tool of custom) {
			merged.set(tool.id, tool);
		}
		return [...merged.values()];
	}

	getTool(toolId: string): CodingTool | undefined {
		return this.getTools().find((t) => t.id === toolId);
	}

	getDefaultToolId(): string | undefined {
		return vscode.workspace
			.getConfiguration("agentSpace")
			.get<string | undefined>("defaultTool");
	}

	getAvailableTools(): CodingTool[] {
		return this.getTools().filter((tool) => this.isToolAvailable(tool));
	}

	getAvailableToolsPreferredFirst(): CodingTool[] {
		const availableTools = this.getAvailableTools();
		const defaultToolId = this.getDefaultToolId();
		if (!defaultToolId) {
			return availableTools;
		}

		const preferredIndex = availableTools.findIndex(
			(tool) => tool.id === defaultToolId,
		);
		if (preferredIndex <= 0) {
			return availableTools;
		}

		const [preferredTool] = availableTools.splice(preferredIndex, 1);
		availableTools.unshift(preferredTool);
		return availableTools;
	}

	getPreferredAvailableTool(): CodingTool | undefined {
		const availableTools = this.getAvailableToolsPreferredFirst();
		if (availableTools.length === 0) {
			return undefined;
		}
		return availableTools[0];
	}

	resolveAgentTool(toolId?: string): CodingTool {
		const id = toolId ?? "claude";
		return this.getTool(id) ?? BUILTIN_CODING_TOOLS[0];
	}

	isToolAvailable(tool: CodingTool): boolean {
		return commandExists(tool.command);
	}

	/**
	 * Build the first-launch command for an agent.
	 *
	 * A claude-family CLI (including `claude-perso`) is started with the
	 * pre-assigned `--session-id` so a later resume targets the exact same
	 * session, launched through the exact same executable and profile.
	 */
	buildLaunchCommand(tool: CodingTool, sessionId?: string | null): string {
		const parts = [tool.command];
		if (tool.args && tool.args.length > 0) {
			parts.push(...tool.args);
		}
		if (isClaudeFamily(tool) && sessionId) {
			parts.push("--session-id", sessionId);
		}
		// Codex auto-generates session IDs — no flag needed on launch
		return `${envPrefix(tool)}${parts.join(" ")}`;
	}

	/**
	 * Build the resume command for an agent.
	 *
	 * `resumeCommand` (when set) is an explicit template with `{command}` and
	 * `{sessionId}` placeholders. Otherwise the CLI family drives the syntax,
	 * always through `tool.command` — a `claude-perso` agent is resumed with
	 * `claude-perso --resume <id>`, never the plain `claude` executable.
	 */
	buildResumeLaunchCommand(
		tool: CodingTool,
		sessionId?: string | null,
	): string {
		if (tool.resumeCommand) {
			if (sessionId) {
				return `${envPrefix(tool)}${tool.resumeCommand
					.replaceAll("{sessionId}", sessionId)
					.replaceAll("{command}", tool.command)}`;
			}
			return this.buildLaunchCommand(tool);
		}

		if (isClaudeFamily(tool) && sessionId) {
			return `${envPrefix(tool)}${tool.command} --resume ${sessionId}`;
		}
		if (isCodexFamily(tool) && sessionId) {
			return `${envPrefix(tool)}${tool.command} resume ${sessionId}`;
		}
		// No sessionId — launch fresh so each agent gets its own session
		return this.buildLaunchCommand(tool);
	}
}
