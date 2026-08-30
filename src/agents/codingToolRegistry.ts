import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProjectConfig } from "../projects/projectConfig";
import { expandHome } from "../projects/projectConfig";
import type { Agent, CodingTool } from "../types";
import { commandExists } from "../utils/platform";
import { resolveHermesHome } from "./hermesProfileResolver";
import { resolveAttention } from "./providers/attentionResolver";
import type {
	CodingAgentProvider,
	ProviderAttentionSignal,
	ProviderCapabilities,
} from "./providers/types";
import { NO_ATTENTION_CAPABILITIES } from "./providers/types";
import {
	ClaudeSessionProvider,
	resolveClaudeProjectsDir,
} from "./sessionProviders/claudeSessionProvider";
import { CodexSessionProvider } from "./sessionProviders/codexSessionProvider";
import { HermesSessionProvider } from "./sessionProviders/hermesSessionProvider";
import { OpenCodeSessionProvider } from "./sessionProviders/openCodeSessionProvider";

const claudeSessionAdapter = new ClaudeSessionProvider();
const codexSessionAdapter = new CodexSessionProvider();
const openCodeSessionAdapter = new OpenCodeSessionProvider();

/**
 * Per-home cache for Hermes session adapters. Each Hermes home directory
 * (resolved from a profile) gets its own adapter instance so two agents
 * using different profiles never share a SQLite connection or breadcrumb
 * reader. The cache is never pruned — adapter count is bounded by the
 * number of distinct profiles in use.
 */
const hermesAdapterCache = new Map<string, HermesSessionProvider>();

function getHermesAdapter(
	home?: string,
	envHermesHome?: string,
): HermesSessionProvider {
	const resolvedHome = home ?? resolveHermesHome(undefined, envHermesHome);
	let adapter = hermesAdapterCache.get(resolvedHome);
	if (!adapter) {
		adapter = new HermesSessionProvider(resolvedHome);
		hermesAdapterCache.set(resolvedHome, adapter);
	}
	return adapter;
}

/** Default adapter (no profile) for the built-in provider definition. */
const hermesDefaultAdapter = getHermesAdapter(
	undefined,
	process.env.HERMES_HOME,
);

/**
 * How long a raw provider attention read is trusted before it is re-fetched.
 * Long enough to collapse the burst of redundant reads that a single logical
 * tick produces (sidebar render, presence polling, session binding and name
 * sync can all ask for the same session within the same second); short
 * enough that the UI still reflects a state change well within one presence
 * polling interval (15s).
 */
const ATTENTION_CACHE_TTL_MS = 4_000;

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

/**
 * Hermes-native attention capabilities (issue #120 PR3). Only `failed` is
 * natively and durably provable today (a session whose `end_reason` records a
 * failure). `working`, `waiting_for_user` and `idle`/`turn_completed` are
 * deliberately NOT advertised: Hermes does not persist an authoritative
 * per-turn phase for them, and Agent Space refuses to invent `turn_completed`
 * from terminal silence.
 */
const HERMES_ATTENTION_CAPABILITIES = {
	"attention.working": false,
	"attention.waitingForUser": false,
	"attention.idle": false,
	"attention.failed": true,
} as const;

