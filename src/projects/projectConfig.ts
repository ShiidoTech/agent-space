import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Per-repository Agent Space configuration, read from
 * `<repo>/.agentspace/config.json` with an optional untracked overlay at
 * `<repo>/.agentspace/config.local.json`.
 *
 * `config.json` holds *shareable project conventions* and may be committed to
 * the repository so the whole team branches where the project actually works:
 * - the real base branch (e.g. `v2_ia_first`), independent of whatever branch
 *   happens to be checked out in the main checkout;
 * - the branch kinds offered at feature creation (e.g. `feature`/`fix`);
 * - a dedicated worktrees directory, distinct from the main checkout.
 * - the provider IDs exposed by this project and its preferred provider.
 *
 * `config.local.json` holds the same shape but belongs to one machine and is
 * gitignored. It exists because `agents.enabled` is an allowlist: without an
 * overlay, using a personal CLI profile on a curated project would mean naming
 * that profile in the committed file, which puts a machine-local wrapper
 * (`claude-perso`, a private fork, a corporate build) into everyone's checkout
 * where it resolves to nothing. The overlay *adds* to the shared allowlist
 * rather than replacing it, so local additions never remove a team convention.
 *
 * Coding tool commands are in neither file: their identity and family are
 * resolved exclusively through `agentSpace.codingTools` (built-ins merged with
 * user/workspace settings). User-local values (a personal CLI profile, a
 * private sessions directory, machine-specific `env`) belong in that setting.
 */
export interface ProjectConfig {
	baseBranch?: string;
	branchKinds?: string[];
	defaultBranchKind?: string;
	worktreesDir?: string;
	/** Explicit shell commands offered for manual setup of new worktrees. */
	bootstrapCommands?: string[];
	agents?: {
		enabled?: string[];
		default?: string;
	};
	/**
	 * Project-level operational knowledge: canonical agent instructions and
	 * runbooks. The files themselves are the source of truth; this block makes
	 * references explicit so missing/invalid ones fail visibly instead of being
	 * silently ignored. See `projectKnowledge.ts` and
	 * `docs/project-operational-knowledge.md`.
	 */
	knowledge?: {
		/** Relative repo paths to canonical agent instructions (AGENTS.md by convention). */
		instructions?: string[];
		/** Relative paths (or an id → path map) to runbooks. */
		runbooks?: string[] | Record<string, string>;
	};
}

/**
 * Detailed settings template shown in the project Settings page so every
 * editable key is discoverable and changeable straight from JSON, even when no
 * `.agentspace/config.json` exists yet. Values are examples: nothing is written
 * unless the user edits and saves the JSON.
 */
export function projectConfigTemplate(): ProjectConfig {
	return {
		baseBranch: "main",
		branchKinds: ["feature", "fix"],
		defaultBranchKind: "feature",
		worktreesDir: "~/.worktrees",
		bootstrapCommands: ["npm install", "npm run dev"],
		agents: {
			enabled: ["claude", "codex"],
			default: "claude",
		},
		knowledge: {
			instructions: ["AGENTS.md"],
			runbooks: ["docs/runbooks.md"],
		},
	};
}

export interface ProjectAgentPolicy {
	enabledIds?: string[];
	defaultId?: string;
}

export function getProjectAgentPolicy(
	config: ProjectConfig,
): ProjectAgentPolicy | undefined {
	if (!config.agents) return undefined;
	return {
		enabledIds: config.agents.enabled,
		defaultId: config.agents.default,
	};
}

const CONFIG_DIR_NAME = ".agentspace";
const CONFIG_FILE_NAME = "config.json";
/** Untracked, machine-local overlay. Never written by Agent Space. */
export const LOCAL_CONFIG_FILE_NAME = "config.local.json";

let cachedConfig:
	| {
			key: string;
			mtimeMs: number;
			localMtimeMs: number;
			config: ProjectConfig;
	  }
	| undefined;

/** Expand a leading `~` to the current user home directory. */
export function expandHome(p: string): string {
	if (!p) return p;
	if (p === "~") return process.env.HOME || "~";
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(process.env.HOME || "~", p.slice(2));
	}
	return p;
}

function readConfigFile(file: string): ProjectConfig | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as ProjectConfig;
	} catch {
		return undefined;
	}
}

