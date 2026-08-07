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
	{ id: "hermes", name: "Hermes", command: "hermes", family: "generic" },
];

export function isClaudeFamily(tool: {
	command: string;
	family?: CodingTool["family"];
}): boolean {
	const family =
		tool.family ?? (tool.command.startsWith("claude") ? "claude" : "generic");
	return family === "claude";
}

export function isOpenCodeFamily(tool: CodingTool): boolean {
	return (tool.family ?? tool.command) === "opencode";
}

function isCodexFamily(tool: CodingTool): boolean {
	return tool.family === "codex";
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shallow-merge a custom tool entry over a built-in tool (or nothing).
 * Fields provided by the custom entry win; anything else keeps the built-in
 * default, so personal/`args` overrides don't need to restate the tool.
 */
function mergeTool(base: CodingTool | undefined, over: CodingTool): CodingTool {
	return {
		id: over.id,
		name: over.name ?? base?.name ?? over.id,
		command: over.command ?? base?.command ?? over.id,
		family: over.family ?? base?.family,
		sessionsDir: over.sessionsDir ?? base?.sessionsDir,
		args: over.args ?? base?.args,
		env: base?.env ? { ...base.env, ...over.env } : over.env,
		resumeCommand: over.resumeCommand ?? base?.resumeCommand,
	};
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
			if (tool.enabled === false) {
				// Allow removing a built-in entirely.
				merged.delete(tool.id);
				continue;
			}
			// Deep-merge over the built-in: a config only needs the deltas it
			// changes (e.g. just `args`), keeping the built-in's other fields.
			const base = merged.get(tool.id);
			merged.set(tool.id, mergeTool(base, tool));
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
		const resolved = this.getTool(id);
		if (resolved) return resolved;
		// Never silently substitute a different tool (e.g. the built-in
		// claude) for one that cannot be resolved: preserve the requested
		// identity so the wrong executable is never launched. Family inference
		// stays on the same isClaudeFamily path used everywhere else.
		return {
			id,
			name: id,
			command: id,
			family: isClaudeFamily({ command: id }) ? "claude" : "generic",
		};
	}

	isToolAvailable(tool: CodingTool): boolean {
		return commandExists(tool.command);
	}

	/**
	 * Canonical claude-family check for a tool id: resolve the tool through
	 * the same merge (built-ins + `agentSpace.codingTools`) used everywhere
	 * else, then apply `isClaudeFamily`. Single source of truth so no caller
	 * re-derives family with its own heuristic.
	 */
	isClaudeFamilyTool(toolId?: string): boolean {
		return isClaudeFamily(this.resolveAgentTool(toolId));
	}

	/**
	 * Build the first-launch command for an agent.
	 *
	 * A claude-family CLI (including a wrapped/custom Claude variant) is
	 * started with the pre-assigned `--session-id` so a later resume targets
	 * the exact same session, launched through the exact same executable and
	 * profile.
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
	 * always through `tool.command` — a wrapped Claude variant is resumed with
	 * its own executable, never the plain `claude` binary.
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
		if (isOpenCodeFamily(tool)) {
			// opencode generates its own session ids. Resume the exact session
			// when one is known; otherwise continue the latest one for the
			// current directory (which is the right session in a per-worktree
			// setup). Never fall back to a fresh launch.
			if (sessionId) {
				return `${envPrefix(tool)}${tool.command} --session ${sessionId}`;
			}
			return `${envPrefix(tool)}${tool.command} --continue`;
		}
		// No sessionId — launch fresh so each agent gets its own session
		return this.buildLaunchCommand(tool);
	}
}
