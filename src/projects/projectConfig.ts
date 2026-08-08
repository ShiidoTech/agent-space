import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Per-repository Agent Space configuration, read from `<repo>/.agentspace/config.json`.
 *
 * This file holds *shareable project conventions* and may be committed to the
 * repository so the whole team branches where the project actually works:
 * - the real base branch (e.g. `v2_ia_first`), independent of whatever branch
 *   happens to be checked out in the main checkout;
 * - the branch kinds offered at feature creation (e.g. `feature`/`fix`);
 * - a dedicated worktrees directory, distinct from the main checkout.
 * - the provider IDs exposed by this project and its preferred provider.
 *
 * Coding tool commands are NOT part of this file: their identity and family are
 * resolved exclusively through `agentSpace.codingTools` (built-ins merged with
 * user/workspace settings). User-local values (a personal CLI profile, a
 * private sessions directory, machine-specific `env`) belong in that setting,
 * in user configuration or workspace settings you keep explicitly untracked.
 */
export interface ProjectConfig {
	baseBranch?: string;
	branchKinds?: string[];
	defaultBranchKind?: string;
	worktreesDir?: string;
	agents?: {
		enabled?: string[];
		default?: string;
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

let cachedConfig:
	| {
			key: string;
			mtimeMs: number;
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

/**
 * Read the project config for a repository. Falls back to an empty config
 * when the file does not exist or is unparseable (fail-open for config,
 * fail-closed for deletion).
 */
export function loadProjectConfig(repoRoot: string): ProjectConfig {
	const dir = path.join(repoRoot, CONFIG_DIR_NAME);
	const file = path.join(dir, CONFIG_FILE_NAME);

	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		cachedConfig = undefined;
		return {};
	}

	if (cachedConfig?.key === file && cachedConfig.mtimeMs === mtimeMs) {
		return cachedConfig.config;
	}

	try {
		const raw = fs.readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw) as ProjectConfig;
		cachedConfig = { key: file, mtimeMs, config: parsed };
		return parsed;
	} catch {
		return {};
	}
}

/** Persist shareable project conventions in the repository config file. */
export function saveProjectConfig(
	repoRoot: string,
	updates: Partial<ProjectConfig>,
): ProjectConfig {
	const dir = path.join(repoRoot, CONFIG_DIR_NAME);
	const file = path.join(dir, CONFIG_FILE_NAME);
	const current = loadProjectConfig(repoRoot);
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
	return config;
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
