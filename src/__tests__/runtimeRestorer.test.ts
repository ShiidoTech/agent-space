import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CodingToolRegistry,
	openCodeBackendManager,
} from "../agents/codingToolRegistry";
import type { CodingAgentProvider } from "../agents/providers/types";
import {
	RuntimeOwnershipGuard,
	runtimeOwnershipKey,
	withRuntimeSpawnLock,
	withRuntimeSpawnLockSync,
} from "../agents/runtimeOwnership";
import {
	type RuntimeRestoreReport,
	restoreAgentRuntimes,
} from "../agents/runtimeRestorer";
import type { TmuxIntegration } from "../agents/tmux";
import { ProjectManager } from "../projects/projectManager";
import { GlobalStore } from "../storage/globalStore";
import type { Agent, Feature } from "../types";
import * as platform from "../utils/platform";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (key: string, defaultValue?: unknown) => {
				if (key === "codingTools") {
					return [
						{
							enabled: true,
							id: "stub",
							name: "Stub",
							command: "stub",
							family: "hermes",
						},
					];
				}
				return defaultValue;
			},
		})),
	},
}));

vi.mock("../utils/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/platform")>();
	return {
		...actual,
		exec: vi.fn(() => ""),
		execAsync: vi.fn(async (command: string) => command),
	};
});

const execMock = vi.mocked(platform.exec);
const execAsyncMock = vi.mocked(platform.execAsync);

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
	execMock.mockClear();
	execAsyncMock.mockClear();
	vi.restoreAllMocks();
});

const WORKTREE = "/tmp/agent-space-restorer/feat-x";

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

function agentFixture(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: "ses_resume",
		tmuxSession: undefined,
		toolId: "stub",
		status: "running",
		hasStarted: true,
		createdAt: "2026-08-09T07:00:00.000Z",
		launchedAt: "2026-08-09T07:51:08.000Z",
		sessionBaseline: [],
		...overrides,
	};
}

interface TmuxState {
	available: boolean;
	alive: Set<string>;
	created: string[];
	configured: string[];
}

function tmuxState(): TmuxState {
	return { available: true, alive: new Set(), created: [], configured: [] };
}

function tmux(st: TmuxState, spawnMakesAlive = true): TmuxIntegration {
	return {
		isAvailable: () => {
			throw new Error("sync tmux API used by runtime restore");
		},
		isAvailableAsync: async () => st.available,
		sessionName: (label: string, agentId: string) =>
			`agent-space-${label}-${agentId}`,
		legacySessionName: (featureId: string, agentId: string) =>
			`agent-space-${featureId}-${agentId}`,
		adoptSession: () => {
			throw new Error("sync tmux API used by runtime restore");
		},
		adoptSessionAsync: async (preferred: string, current: string) =>
			st.alive.has(preferred) || st.alive.has(current),
		createCommand: (sessionName: string, innerCommand: string) => {
			st.created.push(sessionName);
			if (spawnMakesAlive) st.alive.add(sessionName);
			return `tmux new-session -d -s ${sessionName} -- ${innerCommand}`;
		},
		configureSession: (sessionName: string) => {
			throw new Error(`sync tmux API used by runtime restore: ${sessionName}`);
		},
		configureSessionAsync: async (sessionName: string) => {
			st.configured.push(sessionName);
		},
		isSessionAlive: () => {
			throw new Error("sync tmux API used by runtime restore");
		},
		isSessionAliveAsync: async (sessionName: string) =>
			st.alive.has(sessionName),
	} as unknown as TmuxIntegration;
}

function provider(
	overrides: Partial<CodingAgentProvider> = {},
): CodingAgentProvider {
	return {
		id: "stub",
		conversationIdentity: { ownership: "provider_assigned" },
		capabilities: {
			launch: true,
			resume: true,
			sessionDiscovery: false,
			sessionNaming: false,
			attention: {
				"attention.working": false,
				"attention.waitingForUser": false,
				"attention.idle": false,
				"attention.failed": false,
			},
		},
		resumeArgs: (sessionId: string) => ["--session", sessionId],
		sessionAdapter: {
			toolId: "stub",
			readName: () => null,
			scanSessions: () => [],
			hasSession: vi.fn(() => true),
			async: { hasSession: vi.fn(async () => true) },
		},
		...overrides,
	} as CodingAgentProvider;
}

