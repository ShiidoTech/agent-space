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
import { AgentFocusService } from "../agents/agentFocusService";
import type { FeatureSnapshot } from "../features/featureSnapshot";
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
	let getProjectSnapshots: ReturnType<typeof vi.fn>;
	let getProjectReferenceHealth: ReturnType<typeof vi.fn>;
	let getProjectWorktreeBranches: ReturnType<typeof vi.fn>;
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
		getProjectSnapshots = vi.fn(() => []);
		getProjectReferenceHealth = vi.fn(() => undefined);
		getProjectWorktreeBranches = vi.fn(() => undefined);
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
			{ resolveFeature, getContext: vi.fn(() => undefined) } as never,
			{
				getSnapshot,
				getProjectSnapshots,
				getProjectReferenceHealth,
				getProjectWorktreeBranches,
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
		// The panel delegates agent focusing to the shared AgentFocusService;
		// wire a real service around this test's mocks so the issue-#69 focus
		// guarantees keep being exercised end to end.
		p.setAgentFocusService(
			new AgentFocusService({
				getTerminalController: () =>
					({ getTerminal, focusOrCreateTerminalAsync }) as never,
				resolveFeature: resolveFeature as never,
			}),
		);
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

	it("project page path: an explicit message featureId works with no current feature", () => {
		const p = buildPanel();
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		(p as any).currentFeatureId = null;
		const existingShow = vi.fn();
		getTerminal.mockReturnValue({ show: existingShow });

		const handler = receiveMessage.mock.calls[0][0] as (
			message: { command: string } & Record<string, unknown>,
		) => void;
		handler({ command: "focusAgent", featureId: "f1", agentId: "a1" });

		expect(existingShow).toHaveBeenCalledTimes(1);
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

	it("renders a reused-branch chip with the behind count", () => {
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		const html = (buildPanel() as any).renderReusedBranchChip({
			...feature,
			reusedExistingBranch: {
				relation: { status: "behind", ahead: 0, behind: 3 },
			},
		});
		expect(html).toContain("project-base-chip--warning");
		expect(html).toContain("reused &middot; 3 behind");
		expect(html).toContain("3 behind");
	});

	it("renders a plain reused-branch chip when the branch is up to date", () => {
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		const html = (buildPanel() as any).renderReusedBranchChip({
			...feature,
			reusedExistingBranch: {
				relation: { status: "current", ahead: 0, behind: 0 },
			},
		});
		expect(html).toContain("reused branch");
		expect(html).not.toContain("behind");
		expect(html).not.toContain("--warning");
	});

	it("renders no chip when the branch was created fresh", () => {
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		expect((buildPanel() as any).renderReusedBranchChip(feature)).toBe("");
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
			{
				project: { id: "p1", name: "Project" },
				featureManager: { isProvisioningActive: () => true },
			},
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
			{
				project: { id: "p1", name: "Project" },
				featureManager: { isProvisioningActive: () => false },
			},
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
		expect(html).toContain(
			'class="feature-cockpit-evidence">Evidence : 2026-08-12T10:00:00.000Z · 2026-08-12T10:00:01.000Z',
		);
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

	it("offers an Update button on the project page only when the base branch is behind or diverged", () => {
		const panel = buildPanel();
		const behindHealth = {
			branch: "main",
			remoteName: "origin",
			verifiedRemote: {
				status: "known",
				sha: "b".repeat(40),
				observedAt: "2026-08-12T10:00:00.000Z",
				provenance: {
					source: "remote_head",
					ref: "refs/heads/main",
					backend: "git ls-remote",
				},
			},
			verifiedRemoteRelation: {
				state: "behind",
				localOnly: 0,
				comparedOnly: 4,
			},
			state: "behind",
			remoteFreshness: {
				status: "fresh",
				observedAt: "2026-08-12T10:00:00.000Z",
				staleAfterMs: 300_000,
			},
		};
		getProjectReferenceHealth.mockReturnValue(behindHealth);
		const context = {
			project: { id: "p1", name: "Proj", repoPath: "/repo" },
			config: { baseBranch: undefined },
			featureManager: {
				getBranchKinds: () => [],
				getDefaultBranchKind: () => undefined,
				getWorktreeBase: () => "/repo/.worktrees",
			},
		};
		const projectManager = {
			getContext: vi.fn(() => context),
		};
		const render = (
			panel as unknown as {
				getProjectHtml: (projectId: string, settings?: boolean) => string;
			}
		).getProjectHtml.bind(panel);
		// bind a panel whose projectManager resolves the context.
		const bound = panel as unknown as {
			projectManager: typeof projectManager;
			getProjectHtml: (projectId: string, settings?: boolean) => string;
		};
		bound.projectManager = projectManager as never;
		const html = render("p1");

		expect(html).toContain("Update main");
		expect(html).toContain(
			'class="quick-action-btn project-base-update-btn" data-project-id="p1"',
		);
		expect(html).not.toContain("updateBaseBranch(");

		getProjectReferenceHealth.mockReturnValue({
			...behindHealth,
			verifiedRemoteRelation: {
				state: "current",
				localOnly: 0,
				comparedOnly: 0,
			},
			state: "current",
		});
		const currentHtml = render("p1");
		expect(currentHtml).not.toContain("Update main");
	});

	it("renders a delete action only for non-base, non-feature worktree branches", () => {
		const panel = buildPanel();
		getProjectReferenceHealth.mockReturnValue({
			branch: "main",
			remoteName: "origin",
			verifiedRemote: {
				status: "known",
				sha: "b".repeat(40),
				observedAt: "2026-08-12T10:00:00.000Z",
				provenance: {
					source: "remote_head",
					ref: "refs/heads/main",
					backend: "git ls-remote",
				},
			},
			verifiedRemoteRelation: {
				state: "current",
				localOnly: 0,
				comparedOnly: 0,
			},
			state: "current",
		});
		getProjectWorktreeBranches.mockReturnValue({
			repoPath: "/repo",
			baseRef: "main",
			status: "known",
			observedAt: "2026-08-12T10:00:00.000Z",
			branches: [
				{
					ref: "main",
					worktreePath: "/repo",
					headSha: "a".repeat(40),
					detached: false,
					prunable: false,
					baseRelation: { status: "current" },
					workingTree: { status: "clean" },
				},
				{
					ref: "feat/owned",
					worktreePath: "/repo/.worktrees/owned",
					headSha: "b".repeat(40),
					detached: false,
					prunable: false,
					baseRelation: { status: "merged" },
					workingTree: { status: "clean" },
					linkedFeatureId: "f2",
				},
				{
					ref: "feat/done",
					worktreePath: "/repo/.worktrees/done",
					headSha: "c".repeat(40),
					detached: false,
					prunable: false,
					baseRelation: { status: "merged" },
					workingTree: { status: "clean" },
				},
			],
		});
		(
			panel as unknown as {
				projectManager: { getContext: ReturnType<typeof vi.fn> };
			}
		).projectManager.getContext = vi.fn(() => ({
			project: { id: "p1", name: "Proj", repoPath: "/repo" },
		}));
		const render = (
			panel as unknown as {
				renderWorktreeBranches: (projectId: string) => string;
			}
		).renderWorktreeBranches.bind(panel);

		const html = render("p1");

		expect(html).toContain(">feat/done</span>");
		expect(html).toContain("worktree-branch-delete");
		expect(html).not.toContain("deleteWorktreeBranch('p1', 'main'");
		expect(html).toContain("feat/owned");
		expect(html.match(/worktree-branch-delete/g)).toHaveLength(1);
		expect(html).toContain(
			'data-branch-ref="feat/done" data-worktree-path="/repo/.worktrees/done"',
		);
		expect(html).not.toContain("onclick=");
	});

	it("escapes hostile branch refs in delete button data attributes", () => {
		const panel = buildPanel();
		getProjectReferenceHealth.mockReturnValue({
			branch: "main",
			remoteName: "origin",
			verifiedRemote: {
				status: "known",
				sha: "b".repeat(40),
				observedAt: "2026-08-12T10:00:00.000Z",
				provenance: {
					source: "remote_head",
					ref: "refs/heads/main",
					backend: "git ls-remote",
				},
			},
			verifiedRemoteRelation: {
				state: "current",
				localOnly: 0,
				comparedOnly: 0,
			},
			state: "current",
		});
		getProjectWorktreeBranches.mockReturnValue({
			repoPath: "/repo",
			baseRef: "main",
			status: "known",
			observedAt: "2026-08-12T10:00:00.000Z",
			branches: [
				{
					ref: "feat/it's(done)",
					worktreePath: "/repo/.worktrees/odd",
					headSha: "c".repeat(40),
					detached: false,
					prunable: false,
					baseRelation: { status: "merged" },
					workingTree: { status: "clean" },
				},
			],
		});
		(
			panel as unknown as {
				projectManager: { getContext: ReturnType<typeof vi.fn> };
			}
		).projectManager.getContext = vi.fn(() => ({
			project: { id: "p1", name: "Proj", repoPath: "/repo" },
		}));
		const render = (
			panel as unknown as {
				renderWorktreeBranches: (projectId: string) => string;
			}
		).renderWorktreeBranches.bind(panel);

		const html = render("p1");

		expect(html).toContain('data-branch-ref="feat/it&#039;s(done)"');
		expect(html).not.toContain("feat/it's(done)'");
		expect(html).not.toContain("onclick=");
	});

	it("routes updateBaseBranch and deleteWorktreeBranch messages to their commands", () => {
		const panel = buildPanel();
		const executeCommand = vi.mocked(vscode.commands.executeCommand);
		executeCommand.mockClear();

		const messageHandler = (
			panel as unknown as {
				handleMessage: (message: {
					command: string;
					[key: string]: unknown;
				}) => void;
			}
		).handleMessage.bind(panel);

		messageHandler({ command: "updateBaseBranch", projectId: "p1" });
		expect(executeCommand).toHaveBeenCalledWith(
			"agentSpace.updateBaseBranch",
			"p1",
		);

		messageHandler({
			command: "deleteWorktreeBranch",
			projectId: "p1",
			branchRef: "feat/done",
			worktreePath: "/repo/.worktrees/done",
		});
		expect(executeCommand).toHaveBeenCalledWith(
			"agentSpace.deleteWorktreeBranch",
			{
				projectId: "p1",
				branchRef: "feat/done",
				worktreePath: "/repo/.worktrees/done",
			},
		);
	});

	it("renders an external badge for worktrees outside the managed base", () => {
		const panel = buildPanel();
		getProjectWorktreeBranches.mockReturnValue({
			repoPath: "/repo",
			baseRef: "main",
			status: "known",
			observedAt: "2026-08-12T10:00:00.000Z",
			branches: [
				{
					ref: "feat/external",
					worktreePath: "/tmp/claude/worktree",
					headSha: "d".repeat(40),
					detached: false,
					prunable: false,
					baseRelation: { status: "merged" },
					workingTree: { status: "clean" },
					outsideBase: true,
				},
			],
		});
		(
			panel as unknown as {
				projectManager: { getContext: ReturnType<typeof vi.fn> };
			}
		).projectManager.getContext = vi.fn(() => ({
			project: { id: "p1", name: "Proj", repoPath: "/repo" },
		}));
		const render = (
			panel as unknown as {
				renderWorktreeBranches: (projectId: string) => string;
			}
		).renderWorktreeBranches.bind(panel);

		const html = render("p1");

		expect(html).toContain("worktree-branch-external");
		expect(html).toContain("worktree-branch-delete");
		expect(html).toContain("extra confirmation will be asked");
	});
});

describe("Home portfolio card (piloting view)", () => {
	const unknownGit = { status: "unknown", reason: "git_command_failed" };

	function makeSnapshot(overrides?: {
		id?: string;
		name?: string;
		status?: "active" | "done";
		createdAt?: string;
		base?: boolean;
		attention?: readonly {
			code: string;
			severity: "info" | "warning" | "error";
			summary: string;
			detail: string;
			evidence: Record<string, never>;
		}[];
	}): FeatureSnapshot {
		const id = overrides?.id ?? "f1";
		return {
			projectId: "p1",
			feature: {
				id: overrides?.base ? `base:p1` : id,
				name: overrides?.name ?? `Feature ${id}`,
				branch: overrides?.base ? "main" : `feat/${id}`,
				worktreePath: "/repo/.worktrees/x",
				status: overrides?.status ?? "active",
				color: "terminal.ansiBlue",
				isolation: "shared",
				createdAt: overrides?.createdAt ?? "2026-08-12T00:00:00Z",
			},
			source: { status: "known" },
			git: {
				repository: unknownGit,
				worktree: unknownGit,
				branch: unknownGit,
				head: unknownGit,
				feature: unknownGit,
				base: unknownGit,
				creationPoint: unknownGit,
				creationPointInFeature: unknownGit,
				upstream: unknownGit,
				upstreamDivergence: unknownGit,
				featureDelta: unknownGit,
				featureDiff: unknownGit,
				workingTree: unknownGit,
				worktrees: unknownGit,
				featureInBase: unknownGit,
			},
			github: {
				status: "unavailable",
				reason: "repository_unknown",
				provider: "github",
				repository: { status: "unknown", reason: "remote_unreadable" },
				observedAt: "2026-08-12T00:00:00Z",
			},
			integration: {
				status: "unknown",
				reason: "ancestry_unknown",
				evidence: {},
			},
			runtime: {
				agents: { status: "unknown", reason: "not_observed" },
				services: { status: "unknown", reason: "not_observed" },
			},
			attention: overrides?.attention ?? [],
			observedAt: "2026-08-12T00:00:00Z",
		} as unknown as FeatureSnapshot;
	}

	const summary = {
		projectId: "p1",
		projectName: "Agent Space",
		featureCount: 4,
		activeFeatureCount: 2,
		doneFeatureCount: 2,
		agentsActive: 3,
		servicesActive: 1,
		attentionCount: 0,
		lastObservedAt: undefined,
	};

	function renderCard(
		snapshots: FeatureSnapshot[],
		summaryOverrides?: Partial<typeof summary>,
	): string {
		const panel = Object.create(HomePanel.prototype) as HomePanel;
		Object.assign(panel, {
			featureStateCoordinator: {
				getProjectSummary: () => ({ ...summary, ...summaryOverrides }),
				getProjectSnapshots: () => snapshots,
				getProjectReferenceHealth: () => undefined,
			},
		});
		const ctx = {
			project: { id: "p1", name: "Agent Space", repoPath: "/repo/agent-space" },
			config: {},
		};
		return (
			panel as unknown as {
				renderProjectPortfolioCard: (ctx: unknown) => string;
			}
		).renderProjectPortfolioCard(ctx);
	}

	it("renders one piloting card per project with counters and a scoped action", () => {
		const html = renderCard([]);

		expect(html).toContain("onclick=\"showProject('p1')\"");
		expect(html).toContain(">Agent Space</div>");
		expect(html).toContain("<strong>2</strong>/4 features");
		expect(html).toContain("<strong>3</strong> agents");
		expect(html).toContain("<strong>1</strong> script");
		expect(html).not.toContain("portfolio-attention ");
		expect(html).toContain("No active features");
		expect(html).toContain("newFeature('p1')");
	});

	it("surfaces the worst attention severity across the project snapshots", () => {
		const html = renderCard(
			[
				makeSnapshot({
					id: "warned",
					attention: [
						{
							code: "working_tree_changes",
							severity: "warning",
							summary: "Uncommitted changes",
							detail: "2 files pending",
							evidence: {},
						},
					],
				}),
				makeSnapshot({
					id: "failed",
					attention: [
						{
							code: "agent_failed",
							severity: "error",
							summary: "Agent crashed",
							detail: "Exit code 1",
							evidence: {},
						},
					],
				}),
			],
			{ attentionCount: 2 },
		);

		expect(html).toContain("severity-error");
		expect(html).toContain(">2 need attention</span>");
	});

	it("colors the attention badge from base-snapshot alerts too", () => {
		const html = renderCard(
			[
				makeSnapshot({
					base: true,
					attention: [
						{
							code: "upstream_unknown",
							severity: "error",
							summary: "Base unreachable",
							detail: "Remote unreadable",
							evidence: {},
						},
					],
				}),
			],
			{ attentionCount: 1 },
		);

		expect(html).toContain("severity-error");
		expect(html).toContain(">1 needs attention</span>");
		// The synthetic base feature never appears in the preview rows.
		expect(html).not.toContain("openFeature('base:p1')");
	});

	it("previews the most recent active features and collapses the overflow", () => {
		const html = renderCard([
			makeSnapshot({ id: "old", createdAt: "2026-08-01T00:00:00Z" }),
			makeSnapshot({ id: "oldest", createdAt: "2026-07-31T00:00:00Z" }),
			makeSnapshot({ id: "newest", createdAt: "2026-08-21T00:00:00Z" }),
			makeSnapshot({
				id: "finished",
				status: "done",
				createdAt: "2026-08-22T00:00:00Z",
			}),
			makeSnapshot({ id: "newer", createdAt: "2026-08-20T00:00:00Z" }),
		]);

		const newest = html.indexOf("openFeature('newest')");
		const newer = html.indexOf("openFeature('newer')");
		const oldest = html.indexOf("openFeature('old')");
		expect(newest).toBeGreaterThan(-1);
		expect(newer).toBeGreaterThan(newest);
		expect(oldest).toBeGreaterThan(newer);
		expect(html).not.toContain("openFeature('finished')");
		expect(html).not.toContain("openFeature('oldest')");
		expect(html).toContain("+1 more&hellip;");
	});

	it("links the project attention badge to the scoped problems view", () => {
		const html = renderCard(
			[
				makeSnapshot({
					id: "warned",
					attention: [
						{
							code: "working_tree_changes",
							severity: "warning",
							summary: "Uncommitted changes",
							detail: "2 files pending",
							evidence: {},
						},
					],
				}),
			],
			{ attentionCount: 1 },
		);

		expect(html).toContain(
			"onclick=\"event.stopPropagation(); showProblems('p1')\"",
		);
	});
});

describe("Home problems view (portfolio-wide attention list)", () => {
	function makeAttention(
		severity: "info" | "warning" | "error",
		summary: string,
		detail: string,
	) {
		return { code: `code_${summary}`, severity, summary, detail, evidence: {} };
	}

	function makeProblemRow(severity: "info" | "warning" | "error") {
		return {
			feature: {
				id: `f-${severity}`,
				name: `Feature ${severity}`,
				branch: `feat/${severity}`,
				worktreePath: "/repo/.worktrees/x",
				status: "active",
				color: "terminal.ansiBlue",
				isolation: "shared",
				createdAt: "2026-08-12T00:00:00Z",
			},
			attention: [
				makeAttention(severity, `${severity} summary`, `${severity} detail`),
			],
		};
	}

	function renderProblems(options?: {
		projectFilter?: string;
		baseAttention?: ReturnType<typeof makeAttention>[];
	}): string {
		const snapshots = [
			makeProblemRow("warning"),
			makeProblemRow("error"),
			makeProblemRow("info"),
		] as unknown as FeatureSnapshot[];
		if (options?.baseAttention?.length) {
			snapshots.push({
				projectId: "p1",
				feature: {
					id: "base:p1",
					name: "base",
					branch: "main",
					worktreePath: "/repo",
					status: "active",
					color: "terminal.ansiBlue",
					isolation: "shared",
					createdAt: "2026-08-12T00:00:00Z",
				},
				attention: options.baseAttention,
			} as unknown as FeatureSnapshot);
		}
		const panel = Object.create(HomePanel.prototype) as HomePanel;
		Object.assign(panel, {
			panel: {
				webview: { asWebviewUri: () => "webview://asset" },
			},
			extensionUri: {},
			projectManager: {
				getAllContexts: () => [
					{ project: { id: "p1", name: "Agent Space", repoPath: "/repo" } },
					{ project: { id: "p2", name: "Other", repoPath: "/other" } },
				],
			},
			featureStateCoordinator: {
				getProjectSnapshots: (projectId: string) =>
					projectId === "p1" ? snapshots : [],
			},
		});
		return (
			panel as unknown as {
				getProblemsHtml: (projectId?: string) => string;
			}
		).getProblemsHtml(options?.projectFilter);
	}

	it("lists every problem worst-severity first and links rows to their feature", () => {
		const html = renderProblems();

		const error = html.indexOf('data-severity="error"');
		const warning = html.indexOf('data-severity="warning"');
		const info = html.indexOf('data-severity="info"');
		expect(error).toBeGreaterThan(-1);
		expect(warning).toBeGreaterThan(error);
		expect(info).toBeGreaterThan(warning);

		expect(html).toContain("error summary");
		expect(html).toContain("error detail");
		expect(html).toContain("onclick=\"openFeature('f-error')\"");
		expect(html).toContain(">All 3</button>");
	});

	it("routes base-snapshot problems to the project page, not the feature", () => {
		const html = renderProblems({
			baseAttention: [
				makeAttention("error", "Base unreachable", "Remote unreadable"),
			],
		});

		expect(html).toContain("Base unreachable");
		expect(html).toContain("onclick=\"showProject('p1')\"");
		expect(html).not.toContain("openFeature('base:p1')");
	});

	it("renders an empty state when the portfolio has no problems", () => {
		const panel = Object.create(HomePanel.prototype) as HomePanel;
		Object.assign(panel, {
			panel: { webview: { asWebviewUri: () => "webview://asset" } },
			extensionUri: {},
			projectManager: {
				getAllContexts: () => [
					{ project: { id: "p1", name: "Agent Space", repoPath: "/repo" } },
				],
			},
			featureStateCoordinator: { getProjectSnapshots: () => [] },
		});
		const html = (
			panel as unknown as {
				getProblemsHtml: (projectId?: string) => string;
			}
		).getProblemsHtml();

		expect(html).toContain("No attention items");
		expect(html).toContain("Errors 0");
	});

	it("scopes the list to one project with a chip back to all projects", () => {
		const html = renderProblems({ projectFilter: "p1" });

		expect(html).toContain("Project: Agent Space");
		expect(html).toContain("showProblems()");
		// The unfiltered view never shows another project's scope chip.
		expect(renderProblems()).not.toContain("Project: Agent Space");
	});
});
