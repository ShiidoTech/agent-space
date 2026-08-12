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

	it("does not replace the primary branch after an unrelated checkout", () => {
		const feature = createEndingFeature();
		mockExecSync.mockReset();
		mockExecSync.mockReturnValue("feature/1066_closure\n");

		const resolved = manager.getFeature(feature.id);

		expect(resolved?.branch).toBe("feature/1066_ending");
		expect(resolved?.primaryBranchRef).toBe("feature/1066_ending");
		expect(store.loadFeatures()[0]).toMatchObject({
			branch: "feature/1066_ending",
			primaryBranchRef: "feature/1066_ending",
		});
		expect(manager.getFeatureBranchState(feature.id)).toMatchObject({
			primary: "feature/1066_ending",
			checkout: {
				status: "known",
				ref: "feature/1066_closure",
				linked: false,
			},
		});
		expect(mockExecSync).toHaveBeenCalledWith(
			"git symbolic-ref --quiet --short HEAD",
			expect.objectContaining({ cwd: feature.worktreePath }),
		);
	});

	it("links a continuation only when reflog and ancestry both prove it", () => {
		const feature = createEndingFeature();
		const primarySha = "a".repeat(40);
		const continuationSha = "b".repeat(40);
		mockExecSync.mockReset();
		mockExecSync.mockImplementation((command) => {
			const value = String(command);
			if (value.includes("symbolic-ref")) return "feature/1066_closure\n";
			if (value.includes("reflog")) {
				return "checkout: moving from feature/1066_ending to feature/1066_closure\n";
			}
			if (value.includes("refs/heads/feature/1066_ending")) return primarySha;
			if (value.includes("refs/heads/feature/1066_closure")) {
				return continuationSha;
			}
			if (value.includes("merge-base --is-ancestor")) return "";
			throw new Error(`Unexpected Git command: ${value}`);
		});

		const state = manager.getFeatureBranchState(feature.id);

		expect(state).toMatchObject({
			primary: "feature/1066_ending",
			checkout: {
				status: "known",
				ref: "feature/1066_closure",
				linked: true,
				role: "continuation",
			},
			links: [
				{ ref: "feature/1066_ending", role: "primary" },
				{
					ref: "feature/1066_closure",
					role: "continuation",
					source: "reflog_checkout",
					relation: {
						kind: "descends_from",
						ref: "feature/1066_ending",
					},
				},
			],
		});
		expect(store.loadFeatures()[0].branch).toBe("feature/1066_closure");
	});

	it("recovers an overwritten legacy primary from strong local and upstream proof", () => {
		const primarySha = "c".repeat(40);
		const continuationSha = "d".repeat(40);
		store.saveFeatures([
			{
				id: "audit",
				name: "audit_and_go",
				branch: "feat/feature_cockpit",
				worktreePath: path.join(worktreeBase, "feat-audit_and_go"),
				status: "active",
				color: "terminal.ansiGreen",
				isolation: "shared",
				createdAt: "2026-08-12T06:06:12.744Z",
			},
		]);
		manager.reload();
		mockExecSync.mockReset();
		mockExecSync.mockImplementation((command) => {
			const value = String(command);
			if (value.includes("symbolic-ref")) return "feat/feature_cockpit\n";
			if (value.includes("reflog")) {
				return [
					"commit: feat: turn feature page into a control cockpit",
					"checkout: moving from feat/audit_and_go to feat/feature_cockpit",
				].join("\n");
			}
			if (value.includes("refs/heads/feat/audit_and_go")) return primarySha;
			if (value.includes("refs/heads/feat/feature_cockpit")) {
				return continuationSha;
			}
			if (value.includes('"feat/audit_and_go@{upstream}^{commit}"')) {
				return primarySha;
			}
			if (value.includes("merge-base --is-ancestor")) return "";
			throw new Error(`Unexpected Git command: ${value}`);
		});

		const state = manager.getFeatureBranchState("audit");

		expect(state).toMatchObject({
			primary: "feat/audit_and_go",
			checkout: {
				status: "known",
				ref: "feat/feature_cockpit",
				linked: true,
				role: "continuation",
			},
		});
		expect(store.loadFeatures()[0]).toMatchObject({
			name: "audit_and_go",
			branch: "feat/feature_cockpit",
			primaryBranchRef: "feat/audit_and_go",
			branchLinks: [
				{
					ref: "feat/audit_and_go",
					role: "primary",
					source: "reflog_checkout",
				},
				{
					ref: "feat/feature_cockpit",
					role: "continuation",
					source: "reflog_checkout",
					relation: { kind: "descends_from", ref: "feat/audit_and_go" },
				},
			],
		});
	});

	it.each(["upstream missing", "ancestry missing", "name mismatch"] as const)(
		"does not guess legacy recovery when %s",
		(missingProof) => {
			const prior =
				missingProof === "name mismatch"
					? "feat/unrelated"
					: "feat/audit_and_go";
			const primarySha = "e".repeat(40);
			const continuationSha = "f".repeat(40);
			store.saveFeatures([
				{
					id: "audit",
					name: "audit_and_go",
					branch: "feat/feature_cockpit",
					worktreePath: path.join(worktreeBase, "feat-audit_and_go"),
					status: "active",
					color: "terminal.ansiGreen",
					isolation: "shared",
					createdAt: "2026-08-12T06:06:12.744Z",
				},
			]);
			manager.reload();
			mockExecSync.mockReset();
			mockExecSync.mockImplementation((command) => {
				const value = String(command);
				if (value.includes("symbolic-ref")) return "feat/feature_cockpit\n";
				if (value.includes("reflog")) {
					return `checkout: moving from ${prior} to feat/feature_cockpit\n`;
				}
				if (value.includes(`refs/heads/${prior}`)) return primarySha;
				if (value.includes("refs/heads/feat/feature_cockpit")) {
					return continuationSha;
				}
				if (value.includes("@{upstream}")) {
					if (missingProof === "upstream missing")
						throw new Error("no upstream");
					return primarySha;
				}
				if (value.includes("merge-base --is-ancestor")) {
					if (missingProof === "ancestry missing")
						throw new Error("not ancestor");
					return "";
				}
				throw new Error(`Unexpected Git command: ${value}`);
			});

			manager.getFeature("audit");

			expect(store.loadFeatures()[0]).toMatchObject({
				branch: "feat/feature_cockpit",
				primaryBranchRef: "feat/feature_cockpit",
				branchLinks: [
					{
						ref: "feat/feature_cockpit",
						role: "primary",
						source: "legacy_record",
					},
				],
			});
		},
	);

	it("keeps the persisted branch when the worktree branch cannot be resolved", () => {
		const feature = createEndingFeature();
		mockExecSync.mockReset();
		mockExecSync.mockImplementation(() => {
			throw new Error("detached or missing worktree");
		});

		const resolved = manager.getFeature(feature.id);

		expect(resolved?.branch).toBe("feature/1066_ending");
		expect(store.loadFeatures()[0].branch).toBe("feature/1066_ending");
		expect(store.loadFeatures()[0].primaryBranchRef).toBe(
			"feature/1066_ending",
		);
		expect(store.loadFeatures()[0].branchLinks).toMatchObject([
			{ ref: "feature/1066_ending", role: "primary" },
		]);
	});
});
