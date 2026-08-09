import * as vscode from "vscode";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import { presentAgentState } from "../agents/observation/presentAgentState";
import type { TerminalController } from "../agents/terminalController";
import { ICON_CHEVRON_DOWN } from "../constants/icons";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { GitAwareStatus } from "../types";

function _gitStatusLabel(status: GitAwareStatus): string {
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

export class FeatureSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "agentSpace.features";
	private _view?: vscode.WebviewView;
	private _onVisibilityChange?: (visible: boolean) => void;
	private _pollingTimer?: ReturnType<typeof setInterval>;

	private terminalController?: TerminalController;

	constructor(
		private readonly projectManager: ProjectManager,
		readonly _toolRegistry: CodingToolRegistry,
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
				case "openHome":
					run("agentSpace.openHome");
					break;
				case "openProject":
					run("agentSpace.openProject", message.projectId);
					break;
				case "openProjectSettings":
					run("agentSpace.openProjectSettings", message.projectId);
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
				case "attachProviderSession":
					run(
						"agentSpace.attachProviderSession",
						message.featureId,
						message.agentId,
					);
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

	startPolling(): void {
		this.stopPolling();
		this.refresh();
		this._pollingTimer = setInterval(() => {
			this.refresh();
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

		const sections = contexts
			.map((ctx) => this.renderProjectSection(ctx, statusMap))
			.join("");
		const body = `
			<button class="agent-space-home" onclick="send('openHome')">Agent Space</button>
			<div class="sidebar-section-label">Projects</div>
			${sections || '<div class="empty-state"><p>No projects registered</p></div>'}
			<button class="sidebar-add-project" onclick="send('addProject')">+ Add project</button>`;

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
.binding-badge { margin-left: 6px; padding: 1px 5px; border-radius: 8px; font-size: 9px; font-weight: 600; white-space: nowrap; color: var(--vscode-descriptionForeground); background: var(--vscode-button-secondaryBackground); }
.binding-badge.binding-pending { opacity: .75; }
.binding-badge.binding-ambiguous { color: var(--vscode-notificationsWarningIcon-foreground); background: color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 14%, transparent); }
.binding-badge.binding-unverified { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); }
.binding-badge.binding-unsupported { opacity: .6; }
.agent-main-row { display: flex; align-items: center; min-width: 0; gap: 6px; }
.agent-session-title { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 9px; }
.agent-status { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.lifecycle-badge { color: var(--vscode-descriptionForeground); font-size: 9px; white-space: nowrap; }
.status-dot.primary-state-working { background-color: var(--vscode-testing-iconPassed); animation: pulse-green 2s ease-in-out infinite; }
.status-dot.primary-state-warning { background-color: var(--vscode-notificationsWarningIcon-foreground); }
.status-dot.primary-state-error { background-color: var(--vscode-errorForeground); }
.status-dot.primary-state-normal, .status-dot.primary-state-muted { background-color: var(--vscode-disabledForeground); }
</style>
</head>
<body>
	${body}
		<script src="${jsUri}"></script>
</body>
</html>`;
	}

	private renderProjectSection(
		ctx: ProjectContext,
		_statusMap?: Map<string, import("../types").GitAwareStatus>,
	): string {
		const { project } = ctx;
		const baseFeature = ctx.featureManager.getBaseFeature(project.id);
		const features = [baseFeature, ...ctx.featureManager.getFeatures()];
		const featureRows = features
			.map((feature) => {
				const agents = ctx.agentManager.getAgents(feature.id);
				const presented = agents.map((agent) =>
					presentAgentState(ctx.agentManager.observe(agent)),
				);
				const waiting = presented.some((state) => state.label === "Needs you");
				const active = presented.some((state) =>
					["Working", "Running", "Idle", "Starting"].includes(state.label),
				);
				const degraded = presented.some((state) =>
					["Error", "Failed", "Unknown"].includes(state.label),
				);
				const state =
					feature.id === baseFeature.id
						? "BASE"
						: waiting
							? "WAITING"
							: active
								? "ACTIVE"
								: degraded
									? "DEGRADED"
									: feature.status === "done"
										? "DONE"
										: "IDLE";
				const stateClass = state.toLowerCase();
				return `<button class="sidebar-feature-row" onclick="selectFeature('${feature.id}')">
				<span class="sidebar-feature-name" title="${this.escapeHtml(feature.branch)}">${this.escapeHtml(feature.branch)}</span>
				<span class="sidebar-feature-state ${stateClass}">${state}</span>
			</button>`;
			})
			.join("");

		return `
		<div class="project-section">
			<div class="project-header" onclick="toggleProject('${project.id}')">
				<span class="project-toggle" id="project-toggle-${project.id}">${ICON_CHEVRON_DOWN}</span>
				<button class="project-name project-nav-btn" onclick="openProject(event, '${project.id}')">${this.escapeHtml(project.name)}</button>
				<button class="project-settings-btn" onclick="openProjectSettings(event, '${project.id}')" title="Project settings">⚙</button>
			</div>
			<div class="project-body" id="project-body-${project.id}">
				${featureRows || '<div class="empty-placeholder">No features yet</div>'}
			</div>
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
