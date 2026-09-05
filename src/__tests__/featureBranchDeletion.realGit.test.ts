import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function repository(): string {
	const base = mkdtempSync(path.join(tmpdir(), "agent-space-branch-del-"));
	temporaryDirectories.push(base);
	const repo = path.join(base, "repo");
	require("node:fs").mkdirSync(repo);
	git(base, "init", "-b", "main", "repo");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	writeFileSync(path.join(repo, "README.md"), "seed\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "seed");
	return repo;
}

async function managerFor(repo: string, branch: string) {
	const { FeatureManager } = await import("../features/featureManager");
	const { Store } = await import("../storage/store");
	const store = new Store(
		mkdtempSync(path.join(tmpdir(), "agent-space-del-store-")),
	);
	temporaryDirectories.push(store as unknown as string);
	store.saveFeatures([
		{
			id: "f1",
			name: "Feature",
			branch,
			worktreePath: path.join(path.dirname(repo), "worktrees", "f1"),
			status: "active",
			color: "blue",
			isolation: "shared",
			createdAt: "2026-08-12T00:00:00.000Z",
		},
	] as never);
	// Reload in-memory list from the store we just wrote.
	const fresh = new FeatureManager(
		store,
		repo,
		path.join(path.dirname(repo), "worktrees"),
		{},
	);
	return fresh;
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

describe("deleteFinishedBranches (real git)", () => {
	it("deletes a merged local branch with plain -d", async () => {
		const repo = repository();
		git(repo, "checkout", "-b", "feat/merged");
		writeFileSync(path.join(repo, "f.txt"), "x\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "feat");
		git(repo, "checkout", "main");
		git(repo, "merge", "--no-ff", "feat/merged", "-m", "merge");
		const manager = await managerFor(repo, "feat/merged");

		const result = await manager.deleteFinishedBranches("f1", {
			branch: "feat/merged",
		});
		expect(result).toMatchObject({ deleted: true });
		expect(git(repo, "branch", "--list", "feat/merged")).toBe("");
	});

	it("refuses an unmerged branch without proof (no -D)", async () => {
		const repo = repository();
		git(repo, "checkout", "-b", "feat/unmerged");
		writeFileSync(path.join(repo, "f.txt"), "x\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "feat");
		git(repo, "checkout", "main");
		const manager = await managerFor(repo, "feat/unmerged");

		const result = await manager.deleteFinishedBranches("f1", {
			branch: "feat/unmerged",
		});
		expect(result.deleted).toBe(false);
		expect(result.reasons.join("\n")).toContain(
			"Only a matched merged pull request proof",
		);
		// Branch still there: no forced deletion happened.
		expect(git(repo, "branch", "--list", "feat/unmerged")).toContain(
			"feat/unmerged",
		);
	});

	it("force-deletes with -D when the local tip matches the merged proof", async () => {
		const repo = repository();
		git(repo, "checkout", "-b", "feat/squashed");
		writeFileSync(path.join(repo, "f.txt"), "x\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "feat");
		const sha = git(repo, "rev-parse", "HEAD");
		git(repo, "checkout", "main");
		// Squash-merge on main: new commit, feature tip stays unmerged.
		git(repo, "merge", "--squash", "feat/squashed");
		git(repo, "commit", "-m", "squash");
		const manager = await managerFor(repo, "feat/squashed");

		const result = await manager.deleteFinishedBranches("f1", {
			branch: "feat/squashed",
			acceptedPullRequestHeadSha: sha,
		});
		expect(result).toMatchObject({ deleted: true });
		expect(git(repo, "branch", "--list", "feat/squashed")).toBe("");
	});

	it("deletes the remote branch too when its tip is the proven tip", async () => {
		const base = mkdtempSync(path.join(tmpdir(), "agent-space-remote-ok-"));
		temporaryDirectories.push(base);
		const origin = path.join(base, "origin.git");
		execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
		const repo = repository();
		git(repo, "remote", "add", "origin", origin);
		git(repo, "checkout", "-b", "feat/both");
		writeFileSync(path.join(repo, "f.txt"), "x\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "feat");
		const sha = git(repo, "rev-parse", "HEAD");
		git(repo, "push", "-u", "origin", "feat/both");
		git(repo, "checkout", "main");
		git(repo, "merge", "--squash", "feat/both");
		git(repo, "commit", "-m", "squash");
		const manager = await managerFor(repo, "feat/both");

		const result = await manager.deleteFinishedBranches("f1", {
			branch: "feat/both",
			acceptedPullRequestHeadSha: sha,
		});
		expect(result).toMatchObject({ deleted: true });
		expect(git(repo, "branch", "--list", "feat/both")).toBe("");
		expect(
			execFileSync("git", ["ls-remote", origin, "refs/heads/feat/both"], {
				encoding: "utf8",
			}).trim(),
		).toBe("");
	});

	it("is idempotent when the branch is already gone", async () => {
		const repo = repository();
		const manager = await managerFor(repo, "feat/gone");
		const result = await manager.deleteFinishedBranches("f1", {
			branch: "feat/gone",
		});
		expect(result).toMatchObject({ deleted: true });
	});

	it("rejects unsafe branch names without touching git", async () => {
		const repo = repository();
		const manager = await managerFor(repo, "feat/ok");
		const result = await manager.deleteFinishedBranches("f1", {
			branch: "feat/../../evil",
		});
		expect(result.deleted).toBe(false);
	});

	it("preserves a remote branch whose tip is not the proven tip", async () => {
		const base = mkdtempSync(path.join(tmpdir(), "agent-space-remote-"));
		temporaryDirectories.push(base);
		const origin = path.join(base, "origin.git");
		execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
		const repo = repository();
		git(repo, "remote", "add", "origin", origin);
		git(repo, "checkout", "-b", "feat/remote");
		writeFileSync(path.join(repo, "f.txt"), "x\n");
		git(repo, "add", ".");
		git(repo, "commit", "-m", "feat");
		const localSha = git(repo, "rev-parse", "HEAD");
		git(repo, "push", "-u", "origin", "feat/remote");
		// A third party advances the remote branch from another clone: the
		// local tip stays at the proven SHA, the remote moves beyond it.
		const peer = path.join(base, "peer");
		execFileSync("git", ["clone", origin, peer], { stdio: "ignore" });
		git(peer, "config", "user.email", "test@example.com");
		git(peer, "config", "user.name", "Test User");
		git(peer, "checkout", "feat/remote");
		git(peer, "commit", "--allow-empty", "-m", "peer work");
		git(peer, "push", "origin", "feat/remote");
		git(repo, "checkout", "main");
		git(repo, "merge", "--squash", "feat/remote");
		git(repo, "commit", "-m", "squash");
		git(repo, "fetch", "origin");
		const manager = await managerFor(repo, "feat/remote");

		// Local tip matches the proof so it goes, but the remote moved on:
		// preserve it and say how to finish manually.
		const result = await manager.deleteFinishedBranches("f1", {
			branch: "feat/remote",
			acceptedPullRequestHeadSha: localSha,
		});
		expect(result.deleted).toBe(false);
		expect(result.reasons.join("\n")).toContain(
			"does not match the merged proof",
		);
		expect(result.suggestedCommand).toBe(
			"git push origin --delete feat/remote",
		);
		// Local branch is gone (proven), remote tracking ref is preserved.
		expect(git(repo, "branch", "--list", "feat/remote")).toBe("");
		expect(
			git(repo, "rev-parse", "--verify", "refs/remotes/origin/feat/remote"),
		).toBeTruthy();
	});
});
