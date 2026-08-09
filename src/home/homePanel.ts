import * as vscode from "vscode";
import { presentSessionBinding } from "../agents/attention/sessionBindingPresentation";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import { presentAgentState } from "../agents/observation/presentAgentState";
import type { TerminalController } from "../agents/terminalController";
import type { TmuxIntegration } from "../agents/tmux";
import { TERMINAL_COLOR_HEX, TERMINAL_COLOR_MAP } from "../constants/colors";
import { ICON_GIT } from "../constants/icons";
import type { ProjectManager } from "../projects/projectManager";
import type { GlobalStore } from "../storage/globalStore";
import type { Agent, Feature, Service } from "../types";

export class HomePanel {
	public static readonly viewType = "agentSpace.home";
	private static instance: HomePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly projectManager: ProjectManager;
	private readonly tmux: TmuxIntegration;
	private readonly toolRegistry: CodingToolRegistry;
	private readonly extensionUri: vscode.Uri;
	private readonly globalStore: GlobalStore;
	private terminalController?: TerminalController;
	private currentFeatureId: string | null = null;
	private currentProjectId: string | null = null;
	private currentProjectSettings = false;
	private refreshTimer?: ReturnType<typeof setInterval>;
	private onViewStateChangeCallback?:
		| ((state: { active: boolean; visible: boolean }) => void)
		| undefined;
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(
		projectManager: ProjectManager,
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
			tmux,
			toolRegistry,
			extensionUri,
			globalStore,
			terminalController,
		);
		return HomePanel.instance;
	}

	public static getInstance(): HomePanel | undefined {
		return HomePanel.instance;
	}

	private constructor(
		panel: vscode.WebviewPanel,
		projectManager: ProjectManager,
		tmux: TmuxIntegration,
		toolRegistry: CodingToolRegistry,
		extensionUri: vscode.Uri,
		globalStore: GlobalStore,
		terminalController?: TerminalController,
	) {
		this.panel = panel;
		this.projectManager = projectManager;
		this.tmux = tmux;
		this.toolRegistry = toolRegistry;
		this.extensionUri = extensionUri;
		this.globalStore = globalStore;
		this.terminalController = terminalController;

		this.setupMessageHandler();
		this.panel.onDidChangeViewState(
			({ webviewPanel }) => {
				this.onViewStateChangeCallback?.({
					active: webviewPanel.active,
					visible: webviewPanel.visible,
				});
			},
			null,
			this.disposables,
		);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		// Restore last active feature or show welcome
		const lastFeatureId = globalStore.getPreference<string>(
			"lastActiveFeatureId",
		);
		if (lastFeatureId && this.isFeatureValid(lastFeatureId)) {
			this.showFeature(lastFeatureId);
		} else {
			this.showWelcome();
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
		this.panel.title = "Agent Space";
		this.stopGitPolling();
		this.panel.webview.html = this.getWelcomeHtml();
	}

	public showFeature(featureId: string): void {
		this.currentFeatureId = featureId;
		this.currentProjectId = null;
		this.globalStore.setPreference("lastActiveFeatureId", featureId);
		const resolved = this.projectManager.resolveFeature(featureId);
		this.panel.title = resolved
			? `Agent Space: ${resolved.feature.branch}`
			: "Agent Space";
		this.panel.reveal(vscode.ViewColumn.One, true);
		this.startGitPolling();
		this.panel.webview.html = this.getFeatureHtml(featureId);
	}

	public showProject(projectId: string): void {
		this.showProjectPage(projectId, false);
	}

	public showProjectSettings(projectId: string): void {
		this.showProjectPage(projectId, true);
	}

	private showProjectPage(projectId: string, settings: boolean): void {
		const context = this.projectManager.getContext(projectId);
		if (!context) return;
		this.currentFeatureId = null;
		this.currentProjectId = projectId;
		this.currentProjectSettings = settings;
		this.panel.title = `Agent Space: ${context.project.name}`;
		this.stopGitPolling();
		this.panel.reveal(vscode.ViewColumn.One, true);
		this.panel.webview.html = this.getProjectHtml(projectId, settings);
	}

	public refresh(): void {
		try {
			if (this.currentFeatureId) {
				this.panel.webview.html = this.getFeatureHtml(this.currentFeatureId);
			} else if (this.currentProjectId) {
				this.panel.webview.html = this.getProjectHtml(
					this.currentProjectId,
					this.currentProjectSettings,
				);
			} else {
				this.panel.webview.html = this.getWelcomeHtml();
			}
		} catch {
			// Panel may have been disposed
		}
	}

	public getCurrentFeatureId(): string | null {
		return this.currentFeatureId;
	}

	private isFeatureValid(featureId: string): boolean {
		return this.projectManager.resolveFeature(featureId) !== undefined;
	}

	private dispose(): void {
		this.onViewStateChangeCallback?.({ active: false, visible: false });
		HomePanel.instance = undefined;
		this.stopGitPolling();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.panel.dispose();
	}

	private startGitPolling(): void {
		this.stopGitPolling();
		this.refreshTimer = setInterval(() => {
			this.sendGitStatsAsync().catch(() => {});
		}, 15_000);
		this.sendGitStatsAsync().catch(() => {});
	}

	private stopGitPolling(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
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
			case "showProjectSettings":
				run("agentSpace.openProjectSettings", message.projectId as string);
				break;
			case "openProjectConfig":
				run("agentSpace.openProjectConfig", message.projectId as string);
				break;
			case "openProviderDocs":
				run("agentSpace.openProviderDocs");
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
			case "focusAgent":
				this.focusAgentTerminal(message.agentId as string);
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
			case "deleteFeature":
				run("agentSpace.deleteFeature", message.featureId);
				break;
			case "syncNames":
				run("agentSpace.syncSessionNames");
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
			case "refresh":
				this.refresh();
				break;
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
	private focusAgentTerminal(agentId: string): void {
		if (!this.terminalController || !this.currentFeatureId) return;
		const resolved = this.projectManager.resolveFeature(this.currentFeatureId);
		if (!resolved) return;
		const { ctx, feature } = resolved;
		const agents = ctx.agentManager.getAgents(this.currentFeatureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		const agentIndex = agents.indexOf(agent);
		this.terminalController.focusOrCreateTerminal(
			feature,
			agent,
			agentIndex,
			true,
		);
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
		for (const agent of ctx.agentManager.getAgents(featureId)) {
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
			for (const agent of ctx.agentManager.getAgents(feature.id)) {
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
		const agents = ctx.agentManager.getAgents(this.currentFeatureId);
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
		const agents = ctx.agentManager.getAgents(this.currentFeatureId);
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

	// -- Git stats + attention ------------------------------------
	private async sendGitStatsAsync(): Promise<void> {
		if (!this.currentFeatureId) return;
		const resolved = this.projectManager.resolveFeature(this.currentFeatureId);
		if (!resolved) return;

		const agents = resolved.ctx.agentManager.getAgents(this.currentFeatureId);
		this.panel.webview.postMessage({
			type: "agentAttentionUpdate",
			agents: agents.map((agent) => ({
				presentedState: presentAgentState(
					resolved.ctx.agentManager.observe(agent),
				),
				id: agent.id,
				status: agent.attentionStatus ?? "unknown",
				lifecycleStatus: agent.status,
				reason: agent.attentionReason ?? "No current attention evidence",
				bindingState: agent.sessionBinding?.state,
				bindingDetail: agent.sessionBinding?.detail,
			})),
		});

		const stats = await this.getGitDiffStatsAsync(resolved.feature);
		if (!stats) return;

		this.panel.webview.postMessage({
			type: "gitStatsUpdate",
			html: this.renderGitStatsContent(stats),
		});
	}

	private async getGitDiffStatsAsync(
		feature: Feature,
	): Promise<GitStats | null> {
		const { execAsync } = await import("../utils/platform");
		try {
			let diffStat: string;
			try {
				const result = await execAsync(
					`git diff --stat HEAD...${feature.branch}`,
					{
						cwd: feature.worktreePath,
					},
				);
				diffStat = result.stdout.trim();
			} catch {
				const result = await execAsync("git diff --stat HEAD", {
					cwd: feature.worktreePath,
				});
				diffStat = result.stdout.trim();
			}

			return this.parseDiffStat(diffStat);
		} catch {
			return null;
		}
	}

	private getGitDiffStats(feature: Feature): GitStats | null {
		const { execSync } = require("node:child_process");
		try {
			let diffStat: string;
			try {
				diffStat = (
					execSync(`git diff --stat HEAD...${feature.branch}`, {
						cwd: feature.worktreePath,
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "ignore"],
					}) as string
				).trim();
			} catch {
				diffStat = (
					execSync("git diff --stat HEAD", {
						cwd: feature.worktreePath,
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "ignore"],
					}) as string
				).trim();
			}

			return this.parseDiffStat(diffStat);
		} catch {
			return null;
		}
	}

	private parseDiffStat(diffStat: string): GitStats {
		const summaryMatch = diffStat.match(
			/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
		);

		return {
			filesChanged: summaryMatch ? Number(summaryMatch[1]) : 0,
			insertions: summaryMatch ? Number(summaryMatch[2] ?? 0) : 0,
			deletions: summaryMatch ? Number(summaryMatch[3] ?? 0) : 0,
			raw: diffStat,
		};
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
		const projectSummaries = contexts.map((ctx) => {
			const features = [
				ctx.featureManager.getBaseFeature(ctx.project.id),
				...ctx.featureManager.getFeatures(),
			];
			const agents = features.flatMap((feature) =>
				ctx.agentManager.getAgents(feature.id).map((agent) => ({
					agent,
					feature,
					observation: ctx.agentManager.observe(agent),
				})),
			);
			return {
				ctx,
				features,
				activeAgents: agents.filter(
					({ observation }) =>
						observation.lifecycle.state === "running" ||
						observation.lifecycle.state === "starting",
				).length,
				waitingAgents: agents.filter(
					({ observation }) =>
						observation.attention.state === "waiting_for_user",
				).length,
				agents,
			};
		});
		const attentionItems = projectSummaries.flatMap(({ ctx, agents }) =>
			agents
				.filter(
					({ observation }) =>
						observation.attention.state === "waiting_for_user",
				)
				.map(({ agent, feature, observation }) => ({
					projectName: ctx.project.name,
					feature,
					agent,
					detail: observation.attention.reason ?? "Waiting for your answer",
				})),
		);
		const featureEntries = projectSummaries.flatMap(({ ctx, features }) =>
			features.map((feature) => ({
				ctx,
				feature,
				agents: ctx.agentManager.getAgents(feature.id),
			})),
		);
		featureEntries.sort((a, b) => {
			if (a.feature.status !== b.feature.status) {
				return a.feature.status === "active" ? -1 : 1;
			}
			return b.feature.createdAt.localeCompare(a.feature.createdAt);
		});

		const attentionHtml = attentionItems.length
			? attentionItems
					.map(
						({ projectName, feature, agent, detail }) => `
					<button class="attention-item" onclick="openFeature('${feature.id}')">
						<span class="attention-item-title">${this.escapeHtml(agent.name)} · ${this.escapeHtml(projectName)}/${this.escapeHtml(feature.branch)}</span>
						<span class="attention-item-detail">${this.escapeHtml(detail)}</span>
					</button>`,
					)
					.join("")
			: '<div class="activity-empty">Nothing needs your attention right now.</div>';
		const projectHtml = projectSummaries.length
			? projectSummaries
					.map(
						({ ctx, activeAgents, waitingAgents }) => `
					<div class="project-summary-card" onclick="showProject('${ctx.project.id}')">
						<div class="project-summary-header">
							<strong>${this.escapeHtml(ctx.project.name)}</strong>
							<span>${activeAgents} active${waitingAgents ? ` · ${waitingAgents} waiting` : ""}</span>
						</div>
						<div class="project-summary-path">${this.escapeHtml(ctx.featureManager.getBaseBranchName())} · ${this.escapeHtml(ctx.project.repoPath)}</div>
					</div>`,
					)
					.join("")
			: '<div class="empty-welcome"><div class="empty-welcome-text">No projects yet.</div></div>';
		const featureHtml = featureEntries.length
			? featureEntries
					.slice(0, 12)
					.map(({ ctx, feature, agents }) => {
						const waiting = agents.filter(
							(agent) =>
								ctx.agentManager.observe(agent).attention.state ===
								"waiting_for_user",
						).length;
						const active = agents.filter(
							(agent) =>
								ctx.agentManager.observe(agent).lifecycle.state === "running",
						).length;
						return `<button class="feature-summary-row" onclick="openFeature('${feature.id}')">
							<span><strong>${this.escapeHtml(feature.branch)}</strong><small>${this.escapeHtml(ctx.project.name)}${feature.id.startsWith("base:") ? " · BASE" : ""}</small></span>
							<span>${waiting ? `${waiting} waiting` : `${active} active`}</span>
						</button>`;
					})
					.join("")
			: '<div class="activity-empty">No features yet.</div>';
		const sessionCount = projectSummaries.reduce(
			(total, summary) =>
				total +
				summary.agents.filter(({ agent }) => Boolean(agent.sessionId)).length,
			0,
		);
		const diagnosticsLabel = this.tmux.isAvailable()
			? `${sessionCount} session${sessionCount === 1 ? "" : "s"} · tmux available`
			: `${sessionCount} session${sessionCount === 1 ? "" : "s"} · tmux unavailable`;
		const body = projects.length
			? `<div class="welcome-container">
				<div class="welcome-header"><div class="welcome-title">Agent Space</div><div class="welcome-subtitle">Projects, features and human attention</div></div>
				<div class="quick-actions-row"><button class="action-btn" onclick="addProject()">${ICON_FOLDER} Add Project</button></div>
				<div class="section-label">Needs Your Attention</div><div class="attention-list">${attentionHtml}</div>
				<div class="section-label">Projects</div><div class="project-summary-grid">${projectHtml}</div>
				<div class="section-label">Active / Recent Features</div><div class="feature-summary-list">${featureHtml}</div>
				<div class="diagnostics-summary" title="Detailed diagnostics are available through Agent Space: Doctor">Diagnostics <span>${diagnosticsLabel}</span></div>
			</div>`
			: `<div class="welcome-container"><div class="welcome-header"><div class="welcome-title">Agent Space</div><div class="welcome-subtitle">Projects, features and human attention</div></div><div class="empty-welcome"><div class="empty-welcome-title">No projects yet</div><div class="empty-welcome-text">Add a Git project to get started with Agent Space.</div><button class="quick-action-btn primary" onclick="addProject()">${ICON_FOLDER} Add Project</button></div></div>`;

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

		const { ctx, feature } = resolved;
		const agents = ctx.agentManager.getAgents(featureId);
		const services = ctx.serviceManager.getServices(featureId);
		const dotColor = TERMINAL_COLOR_MAP[feature.color] || "#569cd6";

		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);

		const activeAgents = agents.filter(
			(a) => a.status === "running" || a.status === "idle",
		);
		const erroredAgents = agents.filter((a) => a.status === "errored");
		const doneAgents = agents.filter((a) => a.status === "done");
		const stoppedAgents = agents.filter((a) => a.status === "stopped");
		const totalAgents =
			activeAgents.length + erroredAgents.length + doneAgents.length;
		const doneCount = doneAgents.length;
		const progressPct =
			totalAgents > 0 ? Math.round((doneCount / totalAgents) * 100) : 0;

		const body = `
		<div class="workspace-header">
			<button class="home-back-btn" onclick="goHome()" title="Back to Agent Space">&larr;</button>
			<div class="header-color-dot" style="background: ${dotColor}"></div>
			<div class="header-info">
				<div class="header-title">${this.escapeHtml(feature.name)}</div>
				<div class="header-branch">${this.escapeHtml(feature.branch)}</div>
			</div>
			<span class="header-status ${feature.status}">${feature.status === "done" ? "Done" : "Active"}</span>
			<div class="header-actions">
				<button class="header-action-btn" onclick="quickAction('refresh', '${feature.id}')" title="Refresh">
					${ICON_REFRESH}
				</button>
				<button class="header-action-btn" onclick="quickAction('openGitView', '${feature.id}')" title="Open Workspace">
					${ICON_GIT}
				</button>
			</div>
		</div>
		<div class="workspace-content">
			${this.renderProgressSection(progressPct, doneCount, totalAgents)}
			${this.renderAgentsSection(
				activeAgents,
				erroredAgents,
				doneAgents,
				stoppedAgents,
				agents,
				feature,
			)}
			${this.renderServicesSection(services, feature)}
			${this.renderFeatureTmuxSection(feature, agents, services)}
			${this.renderGitStatsSection(feature)}
			${this.renderQuickActions(
				feature,
				ctx.featureManager.getBootstrapCommands().length > 0,
			)}
			${this.renderFeatureActions(feature)}
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
.agent-status-dot.attention-working { background: var(--vscode-testing-iconPassed); animation: pulse-green 2s ease-in-out infinite; }
.agent-status-dot.attention-waiting_for_user { background: var(--vscode-notificationsWarningIcon-foreground); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 18%, transparent); }
.agent-status-dot.attention-failed { background: var(--vscode-errorForeground); }
.agent-status-dot.attention-idle, .agent-status-dot.attention-unknown, .agent-status-dot.attention-done { background: var(--vscode-disabledForeground); }
.binding-badge { white-space: nowrap; }
.binding-badge.binding-pending { opacity: .75; }
.binding-badge.binding-ambiguous { color: var(--vscode-notificationsWarningIcon-foreground); background: color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 14%, transparent); }
.binding-badge.binding-unverified { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); }
.binding-badge.binding-unsupported { opacity: .6; }
.agent-lifecycle-badge { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.agent-session-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 9px; }
.agent-status-dot.primary-state-working { background: var(--vscode-testing-iconPassed); animation: pulse-green 2s ease-in-out infinite; }
.agent-status-dot.primary-state-warning { background: var(--vscode-notificationsWarningIcon-foreground); }
.agent-status-dot.primary-state-error { background: var(--vscode-errorForeground); }
.agent-status-dot.primary-state-normal, .agent-status-dot.primary-state-muted { background: var(--vscode-disabledForeground); }
</style>
</head>
<body>
	${body}
	<script src="${jsUri}"></script>
</body>
</html>`;
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
		const effectiveBaseBranch = context.featureManager.getBaseBranchName();
		const explicitBaseBranch = context.config.baseBranch?.trim();
		const branchKinds = context.featureManager.getBranchKinds();
		const defaultBranchKind = context.featureManager.getDefaultBranchKind();
		const enabledAgents = context.config.agents?.enabled ?? [];
		const defaultAgent = context.config.agents?.default;
		const features = [
			context.featureManager.getBaseFeature(context.project.id),
			...context.featureManager.getFeatures(),
		];
		const featureRows = features
			.map((feature) => {
				const agents = context.agentManager.getAgents(feature.id);
				const waiting = agents.filter(
					(agent) =>
						context.agentManager.observe(agent).attention.state ===
						"waiting_for_user",
				).length;
				const active = agents.filter((agent) => {
					const lifecycle = context.agentManager.observe(agent).lifecycle.state;
					return lifecycle === "running" || lifecycle === "starting";
				}).length;
				const state = waiting
					? `${waiting} waiting`
					: feature.id.startsWith("base:")
						? "BASE"
						: `${active} active`;
				return `
				<div class="project-feature-row" onclick="openFeature('${feature.id}')">
					<div>
						<strong>${this.escapeHtml(feature.name)}</strong>
						<div class="project-setting-source">${this.escapeHtml(feature.branch)} · ${state}</div>
					</div>
					<button class="quick-action-btn subtle" onclick="event.stopPropagation(); openFeature('${feature.id}')">Open</button>
				</div>`;
			})
			.join("");
		const waitingAgents = features.flatMap((feature) =>
			context.agentManager
				.getAgents(feature.id)
				.filter(
					(agent) =>
						context.agentManager.observe(agent).attention.state ===
						"waiting_for_user",
				)
				.map((agent) => ({ agent, feature })),
		);
		const activeFeatures = features.filter(
			(feature) => feature.status === "active",
		).length;
		const activeAgents = features.reduce(
			(total, feature) =>
				total +
				context.agentManager.getAgents(feature.id).filter((agent) => {
					const lifecycle = context.agentManager.observe(agent).lifecycle.state;
					return lifecycle === "running" || lifecycle === "starting";
				}).length,
			0,
		);
		const projectSettingsCard = `
			<div class="project-settings-card">
				<div class="section-label">Project configuration</div>
				<div class="project-settings-grid">
					<div><span class="project-setting-label">Base branch</span><strong>${this.escapeHtml(effectiveBaseBranch)}</strong><span class="project-setting-source">${explicitBaseBranch ? "Configured in .agentspace/config.json" : "Current checkout fallback"}</span></div>
					<div><span class="project-setting-label">Branch kinds</span><span>${this.escapeHtml(branchKinds.join(", ") || "Default")}</span>${defaultBranchKind ? `<span class="project-setting-source">Default: ${this.escapeHtml(defaultBranchKind)}</span>` : ""}</div>
					<div><span class="project-setting-label">Worktrees</span><span class="project-worktree-cell">${this.escapeHtml(context.featureManager.getWorktreeBase())}</span></div>
					<div><span class="project-setting-label">Enabled providers</span><span>${this.escapeHtml(enabledAgents.join(", ") || "All available")}</span>${defaultAgent ? `<span class="project-setting-source">Default: ${this.escapeHtml(defaultAgent)}</span>` : ""}</div>
				</div>
				<div class="project-settings-actions">
					<button class="quick-action-btn" onclick="editProjectBaseBranch('${projectId}')">Edit base branch</button>
					<button class="quick-action-btn" onclick="openProjectConfig('${projectId}')">Open .agentspace/config.json</button>
					<button class="quick-action-btn subtle" onclick="openProviderDocs()">Configuration documentation / examples</button>
				</div>
			</div>`;
		const overviewAttention = waitingAgents.length
			? `<div class="attention-list">${waitingAgents
					.map(
						({ agent, feature }) =>
							`<button class="attention-item" onclick="openFeature('${feature.id}')"><span class="attention-item-title">${this.escapeHtml(agent.name)} · ${this.escapeHtml(feature.branch)}</span><span class="attention-item-detail">Needs your attention</span></button>`,
					)
					.join("")}</div>`
			: '<div class="activity-empty">No agents are waiting for you in this project.</div>';
		const projectPageContent = settings
			? `<div class="project-page-nav"><button class="quick-action-btn" onclick="showProject('${projectId}')">Overview</button><button class="quick-action-btn primary">Settings</button></div>${projectSettingsCard}`
			: `<div class="project-page-nav"><button class="quick-action-btn primary">Overview</button><button class="quick-action-btn" onclick="showProjectSettings('${projectId}')">Settings</button></div>
			<div class="project-overview-grid"><div><div class="section-label">Needs attention</div>${overviewAttention}</div><div class="project-settings-card"><div class="section-label">Repository overview</div><div class="project-settings-grid"><div><span class="project-setting-label">Active features</span><strong>${activeFeatures}</strong></div><div><span class="project-setting-label">Active agents</span><strong>${activeAgents}</strong></div><div><span class="project-setting-label">Base branch</span><strong>${this.escapeHtml(effectiveBaseBranch)}</strong></div><div><span class="project-setting-label">Project path</span><span class="project-worktree-cell">${this.escapeHtml(context.project.repoPath)}</span></div></div></div></div>
			<div><div class="section-label">Features</div><div class="project-feature-list">${featureRows || '<div class="activity-empty">No features yet.</div>'}</div><button class="quick-action-btn primary project-new-feature" onclick="newFeature('${projectId}')">New Feature</button></div>`;

		const body = `
		<div class="workspace-header">
			<button class="home-back-btn" onclick="goHome()" title="Back to Agent Space">&larr;</button>
			<div class="header-info">
				<div class="header-title">${this.escapeHtml(context.project.name)}</div>
				<div class="header-branch">${this.escapeHtml(context.project.repoPath)}</div>
			</div>
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
</head>
<body>
	${body}
	<script src="${jsUri}"></script>
</body>
</html>`;
	}

	// -- Feature Home render helpers ------------------------------
	private renderProgressSection(
		pct: number,
		done: number,
		total: number,
	): string {
		if (total === 0) return "";
		return `
		<div class="progress-section">
			<div class="progress-label">
				<span>Agent Progress</span>
				<span>${done} / ${total} done</span>
			</div>
			<div class="progress-track">
				<div class="progress-fill" style="width: ${pct}%"></div>
			</div>
		</div>`;
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
		const toolBadge = `<span class="agent-tool-badge">${this.escapeHtml(tool.name)}</span>`;
		const observation = this.projectManager
			.resolveFeature(feature.id)
			?.ctx.agentManager.observe(agent);
		const presented = observation
			? presentAgentState(observation)
			: { label: "Unknown", tone: "muted" as const };
		const isDone = agent.status === "done";
		const bindingBadgeData = presentSessionBinding(
			agent.sessionBinding,
			agent.status,
		);
		const bindingBadge = bindingBadgeData
			? `<span id="agent-binding-badge-${agent.id}" class="agent-tool-badge ${bindingBadgeData.className}" title="${this.escapeHtml(bindingBadgeData.tooltip)}">${bindingBadgeData.label}</span>`
			: `<span id="agent-binding-badge-${agent.id}" class="agent-tool-badge" style="display:none"></span>`;
		const isErrored = agent.status === "errored";
		const nameClass = isDone ? "agent-panel-name done" : "agent-panel-name";
		const emptyState = isDone
			? "Agent finished &mdash; no live activity"
			: isErrored
				? this.escapeHtml(
						agent.lastError ?? "Agent failed to start or exited unexpectedly.",
					)
				: "Click to view live terminal output";

		let actionButtons: string;
		if (isDone) {
			actionButtons = `
				<button class="agent-action-btn" onclick="event.stopPropagation(); reopenAgent('${feature.id}', '${agent.id}')" title="Reopen">&#8635;</button>`;
		} else {
			const focusTitle = isErrored ? "Retry Agent" : "Focus Terminal";
			actionButtons = `
				<button class="agent-action-btn" onclick="event.stopPropagation(); focusAgent('${feature.id}', '${agent.id}')" title="${focusTitle}">&#9243;</button>
				<button class="agent-action-btn" onclick="event.stopPropagation(); markAgentDone('${feature.id}', '${agent.id}', '${this.escapeHtml(agent.name)}')" title="Mark Done">&#10003;</button>`;
		}

		return `
		<div class="agent-panel ${isErrored ? "errored" : ""}" style="border-left: 2px solid ${color}">
			<div class="agent-panel-header" id="agent-header-${agent.id}" onclick="toggleAgent('${agent.id}')">
				<div id="agent-attention-dot-${agent.id}" class="agent-status-dot primary-state-${presented.tone}"></div>
				<span class="${nameClass}" title="${this.escapeHtml(agent.name)}">${this.escapeHtml(agent.name)}</span>
				${agent.sessionTitle ? `<span class="agent-session-title" title="${this.escapeHtml(agent.sessionTitle)}">${this.escapeHtml(agent.sessionTitle)}</span>` : ""}
				<span id="agent-lifecycle-badge-${agent.id}" class="agent-tool-badge agent-lifecycle-badge primary-state-${presented.tone}" title="${this.escapeHtml(presented.detail ?? "")}">${presented.label}</span>
				${toolBadge}
				${bindingBadge}
				<div class="agent-panel-actions">
					${actionButtons}
				</div>
				<span class="agent-panel-chevron" id="agent-chevron-${agent.id}">&rsaquo;</span>
			</div>
			<div class="agent-activity" id="agent-activity-${agent.id}">
				<div class="activity-content">
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

	private renderFeatureTmuxSection(
		feature: Feature,
		agents: Agent[],
		services: Service[],
	): string {
		const featureGroup = this.renderTmuxFeatureGroup(feature, agents, services);
		return `
		<div>
			<div class="section-label">Tmux Sessions</div>
			${
				featureGroup ??
				'<div class="tmux-empty-state">No managed tmux sessions for this feature.</div>'
			}
		</div>`;
	}

	private renderTmuxFeatureGroup(
		feature: Feature,
		agents: Agent[],
		services: Service[],
		projectId?: string,
	): string | null {
		const { liveRows, inactiveRows } = this.getTmuxSessionRows(
			feature.id,
			agents,
			services,
		);
		if (liveRows.length === 0 && inactiveRows.length === 0) {
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
					<span class="tmux-count-badge">${liveRows.length} session${liveRows.length === 1 ? "" : "s"}</span>
					<button class="quick-action-btn danger subtle" onclick="killFeatureSessions('${feature.id}')">Kill Feature Sessions</button>
					${
						projectId
							? `<button class="quick-action-btn subtle" onclick="openFeature('${feature.id}')">Open</button>`
							: ""
					}
				</div>
			</div>
			<div class="tmux-session-list">
				${liveRows.length > 0 ? liveRows.join("") : '<div class="tmux-empty-state">No live tmux sessions for this feature.</div>'}
			</div>
			${inactiveSection}
		</div>`;
	}

	private getTmuxSessionRows(
		featureId: string,
		agents: Agent[],
		services: Service[],
	): { liveRows: string[]; inactiveRows: string[] } {
		const liveRows: string[] = [];
		const inactiveRows: string[] = [];

		for (const agent of agents) {
			const sessionName =
				agent.tmuxSession ?? this.tmux.sessionName(featureId, agent.id);
			if (this.tmux.isSessionAlive(sessionName)) {
				liveRows.push(
					this.renderTmuxAgentSessionRow(featureId, agent, sessionName, true),
				);
			} else {
				inactiveRows.push(
					this.renderTmuxAgentSessionRow(featureId, agent, sessionName, false),
				);
			}
		}

		for (const service of services) {
			if (this.tmux.isSessionAlive(service.tmuxSession)) {
				liveRows.push(
					this.renderTmuxServiceSessionRow(featureId, service, true),
				);
			} else {
				inactiveRows.push(
					this.renderTmuxServiceSessionRow(featureId, service, false),
				);
			}
		}

		return { liveRows, inactiveRows };
	}

	private renderTmuxAgentSessionRow(
		featureId: string,
		agent: Agent,
		sessionName?: string,
		alive = true,
	): string {
		const resolvedSessionName =
			sessionName ?? this.tmux.sessionName(featureId, agent.id);
		const actionButton = alive
			? `<button class="quick-action-btn danger subtle" onclick="killAgentSession('${featureId}', '${agent.id}')">Kill</button>`
			: "";
		return `
		<div class="tmux-session-row">
			<div class="tmux-session-main">
				<div class="tmux-session-title">
					<span class="tmux-session-type">Agent</span>
					<span>${this.escapeHtml(agent.name)}</span>
					<span class="tmux-live-pill ${alive ? "live" : "dead"}">${alive ? "Live" : "Stopped"}</span>
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
		alive = true,
	): string {
		const actionButton = alive
			? `<button class="quick-action-btn danger subtle" onclick="killServiceSession('${featureId}', '${service.id}')">Kill</button>`
			: "";
		return `
		<div class="tmux-session-row">
			<div class="tmux-session-main">
				<div class="tmux-session-title">
					<span class="tmux-session-type">Script</span>
					<span>${this.escapeHtml(service.name)}</span>
					<span class="tmux-live-pill ${alive ? "live" : "dead"}">${alive ? "Live" : "Stopped"}</span>
				</div>
				<div class="tmux-session-meta">
					<span>${this.escapeHtml(service.tmuxSession)}</span>
					<span>${this.escapeHtml(service.status)}</span>
				</div>
			</div>
			${actionButton}
		</div>`;
	}

	private renderGitStatsSection(feature: Feature): string {
		const stats = this.getGitDiffStats(feature);
		const content = stats
			? this.renderGitStatsContent(stats)
			: '<div class="activity-empty">No changes yet</div>';

		return `
		<div>
			<div class="section-label">Git Changes</div>
			<div class="git-stats" id="git-stats-content">
				${content}
			</div>
		</div>`;
	}

	private renderQuickActions(feature: Feature, hasBootstrap = false): string {
		return `
		<div>
			<div class="section-label">Quick Actions</div>
			<div class="quick-actions">
				<button class="quick-action-btn primary" onclick="quickAction('addAgent', '${feature.id}')">
					${ICON_PLUS} Add Agent
				</button>
				<button class="quick-action-btn" onclick="quickAction('addService', '${feature.id}')">
					${ICON_SERVER} Add Service
				</button>
				${hasBootstrap ? `<button class="quick-action-btn" onclick="quickAction('bootstrapFeature', '${feature.id}')">Bootstrap Worktree</button>` : ""}
				<button class="quick-action-btn" onclick="quickAction('createPR', '${feature.id}')">
					${ICON_PR} Create PR
				</button>
				<button class="quick-action-btn" onclick="quickAction('openGitView', '${feature.id}')">
					${ICON_GIT} Open Workspace
				</button>
				<button class="quick-action-btn" onclick="quickAction('syncNames', '${feature.id}')">
					${ICON_SYNC} Sync Names
				</button>
			</div>
		</div>`;
	}

	private renderFeatureActions(feature: Feature): string {
		return `
		<div class="feature-actions-section">
			<button class="quick-action-btn danger" onclick="deleteFeature('${feature.id}')">
				Delete Feature
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
const ICON_SERVER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2h9l.5.5v3l-.5.5h-9l-.5-.5v-3l.5-.5zm0 5h9l.5.5v3l-.5.5h-9l-.5-.5v-3l.5-.5zm0 5h9l.5.5v1l-.5.5h-9l-.5-.5v-1l.5-.5zM5 4h1V3H5v1zm0 5h1V8H5v1z"/></svg>`;
const ICON_PR = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7 3.28V12h1V3.28l2.35 2.36.71-.7L8 1.88l-.35.35L4.59 5.29l.7.71L7 3.28zM13.5 7.72V14H2.5V7.72h-1V14.5l.5.5h12l.5-.5V7.72h-1z"/></svg>`;
const ICON_SYNC = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.71.71-1.34-1.34c-.04 1.53.5 2.93 1.53 3.96a5.55 5.55 0 0 0 3.92 1.63l.04 1a6.55 6.55 0 0 1-4.63-1.92 6.48 6.48 0 0 1-1.79-4.53zm12.2-.53l-.76-.01-2.09-2.12.71-.71 1.34 1.34c.04-1.53-.5-2.93-1.53-3.96a5.55 5.55 0 0 0-3.92-1.63l-.04-1a6.55 6.55 0 0 1 4.63 1.92 6.47 6.47 0 0 1 1.78 4.53l1.22-1.23.78.77-2.12 2.1z"/></svg>`;
