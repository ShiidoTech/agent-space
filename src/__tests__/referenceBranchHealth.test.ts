import { describe, expect, it, vi } from "vitest";
import type {
	GitReader,
	GitReadOptions,
	GitReadResult,
} from "../git/gitClient";
import {
	GitLsRemoteBranchHeadSource,
	normalizeReferenceBranch,
	ProjectReferenceBranchObserver,
	type RemoteBranchHeadObservation,
	type RemoteBranchHeadSource,
} from "../projects/referenceBranchHealth";

describe("normalizeReferenceBranch", () => {
	it.each([
		["main", { branch: "main", remoteName: "origin" }],
		["origin/main", { branch: "main", remoteName: "origin" }],
		[
			"refs/remotes/upstream/release/x",
			{ branch: "release/x", remoteName: "upstream" },
		],
		["feature/x", { branch: "feature/x", remoteName: "origin" }],
	] as const)("normalizes %s", (configured, expected) => {
		expect(normalizeReferenceBranch(configured)).toEqual(expected);
	});
});

const LOCAL = "1".repeat(40);
const TRACKING = "2".repeat(40);
const REMOTE = "3".repeat(40);
const NOW = new Date("2026-08-12T10:00:00.000Z");

class FakeGit implements GitReader {
	readonly calls: readonly string[][];
	private callIndex = 0;

	constructor(private readonly results: readonly Partial<GitReadResult>[]) {
		this.calls = [];
	}

	readSync(): GitReadResult {
		throw new Error("Unexpected synchronous Git read");
	}

	async read(
		argv: readonly string[],
		options: GitReadOptions,
	): Promise<GitReadResult> {
		(this.calls as string[][]).push([...argv]);
		const result = this.results[this.callIndex++];
		if (!result) throw new Error(`Unexpected Git call: ${argv.join(" ")}`);
		return {
			argv,
			cwd: options.cwd,
			exitCode: 0,
			signal: null,
			stdout: "",
			stderr: "",
			...result,
		};
	}
}

function success(stdout = ""): Partial<GitReadResult> {
	return { exitCode: 0, stdout };
}

function failure(exitCode = 1, stderr = "missing"): Partial<GitReadResult> {
	return { exitCode, stderr };
}

function remote(
	overrides: Partial<RemoteBranchHeadObservation> = {},
): RemoteBranchHeadSource {
	return {
		observe: vi.fn(async () => ({
			status: "known" as const,
			sha: REMOTE,
			observedAt: NOW.toISOString(),
			provenance: {
				source: "remote_head" as const,
				ref: "refs/heads/main",
				backend: "test provider",
			},
			...overrides,
		})) as RemoteBranchHeadSource["observe"],
	};
}

function observer(
	git: GitReader,
	remoteSource: RemoteBranchHeadSource = remote(),
	options: { staleAfterMs?: number } = {},
): ProjectReferenceBranchObserver {
	return new ProjectReferenceBranchObserver({
		git,
		remote: remoteSource,
		now: () => NOW,
		...options,
	});
}

