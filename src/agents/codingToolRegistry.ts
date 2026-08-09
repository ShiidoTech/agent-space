import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProjectConfig } from "../projects/projectConfig";
import { expandHome } from "../projects/projectConfig";
import type { CodingTool } from "../types";
import { commandExists } from "../utils/platform";
import { resolveAttention } from "./providers/attentionResolver";
import type {
	CodingAgentProvider,
	ProviderCapabilities,
} from "./providers/types";
import { NO_ATTENTION_CAPABILITIES } from "./providers/types";
import {
	ClaudeSessionProvider,
	resolveClaudeProjectsDir,
} from "./sessionProviders/claudeSessionProvider";
import { CodexSessionProvider } from "./sessionProviders/codexSessionProvider";
import { OpenCodeSessionProvider } from "./sessionProviders/openCodeSessionProvider";

const claudeSessionAdapter = new ClaudeSessionProvider();
const codexSessionAdapter = new CodexSessionProvider();
const openCodeSessionAdapter = new OpenCodeSessionProvider();

const fullSessionCapabilities = (
	attention = NO_ATTENTION_CAPABILITIES,
): ProviderCapabilities => ({
	launch: true,
	resume: true,
	sessionDiscovery: true,
	sessionNaming: true,
	attention,
});

const FULL_ATTENTION_CAPABILITIES = {
	"attention.working": true,
	"attention.waitingForUser": true,
	"attention.idle": true,
	"attention.failed": true,
} as const;

export const BUILTIN_PROVIDERS: readonly CodingAgentProvider[] = [
	{
		id: "claude",
		capabilities: fullSessionCapabilities(FULL_ATTENTION_CAPABILITIES),
		getAttentionSignal: (sessionId) =>
			claudeSessionAdapter.readAttention(sessionId),
		sessionAdapter: claudeSessionAdapter,
	},
	{
		id: "codex",
		capabilities: fullSessionCapabilities(FULL_ATTENTION_CAPABILITIES),
		getAttentionSignal: (sessionId) =>
			codexSessionAdapter.readAttention(sessionId),
		sessionAdapter: codexSessionAdapter,
	},
	{
		id: "opencode",
		capabilities: fullSessionCapabilities(FULL_ATTENTION_CAPABILITIES),
		launchArgs: () => [],
		resumeArgs: (sessionId) =>
			sessionId ? ["--session", sessionId] : ["--continue"],
		getAttentionSignal: (sessionId) =>
			openCodeSessionAdapter.readAttention(sessionId) ?? undefined,
		sessionAdapter: openCodeSessionAdapter,
	},
	{
		id: "copilot",
		capabilities: {
			launch: true,
			resume: false,
			sessionDiscovery: false,
			sessionNaming: false,
			attention: NO_ATTENTION_CAPABILITIES,
		},
	},
	{
		id: "hermes",
		capabilities: {
			launch: true,
			resume: false,
			sessionDiscovery: false,
			sessionNaming: false,
			attention: NO_ATTENTION_CAPABILITIES,
		},
	},
];

const providerOverrides: Record<string, Partial<CodingAgentProvider>> = {
	claude: {
		launchArgs: (sessionId) => (sessionId ? ["--session-id", sessionId] : []),
		resumeArgs: (sessionId) => (sessionId ? ["--resume", sessionId] : []),
	},
	codex: {
		launchArgs: () => [],
		resumeArgs: (sessionId) => (sessionId ? ["resume", sessionId] : []),
	},
};

for (const provider of BUILTIN_PROVIDERS) {
	Object.assign(provider, providerOverrides[provider.id]);
}

const providerById = new Map(BUILTIN_PROVIDERS.map((p) => [p.id, p]));

/**
 * The directory a file-backed provider will read for `family`/`sessionsDir`.
 *
 * Mirrors what `providerForTool` hands to the adapter, including the defaults
 * used when a tool declares no `sessionsDir`. Those defaults are exactly where
 * an undeclared wrapped profile silently ends up looking.
 */
