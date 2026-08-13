import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureManager } from "../features/featureManager";
import { Store } from "../storage/store";

// Mock child_process.execSync for git operations
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execSync: vi.fn(),
}));

import { execFile, execSync } from "node:child_process";

const mockExecSync = vi.mocked(execSync);
const mockExecFile = vi.mocked(execFile);

describe("FeatureManager", () => {
	let tmpDir: string;
	let store: Store;
	let manager: FeatureManager;
	const repoRoot = "/fake/repo";
	const featureSha = "a".repeat(40);
	const baseSha = "b".repeat(40);

	function mockCleanMergedDeletion(remove?: () => string): void {
		const activeBranch = store.loadFeatures()[0]?.branch ?? "feat/unknown";
		mockExecSync.mockImplementation((command: string) => {
			const value = String(command);
			if (value.includes("symbolic-ref")) return `${activeBranch}\n`;
			if (value.includes("git status --porcelain")) return "";
			if (value.includes('rev-parse --verify "feat/')) return featureSha;
			if (value.includes('rev-parse --verify "feature/')) return featureSha;
			if (value.includes('rev-parse --verify "main')) return baseSha;
			if (value.includes("merge-base --is-ancestor")) return "";
			if (value.includes("rev-list --count")) return "0";
			if (value.includes("git worktree remove")) return remove?.() ?? "";
			return "";
		});
	}

	function mockCleanSquashMergedDeletion(remove?: () => string): void {
		const activeBranch = store.loadFeatures()[0]?.branch ?? "feat/unknown";
		mockExecSync.mockImplementation((command: string) => {
			const value = String(command);
			if (value.includes("symbolic-ref")) return `${activeBranch}\n`;
			if (value.includes("git status --porcelain")) return "";
			if (value.includes('rev-parse --verify "feat/')) return featureSha;
			if (value.includes('rev-parse --verify "feature/')) return featureSha;
			if (value.includes('rev-parse --verify "main')) return baseSha;
			if (value.includes("merge-base --is-ancestor")) {
				throw Object.assign(new Error("not ancestor"), { status: 1 });
			}
			if (value.includes("rev-list --count")) return "1";
			if (value.includes("git worktree remove")) return remove?.() ?? "";
			return "";
		});
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-test-"));
		store = new Store(tmpDir);
		manager = new FeatureManager(
			store,
			repoRoot,
			path.join(repoRoot, ".worktrees"),
			{ baseBranch: "main" },
		);
		mockExecSync.mockReset();
		mockExecFile.mockReset();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("createFeature", () => {
		it("provisions asynchronously without blocking the extension host", async () => {
			mockExecFile.mockImplementation(((
				_callbackFile: string,
				_callbackArgs: readonly string[],
				_callbackOptions: unknown,
				callback: (
					error: Error | null,
					result?: { stdout: string; stderr: string },
				) => void,
			) => {
				callback(null, { stdout: "abc123\n", stderr: "" });
			}) as never);
			const asyncManager = new FeatureManager(
				store,
				repoRoot,
				path.join(repoRoot, ".worktrees"),
				{ baseBranch: "main" },
			);

			const feature = asyncManager.createFeatureRecord(
				"async-feature",
				"shared",
			);
			const promise = asyncManager.provisionFeature(feature.id);

			expect(feature.provisioning?.state).toBe("provisioning");
			await expect(promise).resolves.toMatchObject({
				id: feature.id,
				createdFromSha: "abc123",
			});
			expect(mockExecFile).toHaveBeenNthCalledWith(
				1,
				"git",
				["rev-parse", "main"],
				{ cwd: repoRoot, encoding: "utf8" },
				expect.any(Function),
			);
			expect(mockExecFile).toHaveBeenNthCalledWith(
				2,
				"git",
				expect.arrayContaining(["worktree", "add", feature.worktreePath]),
				expect.objectContaining({ cwd: repoRoot, encoding: "utf8" }),
				expect.any(Function),
			);
			expect(feature.provisioning?.state).toBe("ready");
		});

		it("persists completion when the storage watcher reloads between Git steps", async () => {
			const asyncManager = new FeatureManager(
				store,
				repoRoot,
				path.join(repoRoot, ".worktrees"),
				{ baseBranch: "main" },
			);
			mockExecFile.mockImplementation(((
				_file: string,
				_args: readonly string[],
				_options: unknown,
				callback: (
					error: Error | null,
					result?: { stdout: string; stderr: string },
				) => void,
			) => {
				// This is what the global-storage watcher does after each atomic save.
				asyncManager.reload();
				callback(null, { stdout: "abc123\n", stderr: "" });
			}) as never);

			const feature = asyncManager.createFeatureRecord("reload-safe", "shared");
			const provisioning = asyncManager.provisionFeature(feature.id);
			expect(asyncManager.isProvisioningActive(feature.id)).toBe(true);
			await expect(provisioning).resolves.toBeDefined();

			const persisted = store.loadFeatures()[0];
			expect(persisted.createdFromSha).toBe("abc123");
			expect(persisted.provisioning).toMatchObject({
				state: "ready",
				steps: [{ status: "completed" }, { status: "completed" }],
			});
			expect(asyncManager.isProvisioningActive(feature.id)).toBe(false);
		});

		it("recovers an orphaned setup only from an exact registered worktree", () => {
			const worktreePath = path.join(repoRoot, ".worktrees", "feat-recovered");
			store.saveFeatures([
				{
					id: "recovered",
					name: "recovered",
					branch: "feat/recovered",
					worktreePath,
					status: "active",
					color: "terminal.ansiBlue",
					isolation: "shared",
					createdAt: new Date(0).toISOString(),
					provisioning: {
						state: "provisioning",
						steps: [
							{
								id: "resolve-base",
								label: "Preparing feature",
								status: "running",
							},
							{
								id: "create-worktree",
								label: "Creating branch and worktree",
								status: "pending",
							},
						],
					},
				},
			]);
			mockExecSync.mockReturnValue(
				`worktree ${worktreePath}\nHEAD ${"c".repeat(40)}\nbranch refs/heads/feat/recovered\n\n`,
			);

			const recovered = new FeatureManager(
				store,
				repoRoot,
				path.join(repoRoot, ".worktrees"),
				{ baseBranch: "main" },
			);

			expect(store.loadFeatures()[0].provisioning).toMatchObject({
				state: "ready",
				steps: [{ status: "completed" }, { status: "completed" }],
			});
			expect(store.loadFeatures()[0].createdFromSha).toBeUndefined();
			expect(recovered.isProvisioningActive("recovered")).toBe(false);
			expect(mockExecSync).toHaveBeenCalledTimes(1);
			expect(mockExecSync).toHaveBeenNthCalledWith(
				1,
				"git worktree list --porcelain",
				expect.objectContaining({ cwd: repoRoot }),
			);
			expect(
				mockExecSync.mock.calls.some(([command]) =>
					String(command).includes("worktree add"),
				),
			).toBe(false);
		});

		it.each([
			{
				name: "the branch is registered at another path",
				output: `worktree /other/path\nHEAD ${"d".repeat(40)}\nbranch refs/heads/feat/orphaned\n\n`,
			},
			{
				name: "the expected worktree is detached",
				output: `worktree ${path.join(repoRoot, ".worktrees", "feat-orphaned")}\nHEAD ${"d".repeat(40)}\ndetached\n\n`,
			},
			{
				name: "Git observation is unavailable",
				output: "__THROW__",
			},
		])("keeps orphaned setup unknown when $name", ({ output }) => {
			const caseStore = new Store(path.join(tmpDir, crypto.randomUUID()));
			const worktreePath = path.join(repoRoot, ".worktrees", "feat-orphaned");
			caseStore.saveFeatures([
				{
					id: "orphaned",
					name: "orphaned",
					branch: "feat/orphaned",
					worktreePath,
					status: "active",
					color: "terminal.ansiBlue",
					isolation: "shared",
					createdAt: new Date(0).toISOString(),
					provisioning: {
						state: "provisioning",
						steps: [
							{
								id: "resolve-base",
								label: "Preparing feature",
								status: "running",
							},
							{
								id: "create-worktree",
								label: "Creating branch and worktree",
								status: "pending",
							},
						],
					},
				},
			]);
			if (output === "__THROW__") {
				mockExecSync.mockImplementation(() => {
					throw new Error("Git unavailable");
				});
			} else {
				mockExecSync.mockReturnValue(output);
			}

			const orphaned = new FeatureManager(
				caseStore,
				repoRoot,
				path.join(repoRoot, ".worktrees"),
				{ baseBranch: "main" },
			);

			expect(caseStore.loadFeatures()[0].provisioning?.state).toBe(
				"provisioning",
			);
			expect(orphaned.isProvisioningActive("orphaned")).toBe(false);
			expect(
				mockExecSync.mock.calls.some(([command]) =>
					String(command).includes("worktree add"),
				),
			).toBe(false);
		});

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

	describe("inspectFeatureLifecycle", () => {
		function saveFeature(worktreePath: string, branch = "feat/example") {
			store.saveFeatures([
				{
					id: "feature-1",
					name: "example",
					branch,
					worktreePath,
					status: "active",
					color: "terminal.ansiBlue",
					isolation: "shared",
					createdAt: new Date(0).toISOString(),
				},
			]);
			manager.reload();
		}

		it("reports a missing worktree without mutating metadata", () => {
			saveFeature(path.join(tmpDir, "missing"));

			expect(manager.inspectFeatureLifecycle()).toEqual([
				expect.objectContaining({ status: "missing_worktree" }),
			]);
			expect(store.loadFeatures()[0].branch).toBe("feat/example");
		});

		it("reports a branch mismatch", () => {
			const worktreePath = path.join(tmpDir, "mismatch");
			fs.mkdirSync(worktreePath);
			saveFeature(worktreePath);
			mockExecSync.mockImplementation((command) =>
				command.includes("rev-parse")
					? Buffer.from("true\n")
					: Buffer.from("fix/actual\n"),
			);

			expect(manager.inspectFeatureLifecycle()[0]).toMatchObject({
				status: "branch_mismatch",
				actualBranch: "fix/actual",
			});
		});

		it("reports detached HEAD when Git has no symbolic branch", () => {
			const worktreePath = path.join(tmpDir, "detached");
			fs.mkdirSync(worktreePath);
			saveFeature(worktreePath);
			mockExecSync.mockImplementation((command) => {
				if (command.includes("rev-parse")) return Buffer.from("true\n");
				throw new Error("detached");
			});

			expect(manager.inspectFeatureLifecycle()[0]).toMatchObject({
				status: "detached_head",
			});
		});

		it("reports a valid worktree explicitly", () => {
			const worktreePath = path.join(tmpDir, "valid");
			fs.mkdirSync(worktreePath);
			saveFeature(worktreePath);
			mockExecSync.mockImplementation((command) =>
				command.includes("rev-parse")
					? Buffer.from("true\n")
					: Buffer.from("feat/example\n"),
			);

			expect(manager.inspectFeatureLifecycle()[0]).toMatchObject({
				status: "valid",
				actualBranch: "feat/example",
			});
		});

		it("reports generic Git failure as unknown", () => {
			const worktreePath = path.join(tmpDir, "invalid");
			fs.mkdirSync(worktreePath);
			saveFeature(worktreePath);
			mockExecSync.mockImplementation(() => {
				throw new Error("git unavailable");
			});

			expect(manager.inspectFeatureLifecycle()[0]).toMatchObject({
				status: "git_state_unknown",
			});
		});
	});

	describe("deleteFeature", () => {
		it("can remove the worktree while preserving records for a resumable finish", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = manager.createFeature("resumable", "shared");
			mockCleanMergedDeletion();

			expect(manager.removeFeatureWorktreeForFinish(feature.id)).toMatchObject({
				deleted: true,
			});
			expect(manager.getFeature(feature.id)).toBeDefined();
			expect(store.loadFeatures()).toHaveLength(1);

			manager.forgetFinishedFeature(feature.id);
			expect(manager.getFeature(feature.id)).toBeUndefined();
		});

		it("removes feature and worktree", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = manager.createFeature("to-delete", "shared");

			mockCleanMergedDeletion();
			manager.deleteFeature(feature.id);

			expect(manager.getFeatures()).toHaveLength(0);
			expect(mockExecSync).toHaveBeenCalledWith(
				expect.stringContaining("git worktree remove"),
				expect.any(Object),
			);
		});

		it("keeps the feature record when git refuses to remove the worktree", () => {
			// Real worktree base inside the tmp dir so fs.existsSync sees the
			// worktree still on disk after the (simulated) git failure.
			const fm = new FeatureManager(store, tmpDir, tmpDir, {
				baseBranch: "main",
			});
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = fm.createFeature("sticky", "shared");
			fs.mkdirSync(feature.worktreePath, { recursive: true });

			mockExecSync.mockReset();
			mockCleanMergedDeletion(() => {
				throw new Error("git worktree remove failed");
			});

			const result = fm.deleteFeature(feature.id);

			expect(result.deleted).toBe(false);
			expect(result.reasons.join("\n")).toContain("refused to remove worktree");
			// Fail-closed: the feature must remain visible so the worktree is
			// not orphaned into an invisible residue.
			expect(fm.getFeatures()).toHaveLength(1);
		});

		it("uses exact merged-PR evidence without weakening Git worktree protection", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = manager.createFeature("squash-merged", "shared");
			mockExecSync.mockReset();
			mockCleanSquashMergedDeletion();

			expect(
				manager.removeFeatureWorktreeForFinish(feature.id, {
					acceptedPullRequestHeadSha: featureSha,
				}),
			).toMatchObject({ deleted: true, reasons: [] });
			const removeCall = mockExecSync.mock.calls.find(([command]) =>
				String(command).includes("git worktree remove"),
			);
			expect(String(removeCall?.[0])).not.toContain("--force");
		});

		it("rejects stale merged-PR evidence when the working tree becomes dirty", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const feature = manager.createFeature("dirty-after-review", "shared");
			mockExecSync.mockReset();
			mockCleanSquashMergedDeletion();
			mockExecSync.mockImplementation((command: string) => {
				const value = String(command);
				if (value.includes("symbolic-ref")) return `${feature.branch}\n`;
				if (value.includes("git status --porcelain")) return " M changed.ts";
				if (value.includes('rev-parse --verify "feat/')) return featureSha;
				if (value.includes('rev-parse --verify "main')) return baseSha;
				if (value.includes("merge-base --is-ancestor")) {
					throw Object.assign(new Error("not ancestor"), { status: 1 });
				}
				if (value.includes("rev-list --count")) return "1";
				return "";
			});

			expect(() =>
				manager.removeFeatureWorktreeForFinish(feature.id, {
					acceptedPullRequestHeadSha: featureSha,
				}),
			).toThrow("no longer matches");
			expect(
				mockExecSync.mock.calls.some(([command]) =>
					String(command).includes("git worktree remove"),
				),
			).toBe(false);
		});
	});

		describe("removeWorktreeResidue", () => {
		it("refuses a path outside worktreeBase", () => {
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fm-outside-"));
			try {
				const result = manager.removeWorktreeResidue(outside);

				expect(result.deleted).toBe(false);
				expect(result.reasons.join("\n")).toContain("outside base");
				expect(fs.existsSync(outside)).toBe(true);
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});

		it("refuses a path registered by Git", () => {
			const localManager = new FeatureManager(store, tmpDir, tmpDir, {
				baseBranch: "main",
			});
			const registered = path.join(tmpDir, "registered");
			fs.mkdirSync(registered);
			mockExecSync.mockReturnValue(`worktree ${registered}\n`);

			const result = localManager.removeWorktreeResidue(registered);

			expect(result.deleted).toBe(false);
			expect(result.reasons.join("\n")).toContain("registered by Git");
			expect(fs.existsSync(registered)).toBe(true);
		});

		it("removes an unregistered residue directory", () => {
			const localManager = new FeatureManager(store, tmpDir, tmpDir, {
				baseBranch: "main",
			});
			const residue = path.join(tmpDir, "residue");
			fs.mkdirSync(residue);
			fs.writeFileSync(path.join(residue, "untracked.txt"), "work");
			mockExecSync.mockReturnValue(`worktree ${path.join(tmpDir, "other")}\n`);

			const result = localManager.removeWorktreeResidue(residue);

			expect(result).toEqual({ deleted: true, reasons: [] });
			expect(fs.existsSync(residue)).toBe(false);
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
		function unconfiguredManager() {
			return new FeatureManager(
				store,
				repoRoot,
				path.join(repoRoot, ".worktrees"),
			);
		}

		it("returns a feature with base:<projectId> id", () => {
			const projectId = "test-project-123";
			mockExecSync.mockReturnValue("main\n");
			const base = unconfiguredManager().getBaseFeature(projectId);
			expect(base.id).toBe(`base:${projectId}`);
			expect(base.branch).toBe("main");
			expect(base.worktreePath).toBe(repoRoot);
			expect(base.status).toBe("active");
			expect(base.isolation).toBe("shared");
		});

		it("caches the git branch result", () => {
			mockExecSync.mockReturnValue("develop\n");
			const unconfigured = unconfiguredManager();
			const base1 = unconfigured.getBaseFeature("p1");
			const base2 = unconfigured.getBaseFeature("p2");
			expect(base1.branch).toBe("develop");
			expect(base2.branch).toBe("develop");
			// execSync should only be called once for branch detection
			expect(mockExecSync).toHaveBeenCalledTimes(1);
		});

		it("keeps the synthetic base observable without inventing a branch", () => {
			mockExecSync.mockImplementation(() => {
				throw new Error("not a git repo");
			});
			expect(unconfiguredManager().getBaseFeature("p1").branch).toBe(
				"(unknown base)",
			);
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

		it("does not invent main when the base branch cannot be observed", () => {
			mockExecSync.mockImplementation(() => {
				throw new Error("git unavailable");
			});
			const fm = configManager({});

			expect(() => fm.getBaseBranchName()).toThrow(
				"Unable to determine the project base branch",
			);
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
			const fm = configManager({ baseBranch: "main" });
			const feature = fm.createFeature("READ-891", "shared", "fix");
			expect(feature.branch).toBe("fix/READ-891");
		});

		it("uses defaultBranchKind when no kind is passed", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({
				baseBranch: "main",
				defaultBranchKind: "feature",
			});
			const feature = fm.createFeature("READ-891", "shared");
			expect(feature.branch).toBe("feature/READ-891");
		});

		it("throws on delete when the worktree has uncommitted changes", () => {
			// base branch detection → clean
			mockExecSync.mockReturnValueOnce("");
			// createFeature worktree add
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({ baseBranch: "main" });
			const feature = fm.createFeature("dirty-one", "shared", "feature");

			mockExecSync.mockReset();
			// deletion safety: observe the linked checkout, then its dirty status.
			mockExecSync.mockImplementation((command: string) =>
				String(command).includes("symbolic-ref")
					? `${feature.branch}\n`
					: " M x.ts\n",
			);

			expect(() => fm.deleteFeature(feature.id)).toThrow("Uncommitted changes");
		});

		it("deletes clean features without --force", () => {
			mockExecSync.mockReturnValue(Buffer.from(""));
			const fm = configManager({ baseBranch: "main" });
			const feature = fm.createFeature("clean-one", "shared", "feature");

			mockExecSync.mockReset();
			mockCleanMergedDeletion();

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
