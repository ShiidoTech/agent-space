import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(() => ""),
}));

import { execSync } from "node:child_process";
import { TmuxIntegration } from "../agents/tmux";
import { ServiceManager } from "../services/serviceManager";
import { Store } from "../storage/store";

describe("ServiceManager", () => {
	let tmpDir: string;
	let store: Store;
	let tmux: TmuxIntegration;
	let manager: ServiceManager;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-test-"));
		store = new Store(tmpDir);
		tmux = new TmuxIntegration();
		manager = new ServiceManager(store, "/repo", tmux);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("createService", () => {
		it("creates a service with correct fields", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			expect(svc.featureId).toBe("f1");
			expect(svc.name).toBe("dev");
			expect(svc.command).toBe("npm run dev");
			expect(svc.launchCommand).toBe("npm run dev");
			expect(svc.status).toBe("running");
			expect(svc.tmuxSession).toBe(`agent-space-svc-f1-${svc.id}`);
		});

		it("supports shell services without a launch command", () => {
			const svc = manager.createService(
				"f1",
				"Terminal",
				"Interactive shell",
				null,
			);
			expect(svc.command).toBe("Interactive shell");
			expect(svc.launchCommand).toBeNull();
		});

		it("persists to storage", () => {
			manager.createService("f1", "dev", "npm run dev");
			expect(store.loadServices("f1")).toHaveLength(1);
		});
	});

	describe("getServices", () => {
		it("returns services for a feature", () => {
			manager.createService("f1", "dev", "npm run dev");
			manager.createService("f1", "test", "npm run test");
			expect(manager.getServices("f1")).toHaveLength(2);
		});

		it("returns empty for unknown feature", () => {
			expect(manager.getServices("unknown")).toEqual([]);
		});

		it("normalizes legacy tmux session names on load", () => {
			store.saveServices("f1", [
				{
					id: "s1",
					featureId: "f1",
					name: "dev",
					command: "npm run dev",
					launchCommand: "npm run dev",
					tmuxSession: "companion-svc-f1-s1",
					status: "running",
					createdAt: "2026-03-05T00:00:00Z",
				},
			]);

			const adoptSpy = vi.spyOn(tmux, "adoptSession").mockReturnValue(true);

			expect(manager.getServices("f1")).toEqual([
				{
					id: "s1",
					featureId: "f1",
					name: "dev",
					command: "npm run dev",
					launchCommand: "npm run dev",
					tmuxSession: "agent-space-svc-f1-s1",
					status: "running",
					createdAt: "2026-03-05T00:00:00Z",
				},
			]);
			expect(adoptSpy).toHaveBeenCalledWith(
				"agent-space-svc-f1-s1",
				"companion-svc-f1-s1",
			);
			expect(store.loadServices("f1")[0]?.tmuxSession).toBe(
				"agent-space-svc-f1-s1",
			);
		});
	});

	describe("stopService", () => {
		it("updates status to stopped", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			manager.stopService(svc.id, "f1");
			const services = manager.getServices("f1");
			expect(services[0].status).toBe("stopped");
		});
	});

	describe("restartService", () => {
		it("restarts the tmux session and updates status to running", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			manager.stopService(svc.id, "f1");
			manager.restartService(svc.id, "f1", "/repo");
			const services = manager.getServices("f1");
			expect(services[0].status).toBe("running");
			expect(execSync).toHaveBeenCalledWith(
				`tmux new-session -d -s "${svc.tmuxSession}" "npm run dev"`,
				expect.objectContaining({ cwd: "/repo" }),
			);
		});

		it("restarts a shell service with a plain tmux session", () => {
			const svc = manager.createService(
				"f1",
				"Terminal",
				"Interactive shell",
				null,
			);
			manager.stopService(svc.id, "f1");
			manager.restartService(svc.id, "f1", "/repo");
			expect(execSync).toHaveBeenCalledWith(
				`tmux new-session -d -s "${svc.tmuxSession}"`,
				expect.objectContaining({ cwd: "/repo" }),
			);
		});
	});

	describe("deleteService", () => {
		it("removes service from storage", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			manager.deleteService(svc.id, "f1");
			expect(manager.getServices("f1")).toHaveLength(0);
		});
	});

	describe("deleteAllServices", () => {
		it("removes all services for a feature", () => {
			manager.createService("f1", "dev", "npm run dev");
			manager.createService("f1", "test", "npm run test");
			manager.deleteAllServices("f1");
			expect(manager.getServices("f1")).toHaveLength(0);
		});
	});

	describe("refreshStatuses", () => {
		it("refreshes stale state when services are read", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			vi.spyOn(tmux, "isSessionAlive").mockReturnValue(false);
			const services = manager.getServices("f1");
			expect(services.find((s) => s.id === svc.id)?.status).toBe("stopped");
		});

		it("marks service as stopped when tmux session is gone", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			vi.spyOn(tmux, "isSessionAlive").mockReturnValue(false);
			manager.refreshStatuses("f1");
			const services = manager.getServices("f1");
			expect(services.find((s) => s.id === svc.id)?.status).toBe("stopped");
		});

		it("keeps service as running when tmux session and pane are alive", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			vi.spyOn(tmux, "isSessionAlive").mockReturnValue(true);
			vi.spyOn(tmux, "getPaneStatus").mockReturnValue({
				dead: false,
				exitCode: 0,
			});
			manager.refreshStatuses("f1");
			const services = manager.getServices("f1");
			expect(services.find((s) => s.id === svc.id)?.status).toBe("running");
		});

		it("marks service as errored when pane exited with non-zero code", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			vi.spyOn(tmux, "isSessionAlive").mockReturnValue(true);
			vi.spyOn(tmux, "getPaneStatus").mockReturnValue({
				dead: true,
				exitCode: 1,
			});
			manager.refreshStatuses("f1");
			const services = manager.getServices("f1");
			expect(services.find((s) => s.id === svc.id)?.status).toBe("errored");
		});

		it("marks service as stopped when pane exited with code 0", () => {
			const svc = manager.createService("f1", "dev", "npm run dev");
			vi.spyOn(tmux, "isSessionAlive").mockReturnValue(true);
			vi.spyOn(tmux, "getPaneStatus").mockReturnValue({
				dead: true,
				exitCode: 0,
			});
			manager.refreshStatuses("f1");
			const services = manager.getServices("f1");
			expect(services.find((s) => s.id === svc.id)?.status).toBe("stopped");
		});

		it("skips refresh when called within 5s TTL", () => {
			manager.createService("f1", "dev", "npm run dev");
			const aliveSpy = vi.spyOn(tmux, "isSessionAlive").mockReturnValue(true);
			vi.spyOn(tmux, "getPaneStatus").mockReturnValue({
				dead: false,
				exitCode: 0,
			});

			// First call — should invoke tmux
			manager.refreshStatuses("f1");
			const firstCallCount = aliveSpy.mock.calls.length;
			expect(firstCallCount).toBeGreaterThan(0);

			// Second call within TTL — should skip tmux
			manager.refreshStatuses("f1");
			expect(aliveSpy.mock.calls.length).toBe(firstCallCount);
		});

		it("refreshes again after invalidateFeature clears TTL", () => {
			manager.createService("f1", "dev", "npm run dev");
			const aliveSpy = vi.spyOn(tmux, "isSessionAlive").mockReturnValue(true);
			vi.spyOn(tmux, "getPaneStatus").mockReturnValue({
				dead: false,
				exitCode: 0,
			});

			manager.refreshStatuses("f1");
			const firstCallCount = aliveSpy.mock.calls.length;

			manager.invalidateFeature("f1");

			manager.refreshStatuses("f1");
			expect(aliveSpy.mock.calls.length).toBeGreaterThan(firstCallCount);
		});
	});
});