export const BUILTIN_PROVIDERS: readonly CodingAgentProvider[] = [
	{
		id: "claude",
		conversationIdentity: {
			ownership: "preassigned",
			createId: () => crypto.randomUUID(),
		},
		capabilities: fullSessionCapabilities(FULL_ATTENTION_CAPABILITIES),
		getAttentionSignal: (sessionId) =>
			claudeSessionAdapter.readAttention(sessionId),
		getAttentionSignalAsync: async (sessionId) =>
			claudeSessionAdapter.readAttentionAsync(sessionId),
		sessionAdapter: claudeSessionAdapter,
	},
	{
		id: "codex",
		conversationIdentity: { ownership: "provider_assigned" },
		// Cross-process delivery from the native TUI is not proven yet.
		capabilities: fullSessionCapabilities(NO_ATTENTION_CAPABILITIES),
		getAttentionSignal: (sessionId) =>
			codexSessionAdapter.readAttention(sessionId),
		getAttentionSignalAsync: async (sessionId) =>
			codexSessionAdapter.readAttentionAsync(sessionId),
		sessionAdapter: codexSessionAdapter,
	},
	{
		id: "opencode",
		conversationIdentity: { ownership: "provider_assigned" },
		capabilities: fullSessionCapabilities(FULL_ATTENTION_CAPABILITIES),
		launchArgs: () => [],
		resumeArgs: (sessionId) =>
			sessionId ? ["--session", sessionId] : ["--continue"],
		getAttentionSignal: (sessionId) =>
			openCodeSessionAdapter.readAttention(sessionId) ?? undefined,
		getAttentionSignalAsync: async (sessionId) =>
			(await openCodeSessionAdapter.readAttentionAsync(sessionId)) ?? undefined,
		sessionAdapter: openCodeSessionAdapter,
	},
	{
		id: "copilot",
		conversationIdentity: { ownership: "unsupported" },
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
		conversationIdentity: { ownership: "provider_assigned" },
		capabilities: {
			launch: true,
			resume: true,
			sessionDiscovery: true,
			sessionNaming: true,
			attention: HERMES_ATTENTION_CAPABILITIES,
		},
		// Keep the cwd supplied by Agent Space when resuming. Hermes otherwise
		// restores the cwd recorded in the session, which may be another worktree.
		resumeArgs: (sessionId) =>
			sessionId ? ["--resume", sessionId, "--no-restore-cwd"] : [],
		sessionAdapter: hermesDefaultAdapter,
		getAttentionSignal: (sessionId) =>
			hermesDefaultAdapter.getAttentionSignal?.(sessionId),
		getAttentionSignalAsync: async (sessionId) =>
			hermesDefaultAdapter.getAttentionSignal?.(sessionId),
	},
];

