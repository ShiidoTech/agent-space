import { beforeEach, describe, expect, it, vi } from "vitest";

const { createTerminalMock, showErrorMessageMock, onDidCloseTerminalMock } =
	vi.hoisted(() => ({
		createTerminalMock: vi.fn(),
		showErrorMessageMock: vi.fn(),
		onDidCloseTerminalMock: vi.fn(() => ({ dispose: vi.fn() })),
	}));

vi.mock("../utils/platform", () => ({
	exec: vi.fn(),
	getTerminalShellArgs: vi.fn(() => ({
		shellPath: "tmux",
		shellArgs: ["attach-session", "-t", "session"],
	})),
}));

vi.mock("../constants/colors", () => ({
	getThemeColors: vi.fn(() => [{ id: "terminal.ansiBlue" }]),
}));

vi.mock("vscode", () => ({
	window: {
		createTerminal: createTerminalMock,
		showErrorMessage: showErrorMessageMock,
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
import { exec } from "../utils/platform";

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
	const notifyChange = vi.fn();
	const findContextByFeatureId = vi.fn();
	const adoptSession = vi.fn();
	const createCommand = vi.fn();
	const configureSession = vi.fn();
	const isSessionAlive = vi.fn();
	const getPaneStatus = vi.fn();
	const resolveAgentTool = vi.fn();
	const buildLaunchCommand = vi.fn();
	const buildResumeLaunchCommand = vi.fn();
	let closedTerminalHandler:
		| ((terminal: {
				show: ReturnType<typeof vi.fn>;
				dispose: ReturnType<typeof vi.fn>;
				hide: ReturnType<typeof vi.fn>;
		  }) => void)
		| undefined;
	let terminalInstance: {
		show: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
		hide: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		onDidCloseTerminalMock.mockImplementation(((
			callback: typeof closedTerminalHandler,
		) => {
			closedTerminalHandler = callback;
			return { dispose: vi.fn() };
		}) as never);
		findContextByFeatureId.mockReturnValue({
			agentManager: { markAgentStarted, recordAgentFailure },
		});
		adoptSession.mockReturnValue(false);
		createCommand.mockReturnValue('tmux new-session -d -s "session" "claude"');
		isSessionAlive.mockReturnValue(true);
		getPaneStatus.mockReturnValue(null);
		resolveAgentTool.mockReturnValue({
			id: "claude",
			name: "Claude Code",
			command: "claude",
		});
		buildLaunchCommand.mockReturnValue("claude");
		buildResumeLaunchCommand.mockReturnValue("claude --resume session-1");
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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
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
		expect(showErrorMessageMock).toHaveBeenCalledWith(
			"Failed to start Agent 1 with Claude Code. Check that the CLI is installed and launches from /repo/feature-one.",
		);
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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
			} as never,
		);

		vi.mocked(exec).mockReturnValue("");

		controller.createTerminal(
			feature,
			{ ...agent, hasStarted: false },
			0,
			true,
		);

		expect(buildLaunchCommand).toHaveBeenCalledWith(
			expect.objectContaining({ id: "claude" }),
			"session-1",
		);
		expect(buildResumeLaunchCommand).not.toHaveBeenCalled();
		expect(markAgentStarted).toHaveBeenCalledWith("a1", "f1");
		expect(notifyChange).toHaveBeenCalledTimes(1);
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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
			} as never,
		);

		findContextByFeatureId.mockReturnValue({
			agentManager: {
				markAgentStarted,
				recordAgentFailure,
				getAgents: vi.fn().mockReturnValue([{ ...agent, status: "running" }]),
			},
		});
		getPaneStatus.mockReturnValue({ dead: true, exitCode: 17 });
		vi.mocked(exec).mockReturnValue("");

		const terminal = controller.createTerminal(
			feature,
			{ ...agent, hasStarted: true },
			0,
		);
		expect(terminal).toBe(terminalInstance);
		expect(closedTerminalHandler).toBeDefined();

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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
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
			} as never,
			{
				resolveAgentTool,
				buildLaunchCommand,
				buildResumeLaunchCommand,
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
