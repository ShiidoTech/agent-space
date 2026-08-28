import * as vscode from "vscode";
import type { AgentFocusService } from "../agents/agentFocusService";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import { presentAgentCard } from "../agents/observation/presentAgentCard";
import type { TerminalController } from "../agents/terminalController";
import type { TmuxIntegration } from "../agents/tmux";
import { TERMINAL_COLOR_HEX, TERMINAL_COLOR_MAP } from "../constants/colors";
import { ICON_BRAND } from "../constants/icons";
import { agentSpaceDiagnostic } from "../diagnostics/agentSpaceDiagnostics";
import { recordFullRebuild } from "../diagnostics/webviewRebuildDiagnostics";
import {
	type FeatureCockpitPresentation,
	type FeatureCockpitPrimaryAction,
	presentFeatureCockpit,
} from "../features/featureCockpitPresentation";
import type { FeatureSnapshot } from "../features/featureSnapshot";
import type { FeatureStateCoordinator } from "../features/featureStateCoordinator";
import {
	hasSharedProjectConfig,
	loadSharedProjectConfig,
	type ProjectConfig,
	projectConfigTemplate,
	pruneEmptyConfig,
} from "../projects/projectConfig";
import { PROTECTED_BRANCH_NAMES } from "../projects/projectGitOps";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { GlobalStore } from "../storage/globalStore";
import type { Agent, Feature, Service } from "../types";

export class HomePanel {
	public static readonly viewType = "agentSpace.home";
	private static instance: HomePanel | undefined;
	private static featurePanels = new Map<string, HomePanel>();

	private readonly panel: vscode.WebviewPanel;
	private readonly projectManager: ProjectManager;
	private readonly tmux: TmuxIntegration;
	private readonly toolRegistry: CodingToolRegistry;
	private readonly extensionUri: vscode.Uri;
	private readonly globalStore: GlobalStore;
	private terminalController?: TerminalController;
	private agentFocus?: AgentFocusService;
	private currentFeatureId: string | null = null;
	private currentProjectId: string | null = null;
	private currentProjectSettings = false;
	private showingProblems = false;
	private problemsProjectFilter: string | undefined;
	private onViewStateChangeCallback?:
		| ((state: { active: boolean; visible: boolean }) => void)
		| undefined;
	private disposables: vscode.Disposable[] = [];
	private coordinatorConsumer?: { dispose: () => void };