function mtimeOf(file: string): number | undefined {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Overlay a machine-local config on the shared one.
 *
 * `agents.enabled` is unioned, shared entries first: the overlay's job is to
 * add a personal profile to a curated project, not to silently drop the agents
 * the team agreed on. Everything else, including `agents.default`, is a plain
 * override — a machine that prefers its own profile says so once.
 */
export function mergeProjectConfig(
	shared: ProjectConfig,
	local: ProjectConfig,
): ProjectConfig {
	const merged: ProjectConfig = { ...shared, ...local };
	if (shared.agents || local.agents) {
		const enabled =
			shared.agents?.enabled || local.agents?.enabled
				? [
						...new Set([
							...(shared.agents?.enabled ?? []),
							...(local.agents?.enabled ?? []),
						]),
					]
				: undefined;
		merged.agents = {
			...shared.agents,
			...local.agents,
			...(enabled ? { enabled } : {}),
		};
	}
	return merged;
}

/**
 * Read the effective project config: the committed conventions with the
 * untracked machine-local overlay applied. Falls back to an empty config when
 * neither file exists or they are unparseable (fail-open for config,
 * fail-closed for deletion).
 */
export function loadProjectConfig(repoRoot: string): ProjectConfig {
	const dir = path.join(repoRoot, CONFIG_DIR_NAME);
	const file = path.join(dir, CONFIG_FILE_NAME);
	const localFile = path.join(dir, LOCAL_CONFIG_FILE_NAME);

	const mtimeMs = mtimeOf(file);
	const localMtimeMs = mtimeOf(localFile);
	if (mtimeMs === undefined && localMtimeMs === undefined) {
		cachedConfig = undefined;
		return {};
	}

	if (
		cachedConfig?.key === file &&
		cachedConfig.mtimeMs === (mtimeMs ?? 0) &&
		cachedConfig.localMtimeMs === (localMtimeMs ?? 0)
	) {
		return cachedConfig.config;
	}

	const shared = mtimeMs === undefined ? {} : (readConfigFile(file) ?? {});
	const local =
		localMtimeMs === undefined ? {} : (readConfigFile(localFile) ?? {});
	const config = mergeProjectConfig(shared, local);
	cachedConfig = {
		key: file,
		mtimeMs: mtimeMs ?? 0,
		localMtimeMs: localMtimeMs ?? 0,
		config,
	};
	return config;
}

/** Read only the committed conventions, without the machine-local overlay. */
export function loadSharedProjectConfig(repoRoot: string): ProjectConfig {
	return (
		readConfigFile(path.join(repoRoot, CONFIG_DIR_NAME, CONFIG_FILE_NAME)) ?? {}
	);
}

/** True when this repository carries an untracked machine-local overlay. */
export function hasLocalProjectConfig(repoRoot: string): boolean {
	return (
		mtimeOf(path.join(repoRoot, CONFIG_DIR_NAME, LOCAL_CONFIG_FILE_NAME)) !==
		undefined
	);
}

/**
 * Persist shareable project conventions in the committed config file.
 *
 * Deliberately reads the shared file rather than the effective config: writing
 * a base branch must never bake the machine-local overlay — a personal CLI
 * profile, a private worktrees path — into the file everyone else checks out.
 */
export function saveProjectConfig(
	repoRoot: string,
	updates: Partial<ProjectConfig>,
): ProjectConfig {
	const dir = path.join(repoRoot, CONFIG_DIR_NAME);
	const file = path.join(dir, CONFIG_FILE_NAME);
	const current = loadSharedProjectConfig(repoRoot);
	const config = { ...current, ...updates } as ProjectConfig;

	for (const key of Object.keys(config) as Array<keyof ProjectConfig>) {
		const value = config[key];
		if (value === undefined || (typeof value === "string" && !value.trim())) {
			delete config[key];
		}
	}

	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	cachedConfig = undefined;
	// Callers install the result as the running project config, so hand back the
	// effective view: only the shared half was written, but the overlay is still
	// in force.
	return loadProjectConfig(repoRoot);
}

/** Replace the shareable project config after an explicit JSON edit. */
export function replaceProjectConfig(
	repoRoot: string,
	config: ProjectConfig,
): ProjectConfig {
	const dir = path.join(repoRoot, CONFIG_DIR_NAME);
	const file = path.join(dir, CONFIG_FILE_NAME);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	cachedConfig = undefined;
	return loadProjectConfig(repoRoot);
}

/** Resolve the effective worktree base for a project. */
export function resolveWorktreeBaseDir(
	repoRoot: string,
	config: ProjectConfig,
	worktreeRelativePath: string,
): string {
	if (config.worktreesDir) {
		return path.resolve(expandHome(config.worktreesDir));
	}
	return path.resolve(repoRoot, worktreeRelativePath);
}

/** True when the project config declares at least one base branch. */
export function hasConfiguredBaseBranch(config: ProjectConfig): boolean {
	return Boolean(config.baseBranch?.trim());
}