export function resolveSessionStoreDir(
	family: CodingTool["family"],
	sessionsDir?: string,
): string | undefined {
	if (family === "claude") {
		return resolveClaudeProjectsDir(
			sessionsDir ? expandHome(sessionsDir) : undefined,
		);
	}
	if (family === "codex") {
		return sessionsDir
			? expandHome(sessionsDir)
			: path.join(process.env.HOME || "~", ".codex", "sessions");
	}
	return undefined;
}

function directoryExists(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function providerForTool(
	id: string,
	family?: CodingTool["family"],
	sessionsDir?: string,
): CodingAgentProvider {
	const builtin = providerById.get(id);
	if (builtin) return builtin;
	const sessionFamily =
		family === "claude" || family === "codex" || family === "opencode";
	const launchArgs =
		family === "claude"
			? (sessionId?: string | null) =>
					sessionId ? ["--session-id", sessionId] : []
			: () => [];
	const resumeArgs =
		family === "claude"
			? (sessionId?: string | null) =>
					sessionId ? ["--resume", sessionId] : []
			: family === "codex"
				? (sessionId?: string | null) =>
						sessionId ? ["resume", sessionId] : []
				: family === "opencode"
					? (sessionId?: string | null) =>
							sessionId ? ["--session", sessionId] : ["--continue"]
					: undefined;
	// One canonical store path per family, shared with `resolveSessionStoreDir`
	// and Doctor, so the directory the adapter reads is exactly the directory
	// whose reachability decides the capabilities and the one Doctor reports.
	const storeDir = resolveSessionStoreDir(family, sessionsDir);
	const claudeSessionProvider =
		family === "claude" ? new ClaudeSessionProvider(storeDir, id) : undefined;
	const codexSessionProvider =
		family === "codex" ? new CodexSessionProvider(storeDir) : undefined;
	const sessionAdapter = claudeSessionProvider ?? codexSessionProvider;
	// A file-backed adapter is only worth anything if its store is actually
	// reachable. Declaring sessionNaming/attention from the mere existence of an
	// adapter let a tool point at the wrong home directory — the default
	// `~/.claude` for a `claude-perso` profile whose sessions live elsewhere —
	// while still advertising full capabilities. The result looked like a silent
	// agent instead of a misconfiguration.
	const storeReachable =
		!sessionAdapter || !storeDir
			? Boolean(sessionAdapter)
			: directoryExists(storeDir);
	const sessionCapable = Boolean(sessionAdapter) && storeReachable;
	return {
		id,
		capabilities: {
			launch: true,
			resume: Boolean(sessionFamily),
			sessionDiscovery: sessionCapable,
			sessionNaming: sessionCapable,
			attention: sessionCapable
				? FULL_ATTENTION_CAPABILITIES
				: NO_ATTENTION_CAPABILITIES,
		},
		launchArgs,
		resumeArgs,
		getAttentionSignal: sessionAdapter
			? (sessionId) => sessionAdapter.readAttention(sessionId)
			: undefined,
		sessionAdapter,
	};
}

export const BUILTIN_CODING_TOOLS: CodingTool[] = [
	{
		id: "claude",
		name: "Claude Code",
		command: "claude",
		family: "claude",
		provider: providerById.get("claude"),
	},
	{
		id: "codex",
		name: "Codex CLI",
		command: "codex",
		family: "codex",
		provider: providerById.get("codex"),
	},
	{
		id: "copilot",
		name: "GitHub Copilot",
		command: "copilot",
		family: "generic",
		provider: providerById.get("copilot"),
	},
	{
		id: "opencode",
		name: "OpenCode",
		command: "opencode",
		family: "opencode",
		provider: providerById.get("opencode"),
	},
	{
		id: "hermes",
		name: "Hermes",
		command: "hermes",
		family: "generic",
		provider: providerById.get("hermes"),
	},
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
		provider: providerForTool(
			over.id,
			over.family ?? base?.family,
			over.sessionsDir ?? base?.sessionsDir,
		),
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
	getTools(config?: ProjectConfig): CodingTool[] {
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
		const tools = [...merged.values()];
		const enabled = config?.agents?.enabled;
		return enabled
			? enabled.flatMap((id) => {
					const tool = tools.find((candidate) => candidate.id === id);
					return tool ? [tool] : [];
				})
			: tools;
	}

	getTool(toolId: string, config?: ProjectConfig): CodingTool | undefined {
		return this.getTools(config).find((t) => t.id === toolId);
	}

	getDefaultToolId(): string | undefined {
		return vscode.workspace
			.getConfiguration("agentSpace")
			.get<string | undefined>("defaultTool");
	}

	getAvailableTools(config?: ProjectConfig): CodingTool[] {
		return this.getTools(config).filter((tool) => this.isToolAvailable(tool));
	}

	getUnavailableTools(config?: ProjectConfig): CodingTool[] {
		return this.getTools(config).filter((tool) => !this.isToolAvailable(tool));
	}

	getUnknownProjectAgentIds(config?: ProjectConfig): string[] {
		const enabled = config?.agents?.enabled ?? [];
		const known = new Set(this.getTools().map((tool) => tool.id));
		return enabled.filter((id) => !known.has(id));
	}

	getAvailableToolsPreferredFirst(config?: ProjectConfig): CodingTool[] {
		const availableTools = this.getAvailableTools(config);
		const defaultToolId = config?.agents?.default ?? this.getDefaultToolId();
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

	getPreferredAvailableTool(config?: ProjectConfig): CodingTool | undefined {
		const configuredDefault =
			config?.agents?.default ?? this.getDefaultToolId();
		const configuredTool = configuredDefault
			? this.getTool(configuredDefault, config)
			: undefined;
		if (
			configuredDefault &&
			(!configuredTool || !this.isToolAvailable(configuredTool))
		) {
			return undefined;
		}
		const availableTools = this.getAvailableToolsPreferredFirst(config);
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

	getProvider(tool: CodingTool): CodingAgentProvider {
		return tool.provider ?? providerForTool(tool.id, tool.family);
	}

	/**
	 * Everything a diagnostic needs to explain how a persisted `toolId` is being
	 * resolved right now: whether it is actually declared, which executable it
	 * maps to, and which session store its provider will read. Resolved through
	 * the same paths the runtime uses, so the report cannot disagree with the
	 * running extension.
	 */
	describeAgentTool(toolId?: string): {
		tool: CodingTool;
		declared: boolean;
		sessionStoreDir?: string;
		adapter?: CodingAgentProvider["sessionAdapter"];
	} {
		const declared = this.getTool(toolId ?? "claude") !== undefined;
		const tool = this.resolveAgentTool(toolId);
		return {
			tool,
			declared,
			sessionStoreDir: resolveSessionStoreDir(tool.family, tool.sessionsDir),
			adapter: this.getProvider(tool).sessionAdapter,
		};
	}

	resolveAttention(tool: CodingTool, sessionId?: string | null) {
		return resolveAttention(this.getProvider(tool), sessionId);
	}

	getStructuredAttentionSignal(tool: CodingTool, sessionId: string) {
		const provider = this.getProvider(tool);
		const signal = provider.getAttentionSignal?.(sessionId);
		if (!signal) return undefined;
		const statusCapability = {
			working: "attention.working",
			waiting_for_user: "attention.waitingForUser",
			idle: "attention.idle",
			failed: "attention.failed",
		}[signal.status] as keyof typeof provider.capabilities.attention;
		return provider.capabilities.attention[statusCapability]
			? signal
			: undefined;
	}

	getSessionRenameAdapters(config?: ProjectConfig) {
		const adapters = new Map<
			string,
			NonNullable<CodingAgentProvider["sessionAdapter"]>
		>();
		for (const tool of this.getTools(config)) {
			const adapter = this.getProvider(tool).sessionAdapter;
			if (adapter) adapters.set(adapter.toolId, adapter);
		}
		return [...adapters.values()];
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
		const provider = this.getProvider(tool);
		if (provider.launchArgs) parts.push(...provider.launchArgs(sessionId));
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

		const provider = this.getProvider(tool);
		if (provider.resumeArgs && provider.capabilities.resume) {
			const args = provider.resumeArgs(sessionId);
			if (args.length > 0) {
				return `${envPrefix(tool)}${tool.command} ${args.join(" ")}`;
			}
		}
		// No sessionId — launch fresh so each agent gets its own session
		return this.buildLaunchCommand(tool);
	}
}
