import * as vscode from "vscode";
import { getThemeColors } from "../constants/colors";
import {
	buildProjectKnowledgeLaunchNote,
	discoverProjectKnowledge,
} from "../projects/projectKnowledge";
import type { ProjectManager } from "../projects/projectManager";
import type { Agent, Feature, Service } from "../types";
import { exec, getTerminalShellArgs } from "../utils/platform";
import type { CodingToolRegistry } from "./codingToolRegistry";
import type { TmuxIntegration } from "./tmux";

const AGENT_COLORS = getThemeColors();

/** Single-quote a value for insertion into a shell command line. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface TerminalMetadata {
	id: string;
	kind: "agent" | "service";
	featureId?: string;
	sessionName: string;
	feature?: Feature;
	agent?: Agent;
	justLaunched?: boolean;
}

export class TerminalController implements vscode.Disposable {
	private terminals = new Map<string, vscode.Terminal>();
	private terminalMetadata = new Map<vscode.Terminal, TerminalMetadata>();
	private disposables: vscode.Disposable[] = [];
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private beforeLaunchCallback?: (
		feature: Feature,
		agent: Agent,
		cwd: string,
	) => void;
	private afterLaunchCallback?: (feature: Feature, agent: Agent) => void;

	constructor(
		private readonly projectManager: ProjectManager,
		private readonly tmux: TmuxIntegration,
		private readonly toolRegistry: CodingToolRegistry,
	) {
		this.disposables.push(
			vscode.window.onDidOpenTerminal((terminal) => {
				const metadata = this.terminalMetadata.get(terminal);
				if (metadata?.kind === "agent" && metadata.featureId) {
					this.markAgentTerminalReady(metadata);
				}
			}),
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

	/**
	 * Called immediately before an agent's CLI starts, while the provider's
	 * session store still shows only pre-existing sessions. That snapshot is what
	 * later guarantees Agent Space never adopts a neighbouring agent's session.
	 */
	onBeforeAgentLaunch(
		callback: (feature: Feature, agent: Agent, cwd: string) => void,
	): void {
		this.beforeLaunchCallback = callback;
	}

	/** Called once the CLI has been started in a live tmux session. */
	onAgentLaunched(callback: (feature: Feature, agent: Agent) => void): void {
		this.afterLaunchCallback = callback;
	}

	createTerminal(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
		attachExisting = false,
	): vscode.Terminal | undefined {
		const name = `[${feature.name}] ${agent.name}`;
		const color = AGENT_COLORS[agentIndex % AGENT_COLORS.length];
		const cwd = agent.worktreePath ?? feature.worktreePath;

		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id);
		const legacySessionName = this.tmux.legacySessionName(feature.id, agent.id);
		let sessionReady = attachExisting
			? this.tmux.isSessionAlive(sessionName)
			: this.tmux.adoptSession(sessionName, legacySessionName);

		if (attachExisting && !sessionReady) {
			void vscode.window.showErrorMessage(
				`Cannot attach agent "${agent.name}": its persisted tmux session is no longer alive.`,
			);
			return undefined;
		}

		let justLaunched = false;
		if (!sessionReady) {
			const tool = this.toolRegistry.resolveAgentTool(agent.toolId);
			const shouldResume = resume && agent.hasStarted === true;
			try {
				const baseCommand = shouldResume
					? this.toolRegistry.buildResumeLaunchCommand(tool, agent.sessionId)
					: this.toolRegistry.buildLaunchCommand(tool, agent.sessionId);
				// Fresh launches get the project's operational knowledge note so
				// the agent's launch context shows which instructions/runbooks
				// were made available. Resume/attach launches stay quiet.
				const launchContextNote = shouldResume
					? undefined
					: this.buildAgentLaunchNote(feature);
				const launchCommand = this.withLaunchContextNote(
					baseCommand,
					launchContextNote,
				);
				// Snapshot the provider's existing sessions for this directory
				// before the CLI starts, so a session created by THIS launch is the
				// only one that can later be attributed to the agent.
				this.beforeLaunchCallback?.(feature, agent, cwd);
				exec(this.tmux.createCommand(sessionName, launchCommand), { cwd });
				this.tmux.configureSession(sessionName);
				sessionReady = this.tmux.isSessionAlive(sessionName);
				justLaunched = sessionReady;
			} catch (err) {
				console.warn(`[TerminalController] tmux session create failed: ${err}`);
				sessionReady = false;
			}
		}

		if (!sessionReady) {
			if (attachExisting) {
				void vscode.window.showErrorMessage(
					`Cannot attach agent "${agent.name}": its persisted tmux session is no longer alive.`,
				);
				return undefined;
			}
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
			feature,
			agent,
			justLaunched,
		});
		// The onDidOpenTerminal event is the VS Code lifecycle boundary used to
		// mark the agent ready. Showing the terminal alone is not enough: the
		// extension must keep the startup indicator visible until VS Code has
		// actually registered the terminal for the user.
		terminal.show(true);

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

	/**
	 * Build the launch-context note for a fresh agent: which project
	 * instructions and runbooks were made available, and any knowledge
	 * problem. Provider-agnostic — the note points at files the agent can
	 * read, it never injects provider-specific context.
	 */
	private buildAgentLaunchNote(feature: Feature): string | undefined {
		const ctx = this.projectManager.findContextByFeatureId(feature.id);
		if (!ctx?.project || !ctx.config) return undefined;
		try {
			return buildProjectKnowledgeLaunchNote(
				discoverProjectKnowledge(ctx.project.repoPath, ctx.config),
			);
		} catch {
			// Knowledge is an enhancement; a resolution failure must never
			// block an agent launch.
			return undefined;
		}
	}

	/**
	 * Prepend a visible launch-context note to the CLI command so it is the
	 * first thing the agent's terminal shows. The note only writes stdout
	 * before the CLI starts; it never feeds input to the CLI.
	 */
	private withLaunchContextNote(
		command: string,
		note: string | undefined,
	): string {
		if (!note) return command;
		const echoed = `printf '%s\\n' ${note
			.split("\n")
			.map(shellQuote)
			.join(" ")}`;
		return `${echoed}; ${command}`;
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

	private markAgentTerminalReady(metadata: TerminalMetadata): void {
		if (!metadata.featureId) return;
		const ctx = this.projectManager.findContextByFeatureId(metadata.featureId);
		if (!ctx) return;
		ctx.agentManager.markAgentStarted(metadata.id, metadata.featureId);
		if (metadata.justLaunched && metadata.feature && metadata.agent) {
			this.afterLaunchCallback?.(metadata.feature, metadata.agent);
		}
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
