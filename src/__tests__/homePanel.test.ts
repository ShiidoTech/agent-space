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
	const observe = vi.fn((value: typeof agent) => ({
		identity: { agentName: value.name, providerId: value.toolId },
		lifecycle: { state: value.status, source: "tmux" },
		attention: { state: "unknown", reason: "Provider activity unavailable" },
		session: { state: "ambiguous", detail: "Several candidates" },
	}));
	const ctx = { agentManager: { getAgents, observe } };
	const resolveFeature = vi.fn().mockReturnValue({ ctx, feature });

	let receiveMessage: ReturnType<typeof vi.fn>;
	let getTerminal: ReturnType<typeof vi.fn>;
	let focusOrCreateTerminalAsync: ReturnType<typeof vi.fn>;
	let getSnapshot: ReturnType<typeof vi.fn>;
	let invalidateFeature: ReturnType<typeof vi.fn>;
	let invalidateProject: ReturnType<typeof vi.fn>;
	let invalidateAll: ReturnType<typeof vi.fn>;
	let refreshProjectReferenceHealth: ReturnType<typeof vi.fn>;
	let reconcile: ReturnType<typeof vi.fn>;
	let reconcileFeature: ReturnType<typeof vi.fn>;
	let reconcileProject: ReturnType<typeof vi.fn>;

	function buildPanel(): HomePanel {
		receiveMessage = vi.fn();
		const webviewPanel = {
			visible: false,
			title: "",
			webview: {
				onDidReceiveMessage: receiveMessage,
				asWebviewUri: vi.fn(() => ({})),
			},
			onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
			reveal: vi.fn(),
		};
		getTerminal = vi.fn();
		getSnapshot = vi.fn();
		invalidateFeature = vi.fn();
		invalidateProject = vi.fn();
		invalidateAll = vi.fn();
		refreshProjectReferenceHealth = vi.fn();
		reconcile = vi.fn(() => Promise.resolve());
		reconcileFeature = vi.fn(() => Promise.resolve());
		reconcileProject = vi.fn(() => Promise.resolve());
		focusOrCreateTerminalAsync = vi.fn().mockResolvedValue({ show: vi.fn() });
		// @ts-expect-error HomePanel's constructor is private; the test drives
		// the panel directly rather than through the navigation lifecycle.
		const p = new HomePanel(
			webviewPanel as never,
			{ resolveFeature } as never,
			{
				getSnapshot,
				getProjectReferenceHealth: vi.fn(() => undefined),
				getProjectWorktreeBranches: vi.fn(() => undefined),
				invalidateFeature,
				invalidateProject,
				invalidateAll,
				refreshProjectReferenceHealth,
				reconcile,
				reconcileFeature,
				reconcileProject,
				acquireConsumer: vi.fn(),
				isFeatureStale: vi.fn(() => false),
				isProjectStale: vi.fn(() => false),
			} as never,
			{} as never,
			{ resolveAgentTool: vi.fn(() => ({ name: "Codex CLI" })) } as never,
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

	it("routes an explicit conversation link request to the extension command", () => {
		postMessage({
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

		// Feature-scoped refresh: only that Feature is invalidated/reconciled,
		// never a project-wide or global reconcile.
		expect(invalidateFeature).toHaveBeenCalledWith("f1");
		expect(reconcileFeature).toHaveBeenCalledWith("f1");
		expect(invalidateProject).not.toHaveBeenCalled();
		expect(invalidateAll).not.toHaveBeenCalled();
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("invalidates cached GitHub evidence on the global Refresh action too", () => {
		// No Feature/Project is currently open: the global fallback path.
		const p = buildPanel();
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		(p as any).currentFeatureId = null;
		postMessage({ command: "refresh", featureId: "" });

		expect(invalidateAll).toHaveBeenCalledTimes(1);
		expect(refreshProjectReferenceHealth).toHaveBeenCalledWith();
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it("focusing a stale Feature refreshes only that Feature, never a project-wide or global reconcile", () => {
		const panel = buildPanel();
		const isFeatureStale = (
			panel as unknown as {
				featureStateCoordinator: { isFeatureStale: ReturnType<typeof vi.fn> };
			}
		).featureStateCoordinator.isFeatureStale;
		isFeatureStale.mockReturnValue(true);
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		(panel as any).currentFeatureId = "f1";
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		(panel as any).maybeRefreshFocusedScope();

		expect(reconcileFeature).toHaveBeenCalledWith("f1");
		expect(reconcileProject).not.toHaveBeenCalled();
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("focusing a fresh Feature does not re-observe it at all", () => {
		const panel = buildPanel();
		const isFeatureStale = (
			panel as unknown as {
				featureStateCoordinator: { isFeatureStale: ReturnType<typeof vi.fn> };
			}
		).featureStateCoordinator.isFeatureStale;
		isFeatureStale.mockReturnValue(false);
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		(panel as any).currentFeatureId = "f1";
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		(panel as any).maybeRefreshFocusedScope();

		expect(reconcileFeature).not.toHaveBeenCalled();
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

	it("renders the Feature page from the local record before any snapshot exists", () => {
		const panel = buildPanel();
		const render = (
			panel as unknown as {
				renderFeatureLocalHtml: (ctx: unknown, feature: Feature) => string;
			}
		).renderFeatureLocalHtml.bind(panel);
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
					{
						id: "create-worktree",
						label: "Creating branch and worktree",
						status: "pending",
					},
				],
			},
		};

		const html = render(
			{ featureManager: { isProvisioningActive: () => true } },
			provisioningFeature,
		);

		expect(html).toContain("Feature One");
		expect(html).toContain("Setting up feature");
		expect(html).toContain("Observing Git state…");
		expect(html).toContain("Finish Feature");
	});

	it("hides the Finish action while the local Feature setup failed", () => {
		const panel = buildPanel();
		const render = (
			panel as unknown as {
				renderFeatureLocalHtml: (ctx: unknown, feature: Feature) => string;
			}
		).renderFeatureLocalHtml.bind(panel);
		const failedFeature: Feature = {
			...feature,
			provisioning: {
				state: "failed",
				steps: [
					{
						id: "resolve-base",
						label: "Preparing feature",
						status: "failed",
					},
				],
				error: "git worktree add failed",
			},
		};

		const html = render(
			{ featureManager: { isProvisioningActive: () => false } },
			failedFeature,
		);

		expect(html).toContain("Feature setup failed");
		expect(html).toContain("git worktree add failed");
		expect(html).not.toContain("Finish Feature");
	});

	it("uses the shared Feature summary and does not repeat its primary alert", () => {
		const panel = buildPanel();
		const render = (
			panel as unknown as {
				renderFeatureCockpit: (cockpit: unknown, snapshot: unknown) => string;
			}
		).renderFeatureCockpit.bind(panel);
		const html = render(
			{
				summary: {
					label: "Needs you",
					tone: "warning",
					detail:
						"2 continuation commits are not in PR #74 — Delivery stays on feat/audit_and_go.",
				},
				alerts: [
					{
						code: "continuation_not_delivered",
						severity: "warning",
						summary: "2 continuation commits are not in PR #74",
						detail: "Delivery stays on feat/audit_and_go.",
						evidence: {},
					},
				],
				hiddenAlertCount: 0,
				work: {
					workingTree: {
						status: "known",
						label: "Clean",
						pending: 0,
						staged: [],
						unstaged: [],
						untracked: [],
						conflicted: [],
						tone: "normal",
					},
					committed: {
						status: "known",
						label: "2 commits on Feature",
						featureCommits: 2,
						baseCommits: 0,
					},
				},
				delivery: {
					source: {
						label: "feat/audit_and_go @dc1be9b",
						tone: "warning",
						detail: "feat/feature_cockpit: 2 commits beyond delivery",
					},
					target: { label: "main" },
					tracking: { label: "No tracking branch", tone: "muted" },
					pullRequest: { label: "PR #74 open main", tone: "normal" },
					integration: { label: "PR open", tone: "normal" },
				},
				runtime: { label: "1 agent running", tone: "normal" },
				primaryAction: { kind: "open_workspace", label: "Review continuation" },
				observedAt: "2026-08-12T10:00:00.000Z",
			},
			{
				projectId: "p1",
				feature: {
					...feature,
					branch: "feat/feature_cockpit",
					primaryBranchRef: "feat/audit_and_go",
				},
				github: { observedAt: "2026-08-12T10:00:01.000Z" },
			},
		);

		expect(
			html.match(/2 continuation commits are not in PR #74/g),
		).toHaveLength(1);
		expect(html).toContain("Needs you");
		expect(html).toContain("Review continuation");
		expect(html).toContain("<summary>Evidence</summary>");
	});

	it("keeps only the non-duplicated bootstrap action below the cockpit", () => {
		const panel = buildPanel();
		const render = (
			panel as unknown as {
				renderQuickActions: (feature: Feature, hasBootstrap: boolean) => string;
			}
		).renderQuickActions.bind(panel);

		expect(render(feature, false)).toBe("");
		const bootstrap = render(feature, true);
		expect(bootstrap).toContain("Bootstrap Worktree");
		expect(bootstrap).not.toContain("Add Agent");
		expect(bootstrap).not.toContain("Add Service");
	});

	it("keeps the agent identity dominant without exposing session repair", () => {
		const panel = buildPanel();
		const render = (
			panel as unknown as {
				renderAgentPanel: (
					value: typeof agent,
					all: Array<typeof agent>,
					feature: Feature,
				) => string;
			}
		).renderAgentPanel.bind(panel);

		const html = render(agent, [agent], feature);

		expect(html).toContain('id="agent-name-a1"');
		expect(html).toContain(">Agent 1</span>");
		expect(html).toContain("Provider &middot; Codex CLI");
		expect(html).not.toContain("Link conversation");
		expect(html).toContain(">Open terminal</button>");
		expect(html).toContain(">Activity <span");
		expect(html).not.toContain("&#9243;");
	});
});
