import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CodingToolRegistry,
	openCodeBackendManager,
} from "../agents/codingToolRegistry";
import { resetOpenCodeReattachStateForTests } from "../agents/openCodeReattach";
import { OpenCodeRuntimeReconciler } from "../agents/openCodeRuntimeReconciler";
import type { CodingAgentProvider } from "../agents/providers/types";
import type { TmuxIntegration } from "../agents/tmux";
import { ProjectManager } from "../projects/projectManager";
import { GlobalStore } from "../storage/globalStore";
import type { Agent, Feature } from "../types";
import * as platform from "../utils/platform";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
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
	execAsyncMock.mockClear();
	vi.restoreAllMocks();
	resetOpenCodeReattachStateForTests();
});

const WORKTREE = "/tmp/agent-space-reconciler/feat-x";

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
		toolId: "opencode",
		status: "running",
		hasStarted: true,
		createdAt: "2026-08-09T07:00:00.000Z",
		launchedAt: "2026-08-09T07:51:08.000Z",
		sessionBaseline: [],
		...overrides,
	};
}

interface TmuxState {
	alive: Set<string>;
	respawned: Array<{ sessionName: string; command: string }>;
	killed: string[];
}

function tmuxState(): TmuxState {
	return { alive: new Set(), respawned: [], killed: [] };
}

function tmux(st: TmuxState): TmuxIntegration {
	return {
		sessionName: (label: string, agentId: string) =>
			`agent-space-${label}-${agentId}`,
		isSessionAliveAsync: async (sessionName: string) =>
			st.alive.has(sessionName),
		configureSessionAsync: async () => {},
		respawnSessionCommandAsync: async (
			sessionName: string,
			command: string,
		) => {
			st.respawned.push({ sessionName, command });
		},
		killSession: (sessionName: string) => {
			st.killed.push(sessionName);
		},
	} as unknown as TmuxIntegration;
}

function provider(
	overrides: Partial<CodingAgentProvider> = {},
): CodingAgentProvider {
	return {
		id: "opencode",
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
			toolId: "opencode",
			readName: () => null,
			scanSessions: () => [],
			hasSession: vi.fn(() => true),
			async: { hasSession: vi.fn(async () => true) },
		},
		...overrides,
	} as CodingAgentProvider;
}

function setup(agents: Agent[]) {
	const repoRoot = tempDir("reconciler-repo-");
	const storagePath = tempDir("reconciler-storage-");
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
	ctx.store.saveFeatures([feature()]);
	ctx.store.saveAgents("f1", agents);

	const opencodeTool = {
		id: "opencode",
		name: "OpenCode",
		command: "opencode",
		family: "opencode" as const,
	};
	const opencodeProvider = provider();
	vi.spyOn(registry, "resolveAgentToolForAgent").mockReturnValue({
		...opencodeTool,
		provider: opencodeProvider,
	} as never);
	vi.spyOn(registry, "getProvider").mockReturnValue(opencodeProvider);

	return { projectManager, ctx, registry, st };
}

function fakeHandle(
	instanceId: string,
	port: number,
	resumeConversation: ReturnType<typeof vi.fn> = vi.fn(async () => true),
) {
	return {
		instanceId,
		baseUrl: `http://127.0.0.1:${port}`,
		pid: 1,
		port,
		kill: vi.fn(),
		sessionProvider: { resumeConversation },
	};
}

