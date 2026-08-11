import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateIntegration } from "../features/integrationEvaluator";
import {
	type FeatureGitInspectionInput,
	FeatureGitInspector,
} from "../git/featureGitInspector";
import type {
	FeatureGitObservations,
	GitObservation,
} from "../git/featureGitObservations";
import { GitClient, type GitReader } from "../git/gitClient";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function repository(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "agent-space-inspector-"));
	temporaryDirectories.push(directory);
	git(directory, "init", "-b", "main");
	git(directory, "config", "user.email", "test@example.com");
	git(directory, "config", "user.name", "Test User");
	return directory;
}

function commit(
	repo: string,
	file: string,
	contents: string,
	subject: string,
): string {
	writeFileSync(path.join(repo, file), contents);
	git(repo, "add", file);
	git(repo, "commit", "-m", subject);
	return git(repo, "rev-parse", "HEAD");
}

function input(
	repo: string,
	overrides: Partial<FeatureGitInspectionInput> = {},
): FeatureGitInspectionInput {
	return {
		repoRoot: repo,
		worktreePath: repo,
		featureBranch: "feature/test",
		baseRef: "main",
		...overrides,
	};
}

function value<T>(observation: GitObservation<T>): T {
	expect(observation.status).toBe("known");
	if (observation.status === "unknown") throw new Error(observation.reason);
	return observation.value;
}

