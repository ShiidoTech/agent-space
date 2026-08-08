import * as vscode from "vscode";
import { getThemeColors } from "../constants/colors";
import type { ProjectManager } from "../projects/projectManager";
import type { Agent, Feature, Service } from "../types";
import { exec, getTerminalShellArgs } from "../utils/platform";
import type { CodingToolRegistry } from "./codingToolRegistry";
import { isOpenCodeFamily } from "./codingToolRegistry";
import {
	claimNewestSessionIdForDirectory,
	sessionIdsForDirectory,
} from "./sessionProviders/openCodeSessionProvider";
import type { TmuxIntegration } from "./tmux";

const AGENT_COLORS = getThemeColors();

interface TerminalMetadata {
	id: string;
	kind: "agent" | "service";
	featureId?: string;
	sessionName: string;
}

export class TerminalController implements vscode.Disposable {
	private terminals = new Map<string, vscode.Terminal>();
	private terminalMetadata = new Map<vscode.Terminal, TerminalMetadata>();
	private disposables: vscode.Disposable[] = [];
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private sessionDiscoveredCallback?: () => void;

	constructor(
		private readonly projectManager: ProjectManager,
		private readonly tmux: TmuxIntegration,
		private readonly toolRegistry: CodingToolRegistry,
	) {
		this.disposables.push(
			vscode.window.onDidCloseTerminal((terminal) => {
				const metadata = this.terminalMetadata.get(terminal);
				if (!metadata) {
					return;
				}

				this.terminalMetadata.delete(terminal);
				this.terminals.delete(metadata.id);

				if (metadata.kind === "agent" && metadata.featureId) {
					this.handleUnexpectedAgentClose(metadata);
				}
			}),
		);
	}

	onSessionDiscovered(callback: () => void): void {
		this.sessionDiscoveredCallback = callback;
	}

	createTerminal(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
	): vscode.Terminal | undefined {
		const name = `[${feature.name}] ${agent.name}`;
		const color = AGENT_COLORS[agentIndex % AGENT_COLORS.length];
		const cwd = agent.worktreePath ?? feature.worktreePath;

		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id);
		const legacySessionName = this.tmux.legacySessionName(feature.id, agent.id);
		let sessionReady = this.tmux.adoptSession(sessionName, legacySessionName);

		if (!sessionReady) {
			const tool = this.toolRegistry.resolveAgentTool(agent.toolId);
			const shouldResume = resume && agent.hasStarted === true;
			// Snapshot the opencode sessions that already exist in this
			// directory BEFORE launching, so a session created by THIS launch
			// is the only one that can be attributed to the agent. A
			// pre-existing session (e.g. another agent in the same worktree)
			// must never become this agent's id just because it is the most
			// recent in the same cwd.
			const openCodeBaseline =
				isOpenCodeFamily(tool) && !agent.sessionId
					? sessionIdsForDirectory(cwd)
					: undefined;
			try {
				const launchCommand = shouldResume
					? this.toolRegistry.buildResumeLaunchCommand(tool, agent.sessionId)
					: this.toolRegistry.buildLaunchCommand(tool, agent.sessionId);
				exec(this.tmux.createCommand(sessionName, launchCommand), { cwd });
				this.tmux.configureSession(sessionName);
				sessionReady = this.tmux.isSessionAlive(sessionName);
				if (openCodeBaseline) {
					void this.captureOpenCodeSessionId(
						feature,
						agent,
						cwd,
						openCodeBaseline,
					);
				}
			} catch (err) {
				console.warn(`[TerminalController] tmux session create failed: ${err}`);
				sessionReady = false;
			}
		}

		if (!sessionReady) {
			const tool = this.toolRegistry.resolveAgentTool(agent.toolId);
			const message = this.buildStartupFailureMessage(
				agent.name,
				tool.name,
				cwd,
			);
			this.recordAgentFailure(feature.id, agent.id, message);
			void vscode.window.showErrorMessage(message);
			return undefined;
		}

		const { shellPath, shellArgs } = getTerminalShellArgs(sessionName);

		const terminal = vscode.window.createTerminal({
			name,
			shellPath,
			shellArgs,
			cwd,
			color,
			iconPath: new vscode.ThemeIcon("hubot"),
			location: vscode.TerminalLocation.Editor,
			isTransient: true,
		});

		this.terminals.set(agent.id, terminal);
		this.terminalMetadata.set(terminal, {
			id: agent.id,
			kind: "agent",
			featureId: feature.id,
			sessionName,
		});

		const ctx = this.projectManager.findContextByFeatureId(feature.id);
		if (ctx) {
			ctx.agentManager.markAgentStarted(agent.id, feature.id);
			this.projectManager.notifyChange();
		}