const withoutResume: CodingAgentProvider["capabilities"] = {
	launch: true,
	resume: false,
	sessionDiscovery: false,
	sessionNaming: false,
	attention: {
		"attention.working": false,
		"attention.waitingForUser": false,
		"attention.idle": false,
		"attention.failed": false,
	},
};

function setup(features: Feature[]) {
	const repoRoot = tempDir("restorer-repo-");
	const storagePath = tempDir("restorer-storage-");
	const globalStore = new GlobalStore(storagePath);
	const registry = new CodingToolRegistry();
	const st = tmuxState();
	const projectManager = new ProjectManager(
		globalStore,
		storagePath,
		".worktrees",
		tmux(st),
		registry,
	);
	const project = projectManager.addProject(repoRoot, "proj");
	const ctx = projectManager.getContext(project.id);
	if (!ctx) throw new Error("context should exist");
	ctx.store.saveFeatures(features);
	return { projectManager, ctx, registry, st };
}

interface RestoreArgs {
	projectManager: ProjectManager;
	registry: CodingToolRegistry;
	st: TmuxState;
	provider?: CodingAgentProvider;
}

async function runRestore({
	projectManager,
	registry,
	st,
	provider: prov,
}: RestoreArgs): Promise<{
	report: RuntimeRestoreReport;
	st: TmuxState;
	projectManager: ProjectManager;
}> {
	if (prov) {
		vi.spyOn(registry, "getProvider").mockReturnValue(prov);
	}
	const report = await restoreAgentRuntimes({
		projectManager,
		tmux: tmux(st),
		toolRegistry: registry,
	});
	return { report, st, projectManager };
}