describe("ProjectReferenceBranchObserver", () => {
	it.each([
		["current", "0\t0\n", 0, 0],
		["behind", "0\t4\n", 0, 4],
		["ahead", "3\t0\n", 3, 0],
		["diverged", "2\t5\n", 2, 5],
	] as const)("classifies a verified remote relation as %s", async (state, counts, localOnly, comparedOnly) => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			success(`${TRACKING}\n`),
			success("1\t1\n"),
			success(),
			success(counts),
		]);
		const result = await observer(git).observe({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result.state).toBe(state);
		expect(result.verifiedRemoteRelation).toEqual({
			state,
			localOnly,
			comparedOnly,
		});
		expect(result.local).toMatchObject({
			status: "known",
			sha: LOCAL,
			provenance: { source: "local_branch", ref: "refs/heads/main" },
		});
		expect(result.remoteTracking).toMatchObject({
			status: "known",
			sha: TRACKING,
			provenance: {
				source: "remote_tracking_ref",
				ref: "refs/remotes/origin/main",
			},
		});
		expect(result.verifiedRemote).toMatchObject({
			status: "known",
			sha: REMOTE,
			provenance: { source: "remote_head" },
		});
		expect(result.remoteFreshness).toEqual({
			status: "fresh",
			observedAt: NOW.toISOString(),
			ageMs: 0,
			staleAfterMs: 300_000,
		});
	});

	it("keeps tracking evidence separate from the verified remote state", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			success(`${TRACKING}\n`),
			success("0\t2\n"),
			failure(128, "unknown revision"),
		]);
		const result = await observer(git).observe({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result.remoteTrackingRelation).toEqual({
			state: "behind",
			localOnly: 0,
			comparedOnly: 2,
		});
		expect(result.state).toBe("different_unknown");
		expect(result.verifiedRemoteRelation).toMatchObject({
			state: "different_unknown",
			reason: "remote_object_not_available_locally",
		});
		expect(git.calls).not.toContainEqual([
			"rev-list",
			"--left-right",
			"--count",
			`${LOCAL}...${REMOTE}`,
		]);
	});

	it("reuses tracking ancestry when its head matches the verified remote", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			success(`${TRACKING}\n`),
			success("0\t7\n"),
		]);
		const result = await observer(
			git,
			remote({ status: "known", sha: TRACKING }),
		).observe({ repoPath: "/repo", branch: "main" });

		expect(result.state).toBe("behind");
		expect(result.remoteTrackingRelation).toEqual({
			state: "behind",
			localOnly: 0,
			comparedOnly: 7,
		});
		expect(result.verifiedRemoteRelation).toEqual(
			result.remoteTrackingRelation,
		);
		expect(git.calls).toHaveLength(4);
		expect(git.calls.some((argv) => argv[0] === "cat-file")).toBe(false);
	});

	it("proves current from identical ids without requiring the remote object", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			failure(),
		]);
		const result = await observer(
			git,
			remote({ status: "known", sha: LOCAL }),
		).observe({ repoPath: "/repo", branch: "main" });

		expect(result.state).toBe("current");
		expect(result.remoteTrackingRelation).toEqual({
			state: "missing",
			reason: "compared_ref_missing",
		});
		expect(git.calls.some((argv) => argv[0] === "cat-file")).toBe(false);
	});

	it("reports a missing local base even when the remote branch exists", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			failure(),
			success(`${TRACKING}\n`),
		]);
		const result = await observer(git).observe({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result.local.status).toBe("missing");
		expect(result.state).toBe("missing");
		expect(result.verifiedRemoteRelation).toEqual({
			state: "missing",
			reason: "local_branch_missing",
		});
	});

	it("reports a verified missing remote branch without trusting tracking", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			success(`${TRACKING}\n`),
			success("0\t2\n"),
		]);
		const result = await observer(git, remote({ status: "missing" })).observe({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result.remoteTrackingRelation.state).toBe("behind");
		expect(result.state).toBe("missing");
		expect(result.verifiedRemoteRelation).toEqual({
			state: "missing",
			reason: "compared_ref_missing",
		});
	});

	it("keeps a remote query failure unknown", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			failure(),
		]);
		const result = await observer(
			git,
			remote({
				status: "unknown",
				reason: "network_unavailable",
				detail: "offline",
			}),
		).observe({ repoPath: "/repo", branch: "main" });

		expect(result.state).toBe("unknown");
		expect(result.verifiedRemoteRelation).toEqual({
			state: "unknown",
			reason: "compared_ref_unknown",
			detail: "offline",
		});
	});

	it("does not query the remote when the repository is unavailable", async () => {
		const git = new FakeGit([failure(128, "not a git repository")]);
		const remoteSource = remote();
		const result = await observer(git, remoteSource).observe({
			repoPath: "/missing",
			branch: "main",
		});

		expect(result.state).toBe("unknown");
		expect(result.local).toMatchObject({
			status: "unknown",
			reason: "repository_unavailable",
		});
		expect(remoteSource.observe).not.toHaveBeenCalled();
	});

	it("marks cached remote evidence stale from its own timestamp", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			failure(),
		]);
		const result = await observer(
			git,
			remote({
				status: "known",
				sha: LOCAL,
				observedAt: "2026-08-12T09:50:00.000Z",
			}),
		).observe({ repoPath: "/repo", branch: "main" });

		expect(result.remoteFreshness).toEqual({
			status: "stale",
			observedAt: "2026-08-12T09:50:00.000Z",
			ageMs: 600_000,
			staleAfterMs: 300_000,
		});
	});

	it("keeps invalid observation time freshness unknown", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			failure(),
		]);
		const result = await observer(
			git,
			remote({ status: "known", sha: LOCAL, observedAt: "invalid" }),
		).observe({ repoPath: "/repo", branch: "main" });

		expect(result.remoteFreshness).toEqual({
			status: "unknown",
			observedAt: "invalid",
			staleAfterMs: 300_000,
		});
	});

	it("keeps malformed comparison output unknown", async () => {
		const git = new FakeGit([
			success("/repo\n"),
			success(`${LOCAL}\n`),
			success(`${LOCAL}\n`),
			success(),
			success(),
			success("not counts\n"),
		]);
		const result = await observer(git).observe({
			repoPath: "/repo",
			branch: "main",
		});

		expect(result.state).toBe("unknown");
		expect(result.verifiedRemoteRelation).toMatchObject({
			state: "unknown",
			reason: "comparison_failed",
		});
	});
});

