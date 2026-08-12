import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	window: { createWebviewPanel: vi.fn() },
	commands: { executeCommand: vi.fn(() => Promise.resolve()) },
	env: { openExternal: vi.fn(() => Promise.resolve(true)) },
	Uri: {
		joinPath: vi.fn(() => ({})),
		parse: vi.fn((value: string) => {
			const parsed = new URL(value);
			return {
				scheme: parsed.protocol.slice(0, -1),
				authority: parsed.host,
				toString: () => value,
			};
		}),
	},
	ViewColumn: { One: 1 },
	ThemeIcon: class {},
	ThemeColor: class {},
}));

import * as vscode from "vscode";
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
	let getSnapshot: ReturnType<typeof vi.fn>;
	let invalidate: ReturnType<typeof vi.fn>;
	let refreshProjectReferenceHealth: ReturnType<typeof vi.fn>;
	let reconcile: ReturnType<typeof vi.fn>;

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
		getSnapshot = vi.fn();
		invalidate = vi.fn();
		refreshProjectReferenceHealth = vi.fn();
		reconcile = vi.fn(() => Promise.resolve());
		focusOrCreateTerminalAsync = vi.fn().mockResolvedValue({ show: vi.fn() });
		// @ts-expect-error HomePanel's constructor is private; the test drives
		// the panel directly rather than through the navigation lifecycle.
		const p = new HomePanel(
			webviewPanel as never,
			{ resolveFeature } as never,
			{
				getSnapshot,
				invalidate,
				refreshProjectReferenceHealth,
				reconcile,
				acquireConsumer: vi.fn(),
			} as never,
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

	function postMessage(message: { command: string } & Record<string, unknown>) {
		const handler = receiveMessage.mock.calls[0][0] as (
			value: { command: string } & Record<string, unknown>,
		) => void;
		handler(message);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		getAgents.mockReturnValue([agent, secondAgent]);
		resolveFeature.mockReturnValue({ ctx, feature });
		buildPanel();
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

	it("opens only the PR URL observed by the extension host", () => {
		getSnapshot.mockReturnValue({
			github: {
				status: "known",
				resolution: {
					outcome: "selected",
					pull: {
						url: "https://github.com/ShiidoTech/agent-space/pull/74",
					},
				},
			},
		});

		postMessage({
			command: "openPullRequest",
			featureId: "f1",
			url: "https://attacker.invalid/steal",
		});

		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
		expect(vscode.env.openExternal).toHaveBeenCalledWith(
			expect.objectContaining({
				scheme: "https",
				authority: "github.com",
			}),
		);
	});

	it("does not open a URL when PR evidence is unknown", () => {
		getSnapshot.mockReturnValue({
			github: { status: "unknown", reason: "remote_unreadable" },
		});

		postMessage({ command: "openPullRequest", featureId: "f1" });

		expect(vscode.env.openExternal).not.toHaveBeenCalled();
	});

	it("refreshes the selected Feature evidence instead of only repainting", () => {
		postMessage({ command: "refresh", featureId: "f1" });

		expect(invalidate).toHaveBeenCalledWith("f1");
		expect(refreshProjectReferenceHealth).toHaveBeenCalledTimes(1);
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it("renders a setup spinner only for a locally-owned provisioning attempt", () => {
		const panel = buildPanel();
		const provisioningFeature: Feature = {
			...feature,
			provisioning: {
				state: "provisioning",
				steps: [
					{
						id: "resolve-base",
						label: "Preparing feature",
						status: "running",
					},
				],
			},
		};
		const render = (
			panel as unknown as {
				renderFeatureProvisioning: (
					feature: Feature,
					locallyActive: boolean,
				) => string;
			}
		).renderFeatureProvisioning.bind(panel);

		const local = render(provisioningFeature, true);
		const orphaned = render(provisioningFeature, false);

		expect(local).toContain("Setting up feature");
		expect(local).toContain("lifecycle-spinner");
		expect(orphaned).toContain("Feature setup state unknown");
		expect(orphaned).not.toContain("lifecycle-spinner");
	});
});
