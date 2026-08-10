import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { FeatureManager } from "../features/featureManager";
import { Store } from "../storage/store";

const mockExecSync = vi.mocked(execSync);

describe("FeatureManager worktree branch reconciliation", () => {
	let tmpDir: string;
	let store: Store;
	let manager: FeatureManager;

	const repoRoot = "/fake/repo";
	const worktreeBase = path.join(repoRoot, ".worktrees");

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-branch-sync-"));
		store = new Store(tmpDir);
		manager = new FeatureManager(store, repoRoot, worktreeBase, {
			baseBranch: "v2_ia_first",
			defaultBranchKind: "feature",
		});
		mockExecSync.mockReset();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function createEndingFeature() {
		mockExecSync.mockReturnValueOnce("");
		return manager.createFeature("1066_ending", "shared", "feature");
	}

	it("reconciles a feature renamed outside Agent Space from the worktree HEAD", () => {
		const feature = createEndingFeature();
		mockExecSync.mockReset();
		mockExecSync.mockReturnValue("feature/1066_closure\n");

		const resolved = manager.getFeature(feature.id);

		expect(resolved?.branch).toBe("feature/1066_closure");
		expect(store.loadFeatures()[0].branch).toBe("feature/1066_closure");
		expect(mockExecSync).toHaveBeenCalledWith(
			"git symbolic-ref --quiet --short HEAD",
			expect.objectContaining({ cwd: feature.worktreePath }),
		);
	});

	it("keeps the persisted branch when the worktree branch cannot be resolved", () => {
		const feature = createEndingFeature();
		mockExecSync.mockReset();
		mockExecSync.mockImplementation(() => {
			throw new Error("detached or missing worktree");
		});

		const resolved = manager.getFeature(feature.id);

		expect(resolved?.branch).toBe("feature/1066_ending");
		expect(store.loadFeatures()[0].branch).toBe("feature/1066_ending");
	});
});
