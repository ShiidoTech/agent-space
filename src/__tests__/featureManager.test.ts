import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureManager } from "../features/featureManager";
import { Store } from "../storage/store";

// Mock child_process.execSync for git operations
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("../features/featureGitStatus", () => ({
	computeGitStatus: vi.fn(),
}));

import { execSync } from "node:child_process";
import { computeGitStatus } from "../features/featureGitStatus";

const mockExecSync = vi.mocked(execSync);
const mockComputeGitStatus = vi.mocked(computeGitStatus);

describe("FeatureManager", () => {
	let tmpDir: string;
	let store: Store;
	let manager: FeatureManager;
	const repoRoot = "/fake/repo";

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-test-"));
		store = new Store(tmpDir);
		manager = new FeatureManager(
			store,
			repoRoot,
			path.join(repoRoot, ".worktrees"),
		);
		mockExecSync.mockReset();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("createFeature", () => {
		it("creates a feature with worktree", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = manager.createFeature("auth-system", "shared");

			expect(feature.name).toBe("auth-system");
			expect(feature.branch).toBe("feat/auth-system");
			expect(feature.worktreePath).toContain("auth-system");
			expect(feature.status).toBe("active");
			expect(feature.isolation).toBe("shared");
			expect(mockExecSync).toHaveBeenCalledWith(
				expect.stringContaining("git worktree add"),
				expect.any(Object),
			);
		});

		it("allows spaces in the display name and normalizes git names", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = manager.createFeature("Auth system", "shared");

			expect(feature.name).toBe("Auth system");
			expect(feature.branch).toBe("feat/Auth-system");
			expect(feature.worktreePath).toContain("Auth-system");
		});

		it("persists the feature to storage", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			manager.createFeature("auth-system", "shared");

			const features = store.loadFeatures();
			expect(features).toHaveLength(1);
			expect(features[0].name).toBe("auth-system");
		});

		it("throws on duplicate name", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			manager.createFeature("auth-system", "shared");

			expect(() => manager.createFeature("auth-system", "shared")).toThrow(
				"conflicts with existing feature",
			);
		});

		it("throws when another feature would normalize to the same git name", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			manager.createFeature("auth system", "shared");

			expect(() => manager.createFeature("auth-system", "shared")).toThrow(
				"conflicts with existing feature",
			);
		});
	});

	describe("bootstrap commands", () => {
		it("returns trimmed, non-empty project commands", () => {
			const configured = new FeatureManager(
				store,
				repoRoot,
				path.join(repoRoot, ".worktrees"),
				{ bootstrapCommands: ["  bun install  ", "", "pnpm test"] },
			);

			expect(configured.getBootstrapCommands()).toEqual([
				"bun install",
				"pnpm test",
			]);
		});
	});

	describe("deleteFeature", () => {
		it("removes feature and worktree", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = manager.createFeature("to-delete", "shared");

			manager.deleteFeature(feature.id);

			expect(manager.getFeatures()).toHaveLength(0);
			expect(mockExecSync).toHaveBeenCalledWith(
				expect.stringContaining("git worktree remove"),
				expect.any(Object),
			);
		});
	});

	describe("getFeatures / getFeature", () => {
		it("returns all features", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			manager.createFeature("a", "shared");
			manager.createFeature("b", "per-agent");

			expect(manager.getFeatures()).toHaveLength(2);
		});

		it("returns single feature by id", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const f = manager.createFeature("a", "shared");

			expect(manager.getFeature(f.id)?.name).toBe("a");
			expect(manager.getFeature("nonexistent")).toBeUndefined();
		});
	});

	describe("updateFeatureStatus", () => {
		it("updates status and persists", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const f = manager.createFeature("a", "shared");

			manager.updateFeatureStatus(f.id, "done");

			expect(manager.getFeature(f.id)?.status).toBe("done");
			expect(store.loadFeatures()[0].status).toBe("done");
		});
	});

	describe("getBaseFeature", () => {
		it("returns a feature with base:<projectId> id", () => {
			const projectId = "test-project-123";
			mockExecSync.mockReturnValue("main\n");
			const base = manager.getBaseFeature(projectId);
			expect(base.id).toBe(`base:${projectId}`);
			expect(base.branch).toBe("main");
			expect(base.worktreePath).toBe(repoRoot);
			expect(base.status).toBe("active");
			expect(base.isolation).toBe("shared");
		});

		it("caches the git branch result", () => {
			mockExecSync.mockReturnValue("develop\n");
			const base1 = manager.getBaseFeature("p1");
			const base2 = manager.getBaseFeature("p2");
			expect(base1.branch).toBe("develop");
			expect(base2.branch).toBe("develop");
			// execSync should only be called once for branch detection
			expect(mockExecSync).toHaveBeenCalledTimes(1);
		});

		it("falls back to main when git fails", () => {
			mockExecSync.mockImplementation(() => {
				throw new Error("not a git repo");
			});
			const base = manager.getBaseFeature("p1");
			expect(base.branch).toBe("main");
		});
	});

	describe("updateFeatureIsolation", () => {
		it("updates isolation and persists", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const f = manager.createFeature("a", "shared");

			manager.updateFeatureIsolation(f.id, "per-agent");

			expect(manager.getFeature(f.id)?.isolation).toBe("per-agent");
			expect(store.loadFeatures()[0].isolation).toBe("per-agent");
		});

		it("toggles back to shared", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const f = manager.createFeature("a", "per-agent");

			manager.updateFeatureIsolation(f.id, "shared");

			expect(manager.getFeature(f.id)?.isolation).toBe("shared");
		});

		it("does nothing for unknown feature", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			manager.createFeature("a", "shared");

			manager.updateFeatureIsolation("nonexistent", "per-agent");

			expect(manager.getFeatures()[0].isolation).toBe("shared");
		});
	});

	describe("getFeatureGitStatus", () => {
		it("delegates to computeGitStatus with correct parameters", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			mockComputeGitStatus.mockReturnValue("ahead");
			const feature = manager.createFeature("status-test", "shared");

			const result = manager.getFeatureGitStatus(feature);

			expect(result).toBe("ahead");
			expect(mockComputeGitStatus).toHaveBeenCalledWith({
				featureBranch: feature.branch,
				baseBranch: "main",
				worktreePath: feature.worktreePath,
				repoRoot: repoRoot,
			});
		});

		it("uses cached base branch", () => {
			mockExecSync.mockReturnValueOnce("develop\n");
			mockExecSync.mockReturnValue(Buffer.from(""));
			mockComputeGitStatus.mockReturnValue("new");

			// Trigger base branch detection
			manager.getBaseFeature("p1");

			const feature = manager.createFeature("test", "shared");
			manager.getFeatureGitStatus(feature);

			expect(mockComputeGitStatus).toHaveBeenCalledWith(
				expect.objectContaining({ baseBranch: "develop" }),
			);
		});
	});

	describe("project-config policies (base branch + branch kind)", () => {
		function configManager(config: Record<string, unknown>) {
			return new FeatureManager(
				store,
				repoRoot,
				path.join(repoRoot, ".worktrees"),
				config,
			);
		}

		it("uses the configured base branch instead of the checked-out HEAD", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({ baseBranch: "v2_ia_first" });
			const base = fm.getBaseFeature("p1");
			expect(base.branch).toBe("v2_ia_first");
			// No execSync call to detect HEAD, even though it would return "".
			expect(mockExecSync).not.toHaveBeenCalled();
		});

		it("creates the worktree from the configured base branch", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({ baseBranch: "v2_ia_first" });
			fm.createFeature("some-feature", "shared", "feature");
			expect(mockExecSync).toHaveBeenCalledWith(
				expect.stringContaining(
					`git worktree add "${path.join(repoRoot, ".worktrees", "feature-some-feature")}" -b "feature/some-feature" "v2_ia_first"`,
				),
				expect.any(Object),
			);
		});

		it("uses the selected branch kind as the branch prefix", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({});
			const feature = fm.createFeature("READ-891", "shared", "fix");
			expect(feature.branch).toBe("fix/READ-891");
		});

		it("uses defaultBranchKind when no kind is passed", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({ defaultBranchKind: "feature" });
			const feature = fm.createFeature("READ-891", "shared");
			expect(feature.branch).toBe("feature/READ-891");
		});

		it("throws on delete when the worktree has uncommitted changes", () => {
			// base branch detection → clean
			mockExecSync.mockReturnValueOnce("");
			// createFeature worktree add
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({});
			const feature = fm.createFeature("dirty-one", "shared", "feature");

			mockExecSync.mockReset();
			// deletion safety: git status --porcelain dirty
			mockExecSync.mockReturnValue(" M x.ts\n");

			expect(() => fm.deleteFeature(feature.id)).toThrow("Uncommitted changes");
		});

		it("deletes clean features without --force", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({});
			const feature = fm.createFeature("clean-one", "shared", "feature");

			mockExecSync.mockReset();
			// deletion safety: clean status, no local commits
			mockExecSync.mockReturnValue("");

			const result = fm.deleteFeature(feature.id);
			expect(result.deleted).toBe(true);
			expect(mockExecSync).toHaveBeenCalledWith(
				expect.stringContaining("git worktree remove"),
				expect.any(Object),
			);
			// no --force on the nominal path
			const removeCall = mockExecSync.mock.calls.find(([c]) =>
				String(c).includes("git worktree remove"),
			);
			expect(String(removeCall?.[0])).not.toContain("--force");
		});
	});
});