	public static createOrShow(
		projectManager: ProjectManager,
		featureStateCoordinator: FeatureStateCoordinator,
		tmux: TmuxIntegration,
		toolRegistry: CodingToolRegistry,
		extensionUri: vscode.Uri,
		globalStore: GlobalStore,
		terminalController?: TerminalController,
	): HomePanel {
		if (HomePanel.instance) {
			HomePanel.instance.panel.reveal(vscode.ViewColumn.One);
			return HomePanel.instance;
		}

		const panel = vscode.window.createWebviewPanel(
			HomePanel.viewType,
			"Agent Space",
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, "media", "webview"),
				],
			},
		);

		HomePanel.instance = new HomePanel(
			panel,
			projectManager,
			featureStateCoordinator,
			tmux,
			toolRegistry,
			extensionUri,
			globalStore,
			terminalController,
		);
		HomePanel.instance.showWelcome();
		return HomePanel.instance;
	}

	public static createOrShowFeature(
		featureId: string,
		projectManager: ProjectManager,
		featureStateCoordinator: FeatureStateCoordinator,
		tmux: TmuxIntegration,
		toolRegistry: CodingToolRegistry,
		extensionUri: vscode.Uri,
		globalStore: GlobalStore,
		terminalController?: TerminalController,
	): HomePanel {
		const existing = HomePanel.featurePanels.get(featureId);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.One);
			return existing;
		}

		const panel = vscode.window.createWebviewPanel(
			HomePanel.viewType,
			"Agent Space",
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, "media", "webview"),
				],
			},
		);
		const featurePanel = new HomePanel(
			panel,
			projectManager,
			featureStateCoordinator,
			tmux,
			toolRegistry,
			extensionUri,
			globalStore,
			terminalController,
			featureId,
		);
		HomePanel.featurePanels.set(featureId, featurePanel);
		featurePanel.showFeature(featureId);
		return featurePanel;
	}

	public static getInstance(): HomePanel | undefined {
		return HomePanel.instance;
	}

	public static refreshAll(): void {
		HomePanel.instance?.refresh();
		for (const panel of HomePanel.featurePanels.values()) panel.refresh();
	}

	private constructor(
		panel: vscode.WebviewPanel,
		projectManager: ProjectManager,
		private readonly featureStateCoordinator: FeatureStateCoordinator,
		tmux: TmuxIntegration,
		toolRegistry: CodingToolRegistry,
		extensionUri: vscode.Uri,
		globalStore: GlobalStore,
		terminalController?: TerminalController,
		private readonly featurePanelId?: string,
	) {
		this.panel = panel;
		this.projectManager = projectManager;
		this.tmux = tmux;
		this.toolRegistry = toolRegistry;
		this.extensionUri = extensionUri;
		this.globalStore = globalStore;
		this.terminalController = terminalController;
		this.setConsumerVisible(panel.visible);

		this.setupMessageHandler();
		this.panel.onDidChangeViewState(
			({ webviewPanel }) => {
				this.setConsumerVisible(webviewPanel.visible);
				this.onViewStateChangeCallback?.({
					active: webviewPanel.active,
					visible: webviewPanel.visible,
				});
			},
			null,
			this.disposables,
		);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	private setConsumerVisible(visible: boolean): void {
		if (visible) {
			this.coordinatorConsumer ??=
				this.featureStateCoordinator.acquireConsumer();
			this.maybeRefreshFocusedScope();
			return;
		}
		this.coordinatorConsumer?.dispose();
		this.coordinatorConsumer = undefined;
	}

	/**
	 * Refreshes only the currently displayed Feature/Project when its deep
	 * evidence is stale. Never touches any other Feature/Project — opening or
	 * refocusing this page must not pay for unrelated observation.
	 */
	private maybeRefreshFocusedScope(): void {
		if (this.currentFeatureId) {
			const featureId = this.currentFeatureId;
			if (this.featureStateCoordinator.isFeatureStale(featureId)) {
				void this.featureStateCoordinator.reconcileFeature(featureId);
			}
			return;
		}
		if (this.currentProjectId) {
			const projectId = this.currentProjectId;
			if (this.featureStateCoordinator.isProjectStale(projectId)) {
				void this.featureStateCoordinator.reconcileProject(projectId);
			}
		}
	}

	public setTerminalController(controller: TerminalController): void {
		this.terminalController = controller;
	}

	public onViewStateChange(
		callback: (state: { active: boolean; visible: boolean }) => void,
	): void {
		this.onViewStateChangeCallback = callback;
	}

	public showWelcome(): void {
		this.currentFeatureId = null;
		this.currentProjectId = null;
		this.showingProblems = false;
		this.problemsProjectFilter = undefined;
		this.panel.title = "Agent Space";
		this.panel.webview.html = this.getWelcomeHtml();
	}

	public showFeature(featureId: string): void {
		const startedAt = Date.now();
		this.currentFeatureId = featureId;
		this.currentProjectId = null;
		this.showingProblems = false;
		this.problemsProjectFilter = undefined;
		this.globalStore.setPreference("lastActiveFeatureId", featureId);
		const resolved = this.projectManager.resolveFeature(featureId);
		this.panel.title = resolved
			? `Agent Space: ${resolved.feature.branch}`
			: "Agent Space";
		this.panel.reveal(vscode.ViewColumn.One, true);
		this.sendRuntimeUpdateAsync().catch(() => {});
		this.panel.webview.html = this.getFeatureHtml(featureId);
		agentSpaceDiagnostic(
			`focus feature:${featureId} local-render ${Date.now() - startedAt}ms`,
		);
		this.maybeRefreshFocusedScope();
	}

	public showProject(projectId: string): void {
		this.showProjectPage(projectId, false);
	}

	public showProjectSettings(projectId: string): void {
		this.showProjectPage(projectId, true);
	}

	/**
	 * Portfolio-wide attention list: every problem currently attached to a
	 * cached snapshot (features and base), worst severity first. Purely built
	 * from cached state — never triggers a new Git/GitHub observation.
	 */
	public showProblems(projectId?: string): void {
		this.currentFeatureId = null;
		this.currentProjectId = null;
		this.showingProblems = true;
		this.problemsProjectFilter = projectId;
		this.panel.title = "Agent Space: Attention";
		this.panel.reveal(vscode.ViewColumn.One, true);
		this.panel.webview.html = this.getProblemsHtml(projectId);
	}

	private showProjectPage(projectId: string, settings: boolean): void {
		const startedAt = Date.now();
		const context = this.projectManager.getContext(projectId);
		if (!context) return;
		this.currentFeatureId = null;
		this.currentProjectId = projectId;
		this.currentProjectSettings = settings;
		this.showingProblems = false;
		this.problemsProjectFilter = undefined;
		this.panel.title = `Agent Space: ${context.project.name}`;
		this.panel.reveal(vscode.ViewColumn.One, true);
		this.panel.webview.html = this.getProjectHtml(projectId, settings);
		agentSpaceDiagnostic(
			`focus project:${projectId} local-render ${Date.now() - startedAt}ms`,
		);
		this.maybeRefreshFocusedScope();
	}

	public refresh(): void {
		try {
			recordFullRebuild("home");
			if (this.currentFeatureId) {
				this.panel.webview.html = this.getFeatureHtml(this.currentFeatureId);
			} else if (this.currentProjectId) {
				this.panel.webview.html = this.getProjectHtml(
					this.currentProjectId,
					this.currentProjectSettings,
				);
			} else if (this.showingProblems) {
				this.panel.webview.html = this.getProblemsHtml(
					this.problemsProjectFilter,
				);
			} else {
				this.panel.webview.html = this.getWelcomeHtml();
			}
			this.maybeRefreshFocusedScope();
		} catch {
			// Panel may have been disposed
		}
	}

	/**
	 * Patch live agent state (name/session title/attention/lifecycle) and
	 * every runtime-derived Feature projection (cockpit headline/primary
	 * action/runtime label/alerts, services, tmux diagnostics) for an
	 * already-open Feature panel without replacing the webview document.
	 * Only safe for state that never adds/removes a card — callers must know
	 * the affected agents/services already exist in this panel's DOM.
	 */
	public refreshLiveState(): void {
		if (!this.currentFeatureId) return;
		this.sendRuntimeUpdateAsync().catch(() => {});
	}

	/**
	 * Patch one already-open Feature panel incrementally. Returns `false`
	 * (no side effect at all) when that Feature has no open panel — callers
	 * decide separately whether anything else needs refreshing, so an
	 * unrelated Feature's runtime change never touches other open panels.
	 */
	public static patchLiveFeature(featureId: string): boolean {
		const panel = HomePanel.featurePanels.get(featureId);
		if (!panel) return false;
		panel.refreshLiveState();
		return true;
	}

	/**
	 * Full rebuild of only the singleton portfolio/project panel — never
	 * touches any open Feature panel. Portfolio/project rollups aren't
	 * incremental yet (issue #120 follow-up), so this is the bounded
	 * fallback for a runtime change on a Feature with no open panel.
	 */
	public static refreshInstance(): void {
		HomePanel.instance?.refresh();
	}

	/**
	 * Route a scoped, non-structural change to the exact open Feature panel
	 * via an incremental patch; anything else (unscoped, structural, or no
	 * matching open panel) falls back to rebuilding just the portfolio
	 * singleton, never unrelated Feature panels.
	 */
	public static refreshLive(scope?: {
		featureId?: string;
		structural?: boolean;
	}): void {
		if (scope?.structural === false && scope.featureId) {
			if (HomePanel.patchLiveFeature(scope.featureId)) return;
			HomePanel.refreshInstance();
			return;
		}
		HomePanel.refreshAll();
	}

	public getCurrentFeatureId(): string | null {
		return this.currentFeatureId;
	}

	private dispose(): void {
		this.onViewStateChangeCallback?.({ active: false, visible: false });
		if (this.featurePanelId) {
			HomePanel.featurePanels.delete(this.featurePanelId);
		} else {
			HomePanel.instance = undefined;
		}
		for (const d of this.disposables) {
			d.dispose();
		}
		this.coordinatorConsumer?.dispose();
		this.coordinatorConsumer = undefined;
		this.panel.dispose();
	}

	private setupMessageHandler(): void {
		this.panel.webview.onDidReceiveMessage(
			(message) => {
				this.handleMessage(message);
			},
			null,
			this.disposables,
		);
	}

	private handleMessage(
		message: { command: string } & Record<string, unknown>,
	): void {
		const run = (cmd: string, ...args: unknown[]) => {
			vscode.commands.executeCommand(cmd, ...args).then(undefined, () => {});
		};
		switch (message.command) {
			// Navigation
			case "showWelcome":
				run("agentSpace.openHome");
				break;
			case "showFeature":
				run("agentSpace.openWorkspace", message.featureId as string);
				break;
			case "showProject":
				run("agentSpace.openProject", message.projectId as string);
				break;
			case "showProblems":
				run("agentSpace.openProblems", message.projectId as string | undefined);
				break;
			case "showProjectSettings":
				run("agentSpace.openProjectSettings", message.projectId as string);
				break;
			case "saveProjectConfig":
				this.saveProjectConfig(
					message.projectId as string,
					message.content as string,
				);
				break;
			case "addProtectedBranch":
				this.addProtectedBranch(
					message.projectId as string,
					message.branchRef as string,
				);
				break;
			case "removeProject":
				this.removeProject(message.projectId as string);
				break;
			// Agent actions
			case "addAgent":
				run("agentSpace.addAgent", message.featureId);
				break;
			case "closeAgent":
				run("agentSpace.closeAgent", message.featureId, message.agentId);
				break;
			case "reopenAgent":
				run("agentSpace.reopenAgent", message.featureId, message.agentId);
				break;
			case "attachProviderSession":
				run(
					"agentSpace.attachProviderSession",
					message.featureId,
					message.agentId,
				);
				break;
			case "focusAgent":
				this.focusAgentTerminal(
					(message.featureId as string | undefined) ??
						this.currentFeatureId ??
						undefined,
					message.agentId as string,
				);
				break;
			case "focusService":
				this.focusServiceTerminal(
					message.featureId as string,
					message.serviceId as string,
				);
				break;
			case "killAgentSession":
				this.handleKillAgentSession(
					message.featureId as string,
					message.agentId as string,
				);
				break;
			case "killServiceSession":
				this.handleKillServiceSession(
					message.featureId as string,
					message.serviceId as string,
				);
				break;
			case "killFeatureSessions":
				this.handleKillFeatureSessions(message.featureId as string);
				break;
			case "killProjectSessions":
				this.handleKillProjectSessions(message.projectId as string);
				break;
			// Service actions
			case "addService":
				run("agentSpace.addService", message.featureId);
				break;
			case "bootstrapFeature":
				run("agentSpace.bootstrapFeature", message.featureId);
				break;
			case "stopService":
				this.handleStopService(
					message.featureId as string,
					message.serviceId as string,
				);
				break;
			case "restartService":
				this.handleRestartService(
					message.featureId as string,
					message.serviceId as string,
				);
				break;
			// Feature actions
			case "createPR":
				run("agentSpace.createPR", message.featureId);
				break;
			case "openGitView":
				run("agentSpace.openFeatureGitView", message.featureId);
				break;
			case "openPullRequest":
				this.openSelectedPullRequest(message.featureId as string);
				break;
			case "deleteFeature":
				run("agentSpace.deleteFeature", message.featureId);
				break;
			case "toggleIsolation":
				run("agentSpace.toggleIsolation", message.featureId);
				break;
			// Project actions
			case "newFeature":
				run("agentSpace.newFeature", message.projectId);
				break;
			case "addProject":
				run("agentSpace.addProject");
				break;
			case "editProjectBaseBranch":
				run("agentSpace.editProjectBaseBranch", message.projectId);
				break;
			case "updateBaseBranch":
				run("agentSpace.updateBaseBranch", message.projectId);
				break;
			case "deleteWorktreeBranch":
				run("agentSpace.deleteWorktreeBranch", {
					projectId: message.projectId,
					branchRef: message.branchRef,
					worktreePath: message.worktreePath,
				});
				break;
			// Activity
			case "requestActivity":
				this.sendActivityForAgent(message.agentId as string);
				break;
			case "refreshActivity":
				this.sendActivityForAgents((message.agentIds as string[]) ?? []);
				break;
			case "requestServiceActivity":
				this.sendActivityForService(message.serviceId as string);
				break;
			case "refreshServiceActivity":
				this.sendActivityForServices((message.serviceIds as string[]) ?? []);
				break;
			case "refresh": {
				// Scoped to whichever Feature/Project is actually open; never a
				// global re-observation of unrelated projects.
				const featureId =
					typeof message.featureId === "string" && message.featureId
						? message.featureId
						: this.currentFeatureId;
				if (featureId) {
					this.featureStateCoordinator.invalidateFeature(featureId);
					void this.featureStateCoordinator
						.reconcileFeature(featureId)
						.then(() => this.refresh());
				} else if (this.currentProjectId) {
					const projectId = this.currentProjectId;
					this.featureStateCoordinator.invalidateProject(projectId);
					this.featureStateCoordinator.refreshProjectReferenceHealth(projectId);
					void this.featureStateCoordinator
						.reconcileProject(projectId)
						.then(() => this.refresh());
				} else {
					this.featureStateCoordinator.invalidateAll();
					this.featureStateCoordinator.refreshProjectReferenceHealth();
					void this.featureStateCoordinator
						.reconcile()
						.then(() => this.refresh());
				}
				break;
			}
		}
	}

	private openSelectedPullRequest(featureId: string): void {
		const github = this.featureStateCoordinator.getSnapshot(featureId)?.github;
		if (github?.status !== "known") return;
		if (github.resolution.outcome !== "selected") return;
		const url = github.resolution.pull.url;
		try {
			const uri = vscode.Uri.parse(url);
			if (uri.scheme !== "https" || uri.authority !== "github.com") return;
			void vscode.env.openExternal(uri);
		} catch {
			// The observed PR URL is invalid. Keep the action fail-closed.
		}
	}

	// -- Service actions ------------------------------------------
	private handleStopService(featureId: string, serviceId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;
		const service = ctx.serviceManager
			.getServices(featureId)
			.find((candidate) => candidate.id === serviceId);
		if (service && this.terminalController) {
			this.terminalController.killServiceTerminal(
				service.id,
				service.tmuxSession,
			);
		}
		ctx.serviceManager.stopService(serviceId, featureId);
		this.projectManager.notifyChange();
	}

	private handleRestartService(featureId: string, serviceId: string): void {
		const resolved = this.projectManager.resolveFeature(featureId);
		if (!resolved) return;
		const { ctx, feature } = resolved;
		ctx.serviceManager.restartService(
			serviceId,
			featureId,
			feature.worktreePath,
		);
		this.projectManager.notifyChange();
	}

	// -- Terminal focus -------------------------------------------
	/**
	 * Same hardened path as the sidebar (see
	 * `FeatureSidebarProvider.handleFocusAgent`): an already-tracked terminal
	 * is revealed with zero exec, and a cold reattachment runs async tmux
	 * reconciliation off the click's call stack. The guarantee scope is
	 * identical — warm focus and cold reattachment; a fresh-spawn branch
	 * still contains a few synchronous calls.
	 */
	/**
	 * Thin delegation to the shared AgentFocusService — the behavioral source
	 * of truth for agent terminal focusing (see its contract). This panel adds
	 * no behavior of its own.
	 */
	public focusAgentTerminal(
		featureId: string | undefined,
		agentId: string,
	): void {
		this.agentFocus?.requestFocus(featureId ?? "", agentId);
	}

	public setAgentFocusService(service: AgentFocusService): void {
		this.agentFocus = service;
	}

	private focusServiceTerminal(featureId: string, serviceId: string): void {
		if (!this.terminalController) return;
		const resolved = this.projectManager.resolveFeature(featureId);
		if (!resolved) return;
		const { ctx, feature } = resolved;
		const services = ctx.serviceManager.getServices(featureId);
		const service = services.find((s) => s.id === serviceId);
		if (!service) return;
		this.terminalController.focusOrCreateServiceTerminal(
			feature,
			service,
			feature.worktreePath,
		);
	}

	private handleKillAgentSession(featureId: string, agentId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;
		this.terminalController?.killAgentTerminal(agentId, featureId);
		ctx.agentManager.closeAgent(agentId, featureId);
		this.projectManager.notifyChange();
	}

	private handleKillServiceSession(featureId: string, serviceId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;
		const service = ctx.serviceManager
			.getServices(featureId)
			.find((candidate) => candidate.id === serviceId);
		if (!service) return;
		this.terminalController?.killServiceTerminal(
			service.id,
			service.tmuxSession,
		);
		ctx.serviceManager.stopService(serviceId, featureId);
		this.projectManager.notifyChange();
	}

	private handleKillFeatureSessions(featureId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;

		this.terminalController?.killFeatureTerminals(featureId);
		for (const agent of ctx.agentManager.getAgentsReadModel(featureId)) {
			ctx.agentManager.closeAgent(agent.id, featureId);
		}
		for (const service of ctx.serviceManager.getServices(featureId)) {
			ctx.serviceManager.stopService(service.id, featureId);
		}
		this.projectManager.notifyChange();
	}

	private handleKillProjectSessions(projectId: string): void {
		const ctx = this.projectManager.getContext(projectId);
		if (!ctx) return;

		this.projectManager.killProjectSessions(projectId, this.terminalController);
		for (const feature of ctx.featureManager.getFeatures()) {
			for (const agent of ctx.agentManager.getAgentsReadModel(feature.id)) {
				ctx.agentManager.closeAgent(agent.id, feature.id);
			}
			for (const service of ctx.serviceManager.getServices(feature.id)) {
				ctx.serviceManager.stopService(service.id, feature.id);
			}
		}
		this.projectManager.notifyChange();
	}

	// -- Activity polling -----------------------------------------
	private sendActivityForAgent(agentId: string): void {
		if (!this.currentFeatureId) return;
		const ctx = this.projectManager.findContextByFeatureId(
			this.currentFeatureId,
		);
		if (!ctx) return;
		const agents = ctx.agentManager.getAgentsReadModel(this.currentFeatureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;

		const sessionName =
			agent.tmuxSession ??
			this.tmux.sessionName(this.currentFeatureId, agentId);
		const content = this.tmux.capturePane(sessionName, 80);
		this.panel.webview.postMessage({
			type: "activityUpdate",
			agentId,
			content: content ?? "",
		});
	}

	private sendActivityForAgents(agentIds: string[]): void {
		if (!this.currentFeatureId || agentIds.length === 0) return;
		const ctx = this.projectManager.findContextByFeatureId(
			this.currentFeatureId,
		);
		if (!ctx) return;
		const agents = ctx.agentManager.getAgentsReadModel(this.currentFeatureId);
		for (const agentId of agentIds) {
			const agent = agents.find((a) => a.id === agentId);
			if (!agent) continue;
			const sessionName =
				agent.tmuxSession ??
				this.tmux.sessionName(this.currentFeatureId, agentId);
			const content = this.tmux.capturePane(sessionName, 80);
			this.panel.webview.postMessage({
				type: "activityUpdate",
				agentId,
				content: content ?? "",
			});
		}
	}

	private sendActivityForService(serviceId: string): void {
		if (!this.currentFeatureId) return;
		const ctx = this.projectManager.findContextByFeatureId(
			this.currentFeatureId,
		);
		if (!ctx) return;
		const services = ctx.serviceManager.getServices(this.currentFeatureId);
		const service = services.find((s) => s.id === serviceId);
		if (!service) return;

		const content = this.tmux.capturePane(service.tmuxSession, 80);
		this.panel.webview.postMessage({
			type: "serviceActivityUpdate",
			serviceId,
			content: content ?? "",
		});
	}

	private sendActivityForServices(serviceIds: string[]): void {
		if (!this.currentFeatureId || serviceIds.length === 0) return;
		const ctx = this.projectManager.findContextByFeatureId(
			this.currentFeatureId,
		);
		if (!ctx) return;
		const services = ctx.serviceManager.getServices(this.currentFeatureId);
		for (const serviceId of serviceIds) {
			const service = services.find((s) => s.id === serviceId);
			if (!service) continue;
			const content = this.tmux.capturePane(service.tmuxSession, 80);
			this.panel.webview.postMessage({
				type: "serviceActivityUpdate",
				serviceId,
				content: content ?? "",
			});
		}
	}

	// -- Runtime-derived Feature projections -----------------------
	/**
	 * Re-render and patch every Feature-page projection that depends only on
	 * runtime evidence (agent/service liveness) and the `attention` it
	 * drives — cockpit headline/primary action/runtime label/alerts and tmux
	 * diagnostics — plus the agent cards and Git stats block. Every patch
	 * targets a specific leaf element by id, never a parent container's
	 * `innerHTML`, so `<details>` open/closed state and focus elsewhere on
	 * the page survive. Never assigns `webview.html`: issue #120 review
	 * flagged that a `"runtime"`-kind change previously only patched the
	 * agent card and Git stats, leaving the cockpit headline/primary action
	 * stale (e.g. an agent going `waiting_for_user` updated the sidebar/
	 * agent card but not the Feature page's "Needs you" banner) until the
	 * next full rebuild — a cross-surface semantic divergence #120 requires
	 * eliminated.
	 */
	private async sendRuntimeUpdateAsync(): Promise<void> {
		if (!this.currentFeatureId) return;
		const resolved = this.projectManager.resolveFeature(this.currentFeatureId);
		const snapshot = this.featureStateCoordinator.getSnapshot(
			this.currentFeatureId,
		);
		if (!resolved || !snapshot) return;

		const agents = this.snapshotAgents(snapshot);
		this.panel.webview.postMessage({
			type: "agentAttentionUpdate",
			agents: agents.map((agent) => ({
				cardPresentation: presentAgentCard(
					resolved.ctx.agentManager.observe(agent),
				),
				id: agent.id,
			})),
		});

		const stats = this.snapshotGitStats(snapshot);
		if (stats) {
			this.panel.webview.postMessage({
				type: "gitStatsUpdate",
				html: this.renderGitStatsContent(stats),
			});
		}

		// Patches only the specific runtime-derived fields via stable ids —
		// never a parent container's `innerHTML` — so any `<details>` the
		// user has expanded elsewhere on the page (work/committed files,
		// diagnostics, service activity panels) and any focus/scroll
		// position survive the patch (issue #120 review: a full-subtree
		// replace recreates child `<details>` and silently resets `open`).
		// The Services section is intentionally not touched here: it never
		// changes from a runtime-only attention tick — stop/restart/add/
		// remove already go through the structural (full-rebuild) path.
		const cockpit = presentFeatureCockpit(
			snapshot,
			this.featureStateCoordinator.getProjectReferenceHealth(
				snapshot.projectId,
			),
		);
		this.panel.webview.postMessage({
			type: "featureRuntimeUpdate",
			headline: cockpit.summary.label,
			detail: cockpit.summary.detail ?? "",
			runtimeLabel: cockpit.runtime.label,
			primaryActionHtml: this.renderCockpitPrimaryAction(
				cockpit.primaryAction,
				snapshot.feature.id,
			),
			alertsHtml: this.renderCockpitAlerts(cockpit),
			diagnosticsSummary: this.diagnosticsSessionSummary(snapshot),
			diagnosticsContentHtml: this.renderFeatureTmuxSection(snapshot),
		});
	}

	private snapshotGitStats(snapshot: FeatureSnapshot): GitStats | null {
		if (snapshot.git.featureDiff.status === "unknown") return null;
		const diff = snapshot.git.featureDiff.value;
		return {
			filesChanged: diff.filesChanged,
			insertions: diff.insertions,
			deletions: diff.deletions,
			raw: diff.raw,
		};
	}

	private snapshotAgents(snapshot: FeatureSnapshot): Agent[] {
		return snapshot.runtime.agents.status === "known"
			? snapshot.runtime.agents.value.map(({ agent }) => agent as Agent)
			: [];
	}

	private snapshotServices(snapshot: FeatureSnapshot): Service[] {
		return snapshot.runtime.services.status === "known"
			? snapshot.runtime.services.value.map(({ service }) => service as Service)
			: [];
	}

	private snapshotCollectionCount(
		snapshots: readonly FeatureSnapshot[],
		collection: "agents" | "services",
	): number | null {
		let total = 0;
		for (const snapshot of snapshots) {
			const observation = snapshot.runtime[collection];
			if (observation.status === "unknown") return null;
			total += observation.value.length;
		}
		return total;
	}

	private renderBaseStateChips(snapshot: FeatureSnapshot | undefined): string {
		if (!snapshot) {
			return '<span class="project-base-chip">unknown</span>';
		}
		const workingTree = snapshot.git.workingTree;
		const worktreeChip =
			workingTree.status === "unknown"
				? '<span class="project-base-chip">unknown</span>'
				: workingTree.value.staged.length > 0 ||
						workingTree.value.unstaged.length > 0 ||
						workingTree.value.untracked.length > 0 ||
						workingTree.value.conflicted.length > 0
					? '<span class="project-base-chip project-base-chip--dirty" title="Uncommitted changes">dirty</span>'
					: '<span class="project-base-chip" title="No uncommitted changes">clean</span>';
		const upstream = snapshot.git.upstream;
		const divergence = snapshot.git.upstreamDivergence;
		const upstreamChip =
			upstream.status === "unknown" || divergence.status === "unknown"
				? '<span class="project-base-chip">upstream unknown</span>'
				: upstream.value.upstream === null || divergence.value === null
					? '<span class="project-base-chip" title="No remote tracking branch">no remote</span>'
					: `<span class="project-base-chip" title="Commits vs ${this.escapeHtml(upstream.value.upstream.ref)}">${divergence.value.rightOnly} ahead &middot; ${divergence.value.leftOnly} behind</span>`;
		return `${worktreeChip}${upstreamChip}`;
	}

	private renderReferenceHealthChip(projectId: string): string {
		const health =
			this.featureStateCoordinator.getProjectReferenceHealth(projectId);
		if (!health) {
			return '<span class="project-base-chip project-base-chip--warning" title="The reference branch has not been observed">origin state unknown</span>';
		}
		const relation = health.verifiedRemoteRelation;
		let label: string;
		let tone = "";
		switch (relation.state) {
			case "current":
				label = `${health.remoteName}/${health.branch} verified current`;
				break;
			case "behind":
				label = `${relation.comparedOnly} behind ${health.remoteName}/${health.branch}`;
				tone = " project-base-chip--warning";
				break;
			case "ahead":
				label = `${relation.localOnly} ahead of ${health.remoteName}/${health.branch}`;
				tone = " project-base-chip--warning";
				break;
			case "diverged":
				label = `${relation.localOnly} ahead · ${relation.comparedOnly} behind ${health.remoteName}/${health.branch}`;
				tone = " project-base-chip--error";
				break;
			case "different_unknown":
				label = `${health.remoteName}/${health.branch} differs · relation unknown`;
				tone = " project-base-chip--warning";
				break;
			case "missing":
				label = `reference branch missing`;
				tone = " project-base-chip--error";
				break;
			case "unknown":
				label = `${health.remoteName}/${health.branch} state unknown`;
				tone = " project-base-chip--warning";
				break;
		}
		if (health.remoteFreshness.status === "stale") {
			label += " · stale";
			tone ||= " project-base-chip--warning";
		}
		const detail =
			relation.state === "unknown" ||
			relation.state === "different_unknown" ||
			relation.state === "missing"
				? (relation.detail ?? relation.reason)
				: `Remote head observed via ${health.verifiedRemote.provenance.backend}`;
		const title = `${detail} · ${health.verifiedRemote.observedAt}`;
		return `<span class="project-base-chip${tone}" title="${this.escapeHtml(title)}">${this.escapeHtml(label)}</span>`;
	}

	private renderWorktreeBranches(projectId: string): string {
		const inventory =
			this.featureStateCoordinator.getProjectWorktreeBranches(projectId);
		const repoPath =
			this.projectManager.getContext(projectId)?.project.repoPath;
		const context = this.projectManager.getContext(projectId);
		if (!inventory || inventory.status !== "known") {
			return `
				<div class="worktree-branches-card">
					<div class="section-label">Worktree branches</div>
					<div class="project-setting-source">Branch inventory not observed yet.</div>
				</div>`;
		}
		const protectedBranches = new Set([
			...PROTECTED_BRANCH_NAMES,
			...(context?.config?.protectedBranches ?? []),
			...(inventory.baseRef ? [inventory.baseRef] : []),
		]);
		const visibleBranches = inventory.branches;
		if (visibleBranches.length === 0) {
			return `
				<div class="worktree-branches-card">
					<div class="section-label">Worktree branches</div>
					<div class="project-setting-source">No branch worktrees detected.</div>
				</div>`;
		}
		const rows = visibleBranches
			.map((branch) => {
				const relation = this.renderBranchRelation(branch.baseRelation);
				const worktreeTone =
					branch.workingTree.status === "dirty"
						? " project-base-chip--warning"
						: branch.workingTree.status === "unknown"
							? " project-base-chip--warning"
							: "";
				const worktreeChip = `<span class="project-base-chip${worktreeTone}" title="Working tree in ${this.escapeHtml(branch.worktreePath)}">${branch.workingTree.status}</span>`;
				const link = branch.linkedFeatureId
					? `<span class="worktree-branch-linked">feature</span>`
					: "";
				const externalChip =
					branch.outsideBase === true
						? `<span class="worktree-branch-external" title="Outside Agent Space's managed base — created by another tool (e.g. Claude Code). Deleting asks an extra confirmation with last-activity evidence.">&#9888; external</span>`
						: "";
				const deletable =
					!branch.linkedFeatureId &&
					inventory.baseRef !== undefined &&
					!protectedBranches.has(branch.ref) &&
					repoPath !== undefined &&
					branch.worktreePath !== repoPath;
				const protectedAction = protectedBranches.has(branch.ref)
					? '<span class="worktree-branch-protected">protected</span>'
					: `<button class="worktree-branch-protect" data-project-id="${this.escapeHtml(projectId)}" data-branch-ref="${this.escapeHtml(branch.ref)}" title="Protect this branch from deletion">protect</button>`;
				const deleteTitle =
					branch.outsideBase === true
						? "Delete this external branch and its worktree (an extra confirmation will be asked)"
						: "Delete this branch and its worktree";
				const deleteAction = deletable
					? `<button class="worktree-branch-delete" data-project-id="${this.escapeHtml(projectId)}" data-branch-ref="${this.escapeHtml(branch.ref)}" data-worktree-path="${this.escapeHtml(branch.worktreePath)}" title="${deleteTitle}">&times;</button>`
					: "";
				return `
				<div class="worktree-branch-row">
					<span class="worktree-branch-ref" title="${this.escapeHtml(branch.worktreePath)}">${this.escapeHtml(branch.ref)}</span>
					<span class="worktree-branch-meta">
						<span title="${this.escapeHtml(branch.headSha)}">@${this.escapeHtml(branch.headSha.slice(0, 8))}</span>
						${branch.prunable ? '<span class="worktree-branch-prunable">prunable</span>' : ""}
					</span>
				<span class="worktree-branch-chips">${relation}${worktreeChip}${link}${externalChip}${protectedAction}${deleteAction}</span>
				</div>`;
			})
			.join("");
		return `
			<div class="worktree-branches-card">
			<div class="section-label">Worktree branches <span class="project-setting-source">· ${visibleBranches.length} branch${visibleBranches.length === 1 ? "" : "es"}</span></div>
				<div class="worktree-branch-list">${rows}</div>
			</div>`;
	}

	private renderBranchRelation(
		relation: import("../git/worktreeBranchObserver").WorktreeBranchBaseRelation,
	): string {
		switch (relation.status) {
			case "current":
				return '<span class="project-base-chip" title="Equal to base">current</span>';
			case "merged":
				return '<span class="project-base-chip" title="Ancestor of the base branch">merged</span>';
			case "ahead":
				return `<span class="project-base-chip project-base-chip--warning" title="Contains commits not present in base">${relation.commits} ahead</span>`;
			case "diverged":
				return `<span class="project-base-chip project-base-chip--error" title="Both refs contain commits absent from the other">${relation.ahead} ahead &middot; ${relation.behind} behind</span>`;
			case "unknown":
				return '<span class="project-base-chip project-base-chip--warning" title="Relation could not be observed">unknown</span>';
		}
	}

	private renderReusedBranchChip(feature: Feature): string {
		const reused = feature.reusedExistingBranch;
		if (!reused) return "";
		const relation = reused.relation;
		if (relation.status === "unknown") {
			return `<span class="project-base-chip project-base-chip--warning" title="Branch ${this.escapeHtml(feature.branch)} already existed; its relation to the base branch could not be observed">reused &middot; relation unknown</span>`;
		}
		if (relation.status === "current") {
			return `<span class="project-base-chip" title="Branch ${this.escapeHtml(feature.branch)} already existed and matches the base branch">reused branch</span>`;
		}
		const detail =
			relation.status === "diverged"
				? `${relation.ahead} ahead &middot; ${relation.behind} behind`
				: relation.status === "ahead"
					? `${relation.ahead} ahead`
					: `${relation.behind} behind`;
		const tone =
			relation.status === "diverged" || relation.status === "ahead"
				? "error"
				: "warning";
		return `<span class="project-base-chip project-base-chip--${tone}" title="Branch ${this.escapeHtml(feature.branch)} already existed when this feature was created; the existing branch was reused and its relation to base is ${detail}">reused &middot; ${detail}</span>`;
	}

	private renderGitStatsContent(stats: GitStats): string {
		if (stats.filesChanged === 0) {
			return '<div class="activity-empty">No changes yet</div>';
		}
		return `
			<div class="git-stat-row">
				<span class="git-stat-label">Files changed</span>
				<span class="git-stat-value">${stats.filesChanged}</span>
			</div>
			<div class="git-stat-row">
				<span class="git-stat-label">Insertions</span>
				<span class="git-stat-value git-additions">+${stats.insertions}</span>
			</div>
			<div class="git-stat-row">
				<span class="git-stat-label">Deletions</span>
				<span class="git-stat-value git-deletions">-${stats.deletions}</span>
			</div>
			${stats.raw ? `<div class="git-files-list">${this.escapeHtml(stats.raw)}</div>` : ""}`;
	}

	private getWelcomeHtml(): string {
		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);

		const contexts = this.projectManager.getAllContexts();
		const projects = this.projectManager.getProjects();

		let body: string;
		if (projects.length === 0) {
			body = `
			<div class="welcome-container">
				<div class="welcome-header">
					<div class="welcome-title">${ICON_BRAND} Agent Space</div>
					<div class="welcome-subtitle">Your features at a glance</div>
				</div>
				<div class="empty-welcome">
					<div class="empty-welcome-title">No projects yet</div>
					<div class="empty-welcome-text">Add a Git project to get started with Agent Space.</div>
					<button class="quick-action-btn primary" onclick="addProject()">
						${ICON_FOLDER} Add Project
					</button>
				</div>
			</div>`;
		} else {
			const portfolioCards = contexts
				.map((ctx) => this.renderProjectPortfolioCard(ctx))
				.join("");
			const totals = contexts.reduce(
				(acc, ctx) => {
					const summary = this.featureStateCoordinator.getProjectSummary(ctx);
					acc.activeFeatures += summary.activeFeatureCount;
					acc.agents += summary.agentsActive;
					acc.scripts += summary.servicesActive;
					acc.attention += summary.attentionCount;
					return acc;
				},
				{ activeFeatures: 0, agents: 0, scripts: 0, attention: 0 },
			);
			const totalsChips = [
				`<span class="portfolio-total-chip"><strong>${contexts.length}</strong> project${contexts.length === 1 ? "" : "s"}</span>`,
				`<span class="portfolio-total-chip"><strong>${totals.activeFeatures}</strong> active feature${totals.activeFeatures === 1 ? "" : "s"}</span>`,
				`<span class="portfolio-total-chip"><strong>${totals.agents}</strong> agent${totals.agents === 1 ? "" : "s"}</span>`,
				`<span class="portfolio-total-chip"><strong>${totals.scripts}</strong> script${totals.scripts === 1 ? "" : "s"}</span>`,
				totals.attention > 0
					? `<span class="portfolio-total-chip attention clickable" role="button" title="List every attention item" onclick="showProblems()"><strong>${totals.attention}</strong> need${totals.attention === 1 ? "s" : ""} attention</span>`
					: "",
			].join("");

			// For "New Feature" button, use first project if only one
			const newFeatureProjectId = projects.length === 1 ? projects[0].id : "";

			body = `
			<div class="welcome-container">
				<div class="welcome-header">
					<div class="welcome-title">${ICON_BRAND} Agent Space</div>
					<div class="welcome-subtitle">Portfolio at a glance</div>
				</div>
				<div class="portfolio-totals">${totalsChips}</div>
				<div class="quick-actions-row">
					<button class="action-btn" onclick="newFeature('${newFeatureProjectId}')">
						${ICON_PLUS} New Feature
					</button>
					<button class="action-btn secondary" onclick="addProject()">
						${ICON_FOLDER} Add Project
					</button>
				</div>
				<div class="section-label">Projects</div>
				<div class="portfolio-grid">${portfolioCards}</div>
			</div>`;
		}

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
	${body}
	<script src="${jsUri}"></script>
</body>
</html>`;
	}

	private getProblemsHtml(projectId?: string): string {
		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);

		const contexts = this.projectManager.getAllContexts();
		const scopedContexts = projectId
			? contexts.filter((ctx) => ctx.project.id === projectId)
			: contexts;

		const severityRank = { info: 1, warning: 2, error: 3 } as const;
		const rows: {
			severity: keyof typeof severityRank;
			summary: string;
			detail: string;
			projectName: string;
			featureLabel: string;
			openTarget: string;
		}[] = [];
		const counts = { error: 0, warning: 0, info: 0 };
		for (const ctx of scopedContexts) {
			for (const snapshot of this.featureStateCoordinator.getProjectSnapshots(
				ctx.project.id,
			)) {
				const isBase = snapshot.feature.id.startsWith("base:");
				const featureLabel = isBase
					? `${ctx.project.name} · base`
					: snapshot.feature.name || snapshot.feature.branch;
				const openTarget = isBase
					? `showProject('${ctx.project.id}')`
					: `openFeature('${snapshot.feature.id}')`;
				for (const problem of snapshot.attention) {
					if (problem.severity === "error") counts.error += 1;
					else if (problem.severity === "warning") counts.warning += 1;
					else counts.info += 1;
					rows.push({
						severity: problem.severity,
						summary: problem.summary,
						detail: problem.detail,
						projectName: ctx.project.name,
						featureLabel,
						openTarget,
					});
				}
			}
		}
		rows.sort((a, b) => {
			if (severityRank[a.severity] !== severityRank[b.severity]) {
				return severityRank[b.severity] - severityRank[a.severity];
			}
			return a.featureLabel.localeCompare(b.featureLabel);
		});

		const total = rows.length;
		const filterChips = [
			`<button class="problems-filter active" data-severity="all" onclick="filterProblems('all')">All ${total}</button>`,
			`<button class="problems-filter problems-filter--error" data-severity="error" onclick="filterProblems('error')">Errors ${counts.error}</button>`,
			`<button class="problems-filter problems-filter--warning" data-severity="warning" onclick="filterProblems('warning')">Warnings ${counts.warning}</button>`,
			`<button class="problems-filter problems-filter--info" data-severity="info" onclick="filterProblems('info')">Info ${counts.info}</button>`,
		].join("");

		const listHtml =
			total === 0
				? '<div class="activity-empty">No attention items. Everything looks calm.</div>'
				: `<div class="problems-list">${rows
						.map(
							(row) => `
				<div class="problem-row problem-row--${row.severity}" data-severity="${row.severity}" onclick="${row.openTarget}">
					<span class="problem-severity-dot"></span>
					<div class="problem-copy">
						<strong title="${this.escapeHtml(row.detail)}">${this.escapeHtml(row.summary)}</strong>
						<span>${this.escapeHtml(row.detail)}</span>
					</div>
					<div class="problem-location">
						<span class="problem-feature" title="${this.escapeHtml(row.featureLabel)}">${this.escapeHtml(row.featureLabel)}</span>
						<span class="problem-project">${this.escapeHtml(row.projectName)}</span>
					</div>
				</div>`,
						)
						.join("")}</div>`;

		const scopeChip =
			projectId && contexts.some((ctx) => ctx.project.id === projectId)
				? `<span class="portfolio-total-chip">Project: ${this.escapeHtml(contexts.find((ctx) => ctx.project.id === projectId)?.project.name ?? projectId)}
					<button class="problems-scope-clear" title="Show all projects" onclick="showProblems()">&#215;</button>
				</span>`
				: "";

		const body = `
		<div class="welcome-container">
			<div class="welcome-header">
				<div class="welcome-title">${ICON_BRAND} Attention items</div>
				<div class="welcome-subtitle">Every problem Agent Space observed across the portfolio</div>
			</div>
			<div class="portfolio-totals">
				<button class="action-btn secondary" onclick="goHome()">&#8592; Portfolio</button>
				${scopeChip}
			</div>
			<div class="problems-toolbar">${filterChips}</div>
			${listHtml}
		</div>`;

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
	${body}
	<script src="${jsUri}"></script>
</body>
</html>`;
	}

	private getFeatureHtml(featureId: string): string {
		const resolved = this.projectManager.resolveFeature(featureId);
		if (!resolved) return this.emptyHtml("Feature not found");

		const snapshot = this.featureStateCoordinator.getSnapshot(featureId);
		if (!snapshot) {
			return this.renderFeatureLocalHtml(resolved.ctx, resolved.feature);
		}
		const { ctx } = resolved;
		const feature = snapshot.feature as Feature;
		const agents = this.snapshotAgents(snapshot);
		const services = this.snapshotServices(snapshot);
		const agentsKnown = snapshot.runtime.agents.status === "known";
		const servicesKnown = snapshot.runtime.services.status === "known";
		const runtimeNotice =
			!agentsKnown || !servicesKnown
				? '<div class="activity-empty">Runtime state unavailable</div>'
				: "";
		const dotColor = TERMINAL_COLOR_MAP[feature.color] || "#569cd6";
		const cockpit = presentFeatureCockpit(
			snapshot,
			this.featureStateCoordinator.getProjectReferenceHealth(
				snapshot.projectId,
			),
		);

		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);

		const activeAgents = agents.filter(
			(a) =>
				a.status === "running" ||
				a.status === "idle" ||
				(a.startup && a.startup.state !== "ready"),
		);
		const erroredAgents = agents.filter((a) => a.status === "errored");
		const doneAgents = agents.filter((a) => a.status === "done");
		const stoppedAgents = agents.filter((a) => a.status === "stopped");
		const body = `
		<button class="home-nav-bar" onclick="showProject('${snapshot.projectId}')" title="Back to Project">&#8592; ${this.escapeHtml(ctx.project.name)}</button>
		<div class="workspace-header">
			<div class="header-color-dot" style="background: ${dotColor}"></div>
			<div class="header-info">
				<div class="header-title">${this.escapeHtml(feature.name)}</div>
				<div class="header-branch">Checkout · ${this.escapeHtml(feature.branch)}</div>
				${feature.primaryBranchRef && feature.primaryBranchRef !== feature.branch ? `<div class="header-branch">Delivery · ${this.escapeHtml(feature.primaryBranchRef)}</div>` : ""}
			</div>
			<div class="header-actions">
				${
					cockpit.primaryAction.kind === "refresh_evidence"
						? ""
						: `<button class="header-action-btn" onclick="quickAction('refresh', '${feature.id}')" title="Refresh evidence">
					${ICON_REFRESH}
				</button>`
				}
			</div>
		</div>
			<div class="workspace-content">
					${this.renderFeatureProvisioning(
						feature,
						ctx.featureManager?.isProvisioningActive?.(feature.id) ?? false,
					)}
				${this.renderFeatureCockpit(cockpit, snapshot)}
				${runtimeNotice}
			${
				agentsKnown
					? this.renderAgentsSection(
							activeAgents,
							erroredAgents,
							doneAgents,
							stoppedAgents,
							agents,
							feature,
						)
					: ""
			}
			${servicesKnown ? this.renderServicesSection(services, feature) : ""}
			${this.renderFeatureDiagnostics(snapshot)}
			${this.renderQuickActions(
				feature,
				ctx.featureManager.getBootstrapCommands().length > 0,
			)}
			${cockpit.primaryAction.kind === "review_finish" ? "" : this.renderFeatureActions(feature)}
		</div>`;

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<style>
.agent-attention-badge { white-space: nowrap; }
.agent-attention-badge.attention-working { color: var(--vscode-testing-iconPassed); }
.agent-attention-badge.attention-waiting_for_user { color: var(--vscode-notificationsWarningIcon-foreground); background: color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 14%, transparent); }
.agent-attention-badge.attention-failed { color: var(--vscode-errorForeground); }
.agent-attention-badge.attention-idle, .agent-attention-badge.attention-unknown { color: var(--vscode-descriptionForeground); }
.lifecycle-card { margin: 0 0 18px; padding: 14px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editorInfo-background) 35%, transparent); }
.lifecycle-card.failed { border-color: var(--vscode-errorForeground); }
.lifecycle-steps { display: grid; gap: 6px; margin-top: 10px; }
.lifecycle-step { display: grid; grid-template-columns: 18px 1fr; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.lifecycle-step.completed { color: var(--vscode-testing-iconPassed); }
.lifecycle-step.running { color: var(--vscode-foreground); }
.lifecycle-step.failed, .lifecycle-card p { color: var(--vscode-errorForeground); overflow-wrap: anywhere; }
.lifecycle-step small { grid-column: 2; }
.lifecycle-spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; border-radius: 50%; animation: lifecycle-spin .8s linear infinite; }
@keyframes lifecycle-spin { to { transform: rotate(360deg); } }
.agent-starting, .agent-starting-inline { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.agent-starting-inline { white-space: nowrap; }
.agent-status-dot.attention-working { background: var(--vscode-testing-iconPassed); animation: pulse-green 2s ease-in-out infinite; }
.agent-status-dot.attention-waiting_for_user { background: var(--vscode-notificationsWarningIcon-foreground); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 18%, transparent); }
.agent-status-dot.attention-failed { background: var(--vscode-errorForeground); }
.agent-status-dot.attention-idle, .agent-status-dot.attention-unknown, .agent-status-dot.attention-done { background: var(--vscode-disabledForeground); }
.agent-status-dot.primary-state-working { background: var(--vscode-testing-iconPassed); animation: pulse-green 2s ease-in-out infinite; }
.agent-status-dot.primary-state-warning { background: var(--vscode-notificationsWarningIcon-foreground); }
.agent-status-dot.primary-state-error { background: var(--vscode-errorForeground); }
.agent-status-dot.primary-state-normal { background: var(--vscode-charts-blue, var(--vscode-focusBorder)); }
.agent-status-dot.primary-state-muted { background: var(--vscode-disabledForeground); }
</style>
</head>
<body>
	${body}
	<script src="${jsUri}"></script>
