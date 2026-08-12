import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureStateCoordinator } from "../features/featureStateCoordinator";
import type { FeatureGitObservations } from "../git/featureGitObservations";
import { known } from "../git/featureGitObservations";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, Feature } from "../types";

afterEach(() => vi.useRealTimers());

function feature(id = "f1"): Feature {
	return {
		id,
		name: id,
		branch: `feat/${id}`,
		worktreePath: `/repo/.worktrees/${id}`,
		status: "active",
		color: "blue",
		isolation: "shared",
		createdAt: "2026-08-10T00:00:00.000Z",
		createdFromSha: "1".repeat(40),
	};
}

function git(inputFeature = feature()): FeatureGitObservations {
	const observedFeature = { ref: inputFeature.branch, sha: "2".repeat(40) };
	const base = { ref: "main", sha: "3".repeat(40) };
	return {
		repository: known({ root: "/repo" }),
		worktree: known({ path: inputFeature.worktreePath, present: true }),
		branch: known({
			expected: inputFeature.branch,
			actual: inputFeature.branch,
			detached: false,
			matchesExpected: true,
		}),
		head: known(observedFeature),
		feature: known(observedFeature),
		base: known(base),
		creationPoint: known({
			ref: inputFeature.createdFromSha ?? "main",
			sha: "1".repeat(40),
		}),
		creationPointInFeature: known({
			ancestor: {
				ref: inputFeature.createdFromSha ?? "main",
				sha: "1".repeat(40),
			},
			descendant: observedFeature,
			isAncestor: true,
		}),
		upstream: known({ branchRef: inputFeature.branch, upstream: null }),
		upstreamDivergence: known(null),
		featureDelta: known({
			left: base,
			right: observedFeature,
			leftOnly: 0,
			rightOnly: 1,
		}),
		featureDiff: known({
			base,
			feature: observedFeature,
			files: [],
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			raw: "",
		}),
		workingTree: known({
			staged: [],
			unstaged: [],
			untracked: [],
			conflicted: [],
		}),
		worktrees: known([]),
		featureInBase: known({
			ancestor: observedFeature,
			descendant: base,
			isAncestor: false,
		}),
	};
}

function setup(
	inspect = vi.fn(async ({ featureBranch }: { featureBranch: string }) =>
		git(featureBranch === "main" ? baseFeature() : feature()),
	),
) {
	let features = [feature()];
	const saveFeatures = vi.fn();
	const saveAgents = vi.fn();
	const saveServices = vi.fn();
	const context = {
		project: { id: "p1", name: "Project", repoPath: "/repo" },
		store: {
			loadFeatures: vi.fn(() => features),
			saveFeatures,
			saveAgents,
			saveServices,
		},
		featureManager: {
			getBaseFeature: () => baseFeature(),
			getBaseBranchName: () => "main",
			getFeatures: vi.fn(() => {
				throw new Error("must not be called");
			}),
		},
		featureGitInspector: {
			inspect,
			observeProject: vi.fn(async () => ({
				repository: known({ root: "/repo" }),
				worktrees: known([]),
			})),
		},
		gitClient: {
			read: vi.fn(async () => ({
				argv: [],
				cwd: "/repo",
				exitCode: 0,
				signal: null,
				stdout: "main\n",
				stderr: "",
			})),
		},
		config: { baseBranch: "main" },
		agentManager: { getAgents: vi.fn(() => []) },
		serviceManager: { getServices: vi.fn(() => []) },
	} as unknown as ProjectContext;
	let currentContext = context;
	const manager = {
		getAllContexts: vi.fn(() => [currentContext]),
		listTmuxSessions: vi.fn(() => []),
		observeTmuxSessions: vi.fn(() => ({
			status: "known" as const,
			sessions: [] as string[],
		})),
		agentTmuxSessionName: vi.fn(
			(featureId: string, agentId: string, persisted?: string) =>
				persisted ?? `agent-space-${featureId}-${agentId}`,
		),
	} as unknown as ProjectManager;
	return {
		context,
		manager,
		inspect,
		saves: [saveFeatures, saveAgents, saveServices],
		setFeatures: (next: Feature[]) => {
			features = next;
		},
		recreateContext: () => {
			currentContext = { ...context };
		},
	};
}

function baseFeature(): Feature {
	return {
		...feature("base:p1"),
		name: "main",
		branch: "main",
		worktreePath: "/repo",
		createdFromSha: undefined,
	};
}

