import { describe, expect, it } from "vitest";
import type { GitWorktreeObservation } from "../git/featureGitObservations";
import type {
	GitReader,
	GitReadOptions,
	GitReadResult,
} from "../git/gitClient";
import { WorktreeBranchObserver } from "../git/worktreeBranchObserver";

const NOW = new Date("2026-08-13T10:00:00.000Z");

const BASE_SHA = "1".repeat(40);
const HEAD_A = "2".repeat(40);
const HEAD_B = "3".repeat(40);
const HEAD_C = "4".repeat(40);

type Handler = (
	argv: readonly string[],
	options: GitReadOptions,
) => Partial<GitReadResult>;

class FakeGit implements GitReader {
	readonly calls: readonly string[][] = [];
	private readonly handler: Handler;

	constructor(handler: Handler) {
		this.handler = handler;
	}

	readSync(): GitReadResult {
		throw new Error("Unexpected synchronous Git read");
	}

	async read(
		argv: readonly string[],
		options: GitReadOptions,
	): Promise<GitReadResult> {
		(this.calls as string[][]).push([...argv]);
		const result = this.handler(argv, options);
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

function worktree(
	overrides: Partial<GitWorktreeObservation> & { path: string },
): GitWorktreeObservation {
	return {
		headSha: null,
		branchRef: null,
		detached: false,
		bare: false,
		prunable: false,
		...overrides,
	};
}

/** Base rev-parse always succeeds; status is always clean unless overridden. */
function defaultGit(
	overrides: {
		readonly mergeBase?: (headSha: string, baseSha: string) => number;
		readonly counts?: (headSha: string, baseSha: string) => string;
		readonly status?: Partial<GitReadResult>;
		readonly baseResult?: Partial<GitReadResult>;
	} = {},
): FakeGit {
	return new FakeGit((argv) => {
		if (argv[0] === "rev-parse")
			return overrides.baseResult ?? { exitCode: 0, stdout: `${BASE_SHA}\n` };
		if (argv[0] === "status")
			return overrides.status ?? { exitCode: 0, stdout: "" };
		if (argv[0] === "merge-base") {
			const exitCode =
				overrides.mergeBase?.(argv[2] as string, argv[3] as string) ?? 0;
			return { exitCode };
		}
		if (argv[0] === "rev-list") {
			const range = argv[3] as string;
			const [headSha] = range.split("...");
			const stdout = overrides.counts?.(headSha, range) ?? "1 1";
			return { exitCode: 0, stdout };
		}
		return { exitCode: 128, stderr: `unexpected argv: ${argv.join(" ")}` };
	});
}

describe("WorktreeBranchObserver", () => {
	it("returns an empty known inventory when no worktrees are attached", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit(),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [],
			baseRef: "main",
		});
		expect(inventory).toEqual({
			repoPath: "/repo",
			baseRef: "main",
			status: "known",
			branches: [],
			observedAt: NOW.toISOString(),
		});
	});