describe("GitLsRemoteBranchHeadSource", () => {
	it("reads one exact remote branch without mutating local refs", async () => {
		const git = new FakeGit([success(`${REMOTE}\trefs/heads/main\n`)]);
		const source = new GitLsRemoteBranchHeadSource({ git, now: () => NOW });

		await expect(
			source.observe({
				repoPath: "/repo",
				remoteName: "origin",
				branch: "main",
			}),
		).resolves.toEqual({
			status: "known",
			sha: REMOTE,
			observedAt: NOW.toISOString(),
			provenance: {
				source: "remote_head",
				ref: "refs/heads/main",
				backend: "git ls-remote",
			},
		});
		expect(git.calls).toEqual([
			["ls-remote", "--heads", "origin", "refs/heads/main"],
		]);
	});

	it("distinguishes a missing remote branch from a failed query", async () => {
		const missingSource = new GitLsRemoteBranchHeadSource({
			git: new FakeGit([success()]),
			now: () => NOW,
		});
		const failedSource = new GitLsRemoteBranchHeadSource({
			git: new FakeGit([failure(128, "could not resolve host")]),
			now: () => NOW,
		});

		await expect(
			missingSource.observe({
				repoPath: "/repo",
				remoteName: "origin",
				branch: "main",
			}),
		).resolves.toMatchObject({ status: "missing" });
		await expect(
			failedSource.observe({
				repoPath: "/repo",
				remoteName: "origin",
				branch: "main",
			}),
		).resolves.toMatchObject({
			status: "unknown",
			reason: "remote_query_failed",
		});
	});

	it("caches remote observations until explicitly invalidated", async () => {
		const git = new FakeGit([
			success(`${REMOTE}\trefs/heads/main\n`),
			success(`${LOCAL}\trefs/heads/main\n`),
		]);
		const source = new GitLsRemoteBranchHeadSource({ git, now: () => NOW });
		const request = {
			repoPath: "/repo",
			remoteName: "origin",
			branch: "main",
		};

		await source.observe(request);
		await source.observe(request);
		expect(git.calls).toHaveLength(1);

		source.invalidate();
		await expect(source.observe(request)).resolves.toMatchObject({
			sha: LOCAL,
		});
		expect(git.calls).toHaveLength(2);
	});

	it("shares an in-flight query and does not let an invalidated result replace fresh proof", async () => {
		let releaseFirst: ((result: GitReadResult) => void) | undefined;
		const firstResult = new Promise<GitReadResult>((resolve) => {
			releaseFirst = resolve;
		});
		const read = vi
			.fn()
			.mockReturnValueOnce(firstResult)
			.mockResolvedValueOnce({
				...gitResultForTest(`${LOCAL}\trefs/heads/main\n`),
			});
		const source = new GitLsRemoteBranchHeadSource({
			git: { read, readSync: vi.fn() },
			now: () => NOW,
		});
		const request = {
			repoPath: "/repo",
			remoteName: "origin",
			branch: "main",
		};

		const first = source.observe(request);
		const shared = source.observe(request);
		expect(read).toHaveBeenCalledTimes(1);

		source.invalidate();
		const refreshed = source.observe(request);
		expect(read).toHaveBeenCalledTimes(2);
		releaseFirst?.(gitResultForTest(`${REMOTE}\trefs/heads/main\n`));

		await expect(first).resolves.toMatchObject({ sha: REMOTE });
		await expect(shared).resolves.toMatchObject({ sha: REMOTE });
		await expect(refreshed).resolves.toMatchObject({ sha: LOCAL });
		await expect(source.observe(request)).resolves.toMatchObject({
			sha: LOCAL,
		});
		expect(read).toHaveBeenCalledTimes(2);
	});

	it.each([
		`${REMOTE}\trefs/heads/other\n`,
		`not-a-sha\trefs/heads/main\n`,
		`${REMOTE}\trefs/heads/main\n${LOCAL}\trefs/heads/main\n`,
	])("rejects an invalid remote response", async (stdout) => {
		const source = new GitLsRemoteBranchHeadSource({
			git: new FakeGit([success(stdout)]),
			now: () => NOW,
		});
		const result = await source.observe({
			repoPath: "/repo",
			remoteName: "origin",
			branch: "main",
		});

		expect(result.status).toBe("unknown");
	});
});

function gitResultForTest(stdout: string): GitReadResult {
	return {
		argv: [],
		cwd: "/repo",
		exitCode: 0,
		signal: null,
		stdout,
		stderr: "",
	};
}
