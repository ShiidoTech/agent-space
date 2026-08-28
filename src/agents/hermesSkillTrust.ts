import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Hermes project-skill trust locations, matching Hermes' own discovery order.
 * Both directories are checked; if either exists, the worktree needs trust.
 */
const PROJECT_SKILL_DIRS = [".agents/skills", ".hermes/skills"] as const;

/**
 * Detect whether a worktree contains Hermes project skills.
 *
 * Checks the two directories Hermes actually scans:
 * - `.agents/skills/` (cross-tool convention)
 * - `.hermes/skills/` (Hermes-native)
 */
export function hasProjectSkills(worktreePath: string): boolean {
	return PROJECT_SKILL_DIRS.some((dir) => {
		try {
			return fs.statSync(path.join(worktreePath, dir)).isDirectory();
		} catch {
			return false;
		}
	});
}

/**
 * Ensure a worktree is trusted by Hermes so its project skills load
 * automatically on session start.
 *
 * - **Idempotent**: the `hermes skills trust` CLI is itself idempotent;
 *   already-trusted paths are a no-op.
 * - **Fail-closed**: if skills are present but the trust command fails,
 *   an explicit error is thrown — the caller must not start Hermes in a
 *   degraded state.
 * - **No-op when absent**: worktrees without project skills are left untouched.
 *
 * Trust is established through the official `hermes skills trust` primitive,
 * scoped to the resolved profile via `-p <profile>`. Agent Space never
 * manipulates Hermes config files directly.
 *
 * @param worktreePath  Absolute path to the feature worktree.
 * @param hermesProfile Profile name frozen on the agent (e.g. "agent-space").
 * @throws When the `hermes skills trust` command exits non-zero.
 */
export function ensureHermesProjectSkillsTrusted(
	worktreePath: string,
	hermesProfile: string,
): void {
	if (!hasProjectSkills(worktreePath)) return;

	try {
		execFileSync(
			"hermes",
			["-p", hermesProfile, "skills", "trust", worktreePath],
			{
				encoding: "utf8",
				timeout: 10_000,
				cwd: worktreePath,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to trust project skills in ${worktreePath}: ` +
				`hermes skills trust exited with: ${detail}`,
		);
	}
}
