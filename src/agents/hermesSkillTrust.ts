import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileAsync } from "../utils/platform";

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

function trustArgs(
	hermesProfile: string,
	worktreePath: string,
): [string, string[]] {
	return ["hermes", ["-p", hermesProfile, "skills", "trust", worktreePath]];
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
 * **Synchronous** variant — use {@link ensureHermesProjectSkillsTrustedAsync}
 * on interactive/async code paths to keep the extension host event loop free.
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

	const [file, args] = trustArgs(hermesProfile, worktreePath);
	try {
		execFile(file, args, { cwd: worktreePath });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to trust project skills in ${worktreePath}: ` +
				`hermes skills trust exited with: ${detail}`,
		);
	}
}

/**
 * Async twin of {@link ensureHermesProjectSkillsTrusted}. Uses
 * `execFileAsync` so the extension host event loop stays free while
 * the subprocess runs — mandatory on the interactive click path
 * (see `TerminalController.createTerminalAsync`).
 *
 * @param worktreePath  Absolute path to the feature worktree.
 * @param hermesProfile Profile name frozen on the agent (e.g. "agent-space").
 * @throws When the `hermes skills trust` command exits non-zero.
 */
export async function ensureHermesProjectSkillsTrustedAsync(
	worktreePath: string,
	hermesProfile: string,
): Promise<void> {
	if (!hasProjectSkills(worktreePath)) return;

	const [file, args] = trustArgs(hermesProfile, worktreePath);
	try {
		await execFileAsync(file, args, { cwd: worktreePath });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to trust project skills in ${worktreePath}: ` +
				`hermes skills trust exited with: ${detail}`,
		);
	}
}