describe("FeatureStateCoordinator", () => {
	it("starts, stops, disposes, and never persists observations", async () => {
		vi.useFakeTimers();
		const fixture = setup();
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		coordinator.start(undefined, 15_000);
		await coordinator.reconcile();
		expect(coordinator.getProjectSnapshots("p1")).toHaveLength(2);
		expect(
			fixture.context.featureGitInspector.observeProject,
		).toHaveBeenCalledTimes(1);
		expect(fixture.saves.every((save) => save.mock.calls.length === 0)).toBe(
			true,
		);
		coordinator.stop();
		coordinator.dispose();
		expect(coordinator.getProjectSnapshots("p1")).toEqual([]);
	});

	it("does not poll without an active consumer", async () => {
		vi.useFakeTimers();
		const fixture = setup();
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		coordinator.start(undefined, 15_000);
		await coordinator.reconcile();
		const callsWithoutConsumer = fixture.inspect.mock.calls.length;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(fixture.inspect).toHaveBeenCalledTimes(callsWithoutConsumer);
		const consumer = coordinator.acquireConsumer(15_000);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(fixture.inspect.mock.calls.length).toBeGreaterThan(
			callsWithoutConsumer,
		);
		consumer.dispose();
		coordinator.dispose();
	});

	it("starts and stops polling as sidebar and Home consumers become visible", async () => {
		vi.useFakeTimers();
		const fixture = setup();
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		coordinator.start(undefined, 15_000);
		await coordinator.reconcile();
		const initialCalls = fixture.inspect.mock.calls.length;

		const sidebar = coordinator.acquireConsumer(15_000);
		const home = coordinator.acquireConsumer(15_000);
		await vi.advanceTimersByTimeAsync(15_000);
		const visibleCalls = fixture.inspect.mock.calls.length;
		expect(visibleCalls).toBeGreaterThan(initialCalls);

		sidebar.dispose();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(fixture.inspect.mock.calls.length).toBeGreaterThan(visibleCalls);

		home.dispose();
		const hiddenCalls = fixture.inspect.mock.calls.length;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fixture.inspect.mock.calls.length).toBe(hiddenCalls);

		const sidebarVisibleAgain = coordinator.acquireConsumer(15_000);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(fixture.inspect.mock.calls.length).toBeGreaterThan(hiddenCalls);
		sidebarVisibleAgain.dispose();
		coordinator.dispose();
	});

	it("notifies only changes, removes deleted entries, and tolerates recreated contexts", async () => {
		const fixture = setup();
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		const listener = vi.fn();
		coordinator.onDidChange(listener);
		await coordinator.reconcile();
		await vi.waitFor(() =>
			expect(coordinator.getProjectReferenceHealth("p1")).toBeDefined(),
		);
		const initialNotifications = listener.mock.calls.length;
		expect(initialNotifications).toBeGreaterThanOrEqual(3);
		await coordinator.reconcile();
		expect(listener).toHaveBeenCalledTimes(initialNotifications);
		fixture.recreateContext();
		await coordinator.reconcile();
		expect(listener).toHaveBeenCalledTimes(initialNotifications);
		fixture.setFeatures([]);
		await coordinator.reconcile();
		expect(coordinator.getSnapshot("f1")).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(initialNotifications + 1);
	});

	it("represents inspector and runtime failures as unknown", async () => {
		const fixture = setup(
			vi.fn(async () => {
				throw new Error("git unavailable");
			}),
		);
		fixture.context.agentManager.getAgents = vi.fn(() => {
			throw new Error("agents unavailable");
		});
		fixture.context.serviceManager.getServices = vi.fn(() => {
			throw new Error("services unavailable");
		});
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await expect(coordinator.reconcile()).resolves.toBeUndefined();
		const snapshot = coordinator.getSnapshot("f1");
		expect(snapshot?.git.repository.status).toBe("unknown");
		expect(snapshot?.runtime.agents).toMatchObject({
			status: "unknown",
			reason: "read_failed",
		});
		expect(snapshot?.runtime.services).toMatchObject({
			status: "unknown",
			reason: "read_failed",
		});
	});

	it("marks retained membership stale when features storage cannot be read", async () => {
		const fixture = setup();
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();
		fixture.context.store.loadFeatures = vi.fn(() => {
			throw new Error("features.json unavailable");
		});
		await coordinator.reconcile();
		const snapshot = coordinator.getSnapshot("f1");
		expect(snapshot?.source).toEqual({
			status: "unknown",
			reason: "storage_read_failed",
			detail: "features.json unavailable",
		});
		expect(snapshot?.attention.map((entry) => entry.code)).toContain(
			"feature_source_unknown",
		);
	});

	it("shares one in-flight reconciliation across concurrent callers", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const inspect = vi.fn(
			async ({ featureBranch }: { featureBranch: string }) => {
				await gate;
				return git(featureBranch === "main" ? baseFeature() : feature());
			},
		);
		const fixture = setup(inspect);
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		const first = coordinator.reconcile();
		const second = coordinator.reconcile();
		expect(second).toBe(first);
		release?.();
		await first;
		expect(inspect).toHaveBeenCalledTimes(2);
	});

	it("publishes local snapshots without waiting for a slow remote head", async () => {
		const fixture = setup();
		const remoteNeverResolves = new Promise<never>(() => undefined);
		const observe = vi.fn(() => remoteNeverResolves);
		const coordinator = new FeatureStateCoordinator(fixture.manager, {
			referenceBranchRemote: { observe },
		});

		await coordinator.reconcile();

		expect(coordinator.getProjectSnapshots("p1")).toHaveLength(2);
		expect(observe).toHaveBeenCalledTimes(1);
		coordinator.dispose();
	});

	it("keeps remote proof cached on ordinary invalidation and clears it explicitly", () => {
		const fixture = setup();
		const invalidate = vi.fn();
		const coordinator = new FeatureStateCoordinator(fixture.manager, {
			referenceBranchRemote: {
				observe: vi.fn(async () => ({
					status: "missing" as const,
					observedAt: "2026-08-12T00:00:00.000Z",
					provenance: {
						source: "remote_head" as const,
						ref: "refs/heads/main",
						backend: "test",
					},
				})),
				invalidate,
			},
		});

		coordinator.invalidate("f1");
		expect(invalidate).not.toHaveBeenCalled();
		coordinator.refreshProjectReferenceHealth();
		expect(invalidate).toHaveBeenCalledTimes(1);
		coordinator.dispose();
	});

	it("records tmux liveness as runtime evidence", async () => {
		const fixture = setup();
		fixture.context.agentManager.getAgents = vi.fn(() => [
			{
				id: "a1",
				featureId: "f1",
				name: "Agent",
				sessionId: null,
				tmuxSession: "agent-f1-a1",
				status: "running",
				createdAt: "2026-08-10T00:00:00.000Z",
			} satisfies Agent,
		]);
		vi.mocked(fixture.manager.observeTmuxSessions).mockReturnValue({
			status: "known",
			sessions: ["agent-f1-a1"],
		});
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();
		const runtime = coordinator.getSnapshot("f1")?.runtime.agents;
		expect(runtime?.status).toBe("known");
		if (runtime?.status === "known") {
			expect(runtime.value[0].tmuxAlive).toEqual({
				status: "known",
				value: true,
			});
		}
	});

	it("keeps failed tmux observation unknown instead of marking sessions dead", async () => {
		const fixture = setup();
		fixture.context.agentManager.getAgents = vi.fn(() => [
			{
				id: "a1",
				featureId: "f1",
				name: "Agent",
				sessionId: null,
				tmuxSession: "agent-f1-a1",
				status: "running",
				createdAt: "2026-08-10T00:00:00.000Z",
			} satisfies Agent,
		]);
		vi.mocked(fixture.manager.observeTmuxSessions).mockReturnValue({
			status: "unknown",
			detail: "tmux unavailable",
		});
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();
		const runtime = coordinator.getSnapshot("f1")?.runtime.agents;
		expect(runtime?.status).toBe("known");
		if (runtime?.status === "known") {
			expect(runtime.value[0].tmuxAlive).toMatchObject({
				status: "unknown",
				reason: "read_failed",
			});
		}
	});

	it("discards an in-flight generation invalidated by deletion", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fixture = setup(
			vi.fn(async ({ featureBranch }: { featureBranch: string }) => {
				await gate;
				return git(featureBranch === "main" ? baseFeature() : feature());
			}),
		);
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		const listener = vi.fn();
		coordinator.onDidChange(listener);
		const first = coordinator.reconcile();
		fixture.setFeatures([]);
		coordinator.invalidate("f1");
		release?.();
		await first;
		await coordinator.reconcile();
		expect(coordinator.getSnapshot("f1")).toBeUndefined();
		expect(
			listener.mock.calls.some(([value]) => value?.feature.id === "f1"),
		).toBe(false);
	});

	it("passes an unknown base to the inspector instead of guessing main", async () => {
		const fixture = setup();
		fixture.context.config = {};
		fixture.context.gitClient.read = vi.fn(async () => ({
			argv: [],
			cwd: "/repo",
			exitCode: 1,
			signal: null,
			stdout: "",
			stderr: "detached",
		}));
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();
		expect(fixture.inspect).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ baseRef: undefined }),
			expect.anything(),
		);
		expect(coordinator.getSnapshot("base:p1")?.feature.branch).toBe(
			"(unknown base)",
		);
	});
});
