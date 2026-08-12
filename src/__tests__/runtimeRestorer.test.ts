import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingToolRegistry } from "../agents/codingToolRegistry";
import type { CodingAgentProvider } from "../agents/providers/types";
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
							family: "opencode",
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
	return { ...actual, exec: vi.fn(() => "") };
});

const execMock = vi.mocked(platform.exec);

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
		isAvailable: () => st.available,
		sessionName: (label: string, agentId: string) =>
			`agent-space-${label}-${agentId}`,
		legacySessionName: (featureId: string, agentId: string) =>
			`agent-space-${featureId}-${agentId}`,
		adoptSession: (preferred: string, current: string) =>
			st.alive.has(preferred) || st.alive.has(current),
		createCommand: (sessionName: string, innerCommand: string) => {
			st.created.push(sessionName);
			if (spawnMakesAlive) st.alive.add(sessionName);
			return `tmux new-session -d -s ${sessionName} -- ${innerCommand}`;
		},
		configureSession: (sessionName: string) => {
			st.configured.push(sessionName);
		},
		isSessionAlive: (sessionName: string) => st.alive.has(sessionName),
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

function runRestore({
	projectManager,
	registry,
	st,
	provider: prov,
}: RestoreArgs): {
	report: RuntimeRestoreReport;
	st: TmuxState;
	projectManager: ProjectManager;
} {
	if (prov) {
		vi.spyOn(registry, "getProvider").mockReturnValue(prov);
	}
	const report = restoreAgentRuntimes({
		projectManager,
		tmux: tmux(st),
		toolRegistry: registry,
	});
	return { report, st, projectManager };
}

describe("restoreAgentRuntimes", () => {
	it("does nothing when tmux is unavailable", () => {
		const { projectManager, ctx, registry, st } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		st.available = false;

		const { report } = runRestore({
			projectManager,
			registry,
			st,
		});

		expect(report.considered).toBe(0);
		expect(execMock).not.toHaveBeenCalled();
	});

	it("reattaches an agent whose tmux session survived the restart", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		st.alive.add("agent-space-f1-a1");

		const { report } = runRestore({ projectManager, registry, st });

		expect(report.considered).toBe(1);
		expect(report.reattached).toHaveLength(1);
		expect(report.resumed).toHaveLength(0);
		expect(execMock).not.toHaveBeenCalled();
		expect(st.created).toHaveLength(0);
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.restore?.state).toBe("reattached");
	});

	it("ignores agents that never started and agents that are done", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [
			agentFixture({ id: "a-done", status: "done", hasStarted: true }),
			agentFixture({ id: "a-fresh", status: "idle", hasStarted: false }),
			agentFixture(),
		]);

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.resumed).toHaveLength(1);
		expect(report.resumed[0]?.agentId).toBe("a1");
	});

	it("resumes with a strictly built provider command when the session is proven", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.resumed).toHaveLength(1);
		expect(execMock).toHaveBeenCalledTimes(1);
		const [command] = execMock.mock.calls[0] ?? [];
		expect(command).toContain("stub --session ses_resume");
		expect(st.created).toEqual(["agent-space-f1-a1"]);
		expect(st.configured).toEqual(["agent-space-f1-a1"]);
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.status).toBe("running");
		expect(stored.restore).toMatchObject({ state: "resumed" });
	});

	it("blocks an agent whose persisted session id no longer exists", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: provider({
				sessionAdapter: {
					toolId: "stub",
					readName: () => null,
					scanSessions: () => [],
					hasSession: vi.fn(() => false),
				},
			}),
		});

		expect(report.considered).toBe(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("verif");
		expect(execMock).not.toHaveBeenCalled();
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.restore?.state).toBe("blocked");
	});

	it("blocks an agent with no persisted session id instead of launching fresh", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture({ sessionId: null })]);

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("session id");
		expect(execMock).not.toHaveBeenCalled();
	});

	it("blocks an agent whose provider cannot resume", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: provider({ capabilities: withoutResume }),
		});

		expect(report.considered).toBe(1);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0]?.reason).toContain("resume capability");
		expect(execMock).not.toHaveBeenCalled();
	});

	it("trusts a previously persisted bound verdict when the provider has no session store", () => {
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

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: prov,
		});

		expect(report.considered).toBe(1);
		expect(report.resumed).toHaveLength(1);
		const [command] = execMock.mock.calls[0] ?? [];
		expect(command).toContain("stub --session ses_resume");
	});

	it("uses a declared resumeCommand template when the tool provides one", () => {
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

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.resumed).toHaveLength(1);
		const [command] = execMock.mock.calls[0] ?? [];
		expect(command).toContain("stub --resume ses_resume");
	});

	it("is idempotent: a second pass reattaches instead of resuming again", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		const prov = provider();
		vi.spyOn(registry, "getProvider").mockReturnValue(prov);

		restoreAgentRuntimes({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		const report = restoreAgentRuntimes({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		expect(report.considered).toBe(1);
		expect(report.reattached).toHaveLength(1);
		expect(report.resumed).toHaveLength(0);
		expect(execMock).toHaveBeenCalledTimes(1);
	});

	it("blocks when the recreated tmux session does not stay alive", () => {
		const { ctx, registry, st, projectManager } = setup([feature()]);
		ctx.store.saveAgents("f1", [agentFixture()]);
		vi.spyOn(registry, "getProvider").mockReturnValue(provider());
		// A spawn that died on arrival: the session is recorded as created but
		// never becomes alive.
		const deadTmux = tmux(st, false);

		const report = restoreAgentRuntimes({
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

	it("recovers agents on the base feature (repo root) as well", () => {
		const { ctx, registry, st, projectManager } = setup([]);
		const base = ctx.featureManager.getBaseFeature(ctx.project.id);
		ctx.store.saveAgents(base.id, [agentFixture({ id: "base-agent" })]);

		const { report } = runRestore({
			projectManager,
			registry,
			st,
			provider: provider(),
		});

		expect(report.considered).toBe(1);
		expect(report.resumed[0]?.agentId).toBe("base-agent");
	});
});
