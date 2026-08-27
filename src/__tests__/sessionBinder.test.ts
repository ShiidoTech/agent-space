import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import type { ProviderSessionAdapter } from "../agents/providers/types";
import { SessionBinder } from "../agents/sessionBinder";
import type { SessionInfo } from "../agents/sessionProviders/types";
import type { TmuxIntegration } from "../agents/tmux";
import { ProjectManager } from "../projects/projectManager";
import { GlobalStore } from "../storage/globalStore";
import type { Agent, Feature } from "../types";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

const WORKTREE = "/tmp/agent-space-binder/feat-x";

function feature(overrides: Partial<Feature> = {}): Feature {
	return {
		id: "f1",
		name: "x",
		branch: "feat/x",
		worktreePath: WORKTREE,
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-08-09T07:00:00.000Z",
		...overrides,
	};
}

/** A stub adapter over a fixed session list, so timing is fully controlled. */
function adapter(
	sessions: SessionInfo[],
	correlateOwnedSession?: ProviderSessionAdapter["correlateOwnedSession"],
): ProviderSessionAdapter {
	const asyncCorrelate = correlateOwnedSession
		? async (cwd: string, known: ReadonlySet<string>) =>
				correlateOwnedSession(cwd, known)
		: undefined;
	return {
		toolId: "stub",
		readName: () => null,
		scanSessions: () => sessions,
		hasSession: (id) => sessions.some((s) => s.sessionId === id),
		correlateOwnedSession,
		async: {
			scanSessions: async () => sessions,
			hasSession: async (id) => sessions.some((s) => s.sessionId === id),
			readName: async () => null,
			correlateOwnedSession: asyncCorrelate,
		},
	};
}

function registry(sessionAdapter?: ProviderSessionAdapter): CodingToolRegistry {
	return {
		resolveAgentTool: (toolId?: string) => ({
			id: toolId ?? "stub",
			name: toolId ?? "stub",
			command: toolId ?? "stub",
			family: "generic" as const,
		}),
		resolveAgentToolForAgent: (agent: { toolId?: string }) => ({
			id: agent.toolId ?? "stub",
			name: agent.toolId ?? "stub",
			command: agent.toolId ?? "stub",
			family: "generic" as const,
		}),
		getProvider: () => ({
			id: "stub",
			capabilities: {
				launch: true,
				resume: true,
				sessionDiscovery: Boolean(sessionAdapter),
				sessionNaming: Boolean(sessionAdapter),
				attention: {
					"attention.working": false,
					"attention.waitingForUser": false,
					"attention.idle": false,
					"attention.failed": false,
				},
			},
			sessionAdapter,
		}),
		getSessionAdapterForAgent: () => sessionAdapter,
	} as unknown as CodingToolRegistry;
}

function tmux(alive = true): TmuxIntegration {
	return {
		sessionName: (featureId: string, agentId: string) =>
			`agent-space-${featureId}-${agentId}`,
		isSessionAlive: () => alive,
		isSessionAliveAsync: async () => alive,
	} as unknown as TmuxIntegration;
}

function setup(features: Feature[]) {
	const repoRoot = tempDir("binder-repo-");
	const storagePath = tempDir("binder-storage-");
	const globalStore = new GlobalStore(storagePath);
	const projectManager = new ProjectManager(globalStore, storagePath);
	const project = projectManager.addProject(repoRoot, "proj");
	const ctx = projectManager.getContext(project.id);
	if (!ctx) throw new Error("context should exist");
	ctx.store.saveFeatures(features);
	return { projectManager, ctx };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: null,
		tmuxSession: "agent-space-f1-a1",
		toolId: "stub",
		status: "running",
		hasStarted: true,
		createdAt: "2026-08-09T07:00:00.000Z",
		launchedAt: "2026-08-09T07:51:08.000Z",
		sessionBaseline: [],
		...overrides,
	};
}

