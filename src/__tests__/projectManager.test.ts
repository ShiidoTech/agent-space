import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../projects/projectManager";
import { GlobalStore } from "../storage/globalStore";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

describe("ProjectManager", () => {
	let globalStore: GlobalStore;
	let manager: ProjectManager;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-"));
		globalStore = new GlobalStore(tmpDir);
		manager = new ProjectManager(globalStore, tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("addProject", () => {
		it("adds a project and persists to GlobalStore", () => {
			const project = manager.addProject("/fake/repo");
			expect(project.repoPath).toBe("/fake/repo");
			expect(project.name).toBe("repo");
			expect(project.id).toBeTruthy();
			expect(manager.getProjects()).toHaveLength(1);
		});

		it("uses custom name when provided", () => {
			const project = manager.addProject("/fake/repo", "My Repo");
			expect(project.name).toBe("My Repo");
		});

		it("rejects duplicate repo paths", () => {
			manager.addProject("/fake/repo");
			expect(() => manager.addProject("/fake/repo")).toThrow(
				"already registered",
			);
		});

		it("fires onChange callback", () => {
			const cb = vi.fn();
			manager.onChange(cb);
			manager.addProject("/fake/repo");
			expect(cb).toHaveBeenCalledOnce();
		});
	});

	describe("removeProject", () => {
		it("removes a project from the registry", () => {
			const project = manager.addProject("/fake/repo");
			manager.removeProject(project.id);
			expect(manager.getProjects()).toHaveLength(0);
		});

		it("fires onChange callback", () => {
			const project = manager.addProject("/fake/repo");
			const cb = vi.fn();
			manager.onChange(cb);
			manager.removeProject(project.id);
			expect(cb).toHaveBeenCalledOnce();
		});
	});

	describe("getContext", () => {
		it("returns context for a registered project", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.getContext(project.id);
			expect(ctx).toBeDefined();
			expect(ctx?.project.repoPath).toBe(tmpDir);
			expect(ctx?.featureManager).toBeDefined();
			expect(ctx?.agentManager).toBeDefined();
		});

		it("includes serviceManager in context", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.getContext(project.id);
			expect(ctx).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			expect(ctx!.serviceManager).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			expect(typeof ctx!.serviceManager.getServices).toBe("function");
		});

		it("returns undefined for unknown project", () => {
			expect(manager.getContext("no-such-id")).toBeUndefined();
		});

		it("caches contexts", () => {
			const project = manager.addProject(tmpDir);
			const ctx1 = manager.getContext(project.id);
			const ctx2 = manager.getContext(project.id);
			expect(ctx1).toBe(ctx2);
		});
	});

	describe("updateProjectConfig", () => {
		it("persists repository conventions and refreshes the context", () => {
			const project = manager.addProject(tmpDir);
			const context = manager.getContext(project.id);
			expect(context).toBeDefined();

			manager.updateProjectConfig(project.id, {
				baseBranch: "develop",
				branchKinds: ["feature", "fix"],
			});

			expect(context?.config.baseBranch).toBe("develop");
			expect(context?.featureManager.getBaseBranchName()).toBe("develop");
			expect(
				JSON.parse(
					fs.readFileSync(
						path.join(tmpDir, ".agentspace", "config.json"),
						"utf-8",
					),
				),
			).toMatchObject({
				baseBranch: "develop",
				branchKinds: ["feature", "fix"],
			});
		});
	});

	describe("getAllContexts", () => {
		it("returns contexts for all projects", () => {
			const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-2-"));
			try {
				manager.addProject(tmpDir);
				manager.addProject(dir2);
				const contexts = manager.getAllContexts();
				expect(contexts).toHaveLength(2);
			} finally {
				fs.rmSync(dir2, { recursive: true, force: true });
			}
		});
	});

	describe("findContextByFeatureId", () => {
		it("returns undefined when no features exist", () => {
			manager.addProject(tmpDir);
			expect(manager.findContextByFeatureId("no-such-feature")).toBeUndefined();
		});

		it("resolves base:<projectId> to the correct project context", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.findContextByFeatureId(`base:${project.id}`);
			expect(ctx).toBeDefined();
			expect(ctx?.project.id).toBe(project.id);
		});

		it("returns undefined for base: prefix with unknown project id", () => {
			manager.addProject(tmpDir);
			expect(
				manager.findContextByFeatureId("base:nonexistent"),
			).toBeUndefined();
		});
	});

	describe("findContextByFeatureIdFast", () => {
		it("resolves base:<projectId> without touching featureManager.getFeature", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.findContextByFeatureIdFast(`base:${project.id}`);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			const getFeatureSpy = vi.spyOn(ctx!.featureManager, "getFeature");

			expect(ctx?.project.id).toBe(project.id);
			expect(getFeatureSpy).not.toHaveBeenCalled();
		});

		it("returns undefined for an unknown feature id, without a Git-reconciling call", () => {
			const project = manager.addProject(tmpDir);
			const getFeatureSpy = vi.spyOn(
				// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
				manager.getContext(project.id)!.featureManager,
				"getFeature",
			);

			expect(
				manager.findContextByFeatureIdFast("no-such-feature"),
			).toBeUndefined();
			expect(getFeatureSpy).not.toHaveBeenCalled();
		});

		it("resolves a real feature via the cached list, never via the Git-reconciling getFeature", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.getContext(project.id);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			const feature = ctx!.featureManager.createFeatureRecord(
				"Fast Lookup",
				"shared",
			);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			const getFeatureSpy = vi.spyOn(ctx!.featureManager, "getFeature");

			const resolved = manager.findContextByFeatureIdFast(feature.id);

			expect(resolved?.project.id).toBe(project.id);
			expect(getFeatureSpy).not.toHaveBeenCalled();

			// Second lookup reuses the now-populated reverse index and still
			// never calls the Git-reconciling accessor.
			manager.findContextByFeatureIdFast(feature.id);
			expect(getFeatureSpy).not.toHaveBeenCalled();
		});
	});

	describe("peekWarmContext (issue #120 PR2, review round 4)", () => {
		it("resolves base:<projectId> when the project's context is already warm, without reading projects.json", () => {
			const project = manager.addProject(tmpDir);
			manager.getContext(project.id); // warms the context, as a render pass would

			const getProjectsSpy = vi.spyOn(globalStore, "getProjects");
			const resolved = manager.peekWarmContext(`base:${project.id}`);

			expect(resolved?.project.id).toBe(project.id);
			expect(getProjectsSpy).not.toHaveBeenCalled();
		});

		it("returns undefined for a cold context, without ever constructing one or reading projects.json", () => {
			manager.addProject(tmpDir);
			// Deliberately never call getContext/getAllContexts: the project
			// exists on disk, but nothing has warmed it in this process yet.
			const getProjectsSpy = vi.spyOn(globalStore, "getProjects");

			expect(manager.peekWarmContext(`base:${tmpDir}`)).toBeUndefined();
			expect(getProjectsSpy).not.toHaveBeenCalled();
		});

		it("resolves a regular feature once its reverse-index entry is warm, without reading projects.json", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.getContext(project.id);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			const feature = ctx!.featureManager.createFeatureRecord(
				"Peek Lookup",
				"shared",
			);
			// A render pass (findContextByFeatureIdFast/resolveFeature) would
			// normally have primed this already; do it explicitly here.
			manager.findContextByFeatureIdFast(feature.id);

			const getProjectsSpy = vi.spyOn(globalStore, "getProjects");
			const resolved = manager.peekWarmContext(feature.id);

			expect(resolved?.project.id).toBe(project.id);
			expect(getProjectsSpy).not.toHaveBeenCalled();
		});

		it("returns undefined for an unknown feature id without reading projects.json", () => {
			manager.addProject(tmpDir);
			const getProjectsSpy = vi.spyOn(globalStore, "getProjects");

			expect(manager.peekWarmContext("no-such-feature")).toBeUndefined();
			expect(getProjectsSpy).not.toHaveBeenCalled();
		});
	});

	describe("AgentFocusService wiring: warm click stays disk-free end to end (issue #120 PR2, review round 4)", () => {
		it("a warm tracked terminal with a pending receipt reveals with zero project/store reads, then defers a matching compare-and-clear ack", async () => {
			vi.useFakeTimers();
			try {
				const project = manager.addProject(tmpDir);
				const ctx = manager.getContext(project.id);
				// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
				const feature = ctx!.featureManager.createFeatureRecord(
					"Wiring Check",
					"shared",
				);
				// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
				const agent = ctx!.agentManager.createAgent(feature);
				// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
				ctx!.agentManager.recordTurnCompleted(agent.id, feature.id, "review-1");
				// Prime the reverse index the way a render pass would.
				manager.findContextByFeatureIdFast(feature.id);

				const { AgentFocusService } = await import(
					"../agents/agentFocusService"
				);
				const show = vi.fn();
				const focusService = new AgentFocusService({
					getTerminalController: () =>
						({
							getTerminal: () => ({ show }),
							focusOrCreateTerminalAsync: vi.fn(),
						}) as never,
					resolveFeature: (id: string) => manager.resolveFeature(id),
					peekPendingReviewId: (featureId, agentId) =>
						manager
							.peekWarmContext(featureId)
							?.agentManager.peekPendingReviewId(featureId, agentId),
					acknowledgeReview: (featureId, agentId, expectedReviewId) => {
						manager
							.peekWarmContext(featureId)
							?.agentManager.acknowledgeReviewIfMatches(
								agentId,
								featureId,
								expectedReviewId,
							);
					},
				});

				const getProjectsSpy = vi.spyOn(globalStore, "getProjects");
				focusService.requestFocus(feature.id, agent.id);

				// The reveal itself never touched disk.
				expect(show).toHaveBeenCalledTimes(1);
				expect(getProjectsSpy).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(0);

				const refreshed =
					// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
					ctx!.agentManager.getAgents(feature.id)[0].pendingReviewId;
				expect(refreshed).toBeUndefined();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("resolveFeature", () => {
		it("resolves base:<projectId> to a base feature", () => {
			const project = manager.addProject(tmpDir);
			const resolved = manager.resolveFeature(`base:${project.id}`);
			expect(resolved).toBeDefined();
			expect(resolved?.feature.id).toBe(`base:${project.id}`);
			expect(resolved?.feature.worktreePath).toBe(tmpDir);
			expect(resolved?.ctx.project.id).toBe(project.id);
		});

		it("returns undefined for unknown feature id", () => {
			manager.addProject(tmpDir);
			expect(manager.resolveFeature("no-such-id")).toBeUndefined();
		});
	});

	describe("isBaseFeatureId", () => {
		it("returns true for base: prefix", () => {
			expect(ProjectManager.isBaseFeatureId("base:abc")).toBe(true);
		});

		it("returns false for regular feature ids", () => {
			expect(ProjectManager.isBaseFeatureId("some-uuid")).toBe(false);
		});
	});

	describe("handleExternalFileChange", () => {
		it("routes agents.json as structural (fail-safe default) and invalidates the agent cache", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.getContext(project.id);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			const invalidateSpy = vi.spyOn(ctx!.agentManager, "invalidateFeature");
			const cb = vi.fn();
			manager.onChange(cb);

			manager.handleExternalFileChange({
				fsPath: path.join(
					tmpDir,
					"projects",
					project.id,
					"features",
					"feat-1",
					"agents.json",
				),
			});

			expect(invalidateSpy).toHaveBeenCalledWith("feat-1");
			expect(cb).toHaveBeenCalledWith({
				projectId: project.id,
				featureId: "feat-1",
			});
			// Fail-safe default: no `structural: false` means a full rebuild.
			expect(cb.mock.calls[0][0].structural).toBeUndefined();
		});

		it("routes review-inbox.json as structural: false, without touching the agent cache (PR2 review round 2, blocker 2)", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.getContext(project.id);
			// biome-ignore lint/style/noNonNullAssertion: test assertion guarantees defined
			const invalidateSpy = vi.spyOn(ctx!.agentManager, "invalidateFeature");
			const cb = vi.fn();
			manager.onChange(cb);

			manager.handleExternalFileChange({
				fsPath: path.join(
					tmpDir,
					"projects",
					project.id,
					"features",
					"feat-1",
					"review-inbox.json",
				),
			});

			expect(invalidateSpy).not.toHaveBeenCalled();
			expect(cb).toHaveBeenCalledWith({
				projectId: project.id,
				featureId: "feat-1",
				structural: false,
			});
		});
	});

	describe("initializeContext uses storagePath", () => {
		it("stores data under storagePath/projects/<id>", () => {
			const project = manager.addProject(tmpDir);
			const ctx = manager.getContext(project.id);
			expect(ctx).toBeDefined();
			// Saving features should create the file under storagePath, not inside the repo
			ctx?.store.saveFeatures([]);
			const expectedFile = path.join(
				tmpDir,
				"projects",
				project.id,
				"features.json",
			);
			expect(fs.existsSync(expectedFile)).toBe(true);
			// Should NOT exist under the old repo-based path
			const oldFile = path.join(
				tmpDir,
				".claude",
				"companion",
				"features.json",
			);
			expect(fs.existsSync(oldFile)).toBe(false);
		});
	});
});