describe("OpenCodeRuntimeReconciler", () => {
	it("reconnects every surviving OpenCode pane for the worktree after a mid-session crash", async () => {
		const { projectManager, ctx, registry, st } = setup([
			agentFixture({ id: "oc-a" }),
			agentFixture({ id: "oc-b" }),
		]);
		st.alive.add("agent-space-f1-oc-a");
		st.alive.add("agent-space-f1-oc-b");
		vi.spyOn(openCodeBackendManager, "ensure").mockResolvedValue(
			fakeHandle("backend-after-crash", 9101) as never,
		);

		const reconciler = new OpenCodeRuntimeReconciler({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		await reconciler.reconcileWorktree(WORKTREE);

		expect(st.respawned.map((r) => r.sessionName).sort()).toEqual([
			"agent-space-f1-oc-a",
			"agent-space-f1-oc-b",
		]);
		const stored = ctx.store.loadAgents("f1");
		expect(stored.find((a) => a.id === "oc-a")?.restore?.state).toBe(
			"reattached",
		);
		expect(stored.find((a) => a.id === "oc-b")?.restore?.state).toBe(
			"reattached",
		);
	});

	it("resumes the session on the new scoped provider so the SSE attention stream is restored", async () => {
		const { projectManager, registry, st } = setup([
			agentFixture({ id: "oc-a" }),
		]);
		st.alive.add("agent-space-f1-oc-a");
		const resumeConversation = vi.fn(async () => true);
		vi.spyOn(openCodeBackendManager, "ensure").mockResolvedValue(
			fakeHandle("backend-fresh", 9105, resumeConversation) as never,
		);

		const reconciler = new OpenCodeRuntimeReconciler({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});
		await reconciler.reconcileWorktree(WORKTREE);

		expect(resumeConversation).toHaveBeenCalledWith("ses_resume");
		expect(st.respawned).toHaveLength(1);
	});

	it("blocks and does not respawn when the session does not exist on the replacement backend", async () => {
		const { projectManager, ctx, registry, st } = setup([
			agentFixture({ id: "oc-a" }),
		]);
		st.alive.add("agent-space-f1-oc-a");
		const resumeConversation = vi.fn(async () => false);
		vi.spyOn(openCodeBackendManager, "ensure").mockResolvedValue(
			fakeHandle("backend-fresh", 9106, resumeConversation) as never,
		);

		const reconciler = new OpenCodeRuntimeReconciler({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});
		await reconciler.reconcileWorktree(WORKTREE);

		expect(resumeConversation).toHaveBeenCalledWith("ses_resume");
		expect(st.respawned).toHaveLength(0);
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.restore?.state).toBe("blocked");
	});

	it("ignores agents whose tmux pane is already gone", async () => {
		const { projectManager, registry, st } = setup([
			agentFixture({ id: "oc-a" }),
		]);
		// Not marked alive: this agent's pane didn't survive.
		vi.spyOn(openCodeBackendManager, "ensure").mockResolvedValue(
			fakeHandle("backend-1", 9102) as never,
		);

		const reconciler = new OpenCodeRuntimeReconciler({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});
		await reconciler.reconcileWorktree(WORKTREE);

		expect(st.respawned).toHaveLength(0);
	});

	it("coalesces concurrent reconcile requests for the same worktree into one pass", async () => {
		const { projectManager, registry, st } = setup([
			agentFixture({ id: "oc-a" }),
		]);
		st.alive.add("agent-space-f1-oc-a");
		const ensureSpy = vi
			.spyOn(openCodeBackendManager, "ensure")
			.mockResolvedValue(fakeHandle("backend-1", 9103) as never);

		const reconciler = new OpenCodeRuntimeReconciler({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});

		await Promise.all([
			reconciler.reconcileWorktree(WORKTREE),
			reconciler.reconcileWorktree(WORKTREE),
			reconciler.reconcileWorktree(WORKTREE),
		]);

		expect(st.respawned).toHaveLength(1);
		expect(ensureSpy).toHaveBeenCalledTimes(1);
	});

	it("does not retry when the backend cannot be restarted — leaves the agent blocked", async () => {
		const { projectManager, ctx, registry, st } = setup([
			agentFixture({ id: "oc-a" }),
		]);
		st.alive.add("agent-space-f1-oc-a");
		vi.spyOn(openCodeBackendManager, "ensure").mockRejectedValue(
			new Error("backend refused to start"),
		);

		const reconciler = new OpenCodeRuntimeReconciler({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});
		await reconciler.reconcileWorktree(WORKTREE);

		expect(st.respawned).toHaveLength(0);
		const stored = ctx.store.loadAgents("f1")[0];
		expect(stored.restore?.state).toBe("blocked");
	});

	it("wires onBackendLost to trigger reconciliation, and dispose() unsubscribes", async () => {
		const { projectManager, registry, st } = setup([
			agentFixture({ id: "oc-a" }),
		]);
		st.alive.add("agent-space-f1-oc-a");
		vi.spyOn(openCodeBackendManager, "ensure").mockResolvedValue(
			fakeHandle("backend-live", 9104) as never,
		);
		let capturedListener: ((worktreePath: string) => void) | undefined;
		const onBackendLostSpy = vi
			.spyOn(openCodeBackendManager, "onBackendLost")
			.mockImplementation((listener) => {
				capturedListener = listener;
				return () => {
					capturedListener = undefined;
				};
			});

		const reconciler = new OpenCodeRuntimeReconciler({
			projectManager,
			tmux: tmux(st),
			toolRegistry: registry,
		});
		reconciler.start();
		expect(onBackendLostSpy).toHaveBeenCalledTimes(1);
		expect(capturedListener).toBeDefined();

		// Simulate the manager reporting the worktree's backend as lost.
		capturedListener?.(WORKTREE);
		await vi.waitFor(() => expect(st.respawned).toHaveLength(1));

		reconciler.dispose();
		expect(capturedListener).toBeUndefined();
	});
});