const providerOverrides: Record<string, Partial<CodingAgentProvider>> = {
	claude: {
		launchArgs: (sessionId) => (sessionId ? ["--session-id", sessionId] : []),
		resumeArgs: (sessionId) => (sessionId ? ["--resume", sessionId] : []),
	},
	codex: {
		// A fresh launch never has a proven session id to resume: Codex writes
		// no rollout file until the CLI actually runs a turn, so there is
		// nothing on disk yet for `codex resume` to find. Always launch plain;
		// the file-backed discovery path in SessionBinder binds the agent once
		// its rollout appears, matching the strict `resumeArgs` path below.
		launchArgs: () => [],
		resumeArgs: (sessionId) => (sessionId ? ["resume", sessionId] : []),
	},
	opencode: {
		// OpenCode owns session creation in its native TUI. Fresh agents remain
		// unbound until the user explicitly links a SQLite session.
		launchArgs: () => [],
		resumeArgs: (sessionId) => (sessionId ? ["--session", sessionId] : []),
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
	envHermesHome?: string,
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
	if (family === "hermes") {
		return resolveHermesHome(undefined, envHermesHome);
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
	envHermesHome?: string,
): CodingAgentProvider {
	const builtin = providerById.get(id);
	if (builtin) return builtin;
	const sessionFamily =
		family === "claude" || family === "codex" || family === "opencode";
	const launchArgs =
		family === "claude"
			? (sessionId?: string | null) =>
					sessionId ? ["--session-id", sessionId] : []
			: // Codex (including wrapped/custom profiles) never has a proven
				// resumable session id on a fresh launch — see the built-in codex
				// provider override for why. Always launch plain.
				() => [];
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
	const storeDir = resolveSessionStoreDir(family, sessionsDir, envHermesHome);
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
		conversationIdentity:
			family === "claude"
				? {
						ownership: "preassigned",
						createId: () => crypto.randomUUID(),
					}
				: sessionFamily
					? { ownership: "provider_assigned" }
					: { ownership: "unsupported" },
		capabilities: {
			launch: true,
			resume: Boolean(sessionFamily),
			sessionDiscovery: sessionCapable,
			sessionNaming: sessionCapable,
			attention:
				sessionCapable && family !== "codex"
					? FULL_ATTENTION_CAPABILITIES
					: NO_ATTENTION_CAPABILITIES,
		},
		launchArgs,
		resumeArgs,
		getAttentionSignal: sessionAdapter
			? (sessionId) => sessionAdapter.readAttention(sessionId)
			: undefined,
		// Async twin of the above — mandatory whenever attention capabilities
		// are announced: the background attention monitor reads exclusively
		// through the async path, so a wrapper without it would silently stop
		// notifying waiting_for_user.
		getAttentionSignalAsync: claudeSessionProvider
			? (sessionId) => claudeSessionProvider.readAttentionAsync(sessionId)
			: codexSessionProvider
				? (sessionId) => codexSessionProvider.readAttentionAsync(sessionId)
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
		family: "hermes",
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

export function isHermesFamily(tool: CodingTool): boolean {
	return (tool.family ?? tool.command) === "hermes";
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
			over.env?.HERMES_HOME ?? base?.env?.HERMES_HOME,
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
		// stays on the same isClaudeFamily/isHermesFamily paths used
		// everywhere else.
		const inferredFamily = isClaudeFamily({ command: id })
			? "claude"
			: id === "hermes"
				? "hermes"
				: "generic";
		return {
			id,
			name: id,
			command: id,
			family: inferredFamily,
		};
	}

	getProvider(tool: CodingTool): CodingAgentProvider {
		return tool.provider ?? providerForTool(tool.id, tool.family);
	}

	/**
	 * Resolve the tool for a specific agent, using the persisted hermesProfile
	 * to build a profile-aware provider when applicable. This is the canonical
	 * entry point for any layer that needs to build commands, scan sessions, or
	 * check session existence for a particular agent — never re-resolve from
	 * project config, which may have changed since creation.
	 */
	resolveAgentToolForAgent(agent: Agent): CodingTool {
		const base = this.resolveAgentTool(agent.toolId);
		const profile = agent.hermesProfile;
		if (!isHermesFamily(base) || !profile) return base;
		const envHermesHome = base.env?.HERMES_HOME;
		const home = resolveHermesHome(profile, envHermesHome);
		const adapter = getHermesAdapter(home, envHermesHome);
		const provider = this.getProvider(base);
		return {
			...base,
			provider: {
				...provider,
				sessionAdapter: adapter,
				// The profile-aware provider must advertise the same Hermes-native
				// attention subset (failed only) and forward signals through the
				// adapter that reads THIS profile's store, not the default one.
				capabilities: {
					...provider.capabilities,
					attention: {
						...provider.capabilities.attention,
						...HERMES_ATTENTION_CAPABILITIES,
					},
				},
				getAttentionSignal: (sessionId) =>
					adapter.getAttentionSignal?.(sessionId),
				getAttentionSignalAsync: async (sessionId) =>
					adapter.getAttentionSignal?.(sessionId),
				launchArgs: () => ["-p", profile],
				resumeArgs: (sessionId) =>
					sessionId
						? ["-p", profile, "--resume", sessionId, "--no-restore-cwd"]
						: ["-p", profile],
			},
		};
	}

	/**
	 * Return the session adapter for a specific agent. For Hermes agents,
	 * this returns a profile-aware adapter that reads from the correct home
	 * directory. For all other families, delegates to the provider's default
	 * adapter.
	 *
	 * This is the single entry point for SessionBinder, SessionNameSyncer,
	 * and runtimeRestorer — never resolve the adapter by toolId alone for
	 * Hermes agents.
	 */
	getSessionAdapterForAgent(
		agent: Agent,
	): import("./providers/types").ProviderSessionAdapter | undefined {
		return this.resolveAgentToolForAgent(agent).provider?.sessionAdapter;
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
		const envHermesHome = tool.env?.HERMES_HOME;
		return {
			tool,
			declared,
			sessionStoreDir: resolveSessionStoreDir(
				tool.family,
				tool.sessionsDir,
				envHermesHome,
			),
			adapter: this.getProvider(tool).sessionAdapter,
		};
	}

	/**
	 * Profile-aware twin of {@link describeAgentTool}: explains how a persisted
	 * agent is resolved right now, using the agent's frozen `hermesProfile`
	 * instead of the default store. This is what Doctor must use for Hermes
	 * agents — otherwise it would probe `~/.hermes` while the agent actually
	 * reads `<hermes-root>/profiles/<profile>`, yielding a misleading report.
	 */
	describeAgentToolForAgent(agent: Agent): {
		tool: CodingTool;
		declared: boolean;
		sessionStoreDir?: string;
		adapter?: CodingAgentProvider["sessionAdapter"];
	} {
		const tool = this.resolveAgentToolForAgent(agent);
		const declared = this.getTool(agent.toolId ?? "claude") !== undefined;
		const envHermesHome = tool.env?.HERMES_HOME;
		const sessionStoreDir = isHermesFamily(tool)
			? resolveHermesHome(agent.hermesProfile, envHermesHome)
			: resolveSessionStoreDir(tool.family, tool.sessionsDir, envHermesHome);
		return {
			tool,
			declared,
			sessionStoreDir,
			adapter: tool.provider?.sessionAdapter,
		};
	}

	resolveAttention(tool: CodingTool, sessionId?: string | null) {
		return resolveAttention(this.getProvider(tool), sessionId);
	}

	/**
	 * Every surface that renders an agent (sidebar, Home, Feature page) as well
	 * as every background loop that reconciles state (presence polling, session
	 * binding, name sync) independently asks for this agent's attention. None of
	 * them know about each other, so without a cache each one re-triggers the
	 * provider's raw read — for OpenCode a real `opencode db` subprocess — even
	 * when they all fire within the same tick. This cache makes one provider
	 * read serve every caller that asks for the same session within the TTL,
	 * which is what actually bounds the number of provider reads/processes: not
	 * any single call site's polling interval, but how many independent call
	 * sites exist.
	 */
	private readonly attentionCache = new Map<
		string,
		{ signal: ProviderAttentionSignal | undefined; expiresAt: number }
	>();
	private readonly attentionInFlight = new Map<
		string,
		Promise<ProviderAttentionSignal | undefined>
	>();

	getStructuredAttentionSignal(
		tool: CodingTool,
		sessionId: string,
		_cwd?: string,
	) {
		const provider = this.getProvider(tool);
		const attentionProvider = provider;
		const signal = this.readAttentionSignalCached(attentionProvider, sessionId);
		if (!signal) return undefined;
		const statusCapability = {
			working: "attention.working",
			waiting_for_user: "attention.waitingForUser",
			idle: "attention.idle",
			failed: "attention.failed",
		}[signal.status] as keyof typeof attentionProvider.capabilities.attention;
		return attentionProvider.capabilities.attention[statusCapability]
			? signal
			: undefined;
	}

	async getStructuredAttentionSignalAsync(
		tool: CodingTool,
		sessionId: string,
		_cwd?: string,
	): Promise<ProviderAttentionSignal | undefined> {
		const provider = this.getProvider(tool);
		const attentionProvider = provider;
		const key = `${attentionProvider.id}:${sessionId}`;
		const cached = this.attentionCache.get(key);
		if (cached && cached.expiresAt > Date.now())
			return this.capableAttention(attentionProvider, cached.signal);
		let pending = this.attentionInFlight.get(key);
		if (!pending) {
			pending = (async () => {
				const signal = attentionProvider.getAttentionSignalAsync
					? await attentionProvider.getAttentionSignalAsync(sessionId)
					: undefined;
				this.attentionCache.set(key, {
					signal,
					expiresAt: Date.now() + ATTENTION_CACHE_TTL_MS,
				});
				return signal;
			})().finally(() => this.attentionInFlight.delete(key));
			this.attentionInFlight.set(key, pending);
		}
		return this.capableAttention(attentionProvider, await pending);
	}

	private capableAttention(
		provider: CodingAgentProvider,
		signal: ProviderAttentionSignal | undefined,
	) {
		if (!signal) return undefined;
		const capability = {
			working: "attention.working",
			waiting_for_user: "attention.waitingForUser",
			idle: "attention.idle",
			failed: "attention.failed",
		}[signal.status] as keyof typeof provider.capabilities.attention;
		return provider.capabilities.attention[capability] ? signal : undefined;
	}

	private readAttentionSignalCached(
		provider: CodingAgentProvider,
		sessionId: string,
	): ProviderAttentionSignal | undefined {
		if (!provider.getAttentionSignal) return undefined;
		const key = `${provider.id}:${sessionId}`;
		const cached = this.attentionCache.get(key);
		const now = Date.now();
		if (cached && cached.expiresAt > now) return cached.signal;
		const signal = provider.getAttentionSignal(sessionId);
		this.attentionCache.set(key, {
			signal,
			expiresAt: now + ATTENTION_CACHE_TTL_MS,
		});
		return signal;
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
	 * Ask the resolved provider for the conversation identity to persist before
	 * launch. Provider-assigned and unsupported identities deliberately stay
	 * null until the provider supplies direct ownership evidence.
	 */
	createInitialConversationId(toolId?: string): string | null {
		const tool = this.resolveAgentTool(toolId);
		const identity = this.getProvider(tool).conversationIdentity;
		return identity.ownership === "preassigned" ? identity.createId() : null;
	}

	/**
	 * Build the first-launch command for an agent.
	 *
	 * A claude-family CLI (including a wrapped/custom Claude variant) is
	 * started with the pre-assigned `--session-id` so a later resume targets
	 * the exact same session, launched through the exact same executable and
	 * profile.
	 */
	buildLaunchCommand(
		tool: CodingTool,
		sessionId?: string | null,
		cwd?: string,
	): string {
		const parts = [tool.command];
		if (tool.args && tool.args.length > 0) {
			parts.push(...tool.args);
		}
		const provider = this.getProvider(tool);
		if (provider.launchArgs) parts.push(...provider.launchArgs(sessionId, cwd));
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

	/**
	 * Build the resume command for an agent, or `undefined` when no genuine
	 * resume is possible.
	 *
	 * Unlike {@link buildResumeLaunchCommand} — whose callers may legitimately
	 * want a fresh launch as a fallback — this never falls back to a fresh
	 * launch command. A silent fallback into a brand-new conversation is
	 * exactly the behavior an automated runtime restoration must avoid. It
	 * returns `undefined` unless every condition that makes the resulting
	 * command a real provider resume is met: a sessionId exists, the tool
	 * declares a `resumeCommand` template, or the provider advertises resume
	 * support with non-empty resume args for that sessionId.
	 */
	buildStrictResumeLaunchCommand(
		tool: CodingTool,
		sessionId?: string | null,
		cwd?: string,
	): string | undefined {
		if (!sessionId) return undefined;
		if (tool.resumeCommand) {
			return `${envPrefix(tool)}${tool.resumeCommand
				.replaceAll("{sessionId}", sessionId)
				.replaceAll("{command}", tool.command)}`;
		}
		const provider = this.getProvider(tool);
		if (!provider.capabilities.resume) return undefined;
		const args = provider.resumeArgs?.(sessionId, cwd);
		if (!args || args.length === 0) return undefined;
		return `${envPrefix(tool)}${tool.command} ${args.join(" ")}`;
	}
}
