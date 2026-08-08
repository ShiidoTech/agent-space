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
