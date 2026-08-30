import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createTerminalMock,
	showErrorMessageMock,
	onDidOpenTerminalMock,
	onDidCloseTerminalMock,
	ensureHermesProjectSkillsTrustedMock,
	ensureHermesProjectSkillsTrustedAsyncMock,
} = vi.hoisted(() => ({
	createTerminalMock: vi.fn(),
	showErrorMessageMock: vi.fn(),
	onDidOpenTerminalMock: vi.fn(() => ({ dispose: vi.fn() })),
	onDidCloseTerminalMock: vi.fn(() => ({ dispose: vi.fn() })),
	ensureHermesProjectSkillsTrustedMock: vi.fn(),
	ensureHermesProjectSkillsTrustedAsyncMock: vi.fn(),
}));

vi.mock("../utils/platform", () => ({
	exec: vi.fn(),
	execAsync: vi.fn(),
	getTerminalShellArgs: vi.fn(() => ({
		shellPath: "tmux",
		shellArgs: ["attach-session", "-t", "session"],
	})),
}));

vi.mock("../agents/hermesSkillTrust", () => ({
	hasProjectSkills: vi.fn().mockReturnValue(true),
	ensureHermesProjectSkillsTrusted: ensureHermesProjectSkillsTrustedMock,
	ensureHermesProjectSkillsTrustedAsync:
		ensureHermesProjectSkillsTrustedAsyncMock,
}));

vi.mock("../constants/colors", () => ({
	getThemeColors: vi.fn(() => [{ id: "terminal.ansiBlue" }]),
}));

vi.mock("vscode", () => ({
	window: {
		createTerminal: createTerminalMock,
		showErrorMessage: showErrorMessageMock,
		onDidOpenTerminal: onDidOpenTerminalMock,
		onDidCloseTerminal: onDidCloseTerminalMock,
	},
	ThemeIcon: class {
		constructor(public readonly id: string) {}
	},
	ThemeColor: class {
		constructor(public readonly id: string) {}
	},
	TerminalLocation: {
		Editor: "editor",
	},
}));

import { TerminalController } from "../agents/terminalController";
import type { Agent, Feature, Service } from "../types";
import { exec, execAsync } from "../utils/platform";

