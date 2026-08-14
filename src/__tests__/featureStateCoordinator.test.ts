import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureStateCoordinator } from "../features/featureStateCoordinator";
import type { FeatureGitObservations } from "../git/featureGitObservations";
import { known, unknown } from "../git/featureGitObservations";
import type { PullRequestBackend } from "../github/pullRequestBackend";
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
			getFeatures: vi.fn(() => features),
		},
		featureGitInspector: {
			inspect,
			isCommitAncestor: vi.fn(
				async (ancestorSha: string, descendantSha: string) =>
					known({
						ancestor: { ref: ancestorSha, sha: ancestorSha },
						descendant: { ref: descendantSha, sha: descendantSha },
						isAncestor: true,
					}),
			),
			countCommitsAfter: vi.fn(
				async (ancestorSha: string, descendantSha: string) =>
					known({ ancestorSha, descendantSha, count: 1 }),
			),
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
	it("uses the exact Feature worktree branch even when persisted links are stale", async () => {
		const fixture = setup();
		const staleFeature = {
			...feature(),
			branch: "feat/old-player",
			branchLinks: [
				{
					ref: "feat/old-player",
					role: "primary" as const,
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "legacy_record" as const,
				},
			],
		};
		fixture.context.featureManager.getFeatures = vi.fn(() => [staleFeature]);
		fixture.context.featureGitInspector.observeProject = vi.fn(async () => ({
			repository: known({ root: "/repo" }),
			worktrees: known([
				{
					path: "/repo/.worktrees/f1",
					headSha: "2".repeat(40),
					branchRef: "refs/heads/feat/current-player",
					detached: false,
					bare: false,
					prunable: false,
				},
			]),
		}));

		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();

		expect(fixture.inspect).toHaveBeenCalledWith(
			expect.objectContaining({ featureBranch: "feat/current-player" }),
			expect.anything(),
		);
	});
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

	it("drains an invalidation that arrives during the queued second pass", async () => {
		let coordinator: FeatureStateCoordinator;
		let calls = 0;
		const inspect = vi.fn(
			async ({ featureBranch }: { featureBranch: string }) => {
				calls += 1;
				if (calls === 1 || calls === 3) coordinator.invalidate("f1");
				return git(featureBranch === "main" ? baseFeature() : feature());
			},
		);
		const fixture = setup(inspect);
		coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();

		expect(inspect).toHaveBeenCalledTimes(6);
		coordinator.dispose();
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

	it("exposes a per-project worktree branch inventory from the observed worktrees", async () => {
		const fixture = setup();
		fixture.setFeatures([
			{
				...feature(),
				branch: "agent/restore-feature-cockpit",
				primaryBranchRef: "agent/restore-feature-cockpit",
			},
		]);
		fixture.context.featureGitInspector.observeProject = vi.fn(async () => ({
			repository: known({ root: "/repo" }),
			worktrees: known([
				{
					path: "/repo/.worktrees/cockpit",
					headSha: "2".repeat(40),
					branchRef: "refs/heads/agent/restore-feature-cockpit",
					detached: false,
					bare: false,
					prunable: false,
				},
			]),
		}));
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();
		await vi.waitFor(() =>
			expect(coordinator.getProjectWorktreeBranches("p1")).toBeDefined(),
		);
		const inventory = coordinator.getProjectWorktreeBranches("p1");
		expect(inventory?.status).toBe("known");
		expect(inventory?.branches[0]?.ref).toBe("agent/restore-feature-cockpit");
		expect(inventory?.branches[0]?.linkedFeatureId).toBe("f1");
		expect(inventory?.branches[0]?.baseRelation).toEqual({
			status: "unknown",
			reason: "base_unknown",
		});
	});

	it("transitions a known worktree inventory to unknown when worktrees cannot be observed", async () => {
		const fixture = setup();
		fixture.setFeatures([]);
		fixture.context.featureGitInspector.observeProject = vi.fn(async () => ({
			repository: known({ root: "/repo" }),
			worktrees: known([
				{
					path: "/repo/.worktrees/cockpit",
					headSha: "2".repeat(40),
					branchRef: "refs/heads/agent/restore-feature-cockpit",
					detached: false,
					bare: false,
					prunable: false,
				},
			]),
		}));
		const coordinator = new FeatureStateCoordinator(fixture.manager);
		await coordinator.reconcile();
		await vi.waitFor(() =>
			expect(coordinator.getProjectWorktreeBranches("p1")?.status).toBe(
				"known",
			),
		);

		fixture.context.featureGitInspector.observeProject = vi.fn(async () => ({
			repository: known({ root: "/repo" }),
			worktrees: unknown("git_command_failed", "worktree list failed"),
		}));
		await coordinator.reconcile();
		expect(coordinator.getProjectWorktreeBranches("p1")).toMatchObject({
			status: "unknown",
			reason: "worktrees_unavailable",
		});
	});

	it("inspects the active branch while querying GitHub for the delivery branch", async () => {
		const readResult = (stdout: string) => ({
			argv: [],
			cwd: "/repo",
			exitCode: 0,
			signal: null,
			stdout,
			stderr: "",
		});
		const active = {
			...feature(),
			branch: "feat/feature_cockpit",
			primaryBranchRef: "feat/audit_and_go",
			branchLinks: [
				{
					ref: "feat/audit_and_go",
					role: "primary" as const,
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "reflog_checkout" as const,
				},
				{
					ref: "feat/feature_cockpit",
					role: "continuation" as const,
					linkedAt: "2026-08-12T09:35:00.000Z",
					source: "reflog_checkout" as const,
					relation: {
						kind: "descends_from" as const,
						ref: "feat/audit_and_go",
					},
				},
			],
		};
		const inspect = vi.fn(async () => git(active));
		const fixture = setup(inspect);
		fixture.setFeatures([
			{
				...active,
				primaryBranchRef: undefined,
				branchLinks: undefined,
			},
		]);
		fixture.context.featureManager.getFeatures = vi.fn(() => [active]);
		const deliverySha = "4".repeat(40);
		fixture.context.gitClient.read = vi.fn(async (args: readonly string[]) => {
			if (args[0] === "config") {
				return readResult(
					"remote.origin.url https://github.com/ShiidoTech/agent-space.git\n",
				);
			}
			if (args[0] === "rev-parse" && args[2]?.startsWith("feat/audit_and_go")) {
				return readResult(`${deliverySha}\n`);
			}
			return readResult("main\n");
		});
		const listPullRequests = vi.fn(async () => ({
			status: "ok" as const,
			pulls: [
				{
					number: 74,
					html_url: "https://github.com/ShiidoTech/agent-space/pull/74",
					state: "open" as const,
					draft: true,
					head: { ref: "feat/audit_and_go", sha: deliverySha },
					base: { ref: "main" },
				},
			],
		}));
		const backend = {
			auth: vi.fn(async () => ({
				state: "authenticated" as const,
				source: "env" as const,
				token: "test",
			})),
			listPullRequests,
		} satisfies PullRequestBackend;
		const coordinator = new FeatureStateCoordinator(fixture.manager, {
			createGithubBackend: () => backend,
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
			},
		});

		await coordinator.reconcile();

		expect(inspect).toHaveBeenCalledWith(
			expect.objectContaining({ featureBranch: "feat/feature_cockpit" }),
			expect.anything(),
		);
		expect(fixture.context.featureManager.getFeatures).toHaveBeenCalled();
		expect(listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "feat/audit_and_go" }),
		);
		await vi.waitFor(() =>
			expect(coordinator.getSnapshot("f1")?.github).toMatchObject({
				queriedHeadSha: deliverySha,
			}),
		);
		expect(coordinator.getSnapshot("f1")?.github).toMatchObject({
			queriedHeadSha: deliverySha,
		});
		expect(coordinator.getSnapshot("f1")?.delivery).toMatchObject({
			branchRef: "feat/audit_and_go",
			head: { status: "known", value: { sha: deliverySha } },
			activeRelation: { status: "known", value: { isAncestor: true } },
			commitsAfter: { status: "known", value: { count: 1 } },
		});
		expect(coordinator.getSnapshot("f1")?.attention).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "continuation_outside_delivery" }),
			]),
		);
		expect(
			coordinator
				.getSnapshot("f1")
				?.attention.some((item) => item.code === "pull_request_head_mismatch"),
		).toBe(false);
	});

	it("selects the merged PR from the active branch and models deliveredVia", async () => {
		const readResult = (stdout: string) => ({
			argv: [],
			cwd: "/repo",
			exitCode: 0,
			signal: null,
			stdout,
			stderr: "",
		});
		const activeSha = "7".repeat(40);
		const deliverySha = "8".repeat(40);
		const active = {
			...feature(),
			branch: "dev/improvements",
			primaryBranchRef: "fix/1203",
			branchLinks: [
				{
					ref: "fix/1203",
					role: "primary" as const,
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "feature_created" as const,
				},
				{
					ref: "dev/improvements",
					role: "continuation" as const,
					linkedAt: "2026-08-12T09:35:00.000Z",
					source: "reflog_checkout" as const,
					relation: {
						kind: "descends_from" as const,
						ref: "fix/1203",
					},
				},
			],
		};
		const inspect = vi.fn(async ({ featureBranch }: { featureBranch: string }) => {
			if (featureBranch === "dev/improvements") {
				return {
					...git(active),
					feature: known({ ref: "dev/improvements", sha: activeSha }),
					head: known({ ref: "dev/improvements", sha: activeSha }),
					featureInBase: known({
						ancestor: { ref: "dev/improvements", sha: activeSha },
						descendant: { ref: "main", sha: "3".repeat(40) },
						isAncestor: false,
					}),
				};
			}
			return git(featureBranch === "main" ? baseFeature() : feature());
		});
		const fixture = setup(inspect);
		fixture.setFeatures([active]);
		fixture.context.featureManager.getFeatures = vi.fn(() => [active]);
		fixture.context.gitClient.read = vi.fn(async (args: readonly string[]) => {
			if (args[0] === "config") {
				return readResult(
					"remote.origin.url https://github.com/ShiidoTech/agent-space.git\n",
				);
			}
			if (args[0] === "rev-parse" && args[2]?.startsWith("fix/1203")) {
				return readResult(`${deliverySha}\n`);
			}
			return readResult("main\n");
		});
		const listPullRequests = vi.fn(async ({ head }: { head: string }) => {
			if (head === "dev/improvements") {
				return {
					status: "ok" as const,
					pulls: [
						{
							number: 1203,
							html_url: "https://github.com/ShiidoTech/agent-space/pull/1203",
							state: "closed" as const,
							merged: true,
							merged_at: "2026-08-12T10:00:00.000Z",
							draft: false,
							head: { ref: "dev/improvements", sha: activeSha },
							base: { ref: "main" },
						},
					],
				};
			}
			return { status: "ok" as const, pulls: [] };
		});
		const backend = {
			auth: vi.fn(async () => ({
				state: "authenticated" as const,
				source: "env" as const,
				token: "test",
			})),
			listPullRequests,
		} satisfies PullRequestBackend;
		const coordinator = new FeatureStateCoordinator(fixture.manager, {
			createGithubBackend: () => backend,
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
			},
		});

		await coordinator.reconcile();

		expect(listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "dev/improvements" }),
		);
		expect(listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "fix/1203" }),
		);
		await vi.waitFor(() =>
			expect(coordinator.getSnapshot("f1")?.github).toMatchObject({
				queriedBranch: "dev/improvements",
				queriedHeadSha: activeSha,
			}),
		);
		const snapshot = coordinator.getSnapshot("f1");
		expect(snapshot?.github).toMatchObject({
			queriedBranch: "dev/improvements",
			queriedHeadSha: activeSha,
		});
		expect(snapshot?.delivery).toMatchObject({
			branchRef: "fix/1203",
			deliveredVia: {
				branchRef: "dev/improvements",
				head: { ref: "dev/improvements", sha: activeSha },
				pullNumber: 1203,
			},
		});
		expect(snapshot?.integration).toMatchObject({
			status: "known",
			outcome: "integrated_by_pull_request",
		});
		expect(
			snapshot?.attention.some(
				(item) => item.code === "continuation_outside_delivery",
			),
		).toBe(false);
	});

	it("ignores a merged PR on the active branch when it is not a proven continuation", async () => {
		const readResult = (stdout: string) => ({
			argv: [],
			cwd: "/repo",
			exitCode: 0,
			signal: null,
			stdout,
			stderr: "",
		});
		const activeSha = "7".repeat(40);
		const deliverySha = "8".repeat(40);
		const active = {
			...feature(),
			branch: "dev/improvements",
			primaryBranchRef: "fix/1203",
			branchLinks: [
				{
					ref: "fix/1203",
					role: "primary" as const,
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "feature_created" as const,
				},
				{
					ref: "dev/improvements",
					role: "continuation" as const,
					linkedAt: "2026-08-12T09:35:00.000Z",
					source: "reflog_checkout" as const,
					relation: {
						kind: "descends_from" as const,
						ref: "fix/1203",
					},
				},
			],
		};
		const inspect = vi.fn(
			async ({ featureBranch }: { featureBranch: string }) => {
				if (featureBranch === "dev/improvements") {
					return {
						...git(active),
						feature: known({ ref: "dev/improvements", sha: activeSha }),
						head: known({ ref: "dev/improvements", sha: activeSha }),
						featureInBase: known({
							ancestor: { ref: "dev/improvements", sha: activeSha },
							descendant: { ref: "main", sha: "3".repeat(40) },
							isAncestor: false,
						}),
					};
				}
				return git(featureBranch === "main" ? baseFeature() : feature());
			},
		);
		const fixture = setup(inspect);
		fixture.setFeatures([active]);
		fixture.context.featureManager.getFeatures = vi.fn(() => [active]);
		// The active branch does NOT descend from the delivery branch, so a PR
		// merged from it is not proof that the historical work was delivered.
		fixture.context.featureGitInspector.isCommitAncestor = vi.fn(
			async (ancestorSha: string, descendantSha: string) =>
				known({
					ancestor: { ref: ancestorSha, sha: ancestorSha },
					descendant: { ref: descendantSha, sha: descendantSha },
					isAncestor: false,
				}),
		);
		fixture.context.gitClient.read = vi.fn(async (args: readonly string[]) => {
			if (args[0] === "config") {
				return readResult(
					"remote.origin.url https://github.com/ShiidoTech/agent-space.git\n",
				);
			}
			if (args[0] === "rev-parse" && args[2]?.startsWith("fix/1203")) {
				return readResult(`${deliverySha}\n`);
			}
			return readResult("main\n");
		});
		const listPullRequests = vi.fn(async ({ head }: { head: string }) => {
			if (head === "dev/improvements") {
				return {
					status: "ok" as const,
					pulls: [
						{
							number: 1203,
							html_url: "https://github.com/ShiidoTech/agent-space/pull/1203",
							state: "closed" as const,
							merged: true,
							merged_at: "2026-08-12T10:00:00.000Z",
							draft: false,
							head: { ref: "dev/improvements", sha: activeSha },
							base: { ref: "main" },
						},
					],
				};
			}
			return { status: "ok" as const, pulls: [] };
		});
		const backend = {
			auth: vi.fn(async () => ({
				state: "authenticated" as const,
				source: "env" as const,
				token: "test",
			})),
			listPullRequests,
		} satisfies PullRequestBackend;
		const coordinator = new FeatureStateCoordinator(fixture.manager, {
			createGithubBackend: () => backend,
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
			},
		});

		await coordinator.reconcile();

		// The active branch is not a proven continuation, so it must not be
		// considered as a delivery vector at all.
		expect(listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "fix/1203" }),
		);
		expect(listPullRequests).not.toHaveBeenCalledWith(
			expect.objectContaining({ head: "dev/improvements" }),
		);
		const snapshot = coordinator.getSnapshot("f1");
		expect(snapshot?.delivery).toMatchObject({
			branchRef: "fix/1203",
		});
		expect(snapshot?.delivery?.deliveredVia).toBeUndefined();
	});

	it("does not model deliveredVia when the continuation PR targets another base", async () => {
		const readResult = (stdout: string) => ({
			argv: [],
			cwd: "/repo",
			exitCode: 0,
			signal: null,
			stdout,
			stderr: "",
		});
		const activeSha = "7".repeat(40);
		const deliverySha = "8".repeat(40);
		const active = {
			...feature(),
			branch: "dev/improvements",
			primaryBranchRef: "fix/1203",
			branchLinks: [
				{
					ref: "fix/1203",
					role: "primary" as const,
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "feature_created" as const,
				},
				{
					ref: "dev/improvements",
					role: "continuation" as const,
					linkedAt: "2026-08-12T09:35:00.000Z",
					source: "reflog_checkout" as const,
					relation: {
						kind: "descends_from" as const,
						ref: "fix/1203",
					},
				},
			],
		};
		const inspect = vi.fn(
			async ({ featureBranch }: { featureBranch: string }) => {
				if (featureBranch === "dev/improvements") {
					return {
						...git(active),
						feature: known({ ref: "dev/improvements", sha: activeSha }),
						head: known({ ref: "dev/improvements", sha: activeSha }),
						featureInBase: known({
							ancestor: { ref: "dev/improvements", sha: activeSha },
							descendant: { ref: "main", sha: "3".repeat(40) },
							isAncestor: false,
						}),
					};
				}
				return git(featureBranch === "main" ? baseFeature() : feature());
			},
		);
		const fixture = setup(inspect);
		fixture.setFeatures([active]);
		fixture.context.featureManager.getFeatures = vi.fn(() => [active]);
		fixture.context.gitClient.read = vi.fn(async (args: readonly string[]) => {
			if (args[0] === "config") {
				return readResult(
					"remote.origin.url https://github.com/ShiidoTech/agent-space.git\n",
				);
			}
			if (args[0] === "rev-parse" && args[2]?.startsWith("fix/1203")) {
				return readResult(`${deliverySha}\n`);
			}
			return readResult("main\n");
		});
		const listPullRequests = vi.fn(async ({ head }: { head: string }) => {
			if (head === "dev/improvements") {
				return {
					status: "ok" as const,
					pulls: [
						{
							number: 1203,
							html_url: "https://github.com/ShiidoTech/agent-space/pull/1203",
							state: "closed" as const,
							merged: true,
							merged_at: "2026-08-12T10:00:00.000Z",
							draft: false,
							head: { ref: "dev/improvements", sha: activeSha },
							base: { ref: "release" },
						},
					],
				};
			}
			return { status: "ok" as const, pulls: [] };
		});
		const backend = {
			auth: vi.fn(async () => ({
				state: "authenticated" as const,
				source: "env" as const,
				token: "test",
			})),
			listPullRequests,
		} satisfies PullRequestBackend;
		const coordinator = new FeatureStateCoordinator(fixture.manager, {
			createGithubBackend: () => backend,
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
			},
		});

		await coordinator.reconcile();

		await vi.waitFor(() =>
			expect(coordinator.getSnapshot("f1")?.integration).toMatchObject({
				status: "known",
			}),
		);
		const snapshot = coordinator.getSnapshot("f1");
		// The continuation is proven and the PR is merged, but it targeted
		// another base, so it must not be modeled as the delivery vector.
		expect(snapshot?.delivery).toMatchObject({
			branchRef: "fix/1203",
		});
		expect(snapshot?.delivery?.deliveredVia).toBeUndefined();
		expect(snapshot?.integration).toMatchObject({
			status: "known",
			outcome: "integrated_to_other_base",
		});
		// Merging into another base no longer suppresses the continuation
		// warning: the work is not proven integrated into the expected base.
		expect(
			snapshot?.attention.some(
				(item) => item.code === "continuation_outside_delivery",
			),
		).toBe(true);
	});

	it("prefers a merged continuation PR matching the active head over a historical merged PR", async () => {
		const readResult = (stdout: string) => ({
			argv: [],
			cwd: "/repo",
			exitCode: 0,
			signal: null,
			stdout,
			stderr: "",
		});
		const activeSha = "7".repeat(40);
		const deliverySha = "8".repeat(40);
		const active = {
			...feature(),
			branch: "dev/improvements",
			primaryBranchRef: "fix/1203",
			branchLinks: [
				{
					ref: "fix/1203",
					role: "primary" as const,
					linkedAt: "2026-08-12T00:00:00.000Z",
					source: "feature_created" as const,
				},
				{
					ref: "dev/improvements",
					role: "continuation" as const,
					linkedAt: "2026-08-12T09:35:00.000Z",
					source: "reflog_checkout" as const,
					relation: {
						kind: "descends_from" as const,
						ref: "fix/1203",
					},
				},
			],
		};
		const inspect = vi.fn(
			async ({ featureBranch }: { featureBranch: string }) => {
				if (featureBranch === "dev/improvements") {
					return {
						...git(active),
						feature: known({ ref: "dev/improvements", sha: activeSha }),
						head: known({ ref: "dev/improvements", sha: activeSha }),
						featureInBase: known({
							ancestor: { ref: "dev/improvements", sha: activeSha },
							descendant: { ref: "main", sha: "3".repeat(40) },
							isAncestor: false,
						}),
					};
				}
				return git(featureBranch === "main" ? baseFeature() : feature());
			},
		);
		const fixture = setup(inspect);
		fixture.setFeatures([active]);
		fixture.context.featureManager.getFeatures = vi.fn(() => [active]);
		fixture.context.gitClient.read = vi.fn(async (args: readonly string[]) => {
			if (args[0] === "config") {
				return readResult(
					"remote.origin.url https://github.com/ShiidoTech/agent-space.git\n",
				);
			}
			if (args[0] === "rev-parse" && args[2]?.startsWith("fix/1203")) {
				return readResult(`${deliverySha}\n`);
			}
			return readResult("main\n");
		});
		const listPullRequests = vi.fn(async ({ head }: { head: string }) => {
			const base = { ref: "main" };
			if (head === "fix/1203") {
				return {
					status: "ok" as const,
					pulls: [
						{
							number: 900,
							html_url: "https://github.com/ShiidoTech/agent-space/pull/900",
							state: "closed" as const,
							merged: true,
							merged_at: "2026-08-11T10:00:00.000Z",
							draft: false,
							head: { ref: "fix/1203", sha: deliverySha },
							base,
						},
					],
				};
			}
			if (head === "dev/improvements") {
				return {
					status: "ok" as const,
					pulls: [
						{
							number: 1203,
							html_url: "https://github.com/ShiidoTech/agent-space/pull/1203",
							state: "closed" as const,
							merged: true,
							merged_at: "2026-08-12T10:00:00.000Z",
							draft: false,
							head: { ref: "dev/improvements", sha: activeSha },
							base,
						},
					],
				};
			}
			return { status: "ok" as const, pulls: [] };
		});
		const backend = {
			auth: vi.fn(async () => ({
				state: "authenticated" as const,
				source: "env" as const,
				token: "test",
			})),
			listPullRequests,
		} satisfies PullRequestBackend;
		const coordinator = new FeatureStateCoordinator(fixture.manager, {
			createGithubBackend: () => backend,
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
			},
		});

		await coordinator.reconcile();

		await vi.waitFor(() =>
			expect(coordinator.getSnapshot("f1")?.github).toMatchObject({
				queriedBranch: "dev/improvements",
				queriedHeadSha: activeSha,
			}),
		);
		const snapshot = coordinator.getSnapshot("f1");
		// Both PRs are merged into the expected base, but the continuation PR
		// proves the exact active head, so it wins as the delivery vector.
		expect(snapshot?.github).toMatchObject({
			queriedBranch: "dev/improvements",
			queriedHeadSha: activeSha,
		});
		expect(snapshot?.delivery).toMatchObject({
			branchRef: "fix/1203",
			deliveredVia: {
				branchRef: "dev/improvements",
				head: { ref: "dev/improvements", sha: activeSha },
				pullNumber: 1203,
			},
		});
		expect(snapshot?.integration).toMatchObject({
			status: "known",
			outcome: "integrated_by_pull_request",
		});
		expect(
			snapshot?.attention.some(
				(item) => item.code === "continuation_outside_delivery",
			),
		).toBe(false);
	});
});