describe("restoreAgentRuntimes", () => {
	it("namespaces ownership locks by Hermes profile", () => {
		const a = agentFixture({ hermesProfile: "profile-a" });
		const b = agentFixture({ hermesProfile: "profile-b" });
		const bSame = agentFixture({ hermesProfile: "profile-a" });
		expect(runtimeOwnershipKey(a)).not.toBe(runtimeOwnershipKey(b));
		expect(runtimeOwnershipKey(a)).toBe(runtimeOwnershipKey(bSame));
	});
	it("filters the live owner guard by Hermes profile, not only session id", async () => {
		const { projectManager, ctx, registry, st } = setup([feature()]);
		const sessionId = "shared-hermes-session";
		ctx.store.saveAgents("f1", [
			agentFixture({ id: "a", sessionId, hermesProfile: "profile-a" }),
			agentFixture({ id: "b", sessionId, hermesProfile: "profile-b" }),
		]);
		st.alive.add("agent-space-f1-a");
		vi.spyOn(registry, "resolveAgentToolForAgent").mockImplementation(() => ({
			id: "hermes",
			name: "Hermes",
			command: "hermes",
			family: "hermes",
			provider: provider(),
		}));
		const guard = new RuntimeOwnershipGuard(projectManager, tmux(st), registry);

		expect((await guard.checkResume(sessionId, "b", "profile-b")).allowed).toBe(
			true,
		);
		expect((await guard.checkResume(sessionId, "b", "profile-a")).allowed).toBe(
			false,
		);
	});

	it("serializes three waiters on one ownership lock", async () => {
		const order: number[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withRuntimeSpawnLock("profile:session", async () => {
			order.push(1);
			await gate;
			return 1;
		});
		const second = withRuntimeSpawnLock("profile:session", async () => {
			order.push(2);
			return 2;
		});
		const third = withRuntimeSpawnLock("profile:session", async () => {
			order.push(3);
			return 3;
		});
		await Promise.resolve();
		expect(order).toEqual([1]);
		release();
		expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
		expect(order).toEqual([1, 2, 3]);
	});
	it("rejects a sync terminal reservation while restore owns the session lock", async () => {
		const key = "profile-a:session-x";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const restore = withRuntimeSpawnLock(key, async () => {
			await gate;
			return "restore";
		});
		await Promise.resolve();
		const syncSpawn = withRuntimeSpawnLockSync(key, () => "terminal");
		expect(syncSpawn).toBeUndefined();
		release();
		expect(await restore).toBe("restore");
		expect(withRuntimeSpawnLockSync(key, () => "terminal")).toBe("terminal");
	});

	it("does nothing when tmux is unavailable", async () => {
		const { projectManager, ctx, registry, st } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		st.available = false;

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
		});

		expect(report.considered).toBe(0);
		expect(execAsyncMock).not.toHaveBeenCalled();
	});

	it("reattaches an agent whose tmux session survived the restart", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		st.alive.add("agent-space-f1-a1");

		const { report } = await runRestore({ projectManager, registry, st });

		expect(report.considered).toBe(1);
		expect(report.reattached).toHaveLength(1);
		expect(report.resumed).toHaveLength(0);
		expect(execAsyncMock).not.toHaveBeenCalled();
		expect(st.created).toHaveLength(0);
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.restore?.state).toBe("reattached");
	});

	it("ignores agents that never started and agents that are done", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ id: "a-done", status: "done", hasStarted: true }),
			agentFixture({ id: "a-fresh", status: "idle", hasStarted: false }),
			agentFixture(),
		]);

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.resumed).toHaveLength(1);
		expect(report.resumed[0]?.agentId).toBe("a1");
	});

	it("resumes with a strictly built provider command when the session is proven", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.resumed).toHaveLength(1);
		expect(execAsyncMock).toHaveBeenCalledTimes(1);
		const [command] = execAsyncMock.mock.calls[0] ?? [];
		expect(command).toContain("stub --session ses_resume");
		expect(st.created).toEqual(["agent-space-f1-a1"]);
		expect(st.configured).toEqual(["agent-space-f1-a1"]);
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.status).toBe("running");
		expect(stored.restore).toMatchObject({ state: "resumed" });
	});

	it("blocks only an OpenCode agent when its backend cannot be ensured", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ id: "oc-a", toolId: "opencode" }),
			agentFixture({ id: "agent-b", toolId: "stub" }),
		]);
		const opencodeTool = {
			id: "opencode",
			name: "OpenCode",
			command: "opencode",
			family: "opencode" as const,
		};
		const opencodeProvider = provider({ id: "opencode" });
		vi.spyOn(registry, "resolveAgentToolForAgent").mockImplementation(
			(agent) =>
				agent.toolId === "opencode"
					? ({ ...opencodeTool, provider: opencodeProvider } as never)
					: registry.resolveAgentTool("stub"),
		);
		vi.spyOn(registry, "getProvider").mockImplementation((tool) =>
			tool.id === "opencode" ? opencodeProvider : provider(),
		);
		vi.spyOn(openCodeBackendManager, "ensure").mockRejectedValue(
			new Error("backend unavailable"),
		);

		const report = await restoreAgentRuntimes({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		expect(report.blocked.map((item) => item.agentId)).toContain("oc-a");
		expect(report.resumed.map((item) => item.agentId)).toContain("agent-b");
		expect(st.created).toEqual(["agent-space-f1-agent-b"]);
		expect(execAsyncMock).toHaveBeenCalledTimes(1);
	});

	it("blocks an agent whose persisted session id no longer exists", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: provider({
				sessionAdapter: {
					toolId: "stub",
					readName: () => null,
					scanSessions: () => [],
					hasSession: vi.fn(() => false),
					async: { hasSession: vi.fn(async () => false) },
				},
			}),
		});

		expect(report.considered).toBe(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("verif");
		expect(execAsyncMock).not.toHaveBeenCalled();
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.restore?.state).toBe("blocked");
	});

	it("blocks an agent with no persisted session id instead of launching fresh", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture({ sessionId: null })]);

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("session id");
		expect(execAsyncMock).not.toHaveBeenCalled();
	});

	it("blocks an agent whose provider cannot resume", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: provider({ capabilities: withoutResume }),
		});

		expect(report.considered).toBe(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("resume capability");
		expect(execAsyncMock).not.toHaveBeenCalled();
	});

	it("trusts a previously persisted bound verdict when the provider has no session store", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({
				sessionBinding: {
					state: "bound" as const,
					checkedAt: "2026-08-09T07:52:53.000Z",
					attempts: 1,
					detail: "verified",
				},
			}),
		]);
		// Provider without a session store: capabilities resume, no adapter.
		const prov = provider() as CodingAgentProvider;
		delete (prov as { sessionAdapter?: unknown }).sessionAdapter;

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: prov,
		});

		expect(report.considered).toBe(1);
		expect(report.resumed).toHaveLength(1);
		const [command] = execAsyncMock.mock.calls[0] ?? [];
		expect(command).toContain("stub --session ses_resume");
	});

	it("uses a declared resumeCommand template when the tool provides one", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		// Tool-level resumeCommand overrides provider resume args entirely.
		vi.spyOn(registry, "getTool").mockReturnValue({
			id: "stub",
			name: "Stub",
			command: "stub",
			family: "opencode",
			resumeCommand: "{command} --resume {sessionId}",
		});

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.resumed).toHaveLength(1);
		const [command] = execAsyncMock.mock.calls[0] ?? [];
		expect(command).toContain("stub --resume ses_resume");
	});

	it("is idempotent: a second pass reattaches instead of resuming again", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const prov = provider();
		vi.spyOn(registry, "getProvider").mockReturnValue(prov);

		await restoreAgentRuntimes({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		const report = await restoreAgentRuntimes({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		expect(report.considered).toBe(1);
		expect(report.reattached).toHaveLength(1);
		expect(report.resumed).toHaveLength(0);
		expect(execAsyncMock).toHaveBeenCalledTimes(1);
	});

	it("refuses to resume a session owned by another live runtime", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ id: "a-live", tmuxSession: "agent-space-f1-a-live" }),
			agentFixture({
				id: "b-recover",
				tmuxSession: "agent-space-f1-b-recover",
			}),
		]);
		st.alive.add("agent-space-f1-a-live");
		vi.spyOn(registry, "getProvider").mockReturnValue(provider());

		const report = await restoreAgentRuntimes({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		expect(report.reattached).toHaveLength(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("already owned");
		expect(st.created).toHaveLength(0);
	});

	it("coalesces concurrent restorations into one spawn", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		vi.spyOn(registry, "getProvider").mockReturnValue(provider());

		const deps = { projectManager, tmux: tmux(st), toolRegistry: registry };
		const [first, second] = await Promise.all([
			restoreAgentRuntimes(deps),
			restoreAgentRuntimes(deps),
		]);

		expect(first.resumed).toHaveLength(1);
		expect(second.reattached).toHaveLength(1);
		expect(st.created).toEqual(["agent-space-f1-a1"]);
		expect(execAsyncMock).toHaveBeenCalledTimes(1);
	});
	it("blocks when the recreated tmux session does not stay alive", async () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		vi.spyOn(registry, "getProvider").mockReturnValue(provider());
		// A spawn that died on arrival: the session is recorded as created but
		// never becomes alive.
		const deadTmux = tmux(st, false);

		const report = await restoreAgentRuntimes({
			projectManager,
			tmux: deadTmux,
			toolRegistry: registry,
		});

		expect(report.considered).toBe(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("stay alive");
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.restore?.state).toBe("blocked");
	});

	it("recovers agents on the base feature (repo root) as well", async () => {
		const { ctx, registry, st, projectManager } = setup([]);
		const base = ctx.featureManager.getBaseFeature(ctx.project.id);
		ctx.store.saveAgents(base.id, [agentFixture({ id: "base-agent" })]);

		const { report } = await runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.resumed[0]?.agentId).toBe("base-agent");
	});
});
