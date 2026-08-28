import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../storage/store";
import type { Agent, Feature, Service } from "../types";

describe("Store", () => {
	let tmpDir: string;
	let store: Store;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-test-"));
		store = new Store(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("features", () => {
		const feature: Feature = {
			id: "f1",
			name: "auth",
			branch: "feat/auth",
			worktreePath: ".worktrees/auth",
			status: "active",
			color: "terminal.ansiBlue",
			isolation: "shared",
			createdAt: "2026-03-04T00:00:00Z",
		};

		it("saves and loads features", () => {
			store.saveFeatures([feature]);
			const loaded = store.loadFeatures();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].name).toBe("auth");
		});

		it("returns empty array when no file exists", () => {
			expect(store.loadFeatures()).toEqual([]);
		});

		it("creates directories if missing", () => {
			const deepDir = path.join(tmpDir, "deep", "nested");
			const deepStore = new Store(deepDir);
			deepStore.saveFeatures([feature]);
			expect(deepStore.loadFeatures()).toHaveLength(1);
		});
	});

	describe("agents", () => {
		const agent: Agent = {
			id: "a1",
			featureId: "f1",
			name: "Setup JWT",
			sessionId: null,
			status: "stopped",
			createdAt: "2026-03-04T00:00:00Z",
		};

		it("saves and loads agents for a feature", () => {
			store.saveAgents("f1", [agent]);
			const loaded = store.loadAgents("f1");
			expect(loaded).toHaveLength(1);
			expect(loaded[0].name).toBe("Setup JWT");
		});

		it("returns empty array when no agents file exists", () => {
			expect(store.loadAgents("nonexistent")).toEqual([]);
		});
	});

	describe("deleteFeatureData", () => {
		it("removes feature agent directory", () => {
			const agent: Agent = {
				id: "a1",
				featureId: "f1",
				name: "test",
				sessionId: null,
				status: "stopped",
				createdAt: "2026-03-04T00:00:00Z",
			};
			store.saveAgents("f1", [agent]);
			store.deleteFeatureData("f1");
			expect(store.loadAgents("f1")).toEqual([]);
		});

		it("also removes the review inbox", () => {
			store.saveReviewInbox("f1", { a1: "review-1" });
			store.deleteFeatureData("f1");
			expect(store.loadReviewInbox("f1")).toEqual({});
		});
	});

	describe("review inbox", () => {
		it("returns an empty map when no file exists", () => {
			expect(store.loadReviewInbox("f1")).toEqual({});
		});

		it("round-trips receipts through save and load", () => {
			store.saveReviewInbox("f1", { a1: "review-1", a2: "review-2" });
			expect(store.loadReviewInbox("f1")).toEqual({
				a1: "review-1",
				a2: "review-2",
			});
		});

		it("writes to a dedicated file, never into agents.json", () => {
			const agent: Agent = {
				id: "a1",
				featureId: "f1",
				name: "test",
				sessionId: null,
				status: "stopped",
				createdAt: "2026-03-04T00:00:00Z",
			};
			store.saveAgents("f1", [agent]);
			store.saveReviewInbox("f1", { a1: "review-1" });

			const rawAgents = fs.readFileSync(
				path.join(tmpDir, "features", "f1", "agents.json"),
				"utf-8",
			);
			expect(rawAgents).not.toContain("pendingReviewId");
			expect(
				fs.existsSync(path.join(tmpDir, "features", "f1", "review-inbox.json")),
			).toBe(true);
		});
	});
});

describe("Store — services", () => {
	let tmpDir: string;
	let store: Store;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-svc-test-"));
		store = new Store(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when no services file exists", () => {
		expect(store.loadServices("f1")).toEqual([]);
	});

	it("round-trips services through save and load", () => {
		const services: Service[] = [
			{
				id: "s1",
				featureId: "f1",
				name: "dev",
				command: "npm run dev",
				tmuxSession: "agent-space-svc-f1-s1",
				status: "running",
				createdAt: "2026-03-05T00:00:00Z",
			},
		];
		store.saveServices("f1", services);
		expect(store.loadServices("f1")).toEqual(services);
	});

	it("overwrites previous services on save", () => {
		store.saveServices("f1", [
			{
				id: "s1",
				featureId: "f1",
				name: "dev",
				command: "npm run dev",
				tmuxSession: "agent-space-svc-f1-s1",
				status: "running",
				createdAt: "2026-03-05T00:00:00Z",
			},
		]);
		store.saveServices("f1", []);
		expect(store.loadServices("f1")).toEqual([]);
	});
});
