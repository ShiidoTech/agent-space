import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	window: { createWebviewPanel: vi.fn() },
	commands: { executeCommand: vi.fn(() => Promise.resolve()) },
	Uri: { joinPath: vi.fn(() => ({})) },
	ViewColumn: { One: 1 },
	ThemeIcon: class {},
	ThemeColor: class {},
}));

import { HomePanel } from "../home/homePanel";
import type { Feature } from "../types";

describe("HomePanel.focusAgentTerminal (issue #69 hardened path)", () => {
	const feature: Feature = {
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

	const secondAgent = {
		id: "b1",
		featureId: "f1",
		name: "Agent 2",
		sessionId: "session-2",
		toolId: "claude",
		status: "running",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const getAgents = vi.fn().mockReturnValue([agent, secondAgent]);
	const ctx = { agentManager: { getAgents } };
	const resolveFeature = vi.fn().mockReturnValue({ ctx, feature });

	let receiveMessage: ReturnType<typeof vi.fn>;
	let getTerminal: ReturnType<typeof vi.fn>;
	let focusOrCreateTerminalAsync: ReturnType<typeof vi.fn>;
	let panel: HomePanel;

	function buildPanel(): HomePanel {
		receiveMessage = vi.fn();
		const webviewPanel = {
			visible: false,
			title: "",
			webview: { onDidReceiveMessage: receiveMessage },
			onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
			reveal: vi.fn(),
		};
		getTerminal = vi.fn();
		focusOrCreateTerminalAsync = vi.fn().mockResolvedValue({ show: vi.fn() });
		// @ts-expect-error HomePanel's constructor is private; the test drives
		// the panel directly rather than through the navigation lifecycle.
		const p = new HomePanel(
			webviewPanel as never,
			{ resolveFeature } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{ getTerminal, focusOrCreateTerminalAsync } as never,
			feature.id,
		);
		// Reaching into the private field so the message handler can run the
		// focus path without the full panel navigation lifecycle.
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		(p as any).currentFeatureId = "f1";
		return p;
	}

	function focusAgent(agentId = "a1"): void {
		const handler = receiveMessage.mock.calls[0][0] as (
			message: { command: string } & Record<string, unknown>,
		) => void;
		handler({ command: "focusAgent", agentId });
	}

	beforeEach(() => {
		vi.clearAllMocks();
		getAgents.mockReturnValue([agent, secondAgent]);
		resolveFeature.mockReturnValue({ ctx, feature });
		panel = buildPanel();
	});

	it("warm path: shows the tracked terminal immediately with no reconciliation call", () => {
		const existingShow = vi.fn();
		getTerminal.mockReturnValue({ show: existingShow });

		focusAgent();

		expect(existingShow).toHaveBeenCalledTimes(1);
		expect(focusOrCreateTerminalAsync).not.toHaveBeenCalled();
	});

	it("cold path: reconciles asynchronously and reveals on resolution", async () => {
		getTerminal.mockReturnValue(undefined);
		const coldShow = vi.fn();
		focusOrCreateTerminalAsync.mockResolvedValue({ show: coldShow });

		focusAgent();

		expect(focusOrCreateTerminalAsync).toHaveBeenCalledWith(
			feature,
			agent,
			0,
			true,
		);
		expect(coldShow).not.toHaveBeenCalled();

		await Promise.resolve();
		await Promise.resolve();

		expect(coldShow).toHaveBeenCalledTimes(1);
	});

	it("cold path failure: records the reconciliation but never shows", async () => {
		getTerminal.mockReturnValue(undefined);
		focusOrCreateTerminalAsync.mockResolvedValue(undefined);

		focusAgent();

		await Promise.resolve();
		await Promise.resolve();

		expect(focusOrCreateTerminalAsync).toHaveBeenCalledTimes(1);
	});

	it("cold A resolving after warm B focus does not steal focus from B", async () => {
		const showA = vi.fn();
		const showB = vi.fn();
		getTerminal.mockImplementation((id: string) =>
			id === "b1" ? { show: showB } : undefined,
		);
		focusOrCreateTerminalAsync.mockResolvedValue({ show: showA });

		// A cold: async reconciliation starts; B warm: shown synchronously.
		focusAgent("a1");
		focusAgent("b1");

		expect(showB).toHaveBeenCalledTimes(1);

		// A resolves last; its cold reveal must be suppressed so B keeps focus.
		await Promise.resolve();
		await Promise.resolve();

		expect(showA).not.toHaveBeenCalled();
	});

	it("two cold agents resolving out of order reveal only the last-focused one", async () => {
		const showA = vi.fn();
		const showB = vi.fn();
		getTerminal.mockReturnValue(undefined);
		focusOrCreateTerminalAsync
			.mockResolvedValueOnce({ show: showA })
			.mockResolvedValueOnce({ show: showB });

		focusAgent("a1");
		focusAgent("b1");

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(showB).toHaveBeenCalledTimes(1);
		expect(showA).not.toHaveBeenCalled();
	});
});
