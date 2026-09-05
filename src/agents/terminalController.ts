import * as vscode from "vscode";
import { getThemeColors } from "../constants/colors";
import { reportUiRefreshError } from "../diagnostics/agentSpaceDiagnostics";
import {
	buildProjectKnowledgeLaunchNote,
	discoverProjectKnowledge,
} from "../projects/projectKnowledge";
import type { ProjectManager } from "../projects/projectManager";
import type { Agent, CodingTool, Feature, Service } from "../types";
import { exec, getTerminalShellArgs } from "../utils/platform";
import type { CodingToolRegistry } from "./codingToolRegistry";
import {
	ensureHermesProjectSkillsTrusted,
	ensureHermesProjectSkillsTrustedAsync,
} from "./hermesSkillTrust";
import {
	RuntimeOwnershipGuard,
	runtimeOwnershipKey,
	withRuntimeSpawnLock,
	withRuntimeSpawnLockSync,
} from "./runtimeOwnership";
import type { SessionBinder } from "./sessionBinder";
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
	private terminalReadyWaiters = new Map<
		string,
		{ resolve: () => void; timer: ReturnType<typeof setTimeout> }
	>();
	/** Coalesces concurrent cold reconciliations so two clicks on the same
	 *  untracked agent can never create two terminals. */
	private terminalReconciliations = new Map<
		string,
		Promise<vscode.Terminal | undefined>
	>();
	private beforeLaunchCallback?: (
		feature: Feature,
		agent: Agent,
		cwd: string,
	) => void;
	private beforeLaunchFastCallback?: (feature: Feature, agent: Agent) => void;
	private beforeLaunchAsyncCallback?: (
		feature: Feature,
		agent: Agent,
		cwd: string,
		resume: boolean,
	) => Promise<void>;
	private afterLaunchCallback?: (feature: Feature, agent: Agent) => void;

	constructor(
		private readonly projectManager: ProjectManager,
		private readonly tmux: TmuxIntegration,
		private readonly toolRegistry: CodingToolRegistry,
		/**
		 * Optional: lets a blocked resume (no persisted sessionId) resolve
		 * itself through the binder's own worktree-scoped, ownership-checked
		 * candidate list instead of failing closed outright. See
		 * {@link tryAutoAttachAndResume}.
		 */
		private readonly sessionBinder?: SessionBinder,
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

	/** Cheap fresh-launch hook; implementations must not inspect provider state. */
	onBeforeAgentLaunchFast(
		callback: (feature: Feature, agent: Agent) => void,
	): void {
		this.beforeLaunchFastCallback = callback;
	}

	/** Called once the CLI has been started in a live tmux session. */
	onAgentLaunched(callback: (feature: Feature, agent: Agent) => void): void {
		this.afterLaunchCallback = callback;
	}

	onBeforeAgentLaunchAsync(
		callback: (
			feature: Feature,
			agent: Agent,
			cwd: string,
			resume: boolean,
		) => Promise<void>,
	): void {
		this.beforeLaunchAsyncCallback = callback;
	}

	createTerminal(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
		attachExisting = false,
	): vscode.Terminal | undefined {
		const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
		if (tool.family !== "hermes") {
			return this.createTerminalUnlocked(
				feature,
				agent,
				agentIndex,
				resume,
				attachExisting,
			);
		}
		return withRuntimeSpawnLockSync(runtimeOwnershipKey(agent), () =>
			this.createTerminalUnlocked(
				feature,
				agent,
				agentIndex,
				resume,
				attachExisting,
			),
		);
	}

	private createTerminalUnlocked(
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
		let launchDiagnostics:
			| { exitCode?: number; output?: string | null }
			| undefined;
		if (!sessionReady) {
			const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
			const shouldResume = resume && agent.hasStarted === true;
			this.advanceStartupStep(feature.id, agent.id, "terminal");
			let baseCommand: string;
			if (shouldResume) {
				if (tool.family === "hermes") {
					const ownership = new RuntimeOwnershipGuard(
						this.projectManager,
						this.tmux,
						this.toolRegistry,
					).checkResumeSync(
						agent.sessionId as string,
						agent.id,
						agent.hermesProfile ?? "default",
					);
					if (!ownership.allowed) {
						const message = ownership.reason as string;
						this.recordAgentFailure(feature.id, agent.id, message);
						void vscode.window.showErrorMessage(message);
						return undefined;
					}
				}
				// A silent fresh launch here would drop the agent into a brand-new
				// empty conversation while the user believes they are resuming one
				// — the same failure mode runtimeRestorer's strict resume exists to
				// prevent. Apply the same fail-closed guarantee to the manual click
				// path: block explicitly instead of guessing.
				const resumeCommand =
					this.toolRegistry.buildStrictResumeLaunchCommand(
						tool,
						agent.sessionId,
						cwd,
					) ?? this.tryAutoAttachAndResume(feature, agent, tool);
				if (!resumeCommand) {
					const message = this.buildResumeBlockedMessage(agent.name, tool.name);
					this.recordAgentFailure(feature.id, agent.id, message);
					void vscode.window.showErrorMessage(message);
					return undefined;
				}
				baseCommand = resumeCommand;
			} else {
				baseCommand = this.toolRegistry.buildLaunchCommand(
					tool,
					agent.sessionId,
					cwd,
				);
			}
			// Ensure Hermes project skills in this worktree are trusted before
			// launch, so skills load automatically without a manual trust step.
			if (agent.hermesProfile && cwd) {
				ensureHermesProjectSkillsTrusted(cwd, agent.hermesProfile);
			}

			// Fresh launches get the project's operational knowledge note so
			// the agent's launch context shows which instructions/runbooks
			// were made available. Resume/attach launches stay quiet.
			// Launch notes are useful enrichment, but discovering project knowledge
			// can perform filesystem I/O. Keep it out of the fresh-start critical
			// path; the provider owns the terminal first.
			const launchCommand = baseCommand;
			try {
				// Snapshot the provider's existing sessions for this directory
				// before the CLI starts, so a session created by THIS launch is the
				// only one that can later be attributed to the agent.
				this.beforeLaunchCallback?.(feature, agent, cwd);
				exec(this.tmux.createCommand(sessionName, launchCommand), { cwd });
				this.tmux.configureSession(sessionName);
				sessionReady = this.tmux.isSessionAlive(sessionName);
				if (sessionReady) {
					// The terminal itself is up; a failure from here on is the
					// provider process inside it, not the terminal.
					this.advanceStartupStep(feature.id, agent.id, "provider");
					// See the async twin for why the session can still be alive with a
					// dead pane (remain-on-exit) after an almost-instant crash.
					const paneStatus = this.tmux.getPaneStatus(sessionName);
					if (paneStatus?.dead) {
						launchDiagnostics = {
							exitCode: paneStatus.exitCode,
							output: this.tmux.capturePane(sessionName),
						};
						this.tmux.killSession(sessionName);
						sessionReady = false;
					} else {
						this.tmux.clearRemainOnExitForSession(sessionName);
					}
				}
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
			const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
			const message = this.buildStartupFailureMessage(
				agent.name,
				tool.name,
				cwd,
				launchDiagnostics,
			);
			this.recordAgentFailure(
				feature.id,
				agent.id,
				message,
				launchDiagnostics?.exitCode,
			);
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

	waitForAgentTerminalReady(
		featureId: string,
		agentId: string,
		timeoutMs = 30_000,
	): Promise<void> {
		const agent = this.projectManager
			.findContextByFeatureId(featureId)
			?.agentManager.getAgent(featureId, agentId);
		if (agent?.status === "running") return Promise.resolve();

		const previous = this.terminalReadyWaiters.get(agentId);
		if (previous) clearTimeout(previous.timer);
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.terminalReadyWaiters.delete(agentId);
				resolve();
			}, timeoutMs);
			this.terminalReadyWaiters.set(agentId, { resolve, timer });
		});
	}

	/**
	 * Async twin of {@link focusOrCreateTerminal} for the interactive click
	 * path (sidebar + home).
	 *
	 * Scope of the non-blocking guarantee:
	 * - **Warm focus** (terminal already tracked): `terminals.get -> show()`,
	 *   zero exec of any kind.
	 * - **Cold tmux reattachment** (terminal lost on window reload but the
	 *   tmux session survived): async-only discovery via `adoptSessionAsync`/
	 *   `isSessionAliveAsync` and an async spawn.
	 *
	 * It is NOT a guarantee over every fresh-launch branch: when the agent's
	 * tmux session is actually gone, `createTerminalAsync` still runs a few
	 * synchronous calls (`configureSession`, launch-note discovery, failure
	 * recording). Those are cold-boot edge cases, not the warm-switch path.
	 *
	 * Concurrency contract: concurrent calls for the same agent coalesce into
	 * one reconciliation, so a double-click can never create duplicate
	 * terminals. A cold-created terminal is registered but NOT revealed; the
	 * caller decides whether (and when) to `show()` it, so a resolution that
	 * is no longer the user's latest focus request can never steal focus.
	 */
	async focusOrCreateTerminalAsync(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
	): Promise<vscode.Terminal | undefined> {
		const existing = this.terminals.get(agent.id);
		if (existing) {
			existing.show();
			return existing;
		}
		return this.createTerminalAsync(feature, agent, agentIndex, resume);
	}

	/**
	 * Non-blocking twin of {@link createTerminal}, used only for cold
	 * reattachment off the interactive click path (see
	 * `focusOrCreateTerminalAsync`). Every other caller keeps using the
	 * synchronous `createTerminal`; the fail-closed session-ownership
	 * ordering (snapshot existing sessions before spawning) is unchanged —
	 * only the discovery calls themselves run asynchronously.
	 *
	 * Guarantee scope: the cold *reattachment* path is fully async. The
	 * fresh-spawn branch (only reachable when the agent's tmux session is
	 * actually gone, not just an untracked `vscode.Terminal`) still calls the
	 * synchronous `configureSession` and `discoverProjectKnowledge`. Do not
	 * read this method as a general "never block" promise.
	 */
	createTerminalAsync(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
		attachExisting = false,
	): Promise<vscode.Terminal | undefined> {
		const existing = this.terminalReconciliations.get(agent.id);
		if (existing) return existing;
		const creation = this.createTerminalAsyncLocked(
			feature,
			agent,
			agentIndex,
			resume,
			attachExisting,
		);
		this.terminalReconciliations.set(agent.id, creation);
		const clear = () => {
			if (this.terminalReconciliations.get(agent.id) === creation) {
				this.terminalReconciliations.delete(agent.id);
			}
		};
		void creation.then(clear, clear);
		return creation;
	}

	private async createTerminalAsyncLocked(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
		attachExisting = false,
	): Promise<vscode.Terminal | undefined> {
		const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
		if (tool.family !== "hermes") {
			return this.createTerminalAsyncUnlocked(
				feature,
				agent,
				agentIndex,
				resume,
				attachExisting,
			);
		}
		return withRuntimeSpawnLock(runtimeOwnershipKey(agent), () =>
			this.createTerminalAsyncUnlocked(
				feature,
				agent,
				agentIndex,
				resume,
				attachExisting,
			),
		);
	}

	private async createTerminalAsyncUnlocked(
		feature: Feature,
		agent: Agent,
		agentIndex: number,
		resume = false,
		attachExisting = false,
	): Promise<vscode.Terminal | undefined> {
		const name = `[${feature.name}] ${agent.name}`;
		const color = AGENT_COLORS[agentIndex % AGENT_COLORS.length];
		const cwd = agent.worktreePath ?? feature.worktreePath;

		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id);
		const legacySessionName = this.tmux.legacySessionName(feature.id, agent.id);
		const shouldResume = resume && agent.hasStarted === true;
		// Kick off the launch-note discovery (synchronous filesystem walk) now,
		// as a microtask, so it overlaps with the tmux discovery subprocess
		// calls below instead of running serially just before the launch —
		// only its result is awaited later, right before it's needed.
		const launchNotePromise = shouldResume
			? Promise.resolve(undefined)
			: Promise.resolve().then(() => this.buildAgentLaunchNote(feature));
		let sessionReady = attachExisting
			? await this.tmux.isSessionAliveAsync(sessionName)
			: await this.tmux.adoptSessionAsync(sessionName, legacySessionName);

		let justLaunched = false;
		let launchDiagnostics:
			| { exitCode?: number; output?: string | null }
			| undefined;
		if (!sessionReady) {
			const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
			this.advanceStartupStep(feature.id, agent.id, "terminal");
			try {
				if (shouldResume) {
					this.beforeLaunchCallback?.(feature, agent, cwd);
					await this.beforeLaunchAsyncCallback?.(feature, agent, cwd, true);
				} else {
					this.beforeLaunchFastCallback?.(feature, agent);
				}
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Provider identity acquisition failed";
				this.recordAgentFailure(feature.id, agent.id, message);
				void vscode.window.showErrorMessage(message);
				return undefined;
			}
			let baseCommand: string;
			if (shouldResume) {
				if (tool.family === "hermes") {
					const ownership = await new RuntimeOwnershipGuard(
						this.projectManager,
						this.tmux,
						this.toolRegistry,
					).checkResume(
						agent.sessionId as string,
						agent.id,
						agent.hermesProfile ?? "default",
					);
					if (!ownership.allowed) {
						const message = ownership.reason as string;
						this.recordAgentFailure(feature.id, agent.id, message);
						void vscode.window.showErrorMessage(message);
						return undefined;
					}
				}
				// Same fail-closed guarantee as the sync path: never silently drop
				// the user into a fresh empty conversation when a genuine resume
				// cannot be proven.
				const resumeCommand =
					this.toolRegistry.buildStrictResumeLaunchCommand(
						tool,
						agent.sessionId,
						cwd,
					) ?? this.tryAutoAttachAndResume(feature, agent, tool);
				if (!resumeCommand) {
					const message = this.buildResumeBlockedMessage(agent.name, tool.name);
					this.recordAgentFailure(feature.id, agent.id, message);
					void vscode.window.showErrorMessage(message);
					return undefined;
				}
				baseCommand = resumeCommand;
			} else {
				baseCommand = this.toolRegistry.buildLaunchCommand(
					tool,
					agent.sessionId,
					cwd,
				);
			}
			// Ensure Hermes project skills in this worktree are trusted before
			// launch, so skills load automatically without a manual trust step.
			// Uses the async variant to keep the extension host event loop free.
			if (agent.hermesProfile && cwd) {
				await ensureHermesProjectSkillsTrustedAsync(cwd, agent.hermesProfile);
			}

			const launchContextNote = await launchNotePromise;
			const launchCommand = this.withLaunchContextNote(
				baseCommand,
				launchContextNote,
			);
			try {
				// Snapshot the provider's existing sessions for this directory
				// before the CLI starts — identical ordering to the sync path —
				// so a session created by THIS launch is the only one that can
				// later be attributed to the agent.
				// `new-session -d` is detached: waiting on the shell wrapper here can
				// inherit the CLI's lifetime and hit execAsync's 30s timeout. The
				// synchronous call returns as soon as tmux accepts the session; all
				// follow-up checks remain asynchronous below.
				exec(this.tmux.createCommand(sessionName, launchCommand), { cwd });
				await this.tmux.configureSessionAsync(sessionName);
				sessionReady = await this.tmux.isSessionAliveAsync(sessionName);
				if (sessionReady) {
					// The terminal itself is up; a failure from here on is the
					// provider process inside it, not the terminal.
					this.advanceStartupStep(feature.id, agent.id, "provider");
					// The tmux session can outlive an almost-instant crash of the
					// process inside it (remain-on-exit) — check the pane, not just
					// the session, so a CLI that started and immediately exited is
					// reported as a real failure with its actual output, not a
					// silent "ready" terminal attached to a dead pane.
					const paneStatus = await this.tmux.getPaneStatusAsync(sessionName);
					if (paneStatus?.dead) {
						launchDiagnostics = {
							exitCode: paneStatus.exitCode,
							output: await this.tmux.capturePaneAsync(sessionName),
						};
						this.tmux.killSession(sessionName);
						sessionReady = false;
					} else {
						// Alive and running: revert to the ordinary "session dies with
						// its pane" behavior so a later, mid-conversation crash is still
						// detected the existing way (see clearRemainOnExitForSession).
						await this.tmux.clearRemainOnExitForSessionAsync(sessionName);
					}
				}
				justLaunched = sessionReady;
			} catch (err) {
				console.warn(`[TerminalController] tmux session create failed: ${err}`);
				sessionReady = false;
			}
		}
		if (
			sessionReady &&
			resume &&
			agent.sessionId &&
			this.beforeLaunchAsyncCallback
		) {
			try {
				await this.beforeLaunchAsyncCallback(feature, agent, cwd, true);
			} catch (error) {
				console.warn(
					`[TerminalController] provider reconnect failed: ${error}`,
				);
			}
		}

		if (!sessionReady) {
			const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
			const message = this.buildStartupFailureMessage(
				agent.name,
				tool.name,
				cwd,
				launchDiagnostics,
			);
			this.recordAgentFailure(
				feature.id,
				agent.id,
				message,
				launchDiagnostics?.exitCode,
			);
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
		// Deliberately NOT calling terminal.show() here: revealing is the
		// caller's decision, so a cold reconciliation that is no longer the
		// user's latest focus (e.g. A cold → B warm) can create the terminal
		// in the background and register it as warm without stealing focus.
		return terminal;
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
				void this.createTerminalAsync(feature, agent, i).catch((error) =>
					reportUiRefreshError("reattach cold terminal", error),
				);
			} else {
				// Tmux session dead — respawn with resume command
				void this.createTerminalAsync(feature, agent, i, true).catch((error) =>
					reportUiRefreshError("respawn cold terminal", error),
				);
			}
		}
	}

	dispose(): void {
		for (const waiter of this.terminalReadyWaiters.values()) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		this.terminalReadyWaiters.clear();
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
		diagnostics?: { exitCode?: number; output?: string | null },
	): string {
		const output = diagnostics?.output?.trim();
		if (diagnostics?.exitCode !== undefined || output) {
			const exitPart =
				diagnostics?.exitCode !== undefined
					? ` (exit code ${diagnostics.exitCode})`
					: "";
			// The CLI process demonstrably started and exited — never blame a
			// missing binary or a bad cwd for a process that actually ran.
			const outputPart = output ? ` Last output:\n${output.slice(-2000)}` : "";
			return `${toolName} exited during startup${exitPart} for ${agentName}.${outputPart}`;
		}
		return `Failed to start ${agentName} with ${toolName}. Check that the CLI is installed and launches from ${cwd}.`;
	}

	/**
	 * Shown when a resume was requested, no session id was persisted for the
	 * agent, and {@link tryAutoAttachAndResume} could not resolve one either
	 * (no candidate, or more than one) — the same condition runtimeRestorer
	 * reports as `blocked`. Never silently launches fresh.
	 */
	private buildResumeBlockedMessage(
		agentName: string,
		toolName: string,
	): string {
		return `Cannot resume "${agentName}": no genuine ${toolName} session could be proven for it. Close this agent and start a new one to continue.`;
	}

	/**
	 * Recovery for a resume that `buildStrictResumeLaunchCommand` refused
	 * because no sessionId is persisted (the common Codex/OpenCode case: the
	 * provider only writes its session file once the agent's first prompt
	 * lands, so binding never happened). Rather than block outright, look for
	 * a session in the agent's worktree via the same worktree- and
	 * ownership-checked list `Attach Provider Session` uses
	 * (`sessionBinder.listAttachableSessions`): sessions from another
	 * worktree or already claimed by a sibling Agent Space agent are already
	 * excluded there.
	 *
	 * Only an unambiguous match (exactly one candidate) is auto-resolved: if
	 * the agent's real session is still there, this makes resume "just
	 * work" without a manual Attach step first. Two or more candidates are
	 * left alone — auto-picking among several risks silently resuming into a
	 * sibling agent's conversation, the exact hazard explicit attachment
	 * exists to prevent. That case (and zero candidates) still falls through
	 * to the blocked message, which is accurate: nothing here proves which
	 * session belongs to this agent.
	 */
	private tryAutoAttachAndResume(
		feature: Feature,
		agent: Agent,
		tool: CodingTool,
	): string | undefined {
		if (!this.sessionBinder) return undefined;
		// A provider-assigned id is not owned by this agent merely because it is
		// the only session currently visible in the worktree. Only preassigned
		// identities may use this legacy convenience path.
		const provider = this.toolRegistry.getProvider(tool);
		if (provider.conversationIdentity.ownership === "provider_assigned") {
			return undefined;
		}
		const candidates = this.sessionBinder.listAttachableSessions(
			feature.id,
			agent.id,
		);
		if (candidates.length !== 1) return undefined;
		const [candidate] = candidates;
		if (
			!this.sessionBinder.attachExplicitly(
				feature.id,
				agent.id,
				candidate.sessionId,
			)
		) {
			return undefined;
		}
		const cwd = agent.worktreePath ?? feature.worktreePath;
		return this.toolRegistry.buildStrictResumeLaunchCommand(
			tool,
			candidate.sessionId,
			cwd,
		);
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
		this.projectManager.notifyChange({ featureId, structural: false });
	}

	/**
	 * Mark startup progress so a later failure is blamed on the phase that
	 * actually failed. See `AgentManager.advanceStartupStep`.
	 */
	private advanceStartupStep(
		featureId: string,
		agentId: string,
		stepId: "worktree" | "terminal" | "provider",
	): void {
		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;
		ctx.agentManager.advanceStartupStep(agentId, featureId, stepId);
	}

	private markAgentTerminalReady(metadata: TerminalMetadata): void {
		if (!metadata.featureId) return;
		const ctx = this.projectManager.findContextByFeatureId(metadata.featureId);
		if (!ctx) return;
		ctx.agentManager.markAgentStarted(metadata.id, metadata.featureId);
		const waiter = this.terminalReadyWaiters.get(metadata.id);
		if (waiter) {
			clearTimeout(waiter.timer);
			this.terminalReadyWaiters.delete(metadata.id);
			waiter.resolve();
		}
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