	it("classifies current, merged, ahead and diverged branches vs base", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit({
				mergeBase: (headSha) => (headSha === HEAD_A ? 0 : 1),
				counts: (headSha) =>
					headSha === HEAD_B ? "3 0" : headSha === HEAD_C ? "2 4" : "0 0",
			}),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({
					path: "/repo/.worktrees/cur",
					branchRef: "refs/heads/feat/cur",
					headSha: BASE_SHA,
				}),
				worktree({
					path: "/repo/.worktrees/merged",
					branchRef: "refs/heads/feat/merged",
					headSha: HEAD_A,
				}),
				worktree({
					path: "/repo/.worktrees/ahead",
					branchRef: "refs/heads/feat/ahead",
					headSha: HEAD_B,
				}),
				worktree({
					path: "/repo/.worktrees/div",
					branchRef: "refs/heads/feat/div",
					headSha: HEAD_C,
				}),
			],
			baseRef: "main",
		});
		expect(inventory.status).toBe("known");
		expect(inventory.branches).toHaveLength(4);
		expect(inventory.branches[0].baseRelation).toEqual({ status: "current" });
		expect(inventory.branches[1].baseRelation).toEqual({ status: "merged" });
		expect(inventory.branches[2].baseRelation).toEqual({
			status: "ahead",
			commits: 3,
		});
		expect(inventory.branches[3].baseRelation).toEqual({
			status: "diverged",
			ahead: 2,
			behind: 4,
		});
		expect(inventory.branches[0].workingTree).toEqual({ status: "clean" });
	});

	it("skips bare worktrees and detached entries without a branch ref", async () => {
		const git = defaultGit();
		const observer = new WorktreeBranchObserver({ git, now: () => NOW });
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({ path: "/repo/.worktrees/bare", bare: true }),
				worktree({
					path: "/repo/.worktrees/det",
					detached: true,
					headSha: HEAD_A,
				}),
			],
			baseRef: "main",
		});
		expect(inventory.branches).toEqual([]);
		expect(git.calls).toEqual([]);
	});

	it("links branches to their owning feature id", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit({ mergeBase: () => 1, counts: () => "5 0" }),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({
					path: "/repo/.worktrees/cockpit",
					branchRef: "refs/heads/agent/restore-feature-cockpit",
					headSha: HEAD_A,
				}),
			],
			baseRef: "main",
			featureBranches: new Map([["agent/restore-feature-cockpit", "f1"]]),
		});
		expect(inventory.branches[0].linkedFeatureId).toBe("f1");
		expect(inventory.branches[0].ref).toBe("agent/restore-feature-cockpit");
		expect(inventory.branches[0].baseRelation).toEqual({
			status: "ahead",
			commits: 5,
		});
	});

	it("reports unknown relation when the base ref cannot be resolved", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit({
				baseResult: {
					exitCode: 128,
					stderr: "fatal: ambiguous argument 'main'",
				},
			}),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({
					path: "/repo/.worktrees/f",
					branchRef: "refs/heads/feat/f",
					headSha: HEAD_A,
				}),
			],
			baseRef: "main",
		});
		expect(inventory.branches[0].baseRelation).toEqual({
			status: "unknown",
			reason: "base_unknown",
		});
	});

	it("reports unknown relation when no base ref is observed", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit(),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({
					path: "/repo/.worktrees/f",
					branchRef: "refs/heads/feat/f",
					headSha: HEAD_A,
				}),
			],
		});
		expect(inventory.branches[0].baseRelation).toEqual({
			status: "unknown",
			reason: "base_unknown",
		});
	});

	it("flags dirty working trees", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit({
				mergeBase: () => 1,
				counts: () => "1 0",
				status: { exitCode: 0, stdout: " M src/a.ts\0" },
			}),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({
					path: "/repo/.worktrees/dirty",
					branchRef: "refs/heads/feat/dirty",
					headSha: HEAD_A,
				}),
			],
			baseRef: "main",
		});
		expect(inventory.branches[0].workingTree).toEqual({ status: "dirty" });
	});

	it("reports unknown working tree when git status fails", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit({
				status: { exitCode: 128, stderr: "fatal: not a git repository" },
			}),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({
					path: "/repo/.worktrees/gone",
					branchRef: "refs/heads/feat/gone",
					headSha: HEAD_A,
				}),
			],
			baseRef: "main",
		});
		expect(inventory.branches[0].workingTree).toEqual({ status: "unknown" });
	});

	it("tolerates a status failure while still reporting the relation", async () => {
		const observer = new WorktreeBranchObserver({
			git: defaultGit({
				mergeBase: () => 1,
				counts: () => "7 0",
				status: { exitCode: 128 },
			}),
			now: () => NOW,
		});
		const inventory = await observer.observe({
			repoPath: "/repo",
			worktrees: [
				worktree({
					path: "/repo/.worktrees/f",
					branchRef: "refs/heads/feat/f",
					headSha: HEAD_A,
				}),
			],
			baseRef: "main",
		});
		expect(inventory.branches[0].baseRelation).toEqual({
			status: "ahead",
			commits: 7,
		});
		expect(inventory.branches[0].workingTree).toEqual({ status: "unknown" });
	});
});
