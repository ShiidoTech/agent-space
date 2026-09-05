import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { probeAgents } from "../diagnostics/doctorCommand";
import { Store } from "../storage/store";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

describe("doctor agent probing", () => {
	it("includes agents persisted under the runtime's synthetic base feature", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-command-"));
		const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-store-"));
		try {
			const project = {
				id: "project-1",
				name: "agent-space",
				repoPath: root,
			};
			const store = new Store(path.join(storagePath, "projects", project.id));
			store.saveAgents(`base:${project.id}`, [
				{
					id: "agent-base",
					featureId: `base:${project.id}`,
					name: "Agent 1",
					sessionId: "session-base",
					toolId: "stub",
					status: "running",
					hasStarted: true,
					createdAt: "2026-08-09T07:00:00.000Z",
				},
			]);

			const result = probeAgents(storagePath, [project], {
				getUnknownProjectAgentIds: () => [],
				getStructuredAttentionSignal: () => undefined,
				describeAgentToolForAgent: () => ({
					declared: true,
					tool: { id: "stub", name: "Stub", command: "stub" },
					adapter: {
						hasSession: () => true,
						readName: () => null,
						toolId: "stub",
					},
					sessionStoreDir: "/tmp/stub-sessions",
				}),
			} as never);

			expect(result.agents).toHaveLength(1);
			expect(result.agents[0]?.featureLabel).toBe("(unknown base)");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(storagePath, { recursive: true, force: true });
		}
	});

	it("surfaces on-disk corruption backups even after a valid save (review P0-1/P1-7)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-command-"));
		const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-store-"));
		try {
			const project = {
				id: "project-1",
				name: "agent-space",
				repoPath: root,
			};
			const store = new Store(path.join(storagePath, "projects", project.id));
			// Corrupt -> quarantine -> valid save, all on earlier instances.
			const agentsPath = path.join(
				storagePath,
				"projects",
				project.id,
				"features",
				"f1",
				"agents.json",
			);
			fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
			fs.writeFileSync(agentsPath, "{corrupt", "utf-8");
			expect(store.loadAgents("f1")).toEqual([]);
			store.saveAgents("f1", []);

			// probeAgents builds fresh Store instances: the backup must still
			// be reported, never a silent healthy empty state.
			const result = probeAgents(storagePath, [project], {
				getUnknownProjectAgentIds: () => [],
				getStructuredAttentionSignal: () => undefined,
				describeAgentToolForAgent: () => ({
					declared: true,
					tool: { id: "stub", name: "Stub", command: "stub" },
					adapter: {
						hasSession: () => true,
						readName: () => null,
						toolId: "stub",
					},
					sessionStoreDir: "/tmp/stub-sessions",
				}),
			} as never);

			expect(result.storageHealth.corruptedFiles).toContain(agentsPath);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(storagePath, { recursive: true, force: true });
		}
	});
});
