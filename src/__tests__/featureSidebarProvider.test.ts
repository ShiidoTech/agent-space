import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn(() => Promise.resolve()) },
	window: { showInputBox: vi.fn(() => Promise.resolve("New Name")) },
	Uri: { joinPath: vi.fn(() => ({})) },
	ThemeIcon: class {},
	ThemeColor: class {},
}));

import * as vscode from "vscode";
import { AgentFocusService } from "../agents/agentFocusService";
import {
	FeatureSidebarProvider,
	presentSidebarFeatureSummary,
} from "../features/featureSidebarProvider";

describe("FeatureSidebarProvider.handleFocusAgent (issue #69)", () => {
	it("keeps runtime attention visible before deep evidence exists", () => {
		const snapshot = {
			feature: { id: "f1" },
			attention: [
				{
					code: "agent_waiting_for_user",
					severity: "warning",
					summary: "Agent needs attention",
					detail: "The agent is waiting for input.",
				},
			],
		} as never;

		expect(presentSidebarFeatureSummary(snapshot, false)).toEqual({
			label: "Needs you",
			tone: "warning",
			detail: "Agent needs attention — The agent is waiting for input.",
		});
		expect(presentSidebarFeatureSummary(snapshot, false)?.label).not.toBe(
			"Evidence unavailable",
		);
	});
	const feature = {
		id: "f1",
		name: "Feature One",
		branch: "feat/one",
		worktreePath: "/repo/feature-one",
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const agent = {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: "session-1",
		toolId: "claude",
		status: "running",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const getAgents = vi.fn().mockReturnValue([agent]);
	const ctx = { agentManager: { getAgents, getAgentsReadModel: getAgents } };
	const resolveFeature = vi.fn().mockReturnValue({ ctx, feature });

	let postMessage: ReturnType<typeof vi.fn>;
	let getTerminal: ReturnType<typeof vi.fn>;
	let existingShow: ReturnType<typeof vi.fn>;
	let focusOrCreateTerminalAsync: ReturnType<typeof vi.fn>;
	let provider: FeatureSidebarProvider;

	function buildProvider(): FeatureSidebarProvider {
		const p = new FeatureSidebarProvider(
			{ resolveFeature } as never,
			{} as never,
			{} as never,
			undefined,
			{} as never,
		);
		postMessage = vi.fn().mockResolvedValue(true);
		existingShow = vi.fn();
		getTerminal = vi.fn();
		focusOrCreateTerminalAsync = vi.fn().mockResolvedValue({ show: vi.fn() });

		// biome-ignore lint/suspicious/noExplicitAny: reaching into private fields for a focused unit test
		(p as any)._view = { webview: { postMessage } };
		p.setTerminalController({
			getTerminal,
			focusOrCreateTerminalAsync,
		} as never);
		// handleFocusAgent delegates to the shared AgentFocusService; wire a
		// real service around this test's mocks so the issue-#69 guarantees
		// keep being exercised through the sidebar's observer translation.
		p.setAgentFocusService(
			new AgentFocusService({
				getTerminalController: () =>
					({ getTerminal, focusOrCreateTerminalAsync }) as never,
				resolveFeature: resolveFeature as never,
			}),
		);
		return p;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		getAgents.mockReturnValue([agent]);
		resolveFeature.mockReturnValue({ ctx, feature });
		provider = buildProvider();
	});

	function focusAgent(agentId = "a1"): void {
		// biome-ignore lint/suspicious/noExplicitAny: invoking the private handler directly
		(provider as any).handleFocusAgent("f1", agentId);
	}

	it("warm path: shows the tracked terminal immediately with no reconciliation call", () => {
		getTerminal.mockReturnValue({ show: existingShow });

		focusAgent();

		expect(existingShow).toHaveBeenCalledTimes(1);
		expect(focusOrCreateTerminalAsync).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "focused",
		});
	});

	it("cold path: posts an immediate opening state and reconciles asynchronously", async () => {
		getTerminal.mockReturnValue(undefined);

		focusAgent();

		// The opening state must be posted synchronously, before the async
		// reconciliation promise has any chance to resolve.
		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "opening",
		});
		expect(focusOrCreateTerminalAsync).toHaveBeenCalledWith(
			feature,
			agent,
			0,
			true,
		);

		await Promise.resolve();
		await Promise.resolve();

		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "focused",
		});
	});

	it("does nothing when the agent no longer exists", () => {
		getAgents.mockReturnValue([]);

		focusAgent("missing-agent");

		expect(postMessage).not.toHaveBeenCalled();
		expect(focusOrCreateTerminalAsync).not.toHaveBeenCalled();
	});

	it("A cold → B warm: a stale cold resolution never steals focus from B", async () => {
		const agent2 = { ...agent, id: "a2", name: "Agent 2" };
		getAgents.mockReturnValue([agent, agent2]);
		const terminalB = { show: vi.fn() };
		getTerminal.mockImplementation((id: string) =>
			id === "a2" ? terminalB : undefined,
		);

		let resolveA!: (terminal: { show: ReturnType<typeof vi.fn> }) => void;
		const pendingA = new Promise<{ show: ReturnType<typeof vi.fn> }>(
			(resolve) => {
				resolveA = resolve;
			},
		);
		focusOrCreateTerminalAsync.mockReturnValue(pendingA);

		// Click A (cold, starts async reconciliation), then B (warm) while A
		// is still in flight — B must win focus immediately.
		focusAgent("a1");
		focusAgent("a2");

		expect(terminalB.show).toHaveBeenCalledTimes(1);
		expect(focusOrCreateTerminalAsync).toHaveBeenCalledWith(
			feature,
			agent,
			0,
			true,
		);

		// A's reconciliation now resolves: its terminal becomes tracked but
		// must NOT be revealed, and no "focused" claim is made for a stale
		// request.
		const terminalA = { show: vi.fn() };
		resolveA(terminalA);
		await pendingA;

		expect(terminalA.show).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "focused",
		});
		expect(terminalB.show).toHaveBeenCalledTimes(1);
	});

	it("double-click on the same cold agent: only the latest request reveals", async () => {
		getTerminal.mockReturnValue(undefined);
		let resolveA!: (terminal: { show: ReturnType<typeof vi.fn> }) => void;
		const pendingA = new Promise<{ show: ReturnType<typeof vi.fn> }>(
			(resolve) => {
				resolveA = resolve;
			},
		);
		// The controller coalesces both clicks onto one in-flight
		// reconciliation; the provider only decides who reveals at resolution.
		focusOrCreateTerminalAsync.mockReturnValue(pendingA);

		focusAgent("a1");
		focusAgent("a1");

		expect(focusOrCreateTerminalAsync).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "opening",
		});

		const terminalA = { show: vi.fn() };
		resolveA(terminalA);
		await pendingA;

		// Only the latest (second) request is still current → revealed once,
		// single "focused" claim.
		expect(terminalA.show).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "focused",
		});
	});

	it("routes an explicit conversation link request to the extension command", () => {
		let onMessage:
			| ((message: { command: string } & Record<string, string>) => void)
			| undefined;
		const linkProvider = new FeatureSidebarProvider(
			{ getAllContexts: () => [] } as never,
			{
				acquireConsumer: () => ({ dispose: vi.fn() }),
				reconcile: () => Promise.resolve(),
			} as never,
			{} as never,
			undefined,
			{} as never,
		);
		linkProvider.resolveWebviewView({
			visible: true,
			webview: {
				options: {},
				html: "",
				asWebviewUri: vi.fn(() => "asset"),
				postMessage: vi.fn(() => Promise.resolve(true)),
				onDidReceiveMessage: vi.fn((handler) => {
					onMessage = handler;
					return { dispose: vi.fn() };
				}),
			},
			onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
		} as never);

		onMessage?.({
			command: "attachProviderSession",
			featureId: "f1",
			agentId: "a1",
		});

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"agentSpace.attachProviderSession",
			"f1",
			"a1",
		);
	});
});