async function inspect(
	repo: string,
	overrides: Partial<FeatureGitInspectionInput> = {},
): Promise<FeatureGitObservations> {
	return new FeatureGitInspector().inspect(input(repo, overrides));
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0).reverse()) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FeatureGitInspector against real repositories", () => {
	it("observes a clean feature with no commits beyond its base", async () => {
		const repo = repository();
		commit(repo, "base.txt", "base\n", "base");
		git(repo, "switch", "-c", "feature/test");

		const observation = await inspect(repo);
		expect(value(observation.featureDelta)).toMatchObject({
			leftOnly: 0,
			rightOnly: 0,
		});
		expect(value(observation.featureDiff)).toMatchObject({
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
		});
	});

	it("observes a clean repository with no commits without inventing SHAs", async () => {
		const repo = repository();
		const observation = await inspect(repo, { featureBranch: "main" });

		expect(value(observation.branch)).toMatchObject({
			actual: "main",
			detached: false,
			matchesExpected: true,
		});
		expect(value(observation.workingTree)).toEqual({
			staged: [],
			unstaged: [],
			untracked: [],
			conflicted: [],
		});
		expect(observation.head).toMatchObject({
			status: "unknown",
			reason: "unborn_head",
		});
		expect(observation.featureDelta.status).toBe("unknown");
		expect(observation.featureInBase.status).toBe("unknown");
	});

	it("keeps ahead, base-advanced, and diverged commit comparisons explicit", async () => {
		const repo = repository();
		commit(repo, "base.txt", "base\n", "base");
		git(repo, "switch", "-c", "feature/test");
		commit(repo, "feature.txt", "feature\n", "feature");

		let observation = await inspect(repo);
		expect(value(observation.featureDelta)).toMatchObject({
			leftOnly: 0,
			rightOnly: 1,
		});

		git(repo, "reset", "--hard", "HEAD~1");
		const mainWorktree = mkdtempSync(path.join(tmpdir(), "agent-space-main-"));
		rmSync(mainWorktree, { recursive: true });
		temporaryDirectories.push(mainWorktree);
		git(repo, "worktree", "add", mainWorktree, "main");
		commit(mainWorktree, "main.txt", "main\n", "main advances");
		observation = await inspect(repo);
		expect(value(observation.featureDelta)).toMatchObject({
			leftOnly: 1,
			rightOnly: 0,
		});

		commit(repo, "feature.txt", "different feature\n", "feature advances");
		observation = await inspect(repo);
		expect(value(observation.featureDelta)).toMatchObject({
			leftOnly: 1,
			rightOnly: 1,
		});
	});

	it("separates staged, unstaged, and untracked files from feature delta", async () => {
		const repo = repository();
		commit(repo, "tracked.txt", "one\n", "initial");
		git(repo, "switch", "-c", "feature/test");
		writeFileSync(path.join(repo, "staged.txt"), "staged\n");
		git(repo, "add", "staged.txt");
		writeFileSync(path.join(repo, "tracked.txt"), "two\n");
		writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");

		const observation = await inspect(repo);
		expect(value(observation.workingTree)).toEqual({
			staged: ["staged.txt"],
			unstaged: ["tracked.txt"],
			untracked: ["untracked.txt"],
			conflicted: [],
		});
		expect(value(observation.featureDelta).rightOnly).toBe(0);
		expect(value(observation.featureDiff).filesChanged).toBe(0);
	});

	it.each([
		["staged", { staged: ["file.txt"], unstaged: [], untracked: [] }],
		["unstaged", { staged: [], unstaged: ["tracked.txt"], untracked: [] }],
		["untracked", { staged: [], unstaged: [], untracked: ["file.txt"] }],
	] as const)("observes a %s-only working tree", async (kind, expected) => {
		const repo = repository();
		commit(repo, "tracked.txt", "initial\n", "initial");
		git(repo, "switch", "-c", "feature/test");
		if (kind === "staged") {
			writeFileSync(path.join(repo, "file.txt"), "staged\n");
			git(repo, "add", "file.txt");
		} else if (kind === "unstaged") {
			writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
		} else {
			writeFileSync(path.join(repo, "file.txt"), "untracked\n");
		}

		const changes = value((await inspect(repo)).workingTree);
		expect(changes).toMatchObject({ ...expected, conflicted: [] });
	});

	it("observes conflicts separately", async () => {
		const repo = repository();
		commit(repo, "conflict.txt", "base\n", "initial");
		git(repo, "switch", "-c", "feature/test");
		commit(repo, "conflict.txt", "feature\n", "feature edit");
		git(repo, "switch", "main");
		commit(repo, "conflict.txt", "main\n", "main edit");
		git(repo, "switch", "feature/test");
		try {
			git(repo, "merge", "main");
		} catch {
			// The conflict is the state under inspection.
		}

		const observation = await inspect(repo);
		expect(value(observation.workingTree).conflicted).toEqual(["conflict.txt"]);
		expect(value(observation.workingTree).staged).toEqual([]);
		expect(value(observation.workingTree).unstaged).toEqual([]);
	});

	it("observes detached HEAD and branch mismatch without changing either", async () => {
		const repo = repository();
		commit(repo, "file.txt", "content\n", "initial");
		git(repo, "switch", "-c", "other");

		let observation = await inspect(repo);
		expect(value(observation.branch)).toMatchObject({
			actual: "other",
			matchesExpected: false,
		});

		const sha = git(repo, "rev-parse", "HEAD");
		git(repo, "checkout", "--detach", sha);
		observation = await inspect(repo);
		expect(value(observation.branch)).toMatchObject({
			actual: null,
			detached: true,
			matchesExpected: false,
		});
		expect(git(repo, "rev-parse", "HEAD")).toBe(sha);
	});

	it("keeps an unexpected symbolic-ref failure unknown", async () => {
		const repo = repository();
		commit(repo, "file.txt", "content\n", "initial");
		git(repo, "switch", "-c", "feature/test");
		const client = new GitClient();
		const reader: GitReader = {
			readSync: (argv, options) => client.readSync(argv, options),
			read: (argv, options) =>
				argv[0] === "symbolic-ref"
					? Promise.resolve({
							argv,
							cwd: options.cwd,
							exitCode: 128,
							signal: null,
							stdout: "",
							stderr: "permission denied",
							error: new Error("permission denied"),
						})
					: client.read(argv, options),
		};

		const observation = await new FeatureGitInspector(reader).inspect(
			input(repo),
		);
		expect(observation.branch).toMatchObject({
			status: "unknown",
			reason: "git_command_failed",
		});
	});

	it("executes only local read commands", async () => {
		const repo = repository();
		const createdFromSha = commit(repo, "file.txt", "content\n", "initial");
		git(repo, "switch", "-c", "feature/test");
		const client = new GitClient();
		const commands: string[][] = [];
		const reader: GitReader = {
			readSync: (argv, options) => client.readSync(argv, options),
			read: (argv, options) => {
				commands.push([...argv]);
				return client.read(argv, options);
			},
		};

		await new FeatureGitInspector(reader).inspect(
			input(repo, { createdFromSha }),
		);
		const forbidden = new Set([
			"add",
			"branch",
			"checkout",
			"commit",
			"fetch",
			"merge",
			"pull",
			"push",
			"reset",
			"switch",
			"update-ref",
		]);
		expect(commands.length).toBeGreaterThan(0);
		expect(commands.some(([command]) => forbidden.has(command))).toBe(false);
	});

	it("exposes canonical old and new paths for a real rename", async () => {
		const repo = repository();
		commit(repo, "old.ts", "const value = 1;\n", "initial");
		git(repo, "switch", "-c", "feature/test");
		git(repo, "mv", "old.ts", "new.ts");
		git(repo, "commit", "-m", "rename file");

		const observation = await inspect(repo);
		const diff = value(observation.featureDiff);
		expect(diff.files).toEqual([
			expect.objectContaining({
				path: "new.ts",
				oldPath: "old.ts",
				newPath: "new.ts",
			}),
		]);
	});

	it("shares project-wide worktree facts across feature inspections", async () => {
		const repo = repository();
		commit(repo, "base.txt", "base\n", "base");
		const featurePath = mkdtempSync(
			path.join(tmpdir(), "agent-space-feature-"),
		);
		rmSync(featurePath, { recursive: true });
		temporaryDirectories.push(featurePath);
		git(repo, "worktree", "add", featurePath, "-b", "feature/test");
		const inspector = new FeatureGitInspector();
		const project = await inspector.observeProject(repo);
		const readerCommands: string[][] = [];
		const client = new GitClient();
		const reader: GitReader = {
			readSync: (argv, options) => client.readSync(argv, options),
			read: (argv, options) => {
				readerCommands.push([...argv]);
				return client.read(argv, options);
			},
		};
		const sharedInspector = new FeatureGitInspector(reader);
		await sharedInspector.inspect(
			input(repo, { worktreePath: featurePath }),
			project,
		);
		await sharedInspector.inspect(
			input(repo, { worktreePath: featurePath }),
			project,
		);
		expect(
			readerCommands.filter(
				([command, subcommand]) =>
					command === "worktree" && subcommand === "list",
			),
		).toHaveLength(0);
	});

	it("does not prove integration when feature and base only meet after base advancement", async () => {
		const repo = repository();
		const createdFromSha = commit(repo, "base.txt", "A\n", "A");
		const featurePath = mkdtempSync(
			path.join(tmpdir(), "agent-space-feature-"),
		);
		rmSync(featurePath, { recursive: true });
		temporaryDirectories.push(featurePath);
		git(repo, "worktree", "add", featurePath, "-b", "feature/test");
		commit(repo, "base.txt", "B\n", "B");
		git(featurePath, "reset", "--hard", "main");

		const observation = await inspect(repo, {
			worktreePath: featurePath,
			createdFromSha,
		});
		expect(value(observation.feature).sha).toBe(value(observation.base).sha);
		expect(evaluateIntegration(observation, createdFromSha)).toMatchObject({
			status: "unknown",
			reason: "ancestry_unknown",
		});
	});

	it("reports a missing worktree and unknown base explicitly", async () => {
		const repo = repository();
		commit(repo, "file.txt", "content\n", "initial");
		const missing = path.join(repo, "missing-worktree");
		const observation = await inspect(repo, {
			worktreePath: missing,
			baseRef: "missing-base",
		});

		expect(value(observation.worktree)).toEqual({
			path: missing,
			present: false,
		});
		expect(observation.workingTree).toMatchObject({
			status: "unknown",
			reason: "worktree_missing",
		});
		expect(observation.base).toMatchObject({
			status: "unknown",
			reason: "base_unknown",
		});
		expect(observation.featureDelta.status).toBe("unknown");
	});

	it("distinguishes absent upstream from a configured absent remote ref", async () => {
		const repo = repository();
		commit(repo, "file.txt", "content\n", "initial");
		git(repo, "switch", "-c", "feature/test");

		let observation = await inspect(repo);
		expect(value(observation.upstream).upstream).toBeNull();
		expect(value(observation.upstreamDivergence)).toBeNull();

		git(repo, "config", "branch.feature/test.remote", "origin");
		git(repo, "config", "branch.feature/test.merge", "refs/heads/feature/test");
		observation = await inspect(repo);
		expect(observation.upstream).toMatchObject({
			status: "unknown",
			reason: "upstream_ref_missing",
			observed: { ref: "refs/remotes/origin/feature/test" },
		});
		expect(observation.upstreamDivergence.status).toBe("unknown");
	});

	it("preserves refs and SHAs in feature and upstream divergence comparisons", async () => {
		const repo = repository();
		commit(repo, "base.txt", "base\n", "base");
		git(repo, "switch", "-c", "feature/test");
		commit(repo, "feature.txt", "feature\n", "feature");
		git(repo, "update-ref", "refs/remotes/origin/feature/test", "main");
		git(repo, "config", "branch.feature/test.remote", "origin");
		git(repo, "config", "branch.feature/test.merge", "refs/heads/feature/test");

		const observation = await inspect(repo);
		const delta = value(observation.featureDelta);
		const divergence = value(observation.upstreamDivergence);
		expect(delta.left.ref).toBe("main");
		expect(delta.right.ref).toBe("feature/test");
		expect(delta.left.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(delta.right.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(divergence?.left.ref).toBe("refs/remotes/origin/feature/test");
		expect(divergence?.right.sha).toBe(delta.right.sha);
	});

	it("records actual ancestry while leaving integration semantics unevaluated", async () => {
		const repo = repository();
		const createdFromSha = commit(repo, "base.txt", "base\n", "base");
		git(repo, "switch", "-c", "feature/test");
		commit(repo, "feature.txt", "feature\n", "feature");
		git(repo, "switch", "main");
		git(repo, "merge", "--no-ff", "feature/test", "-m", "integrate feature");
		git(repo, "switch", "feature/test");

		const proven = await inspect(repo, { createdFromSha });
		expect(value(proven.featureInBase)).toMatchObject({
			isAncestor: true,
		});
		expect(evaluateIntegration(proven, createdFromSha)).toMatchObject({
			status: "known",
			outcome: "integrated_by_ancestry",
		});

		const impossible = await inspect(repo);
		expect(value(impossible.featureInBase)).toMatchObject({
			isAncestor: true,
		});
		expect(JSON.stringify(impossible)).not.toContain('"kind":"integrated"');
		expect(evaluateIntegration(impossible)).toMatchObject({
			status: "unknown",
			reason: "creation_point_unknown",
		});
		expect(existsSync(path.join(repo, ".git", "FETCH_HEAD"))).toBe(false);
	});
});
