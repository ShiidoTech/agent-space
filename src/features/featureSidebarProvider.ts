import * as vscode from "vscode";
import type { AgentManager } from "../agents/agentManager";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import type { TerminalController } from "../agents/terminalController";
import { TERMINAL_COLOR_HEX } from "../constants/colors";
import {
	ICON_ADD_AGENT,
	ICON_ADD_SERVICE,
	ICON_CHEVRON_DOWN,
	ICON_CHEVRON_RIGHT,
	ICON_DELETE,
	ICON_GIT,
	ICON_REMOVE,
	ICON_RESTART,
	ICON_STOP,
	ICON_SYNC,
} from "../constants/icons";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { ServiceManager } from "../services/serviceManager";
import type {
	Agent,
	AgentAttentionStatus,
	Feature,
	GitAwareStatus,
	Service,
} from "../types";
import type { FeatureManager } from "./featureManager";

function gitStatusLabel(status: GitAwareStatus): string {
	switch (status) {
		case "new":
			return "New";
		case "modified":
			return "Modified";
		case "ahead":
			return "Ahead";
		case "merged":
			return "Merged";
	}
}

function attentionStatusLabel(status: AgentAttentionStatus): string {
	switch (status) {
		case "working":
			return "Working";
		case "waiting_for_user":
			return "Waiting for you";
		case "idle":
			return "Idle";
		case "failed":
			return "Failed";
		case "done":
			return "Done";
		case "unknown":
			return "Unknown";
	}
}