describe("issue #120: non-structural notifyChange scope (zero-reload eligible)", () => {
	// renameAgent never adds/removes a card, so it reports `structural: false`
	// and extension.ts can patch the sidebar/Home DOM in place. stopService/
	// restartService move a service card between the running/stopped DOM
	// sections (renderServicesSection) with a different action button —
	// today's incremental patch doesn't perform that move, so they must stay
	// structural (full rebuild) until it does (PR review on #121).
	function buildProvider(overrides: {
		serviceManager?: Record<string, unknown>;
		agentManager?: Record<string, unknown>;
	}) {
		const notifyChange = vi.fn();
		const service = { id: "s1", tmuxSession: "svc" };
		const agent = { id: "a1", name: "Agent 1" };
		const feature = { id: "f1", worktreePath: "/repo/f1" };
		const ctx = {
			serviceManager: {
				getServices: vi.fn(() => [service]),
				stopService: vi.fn(),
				restartService: vi.fn(),
				...overrides.serviceManager,
			},
			agentManager: {
				getAgentsReadModel: vi.fn(() => [agent]),
				renameAgent: vi.fn(),
				...overrides.agentManager,
			},
		};
		const projectManager = {
			findContextByFeatureId: vi.fn(() => ctx),
			resolveFeature: vi.fn(() => ({ ctx, feature })),
			notifyChange,
		};
		const provider = new FeatureSidebarProvider(
			projectManager as never,
			{} as never,
			{} as never,
			undefined,
			{} as never,
		);
		return { provider, notifyChange, ctx };
	}

	it("handleStopService still reports a structural (full-rebuild) change", () => {
		const { provider, notifyChange } = buildProvider({});
		// biome-ignore lint/suspicious/noExplicitAny: invoking the private handler directly
		(provider as any).handleStopService("f1", "s1");

		expect(notifyChange).toHaveBeenCalledWith({ featureId: "f1" });
	});

	it("handleRestartService still reports a structural (full-rebuild) change", () => {
		const { provider, notifyChange } = buildProvider({});
		// biome-ignore lint/suspicious/noExplicitAny: invoking the private handler directly
		(provider as any).handleRestartService("f1", "s1");

		expect(notifyChange).toHaveBeenCalledWith({ featureId: "f1" });
	});

	it("handleRenameAgent reports a non-structural, feature-scoped change", async () => {
		const { provider, notifyChange } = buildProvider({});
		// biome-ignore lint/suspicious/noExplicitAny: invoking the private handler directly
		await (provider as any).handleRenameAgent("f1", "a1");

		expect(notifyChange).toHaveBeenCalledWith({
			featureId: "f1",
			structural: false,
		});
	});
});