describe("SessionBinder", () => {
	beforeEach(() => {
		vi.setSystemTime(new Date("2026-08-09T08:00:00.000Z"));
	});

	it("does not treat a sole late session as proof of ownership", () => {
		// The capture this replaces gave up after 7.5s. Real providers write the
		// session record on the first prompt: 105s later in the measured case.
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_late",
						prompt: "",
						created: "2026-08-09T07:52:53.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(outcomes[0]?.boundSessionId).toBeUndefined();
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.sessionId).toBeNull();
		expect(stored.sessionBinding?.state).toBe("ambiguous");
		expect(stored.sessionBinding?.detail).toContain(
			"ownership cannot be proven",
		);
	});

	it("does not treat a sole late session as proof of ownership through the async boundary", async () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_late",
						prompt: "",
						created: "2026-08-09T07:52:53.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = await binder.reconcileAllAsync();

		expect(outcomes[0]?.boundSessionId).toBeUndefined();
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.sessionId).toBeNull();
		expect(stored.sessionBinding?.state).toBe("ambiguous");
		expect(stored.sessionBinding?.detail).toContain(
			"ownership cannot be proven",
		);
	});

	it("binds a late session through the async boundary when the provider proves ownership", async () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const sessions: SessionInfo[] = [];
		const correlate = vi.fn(() => "ses_late");
		const binder = new SessionBinder(
			registry(adapter(sessions, correlate)),
			tmux(),
		);
		binder.start(projectManager, 0);

		await binder.reconcileAllAsync();
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBeNull();

		// The provider only writes the session on the first prompt, after the
		// first pass found nothing.
		sessions.push({
			sessionId: "ses_late",
			prompt: "",
			created: "2026-08-09T07:52:53.000Z",
			projectPath: WORKTREE,
		});
		const outcomes = await binder.reconcileAllAsync();

		expect(correlate).toHaveBeenCalledWith(WORKTREE, expect.any(Set));
		expect(outcomes[0]?.boundSessionId).toBe("ses_late");
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBe("ses_late");
	});

	it("binds a preassigned session that resolves in the async provider store", async () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture({ sessionId: "ses_claude" })]);
		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_claude",
						prompt: "",
						created: "2026-08-09T07:52:53.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = await binder.reconcileAllAsync();

		expect(outcomes[0]?.binding.state).toBe("bound");
		expect(outcomes[0]?.boundSessionId).toBeUndefined();
	});

	it("serializes overlapping async passes into a single scan", async () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const sessionList: SessionInfo[] = [];
		let resolveScan: ((sessions: SessionInfo[]) => void) | undefined;
		let scanCount = 0;
		const scanDeferred = new Promise<SessionInfo[]>((resolve) => {
			resolveScan = resolve;
		});
		const customAdapter: ProviderSessionAdapter = {
			toolId: "stub",
			readName: () => null,
			scanSessions: () => sessionList,
			hasSession: (id) => sessionList.some((s) => s.sessionId === id),
			async: {
				scanSessions: () => {
					scanCount += 1;
					return scanDeferred;
				},
				hasSession: async (id) => sessionList.some((s) => s.sessionId === id),
				readName: async () => null,
			},
		};
		const binder = new SessionBinder(registry(customAdapter), tmux());
		binder.start(projectManager, 0);

		const first = binder.reconcileAllAsync();
		const second = binder.reconcileAllAsync();
		expect(second).toBe(first);

		resolveScan?.(sessionList);
		await first;

		expect(scanCount).toBe(1);
	});

	it("allows a user-selected session to be attached with worktree and uniqueness checks", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_selected",
						prompt: "Implement the selected task",
						created: "2026-08-09T07:52:53.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		expect(binder.listAttachableSessions("f1", "a1")).toHaveLength(1);
		expect(binder.attachExplicitly("f1", "a1", "ses_selected")).toBe(true);
		expect(ctx.store.loadAgents("f1")[0]).toMatchObject({
			sessionId: "ses_selected",
			sessionBinding: { state: "bound" },
		});
	});

	it("refuses attachment when the session is already owned by a base agent", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const base = ctx.featureManager.getBaseFeature(ctx.project.id);
		ctx.store.saveAgents(base.id, [
			agentFixture({
				id: "base-owner",
				featureId: base.id,
				sessionId: "ses_selected",
				tmuxSession: "agent-space-base-owner",
			}),
		]);
		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_selected",
						prompt: "Already owned by the base agent",
						created: "2026-08-09T07:52:53.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		expect(binder.attachExplicitly("f1", "a1", "ses_selected")).toBe(false);
		expect(binder.listAttachableSessions("f1", "a1")).toEqual([]);
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBeNull();
	});

	it("lets two shared-worktree agents bind the explicitly selected sessions", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ id: "a1", name: "Agent 1" }),
			agentFixture({ id: "a2", name: "Agent 2" }),
		]);
		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "session_a",
						prompt: "Conversation A",
						created: "2026-08-09T07:52:00.000Z",
						projectPath: WORKTREE,
					},
					{
						sessionId: "session_b",
						prompt: "Conversation B",
						created: "2026-08-09T07:53:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		expect(binder.listAttachableSessions("f1", "a2")).toHaveLength(2);
		expect(binder.attachExplicitly("f1", "a2", "session_b")).toBe(true);
		expect(binder.listAttachableSessions("f1", "a1")).toEqual([
			expect.objectContaining({ sessionId: "session_a" }),
		]);
		expect(binder.attachExplicitly("f1", "a1", "session_a")).toBe(true);

		expect(ctx.store.loadAgents("f1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "a1",
					sessionId: "session_a",
					sessionBinding: expect.objectContaining({ state: "bound" }),
				}),
				expect.objectContaining({
					id: "a2",
					sessionId: "session_b",
					sessionBinding: expect.objectContaining({ state: "bound" }),
				}),
			]),
		);
	});

	it("refuses an explicit session from another worktree or a vanished store", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "wrong-cwd",
						prompt: "Other worktree",
						created: "2026-08-09T07:52:00.000Z",
						projectPath: "/tmp/another-worktree",
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		expect(binder.listAttachableSessions("f1", "a1")).toEqual([]);
		expect(binder.attachExplicitly("f1", "a1", "wrong-cwd")).toBe(false);
		expect(binder.attachExplicitly("f1", "a1", "vanished")).toBe(false);
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBeNull();
	});

	it("binds a new session only when a provider supplies strong ownership proof", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const correlateOwnedSession = vi.fn(() => "ses_provider_owned");
		const binder = new SessionBinder(
			registry(
				adapter(
					[
						{
							sessionId: "ses_provider_owned",
							prompt: "",
							created: "2026-08-09T07:52:53.000Z",
							projectPath: WORKTREE,
						},
					],
					correlateOwnedSession,
				),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(correlateOwnedSession).toHaveBeenCalledWith(WORKTREE, new Set());
		expect(outcomes[0]?.boundSessionId).toBe("ses_provider_owned");
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBe("ses_provider_owned");
	});

	it("binds a preassigned session when the provider store resolves it", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture({ sessionId: "ses_claude" })]);
		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_claude",
						prompt: "",
						created: "2026-08-09T07:52:53.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(outcomes[0]?.binding.state).toBe("bound");
		expect(outcomes[0]?.boundSessionId).toBeUndefined();
	});

	it("never adopts a session that existed before the agent launched", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ sessionBaseline: ["ses_neighbour"] }),
		]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_neighbour",
						prompt: "",
						created: "2026-08-09T07:55:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(outcomes[0]?.boundSessionId).toBeUndefined();
		expect(outcomes[0]?.binding.state).toBe("pending");
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBeNull();
	});

	it("never swaps two agents when the sessions appear in the opposite order", () => {
		// The regression this guards: agents were served oldest-launch-first
		// against sessions sorted oldest-created-first. Those two orders are
		// unrelated, because a session is created on the first prompt. Launch A
		// then B, then talk to B before A, and the old rule handed A's session to
		// B and B's to A — silently, and looking bound.
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({
				id: "a1",
				name: "Agent 1",
				tmuxSession: "agent-space-f1-a1",
				launchedAt: "2026-08-09T07:51:00.000Z",
			}),
			agentFixture({
				id: "a2",
				name: "Agent 2",
				tmuxSession: "agent-space-f1-a2",
				launchedAt: "2026-08-09T07:52:00.000Z",
			}),
		]);

		const binder = new SessionBinder(
			registry(
				adapter([
					// Prompted first, but belongs to the agent launched second.
					{
						sessionId: "ses_for_a2",
						prompt: "",
						created: "2026-08-09T07:55:00.000Z",
						projectPath: WORKTREE,
					},
					{
						sessionId: "ses_for_a1",
						prompt: "",
						created: "2026-08-09T07:56:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		binder.reconcileAll();

		const stored = ctx.store.loadAgents("f1");
		for (const id of ["a1", "a2"]) {
			const agent = stored.find((a) => a.id === id);
			expect(agent?.sessionId).toBeNull();
			expect(agent?.sessionBinding?.state).toBe("ambiguous");
		}
	});

	it("does not use launch timing to adopt a shared-worktree session", () => {
		// a2 launched after the only session was created, so it cannot own it and
		// a1 is the single possible claimant.
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({
				id: "a1",
				name: "Agent 1",
				tmuxSession: "agent-space-f1-a1",
				launchedAt: "2026-08-09T07:51:00.000Z",
			}),
			agentFixture({
				id: "a2",
				name: "Agent 2",
				tmuxSession: "agent-space-f1-a2",
				launchedAt: "2026-08-09T07:53:00.000Z",
			}),
		]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_first",
						prompt: "",
						created: "2026-08-09T07:52:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		binder.reconcileAll();

		const stored = ctx.store.loadAgents("f1");
		expect(stored.find((a) => a.id === "a1")?.sessionId).toBeNull();
		expect(stored.find((a) => a.id === "a2")?.sessionId).toBeNull();
		expect(stored.find((a) => a.id === "a1")?.sessionBinding?.state).toBe(
			"ambiguous",
		);
		expect(stored.find((a) => a.id === "a2")?.sessionBinding?.state).toBe(
			"pending",
		);
	});

	it("refuses to pick when one agent has several possible sessions", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_a",
						prompt: "",
						created: "2026-08-09T07:52:00.000Z",
						projectPath: WORKTREE,
					},
					// A session the human started by hand in the same worktree is
					// indistinguishable from the agent's own.
					{
						sessionId: "ses_b",
						prompt: "",
						created: "2026-08-09T07:53:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(outcomes[0]?.boundSessionId).toBeUndefined();
		expect(outcomes[0]?.binding.state).toBe("ambiguous");
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBeNull();
	});

	it("does not let a dead agent claim a session created after it stopped", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_someone_else",
						prompt: "",
						created: "2026-08-09T07:59:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(false),
		);
		binder.start(projectManager, 0);

		binder.reconcileAll();

		expect(ctx.store.loadAgents("f1")[0].sessionId).toBeNull();
	});

	it("reports a stored session id the provider has never heard of as unverified", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ sessionId: "pre-assigned-uuid" }),
		]);

		const binder = new SessionBinder(registry(adapter([])), tmux());
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(outcomes[0]?.binding.state).toBe("unverified");
		// The value is reported, never silently erased.
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBe("pre-assigned-uuid");
	});

	it("does not replace an unverified id with an unproven new session", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ sessionId: "pre-assigned-uuid" }),
		]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "real-session",
						prompt: "",
						created: "2026-08-09T07:52:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(outcomes[0]?.boundSessionId).toBeUndefined();
		expect(outcomes[0]?.binding.state).toBe("ambiguous");
		expect(ctx.store.loadAgents("f1")[0].sessionId).toBe("pre-assigned-uuid");
	});

	it("marks a provider with no session store as unsupported rather than pending forever", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const binder = new SessionBinder(registry(undefined), tmux());
		binder.start(projectManager, 0);

		const outcomes = binder.reconcileAll();

		expect(outcomes[0]?.binding.state).toBe("unsupported");
	});

	it("records the pre-launch baseline so a restart cannot lose it", () => {
		const { projectManager, ctx } = setup([feature()]);
		const agent = agentFixture({
			sessionBaseline: undefined,
			launchedAt: undefined,
		});
		ctx.store.saveAgents("f1", [agent]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_existing",
						prompt: "",
						created: "2026-08-09T07:00:00.000Z",
						projectPath: WORKTREE,
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		binder.recordLaunch(ctx, "f1", agent, WORKTREE);

		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.sessionBaseline).toEqual(["ses_existing"]);
		expect(stored.launchedAt).toBeTruthy();
		expect(stored.sessionBinding?.state).toBe("pending");
	});

	it("ignores sessions from another worktree", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const binder = new SessionBinder(
			registry(
				adapter([
					{
						sessionId: "ses_elsewhere",
						prompt: "",
						created: "2026-08-09T07:55:00.000Z",
						projectPath: "/tmp/agent-space-binder/other",
					},
				]),
			),
			tmux(),
		);
		binder.start(projectManager, 0);

		binder.reconcileAll();

		expect(ctx.store.loadAgents("f1")[0].sessionId).toBeNull();
	});

	it("re-checks a stale bound binding and reports a session that disappeared", () => {
		// Binding is a reconciled state, not a verdict: a repointed profile or a
		// deleted transcript must stop being asserted as bound.
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({
				sessionId: "ses_gone",
				sessionBinding: {
					state: "bound",
					checkedAt: "2026-08-09T07:00:00.000Z",
					attempts: 1,
					detail: "Adopted the session this agent started",
				},
			}),
		]);

		const binder = new SessionBinder(registry(adapter([])), tmux());
		binder.start(projectManager, 0);

		binder.reconcileAll();

		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.sessionBinding?.state).toBe("unverified");
		// The id is reported, never silently rewritten.
		expect(stored.sessionId).toBe("ses_gone");
	});

	it("does not re-scan the store for a binding checked moments ago", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({
				sessionId: "ses_ok",
				sessionBinding: {
					state: "bound",
					checkedAt: "2026-08-09T07:59:30.000Z",
					attempts: 1,
					detail: "Adopted the session this agent started",
				},
			}),
		]);

		const stub = adapter([]);
		const hasSession = vi.fn(() => false);
		stub.hasSession = hasSession;

		const binder = new SessionBinder(registry(stub), tmux());
		binder.start(projectManager, 0);

		binder.reconcileAll();

		expect(hasSession).not.toHaveBeenCalled();
		expect(ctx.store.loadAgents("f1")[0].sessionBinding?.state).toBe("bound");
	});

	it("does not persist identical pending reconciliations repeatedly", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const saveAgents = vi.spyOn(ctx.store, "saveAgents");
		const binder = new SessionBinder(registry(adapter([])), tmux());
		binder.start(projectManager, 0);

		binder.reconcileAll();
		const writesAfterFirst = saveAgents.mock.calls.length;
		binder.reconcileAll();
		binder.reconcileAll();

		expect(writesAfterFirst).toBe(1);
		expect(saveAgents).toHaveBeenCalledTimes(writesAfterFirst);
		expect(ctx.store.loadAgents("f1")[0].sessionBinding?.attempts).toBe(0);
	});

	it("refreshes a stale bound check once and reuses its five-minute window", () => {
		const { projectManager, ctx } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({
				sessionId: "ses_ok",
				sessionBinding: {
					state: "bound",
					checkedAt: "2026-08-09T07:00:00.000Z",
					attempts: 1,
					detail: "Adopted the session this agent started",
				},
			}),
		]);
		const stub = adapter([]);
		const hasSession = vi.fn(() => true);
		stub.hasSession = hasSession;
		const binder = new SessionBinder(registry(stub), tmux());
		binder.start(projectManager, 0);

		binder.reconcileAll();
		vi.setSystemTime(new Date("2026-08-09T08:01:00.000Z"));
		binder.reconcileAll();
		vi.setSystemTime(new Date("2026-08-09T13:01:00.000Z"));
		binder.reconcileAll();

		expect(hasSession).toHaveBeenCalledTimes(2);
		expect(ctx.store.loadAgents("f1")[0].sessionBinding?.checkedAt).toBe(
			"2026-08-09T13:01:00.000Z",
		);
	});

	it("asks the provider for a fresh launch baseline", () => {
		const { projectManager, ctx } = setup([feature()]);
		const agent = agentFixture({
			sessionBaseline: undefined,
			launchedAt: undefined,
		});
		ctx.store.saveAgents("f1", [agent]);
		const sessions: SessionInfo[] = [
			{
				sessionId: "before",
				prompt: "",
				created: "2026-08-09T07:00:00.000Z",
				projectPath: WORKTREE,
			},
		];
		const scanSessions = vi.fn((options?: { fresh?: boolean }) =>
			options?.fresh
				? [
						...sessions,
						{
							sessionId: "just-before-launch",
							prompt: "",
							created: "2026-08-09T07:59:59.000Z",
							projectPath: WORKTREE,
						},
					]
				: sessions.slice(0, 1),
		);
		const sessionAdapter = adapter(sessions);
		sessionAdapter.scanSessions = scanSessions;
		const binder = new SessionBinder(registry(sessionAdapter), tmux());
		binder.start(projectManager, 0);

		binder.recordLaunch(ctx, "f1", agent, WORKTREE);

		expect(scanSessions).toHaveBeenCalledWith({ fresh: true });
		expect(ctx.store.loadAgents("f1")[0].sessionBaseline).toContain(
			"just-before-launch",
		);
	});
});
