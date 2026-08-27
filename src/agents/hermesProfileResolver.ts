import * as os from "node:os";
import * as path from "node:path";
import type { ProjectConfig } from "../projects/projectConfig";
import type { Agent } from "../types";

/**
 * Resolve the Hermes root directory.
 *
 * Respects the `HERMES_HOME` environment variable when set; falls back to
 * the platform home directory (`os.homedir()`) with the conventional
 * `.hermes` suffix. Never hardcodes `~` — always resolves through the
 * runtime environment so containerised or cross-platform setups are honoured.
 */
export function resolveHermesRoot(): string {
	return process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
}

/**
 * Resolve the filesystem path for a Hermes home directory given a profile.
 *
 * - Named profile `"iqv2"` → `<hermes-root>/profiles/iqv2`
 * - Default / `undefined`  → `<hermes-root>` itself
 *
 * The root is determined by {@link resolveHermesRoot} (respects
 * `HERMES_HOME` and platform conventions).
 */
export function resolveHermesHome(profile?: string): string {
	const root = resolveHermesRoot();
	if (!profile) return root;
	return path.join(root, "profiles", profile);
}

/**
 * Resolve the effective Hermes profile for an agent.
 *
 * Priority order (highest wins):
 * 1. `agent.hermesProfile` — persisted at creation, never re-resolved.
 * 2. `projectConfig.providers.hermes.profile` — project-level declaration.
 * 3. `undefined` — default Hermes home.
 *
 * The persisted agent profile always wins so that a config change after
 * creation never silently redirects an existing session to a different
 * runtime.
 */
export function resolveHermesProfile(
	agent: Agent,
	projectConfig?: ProjectConfig,
): string | undefined {
	return (
		agent.hermesProfile ??
		projectConfig?.providers?.hermes?.profile ??
		undefined
	);
}

/**
 * Resolve the Hermes home directory for a specific agent, using the
 * persisted profile (or falling back to project config).
 *
 * This is the primary entry point for any layer that needs to know
 * *where* a given Hermes agent's sessions live.
 */
export function resolveAgentHermesHome(
	agent: Agent,
	projectConfig?: ProjectConfig,
): string {
	const profile = resolveHermesProfile(agent, projectConfig);
	return resolveHermesHome(profile);
}
