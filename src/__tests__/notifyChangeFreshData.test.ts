import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execSync: vi.fn(),
}));

import { FeatureStateCoordinator } from "../features/featureStateCoordinator";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, Feature } from "../types";

// Issue #120 PR review (blocker 2): `invalidateFeature()` deliberately never
// touches the coordinator's cached snapshot, so a listener that reads
// `getProjectSnapshots`/`getSnapshot` right after a rename — without an
// intervening `reconcilePresence()` — can still see the pre-rename name.
// This proves the mechanism the extension.ts fix relies on: an explicit
// `reconcilePresence()` call between the mutation and the incremental patch
// actually refreshes `runtime.agents` from the live read model.

function feature(): Feature {
	return {
		id: "f1",
		name: "f1",
		branch: "feat/f1",
		worktreePath: "/repo/.worktrees/f1",
		status: "active",
		color: "blue",
		isolation: "shared",
		createdAt: "2026-08-10T00:00:00.000Z",
		createdFromSha: "1".repeat(40),
	};
}

function buildFixture() {
	let agents: Agent[] = [
		{
			id: "a1",
			featureId: "f1",
			name: "Agent 1",
			toolId: "claude",
			status: "running",
			createdAt: "2026-08-10T00:00:00.000Z",
		} as Agent,
	];
	const context = {
		project: { id: "p1", name: "Project", repoPath: "/repo" },
		featureManager: {
			getBaseFeature: () => ({
				...feature(),
				id: "base:p1",
				name: "main",
				branch: "main",
			}),
			listFeaturesCached: vi.fn(() => [feature()]),
		},
		agentManager: {
			getAgentsReadModel: vi.fn(() => agents),
		},
		serviceManager: { getServices: vi.fn(() => []) },
		config: { baseBranch: "main" },
	} as unknown as ProjectContext;
	const manager = {
		getAllContexts: vi.fn(() => [context]),
		getContext: vi.fn(() => context),
		observeTmuxSessions: vi.fn(() => ({
			status: "known" as const,
			sessions: [] as string[],
		})),
		agentTmuxSessionName: vi.fn(() => undefined),
		findContextByFeatureId: vi.fn(() => context),
	} as unknown as ProjectManager;

	return {
		coordinator: new FeatureStateCoordinator(manager),
		renameAgent: (name: string) => {
			agents = [{ ...agents[0], name }];
		},
	};
}

describe("issue #120: incremental patch must read post-mutation state", () => {
	it("reconcilePresence() refreshes the cached snapshot's agent name after a rename", async () => {
		const { coordinator, renameAgent } = buildFixture();
		await coordinator.reconcilePresence();

		const before = coordinator.getProjectSnapshots("p1")[0];
		expect(before.runtime.agents.status).toBe("known");
		expect(
			before.runtime.agents.status === "known" &&
				before.runtime.agents.value[0].agent.name,
		).toBe("Agent 1");

		renameAgent("Renamed Agent");

		// Without a fresh reconcile, the cache is still the pre-rename name —
		// this is exactly blocker 2: patching from `getProjectSnapshots()`
		// alone (no reconcile in between) would post the stale name.
		const stale = coordinator.getProjectSnapshots("p1")[0];
		expect(
			stale.runtime.agents.status === "known" &&
				stale.runtime.agents.value[0].agent.name,
		).toBe("Agent 1");

		await coordinator.reconcilePresence();

		const fresh = coordinator.getProjectSnapshots("p1")[0];
		expect(
			fresh.runtime.agents.status === "known" &&
				fresh.runtime.agents.value[0].agent.name,
		).toBe("Renamed Agent");
	});
});
