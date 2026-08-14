import * as vscode from "vscode";
import type { CodingToolRegistry } from "../agents/codingToolRegistry";
import {
	type AgentCardPresentation,
	presentAgentCard,
} from "../agents/observation/presentAgentCard";
import type { TerminalController } from "../agents/terminalController";
import { TERMINAL_COLOR_HEX } from "../constants/colors";
import {
	ICON_ADD_AGENT,
	ICON_ADD_SERVICE,
	ICON_CHEVRON_DOWN,
	ICON_CHEVRON_RIGHT,
	ICON_DELETE,
	ICON_GIT,
	ICON_RESTART,
	ICON_STOP,
} from "../constants/icons";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, Feature, Service } from "../types";
import { presentFeatureCockpit } from "./featureCockpitPresentation";
import type { FeatureSnapshot } from "./featureSnapshot";
import type { FeatureStateCoordinator } from "./featureStateCoordinator";

export class FeatureSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "agentSpace.features";
	private _view?: vscode.WebviewView;
	private _onVisibilityChange?: (visible: boolean) => void;
	private consumer?: { dispose: () => void };
	/**
	 * Monotonic counter stamped on every focus request. A cold reconciliation
	 * only reveals its terminal (and claims "focused"/"failed") if its stamp
	 * is still the latest, so a slower cold resolution can never steal focus
	 * from a newer click (e.g. A cold → B warm).
	 */
	private focusSequence = 0;

	private terminalController?: TerminalController;

	constructor(
		private readonly projectManager: ProjectManager,
		private readonly featureStateCoordinator: FeatureStateCoordinator,
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
		this.setConsumerVisible(webviewView.visible);
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "media", "webview"),
			],
		};
		webviewView.webview.html = this.getHtml();

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.setConsumerVisible(true);
				this.refreshState();
			} else {
				this.setConsumerVisible(false);
			}
			this._onVisibilityChange?.(webviewView.visible);
		});
		this.refreshState();

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
				case "stopService":
					this.handleStopService(message.featureId, message.serviceId);
					break;
				case "restartService":
					this.handleRestartService(message.featureId, message.serviceId);
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

	private setConsumerVisible(visible: boolean): void {
		if (visible) {
			this.consumer ??= this.featureStateCoordinator.acquireConsumer();
			return;
		}
		this.consumer?.dispose();
		this.consumer = undefined;
	}

	/** Full HTML rebuild — used for initial load and structural changes (feature create/delete). */
	refresh(): void {
		this.refreshAsync().catch(() => {});
	}

	/** Update live state without replacing the webview DOM or its local UI state. */
	refreshState(): void {
		this.sendUpdate().catch(() => {});
	}

	private async refreshAsync(): Promise<void> {
		try {
			if (!this._view) return;
			// The sidebar only needs lightweight presence/runtime facts to stay
			// live; deep Git/GitHub evidence is demand-driven per Project/Feature
			// focus, so this never blocks on (or triggers) a full deep reconcile.
			await this.featureStateCoordinator.reconcilePresence();

			if (this._view) {
				this._view.webview.html = this.getHtml();
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

			interface SidebarAgent {
				id: string;
				name: string;
				sessionTitle?: string;
				cardPresentation: AgentCardPresentation;
				status: string;
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
				statusLabel?: string;
				statusTone?: string;
				statusDetail?: string;
				isBase: boolean;
				agents: SidebarAgent[];
				services: SidebarService[];
				agentsKnown: boolean;
				servicesKnown: boolean;
			}
			interface SidebarProject {
				id: string;
				name: string;
				features: SidebarFeature[];
			}

			const projects: SidebarProject[] = contexts.map((ctx) => {
				const snapshots = this.featureStateCoordinator.getProjectSnapshots(
					ctx.project.id,
				);
				const features: SidebarFeature[] = snapshots.map((snapshot) => {
					const agents = this.snapshotAgents(snapshot);
					const services = this.snapshotServices(snapshot);
					const summary = snapshot.feature.id.startsWith("base:")
						? undefined
						: presentFeatureCockpit(
								snapshot,
								this.featureStateCoordinator.getProjectReferenceHealth(
									ctx.project.id,
								),
							).summary;
					return {
						id: snapshot.feature.id,
						branch: snapshot.feature.branch,
						statusLabel: summary?.label,
						statusTone: summary?.tone,
						statusDetail: summary?.detail,
						isBase: snapshot.feature.id.startsWith("base:"),
						agentsKnown: snapshot.runtime.agents.status === "known",
						servicesKnown: snapshot.runtime.services.status === "known",
						agents: agents.map((a) => ({
							cardPresentation: presentAgentCard(ctx.agentManager.observe(a)),
							id: a.id,
							name: a.name,
							sessionTitle: a.sessionTitle,
							status: a.status,
							toolId: a.toolId,
							lastError: a.lastError,
						})),
						services: services.map((s) => ({
							id: s.id,
							name: s.name,
							command: s.command,
							status: s.status,
						})),
					};
				});

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

		const agents = ctx.agentManager.getAgentsReadModel(featureId);
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
				.getAgentsReadModel(featureId)
				.find((a) => a.id === agentId);
			if (updatedAgent) {
				const agentIndex = ctx.agentManager
					.getAgentsReadModel(featureId)
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
		const agents = ctx.agentManager.getAgentsReadModel(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		const agentIndex = agents.indexOf(agent);

		const focusSeq = ++this.focusSequence;

		// Strict fast path: an already-tracked terminal is revealed with no
		// shell/process call of any kind before terminal.show(). This is the
		// hot path for switching between already-running agents.
		const existing = this.terminalController.getTerminal(agentId);
		if (existing) {
			existing.show();
			this.postAgentFocusState(agentId, "focused");
			return;
		}

		// Cold path: the VS Code terminal isn't tracked yet (e.g. right after
		// a window reload). Surface an immediate "opening" state and let
		// tmux/session reconciliation run asynchronously — it must never run
		// synchronously on this interactive click path.
		this.postAgentFocusState(agentId, "opening");
		void this.terminalController
			.focusOrCreateTerminalAsync(feature, agent, agentIndex, true)
			.then((terminal) => {
				if (focusSeq === this.focusSequence) {
					if (terminal) {
						// Still the latest focus request — reveal it. (A cold
						// terminal that is no longer current stays tracked but
						// unrevealed, so the next click is an instant warm
						// switch without ever stealing focus.)
						terminal.show();
						this.postAgentFocusState(agentId, "focused");
					} else {
						this.postAgentFocusState(agentId, "failed");
					}
				}
				this.refreshState();
			})
			.catch((error) => {
				console.warn(
					`[FeatureSidebarProvider] focusAgent reconciliation failed: ${error}`,
				);
				if (focusSeq === this.focusSequence) {
					this.postAgentFocusState(agentId, "failed");
				}
				this.refreshState();
			});
	}

	/** Best-effort UI hint for the sidebar's optimistic click feedback. */
	private postAgentFocusState(
		agentId: string,
		state: "opening" | "focused" | "failed",
	): void {
		if (!this._view) return;
		void this._view.webview
			.postMessage({ type: "agentFocusState", agentId, state })
			.then(undefined, () => {
				// Webview may be disposed mid-round-trip; best-effort only.
			});
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

	private getHtml(): string {
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
				<div class="empty-state">
					<div style="font-size: 24px; opacity: 0.3; margin-bottom: 8px;">Waiting for projects...</div>
					<p>No projects registered</p>
				</div>`;
		} else {
			const sections = contexts
				.map((ctx) => this.renderProjectSection(ctx))
				.join("");
			body = `
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
.binding-badge { margin-left: 6px; padding: 1px 5px; border-radius: 8px; font-size: 9px; font-weight: 600; white-space: nowrap; color: var(--vscode-descriptionForeground); background: var(--vscode-button-secondaryBackground); }
.binding-badge.binding-pending { opacity: .75; }
.binding-badge.binding-ambiguous { color: var(--vscode-notificationsWarningIcon-foreground); background: color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground) 14%, transparent); }
.binding-badge.binding-unverified { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); }
.binding-badge.binding-unsupported { opacity: .6; }
.project-open-btn { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 22px; height: 22px; margin-left: auto; padding: 0; border: 0; border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
.project-open-btn:hover { background: var(--vscode-button-hoverBackground); }
.agent-main-row { display: flex; align-items: center; min-width: 0; gap: 6px; }
.agent-session-title { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 9px; }
.agent-status { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.lifecycle-badge { color: var(--vscode-descriptionForeground); font-size: 9px; white-space: nowrap; }
.status-dot.primary-state-working { background-color: var(--vscode-testing-iconPassed); animation: pulse-green 2s ease-in-out infinite; }
.status-dot.primary-state-warning { background-color: var(--vscode-notificationsWarningIcon-foreground); }
.status-dot.primary-state-error { background-color: var(--vscode-errorForeground); }
.status-dot.primary-state-normal { background-color: var(--vscode-charts-blue, var(--vscode-focusBorder)); }
.status-dot.primary-state-muted { background-color: var(--vscode-disabledForeground); }
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

	private renderProjectSection(ctx: ProjectContext): string {
		const { project } = ctx;
		const snapshots = this.featureStateCoordinator.getProjectSnapshots(
			project.id,
		);
		const baseSnapshot = snapshots.find((snapshot) =>
			snapshot.feature.id.startsWith("base:"),
		);
		const baseCard = baseSnapshot ? this.renderBaseCard(baseSnapshot) : "";
		const featureCards = snapshots
			.filter((snapshot) => !snapshot.feature.id.startsWith("base:"))
			.map((snapshot) => this.renderFeatureCard(snapshot))
			.join("");

		return `
		<div class="project-section">
			<div class="project-header" onclick="toggleProject('${project.id}')">
				<span class="project-toggle" id="project-toggle-${project.id}">${ICON_CHEVRON_DOWN}</span>
				<button class="project-name project-nav-btn" title="Open ${this.escapeHtml(project.name)}" onclick="openProject(event, '${project.id}')">${this.escapeHtml(project.name)}</button>
				<button class="project-open-btn" onclick="openProject(event, '${project.id}')" title="Open project" aria-label="Open project">${ICON_CHEVRON_RIGHT}</button>
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

	dispose(): void {
		this.consumer?.dispose();
		this.consumer = undefined;
	}

	private renderBaseCard(snapshot: FeatureSnapshot): string {
		const feature = snapshot.feature as Feature;
		const agents = this.snapshotAgents(snapshot);
		const services = this.snapshotServices(snapshot);
		const totalCount =
			agents.filter((a) => a.status !== "done").length +
			services.filter((s) => s.status === "running").length;

		const bodyHtml = this.renderSnapshotCardBody(snapshot, agents, services);
		const count = this.snapshotRuntimeKnown(snapshot)
			? totalCount > 0
				? String(totalCount)
				: ""
			: "?";

		return `
		<div class="feature-card base-card" data-feature-id="${feature.id}" onclick="selectFeature('${feature.id}')">
			<div class="card-header" onclick="toggleFeatureCard(event, '${feature.id}')">
				<span class="card-chevron" id="card-chevron-${feature.id}">${ICON_CHEVRON_DOWN}</span>
				<span class="feature-name">${this.escapeHtml(feature.branch)}</span>
				<span class="base-label">base</span>
				<span class="collapse-count" id="collapse-count-${feature.id}">${count}</span>
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

	private renderFeatureCard(snapshot: FeatureSnapshot): string {
		const feature = snapshot.feature as Feature;
		const agents = this.snapshotAgents(snapshot);
		const services = this.snapshotServices(snapshot);
		const totalCount =
			agents.filter((a) => a.status !== "done").length +
			services.filter((s) => s.status === "running").length;

		const summary = presentFeatureCockpit(
			snapshot,
			this.featureStateCoordinator.getProjectReferenceHealth(
				snapshot.projectId,
			),
		).summary;
		const bodyHtml = this.renderSnapshotCardBody(snapshot, agents, services);
		const count = this.snapshotRuntimeKnown(snapshot)
			? totalCount > 0
				? String(totalCount)
				: ""
			: "?";

		return `
		<div class="feature-card" data-feature-id="${feature.id}" onclick="selectFeature('${feature.id}')">
			<div class="card-header" onclick="toggleFeatureCard(event, '${feature.id}')">
				<span class="card-chevron" id="card-chevron-${feature.id}">${ICON_CHEVRON_DOWN}</span>
				<span class="feature-name">${this.escapeHtml(feature.branch)}</span>
				<span class="status-badge status-${summary.tone}" data-status-badge="${feature.id}" title="${this.escapeHtml(summary.detail ?? summary.label)}">${this.escapeHtml(summary.label)}</span>
				<span class="collapse-count" id="collapse-count-${feature.id}">${count}</span>
				<button class="delete-btn" onclick="deleteFeature(event, '${feature.id}')" title="Finish Feature">${ICON_DELETE}</button>
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

	private snapshotRuntimeKnown(snapshot: FeatureSnapshot): boolean {
		return (
			snapshot.runtime.agents.status === "known" &&
			snapshot.runtime.services.status === "known"
		);
	}

	private renderSnapshotCardBody(
		snapshot: FeatureSnapshot,
		agents: Agent[],
		services: Service[],
	): string {
		const feature = snapshot.feature as Feature;
		const agentsHtml =
			snapshot.runtime.agents.status === "known"
				? this.renderAgentsSection(feature, agents)
				: '<div class="empty-placeholder">Agent runtime unavailable</div>';
		const servicesHtml =
			snapshot.runtime.services.status === "known"
				? this.renderServicesSection(feature, services)
				: '<div class="empty-placeholder">Service runtime unavailable</div>';
		return `${agentsHtml}${servicesHtml}`;
	}

	private renderAgentsSection(feature: Feature, agents: Agent[]): string {
		const activeAgents = agents.filter((a) => a.status !== "done");
		const doneAgents = agents.filter((a) => a.status === "done");

		const renderAgentCard = (a: Agent, i: number) => {
			const tool = this.toolRegistry.resolveAgentTool(a.toolId);
			const toolLabel = ` &middot; ${this.escapeHtml(tool.name)}`;
			const agentColor = TERMINAL_COLOR_HEX[i % TERMINAL_COLOR_HEX.length];
			const observation = this.projectManager
				.findContextByFeatureId(feature.id)
				?.agentManager.observe(a) ?? {
				identity: { agentName: a.name },
				lifecycle: { state: a.status, source: "agentspace" },
				attention: {
					state:
						a.attentionStatus === "done"
							? "unknown"
							: (a.attentionStatus ?? "unknown"),
					reason: a.attentionReason,
				},
				session: {
					state: a.sessionBinding?.state ?? "pending",
					detail: a.sessionBinding?.detail,
				},
			};
			const card = presentAgentCard(observation);
			const presented = card.primaryState;
			const errorNote = a.lastError
				? `<div class="agent-error-note" title="${this.escapeHtml(a.lastError)}">${this.escapeHtml(a.lastError)}</div>`
				: "";

			return `
		<div class="agent-card ${a.status}" data-agent-id="${a.id}"
			onclick="focusAgent(event, '${feature.id}', '${a.id}')"
			oncontextmenu="showAgentMenu(event, '${feature.id}', '${a.id}')">
            <div class="agent-color-bar" style="background-color: ${agentColor}"></div>
			<div class="status-dot primary-state-${presented.tone}" data-attention-dot="${a.id}"></div>
			<div class="agent-copy">
				<div class="agent-main-row">
					<span class="agent-name" title="${this.escapeHtml(card.name)}">${this.escapeHtml(card.name)}<span class="agent-tool">${toolLabel}</span></span>
					${card.secondaryTitle ? `<span class="agent-session-title" title="${this.escapeHtml(card.secondaryTitle)}">${this.escapeHtml(card.secondaryTitle)}</span>` : ""}
					<span class="agent-status">
						<span class="lifecycle-badge primary-state-${presented.tone}" data-lifecycle-badge="${a.id}" title="${this.escapeHtml(presented.detail ?? "")}">${presented.label}</span>
					</span>
				</div>
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
					const presented = presentAgentCard(
						this.projectManager
							.findContextByFeatureId(feature.id)
							?.agentManager.observe(a) ?? {
							identity: { agentName: a.name },
							lifecycle: { state: a.status, source: "agentspace" },
							attention: { state: "unknown" },
							session: { state: "pending" },
						},
					).primaryState;
					return `
		<div class="agent-card done" data-agent-id="${a.id}" oncontextmenu="showAgentMenu(event, '${feature.id}', '${a.id}')">
            <div class="agent-color-bar" style="background-color: ${agentColor}"></div>
            <div class="status-dot done" data-attention-dot="${a.id}"></div>
			<div class="agent-copy">
				<div class="agent-main-row">
					<span class="agent-name">${this.escapeHtml(a.name)}</span>
					<span class="agent-status">
						<span class="lifecycle-badge primary-state-${presented.tone}" data-lifecycle-badge="${a.id}">${presented.label}</span>
					</span>
				</div>
			</div>
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