describe("TerminalController", () => {
	const feature: Feature = {
		id: "f1",
		name: "Feature One",
		branch: "feat/feature-one",
		worktreePath: "/repo/feature-one",
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const agent: Agent = {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: "session-1",
		toolId: "claude",
		status: "stopped",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const shellService: Service = {
		id: "svc1",
		featureId: "f1",
		name: "Terminal",
		command: "Interactive shell",
		launchCommand: null,
		tmuxSession: "agent-space-svc-f1-svc1",
		status: "running",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const markAgentStarted = vi.fn();
	const recordAgentFailure = vi.fn();
	const advanceStartupStep = vi.fn();
	const notifyChange = vi.fn();
	const findContextByFeatureId = vi.fn();
	const getAgent = vi.fn();
	const adoptSession = vi.fn();
	const createCommand = vi.fn();
	const configureSession = vi.fn();
	const isSessionAlive = vi.fn();
	const getPaneStatus = vi.fn();
	const getPaneStatusAsync = vi.fn();
	const capturePane = vi.fn();
	const capturePaneAsync = vi.fn();
	const killSession = vi.fn();
	const clearRemainOnExitForSession = vi.fn();
	const clearRemainOnExitForSessionAsync = vi.fn();
	const resolveAgentTool = vi.fn();
	const resolveAgentToolForAgent = vi.fn();
	const buildLaunchCommand = vi.fn();
	const buildResumeLaunchCommand = vi.fn();
	const buildStrictResumeLaunchCommand = vi.fn();
	let closedTerminalHandler:
		| ((terminal: {
				show: ReturnType<typeof vi.fn>;
				dispose: ReturnType<typeof vi.fn>;
				hide: ReturnType<typeof vi.fn>;
		  }) => void)
		| undefined;
	let openedTerminalHandler:
		| ((terminal: typeof terminalInstance) => void)
		| undefined;
	let terminalInstance: {
		show: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
		hide: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(exec).mockImplementation(() => "");
		onDidCloseTerminalMock.mockImplementation(((
			callback: typeof closedTerminalHandler,
		) => {
			closedTerminalHandler = callback;
			return { dispose: vi.fn() };
		}) as never);
		onDidOpenTerminalMock.mockImplementation(((
			callback: typeof openedTerminalHandler,
		) => {
			openedTerminalHandler = callback;
			return { dispose: vi.fn() };
		}) as never);
		findContextByFeatureId.mockReturnValue({
			agentManager: {
				getAgent,
				markAgentStarted,
				recordAgentFailure,
				advanceStartupStep,
			},
		});
		getAgent.mockReturnValue({ ...agent, status: "stopped" });
		adoptSession.mockReturnValue(false);
		createCommand.mockReturnValue('tmux new-session -d -s "session" "claude"');
		isSessionAlive.mockReturnValue(true);
		getPaneStatus.mockReturnValue(null);
		getPaneStatusAsync.mockResolvedValue(null);
		capturePane.mockReturnValue(null);
		capturePaneAsync.mockResolvedValue(null);
		resolveAgentTool.mockReturnValue({
			id: "claude",
			name: "Claude Code",
			command: "claude",
		});
		resolveAgentToolForAgent.mockReturnValue({
			id: "claude",
			name: "Claude Code",
			command: "claude",
		});
		buildLaunchCommand.mockReturnValue("claude");
		buildResumeLaunchCommand.mockReturnValue("claude --resume session-1");
		buildStrictResumeLaunchCommand.mockReturnValue("claude --resume session-1");
		terminalInstance = { show: vi.fn(), dispose: vi.fn(), hide: vi.fn() };
		createTerminalMock.mockReturnValue(terminalInstance);
		showErrorMessageMock.mockResolvedValue(undefined);
	});

	it("does not create or mark a terminal running when tmux startup fails", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockImplementation(() => {
			throw new Error("spawn failed");
		});

		const terminal = controller.createTerminal(feature, agent, 0);

		expect(terminal).toBeUndefined();
		expect(createTerminalMock).not.toHaveBeenCalled();
		expect(markAgentStarted).not.toHaveBeenCalled();
		expect(recordAgentFailure).toHaveBeenCalledWith(
			"a1",
			"f1",
			"Failed to start Agent 1 with Claude Code. Check that the CLI is installed and launches from /repo/feature-one.",
			undefined,
		);
		expect(notifyChange).toHaveBeenCalledTimes(1);
		// issue #120: a failure on an already-known agent never adds/removes a
		// card, so the sidebar/Home can patch it in place instead of a full
		// webview rebuild.
		expect(notifyChange).toHaveBeenCalledWith({
			featureId: "f1",
			structural: false,
		});
		expect(showErrorMessageMock).toHaveBeenCalledWith(
			"Failed to start Agent 1 with Claude Code. Check that the CLI is installed and launches from /repo/feature-one.",
		);
	});

	it("waits for the terminal-open event after createTerminal returns", async () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		controller.createTerminal(feature, agent, 0);
		const ready = controller.waitForAgentTerminalReady("f1", "a1");
		let settled = false;
		void ready.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		openedTerminalHandler?.(terminalInstance);
		await ready;
		expect(markAgentStarted).toHaveBeenCalledWith("a1", "f1");
		controller.dispose();
	});

	it("attaches an existing session without adoption or process creation", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, tmuxSession: "companion-f1-a1" },
			0,
			false,
			true,
		);

		expect(terminal).toBe(terminalInstance);
		expect(markAgentStarted).not.toHaveBeenCalled();
		openedTerminalHandler?.(terminalInstance);
		expect(isSessionAlive).toHaveBeenCalledWith("companion-f1-a1");
		expect(adoptSession).not.toHaveBeenCalled();
		expect(vi.mocked(exec)).not.toHaveBeenCalled();
		expect(markAgentStarted).toHaveBeenCalledWith("a1", "f1");
	});

	it("fails closed when an existing session disappears before attach", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive: vi.fn().mockReturnValue(false),
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, tmuxSession: "agent-space-f1-a1" },
			0,
			false,
			true,
		);

		expect(terminal).toBeUndefined();
		expect(adoptSession).not.toHaveBeenCalled();
		expect(createCommand).not.toHaveBeenCalled();
		expect(buildLaunchCommand).not.toHaveBeenCalled();
		expect(buildResumeLaunchCommand).not.toHaveBeenCalled();
		expect(vi.mocked(exec)).not.toHaveBeenCalled();
	});

	it("does not mark an agent running when tmux session dies immediately", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive: vi.fn().mockReturnValue(false),
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockReturnValue("");

		const terminal = controller.createTerminal(feature, agent, 0);

		expect(terminal).toBeUndefined();
		expect(createTerminalMock).not.toHaveBeenCalled();
		expect(markAgentStarted).not.toHaveBeenCalled();
		expect(recordAgentFailure).toHaveBeenCalledTimes(1);
		expect(notifyChange).toHaveBeenCalledTimes(1);
	});

	// Cas E: a CLI that is present but exits immediately (e.g. `codex resume
	// <id>` printing "No saved session found" and exiting) must surface its
	// real exit code and captured output, not the generic "Check that the CLI
	// is installed" message — the process demonstrably ran.
	it("Cas E: surfaces the real exit code and pane output for a CLI that exits immediately", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockReturnValue("");
		isSessionAlive.mockReturnValue(true);
		getPaneStatus.mockReturnValue({ dead: true, exitCode: 1 });
		capturePane.mockReturnValue(
			'ERROR: No saved session found with ID "01a04fbe-thread".',
		);

		const terminal = controller.createTerminal(feature, agent, 0);

		expect(terminal).toBeUndefined();
		expect(killSession).toHaveBeenCalledWith("agent-space-f1-a1");
		expect(recordAgentFailure).toHaveBeenCalledWith(
			"a1",
			"f1",
			expect.stringContaining("exit code 1"),
			1,
		);
		expect(recordAgentFailure).toHaveBeenCalledWith(
			"a1",
			"f1",
			expect.stringContaining("No saved session found"),
			1,
		);
		expect(recordAgentFailure).not.toHaveBeenCalledWith(
			"a1",
			"f1",
			expect.stringContaining("Check that the CLI is installed"),
			expect.anything(),
		);
	});

	// Cas F: the worktree step must never be blamed for a failure that
	// happened after the worktree and terminal both provably succeeded — here
	// the tmux session comes up fine and only the provider process crashes.
	it("Cas F: blames the provider startup step, not worktree, for a post-terminal crash", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockReturnValue("");
		isSessionAlive.mockReturnValue(true);
		getPaneStatus.mockReturnValue({ dead: true, exitCode: 1 });

		controller.createTerminal(feature, agent, 0);

		expect(advanceStartupStep).toHaveBeenCalledWith("a1", "f1", "terminal");
		expect(advanceStartupStep).toHaveBeenCalledWith("a1", "f1", "provider");
		// "provider" was reached (and is therefore the step recordAgentFailure's
		// real implementation would find `running`) strictly after "terminal" —
		// a worktree/terminal that never ran would never call this at all.
		const stepCalls = advanceStartupStep.mock.calls.map((call) => call[2]);
		expect(stepCalls.indexOf("terminal")).toBeLessThan(
			stepCalls.indexOf("provider"),
		);
	});

	it("launches a fresh agent with the normal command even when resume was requested", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockReturnValue("");

		controller.createTerminal(
			feature,
			{ ...agent, hasStarted: false },
			0,
			true,
		);
		openedTerminalHandler?.(terminalInstance);

		expect(buildLaunchCommand).toHaveBeenCalledWith(
			expect.objectContaining({ id: "claude" }),
			"session-1",
			"/repo/feature-one",
		);
		expect(buildResumeLaunchCommand).not.toHaveBeenCalled();
		expect(markAgentStarted).toHaveBeenCalledWith("a1", "f1");
		expect(notifyChange).toHaveBeenCalledTimes(1);
	});

	it("resumes a started agent with the strict resume command when the session is provable", () => {
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockReturnValue("");

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, hasStarted: true },
			0,
			true,
		);

		expect(buildStrictResumeLaunchCommand).toHaveBeenCalledWith(
			expect.objectContaining({ id: "claude" }),
			"session-1",
			"/repo/feature-one",
		);
		expect(buildLaunchCommand).not.toHaveBeenCalled();
		expect(terminal).toBe(terminalInstance);
		expect(showErrorMessageMock).not.toHaveBeenCalled();
	});

	it("blocks instead of silently launching fresh when no genuine resume can be proven", () => {
		buildStrictResumeLaunchCommand.mockReturnValue(undefined);
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, hasStarted: true, sessionId: null },
			0,
			true,
		);

		expect(terminal).toBeUndefined();
		expect(createTerminalMock).not.toHaveBeenCalled();
		expect(vi.mocked(exec)).not.toHaveBeenCalled();
		expect(buildLaunchCommand).not.toHaveBeenCalled();
		expect(recordAgentFailure).toHaveBeenCalledWith(
			"a1",
			"f1",
			'Cannot resume "Agent 1": no genuine Claude Code session could be proven for it. Close this agent and start a new one to continue.',
			undefined,
		);
		expect(showErrorMessageMock).toHaveBeenCalledWith(
			'Cannot resume "Agent 1": no genuine Claude Code session could be proven for it. Close this agent and start a new one to continue.',
		);
	});

	it("blocks the async reopen path the same way when no genuine resume can be proven", async () => {
		buildStrictResumeLaunchCommand.mockReturnValue(undefined);
		const isSessionAliveAsync = vi.fn();
		const adoptSessionAsync = vi.fn().mockResolvedValue(false);
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				isSessionAliveAsync,
				adoptSessionAsync,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		const terminal = await controller.focusOrCreateTerminalAsync(
			feature,
			{ ...agent, hasStarted: true, sessionId: null },
			0,
			true,
		);

		expect(terminal).toBeUndefined();
		expect(vi.mocked(execAsync)).not.toHaveBeenCalled();
		expect(vi.mocked(exec)).not.toHaveBeenCalled();
		expect(createTerminalMock).not.toHaveBeenCalled();
		expect(recordAgentFailure).toHaveBeenCalledWith(
			"a1",
			"f1",
			'Cannot resume "Agent 1": no genuine Claude Code session could be proven for it. Close this agent and start a new one to continue.',
			undefined,
		);
	});

	it("auto-attaches and resumes when exactly one worktree session is unowned", () => {
		const candidate = {
			sessionId: "session-2",
			prompt: "Recovered conversation",
			created: "2026-08-13T05:54:00.000Z",
			projectPath: "/repo/feature-one",
		};
		const listAttachableSessions = vi.fn().mockReturnValue([candidate]);
		const attachExplicitly = vi.fn().mockReturnValue(true);
		buildStrictResumeLaunchCommand.mockImplementation(
			(_tool: unknown, sessionId?: string | null) =>
				sessionId === "session-2" ? "codex resume session-2" : undefined,
		);
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
			{ listAttachableSessions, attachExplicitly } as never,
		);

		vi.mocked(exec).mockReturnValue("");

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, hasStarted: true, sessionId: null },
			0,
			true,
		);

		expect(listAttachableSessions).toHaveBeenCalledWith("f1", "a1");
		expect(attachExplicitly).toHaveBeenCalledWith("f1", "a1", "session-2");
		expect(buildStrictResumeLaunchCommand).toHaveBeenCalledWith(
			expect.objectContaining({ id: "claude" }),
			"session-2",
			"/repo/feature-one",
		);
		expect(terminal).toBe(terminalInstance);
		expect(showErrorMessageMock).not.toHaveBeenCalled();
		expect(recordAgentFailure).not.toHaveBeenCalled();
	});

	it("does not auto-attach a unique custom provider-assigned session", () => {
		const listAttachableSessions = vi.fn().mockReturnValue([
			{
				sessionId: "hermes-session",
				prompt: "Recovered conversation",
				created: "2026-08-13T05:54:00.000Z",
				projectPath: "/repo/feature-one",
			},
		]);
		const attachExplicitly = vi.fn().mockReturnValue(true);
		resolveAgentTool.mockReturnValue({
			id: "codex-perso",
			name: "Codex perso",
			command: "codex-perso",
		});
		buildStrictResumeLaunchCommand.mockReturnValue(undefined);
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "provider_assigned" },
				})),
				buildLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
			{ listAttachableSessions, attachExplicitly } as never,
		);

		const terminal = controller.createTerminal(
			{ ...feature },
			{ ...agent, hasStarted: true, sessionId: null },
			0,
			true,
		);

		expect(terminal).toBeUndefined();
		expect(listAttachableSessions).not.toHaveBeenCalled();
		expect(attachExplicitly).not.toHaveBeenCalled();
	});

	it("stays blocked (never auto-picks) when more than one worktree session is unowned", () => {
		const listAttachableSessions = vi.fn().mockReturnValue([
			{
				sessionId: "session-2",
				prompt: "A",
				created: "2026-08-13T05:54:00.000Z",
				projectPath: "/repo/feature-one",
			},
			{
				sessionId: "session-3",
				prompt: "B",
				created: "2026-08-13T05:55:00.000Z",
				projectPath: "/repo/feature-one",
			},
		]);
		const attachExplicitly = vi.fn();
		buildStrictResumeLaunchCommand.mockReturnValue(undefined);
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
			{ listAttachableSessions, attachExplicitly } as never,
		);

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, hasStarted: true, sessionId: null },
			0,
			true,
		);

		expect(terminal).toBeUndefined();
		expect(attachExplicitly).not.toHaveBeenCalled();
		expect(vi.mocked(exec)).not.toHaveBeenCalled();
		expect(recordAgentFailure).toHaveBeenCalledWith(
			"a1",
			"f1",
			'Cannot resume "Agent 1": no genuine Claude Code session could be proven for it. Close this agent and start a new one to continue.',
			undefined,
		);
	});

	it("auto-attaches and resumes on the async reopen path too", async () => {
		const candidate = {
			sessionId: "session-2",
			prompt: "Recovered conversation",
			created: "2026-08-13T05:54:00.000Z",
			projectPath: "/repo/feature-one",
		};
		const listAttachableSessions = vi.fn().mockReturnValue([candidate]);
		const attachExplicitly = vi.fn().mockReturnValue(true);
		buildStrictResumeLaunchCommand.mockImplementation(
			(_tool: unknown, sessionId?: string | null) =>
				sessionId === "session-2" ? "codex resume session-2" : undefined,
		);
		const isSessionAliveAsync = vi.fn().mockResolvedValue(true);
		const adoptSessionAsync = vi.fn().mockResolvedValue(false);
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive,
				isSessionAliveAsync,
				adoptSessionAsync,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				getProvider: vi.fn(() => ({
					conversationIdentity: { ownership: "preassigned" },
				})),
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
			{ listAttachableSessions, attachExplicitly } as never,
		);

		vi.mocked(execAsync).mockResolvedValue({ stdout: "", stderr: "" });

		const terminal = await controller.focusOrCreateTerminalAsync(
			feature,
			{ ...agent, hasStarted: true, sessionId: null },
			0,
			true,
		);

		expect(attachExplicitly).toHaveBeenCalledWith("f1", "a1", "session-2");
		expect(terminal).toBe(terminalInstance);
		expect(recordAgentFailure).not.toHaveBeenCalled();
	});

	it("records and surfaces unexpected agent exits after the terminal closes", () => {
		const sessionAliveMock = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValue(false);
		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
				legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
				adoptSession,
				createCommand,
				configureSession,
				isSessionAlive: sessionAliveMock,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		findContextByFeatureId.mockReturnValue({
			agentManager: {
				markAgentStarted,
				recordAgentFailure,
				advanceStartupStep,
				getAgents: vi.fn().mockReturnValue([{ ...agent, status: "running" }]),
			},
		});
		// Alive (not dead) for the post-launch startup check, then dead once the
		// terminal has actually closed later — this test is about a crash that
		// happens after a genuinely successful launch, not an instant one.
		getPaneStatus
			.mockReturnValueOnce(null)
			.mockReturnValue({ dead: true, exitCode: 17 });
		vi.mocked(exec).mockReturnValue("");

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, hasStarted: true },
			0,
		);
		expect(terminal).toBe(terminalInstance);
		expect(closedTerminalHandler).toBeDefined();
		openedTerminalHandler?.(terminalInstance);

		closedTerminalHandler?.(terminalInstance);

		expect(recordAgentFailure).toHaveBeenLastCalledWith(
			"a1",
			"f1",
			"Agent 1 exited unexpectedly (exit code 17).",
			17,
		);
		expect(showErrorMessageMock).toHaveBeenLastCalledWith(
			"Agent 1 exited unexpectedly (exit code 17).",
		);
		expect(notifyChange).toHaveBeenCalledTimes(2);
	});

	it("starts shell services without an inner command", () => {
		const createShellCommand = vi
			.fn()
			.mockReturnValue('tmux new-session -d -s "agent-space-svc-f1-svc1"');
		const configureServiceSession = vi.fn();
		const serviceSessionAlive = vi
			.fn()
			.mockReturnValueOnce(false)
			.mockReturnValue(true);

		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				isSessionAlive: serviceSessionAlive,
				createShellCommand,
				configureServiceSession,
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		controller.createServiceTerminal(
			feature,
			shellService,
			"/repo/feature-one",
		);

		expect(createShellCommand).toHaveBeenCalledWith("agent-space-svc-f1-svc1");
		expect(vi.mocked(exec)).toHaveBeenCalledWith(
			'tmux new-session -d -s "agent-space-svc-f1-svc1"',
			{ cwd: "/repo/feature-one" },
		);
		expect(configureServiceSession).toHaveBeenCalledWith(
			"agent-space-svc-f1-svc1",
		);
		expect(createTerminalMock).toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// focusOrCreateTerminal / focusOrCreateTerminalAsync — the interactive
	// sidebar click path (issue #69). A tracked/warm terminal must resolve
	// with zero shell/process calls, sync or async. Only cold reattachment
	// (terminal not tracked) may touch tmux, and it must do so via the async
	// helpers only, never the synchronous ones.
	// -----------------------------------------------------------------------
	describe("focusOrCreateTerminal (warm path)", () => {
		it("shows an already-tracked terminal with no exec of any kind", () => {
			const controller = new TerminalController(
				{ findContextByFeatureId, notifyChange } as never,
				{
					sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
					legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
					adoptSession,
					createCommand,
					configureSession,
					isSessionAlive,
					getPaneStatus,
					getPaneStatusAsync,
					capturePane,
					capturePaneAsync,
					killSession,
					clearRemainOnExitForSession,
					clearRemainOnExitForSessionAsync,
				} as never,
				{
					resolveAgentTool,
					resolveAgentToolForAgent,
					buildLaunchCommand,
					buildResumeLaunchCommand,
				} as never,
			);

			// Warm the terminal via a normal (mocked-away) create, then clear
			// the exec spy so only the focus call itself is under test.
			controller.createTerminal(feature, agent, 0);
			vi.mocked(exec).mockClear();
			vi.mocked(execAsync).mockClear();
			adoptSession.mockClear();
			isSessionAlive.mockClear();

			const terminal = controller.focusOrCreateTerminal(feature, agent, 0);

			expect(terminal).toBe(terminalInstance);
			expect(terminalInstance.show).toHaveBeenCalled();
			expect(vi.mocked(exec)).not.toHaveBeenCalled();
			expect(vi.mocked(execAsync)).not.toHaveBeenCalled();
			expect(adoptSession).not.toHaveBeenCalled();
			expect(isSessionAlive).not.toHaveBeenCalled();
		});
	});

	describe("focusOrCreateTerminalAsync", () => {
		it("resolves an already-tracked terminal synchronously in effect, with no exec/tmux call", async () => {
			const isSessionAliveAsync = vi.fn();
			const adoptSessionAsync = vi.fn();
			const controller = new TerminalController(
				{ findContextByFeatureId, notifyChange } as never,
				{
					sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
					legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
					adoptSession,
					createCommand,
					configureSession,
					isSessionAlive,
					isSessionAliveAsync,
					adoptSessionAsync,
					getPaneStatus,
					getPaneStatusAsync,
					capturePane,
					capturePaneAsync,
					killSession,
					clearRemainOnExitForSession,
					clearRemainOnExitForSessionAsync,
				} as never,
				{
					resolveAgentTool,
					resolveAgentToolForAgent,
					buildLaunchCommand,
					buildResumeLaunchCommand,
				} as never,
			);

			controller.createTerminal(feature, agent, 0);
			vi.mocked(exec).mockClear();
			vi.mocked(execAsync).mockClear();
			adoptSession.mockClear();
			isSessionAlive.mockClear();

			const terminal = await controller.focusOrCreateTerminalAsync(
				feature,
				agent,
				0,
			);

			expect(terminal).toBe(terminalInstance);
			expect(terminalInstance.show).toHaveBeenCalled();
			expect(vi.mocked(exec)).not.toHaveBeenCalled();
			expect(vi.mocked(execAsync)).not.toHaveBeenCalled();
			expect(adoptSession).not.toHaveBeenCalled();
			expect(isSessionAlive).not.toHaveBeenCalled();
			expect(adoptSessionAsync).not.toHaveBeenCalled();
			expect(isSessionAliveAsync).not.toHaveBeenCalled();
		});

		it("reattaches a cold agent using only the async tmux helpers, never the sync ones", async () => {
			const isSessionAliveAsync = vi.fn().mockResolvedValue(true);
			const adoptSessionAsync = vi.fn().mockResolvedValue(true);
			const controller = new TerminalController(
				{ findContextByFeatureId, notifyChange } as never,
				{
					sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
					legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
					adoptSession,
					createCommand,
					configureSession,
					isSessionAlive,
					isSessionAliveAsync,
					adoptSessionAsync,
					getPaneStatus,
					getPaneStatusAsync,
					capturePane,
					capturePaneAsync,
					killSession,
					clearRemainOnExitForSession,
					clearRemainOnExitForSessionAsync,
				} as never,
				{
					resolveAgentTool,
					resolveAgentToolForAgent,
					buildLaunchCommand,
					buildResumeLaunchCommand,
				} as never,
			);

			const terminal = await controller.focusOrCreateTerminalAsync(
				feature,
				agent,
				0,
				true,
			);

			expect(terminal).toBe(terminalInstance);
			expect(adoptSessionAsync).toHaveBeenCalledWith(
				"agent-space-f1-a1",
				"companion-f1-a1",
			);
			// The cold path must never fall back to the synchronous discovery
			// helpers — that is exactly the extension-host-blocking behaviour
			// issue #69 removes from the interactive click path.
			expect(adoptSession).not.toHaveBeenCalled();
			expect(isSessionAlive).not.toHaveBeenCalled();
			expect(vi.mocked(exec)).not.toHaveBeenCalled();
			expect(markAgentStarted).not.toHaveBeenCalled();
			openedTerminalHandler?.(terminalInstance);
			expect(markAgentStarted).toHaveBeenCalledWith("a1", "f1");
		});

		it("spawns a fresh session via async exec only when no tmux session can be adopted", async () => {
			const isSessionAliveAsync = vi.fn().mockResolvedValue(true);
			const adoptSessionAsync = vi.fn().mockResolvedValue(false);
			const controller = new TerminalController(
				{ findContextByFeatureId, notifyChange } as never,
				{
					sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
					legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
					adoptSession,
					createCommand,
					configureSession,
					isSessionAlive,
					isSessionAliveAsync,
					adoptSessionAsync,
					getPaneStatus,
					getPaneStatusAsync,
					capturePane,
					capturePaneAsync,
					killSession,
					clearRemainOnExitForSession,
					clearRemainOnExitForSessionAsync,
				} as never,
				{
					resolveAgentTool,
					resolveAgentToolForAgent,
					buildLaunchCommand,
					buildResumeLaunchCommand,
				} as never,
			);

			vi.mocked(execAsync).mockResolvedValue({ stdout: "", stderr: "" });

			const terminal = await controller.focusOrCreateTerminalAsync(
				feature,
				{ ...agent, hasStarted: false },
				0,
				true,
			);

			expect(terminal).toBe(terminalInstance);
			expect(vi.mocked(execAsync)).toHaveBeenCalledWith(
				'tmux new-session -d -s "session" "claude"',
				{ cwd: feature.worktreePath },
			);
			expect(vi.mocked(exec)).not.toHaveBeenCalled();
			expect(adoptSession).not.toHaveBeenCalled();
			expect(isSessionAlive).not.toHaveBeenCalled();
		});

		it("coalesces overlapping cold requests for the same agent into one create, without revealing", async () => {
			const isSessionAliveAsync = vi.fn().mockResolvedValue(true);
			const adoptSessionAsync = vi.fn().mockResolvedValue(true);
			const controller = new TerminalController(
				{ findContextByFeatureId, notifyChange } as never,
				{
					sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
					legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
					adoptSession,
					createCommand,
					configureSession,
					isSessionAlive,
					isSessionAliveAsync,
					adoptSessionAsync,
					getPaneStatus,
					getPaneStatusAsync,
					capturePane,
					capturePaneAsync,
					killSession,
					clearRemainOnExitForSession,
					clearRemainOnExitForSessionAsync,
				} as never,
				{
					resolveAgentTool,
					resolveAgentToolForAgent,
					buildLaunchCommand,
					buildResumeLaunchCommand,
				} as never,
			);

			// Two overlapping clicks on the same untracked agent: neither one
			// can take the warm path (the map stays empty until resolution),
			// and the second must reuse the in-flight reconciliation instead
			// of starting a duplicate create.
			const first = controller.focusOrCreateTerminalAsync(
				feature,
				agent,
				0,
				true,
			);
			const second = controller.focusOrCreateTerminalAsync(
				feature,
				agent,
				0,
				true,
			);

			const [terminalA, terminalB] = await Promise.all([first, second]);

			expect(terminalA).toBe(terminalInstance);
			expect(terminalB).toBe(terminalInstance);
			expect(createTerminalMock).toHaveBeenCalledTimes(1);
			expect(adoptSessionAsync).toHaveBeenCalledTimes(1);
			expect(isSessionAliveAsync).not.toHaveBeenCalled();
			// Cold create must not reveal by itself — the caller owns the
			// show decision so a stale resolution cannot steal focus.
			expect(terminalInstance.show).not.toHaveBeenCalled();
		});

		it("uses the async trust primitive on the cold path, never the sync one", async () => {
			const isSessionAliveAsync = vi.fn().mockResolvedValue(true);
			const adoptSessionAsync = vi.fn().mockResolvedValue(false);
			const hermesAgent: Agent = {
				...agent,
				hermesProfile: "agent-space",
			};
			const controller = new TerminalController(
				{ findContextByFeatureId, notifyChange } as never,
				{
					sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
					legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
					adoptSession,
					createCommand,
					configureSession,
					isSessionAlive,
					isSessionAliveAsync,
					adoptSessionAsync,
					getPaneStatus,
					getPaneStatusAsync,
					capturePane,
					capturePaneAsync,
					killSession,
					clearRemainOnExitForSession,
					clearRemainOnExitForSessionAsync,
				} as never,
				{
					resolveAgentTool,
					resolveAgentToolForAgent,
					buildLaunchCommand,
					buildResumeLaunchCommand,
				} as never,
			);

			ensureHermesProjectSkillsTrustedAsyncMock.mockResolvedValue(undefined);
			vi.mocked(execAsync).mockResolvedValue({ stdout: "", stderr: "" });

			const terminal = await controller.focusOrCreateTerminalAsync(
				feature,
				hermesAgent,
				0,
				true,
			);

			expect(terminal).toBeDefined();
			expect(ensureHermesProjectSkillsTrustedAsyncMock).toHaveBeenCalledOnce();
			expect(ensureHermesProjectSkillsTrustedMock).not.toHaveBeenCalled();
		});

		it("prevents tmux creation when async trust fails", async () => {
			const isSessionAliveAsync = vi.fn().mockResolvedValue(true);
			const adoptSessionAsync = vi.fn().mockResolvedValue(false);
			const hermesAgent: Agent = {
				...agent,
				hermesProfile: "agent-space",
			};
			const controller = new TerminalController(
				{ findContextByFeatureId, notifyChange } as never,
				{
					sessionName: vi.fn().mockReturnValue("agent-space-f1-a1"),
					legacySessionName: vi.fn().mockReturnValue("companion-f1-a1"),
					adoptSession,
					createCommand,
					configureSession,
					isSessionAlive,
					isSessionAliveAsync,
					adoptSessionAsync,
					getPaneStatus,
					getPaneStatusAsync,
					capturePane,
					capturePaneAsync,
					killSession,
					clearRemainOnExitForSession,
					clearRemainOnExitForSessionAsync,
				} as never,
				{
					resolveAgentTool,
					resolveAgentToolForAgent,
					buildLaunchCommand,
					buildResumeLaunchCommand,
				} as never,
			);

			ensureHermesProjectSkillsTrustedAsyncMock.mockRejectedValue(
				new Error("hermes skills trust failed"),
			);

			await expect(
				controller.focusOrCreateTerminalAsync(feature, hermesAgent, 0, true),
			).rejects.toThrow("hermes skills trust failed");
			expect(createTerminalMock).not.toHaveBeenCalled();
		});
	});

	it("does not create a terminal when service tmux session fails to start", () => {
		const createShellCommand = vi
			.fn()
			.mockReturnValue('tmux new-session -d -s "agent-space-svc-f1-svc1"');

		const controller = new TerminalController(
			{ findContextByFeatureId, notifyChange } as never,
			{
				isSessionAlive: vi.fn().mockReturnValue(false),
				createShellCommand,
				configureServiceSession: vi.fn(),
				getPaneStatus,
				getPaneStatusAsync,
				capturePane,
				capturePaneAsync,
				killSession,
				clearRemainOnExitForSession,
				clearRemainOnExitForSessionAsync,
			} as never,
			{
				resolveAgentTool,
				resolveAgentToolForAgent,
				buildLaunchCommand,
				buildResumeLaunchCommand,
				buildStrictResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockReturnValue("");

		const terminal = controller.createServiceTerminal(
			feature,
			shellService,
			"/repo/feature-one",
		);

		expect(terminal).toBeUndefined();
		expect(createTerminalMock).not.toHaveBeenCalled();
		expect(showErrorMessageMock).toHaveBeenCalledWith(
			expect.stringContaining("Failed to start service"),
		);
	});
});
