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
function adapter(sessions: SessionInfo[]): ProviderSessionAdapter {
	return {
		toolId: "stub",
		readName: () => null,
		scanSessions: () => sessions,
		hasSession: (id) => sessions.some((s) => s.sessionId === id),
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
	} as unknown as CodingToolRegistry;
}

function tmux(alive = true): TmuxIntegration {
	return {
		sessionName: (featureId: string, agentId: string) =>
			`agent-space-${featureId}-${agentId}`,
		isSessionAlive: () => alive,
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

	it("binds a session that appears long after the launch window closed", () => {
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

		expect(outcomes[0]?.boundSessionId).toBe("ses_late");
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.sessionId).toBe("ses_late");
		expect(stored.sessionBinding?.state).toBe("bound");
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

	it("gives two agents in one worktree two different sessions, oldest launch first", () => {
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
						sessionId: "ses_second",
						prompt: "",
						created: "2026-08-09T07:54:00.000Z",
						projectPath: WORKTREE,
					},
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
		expect(stored.find((a) => a.id === "a1")?.sessionId).toBe("ses_first");
		// a2 launched after ses_first was created, so it cannot claim it.
		expect(stored.find((a) => a.id === "a2")?.sessionId).toBe("ses_second");
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

	it("adopts the real session when a pre-assigned id never materialised", () => {
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

		expect(outcomes[0]?.boundSessionId).toBe("real-session");
		expect(outcomes[0]?.binding.detail).toContain("pre-assigned");
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
});
