import * as fs from "node:fs";
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
 * Resolve the profile Hermes itself considers active (its "sticky default",
 * set with `hermes profile use <name>`).
 *
 * Hermes stores the sticky default in `<hermes-root>/active_profile`: a file
 * whose trimmed contents are the active profile name. When the file is absent,
 * empty, or unreadable, Hermes behaves as if the active profile were
 * `"default"` (the base `~/.hermes` home). This mirrors `get_active_profile()`
 * in Hermes' `profiles.py` so Agent Space freezes the same runtime a bare
 * `hermes` invocation would have used.
 */
export function resolveActiveHermesProfile(): string {
	const root = resolveHermesRoot();
	const activePath = path.join(root, "active_profile");
	try {
		const name = fs.readFileSync(activePath, "utf8").trim();
		if (!name) return "default";
		return name;
	} catch {
		return "default";
	}
}

/**
 * Resolve the Hermes profile to freeze onto a newly created agent.
 *
 * Priority order:
 * 1. `projectProfile` — the project's declared `providers.hermes.profile`.
 * 2. Hermes' own active profile (`hermes profile use`), if any.
 * 3. `"default"` — the base `~/.hermes` home.
 *
 * This always returns a concrete profile (never `undefined`) so that every
 * Hermes agent is created with an explicit persisted `hermesProfile`, and
 * every subsequent launch/resume goes through `-p <profile>`. Only by
 * persisting even the implicit default can Agent Space guarantee that a later
 * `hermes profile use` (or project config edit) never silently moves an
 * existing session to a different runtime.
 */
export function resolveCreationProfile(projectProfile?: string): string {
	return projectProfile ?? resolveActiveHermesProfile();
}

/**
 * Resolve the filesystem path for a Hermes home directory given a profile.
 *
 * - Named profile `"iqv2"` → `<hermes-root>/profiles/iqv2`
 * - Default / `undefined` / `"default"` → `<hermes-root>` itself
 *
 * The root is determined by {@link resolveHermesRoot} (respects
 * `HERMES_HOME` and platform conventions). The literal name `"default"`
 * refers to Hermes' built-in base profile, which is the root directory
 * itself — never `<hermes-root>/profiles/default`.
 */
export function resolveHermesHome(profile?: string): string {
	const root = resolveHermesRoot();
	if (!profile || profile === "default") return root;
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
