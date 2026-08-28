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

import {
	getWebviewRebuildCounts,
	resetWebviewRebuildCounts,
} from "../diagnostics/webviewRebuildDiagnostics";
import { createFeatureChangeFlusher } from "../features/featureChangeRouting";
import { FeatureSidebarProvider } from "../features/featureSidebarProvider";
import type { FeatureSnapshot } from "../features/featureSnapshot";
import { HomePanel } from "../home/homePanel";
import type { Feature } from "../types";

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

function buildSnapshot(): FeatureSnapshot {
	// `sendGitStatsAsync` (the incremental Home patch path) only reads
	// `runtime.agents` and `git.featureDiff`; the full-rebuild render path
	// (`getFeatureHtml`) is stubbed in the tests below, so this snapshot is
	// intentionally not a complete `FeatureSnapshot` fixture.
	return {
		feature,
		attention: [],
		runtime: {
			agents: { status: "known", value: [{ agent }] },
			services: { status: "known", value: [] },
		},
		git: { featureDiff: { status: "unknown" } },
	} as unknown as FeatureSnapshot;
}

describe("issue #120: zero full-document rebuild for non-structural transitions", () => {
	beforeEach(() => {
		resetWebviewRebuildCounts();
		HomePanel["featurePanels"].clear();
		HomePanel["instance"] = undefined;
	});

	function buildSidebar() {
		const sidebarWebview = {
			set html(_value: string) {
				htmlAssignments += 1;
			},
			postMessage: vi.fn().mockResolvedValue(true),
			asWebviewUri: vi.fn(() => "asset"),
			onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
		};
		let htmlAssignments = 0;
		const provider = new FeatureSidebarProvider(
			{ getAllContexts: () => [] } as never,
			{
				acquireConsumer: () => ({ dispose: vi.fn() }),
				reconcilePresence: vi.fn().mockResolvedValue(undefined),
				getProjectSnapshots: () => [],
			} as never,
			{} as never,
			undefined,
			{} as never,
		);
		provider.resolveWebviewView({
			visible: true,
			webview: sidebarWebview,
			onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
		} as never);
		return { provider, getHtmlAssignments: () => htmlAssignments };
	}

	function buildHomePanelBase(featureId: string | undefined) {
		const receiveMessage = vi.fn();
		const webviewPanel = {
			visible: false,
			title: "",
			webview: {
				onDidReceiveMessage: receiveMessage,
				asWebviewUri: vi.fn(() => ({})),
				postMessage: vi.fn(),
				set html(_value: string) {
					htmlAssignments += 1;
				},
			},
			onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
			reveal: vi.fn(),
		};
		let htmlAssignments = 0;
		const getSnapshot = vi.fn(() => buildSnapshot());
		// @ts-expect-error HomePanel's constructor is private; test drives the
		// panel directly, matching the existing homePanel.test.ts pattern.
		const panel = new HomePanel(
			webviewPanel as never,
			{
				resolveFeature: vi.fn(() => ({
					ctx: {
						agentManager: {
							observe: vi.fn(() => ({
								identity: { agentName: agent.name },
								lifecycle: { state: "running", source: "agentspace" },
								attention: { state: "working" },
								session: { state: "bound" },
							})),
						},
					},
					feature,
				})),
				getContext: vi.fn(() => undefined),
			} as never,
			{
				getSnapshot,
				getProjectSnapshots: vi.fn(() => []),
				getProjectReferenceHealth: vi.fn(() => undefined),
				getProjectWorktreeBranches: vi.fn(() => undefined),
				invalidateFeature: vi.fn(),
				invalidateProject: vi.fn(),
				invalidateAll: vi.fn(),
				refreshProjectReferenceHealth: vi.fn(),
				reconcile: vi.fn(() => Promise.resolve()),
				reconcileFeature: vi.fn(() => Promise.resolve()),
				reconcileProject: vi.fn(() => Promise.resolve()),
				acquireConsumer: vi.fn(() => ({ dispose: vi.fn() })),
				isFeatureStale: vi.fn(() => false),
				isProjectStale: vi.fn(() => false),
			} as never,
			{} as never,
			{ resolveAgentTool: vi.fn(() => ({ name: "Claude" })) } as never,
			{} as never,
			{} as never,
			undefined,
			featureId,
		);
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		if (featureId) (panel as any).currentFeatureId = featureId;
		// The full HTML render path is exercised by featureCockpitPresentation
		// tests; here we only care that the rebuild counter/webview.html write
		// happen exactly when the incremental-vs-full routing contract says
		// they should, so stub the (expensive-to-mock) render itself.
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		vi.spyOn(panel as any, "getFeatureHtml").mockReturnValue("<html></html>");
		// biome-ignore lint/suspicious/noExplicitAny: focused unit test
		vi.spyOn(panel as any, "getWelcomeHtml").mockReturnValue("<html></html>");
		return { panel, getHtmlAssignments: () => htmlAssignments };
	}

	function buildHomeFeaturePanel(featureId = "f1") {
		const built = buildHomePanelBase(featureId);
		HomePanel["featurePanels"].set(featureId, built.panel);
		return built;
	}

	/** The portfolio/project singleton panel (`HomePanel.instance`) — never a Feature panel. */
	function buildHomeInstance() {
		const built = buildHomePanelBase(undefined);
		HomePanel["instance"] = built.panel;
		return built;
	}

	it("sidebar.refreshState() never assigns webview.html or increments the rebuild counter", async () => {
		const { provider, getHtmlAssignments } = buildSidebar();
		const before = getHtmlAssignments();

		for (let i = 0; i < 5; i++) {
			provider.refreshState();
			await Promise.resolve();
		}

		expect(getHtmlAssignments()).toBe(before);
		expect(getWebviewRebuildCounts().sidebar).toBe(0);
	});

	it("sidebar.refresh() assigns webview.html and increments the rebuild counter", async () => {
		const { provider, getHtmlAssignments } = buildSidebar();
		const before = getHtmlAssignments();

		provider.refresh();
		await Promise.resolve();
		await Promise.resolve();

		expect(getHtmlAssignments()).toBe(before + 1);
		expect(getWebviewRebuildCounts().sidebar).toBe(1);
	});

	it("HomePanel.refreshLive({structural:false}) patches the open Feature panel without a full rebuild", () => {
		const { getHtmlAssignments } = buildHomeFeaturePanel();
		const before = getHtmlAssignments();

		for (let i = 0; i < 5; i++) {
			HomePanel.refreshLive({ featureId: "f1", structural: false });
		}

		expect(getHtmlAssignments()).toBe(before);
		expect(getWebviewRebuildCounts().home).toBe(0);
	});

	it("HomePanel.refreshLive() falls back to a full rebuild for structural/unscoped changes", () => {
		const { getHtmlAssignments } = buildHomeFeaturePanel();
		const before = getHtmlAssignments();

		HomePanel.refreshLive({ featureId: "f1", structural: true });

		expect(getHtmlAssignments()).toBe(before + 1);
		expect(getWebviewRebuildCounts().home).toBe(1);
	});

	it("a scripted multi-transition scenario of only non-structural changes yields zero rebuilds across both surfaces", async () => {
		const { provider: sidebar, getHtmlAssignments: sidebarHtml } =
			buildSidebar();
		const { getHtmlAssignments: homeHtml } = buildHomeFeaturePanel();
		const sidebarBefore = sidebarHtml();
		const homeBefore = homeHtml();

		// Simulates extension.ts's projectManager.onChange routing for a
		// sequence of status/service/rename transitions on already-known
		// agents/services (working -> waiting -> working -> idle, service
		// restart, rename) — the exact scenario issue #120 requires to be
		// reload-free after initial mount.
		for (let i = 0; i < 10; i++) {
			sidebar.refreshState();
			HomePanel.refreshLive({ featureId: "f1", structural: false });
			await Promise.resolve();
		}

		expect(sidebarHtml()).toBe(sidebarBefore);
		expect(homeHtml()).toBe(homeBefore);
		expect(getWebviewRebuildCounts()).toEqual({ sidebar: 0, home: 0 });
	});

	// PR #121 second review: a runtime event for a Feature with no open panel
	// must never fall back to `HomePanel.refreshAll()` (which would rebuild
	// every unrelated open Feature panel too, and could do so N times per
	// flush). This exercises the real `createFeatureChangeFlusher` wired to
	// the real `HomePanel.patchLiveFeature`/`refreshInstance` fallback — not
	// mocks of them — with f1 open and f2 unopened in the same flush.
	it("real flusher + real HomePanel fallback: an unopened Feature's runtime change costs one bounded instance refresh, never touches f1's open panel", async () => {
		const { getHtmlAssignments: f1Html } = buildHomeFeaturePanel("f1");
		const { getHtmlAssignments: instanceHtml } = buildHomeInstance();
		const f1Before = f1Html();
		const instanceBefore = instanceHtml();

		let scheduled: (() => void) | undefined;
		const flush = createFeatureChangeFlusher(
			{
				refreshSidebarState: () => {},
				refreshHomeAll: () => HomePanel.refreshAll(),
				patchHomeFeature: (featureId) => HomePanel.patchLiveFeature(featureId),
				refreshHomeInstance: () => HomePanel.refreshInstance(),
				nudgeAttention: () => {},
			},
			150,
			(fn) => {
				scheduled = fn;
			},
		);

		flush({ feature: { id: "f1" } } as unknown as FeatureSnapshot, "runtime");
		flush({ feature: { id: "f2" } } as unknown as FeatureSnapshot, "runtime");
		scheduled?.();
		await Promise.resolve();

		// f1's own open panel was patched incrementally — no rebuild.
		expect(f1Html()).toBe(f1Before);
		// f2 has no open panel: the portfolio singleton absorbs it, exactly
		// once, and f1's unrelated panel is never touched by that fallback.
		expect(instanceHtml()).toBe(instanceBefore + 1);
		expect(getWebviewRebuildCounts()).toEqual({ sidebar: 0, home: 1 });
	});
});
