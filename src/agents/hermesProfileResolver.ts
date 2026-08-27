import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectConfig } from "../projects/projectConfig";
import type { Agent } from "../types";

const PROFILES_DIR = "profiles";

/**
 * Split a Hermes home path into (root, profile) if it points inside a
 * `profiles/<name>` subdirectory. Hermes treats `HERMES_HOME` as the
 * *effective* home (which may be a profile directory). The root is the
 * parent of `profiles/`, and the profile is the last segment.
 *
 * Examples:
 * - `/home/user/.hermes` → `{ root: "/home/user/.hermes", profile: undefined }`
 * - `/home/user/.hermes/profiles/coder` → `{ root: "/home/user/.hermes", profile: "coder" }`
 * - `/custom/hermes/profiles/iqv2` → `{ root: "/custom/hermes", profile: "iqv2" }`
 *
 * Validates the raw profile segment before normalizing, to reject path
 * traversal and shell metacharacters that `path.normalize` would silently
 * resolve away.
 */
function splitHermesHome(hermesHome: string): {
	root: string;
	profile?: string;
} {
	// First, check if the raw input contains a profiles/ segment with a
	// potentially invalid profile name, before normalization resolves it away.
	const rawProfilesSeg = `${path.sep}${PROFILES_DIR}${path.sep}`;
	const rawIdx = hermesHome.lastIndexOf(rawProfilesSeg);
	if (rawIdx !== -1) {
		const rawProfile = hermesHome.slice(rawIdx + rawProfilesSeg.length);
		// If there's a non-empty profile segment, validate it for traversal
		// and shell metacharacters before normalization resolves them away.
		// We validate regardless of whether it contains separators, because
		// a segment like "../evil" contains "/" but is a traversal attempt.
		if (rawProfile) {
			if (rawProfile.includes("..") || /[;&|`$\\/]/.test(rawProfile)) {
				throw new Error(
					`Invalid Hermes profile in HERMES_HOME: "${rawProfile}" (path traversal or shell metacharacter not allowed)`,
				);
			}
		}
	}

	const normalized = path.normalize(hermesHome);
	const profilesSeg = `${path.sep}${PROFILES_DIR}${path.sep}`;
	const idx = normalized.lastIndexOf(profilesSeg);
	if (idx === -1) {
		return { root: normalized, profile: undefined };
	}
	const root = normalized.slice(0, idx);
	const profile = normalized.slice(idx + profilesSeg.length);
	if (!profile || profile.includes(path.sep)) {
		return { root: normalized, profile: undefined };
	}
	return { root, profile };
}

/**
 * Resolve the Hermes root directory and the profile implicitly carried by
 * `HERMES_HOME` (if any).
 *
 * If `envHermesHome` is provided (e.g. from a custom tool's `env.HERMES_HOME`),
 * it is used instead of `process.env.HERMES_HOME`. This ensures the launched
 * process and the session adapter share the same source of truth.
 */
export function resolveHermesRootAndProfile(envHermesHome?: string): {
	root: string;
	hermesHomeProfile?: string;
} {
	const hermesHome = envHermesHome ?? process.env.HERMES_HOME;
	if (!hermesHome) {
		return {
			root: path.join(os.homedir(), ".hermes"),
			hermesHomeProfile: undefined,
		};
	}
	const { root, profile } = splitHermesHome(hermesHome);
	return { root, hermesHomeProfile: profile };
}

/**
 * Canonicalise a Hermes profile name to the form Hermes itself uses:
 * - trim whitespace
 * - lowercase
 * - "default" (any case) → "default"
 *
 * Then validate: reject empty, path traversal (`..`, `/`, `\`), and shell
 * metacharacters that could break command construction.
 *
 * Throws on invalid input — callers must catch and surface a clear error.
 */
export function canonicalizeHermesProfile(profile: string): string {
	const trimmed = profile.trim();
	if (!trimmed) {
		throw new Error("Hermes profile name cannot be empty");
	}
	const lower = trimmed.toLowerCase();
	if (lower === "default") return "default";

	// Path traversal / directory separators
	if (lower.includes("..") || lower.includes("/") || lower.includes("\\")) {
		throw new Error(
			`Invalid Hermes profile name: "${profile}" (path traversal or separator not allowed)`,
		);
	}
	// Shell metacharacters that would break `hermes -p <profile>` when concatenated
	// into a shell command string. We keep the allowed set restrictive: alphanum,
	// dash, underscore, dot.
	if (!/^[a-z0-9._-]+$/.test(lower)) {
		throw new Error(
			`Invalid Hermes profile name: "${profile}" (shell metacharacter not allowed; only alphanumeric, dash, underscore, dot allowed)`,
		);
	}
	return lower;
}

/**
 * Resolve the profile Hermes itself considers active (its "sticky default",
 * set with `hermes profile use <name>`).
 *
 * Reads `<hermes-root>/active_profile` from the root derived from `envHermesHome`
 * (or `process.env.HERMES_HOME`). Missing/empty/unreadable → `"default"`.
 */
export function resolveActiveHermesProfile(envHermesHome?: string): string {
	const { root } = resolveHermesRootAndProfile(envHermesHome);
	const activePath = path.join(root, "active_profile");
	try {
		const name = fs.readFileSync(activePath, "utf8").trim();
		if (!name) return "default";
		// The file may contain a non-canonical name; canonicalise for consistency.
		return canonicalizeHermesProfile(name);
	} catch {
		return "default";
	}
}

/**
 * Resolve the Hermes profile to freeze onto a newly created agent.
 *
 * Priority order:
 * 1. `projectProfile` — the project's declared `providers.hermes.profile` (canonicalised).
 * 2. Profile implicitly carried by `HERMES_HOME` (e.g. `HERMES_HOME=/root/profiles/coder` → "coder").
 * 3. Hermes' own active profile (`hermes profile use`), if any.
 * 4. `"default"` — the base `~/.hermes` home.
 *
 * Always returns a concrete, canonicalised profile so that every Hermes agent
 * is created with an explicit persisted `hermesProfile`, and every subsequent
 * launch/resume goes through `-p <profile>`.
 */
export function resolveCreationProfile(
	projectProfile?: string,
	envHermesHome?: string,
): string {
	if (projectProfile) {
		return canonicalizeHermesProfile(projectProfile);
	}
	const { hermesHomeProfile } = resolveHermesRootAndProfile(envHermesHome);
	if (hermesHomeProfile) {
		return canonicalizeHermesProfile(hermesHomeProfile);
	}
	return resolveActiveHermesProfile(envHermesHome);
}

/**
 * Resolve the filesystem path for a Hermes home directory given a profile.
 *
 * - Named profile `"iqv2"` → `<hermes-root>/profiles/iqv2`
 * - Default / `undefined` / `"default"` → `<hermes-root>` itself
 *
 * The root is determined by {@link resolveHermesRootAndProfile} (respects
 * `envHermesHome` / `HERMES_HOME` and platform conventions). The literal name
 * `"default"` refers to Hermes' built-in base profile, which is the root
 * directory itself — never `<hermes-root>/profiles/default`.
 */
export function resolveHermesHome(
	profile?: string,
	envHermesHome?: string,
): string {
	const { root, hermesHomeProfile } =
		resolveHermesRootAndProfile(envHermesHome);
	// If no explicit profile is given, but HERMES_HOME points to a profile
	// directory, use that profile's directory as the effective home.
	if (!profile || profile === "default") {
		if (hermesHomeProfile) {
			return path.join(root, PROFILES_DIR, hermesHomeProfile);
		}
		return root;
	}
	return path.join(root, PROFILES_DIR, profile);
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