export class FeatureSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "agentSpace.features";
	private _view?: vscode.WebviewView;
	private _onVisibilityChange?: (visible: boolean) => void;
	private _pollingTimer?: ReturnType<typeof setInterval>;

	private terminalController?: TerminalController;

	constructor(
		private readonly projectManager: ProjectManager,
		private readonly toolRegistry: CodingToolRegistry,
		_prerequisites: unknown,
		private readonly extensionUri: vscode.Uri,
	) {}

	setTerminalController(controller: TerminalController): void {
		this.terminalController = controller;
	}

	onVisibilityChange(callback: (visible: boolean) => void): void {
		this._onVisibilityChange = callback;
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "media", "webview"),
			],
		};
		webviewView.webview.html = this.getHtml();

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.startPolling();
			} else {
				this.stopPolling();
			}
			this._onVisibilityChange?.(webviewView.visible);
		});
		this.startPolling();

		webviewView.webview.onDidReceiveMessage((message) => {
			const run = (cmd: string, ...args: unknown[]) => {
				vscode.commands.executeCommand(cmd, ...args).then(undefined, () => {});
			};
			switch (message.command) {
				case "selectFeature":
					run("agentSpace.selectFeature", message.featureId);
					break;
				case "newFeature":
					run("agentSpace.newFeature", message.projectId);
					break;
				case "addAgent":
					run("agentSpace.addAgent", message.featureId);
					break;
				case "deleteFeature":
					run("agentSpace.deleteFeature", message.featureId);
					break;
				case "createPR":
					run("agentSpace.createPR", message.featureId);
					break;
				case "closeAgent":
					run("agentSpace.closeAgent", message.featureId, message.agentId);
					break;
				case "renameAgent":
					this.handleRenameAgent(message.featureId, message.agentId);
					break;
				case "toggleIsolation":
					run("agentSpace.toggleIsolation", message.featureId);
					break;
				case "addProject":
					run("agentSpace.addProject");
					break;
				case "removeProject":
					run("agentSpace.removeProject");
					break;
				case "addService":
					run("agentSpace.addService", message.featureId);
					break;
				case "syncNames":
					run("agentSpace.syncSessionNames");
					break;
				case "stopService":
					this.handleStopService(message.featureId, message.serviceId);
					break;
				case "restartService":
					this.handleRestartService(message.featureId, message.serviceId);
					break;
				case "reopenAgent":
					run("agentSpace.reopenAgent", message.featureId, message.agentId);
					break;
				case "deleteAgent":
					run("agentSpace.deleteAgent", message.featureId, message.agentId);
					break;
				case "focusAgent":
					this.handleFocusAgent(message.featureId, message.agentId);
					break;
				case "focusService":
					this.handleFocusService(message.featureId, message.serviceId);
					break;
				case "openWorkspace":
					run("agentSpace.openWorkspace", message.featureId);
					break;
				case "openGitView":
					run("agentSpace.openFeatureGitView", message.featureId);
					break;
				case "requestFullRefresh":
					this.refresh();
					break;
			}
		});
	}

	/** Full HTML rebuild — used for initial load and structural changes (feature create/delete). */
	refresh(): void {
		this.refreshAsync().catch(() => {});
	}

	private async refreshAsync(): Promise<void> {
		try {
			if (!this._view) return;

			// Pre-compute all git statuses in parallel
			const contexts = this.projectManager.getAllContexts();
			const statusMap = new Map<string, import("../types").GitAwareStatus>();

			const tasks: Promise<void>[] = [];
			for (const ctx of contexts) {
				for (const feature of ctx.featureManager.getFeatures()) {
					tasks.push(
						ctx.featureManager
							.getFeatureGitStatusAsync(feature)
							.then((status) => {
								statusMap.set(feature.id, status);
							}),
					);
				}
			}
			await Promise.all(tasks);

			if (this._view) {
				this._view.webview.html = this.getHtml(statusMap);
			}
		} catch {
			// Webview may have been disposed; swallow to prevent cascade
		}
	}

	/** Lightweight incremental update — sends JSON data via postMessage so the webview
	 *  can update DOM in-place without rebuilding the entire HTML tree. */
	private async sendUpdate(): Promise<void> {
		try {
			if (!this._view?.webview) return;

			const contexts = this.projectManager.getAllContexts();
			const statusMap = new Map<string, import("../types").GitAwareStatus>();

			const asyncTasks: Promise<void>[] = [];
			for (const ctx of contexts) {
				for (const feature of ctx.featureManager.getFeatures()) {
					asyncTasks.push(
						ctx.featureManager.getFeatureGitStatusAsync(feature).then((s) => {
							statusMap.set(feature.id, s);
						}),
					);
				}
			}
			await Promise.all(asyncTasks);

			interface SidebarAgent {
				id: string;
				name: string;
				status: string;
				attentionStatus?: AgentAttentionStatus;
				attentionReason?: string;
				toolId?: string;
				lastError?: string;
			}
			interface SidebarService {
				id: string;
				name: string;
				command: string;
				status: string;
			}
			interface SidebarFeature {
				id: string;
				branch: string;
				gitStatus?: string;
				isBase: boolean;
				agents: SidebarAgent[];
				services: SidebarService[];
			}
			interface SidebarProject {
				id: string;
				name: string;
				features: SidebarFeature[];
			}

			const projects: SidebarProject[] = contexts.map((ctx) => {
				const baseFeature = ctx.featureManager.getBaseFeature(ctx.project.id);
				const baseAgents = ctx.agentManager.getAgents(baseFeature.id);
				const baseServices = ctx.serviceManager.getServices(baseFeature.id);

				const features: SidebarFeature[] = [
					{
						id: baseFeature.id,
						branch: baseFeature.branch,
						isBase: true,
						agents: baseAgents.map((a) => ({
							id: a.id,
							name: a.name,
							status: a.status,
							attentionStatus: a.attentionStatus,
							attentionReason: a.attentionReason,
							toolId: a.toolId,
							lastError: a.lastError,
						})),
						services: baseServices.map((s) => ({
							id: s.id,
							name: s.name,
							command: s.command,
							status: s.status,
						})),
					},
				];

				for (const feature of ctx.featureManager.getFeatures()) {
					const agents = ctx.agentManager.getAgents(feature.id);
					const services = ctx.serviceManager.getServices(feature.id);
					features.push({
						id: feature.id,
						branch: feature.branch,
						gitStatus: statusMap.get(feature.id),
						isBase: false,
						agents: agents.map((a) => ({
							id: a.id,
							name: a.name,
							status: a.status,
							attentionStatus: a.attentionStatus,
							attentionReason: a.attentionReason,
							toolId: a.toolId,
							lastError: a.lastError,
						})),
						services: services.map((s) => ({
							id: s.id,
							name: s.name,
							command: s.command,
							status: s.status,
						})),
					});
				}

				return { id: ctx.project.id, name: ctx.project.name, features };
			});

			this._view.webview.postMessage({
				type: "sidebarUpdate",
				data: { projects },
			});
		} catch {
			// Webview may have been disposed
		}
	}

	startPolling(): void {
		this.stopPolling();
		this.sendUpdate().catch(() => {});
		this._pollingTimer = setInterval(() => {
			this.sendUpdate().catch(() => {});
		}, 15_000);
	}

	stopPolling(): void {
		if (this._pollingTimer) {
			clearInterval(this._pollingTimer);
			this._pollingTimer = undefined;
		}
	}

	dispose(): void {
		this.stopPolling();
	}

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

	private async handleRenameAgent(
		featureId: string,
		agentId: string,
	): Promise<void> {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;

		const agents = ctx.agentManager.getAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;

		const newName = await vscode.window.showInputBox({
			prompt: "Rename agent",
			value: agent.name,
			validateInput: (v) => (v.trim() ? undefined : "Name is required"),
		});
		if (!newName) return;

		ctx.agentManager.renameAgent(agentId, featureId, newName.trim());

		// Re-create the VS Code terminal tab with the new name
		const resolved = this.projectManager.resolveFeature(featureId);
		if (this.terminalController && resolved) {
			const updatedAgent = ctx.agentManager
				.getAgents(featureId)
				.find((a) => a.id === agentId);
			if (updatedAgent) {
				const agentIndex = ctx.agentManager
					.getAgents(featureId)
					.findIndex((a) => a.id === agentId);
				this.terminalController.renameTerminal(
					resolved.feature,
					updatedAgent,
					agentIndex,
				);
			}
		}

		this.projectManager.notifyChange();
	}

	private handleFocusAgent(featureId: string, agentId: string): void {
		if (!this.terminalController) return;
		const resolved = this.projectManager.resolveFeature(featureId);
		if (!resolved) return;
		const { ctx, feature } = resolved;
		const agents = ctx.agentManager.getAgents(featureId);
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

	private handleFocusService(featureId: string, serviceId: string): void {
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

	private getHtml(
		statusMap?: Map<string, import("../types").GitAwareStatus>,
	): string {
		const webview = this._view?.webview;
		if (!webview) return "";
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "sidebar.css"),
		);
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "webview", "sidebar.js"),
		);

		const contexts = this.projectManager.getAllContexts();

		let body: string;
		if (contexts.length === 0) {
			body = `
				<button class="btn-secondary" onclick="send('addProject')">Add Project</button>
				<div class="empty-state">
					<div style="font-size: 24px; opacity: 0.3; margin-bottom: 8px;">Waiting for projects...</div>
					<p>No projects registered</p>
					<button class="btn-primary" onclick="send('addProject')">Add Project</button>
				</div>`;
		} else {
			const sections = contexts
				.map((ctx) => this.renderProjectSection(ctx, statusMap))
				.join("");
			body = `
				<button class="btn-secondary" onclick="send('addProject')">Add Project</button>
				${sections}`;
		}

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<style>
.attention-badge { margin-left: 6px; padding: 1px 5px; border-radius: 8px; font-size: 9px; font-weight: 600; white-space: nowrap; color: var(--vscode-descriptionForeground); background: var(--vscode-button-secondaryBackground); }
.attention-badge.attention-working { color: var(--vscode-testing-iconPassed); }
.attention-badge.attention-waiting_for_user { color: var(--vscode-notificationsWarningIcon-foreground); background: color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 14%, transparent); }
.attention-badge.attention-failed { color: var(--vscode-errorForeground); }
.status-dot.working { background-color: var(--vscode-testing-iconPassed); animation: pulse-green 2s ease-in-out infinite; }
.status-dot.waiting_for_user { background-color: var(--vscode-notificationsWarningIcon-foreground); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 18%, transparent); }
.status-dot.failed { background-color: var(--vscode-errorForeground); }
.status-dot.idle, .status-dot.unknown { background-color: var(--vscode-disabledForeground); }
.status-dot.done { background-color: var(--vscode-disabledForeground); opacity: .5; }
</style>
</head>
<body>
	${body}
	<div id="agentContextMenu" class="context-menu">
		<button class="context-menu-item" id="menuRename">Rename Agent</button>
        <div class="context-separator"></div>
		<button class="context-menu-item" id="menuMarkDone">Mark as Done</button>
		<button class="context-menu-item menu-danger" id="menuDeleteAgent">Delete Agent</button>
	</div>
	<script src="${jsUri}"></script>