		return terminal;
	}

	focusOrCreateTerminal(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
	): vscode.Terminal | undefined {
		const existing = this.terminals.get(agent.id);
		if (existing) {
			existing.show();
			return existing;
		}
		return this.createTerminal(feature, agent, agentIndex, resume);
	}

	focusOrCreateServiceTerminal(
		feature: Feature,
		service: Service,
		cwd: string,
	): vscode.Terminal | undefined {
		const existing = this.terminals.get(service.id);
		if (existing) {
			existing.show();
			return existing;
		}
		return this.createServiceTerminal(feature, service, cwd);
	}

	createServiceTerminal(
		_feature: Feature,
		service: Service,
		cwd: string,
	): vscode.Terminal | undefined {
		const name = `svc: ${service.name}`;
		const sessionName = service.tmuxSession;
		let sessionReady = this.tmux.isSessionAlive(sessionName);

		if (!sessionReady) {
			try {
				exec(this.resolveServiceStartCommand(service), { cwd });
				this.tmux.configureServiceSession(sessionName);
				sessionReady = this.tmux.isSessionAlive(sessionName);
			} catch (err) {
				console.warn(`[TerminalController] service tmux create failed: ${err}`);
			}
		}

		if (!sessionReady) {
			void vscode.window.showErrorMessage(
				`Failed to start service "${service.name}". Check that the command runs in ${cwd}.`,
			);
			return undefined;
		}

		const { shellPath, shellArgs } = getTerminalShellArgs(sessionName);

		const terminal = vscode.window.createTerminal({
			name,
			shellPath,
			shellArgs,
			cwd,
			color: new vscode.ThemeColor("terminal.ansiWhite"),
			iconPath: new vscode.ThemeIcon("server-process"),
			location: vscode.TerminalLocation.Editor,
			isTransient: true,
		});

		this.terminals.set(service.id, terminal);
		this.terminalMetadata.set(terminal, {
			id: service.id,
			kind: "service",
			featureId: service.featureId,
			sessionName,
		});
		return terminal;
	}

	private resolveServiceStartCommand(service: Service): string {
		if (service.launchCommand === null) {
			return this.tmux.createShellCommand(service.tmuxSession);
		}

		return this.tmux.createCommand(
			service.tmuxSession,
			service.launchCommand ?? service.command,
		);
	}

	getTerminal(agentId: string): vscode.Terminal | undefined {
		return this.terminals.get(agentId);
	}

	findAgentIdByTerminal(terminal: vscode.Terminal): string | undefined {
		for (const [agentId, t] of this.terminals) {
			if (t === terminal) return agentId;
		}
		return undefined;
	}

	renameTerminal(feature: Feature, agent: Agent, agentIndex: number): void {
		const existing = this.terminals.get(agent.id);
		if (!existing) return;

		// Dispose old terminal (detaches from tmux, session stays alive)
		this.terminalMetadata.delete(existing);
		this.terminals.delete(agent.id);
		existing.dispose();

		// Re-attach with updated name
		const name = `[${feature.name}] ${agent.name}`;
		const color = AGENT_COLORS[agentIndex % AGENT_COLORS.length];
		const cwd = agent.worktreePath ?? feature.worktreePath;
		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id);
		const legacySessionName = this.tmux.legacySessionName(feature.id, agent.id);
		this.tmux.adoptSession(sessionName, legacySessionName);

		const { shellPath, shellArgs } = getTerminalShellArgs(sessionName);

		const terminal = vscode.window.createTerminal({
			name,
			shellPath,
			shellArgs,
			cwd,
			color,
			iconPath: new vscode.ThemeIcon("hubot"),
			location: vscode.TerminalLocation.Editor,
			isTransient: true,
		});

		this.terminals.set(agent.id, terminal);
		this.terminalMetadata.set(terminal, {
			id: agent.id,
			kind: "agent",
			featureId: feature.id,
			sessionName,
		});
	}

	disposeFeatureTerminals(featureId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;

		const agents = ctx.agentManager.getAgents(featureId);
		for (const agent of agents) {
			this.disposeTrackedTerminal(agent.id);
		}

		this.disposeFeatureServiceTerminals(featureId);
	}

	disposeFeatureServiceTerminals(featureId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;

		const services = ctx.serviceManager.getServices(featureId);
		for (const service of services) {
			this.disposeTrackedTerminal(service.id);
		}
	}

	killAgentTerminal(agentId: string, featureId: string): void {
		this.disposeTrackedTerminal(agentId);

		const sessionName = this.resolveAgentSessionName(featureId, agentId);
		this.tmux.killSession(sessionName);
		const legacySessionName = this.tmux.legacySessionName(featureId, agentId);
		if (legacySessionName !== sessionName) {
			this.tmux.killSession(legacySessionName);
		}
	}

	killFeatureTerminals(featureId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;

		const agents = ctx.agentManager.getAgents(featureId);
		for (const agent of agents) {
			this.killAgentTerminal(agent.id, featureId);
		}

		this.killFeatureServiceTerminals(featureId);
	}

	killServiceTerminal(serviceId: string, tmuxSession: string): void {
		this.disposeTrackedTerminal(serviceId);
		this.tmux.killSession(tmuxSession);
	}

	killFeatureServiceTerminals(featureId: string): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;

		const services = ctx.serviceManager.getServices(featureId);
		for (const service of services) {
			this.killServiceTerminal(service.id, service.tmuxSession);
		}
	}

	reconnectTmuxSessions(feature: Feature): void {
		// Debounce per feature to avoid duplicate reconnections from rapid
		// sidebar visibility changes and feature activation events
		const existing = this.reconnectTimers.get(feature.id);
		if (existing) {
			clearTimeout(existing);
		}
		this.reconnectTimers.set(
			feature.id,
			setTimeout(() => {
				this.reconnectTimers.delete(feature.id);
				this.doReconnectTmuxSessions(feature);
			}, 150),
		);
	}

	private doReconnectTmuxSessions(feature: Feature): void {
		const ctx = this.projectManager.findContextByFeatureId(feature.id);
		if (!ctx) return;

		const agents = ctx.agentManager.getAgents(feature.id);
		for (let i = 0; i < agents.length; i++) {
			const agent = agents[i];
			if (agent.status === "done") continue;
			if (this.terminals.has(agent.id)) continue;

			const sessionName =
				agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id);
			const legacySessionName = this.tmux.legacySessionName(
				feature.id,
				agent.id,
			);
			const isAlive = this.tmux.adoptSession(sessionName, legacySessionName);

			if (isAlive) {
				// Tmux session alive — just reattach
				this.createTerminal(feature, agent, i);
			} else {
				// Tmux session dead — respawn with resume command
				this.createTerminal(feature, agent, i, true);
			}
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private resolveAgentSessionName(featureId: string, agentId: string): string {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		const agent = ctx?.agentManager.getAgent(featureId, agentId);
		return agent?.tmuxSession ?? this.tmux.sessionName(featureId, agentId);
	}

	/**
	 * Best-effort: poll the opencode session store until a session created
	 * after `baseline` appears for `cwd`, then persist its id on the agent.
	 * Sessions that already existed before the launch (in `baseline`) are
	 * never attributed to this agent. The claim is atomic: if two captures
	 * for the same cwd poll concurrently, each new session is reserved for
	 * exactly one of them and the other keeps waiting for a newer one. Never
	 * blocks the UI and swallows failures (e.g. opencode not installed).
	 */
	private async captureOpenCodeSessionId(
		feature: Feature,
		agent: Agent,
		cwd: string,
		baseline: Set<string>,
	): Promise<void> {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			let sessionId: string | undefined;
			try {
				sessionId = claimNewestSessionIdForDirectory(cwd, baseline);
			} catch {
				// opencode CLI unavailable — nothing to discover
				return;
			}
			if (sessionId) {
				const ctx = this.projectManager.findContextByFeatureId(feature.id);
				ctx?.agentManager.updateAgentSessionId(agent.id, feature.id, sessionId);
				this.projectManager.notifyChange();
				this.sessionDiscoveredCallback?.();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 750));
		}
	}

	private disposeTrackedTerminal(entityId: string): void {
		const terminal = this.terminals.get(entityId);
		if (!terminal) {
			return;
		}

		this.terminals.delete(entityId);
		this.terminalMetadata.delete(terminal);
		terminal.dispose();
	}

	private buildStartupFailureMessage(
		agentName: string,
		toolName: string,
		cwd: string,
	): string {
		return `Failed to start ${agentName} with ${toolName}. Check that the CLI is installed and launches from ${cwd}.`;
	}

	private recordAgentFailure(
		featureId: string,
		agentId: string,
		message: string,
		exitCode?: number | null,
	): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) {
			return;
		}

		ctx.agentManager.recordAgentFailure(agentId, featureId, message, exitCode);
		this.projectManager.notifyChange();
	}

	private handleUnexpectedAgentClose(metadata: TerminalMetadata): void {
		if (!metadata.featureId) {
			return;
		}

		const ctx = this.projectManager.findContextByFeatureId(metadata.featureId);
		if (!ctx) {
			return;
		}

		const agent = ctx.agentManager
			.getAgents(metadata.featureId)
			.find((candidate) => candidate.id === metadata.id);
		if (!agent || agent.status === "done") {
			return;
		}

		const paneStatus = this.tmux.getPaneStatus(metadata.sessionName);
		const sessionAlive = this.tmux.isSessionAlive(metadata.sessionName);
		if (sessionAlive && !paneStatus?.dead) {
			return;
		}

		const exitSuffix =
			paneStatus?.dead && Number.isFinite(paneStatus.exitCode)
				? ` (exit code ${paneStatus.exitCode})`
				: "";
		const message = `${agent.name} exited unexpectedly${exitSuffix}.`;
		this.recordAgentFailure(
			metadata.featureId,
			metadata.id,
			message,
			paneStatus?.dead ? paneStatus.exitCode : undefined,
		);
		void vscode.window.showErrorMessage(message);
	}
}
