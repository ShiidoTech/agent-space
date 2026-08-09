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
		this.panel.webview.html = this.getInformationArchitectureHomeHtml();
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
		this.panel.webview.html = this.getInformationArchitectureProjectHtml(
			projectId,
			settings,
		);
	}

	public refresh(): void {
		try {
			if (this.currentFeatureId) {
				this.panel.webview.html = this.getFeatureHtml(this.currentFeatureId);
			} else if (this.currentProjectId) {
				this.panel.webview.html = this.getInformationArchitectureProjectHtml(
					this.currentProjectId,
					this.currentProjectSettings,
				);
			} else {
				this.panel.webview.html = this.getInformationArchitectureHomeHtml();
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
			case "openConfigDocs":
				run("agentSpace.openConfigDocs");
				break;
			case "openDiagnostics":
				run("agentSpace.doctor");
				break;
			case "attachProviderSession":
				run(
					"agentSpace.attachProviderSession",
					message.featureId,
					message.agentId,
				);
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

	private getInformationArchitectureHomeHtml(): string {
		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);
		const contexts = this.projectManager.getAllContexts();
		const attention: string[] = [];
		const allFeatures: Array<{
			id: string;
			branch: string;
			projectId: string;
			projectName: string;
			active: number;
			waiting: number;
			createdAt: string;
			status: string;
		}> = [];

		for (const ctx of contexts) {
			const features = [
				ctx.featureManager.getBaseFeature(ctx.project.id),
				...ctx.featureManager.getFeatures(),
			];
			for (const feature of features) {
				const agents = ctx.agentManager.getAgents(feature.id);
				let active = 0;
				let waiting = 0;
				for (const agent of agents) {
					const observation = ctx.agentManager.observe(agent);
					const presented = presentAgentState(observation);
					if (presented.label === "Needs you") {
						waiting++;
						attention.push(
							`<button class="attention-item" onclick="showFeature('${feature.id}')"><span class="attention-agent">${this.escapeHtml(agent.name)} · ${this.escapeHtml(ctx.project.name)}/${this.escapeHtml(feature.branch)}</span><strong>Needs your attention</strong><span>${this.escapeHtml(presented.detail ?? "Waiting for your answer")}</span></button>`,
						);
					}
					if (
						["Working", "Running", "Idle", "Starting"].includes(presented.label)
					)
						active++;
				}
				if (feature.id !== `base:${ctx.project.id}` || agents.length > 0) {
					allFeatures.push({
						id: feature.id,
						branch: feature.branch,
						projectId: ctx.project.id,
						projectName: ctx.project.name,
						active,
						waiting,
						createdAt: feature.createdAt,
						status: feature.status,
					});
				}
			}
		}

		const projectCards = contexts
			.map((ctx) => {
				const projectFeatures = allFeatures.filter(
					(f) => f.projectId === ctx.project.id && !f.id.startsWith("base:"),
				);
				const active = projectFeatures.filter((f) => f.active > 0).length;
				const waiting = projectFeatures.filter((f) => f.waiting > 0).length;
				return `<button class="home-project-card" onclick="showProject('${ctx.project.id}')"><span class="home-project-name">${this.escapeHtml(ctx.project.name)}</span><span class="home-project-meta">${active} active${waiting ? ` · ${waiting} waiting` : ""}</span><span class="home-project-branch">Base: ${this.escapeHtml(ctx.featureManager.getBaseBranchName())}</span></button>`;
			})
			.join("");
		const featureCards = allFeatures
			.filter((f) => !f.id.startsWith("base:"))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 12)
			.map(
				(f) =>
					`<button class="home-feature-row" onclick="showFeature('${f.id}')"><span><strong>${this.escapeHtml(f.branch)}</strong><small>${this.escapeHtml(f.projectName)}</small></span><span class="home-feature-state ${f.waiting ? "waiting" : f.active ? "active" : "idle"}">${f.waiting ? "Waiting" : f.active ? "Active" : f.status === "done" ? "Done" : "Recent"}</span></button>`,
			)
			.join("");
		const tmuxSessions = this.projectManager.listTmuxSessions();
		const body =
			contexts.length === 0
				? `<main class="ia-home"><h1>Agent Space</h1><div class="ia-empty"><h2>No projects yet</h2><p>Add a Git project to start working with agents.</p><button class="quick-action-btn primary" onclick="addProject()">Add project</button></div></main>`
				: `<main class="ia-home"><header class="ia-home-header"><div><h1>Agent Space</h1><p>Projects, features, agents, and human attention.</p></div><button class="quick-action-btn" onclick="addProject()">Add project</button></header>
			${attention.length ? `<section class="ia-section attention-section"><h2>Needs your attention</h2>${attention.join("")}</section>` : ""}
			<section class="ia-section"><h2>Projects</h2><div class="home-project-grid">${projectCards}</div></section>
			<section class="ia-section"><h2>Active / recent features</h2><div class="home-feature-list">${featureCards || '<div class="activity-empty">No features yet.</div>'}</div></section>
			<section class="ia-section diagnostics-section"><h2>Diagnostics</h2><p>${tmuxSessions.length} technical session${tmuxSessions.length === 1 ? "" : "s"} · details available in Doctor</p><button class="quick-action-btn subtle" onclick="openDiagnostics()">Open diagnostics</button></section>
		</main>`;
		return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${cssUri}"></head><body>${body}<script src="${jsUri}"></script></body></html>`;
	}

	private getInformationArchitectureProjectHtml(
		projectId: string,
		settings = false,
	): string {
		const context = this.projectManager.getContext(projectId);
		if (!context) return this.emptyHtml("Project not found");
		const cssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.css"),
		);
		const jsUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "home.js"),
		);
		const features = [
			context.featureManager.getBaseFeature(context.project.id),
			...context.featureManager.getFeatures(),
		];
		const baseBranch = context.featureManager.getBaseBranchName();
		const activeFeatures: Feature[] = [];
		const waitingFeatures: Feature[] = [];
		for (const feature of features) {
			const agents = context.agentManager.getAgents(feature.id);
			const observations = agents.map((agent) =>
				presentAgentState(context.agentManager.observe(agent)),
			);
			if (observations.some((state) => state.label === "Needs you"))
				waitingFeatures.push(feature);
			if (
				observations.some((state) =>
					["Working", "Running", "Idle", "Starting"].includes(state.label),
				)
			)
				activeFeatures.push(feature);
		}
		const attentionHtml = waitingFeatures
			.map(
				(feature) =>
					`<button class="attention-item" onclick="showFeature('${feature.id}')"><span class="attention-agent">${this.escapeHtml(feature.branch)}</span><strong>${context.agentManager.getAgents(feature.id).filter((agent) => presentAgentState(context.agentManager.observe(agent)).label === "Needs you").length} agent(s) need you</strong><span>Open feature</span></button>`,
			)
			.join("");
		const featureRows = features
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((feature) => {
				const agents = context.agentManager.getAgents(feature.id);
				const services = context.serviceManager.getServices(feature.id);
				const agentSummary = agents.length
					? agents
							.map((agent) => {
								const state = presentAgentState(
									context.agentManager.observe(agent),
								);
								return `<span class="project-agent-chip"><strong>${this.escapeHtml(agent.name)}</strong> · ${this.escapeHtml(state.label)}</span>`;
							})
							.join("")
					: '<span class="project-setting-source">No agents</span>';
				return `<article class="project-feature-block"><button class="home-feature-row" onclick="showFeature('${feature.id}')"><span><strong>${this.escapeHtml(feature.name)}</strong><small>${this.escapeHtml(feature.branch)}${feature.id.startsWith("base:") ? " · repository base" : ""}</small></span><span class="home-feature-state ${waitingFeatures.includes(feature) ? "waiting" : activeFeatures.includes(feature) ? "active" : "idle"}">${waitingFeatures.includes(feature) ? "Waiting" : activeFeatures.includes(feature) ? "Active" : feature.status === "done" ? "Done" : "Idle"}</span></button><div class="project-agent-list">${agentSummary}</div>${services.length ? `<div class="project-services-summary">${services.length} service${services.length === 1 ? "" : "s"}: ${services.map((service) => this.escapeHtml(service.name)).join(", ")}</div>` : ""}</article>`;
			})
			.join("");
		const config = context.config;
		const configuredAgents =
			config.agents?.enabled?.join(", ") || "All available providers";
		const settingsHtml = `<section class="project-settings-card"><h2>Project settings</h2><p class="settings-help">The complete project convention remains in <code>.agentspace/config.json</code>.</p><div class="project-settings-grid"><div><span class="project-setting-label">Base branch</span><strong>${this.escapeHtml(baseBranch)}</strong></div><div><span class="project-setting-label">Branch kinds</span><span>${this.escapeHtml(context.featureManager.getBranchKinds().join(", ") || "feat")}</span></div><div><span class="project-setting-label">Default branch kind</span><span>${this.escapeHtml(context.featureManager.getDefaultBranchKind() || "feat")}</span></div><div><span class="project-setting-label">Worktree directory</span><span class="project-worktree-cell">${this.escapeHtml(context.featureManager.getWorktreeBase())}</span></div><div><span class="project-setting-label">Providers enabled</span><span>${this.escapeHtml(configuredAgents)}</span></div><div><span class="project-setting-label">Default provider</span><span>${this.escapeHtml(config.agents?.default || "Global default")}</span></div></div><div class="project-settings-actions"><button class="quick-action-btn" onclick="openProjectConfig('${projectId}')">Open .agentspace/config.json</button><button class="quick-action-btn subtle" onclick="openConfigDocs()">Configuration documentation / examples</button><button class="quick-action-btn subtle" onclick="editProjectBaseBranch('${projectId}')">Edit base branch</button></div></section>`;
		const content = settings
			? `<nav class="project-page-nav"><button class="quick-action-btn" onclick="showProject('${projectId}')">Overview</button><button class="quick-action-btn primary">Settings</button></nav>${settingsHtml}`
			: `<nav class="project-page-nav"><button class="quick-action-btn primary">Overview</button><button class="quick-action-btn" onclick="showProjectSettings('${projectId}')">Settings</button></nav>${attentionHtml ? `<section class="ia-section attention-section"><h2>Needs attention</h2>${attentionHtml}</section>` : ""}<section class="ia-section"><h2>Repository control center</h2><div class="project-health-card"><p><strong>${this.escapeHtml(context.project.name)}</strong> · base branch <strong>${this.escapeHtml(baseBranch)}</strong></p><p class="project-setting-source">${this.escapeHtml(context.project.repoPath)} · ${features.length} tracked area${features.length === 1 ? "" : "s"} · ${activeFeatures.length} active · ${waitingFeatures.length} waiting</p></div></section><section class="ia-section"><h2>Features, agents &amp; services</h2><div class="home-feature-list">${featureRows || '<div class="activity-empty">No features yet.</div>'}</div><button class="quick-action-btn primary project-new-feature" onclick="newFeature('${projectId}')">New feature</button></section>`;
		return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${cssUri}"></head><body><main class="ia-home"><header class="workspace-header"><button class="home-back-btn" onclick="goHome()" title="Back to Agent Space">&larr;</button><div class="header-info"><h1 class="header-title">${this.escapeHtml(context.project.name)}</h1><div class="header-branch">${this.escapeHtml(context.project.repoPath)}</div></div></header>${content}</main><script src="${jsUri}"></script></body></html>`;
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
			(a) =>
				a.status === "running" ||
				a.status === "idle" ||
				(a.startup && a.startup.state !== "ready" && a.status !== "done"),
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
			<button class="project-context-link" onclick="showProject('${ctx.project.id}')" title="Open project">${this.escapeHtml(ctx.project.name)}</button>
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
			${this.renderFeatureProvisioning(feature)}
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
.lifecycle-card { margin: 0 0 18px; padding: 14px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editorInfo-background) 35%, transparent); }
.lifecycle-card.failed { border-color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 35%, transparent); }
.lifecycle-card-title { font-weight: 600; margin-bottom: 10px; }
.lifecycle-steps { display: grid; gap: 6px; }
.lifecycle-step { display: grid; grid-template-columns: 18px 1fr; gap: 7px; align-items: start; color: var(--vscode-descriptionForeground); font-size: 12px; }
.lifecycle-step.completed { color: var(--vscode-testing-iconPassed); }
.lifecycle-step.running { color: var(--vscode-foreground); }
.lifecycle-step.failed { color: var(--vscode-errorForeground); }
.lifecycle-step-icon { font-weight: 700; text-align: center; }
.lifecycle-step small { grid-column: 2; color: var(--vscode-errorForeground); overflow-wrap: anywhere; }
.lifecycle-error { margin: 10px 0 0; color: var(--vscode-errorForeground); font-size: 12px; }
.agent-startup-steps { margin: 0 0 10px; }
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

	private renderFeatureProvisioning(feature: Feature): string {
		const progress = feature.provisioning;
		if (!progress || progress.state === "ready") return "";
		const steps = progress.steps
			.map((step) => {
				const icon =
					step.status === "completed"
						? "✓"
						: step.status === "failed"
							? "!"
							: step.status === "running"
								? "…"
								: "·";
				return `<div class="lifecycle-step ${step.status}"><span class="lifecycle-step-icon">${icon}</span><span>${this.escapeHtml(step.label)}</span>${step.error ? `<small>${this.escapeHtml(step.error)}</small>` : ""}</div>`;
			})
			.join("");
		return `<section class="lifecycle-card ${progress.state === "failed" ? "failed" : ""}"><div class="lifecycle-card-title">${progress.state === "failed" ? "Feature setup failed" : "Preparing feature"}</div><div class="lifecycle-steps">${steps}</div>${progress.error ? `<p class="lifecycle-error">${this.escapeHtml(progress.error)}</p>` : ""}</section>`;
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
			? `<button id="agent-binding-badge-${agent.id}" class="agent-tool-badge ${bindingBadgeData.className}" title="${this.escapeHtml(bindingBadgeData.tooltip)}" onclick="event.stopPropagation(); attachProviderSession('${feature.id}', '${agent.id}')">⚠</button>`
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
		const startupProgress =
			agent.startup && agent.startup.state !== "ready"
				? `<div class="lifecycle-steps agent-startup-steps">${agent.startup.steps.map((step) => `<div class="lifecycle-step ${step.status}"><span class="lifecycle-step-icon">${step.status === "completed" ? "✓" : step.status === "failed" ? "!" : step.status === "running" ? "…" : "·"}</span><span>${this.escapeHtml(step.label)}</span></div>`).join("")}</div>`
				: "";

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
			<p class="section-help">Services are long-lived commands for the feature worktree (dev server, watcher or shell). They do not reason about the task and are separate from Agents.</p>
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
							? `<button class="quick-action-btn subtle" onclick="resumeFeature('${feature.id}')">Open</button>`
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
const _ICON_FOLDER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h12v4.49zm0-5.49h-12V3h4.29l.85.85.36.15H14v2z"/></svg>`;
const ICON_SERVER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2h9l.5.5v3l-.5.5h-9l-.5-.5v-3l.5-.5zm0 5h9l.5.5v3l-.5.5h-9l-.5-.5v-3l.5-.5zm0 5h9l.5.5v1l-.5.5h-9l-.5-.5v-1l.5-.5zM5 4h1V3H5v1zm0 5h1V8H5v1z"/></svg>`;
const ICON_PR = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7 3.28V12h1V3.28l2.35 2.36.71-.7L8 1.88l-.35.35L4.59 5.29l.7.71L7 3.28zM13.5 7.72V14H2.5V7.72h-1V14.5l.5.5h12l.5-.5V7.72h-1z"/></svg>`;
const _ICON_SYNC = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.71.71-1.34-1.34c-.04 1.53.5 2.93 1.53 3.96a5.55 5.55 0 0 0 3.92 1.63l.04 1a6.55 6.55 0 0 1-4.63-1.92 6.48 6.48 0 0 1-1.79-4.53zm12.2-.53l-.76-.01-2.09-2.12.71-.71 1.34 1.34c.04-1.53-.5-2.93-1.53-3.96a5.55 5.55 0 0 0-3.92-1.63l-.04-1a6.55 6.55 0 0 1 4.63 1.92 6.47 6.47 0 0 1 1.78 4.53l1.22-1.23.78.77-2.12 2.1z"/></svg>`;