</body>
</html>`;
	}

	/**
	 * Render a Feature page from the local lifecycle record only, before any
	 * observation snapshot exists. The local lifecycle (creating, provisioning,
	 * failed, ready) is rendered immediately; observation sections that need a
	 * `FeatureSnapshot` (Git, GitHub/PR, runtime) are announced as pending and
	 * enriched progressively when the coordinator publishes them.
	 */
	private renderFeatureLocalHtml(
		ctx: ProjectContext,
		feature: Feature,
	): string {
		const dotColor = TERMINAL_COLOR_MAP[feature.color] || "#569cd6";
		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);
		const provisioning = this.renderFeatureProvisioning(
			feature,
			ctx.featureManager?.isProvisioningActive?.(feature.id) ?? false,
		);
		const body = `
		<button class="home-nav-bar" onclick="showProject('${ctx.project.id}')" title="Back to Project">&#8592; ${this.escapeHtml(ctx.project.name)}</button>
		<div class="workspace-header">
			<div class="header-color-dot" style="background: ${dotColor}"></div>
			<div class="header-info">
				<div class="header-title">${this.escapeHtml(feature.name)}</div>
				<div class="header-branch">Checkout · ${this.escapeHtml(feature.branch)}</div>
				${feature.primaryBranchRef && feature.primaryBranchRef !== feature.branch ? `<div class="header-branch">Delivery · ${this.escapeHtml(feature.primaryBranchRef)}</div>` : ""}
			</div>
		</div>
		<div class="workspace-content">
			${provisioning}
			<div class="activity-empty">Observing Git state…</div>
			${feature.provisioning?.state === "failed" ? "" : this.renderFeatureActions(feature)}
		</div>`;

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<style>
.lifecycle-card { margin: 0 0 18px; padding: 14px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editorInfo-background) 35%, transparent); }
.lifecycle-card.failed { border-color: var(--vscode-errorForeground); }
.lifecycle-steps { display: grid; gap: 6px; margin-top: 10px; }
.lifecycle-step { display: grid; grid-template-columns: 18px 1fr; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.lifecycle-step.completed { color: var(--vscode-testing-iconPassed); }
.lifecycle-step.running { color: var(--vscode-foreground); }
.lifecycle-step.failed, .lifecycle-card p { color: var(--vscode-errorForeground); overflow-wrap: anywhere; }
.lifecycle-step small { grid-column: 2; }
.lifecycle-spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; border-radius: 50%; animation: lifecycle-spin .8s linear infinite; }
@keyframes lifecycle-spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
	${body}
	<script src="${jsUri}"></script>
</body>
</html>`;
	}

	/**
	 * The `<details class="feature-attention-card">` "more alerts" widget.
	 * Extracted so the runtime patch path (`sendRuntimeUpdateAsync`) can
	 * regenerate just this fragment — its own `<details>` open/closed state
	 * is expected to reset when alerts genuinely change (that's the update
	 * being reported), unlike the unrelated work/committed/diagnostics
	 * `<details>` elsewhere on the page, which a runtime tick must not touch.
	 */
	private renderCockpitAlerts(cockpit: FeatureCockpitPresentation): string {
		const remainingAlerts = cockpit.alerts.slice(1);
		const remainingAlertCount =
			remainingAlerts.length + cockpit.hiddenAlertCount;
		if (remainingAlertCount === 0) return "";
		return `<details class="feature-attention-card">
					<summary>${remainingAlertCount} more item${remainingAlertCount === 1 ? "" : "s"} need attention</summary>
					${remainingAlerts
						.map(
							(
								problem,
							) => `<div class="feature-attention-row feature-attention-row--${problem.severity}">
								<strong>${this.escapeHtml(problem.summary)}</strong>
								<span>${this.escapeHtml(problem.detail)}</span>
							</div>`,
						)
						.join("")}
					${cockpit.hiddenAlertCount > 0 ? `<div class="feature-cockpit-observed">${cockpit.hiddenAlertCount} additional item${cockpit.hiddenAlertCount === 1 ? "" : "s"} available after refresh</div>` : ""}
				</details>`;
	}

	private renderFeatureCockpit(
		cockpit: FeatureCockpitPresentation,
		snapshot: FeatureSnapshot,
	): string {
		const primary = this.renderCockpitPrimaryAction(
			cockpit.primaryAction,
			snapshot.feature.id,
		);
		const headline = cockpit.summary.label;
		const summaryDetail = cockpit.summary.detail;
		const alerts = this.renderCockpitAlerts(cockpit);
		const working = cockpit.work.workingTree;
		const workingBreakdown =
			working.status === "known"
				? `<div class="feature-cockpit-breakdown">
					<span>${working.staged.length} staged</span>
					<span>${working.unstaged.length} unstaged</span>
					<span>${working.untracked.length} untracked</span>
					<span>${working.conflicted.length} conflicts</span>
				</div>${this.renderWorkingTreeFiles(working)}`
				: "";
		const committed = cockpit.work.committed;
		const committedBreakdown =
			committed.status === "known"
				? `<div class="feature-cockpit-breakdown">
					${committed.baseCommits > 0 ? `<span>${committed.baseCommits} base-only commit${committed.baseCommits === 1 ? "" : "s"}</span>` : ""}
					${committed.filesChanged === undefined ? "<span>File diff Unknown</span>" : `<span>${committed.filesChanged} files</span><span class="git-additions">+${committed.insertions ?? 0}</span><span class="git-deletions">-${committed.deletions ?? 0}</span>`}
				</div>${this.renderCommittedFiles(committed)}`
				: "";
		const pull = cockpit.delivery.pullRequest;
		const pullAction =
			pull.number && cockpit.primaryAction.kind !== "open_pull_request"
				? `<button class="quick-action-btn subtle" onclick="openPullRequest('${snapshot.feature.id}')">Open</button>`
				: "";

		return `<section class="feature-cockpit">
			<div class="feature-cockpit-summary">
				<div class="feature-cockpit-summary-copy">
					<strong id="feature-cockpit-headline">${this.escapeHtml(headline)}</strong>
					<span id="feature-cockpit-detail" class="feature-cockpit-summary-detail" style="${summaryDetail ? "" : "display:none"}">${summaryDetail ? this.escapeHtml(summaryDetail) : ""}</span>
					<span id="feature-cockpit-runtime-label" class="feature-cockpit-summary-meta">${this.escapeHtml(cockpit.runtime.label)}</span>
				</div>
				<div id="feature-cockpit-primary-action">${primary}</div>
			</div>
			<div id="feature-cockpit-alerts">${alerts}</div>
			<div class="feature-cockpit-grid">
				<div class="feature-cockpit-card">
					<h3>Work</h3>
					<div class="feature-cockpit-row">
						<span>Working tree</span>
						<div class="feature-cockpit-value feature-cockpit-value--${working.status === "known" ? working.tone : "warning"}">
							<strong>${this.escapeHtml(working.label)}</strong>${workingBreakdown}
						</div>
					</div>
					<div class="feature-cockpit-row">
						<span>Committed</span>
						<div class="feature-cockpit-value"><strong>${this.escapeHtml(committed.label)}</strong>${committedBreakdown}</div>
					</div>
				</div>
				<div class="feature-cockpit-card">
					<h3>Delivery</h3>
					<div class="feature-cockpit-row"><span>Delivery branch</span><div class="feature-cockpit-value feature-cockpit-value--${cockpit.delivery.source.tone}"><strong>${this.escapeHtml(cockpit.delivery.source.label)}</strong>${cockpit.delivery.source.detail ? `<div class="feature-cockpit-breakdown">${this.escapeHtml(cockpit.delivery.source.detail)}</div>` : ""}</div></div>
					<div class="feature-cockpit-row"><span>Target</span><div class="feature-cockpit-value"><strong>${this.escapeHtml(cockpit.delivery.target.label)}</strong> ${this.escapeHtml(cockpit.delivery.target.detail ?? "")}${this.renderReferenceHealthChip(snapshot.projectId)}</div></div>
					<div class="feature-cockpit-row"><span>Tracking</span><div class="feature-cockpit-value feature-cockpit-value--${cockpit.delivery.tracking.tone}">${this.escapeHtml(cockpit.delivery.tracking.label)}</div></div>
					<div class="feature-cockpit-row"><span>Pull request</span><div class="feature-cockpit-value feature-cockpit-value--${pull.tone}">${this.escapeHtml(pull.label)} ${pullAction}</div></div>
					<div class="feature-cockpit-row"><span>Integration</span><div class="feature-cockpit-value feature-cockpit-value--${cockpit.delivery.integration.tone}"><strong>${this.escapeHtml(cockpit.delivery.integration.label)}</strong>${cockpit.delivery.integration.detail ? `<div class="feature-cockpit-breakdown">${this.escapeHtml(cockpit.delivery.integration.detail)}</div>` : ""}</div></div>
				</div>
			</div>
			<div class="feature-cockpit-evidence">Evidence : ${this.escapeHtml(cockpit.observedAt)} · ${this.escapeHtml(snapshot.github.observedAt)}</div>
		</section>`;
	}

	private renderWorkingTreeFiles(
		working: Extract<
			FeatureCockpitPresentation["work"]["workingTree"],
			{ status: "known" }
		>,
	): string {
		if (working.pending === 0) return "";
		const files = [
			...working.conflicted.map((file) => `conflict  ${file}`),
			...working.staged.map((file) => `staged    ${file}`),
			...working.unstaged.map((file) => `unstaged  ${file}`),
			...working.untracked.map((file) => `untracked ${file}`),
		];
		return `<details class="feature-cockpit-files"><summary>Show files</summary><pre class="feature-cockpit-files-list">${this.escapeHtml(files.join("\n"))}</pre></details>`;
	}

	private renderCommittedFiles(
		committed: Extract<
			FeatureCockpitPresentation["work"]["committed"],
			{ status: "known" }
		>,
	): string {
		if (!committed.files || committed.files.length === 0) return "";
		const files = committed.files.map((file) => {
			const pathLabel =
				file.oldPath && file.newPath && file.oldPath !== file.newPath
					? `${file.oldPath} -> ${file.newPath}`
					: file.path;
			const insertions =
				file.insertions === null ? "+?" : `+${file.insertions}`;
			const deletions = file.deletions === null ? "-?" : `-${file.deletions}`;
			return `${insertions.padStart(5)} ${deletions.padStart(5)}  ${pathLabel}`;
		});
		return `<details class="feature-cockpit-files"><summary>Show committed files</summary><pre class="feature-cockpit-files-list">${this.escapeHtml(files.join("\n"))}</pre></details>`;
	}

	private renderCockpitPrimaryAction(
		action: FeatureCockpitPrimaryAction,
		featureId: string,
	): string {
		let onclick: string;
		switch (action.kind) {
			case "refresh_evidence":
				onclick = `quickAction('refresh', '${featureId}')`;
				break;
			case "open_agent":
				onclick = `focusAgent('${featureId}', '${action.agentId}')`;
				break;
			case "open_workspace":
				onclick = `quickAction('openGitView', '${featureId}')`;
				break;
			case "open_pull_request":
				onclick = `openPullRequest('${featureId}')`;
				break;
			case "create_pull_request":
				onclick = `quickAction('createPR', '${featureId}')`;
				break;
			case "review_finish":
				onclick = `deleteFeature('${featureId}')`;
				break;
		}
		return `<button class="quick-action-btn primary feature-cockpit-primary" onclick="${onclick}">${this.escapeHtml(action.label)}</button>`;
	}

	private getProjectHtml(projectId: string, settings = false): string {
		const context = this.projectManager.getContext(projectId);
		if (!context) return this.emptyHtml("Project not found");

		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);
		const explicitBaseBranch = context.config.baseBranch?.trim();
		const snapshots =
			this.featureStateCoordinator.getProjectSnapshots(projectId);
		const baseSnapshot = snapshots.find((snapshot) =>
			snapshot.feature.id.startsWith("base:"),
		);
		const effectiveBaseBranch = baseSnapshot?.feature.branch ?? "Unknown";
		const baseSource = explicitBaseBranch
			? "Configured"
			: baseSnapshot
				? "Observed current checkout"
				: "Unavailable";
		const baseCommitLabel =
			baseSnapshot?.git.base.status === "known"
				? baseSnapshot.git.base.value.sha.slice(0, 12)
				: "";
		const branchKinds = context.featureManager.getBranchKinds();
		const defaultBranchKind = context.featureManager.getDefaultBranchKind();
		const featureSnapshots = snapshots.filter(
			(snapshot) => !snapshot.feature.id.startsWith("base:"),
		);
		const projectSnapshots = [
			...(baseSnapshot &&
			(this.snapshotAgents(baseSnapshot).length > 0 ||
				this.snapshotServices(baseSnapshot).length > 0 ||
				baseSnapshot.runtime.agents.status === "unknown" ||
				baseSnapshot.runtime.services.status === "unknown")
				? [baseSnapshot]
				: []),
			...featureSnapshots,
		];
		const projectAgentCount = this.snapshotCollectionCount(
			projectSnapshots,
			"agents",
		);
		const projectServiceCount = this.snapshotCollectionCount(
			projectSnapshots,
			"services",
		);

		// ── Base branch git state (the comparison branch) ──────────────
		const baseStateChips = this.renderBaseStateChips(baseSnapshot);
		const referenceHealthChip = this.renderReferenceHealthChip(projectId);
		const worktreeBranches = this.renderWorktreeBranches(projectId);
		const hasManagedSessions = snapshots.some((snapshot) => {
			const rows = this.getTmuxSessionRows(snapshot);
			return (
				rows.liveRows.length > 0 ||
				rows.inactiveRows.length > 0 ||
				rows.unknownRows.length > 0
			);
		});
		const referenceHealth =
			this.featureStateCoordinator.getProjectReferenceHealth(projectId);
		const baseUpdateAction =
			referenceHealth &&
			referenceHealth.verifiedRemote.status === "known" &&
			(referenceHealth.verifiedRemoteRelation.state === "behind" ||
				referenceHealth.verifiedRemoteRelation.state === "diverged")
				? `<button class="quick-action-btn project-base-update-btn" data-project-id="${this.escapeHtml(projectId)}" title="Fetch ${this.escapeHtml(referenceHealth.remoteName)}/${this.escapeHtml(referenceHealth.branch)} and fast-forward the local branch">${ICON_REFRESH} Update ${this.escapeHtml(referenceHealth.branch)}</button>`
				: "";

		// ── Rich feature cards (sidebar-equivalent density) ────────────
		const featureRows = projectSnapshots.length
			? projectSnapshots
					.map((snapshot) => {
						const feature = snapshot.feature as Feature;
						const agents = this.snapshotAgents(snapshot);
						const services = this.snapshotServices(snapshot);
						const dotColor = TERMINAL_COLOR_MAP[feature.color] || "#569cd6";
						const summary = feature.id.startsWith("base:")
							? null
							: presentFeatureCockpit(
									snapshot,
									this.featureStateCoordinator.getProjectReferenceHealth(
										projectId,
									),
								).summary;
						const statusBadge = summary
							? `<span class="project-status-badge status-${summary.tone}" title="${this.escapeHtml(summary.detail ?? summary.label)}">${this.escapeHtml(summary.label)}</span>`
							: '<span class="project-base-label">base</span>';
						const agentCount = agents.filter((a) => a.status !== "done").length;
						const serviceCount = services.filter(
							(s) => s.status === "running",
						).length;
						const counts =
							snapshot.runtime.agents.status === "unknown" ||
							snapshot.runtime.services.status === "unknown"
								? "runtime unknown"
								: [
										agentCount > 0
											? `${agentCount} agent${agentCount > 1 ? "s" : ""}`
											: "",
										serviceCount > 0
											? `${serviceCount} script${serviceCount > 1 ? "s" : ""}`
											: "",
									]
										.filter(Boolean)
										.join(" &middot; ");
						return `
						<div class="project-feature-card" data-feature-id="${feature.id}">
							<div class="project-feature-card-header" onclick="toggleCardCollapse(this)">
								<span class="project-feature-chevron" id="pf-chevron-${feature.id}">&rsaquo;</span>
								<div class="project-feature-color" style="background: ${dotColor}"></div>
								<span class="project-feature-branch">${this.escapeHtml(feature.branch)}</span>
								${statusBadge}
								${this.renderReusedBranchChip(feature)}
								<span class="project-feature-counts">${counts}</span>
								<button class="project-feature-delete" onclick="event.stopPropagation(); deleteFeature('${feature.id}')" title="Finish Feature">&times;</button>
							</div>
							<div class="project-feature-card-body" id="pf-body-${feature.id}">
								${this.renderProjectFeatureBody(snapshot, feature, agents, services)}
								<div class="project-feature-actions">
									<button class="quick-action-btn primary" onclick="openFeature('${feature.id}')">Open</button>
									<button class="quick-action-btn" onclick="quickAction('openGitView', '${feature.id}')">Open Workspace</button>
									<button class="quick-action-btn" onclick="quickAction('addAgent', '${feature.id}')">Add Agent</button>
									<button class="quick-action-btn" onclick="quickAction('addService', '${feature.id}')">Add Service</button>
								</div>
							</div>
						</div>`;
					})
					.join("")
			: '<div class="empty-welcome"><div class="empty-welcome-text">No features yet. Create one to get started.</div></div>';

		const projectSettingsCard = `
			<div class="project-settings-card">
				<div class="section-label">Project Settings</div>
				<div class="project-settings-grid">
					<div><span class="project-setting-label">Base branch</span><strong>${this.escapeHtml(effectiveBaseBranch)}</strong><span class="project-setting-source">${baseSource}</span></div>
					<div><span class="project-setting-label">Protected branches</span><span>${this.escapeHtml([...new Set([...PROTECTED_BRANCH_NAMES, ...(context.config.protectedBranches ?? [])])].join(", "))}</span></div>
					<div><span class="project-setting-label">Branch kinds</span><span>${this.escapeHtml(branchKinds.join(", ") || "Default")}</span>${defaultBranchKind ? `<span class="project-setting-source">Default: ${this.escapeHtml(defaultBranchKind)}</span>` : ""}</div>
					<div><span class="project-setting-label">Worktrees</span><span class="project-worktree-cell">${this.escapeHtml(context.featureManager.getWorktreeBase())}</span></div>
				</div>
				<button class="quick-action-btn" onclick="editProjectBaseBranch('${projectId}')">Edit base branch</button>
				<div class="section-label project-config-label">.agentspace/config.json</div>
				<textarea class="project-config-editor" id="project-config-${projectId}">${this.escapeHtml(this.projectConfigEditorContent(context.project.repoPath))}</textarea>
				<div class="project-config-actions">
					<button class="quick-action-btn primary" onclick="saveProjectConfig('${projectId}')">Save configuration</button>
					<span class="project-config-help">Shared project settings only; machine-local overlays stay separate.</span>
				</div>
				<details class="project-config-reference">
					<summary>Available settings</summary>
					<pre>{
  "baseBranch": "main",              // shared base branch for worktrees
  "protectedBranches": ["trunk"],    // additional branches never offered for deletion
  "branchKinds": ["feature", "fix"], // kinds offered at feature creation
  "defaultBranchKind": "feature",
  "worktreesDir": "~/.worktrees",    // default: &lt;repo&gt;/.worktrees
  "bootstrapCommands": ["npm install"],
  "agents": { "enabled": ["claude"], "default": "claude" },
  "knowledge": { "instructions": ["AGENTS.md"], "runbooks": ["docs/runbooks.md"] }
}</pre>
					<p class="project-config-help">Reference only &mdash; examples above are never saved. Fill the editor with the values you want.</p>
				</details>
			</div>`;
		const projectPageContent = settings
			? `<div class="project-page-nav">
				<button class="quick-action-btn" onclick="showProject('${projectId}')">Overview</button>
				<button class="quick-action-btn primary">Settings</button>
			</div>${projectSettingsCard}`
			: `<div class="project-page-nav">
				<button class="quick-action-btn primary">Overview</button>
				<button class="quick-action-btn" onclick="showProjectSettings('${projectId}')">Settings</button>
			</div>
			<div class="project-health-card">
				<div class="section-label">Project overview</div>
				<div class="project-overview-grid">
					<div><strong>${featureSnapshots.length}</strong><span>Features</span></div>
					<div><strong>${featureSnapshots.filter((snapshot) => snapshot.feature.status === "active").length}</strong><span>Active</span></div>
					<div><strong>${projectAgentCount ?? "?"}</strong><span>Agents</span></div>
					<div><strong>${projectServiceCount ?? "?"}</strong><span>Scripts</span></div>
				</div>
				<p class="project-setting-source">${this.escapeHtml(context.project.repoPath)} · base branch <strong>${this.escapeHtml(effectiveBaseBranch)}</strong> ${baseCommitLabel ? `&middot; <span title="Observed base SHA">${this.escapeHtml(baseCommitLabel)}</span>` : ""}</p>
				<div class="project-base-chips">${referenceHealthChip}${baseStateChips}${baseUpdateAction}</div>
			</div>
			${worktreeBranches}
			<div>
				<div class="section-label">Active / recent features</div>
				<div class="project-feature-list">${featureRows}</div>
				<button class="quick-action-btn primary project-new-feature" onclick="newFeature('${projectId}')">New Feature</button>
			</div>`;

		const body = `
		<button class="home-nav-bar" onclick="goHome()" title="Back to Agent Space">&#8592; Agent Space</button>
		<div class="workspace-header">
			<div class="header-info">
				<div class="header-title">${this.escapeHtml(context.project.name)}</div>
				<div class="header-branch">${this.escapeHtml(context.project.repoPath)}</div>
			</div>
			<button class="header-action-btn" onclick="quickAction('refresh', '')" title="Refresh local and remote observations">${ICON_REFRESH}</button>
			${hasManagedSessions ? `<button class="project-delete-btn" onclick="killProjectSessions('${projectId}')" title="Kill every managed tmux session of this project">Kill sessions</button>` : ""}
			<button class="project-delete-btn" onclick="removeProject('${projectId}')" title="Remove project">Remove project</button>
		</div>
		<div class="workspace-content project-page">
			${projectPageContent}
		</div>`;

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<style>
.project-config-label { margin-top: 18px; }
.project-config-editor { box-sizing: border-box; width: 100%; min-height: 280px; margin-top: 8px; padding: 10px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.45; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
.project-config-editor:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.project-config-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.project-config-help { font-size: 11px; color: var(--vscode-descriptionForeground); }
.project-config-reference { margin-top: 12px; font-size: 12px; }
.project-config-reference summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
.project-config-reference pre { margin: 8px 0 4px; padding: 8px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; white-space: pre; }
.project-delete-btn { margin-left: auto; padding: 5px 9px; border: 1px solid var(--vscode-testing-iconFailed); border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-testing-iconFailed); cursor: pointer; }
.project-delete-btn:hover { background: var(--vscode-errorForeground); }
</style>
</head>
<body>
	${body}
	<script src="${jsUri}"></script>
