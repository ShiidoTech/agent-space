import { describe, expect, it, vi } from "vitest";
import {
	type CleanupOrphanedFeaturesDeps,
	cleanupOrphanedFeatures,
} from "../features/cleanupOrphanedFeatures";

describe("cleanupOrphanedFeatures", () => {
	it("returns nothing_to_do when no orphans exist", async () => {
		const outcome = await cleanupOrphanedFeatures({
			projectManager: {
				getAllContexts: vi.fn(() => []),
				observeTmuxSessions: vi.fn(),
			},
			terminalController: { killFeatureTerminals: vi.fn() },
			tmux: { sessionName: vi.fn(), legacySessionName: vi.fn() },
			sessionNameSyncer: { clearFeature: vi.fn() },
		});

		expect(outcome).toEqual({ status: "nothing_to_do" });
	});

	it("calls forgetFinishedFeature when no tracked sessions exist", async () => {
		const forget = vi.fn();
		const clear = vi.fn();
		const outcome = await cleanupOrphanedFeatures({
			projectManager: {
				getAllContexts: vi.fn(() => [
					{
						project: { id: "p1", name: "P1", repoPath: "/repo" },
						featureManager: {
							getOrphanedFeatures: vi.fn(() => [
								{
									id: "f1",
									name: "f1",
									branch: "feat/f1",
									worktreePath: "/x",
									status: "active" as const,
									color: "blue",
									isolation: "shared" as const,
									createdAt: "",
									createdFromSha: "",
								},
							]),
							forgetFinishedFeature: forget,
						},
						agentManager: { getAgents: vi.fn(() => []) },
						serviceManager: { getServices: vi.fn(() => []) },
					},
				]),
				observeTmuxSessions: vi.fn(() => ({
					status: "known" as const,
					sessions: [] as string[],
				})),
			},
			terminalController: { killFeatureTerminals: vi.fn() },
			tmux: { sessionName: vi.fn(), legacySessionName: vi.fn() },
			sessionNameSyncer: { clearFeature: clear },
		} as unknown as CleanupOrphanedFeaturesDeps);

		expect(outcome).toEqual({ status: "cleaned", count: 1 });
		expect(forget).toHaveBeenCalledWith("f1");
		expect(clear).toHaveBeenCalledWith("f1");
	});

	it("blocks when a tracked session is still alive after kill", async () => {
		const forget = vi.fn();
		const outcome = await cleanupOrphanedFeatures({
			projectManager: {
				getAllContexts: vi.fn(() => [
					{
						project: { id: "p1", name: "P1", repoPath: "/repo" },
						featureManager: {
							getOrphanedFeatures: vi.fn(() => [
								{
									id: "f1",
									name: "f1",
									branch: "feat/f1",
									worktreePath: "/x",
									status: "active" as const,
									color: "blue",
									isolation: "shared" as const,
									createdAt: "",
									createdFromSha: "",
								},
							]),
							forgetFinishedFeature: forget,
						},
						agentManager: {
							getAgents: vi.fn(() => [
								{
									id: "a1",
									featureId: "f1",
									name: "Agent 1",
									sessionId: "s",
									toolId: "claude",
									status: "running" as const,
									createdAt: "",
									tmuxSession: "agent-space-f1-a1",
								},
							]),
						},
						serviceManager: { getServices: vi.fn(() => []) },
					},
				]),
				observeTmuxSessions: vi.fn(() => ({
					status: "known" as const,
					sessions: ["agent-space-f1-a1"],
				})),
			},
			terminalController: { killFeatureTerminals: vi.fn() },
			tmux: {
				sessionName: vi.fn(() => "agent-space-f1-a1"),
				legacySessionName: vi.fn(() => "legacy-f1-a1"),
			},
			sessionNameSyncer: { clearFeature: vi.fn() },
		} as unknown as CleanupOrphanedFeaturesDeps);

		expect(outcome.status).toBe("blocked");
		expect((outcome as { reason: string }).reason).toContain("still running");
		expect(forget).not.toHaveBeenCalled();
	});

	it("blocks when tmux observation is unknown", async () => {
		const forget = vi.fn();
		const outcome = await cleanupOrphanedFeatures({
			projectManager: {
				getAllContexts: vi.fn(() => [
					{
						project: { id: "p1", name: "P1", repoPath: "/repo" },
						featureManager: {
							getOrphanedFeatures: vi.fn(() => [
								{
									id: "f1",
									name: "f1",
									branch: "feat/f1",
									worktreePath: "/x",
									status: "active" as const,
									color: "blue",
									isolation: "shared" as const,
									createdAt: "",
									createdFromSha: "",
								},
							]),
							forgetFinishedFeature: forget,
						},
						agentManager: {
							getAgents: vi.fn(() => [
								{
									id: "a1",
									featureId: "f1",
									name: "Agent 1",
									sessionId: "s",
									toolId: "claude",
									status: "running" as const,
									createdAt: "",
									tmuxSession: "agent-space-f1-a1",
								},
							]),
						},
						serviceManager: { getServices: vi.fn(() => []) },
					},
				]),
				observeTmuxSessions: vi.fn(() => ({
					status: "unknown" as const,
					reason: "tmux_not_available",
				})),
			},
			terminalController: { killFeatureTerminals: vi.fn() },
			tmux: {
				sessionName: vi.fn(() => "agent-space-f1-a1"),
				legacySessionName: vi.fn(() => "legacy-f1-a1"),
			},
			sessionNameSyncer: { clearFeature: vi.fn() },
		} as unknown as CleanupOrphanedFeaturesDeps);

		expect(outcome.status).toBe("blocked");
		expect((outcome as { reason: string }).reason).toContain(
			"could not be verified",
		);
		expect(forget).not.toHaveBeenCalled();
	});

	it("cleans after sessions are verified stopped", async () => {
		const forget = vi.fn();
		const clear = vi.fn();
		const outcome = await cleanupOrphanedFeatures({
			projectManager: {
				getAllContexts: vi.fn(() => [
					{
						project: { id: "p1", name: "P1", repoPath: "/repo" },
						featureManager: {
							getOrphanedFeatures: vi.fn(() => [
								{
									id: "f1",
									name: "f1",
									branch: "feat/f1",
									worktreePath: "/x",
									status: "active" as const,
									color: "blue",
									isolation: "shared" as const,
									createdAt: "",
									createdFromSha: "",
								},
							]),
							forgetFinishedFeature: forget,
						},
						agentManager: {
							getAgents: vi.fn(() => [
								{
									id: "a1",
									featureId: "f1",
									name: "Agent 1",
									sessionId: "s",
									toolId: "claude",
									status: "running" as const,
									createdAt: "",
									tmuxSession: "agent-space-f1-a1",
								},
							]),
						},
						serviceManager: { getServices: vi.fn(() => []) },
					},
				]),
				observeTmuxSessions: vi.fn(() => ({
					status: "known" as const,
					sessions: [],
				})),
			},
			terminalController: { killFeatureTerminals: vi.fn() },
			tmux: {
				sessionName: vi.fn(() => "agent-space-f1-a1"),
				legacySessionName: vi.fn(() => "legacy-f1-a1"),
			},
			sessionNameSyncer: { clearFeature: clear },
		} as unknown as CleanupOrphanedFeaturesDeps);

		expect(outcome).toEqual({ status: "cleaned", count: 1 });
		expect(forget).toHaveBeenCalledWith("f1");
		expect(clear).toHaveBeenCalledWith("f1");
	});
});
