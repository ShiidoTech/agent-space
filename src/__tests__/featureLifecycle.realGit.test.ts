import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function repository(): { repo: string; worktrees: string } {
	const base = mkdtempSync(path.join(tmpdir(), "agent-space-lifecycle-"));
	temporaryDirectories.push(base);
	const repo = path.join(base, "repo");
	const worktrees = path.join(base, "worktrees");
	mkdirSync(repo);
	mkdirSync(worktrees);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	require("node:fs").writeFileSync(path.join(repo, "README.md"), "seed\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "seed");
	return { repo, worktrees };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("Feature lifecycle: create renders locally, finish reassesses with cached evidence", () => {
	it("creates a worktree-backed Feature and a sync re-assessment stays safe without a reconcile", async () => {
		const { repo, worktrees } = repository();
		const { FeatureManager } = await import("../features/featureManager");
		const { Store } = await import("../storage/store");
		const store = new Store(path.join(path.dirname(repo), "store"));
		const manager = new FeatureManager(store, repo, worktrees, {});

		const feature = manager.createFeatureRecord("lifecycle", "shared");
		expect(feature.provisioning?.state).toBe("provisioning");

		const provisioning = manager.provisionFeature(feature.id);
		const ready = await provisioning;
		expect(ready?.provisioning?.state).toBe("ready");
		expect(require("node:fs").existsSync(feature.worktreePath)).toBe(true);

		// The re-assessment used by Finish after my change is local-only: it
		// re-reads worktree safety synchronously and never requires a network
		// reconcile. A clean just-created worktree must be `safe`.
		const { assessFeatureFinish } = await import("../features/featureFinish");
		const { GitClient } = await import("../git/gitClient");
		const ctx = {
			project: { repoPath: repo },
			gitClient: new GitClient(),
			featureManager: manager,
			agentManager: { getAgents: () => [] as never[] },
		} as never;
		const assessment = assessFeatureFinish(ctx as never, feature, {
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		} as never);
		expect(assessment.checks.length).toBeGreaterThan(0);
		expect(assessment.fingerprint.length).toBeGreaterThan(0);
		// A clean worktree with no local commits and no dirty state is safe to
		// remove; the Finish confirmation can proceed without a fresh GitHub
		// round-trip.
		expect(assessment.safe).toBe(true);
	});

	it("keeps Finish fail-closed when the worktree becomes dirty after the snapshot", async () => {
		const { repo, worktrees } = repository();
		const { FeatureManager } = await import("../features/featureManager");
		const { Store } = await import("../storage/store");
		const store = new Store(path.join(path.dirname(repo), "store"));
		const manager = new FeatureManager(store, repo, worktrees, {});
		const feature = manager.createFeatureRecord("dirty-finish", "shared");
		await manager.provisionFeature(feature.id);

		const { assessFeatureFinish } = await import("../features/featureFinish");
		const { GitClient } = await import("../git/gitClient");
		const ctx = {
			project: { repoPath: repo },
			gitClient: new GitClient(),
			featureManager: manager,
			agentManager: { getAgents: () => [] as never[] },
		} as never;

		require("node:fs").writeFileSync(
			path.join(feature.worktreePath, "new-file.txt"),
			"uncommitted",
		);

		const assessment = assessFeatureFinish(ctx as never, feature, {
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		} as never);
		expect(assessment.safe).toBe(false);
		expect(assessment.forceable).toBe(false);
		// The dirty worktree plus missing integration evidence must block the
		// Finish decision: no worktree or metadata would be removed.
		expect(assessment.reasons.length).toBeGreaterThan(0);
	});

	it("reuses an already-existing branch instead of failing, reporting drift from base", async () => {
		const { repo, worktrees } = repository();
		const { FeatureManager } = await import("../features/featureManager");
		const { Store } = await import("../storage/store");
		const store = new Store(path.join(path.dirname(repo), "store"));

		git(repo, "branch", "feat/pre-existing");
		git(repo, "commit", "--allow-empty", "-m", "advance base");

		const manager = new FeatureManager(store, repo, worktrees, {});
		const feature = manager.createFeatureRecord("pre-existing", "shared");
		const ready = await manager.provisionFeature(feature.id);

		expect(ready?.provisioning?.state).toBe("ready");
		expect(ready?.reusedExistingBranch).toEqual({ behind: 1 });
		expect(ready?.createdFromSha).toBeUndefined();
		expect(require("node:fs").existsSync(feature.worktreePath)).toBe(true);
		expect(git(feature.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
			"feat/pre-existing",
		);
	});
});