</body>
</html>`;
	}

	/**
	 * Body of a rich feature card on the project page: agents + services
	 * sections (same helpers as the full feature page), then quick actions.
	 */
	private renderProjectFeatureBody(
		snapshot: FeatureSnapshot,
		feature: Feature,
		agents: Agent[],
		services: Service[],
	): string {
		const activeAgents = agents.filter(
			(a) =>
				a.status === "running" ||
				a.status === "idle" ||
				(a.startup && a.startup.state !== "ready"),
		);
		const erroredAgents = agents.filter((a) => a.status === "errored");
		const doneAgents = agents.filter((a) => a.status === "done");
		const stoppedAgents = agents.filter((a) => a.status === "stopped");

		return `
			${snapshot.runtime.agents.status === "known" ? this.renderAgentsSection(activeAgents, erroredAgents, doneAgents, stoppedAgents, agents, feature) : '<div class="activity-empty">Agent runtime unavailable</div>'}
			${snapshot.runtime.services.status === "known" ? this.renderServicesSection(services, feature) : '<div class="activity-empty">Service runtime unavailable</div>'}`;
	}

	/**
	 * Content of the settings JSON editor, always derived from the *shared*
	 * `.agentspace/config.json` — never the effective config that merges the
	 * machine-local overlay. A project with no shared file (even when a
	 * `config.local.json` exists) shows the discovery template, and editing it
	 * can never materialise machine-local values into the committed file.
	 */
	private projectConfigEditorContent(repoPath: string): string {
		const shared = loadSharedProjectConfig(repoPath);
		if (hasSharedProjectConfig(repoPath) && Object.keys(shared).length > 0) {
			return JSON.stringify(shared, null, 2);
		}
		return JSON.stringify(projectConfigTemplate(), null, 2);
	}

	private saveProjectConfig(projectId: string, content: string): void {
		try {
			const parsed: unknown = JSON.parse(content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Configuration must be a JSON object.");
			}
			const cleaned = pruneEmptyConfig(parsed as ProjectConfig);
			this.projectManager.replaceProjectConfig(projectId, cleaned);
			void vscode.window.showInformationMessage("Project configuration saved.");
		} catch (error) {
			void vscode.window.showErrorMessage(
				`Could not save project configuration: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private addProtectedBranch(projectId: string, branchRef: string): void {
		const context = this.projectManager.getContext(projectId);
		const branch = branchRef.trim();
		if (!context || !branch || PROTECTED_BRANCH_NAMES.has(branch)) return;
		const sharedConfig = loadSharedProjectConfig(context.project.repoPath);
		const protectedBranches = [
			...new Set([...(sharedConfig.protectedBranches ?? []), branch]),
		];
		this.projectManager.updateProjectConfig(projectId, { protectedBranches });
	}

	private removeProject(projectId: string): void {
		const project = this.projectManager
			.getProjects()
			.find((candidate) => candidate.id === projectId);
		if (!project) return;
		void vscode.window
			.showWarningMessage(
				`Remove project "${project.name}" from Agent Space?`,
				{ modal: true },
				"Remove project",
			)
			.then((choice) => {
				if (choice === "Remove project") {
					this.projectManager.removeProject(projectId);
					this.showWelcome();
				}
			});
	}

	// -- Feature Home render helpers ------------------------------
	private renderFeatureProvisioning(
		feature: Feature,
		locallyActive = false,
	): string {
		const progress = feature.provisioning;
		if (!progress || progress.state === "ready") return "";
		const activelyProvisioning =
			progress.state === "provisioning" && locallyActive;
		const stateUnknown = progress.state === "provisioning" && !locallyActive;
		const steps = progress.steps
			.map((step) => {
				const icon =
					step.status === "completed"
						? "✓"
						: step.status === "failed"
							? "!"
							: step.status === "running"
								? activelyProvisioning
									? "…"
									: "?"
								: "·";
				return `<div class="lifecycle-step ${step.status}"><span>${step.status === "running" && activelyProvisioning ? '<i class="lifecycle-spinner"></i>' : icon}</span><span>${this.escapeHtml(step.label)}</span>${step.error ? `<small>${this.escapeHtml(step.error)}</small>` : ""}</div>`;
			})
			.join("");
		const title =
			progress.state === "failed"
				? "Feature setup failed"
				: stateUnknown
					? "Feature setup state unknown"
					: "Setting up feature";
		const detail = stateUnknown
			? "<p>No setup operation is active in this window. Git state was left unchanged.</p>"
			: "";
		return `<section class="lifecycle-card ${progress.state === "failed" ? "failed" : ""}"><strong>${title}</strong><div class="lifecycle-steps">${steps}</div>${detail}${progress.error ? `<p>${this.escapeHtml(progress.error)}</p>` : ""}</section>`;
	}

	private renderAgentsSection(
		active: Agent[],
		errored: Agent[],
		done: Agent[],
		stopped: Agent[],
		all: Agent[],
		feature: Feature,
	): string {
		if (all.length === 0) {
			return `
			<div>
				<div class="section-label">Agents</div>
				<div class="agent-grid">
					<div class="ghost-card" onclick="quickAction('addAgent', '${feature.id}')">
						${ICON_PLUS} Add Agent
					</div>
				</div>
			</div>`;
		}

		const visibleCount = active.length + errored.length;

		const activePanels = active
			.map((a) => this.renderAgentPanel(a, all, feature))
			.join("");
		const erroredPanels = errored
			.map((a) => this.renderAgentPanel(a, all, feature))
			.join("");
		const donePanels = done
			.map((a) => this.renderAgentPanel(a, all, feature))
			.join("");
		const stoppedPanels = stopped
			.map((a) => this.renderAgentPanel(a, all, feature))
			.join("");

		let stoppedSection = "";
		if (stopped.length > 0) {
			stoppedSection = `
			<div class="stopped-services-header collapsed" onclick="toggleStoppedServicesHome(this)">
				<span class="stopped-services-chevron">&rsaquo;</span>
				<span>${stopped.length} stopped</span>
			</div>
			<div class="stopped-services-list collapsed">
				${stoppedPanels}
			</div>`;
		}

		return `
		<div>
			<div class="section-label">Agents${visibleCount > 0 ? ` &middot; ${visibleCount}` : ""}</div>
			<div class="agent-grid">
				${activePanels}
				${erroredPanels}
				${donePanels}
				<div class="ghost-card" onclick="quickAction('addAgent', '${feature.id}')">
					${ICON_PLUS} Add Agent
				</div>
			</div>
			${stoppedSection}
		</div>`;
	}

	private renderAgentPanel(
		agent: Agent,
		allAgents: Agent[],
		feature: Feature,
	): string {
		const idx = allAgents.indexOf(agent);
		const color = TERMINAL_COLOR_HEX[idx % TERMINAL_COLOR_HEX.length];
		const tool = this.toolRegistry.resolveAgentTool(agent.toolId);
		const observation = this.projectManager
			.resolveFeature(feature.id)
			?.ctx.agentManager.observe(agent);
		const card = presentAgentCard(
			observation ?? {
				identity: {
					agentName: agent.name,
					sessionTitle: agent.sessionTitle,
					providerId: agent.toolId,
				},
				lifecycle: { state: "unknown", source: "agentspace" },
				attention: { state: "unknown" },
				session: {
					state: agent.sessionBinding?.state ?? "pending",
					detail: agent.sessionBinding?.detail,
				},
			},
		);
		const presented = card.primaryState;
		const isDone = agent.status === "done";
		const isErrored = agent.status === "errored";
		const nameClass = isDone ? "agent-panel-name done" : "agent-panel-name";
		const emptyState = isDone
			? "Agent finished &mdash; no live activity"
			: isErrored
				? this.escapeHtml(
						agent.lastError ?? "Agent failed to start or exited unexpectedly.",
					)
				: "No live output captured yet";
		const startupStep = agent.startup?.steps.find(
			(step) => step.status === "running",
		);
		const startupBadge = startupStep
			? `<span class="agent-starting-inline"><i class="lifecycle-spinner"></i>${this.escapeHtml(startupStep.label)}</span>`
			: "";
		const startupProgress = startupStep
			? `<div class="agent-starting"><i class="lifecycle-spinner"></i><span>${this.escapeHtml(startupStep.label)}</span></div>`
			: "";

		let actionButtons: string;
		if (isDone) {
			actionButtons = `
				<button class="agent-action-btn agent-action-btn-secondary" onclick="reopenAgent('${feature.id}', '${agent.id}')">Reopen agent</button>`;
		} else {
			actionButtons = `
				<button class="agent-action-btn agent-terminal-action" onclick="focusAgent('${feature.id}', '${agent.id}')">Open terminal</button>
				<button class="agent-action-btn agent-action-btn-secondary" onclick="markAgentDone('${feature.id}', '${agent.id}')">Mark done</button>`;
		}

		return `
		<div class="agent-panel ${isErrored ? "errored" : ""}" style="border-left: 2px solid ${color}">
			<div class="agent-panel-header agent-card-header" id="agent-header-${agent.id}">
				<div class="agent-panel-summary">
					<div class="agent-identity">
						<div id="agent-attention-dot-${agent.id}" class="agent-status-dot primary-state-${presented.tone}"></div>
						<span id="agent-name-${agent.id}" class="${nameClass}" title="${this.escapeHtml(card.name)}">${this.escapeHtml(card.name)}</span>
					</div>
					<span id="agent-lifecycle-badge-${agent.id}" class="agent-primary-state primary-state-${presented.tone}" title="${this.escapeHtml(presented.detail ?? "")}">${this.escapeHtml(presented.label)}</span>
				</div>
				<div class="agent-metadata">
					<span class="agent-provider">Provider &middot; ${this.escapeHtml(tool.name)}</span>
					<span id="agent-session-title-${agent.id}" class="agent-session-title" ${card.secondaryTitle ? "" : 'style="display:none"'} title="${this.escapeHtml(card.secondaryTitle ?? "")}">Session &middot; ${this.escapeHtml(card.secondaryTitle ?? "")}</span>
					${startupBadge}
				</div>
				<div class="agent-panel-actions">
					${actionButtons}
					<button id="agent-toggle-${agent.id}" class="agent-activity-toggle" aria-expanded="false" aria-controls="agent-activity-${agent.id}" onclick="toggleAgent('${agent.id}')">Activity <span class="agent-panel-chevron" id="agent-chevron-${agent.id}">&rsaquo;</span></button>
				</div>
			</div>
			<div class="agent-activity" id="agent-activity-${agent.id}">
				<div class="activity-content">
					${startupProgress}
					<pre class="activity-pre" id="activity-pre-${agent.id}" style="display: none"></pre>
					<div class="activity-empty" id="activity-empty-${agent.id}">
						${emptyState}
					</div>
				</div>
			</div>
		</div>`;
	}

	private renderServicesSection(services: Service[], feature: Feature): string {
		const activeServices = services.filter((s) => s.status === "running");
		const stoppedServices = services.filter((s) => s.status !== "running");

		const activePanels = activeServices
			.map((s) => this.renderServicePanel(s, feature))
			.join("");
		const stoppedPanels = stoppedServices
			.map((s) => this.renderServicePanel(s, feature))
			.join("");

		const ghostCard = `
			<div class="ghost-card" onclick="quickAction('addService', '${feature.id}')">
				${ICON_PLUS} Add Service
			</div>`;

		let stoppedSection = "";
		if (stoppedServices.length > 0) {
			stoppedSection = `
			<div class="stopped-services-header collapsed" onclick="toggleStoppedServicesHome(this)">
				<span class="stopped-services-chevron">&rsaquo;</span>
				<span>${stoppedServices.length} stopped</span>
			</div>
			<div class="stopped-services-list collapsed">
				${stoppedPanels}
			</div>`;
		}

		return `
		<div>
			<div class="section-label">Services${activeServices.length > 0 ? ` &middot; ${activeServices.length}` : ""}</div>
			<div class="services-grid">
				${activePanels}
				${ghostCard}
			</div>
			${stoppedSection}
		</div>`;
	}

	private renderServicePanel(service: Service, feature: Feature): string {
		const stopBtn =
			service.status === "running"
				? `<button class="agent-action-btn" onclick="event.stopPropagation(); serviceAction('stop', '${feature.id}', '${service.id}')" title="Stop">&#9632;</button>`
				: "";
		const restartBtn = `<button class="agent-action-btn" onclick="event.stopPropagation(); serviceAction('restart', '${feature.id}', '${service.id}')" title="${service.status === "running" ? "Restart" : "Start"}">&#8635;</button>`;
		const focusBtn = `<button class="agent-action-btn" onclick="event.stopPropagation(); focusService('${feature.id}', '${service.id}')" title="Focus Terminal">&#9243;</button>`;

		return `
		<div class="agent-panel" style="border-left: 2px solid ${service.status === "running" ? "var(--vscode-testing-iconPassed)" : "var(--vscode-descriptionForeground)"}">
			<div class="agent-panel-header" id="service-header-${service.id}" onclick="toggleService('${service.id}')">
				<div class="service-status-dot ${service.status}"></div>
				<span class="agent-panel-name">${this.escapeHtml(service.name)}</span>
				<span class="agent-tool-badge service-command-badge">${this.escapeHtml(service.command)}</span>
				<div class="agent-panel-actions">
					${focusBtn}
					${stopBtn}
					${restartBtn}
				</div>
				<span class="agent-panel-chevron" id="service-chevron-${service.id}">&rsaquo;</span>
			</div>
			<div class="agent-activity" id="service-activity-${service.id}">
				<div class="activity-content">
					<pre class="activity-pre" id="service-activity-pre-${service.id}" style="display: none"></pre>
					<div class="activity-empty" id="service-activity-empty-${service.id}">
						Click to view live output
					</div>
				</div>
			</div>
		</div>`;
	}

	/**
	 * Portfolio card for the Home piloting view: a cheap per-project rollup
	 * plus a preview of the most recent active features. Built purely from
	 * cached state — never triggers a new Git/GitHub observation.
	 */
	private renderProjectPortfolioCard(ctx: ProjectContext): string {
		const projectId = ctx.project.id;
		const summary = this.featureStateCoordinator.getProjectSummary(ctx);
		const allSnapshots =
			this.featureStateCoordinator.getProjectSnapshots(projectId);

		// Severity spans every snapshot, including the synthetic base: one —
		// getProjectSummary() counts its attention too, so the badge color
		// must cover the same evidence set as the count.
		const severityRank = { info: 1, warning: 2, error: 3 } as const;
		let worstSeverity: keyof typeof severityRank | undefined;
		for (const snapshot of allSnapshots) {
			for (const problem of snapshot.attention) {
				if (
					!worstSeverity ||
					severityRank[problem.severity] > severityRank[worstSeverity]
				) {
					worstSeverity = problem.severity;
				}
			}
		}
		const attentionBadge =
			summary.attentionCount > 0
				? `<span class="portfolio-attention severity-${worstSeverity ?? "info"} clickable" role="button" title="List this project's ${summary.attentionCount} attention item${summary.attentionCount === 1 ? "" : "s"}" onclick="event.stopPropagation(); showProblems('${projectId}')">${summary.attentionCount} need${summary.attentionCount === 1 ? "s" : ""} attention</span>`
				: "";

		// base: is excluded only from the portfolio counters and preview.
		const snapshots = allSnapshots.filter(
			(snapshot) => !snapshot.feature.id.startsWith("base:"),
		);
		const previewCount = 3;
		const activeFeatures = snapshots
			.filter((snapshot) => snapshot.feature.status !== "done")
			.sort((a, b) => b.feature.createdAt.localeCompare(a.feature.createdAt));
		const previewRows = activeFeatures
			.slice(0, previewCount)
			.map((snapshot) => {
				const feature = snapshot.feature as Feature;
				const dotColor = TERMINAL_COLOR_MAP[feature.color] || "#569cd6";
				const cockpitSummary = presentFeatureCockpit(
					snapshot,
					this.featureStateCoordinator.getProjectReferenceHealth(projectId),
				).summary;
				return `
				<div class="portfolio-feature-row" onclick="event.stopPropagation(); openFeature('${feature.id}')">
					<span class="portfolio-feature-dot" style="background: ${dotColor}"></span>
					<span class="portfolio-feature-name" title="${this.escapeHtml(feature.branch)}">${this.escapeHtml(feature.name || feature.branch)}</span>
					<span class="portfolio-feature-status tone-${cockpitSummary.tone}" title="${this.escapeHtml(cockpitSummary.detail ?? cockpitSummary.label)}">${this.escapeHtml(cockpitSummary.label)}</span>
				</div>`;
			})
			.join("");
		const overflowCount =
			activeFeatures.length - Math.min(activeFeatures.length, previewCount);
		const preview =
			activeFeatures.length > 0
				? `${previewRows}${overflowCount > 0 ? `<div class="portfolio-feature-more" onclick="showProject('${projectId}')">+${overflowCount} more&hellip;</div>` : ""}`
				: '<div class="portfolio-features-empty">No active features</div>';

		return `
		<div class="portfolio-card" onclick="showProject('${projectId}')">
			<div class="portfolio-card-header">
				<div>
					<div class="portfolio-card-title">${this.escapeHtml(ctx.project.name)}</div>
					<div class="portfolio-card-path" title="${this.escapeHtml(ctx.project.repoPath)}">${this.escapeHtml(ctx.project.repoPath)}</div>
				</div>
				${attentionBadge}
			</div>
			<div class="portfolio-card-stats">
				<span class="portfolio-stat"><strong>${summary.activeFeatureCount}</strong>/${summary.featureCount} features</span>
				<span class="portfolio-stat"><strong>${summary.agentsActive}</strong> agent${summary.agentsActive === 1 ? "" : "s"}</span>
				<span class="portfolio-stat"><strong>${summary.servicesActive}</strong> script${summary.servicesActive === 1 ? "" : "s"}</span>
			</div>
			<div class="portfolio-features">${preview}</div>
			<div class="portfolio-card-footer">
				<button class="quick-action-btn primary" onclick="event.stopPropagation(); newFeature('${projectId}')">New Feature</button>
			</div>
		</div>`;
	}

	private renderFeatureTmuxSection(snapshot: FeatureSnapshot): string {
		const featureGroup = this.renderTmuxFeatureGroup(snapshot);
		return `
		<div>
			<div class="section-label">Tmux Sessions</div>
			${
				featureGroup ??
				'<div class="tmux-empty-state">No managed tmux sessions for this feature.</div>'
			}
		</div>`;
	}

	private diagnosticsSessionSummary(snapshot: FeatureSnapshot): string {
		const { liveRows, unknownRows } = this.getTmuxSessionRows(snapshot);
		return unknownRows.length > 0
			? "session state unknown"
			: `${liveRows.length} live session${liveRows.length === 1 ? "" : "s"}`;
	}

	/**
	 * The `<details>` element itself is only ever produced here, at initial
	 * render — the runtime patch path (`sendRuntimeUpdateAsync`) only ever
	 * replaces the inner `#feature-diagnostics-content`/`#feature-diagnostics-summary`
	 * text, so a user-expanded `<details open>` survives a tmux-liveness tick
	 * (issue #120 review: a parent `innerHTML` reassignment would recreate
	 * the `<details>` and silently discard its `open` state).
	 */
	private renderFeatureDiagnostics(snapshot: FeatureSnapshot): string {
		return `<details class="feature-diagnostics">
			<summary id="feature-diagnostics-summary">Diagnostics · ${this.diagnosticsSessionSummary(snapshot)}</summary>
			<div id="feature-diagnostics-content" class="feature-diagnostics-content">${this.renderFeatureTmuxSection(snapshot)}</div>
		</details>`;
	}

	private renderTmuxFeatureGroup(
		snapshot: FeatureSnapshot,
		projectId?: string,
	): string | null {
		const feature = snapshot.feature;
		const { liveRows, inactiveRows, unknownRows } =
			this.getTmuxSessionRows(snapshot);
		if (
			liveRows.length === 0 &&
			inactiveRows.length === 0 &&
			unknownRows.length === 0
		) {
			return null;
		}

		let inactiveSection = "";
		if (inactiveRows.length > 0) {
			inactiveSection = `
			<div class="stopped-services-header collapsed tmux-inactive-header" onclick="toggleStoppedServicesHome(this)">
				<span class="stopped-services-chevron">&rsaquo;</span>
				<span>${inactiveRows.length} stopped</span>
			</div>
			<div class="stopped-services-list collapsed tmux-inactive-list">
				${inactiveRows.join("")}
			</div>`;
		}

		return `
		<div class="tmux-feature-card">
			<div class="tmux-feature-header">
				<div>
					<div class="tmux-feature-name">${this.escapeHtml(feature.name)}</div>
					<div class="tmux-feature-branch">${this.escapeHtml(feature.branch)}</div>
				</div>
				<div class="tmux-feature-actions">
					<span class="tmux-count-badge">${unknownRows.length > 0 ? "unknown" : `${liveRows.length} session${liveRows.length === 1 ? "" : "s"}`}</span>
					<button class="quick-action-btn danger subtle" onclick="killFeatureSessions('${feature.id}')">Kill Feature Sessions</button>
					${
						projectId
							? `<button class="quick-action-btn subtle" onclick="openFeature('${feature.id}')">Open</button>`
							: ""
					}
				</div>
			</div>
			<div class="tmux-session-list">
				${liveRows.length > 0 ? liveRows.join("") : unknownRows.length === 0 ? '<div class="tmux-empty-state">No live tmux sessions for this feature.</div>' : ""}
				${unknownRows.join("")}
			</div>
			${inactiveSection}
		</div>`;
	}

	private getTmuxSessionRows(snapshot: FeatureSnapshot): {
		liveRows: string[];
		inactiveRows: string[];
		unknownRows: string[];
	} {
		const liveRows: string[] = [];
		const inactiveRows: string[] = [];
		const unknownRows: string[] = [];
		const featureId = snapshot.feature.id;

		if (snapshot.runtime.agents.status === "unknown") {
			unknownRows.push(
				'<div class="tmux-empty-state">Agent runtime unavailable.</div>',
			);
		} else
			for (const { agent, tmuxAlive } of snapshot.runtime.agents.value) {
				const sessionName =
					agent.tmuxSession ?? this.tmux.sessionName(featureId, agent.id);
				if (tmuxAlive.status === "unknown") {
					unknownRows.push(
						this.renderTmuxAgentSessionRow(
							featureId,
							agent as Agent,
							sessionName,
							null,
						),
					);
				} else if (tmuxAlive.value) {
					liveRows.push(
						this.renderTmuxAgentSessionRow(
							featureId,
							agent as Agent,
							sessionName,
							true,
						),
					);
				} else {
					inactiveRows.push(
						this.renderTmuxAgentSessionRow(
							featureId,
							agent as Agent,
							sessionName,
							false,
						),
					);
				}
			}

		if (snapshot.runtime.services.status === "unknown") {
			unknownRows.push(
				'<div class="tmux-empty-state">Service runtime unavailable.</div>',
			);
		} else
			for (const { service, tmuxAlive } of snapshot.runtime.services.value) {
				if (tmuxAlive.status === "unknown") {
					unknownRows.push(
						this.renderTmuxServiceSessionRow(
							featureId,
							service as Service,
							null,
						),
					);
				} else if (tmuxAlive.value) {
					liveRows.push(
						this.renderTmuxServiceSessionRow(
							featureId,
							service as Service,
							true,
						),
					);
				} else {
					inactiveRows.push(
						this.renderTmuxServiceSessionRow(
							featureId,
							service as Service,
							false,
						),
					);
				}
			}

		return { liveRows, inactiveRows, unknownRows };
	}

	private renderTmuxAgentSessionRow(
		featureId: string,
		agent: Agent,
		sessionName?: string,
		alive: boolean | null = true,
	): string {
		const resolvedSessionName =
			sessionName ?? this.tmux.sessionName(featureId, agent.id);
		const actionButton =
			alive === true
				? `<button class="quick-action-btn danger subtle" onclick="killAgentSession('${featureId}', '${agent.id}')">Kill</button>`
				: "";
		return `
		<div class="tmux-session-row">
			<div class="tmux-session-main">
				<div class="tmux-session-title">
					<span class="tmux-session-type">Agent</span>
					<span>${this.escapeHtml(agent.name)}</span>
					<span class="tmux-live-pill ${alive === null ? "" : alive ? "live" : "dead"}">${alive === null ? "Unknown" : alive ? "Live" : "Stopped"}</span>
				</div>
				<div class="tmux-session-meta">
					<span>${this.escapeHtml(resolvedSessionName)}</span>
					<span>${this.escapeHtml(agent.status)}</span>
				</div>
			</div>
			${actionButton}
		</div>`;
	}

	private renderTmuxServiceSessionRow(
		featureId: string,
		service: Service,
		alive: boolean | null = true,
	): string {
		const actionButton =
			alive === true
				? `<button class="quick-action-btn danger subtle" onclick="killServiceSession('${featureId}', '${service.id}')">Kill</button>`
				: "";
		return `
		<div class="tmux-session-row">
			<div class="tmux-session-main">
				<div class="tmux-session-title">
					<span class="tmux-session-type">Script</span>
					<span>${this.escapeHtml(service.name)}</span>
					<span class="tmux-live-pill ${alive === null ? "" : alive ? "live" : "dead"}">${alive === null ? "Unknown" : alive ? "Live" : "Stopped"}</span>
				</div>
				<div class="tmux-session-meta">
					<span>${this.escapeHtml(service.tmuxSession)}</span>
					<span>${this.escapeHtml(service.status)}</span>
				</div>
			</div>
			${actionButton}
		</div>`;
	}

	private renderQuickActions(feature: Feature, hasBootstrap = false): string {
		if (!hasBootstrap) return "";
		return `
		<div class="feature-setup-actions">
			<button class="quick-action-btn" onclick="quickAction('bootstrapFeature', '${feature.id}')">Bootstrap Worktree</button>
		</div>`;
	}

	private renderFeatureActions(feature: Feature): string {
		return `
			<div class="feature-actions-section">
				<button class="quick-action-btn danger" onclick="deleteFeature('${feature.id}')">
					Finish Feature
			</button>
		</div>`;
	}

	private emptyHtml(message: string): string {
		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
	<div class="empty-workspace">
		<p>${this.escapeHtml(message)}</p>
	</div>
</body>
</html>`;
	}

	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}
}

// -- Interfaces ---------------------------------------------------
interface GitStats {
	filesChanged: number;
	insertions: number;
	deletions: number;
	raw: string;
}

// -- Inline SVG Icons (small, self-contained) ---------------------
const ICON_REFRESH = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.451 5.609l-.579-.921-1.017.641c-.597-.58-1.345-.99-2.162-1.18a5.03 5.03 0 0 0-2.441.077 4.975 4.975 0 0 0-2.108 1.299A5.007 5.007 0 0 0 3.986 8.1a4.947 4.947 0 0 0 .424 2.32 5.028 5.028 0 0 0 1.541 1.86 5.067 5.067 0 0 0 2.21.996 4.997 4.997 0 0 0 2.44-.079c.729-.224 1.393-.612 1.938-1.137l-.726-.726a3.98 3.98 0 0 1-1.535.892 3.98 3.98 0 0 1-1.935.062 4.037 4.037 0 0 1-1.758-.793A3.996 3.996 0 0 1 5.36 9.974a3.935 3.935 0 0 1-.337-1.842A3.985 3.985 0 0 1 5.723 6.3a3.955 3.955 0 0 1 1.674-1.032 3.998 3.998 0 0 1 1.94-.061c.65.133 1.248.436 1.723.875l-1.06.667.596.921L13.452 5.61z"/></svg>`;
const ICON_PLUS = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>`;
const ICON_FOLDER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h12v4.49zm0-5.49h-12V3h4.29l.85.85.36.15H14v2z"/></svg>`;