</body>
</html>`;
	}

	private renderProjectSection(
		ctx: ProjectContext,
		statusMap?: Map<string, import("../types").GitAwareStatus>,
	): string {
		const { project } = ctx;
		const baseFeature = ctx.featureManager.getBaseFeature(project.id);
		const baseCard = this.renderBaseCard(
			baseFeature,
			ctx.agentManager,
			ctx.serviceManager,
		);

		const features = ctx.featureManager.getFeatures();
		const featureCards = features
			.map((f) =>
				this.renderFeatureCard(
					f,
					ctx.agentManager,
					ctx.serviceManager,
					ctx.featureManager,
					statusMap,
				),
			)
			.join("");

		return `
		<div class="project-section">
			<div class="project-header" onclick="toggleProject('${project.id}')">
				<span class="project-toggle" id="project-toggle-${project.id}">${ICON_CHEVRON_DOWN}</span>
				<span class="project-name">${this.escapeHtml(project.name)}</span>
				<span class="project-path" title="${this.escapeHtml(project.repoPath)}">${this.escapeHtml(project.repoPath)}</span>
				<button class="project-remove-btn" onclick="removeProject(event)" title="Remove Project">${ICON_REMOVE}</button>
			</div>
			<div class="project-body" id="project-body-${project.id}">
				<button class="btn-primary" onclick="newFeature(event, '${project.id}')">
                    <span>+</span> New Feature
                </button>
				${baseCard}
				${featureCards || '<div class="empty-placeholder">No features yet</div>'}
			</div>
		</div>`;
	}

	private renderBaseCard(
		feature: Feature,
		agentManager: AgentManager,
		serviceManager: ServiceManager,
	): string {
		const agents = agentManager.getAgents(feature.id);
		const services = serviceManager.getServices(feature.id);
		const totalCount =
			agents.filter((a) => a.status !== "done").length +
			services.filter((s) => s.status === "running").length;

		const bodyHtml = this.renderCardBody(feature, agents, services);

		return `
		<div class="feature-card base-card" data-feature-id="${feature.id}" onclick="selectFeature('${feature.id}')">
			<div class="card-header" onclick="toggleFeatureCard(event, '${feature.id}')">
				<span class="card-chevron" id="card-chevron-${feature.id}">${ICON_CHEVRON_DOWN}</span>
				<span class="feature-name">${this.escapeHtml(feature.branch)}</span>
				<span class="base-label">base</span>
				<span class="collapse-count" id="collapse-count-${feature.id}">${totalCount > 0 ? totalCount : ""}</span>
			</div>
			<div class="feature-card-body" id="card-body-${feature.id}">
				${bodyHtml}
				<div class="feature-quick-actions">
					<button class="action-btn" onclick="addAgent(event, '${feature.id}')" title="Add Agent">${ICON_ADD_AGENT}</button>
					<button class="action-btn" onclick="addService(event, '${feature.id}')" title="Add Service">${ICON_ADD_SERVICE}</button>
					<button class="action-btn" onclick="openGitView(event, '${feature.id}')" title="Open Workspace">${ICON_GIT}</button>
				</div>
			</div>
		</div>`;
	}

	private renderFeatureCard(
		feature: Feature,
		agentManager: AgentManager,
		serviceManager: ServiceManager,
		featureManager: FeatureManager,
		statusMap?: Map<string, import("../types").GitAwareStatus>,
	): string {
		const agents = agentManager.getAgents(feature.id);
		const services = serviceManager.getServices(feature.id);
		const totalCount =
			agents.filter((a) => a.status !== "done").length +
			services.filter((s) => s.status === "running").length;

		const gitStatus =
			statusMap?.get(feature.id) ?? featureManager.getFeatureGitStatus(feature);
		const bodyHtml = this.renderCardBody(feature, agents, services);

		return `
		<div class="feature-card" data-feature-id="${feature.id}" onclick="selectFeature('${feature.id}')">
			<div class="card-header" onclick="toggleFeatureCard(event, '${feature.id}')">
				<span class="card-chevron" id="card-chevron-${feature.id}">${ICON_CHEVRON_DOWN}</span>
				<span class="feature-name">${this.escapeHtml(feature.branch)}</span>
				<span class="status-badge status-${gitStatus}" data-status-badge="${feature.id}">${gitStatusLabel(gitStatus)}</span>
				<span class="collapse-count" id="collapse-count-${feature.id}">${totalCount > 0 ? totalCount : ""}</span>
				<button class="delete-btn" onclick="deleteFeature(event, '${feature.id}')" title="Delete Feature">${ICON_DELETE}</button>
			</div>
			<div class="feature-card-body" id="card-body-${feature.id}">
				${bodyHtml}
				<div class="feature-quick-actions">
					<button class="action-btn" onclick="addAgent(event, '${feature.id}')" title="Add Agent">${ICON_ADD_AGENT}</button>
					<button class="action-btn" onclick="addService(event, '${feature.id}')" title="Add Service">${ICON_ADD_SERVICE}</button>
					<button class="action-btn" onclick="openGitView(event, '${feature.id}')" title="Open Workspace">${ICON_GIT}</button>
				</div>
			</div>
		</div>`;
	}

	private renderCardBody(
		feature: Feature,
		agents: Agent[],
		services: Service[],
	): string {
		const agentsHtml = this.renderAgentsSection(feature, agents);
		const servicesHtml = this.renderServicesSection(feature, services);
		return `${agentsHtml}${servicesHtml}`;
	}

	private renderAgentsSection(feature: Feature, agents: Agent[]): string {
		const defaultToolId = this.toolRegistry.getDefaultToolId();

		const activeAgents = agents.filter((a) => a.status !== "done");
		const doneAgents = agents.filter((a) => a.status === "done");

		const renderAttentionBadge = (a: Agent) => {
			const attention = a.attentionStatus ?? "unknown";
			const reason = a.attentionReason ?? "No current attention evidence";
			return `<span class="attention-badge attention-${attention}" data-attention-badge="${a.id}" title="${this.escapeHtml(reason)}">${attentionStatusLabel(attention)}</span>`;
		};

		const renderAgentCard = (a: Agent, i: number) => {
			const tool = this.toolRegistry.resolveAgentTool(a.toolId);
			const toolLabel =
				tool.id !== defaultToolId
					? ` &middot; ${this.escapeHtml(tool.name)}`
					: "";
			const agentColor = TERMINAL_COLOR_HEX[i % TERMINAL_COLOR_HEX.length];
			const attention = a.attentionStatus ?? "unknown";
			const errorNote = a.lastError
				? `<div class="agent-error-note" title="${this.escapeHtml(a.lastError)}">${this.escapeHtml(a.lastError)}</div>`
				: "";

			return `
		<div class="agent-card ${a.status}" data-agent-id="${a.id}"
			onclick="focusAgent(event, '${feature.id}', '${a.id}')"
			oncontextmenu="showAgentMenu(event, '${feature.id}', '${a.id}')">
            <div class="agent-color-bar" style="background-color: ${agentColor}"></div>
            <div class="status-dot ${attention}" data-attention-dot="${a.id}"></div>
			<div class="agent-copy">
				<span class="agent-name" title="${this.escapeHtml(a.name)}">${this.escapeHtml(a.name)}<span class="agent-tool">${toolLabel}</span>${renderAttentionBadge(a)}</span>
				${errorNote}
			</div>
		</div>`;
		};

		const activeCards = activeAgents
			.map((a) => renderAgentCard(a, agents.indexOf(a)))
			.join("");

		let disabledHtml = "";
		if (doneAgents.length > 0) {
			const doneCards = doneAgents
				.map((a) => {
					const i = agents.indexOf(a);
					const agentColor = TERMINAL_COLOR_HEX[i % TERMINAL_COLOR_HEX.length];
					return `
		<div class="agent-card done" data-agent-id="${a.id}" oncontextmenu="showAgentMenu(event, '${feature.id}', '${a.id}')">
            <div class="agent-color-bar" style="background-color: ${agentColor}"></div>
            <div class="status-dot done" data-attention-dot="${a.id}"></div>
			<span class="agent-name">${this.escapeHtml(a.name)}${renderAttentionBadge(a)}</span>
			<button class="action-btn" onclick="reopenAgent(event, '${feature.id}', '${a.id}')" title="Re-enable agent">${ICON_RESTART}</button>
			<button class="action-btn agent-delete-btn" onclick="deleteAgent(event, '${feature.id}', '${a.id}')" title="Delete agent">${ICON_DELETE}</button>
		</div>`;
				})
				.join("");

			disabledHtml = `
		<div class="disabled-header collapsed" onclick="toggleDisabled(event, '${feature.id}')">
			<span class="disabled-icon" id="disabled-toggle-${feature.id}">${ICON_CHEVRON_RIGHT}</span>
			<span>${doneAgents.length} finished</span>
		</div>
		<div class="disabled-list collapsed" id="disabled-list-${feature.id}">
			${doneCards}
		</div>`;
		}

		return `
    <div class="section-header">
        <span class="section-label">Agents</span>
        ${activeAgents.length > 0 ? `<span class="agent-count">${activeAgents.length}</span>` : ""}
        <button class="action-btn sync-btn" onclick="syncNames(event)" title="Sync Names">${ICON_SYNC}</button>
    </div>
	<div class="agent-list">
        ${activeCards || '<div class="empty-placeholder">Click + to add an agent</div>'}
    </div>
	${disabledHtml}`;
	}

	private renderServicesSection(feature: Feature, services: Service[]): string {
		if (services.length === 0) return "";

		const activeServices = services.filter((s) => s.status === "running");
		const stoppedServices = services.filter((s) => s.status !== "running");

		const renderServiceCard = (s: Service) => `
			<div class="service-card ${s.status}" data-service-id="${s.id}" onclick="focusService(event, '${feature.id}', '${s.id}')">
				<div class="service-header">
					<span class="service-name" title="${this.escapeHtml(s.command)}">${this.escapeHtml(s.name)}</span>
                    <div class="service-actions">
                        ${
													s.status === "running"
														? `<button class="action-btn" onclick="stopService(event, '${feature.id}', '${s.id}')" title="Stop">${ICON_STOP}</button>`
														: `<button class="action-btn" onclick="restartService(event, '${feature.id}', '${s.id}')" title="Start">${ICON_RESTART}</button>`
												}
                    </div>
				</div>
				<div class="service-command">${this.escapeHtml(s.command)}</div>
			</div>`;

		const activeServiceCards = activeServices.map(renderServiceCard).join("");

		let stoppedServicesHtml = "";
		if (stoppedServices.length > 0) {
			const stoppedCards = stoppedServices.map(renderServiceCard).join("");
			stoppedServicesHtml = `
		<div class="disabled-header collapsed" onclick="toggleStoppedServices(event, '${feature.id}')">
			<span class="disabled-icon" id="stopped-svc-toggle-${feature.id}">${ICON_CHEVRON_RIGHT}</span>
			<span>${stoppedServices.length} stopped</span>
		</div>
		<div class="disabled-list collapsed" id="stopped-svc-list-${feature.id}">
			${stoppedCards}
		</div>`;
		}

		return `
		<div class="services-section">
			<div class="section-header"><span class="section-label">Services</span></div>
			<div class="service-list">${activeServiceCards || '<div class="empty-placeholder">No running services</div>'}</div>
			${stoppedServicesHtml}
		</div>`;
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
