import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CodingToolRegistry } from "./agents/codingToolRegistry";
import { SessionNameSyncer } from "./agents/sessionNameSyncer";
import { TerminalController } from "./agents/terminalController";
import { TmuxIntegration } from "./agents/tmux";
import { runBootstrapCommands } from "./features/bootstrapRunner";
import { validateFeatureNameInput } from "./features/featureName";
import { FeatureSidebarProvider } from "./features/featureSidebarProvider";
import {
	buildGitHubCompareUrl,
	buildGitHubPullRequestBaseMetadata,
} from "./git/githubCompareUrl";
import {
	getGitViewHandoffAction,
	openFeatureGitView,
	PENDING_GIT_VIEW_HANDOFF_PREF,
} from "./git/gitViewHandoff";
import { checkWorktreeDeletionSafety } from "./git/worktreeSafety";
import { HomePanel } from "./home/homePanel";
import { HomeSidebarProvider } from "./home/homeSidebarProvider";
import { PrerequisiteChecker } from "./prerequisites";
import type { ProjectContext } from "./projects/projectManager";
import { ProjectManager } from "./projects/projectManager";
import { ensureDefaultToolConfigured } from "./startup/defaultToolInitializer";
import { GlobalStore } from "./storage/globalStore";
import type { Feature } from "./types";
import { execAsync, execAsyncSilent } from "./utils/platform";
import { ContextOnlyIsolation } from "./workspace/agentWorkspaceIsolation";

let activeFeatureId: string | null = null;
let featureActivationInProgress = false;
const execFileAsync = promisify(execFileCallback);

/**
 * Collect every reason why a feature (and its per-agent worktrees) cannot be
 * deleted without risking work loss. Empty array = safe nominal delete.
 */
function collectFeatureDeletionBlockers(
	ctx: ProjectContext,
	feature: Feature,
): string[] {
	const baseBranch = ctx.featureManager.getBaseBranchName();
	const reasons: string[] = [];

	const check = (worktreePath: string, branch?: string) => {
		const safety = checkWorktreeDeletionSafety({
			repoRoot: ctx.project.repoPath,
			worktreeBase: ctx.featureManager.getWorktreeBase(),
			worktreePath,
			branch,
			baseBranch,
		});
		if (!safety.safe) {
			reasons.push(...safety.reasons);
		}
	};

	check(feature.worktreePath, feature.branch);
	for (const agent of ctx.agentManager.getAgents(feature.id)) {
		if (agent.worktreePath) check(agent.worktreePath);
	}
	return reasons;
}

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	const prerequisites = new PrerequisiteChecker();
	const { ok, missing } = prerequisites.checkRequired();
	if (!ok) {
		prerequisites.showMissingToolsError(missing);
		return;
	}

	const tmux = new TmuxIntegration();

	const storagePath = context.globalStorageUri.fsPath;
	const globalStore = new GlobalStore(storagePath);
	const workspaceIsolation = new ContextOnlyIsolation();

	// One-time migration from Memento to file-based GlobalStore
	if (!globalStore.hasProjectsFile()) {
		const oldProjects = context.globalState.get<unknown[]>("projects");
		if (oldProjects && oldProjects.length > 0) {
			globalStore.saveProjects(oldProjects as import("./types").Project[]);
		}
		const oldFeatureId = context.globalState.get<string>("lastActiveFeatureId");
		if (oldFeatureId) {
			globalStore.setPreference("lastActiveFeatureId", oldFeatureId);
		}
		context.globalState.update("projects", undefined);
		context.globalState.update("lastActiveFeatureId", undefined);
	}

	const worktreeRelativePath = vscode.workspace
		.getConfiguration("agentSpace")
		.get<string>("worktreeBasePath", ".worktrees");

	const toolRegistry = new CodingToolRegistry();

	const projectManager = new ProjectManager(
		globalStore,
		storagePath,
		worktreeRelativePath,
		tmux,
		toolRegistry,
	);
	const gitViewHandoffAction = getGitViewHandoffAction(
		globalStore.getPreference(PENDING_GIT_VIEW_HANDOFF_PREF),
		vscode.workspace.workspaceFolders,
	);
	if (gitViewHandoffAction !== "noop") {
		globalStore.setPreference(PENDING_GIT_VIEW_HANDOFF_PREF, undefined);
		if (gitViewHandoffAction === "openScm") {
			void vscode.commands.executeCommand("workbench.view.scm");
		}
	}

	// Cross-window sync via VS Code's native file watcher
	const storageWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(context.globalStorageUri, "**/*.json"),
	);
	storageWatcher.onDidChange((uri) =>
		projectManager.handleExternalFileChange(uri),
	);
	storageWatcher.onDidCreate((uri) =>
		projectManager.handleExternalFileChange(uri),
	);
	storageWatcher.onDidDelete((uri) =>
		projectManager.handleExternalFileChange(uri),
	);
	context.subscriptions.push(storageWatcher);

	await ensureDefaultToolConfigured(toolRegistry, globalStore);

	const defaultToolId = toolRegistry.getDefaultToolId();
	const availableTools = toolRegistry.getAvailableTools();
	if (availableTools.length === 0) {
		vscode.window.showWarningMessage(
			`No coding tools found on PATH. Install one of: ${toolRegistry
				.getTools()
				.map((t) => t.command)
				.join(", ")}.`,
		);
	} else if (defaultToolId) {
		const defaultTool = toolRegistry.resolveAgentTool(defaultToolId);
		if (!toolRegistry.isToolAvailable(defaultTool)) {
			vscode.window.showWarningMessage(
				`${defaultTool.name} CLI not found. New features will not launch another tool automatically until the default is installed or changed.`,
			);
		}
	}

	const terminalController = new TerminalController(
		projectManager,
		tmux,
		toolRegistry,
	);
	context.subscriptions.push(terminalController);

	const sidebarProvider = new FeatureSidebarProvider(
		projectManager,
		toolRegistry,
		prerequisites,
		context.extensionUri,
	);
	sidebarProvider.setTerminalController(terminalController);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			FeatureSidebarProvider.viewType,
			sidebarProvider,
		),
	);
	context.subscriptions.push({ dispose: () => sidebarProvider.stopPolling() });

	const homeSidebarProvider = new HomeSidebarProvider(() => {
		void showAgentSpace();
	}, context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			HomeSidebarProvider.viewType,
			homeSidebarProvider,
		),
	);

	const ensureHomePanel = () => {
		const panel = HomePanel.createOrShow(
			projectManager,
			tmux,
			toolRegistry,
			context.extensionUri,
			globalStore,
			terminalController,
		);
		panel.onViewStateChange(({ active }) => {
			if (active) {
				workspaceIsolation.scheduleEnter();
				return;
			}

			if (featureActivationInProgress) return;

			workspaceIsolation.scheduleLeave({
				guard: () => {
					if (featureActivationInProgress) return false;
					// Abort leave if focus moved to a feature terminal
					const active = vscode.window.activeTerminal;
					return !(
						active &&
						activeFeatureId &&
						terminalController.findAgentIdByTerminal(active)
					);
				},
			});
		});
		return panel;
	};

	const showAgentSpace = async (featureId?: string): Promise<HomePanel> => {
		const panel = ensureHomePanel();
		if (featureId) {
			activeFeatureId = featureId;
			panel.showFeature(featureId);
		} else {
			panel.showWelcome();
		}
		await workspaceIsolation.enter();
		return panel;
	};

	const activateFeatureInCurrentWindow = async (
		featureId: string,
	): Promise<void> => {
		if (featureActivationInProgress) return;
		featureActivationInProgress = true;
		try {
			if (activeFeatureId && activeFeatureId !== featureId) {
				terminalController.disposeFeatureTerminals(activeFeatureId);
			}

			activeFeatureId = featureId;
			const resolved = projectManager.resolveFeature(featureId);
			if (!resolved) return;
			const { ctx, feature } = resolved;

			const agents = ctx.agentManager.getAgents(featureId);
			if (agents.length === 0) {
				// No auto-launch: opening an empty feature must not start a
				// coding tool session (and burn tokens). Agents are added
				// explicitly via "Add Agent".
				await showAgentSpace(featureId);
				return;
			}
			terminalController.reconnectTmuxSessions(feature);

			await showAgentSpace(featureId);
		} finally {
			featureActivationInProgress = false;
		}
	};

	sidebarProvider.onVisibilityChange((visible) => {
		if (!visible) {
			if (featureActivationInProgress) return;
			// Sidebar hidden → restore tab bar, but NO terminal cleanup
			// (terminals are only cleaned up via the HomePanel viewstate handler)
			workspaceIsolation.scheduleLeave({
				guard: () => {
					if (featureActivationInProgress) return false;
					const activeTerm = vscode.window.activeTerminal;
					return !(
						activeTerm &&
						activeFeatureId &&
						terminalController.findAgentIdByTerminal(activeTerm)
					);
				},
			});
			return;
		}

		// Sidebar visible → reconnect and re-enter isolation
		// enter() in showAgentSpace cancels any pending leave via cancelPending()
		if (activeFeatureId) {
			const resolved = projectManager.resolveFeature(activeFeatureId);
			if (!resolved) return;
			terminalController.reconnectTmuxSessions(resolved.feature);
			void showAgentSpace(activeFeatureId);
			return;
		}
		void showAgentSpace();
	});

	const sessionNameSyncer = new SessionNameSyncer(
		toolRegistry.getSessionRenameAdapters(),
	);
	terminalController.onSessionDiscovered(() => sessionNameSyncer.syncAll());
	sessionNameSyncer.onAgentRenamed((agentId, featureId) => {
		projectManager.notifyChange();
		const resolved = projectManager.resolveFeature(featureId);
		if (!resolved) return;
		const { ctx, feature } = resolved;
		const agents = ctx.agentManager.getAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		const agentIndex = agents.indexOf(agent);
		terminalController.renameTerminal(feature, agent, agentIndex);
	});
	let previousActiveTerminal: vscode.Terminal | undefined;
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTerminal((terminal) => {
			// Sync terminal that lost focus (catch titles set while user was watching)
			if (previousActiveTerminal) {
				const agentId = terminalController.findAgentIdByTerminal(
					previousActiveTerminal,
				);
				if (agentId) sessionNameSyncer.syncAgentOnFocus(agentId);
			}
			// Sync terminal that gained focus (catch titles set while user was away)
			if (terminal) {
				const agentId = terminalController.findAgentIdByTerminal(terminal);
				if (agentId) sessionNameSyncer.syncAgentOnFocus(agentId);
			}
			previousActiveTerminal = terminal ?? undefined;
		}),
	);

	const config = vscode.workspace.getConfiguration("agentSpace");
	if (config.get("syncSessionNames", config.get("autoNameAgents", true))) {
		sessionNameSyncer.start(projectManager);
		sessionNameSyncer.syncAll();
	}
	context.subscriptions.push({ dispose: () => sessionNameSyncer.dispose() });

	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.syncSessionNames", () => {
			sessionNameSyncer.syncAll();
		}),
	);

	projectManager.onChange(() => {
		sidebarProvider.refresh();
		homeSidebarProvider.refresh();
		const home = HomePanel.getInstance();
		if (home) home.refresh();
	});

	// Command: Open Home
	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.openHome", async () => {
			await showAgentSpace();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.openProject",
			async (projectId?: string) => {
				if (!projectId) return;
				const panel = ensureHomePanel();
				panel.showProject(projectId);
				await workspaceIsolation.enter();
			},
		),
		vscode.commands.registerCommand(
			"agentSpace.openProjectSettings",
			async (projectId?: string) => {
				if (!projectId) return;
				const panel = ensureHomePanel();
				panel.showProjectSettings(projectId);
				await workspaceIsolation.enter();
			},
		),
	);

	// Command: New Feature
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.newFeature",
			async (projectIdArg?: string) => {
				let projectId = projectIdArg;

				// If no projectId provided, resolve it
				if (!projectId) {
					const projects = projectManager.getProjects();
					if (projects.length === 0) {
						vscode.window.showWarningMessage(
							"No projects registered. Add a project first.",
						);
						return;
					}
					if (projects.length === 1) {
						projectId = projects[0].id;
					} else {
						const pick = await vscode.window.showQuickPick(
							projects.map((p) => ({
								label: p.name,
								description: p.repoPath,
								id: p.id,
							})),
							{ placeHolder: "Select project for new feature" },
						);
						if (!pick) return;
						projectId = pick.id;
					}
				}

				const ctx = projectManager.getContext(projectId);
				if (!ctx) return;

				if (!(await isGitRepoAsync(ctx.project.repoPath))) {
					vscode.window.showErrorMessage(
						`"${ctx.project.name}" is not a Git repository.`,
					);
					return;
				}

				const name = await vscode.window.showInputBox({
					prompt: "Feature name",
					placeHolder: "Auth system",
					validateInput: validateFeatureNameInput,
				});
				if (!name) return;

				// Project-declared branch kinds → ask which prefix to use
				// (e.g. feature/ vs fix/), otherwise the project default.
				let branchKind: string | undefined;
				const branchKinds = ctx.featureManager.getBranchKinds();
				if (branchKinds.length > 1) {
					const kindPick = await vscode.window.showQuickPick(
						branchKinds.map((k) => ({ label: k, value: k })),
						{
							placeHolder: "Branch kind",
							title: `Branch prefix for "${name}"`,
						},
					);
					if (!kindPick) return;
					branchKind = kindPick.value;
				} else if (branchKinds.length === 1) {
					branchKind = branchKinds[0];
				}

				const perAgentEnabled = vscode.workspace
					.getConfiguration("agentSpace")
					.get<boolean>("enablePerAgentIsolation", false);

				let isolation: "shared" | "per-agent" = "shared";
				if (perAgentEnabled) {
					const isolationPick = await vscode.window.showQuickPick(
						[
							{
								label: "Shared worktree",
								description: "All agents share one worktree",
								value: "shared" as const,
							},
							{
								label: "Isolated agents",
								description: "Each agent gets its own worktree",
								value: "per-agent" as const,
							},
						],
						{
							placeHolder: "Agent isolation mode",
						},
					);
					if (!isolationPick) return;
					isolation = isolationPick.value;
				}

				try {
					const feature = ctx.featureManager.createFeature(
						name,
						isolation,
						branchKind,
					);
					activeFeatureId = feature.id;

					const initialTool = toolRegistry.getPreferredAvailableTool(
						ctx.config,
					);
					if (initialTool) {
						const launchNow = await vscode.window.showQuickPick(
							[
								{
									label: `Launch ${initialTool.name} now`,
									description: `Start the agent immediately (uses ${initialTool.name})`,
									value: true as const,
								},
								{
									label: "Create feature without agent",
									description:
										"No tool session is started; add an agent later with 'Add Agent'",
									value: false as const,
								},
							],
							{
								placeHolder: `Launch ${initialTool.name} now?`,
							},
						);
						if (launchNow?.value) {
							ctx.agentManager.createAgent(feature, initialTool.id);
						}
					} else {
						vscode.window.showErrorMessage(
							"Feature created, but no coding tools are available. Add an agent later with 'Add Agent'.",
						);
					}
					sidebarProvider.refresh();
					await activateFeatureInCurrentWindow(feature.id);
				} catch (err) {
					const msg =
						err instanceof Error ? err.message : "Failed to create feature";
					vscode.window.showErrorMessage(`Create feature failed: ${msg}`);
				}
			},
		),
	);

	// Command: Select Feature
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.selectFeature",
			async (featureId: string) => {
				const resolved = projectManager.resolveFeature(featureId);
				if (!resolved) return;
				await activateFeatureInCurrentWindow(featureId);
			},
		),
	);

	// Command: Open Workspace Panel (now opens HomePanel's Feature Home view)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.openWorkspace",
			async (featureIdArg?: string) => {
				const featureId = featureIdArg ?? activeFeatureId;
				if (!featureId) return;
				await activateFeatureInCurrentWindow(featureId);
			},
		),
	);

	// Command: Add Agent
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.addAgent",
			async (featureIdArg?: string) => {
				const featureId = featureIdArg ?? activeFeatureId;
				if (!featureId) return;

				const resolved = projectManager.resolveFeature(featureId);
				if (!resolved) return;
				const { ctx, feature } = resolved;

				// Tool selection — only show installed tools
				const tools = toolRegistry.getAvailableToolsPreferredFirst(ctx.config);
				const unavailable = toolRegistry.getUnavailableTools(ctx.config);
				const unknown = toolRegistry.getUnknownProjectAgentIds(ctx.config);
				const configuredDefault = ctx.config.agents?.default;
				if (
					configuredDefault &&
					!tools.some((tool) => tool.id === configuredDefault)
				) {
					vscode.window.showWarningMessage(
						`Project default agent "${configuredDefault}" is unavailable; no other executable will be selected automatically.`,
					);
				}
				if (unavailable.length > 0) {
					vscode.window.showInformationMessage(
						`Project agents unavailable on PATH: ${unavailable.map((tool) => tool.id).join(", ")}.`,
					);
				}
				if (unknown.length > 0) {
					vscode.window.showWarningMessage(
						`Project agents are not registered in this installation: ${unknown.join(", ")}.`,
					);
				}
				if (tools.length === 0) {
					vscode.window.showErrorMessage(
						`No coding tools found on PATH. Install one of: ${toolRegistry
							.getTools()
							.map((t) => t.command)
							.join(", ")}.`,
					);
					return;
				}

				const defaultToolId = toolRegistry.getDefaultToolId();
				const toolPick = await vscode.window.showQuickPick(
					tools.map((t) => ({
						label: t.name,
						description: t.id === defaultToolId ? "(default)" : undefined,
						toolId: t.id,
					})),
					{ placeHolder: "Select coding tool" },
				);
				if (!toolPick) return;

				try {
					const agents = ctx.agentManager.getAgents(featureId);
					const agent = ctx.agentManager.createAgent(feature, toolPick.toolId);
					terminalController.createTerminal(feature, agent, agents.length);
					sidebarProvider.refresh();
					const home = HomePanel.getInstance();
					if (home) home.refresh();
				} catch (err) {
					const message =
						err instanceof Error ? err.message : "Failed to create agent";
					vscode.window.showErrorMessage(`Add agent failed: ${message}`);
				}
			},
		),
	);

	// Command: Add Service
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.addService",
			async (featureIdArg?: string) => {
				const featureId = featureIdArg ?? activeFeatureId;
				if (!featureId) return;

				const resolved = projectManager.resolveFeature(featureId);
				if (!resolved) return;
				const { ctx, feature } = resolved;

				const { detectScripts } = await import("./services/scriptDetector");
				const scripts = detectScripts(feature.worktreePath);
				const picks: Array<{
					label: string;
					description: string;
					serviceName: string;
					serviceCommand: string;
					launchCommand: string | null;
				}> = [
					{
						label: "$(terminal) Open Terminal",
						description: "Start an interactive shell in this worktree",
						serviceName: "Terminal",
						serviceCommand: "Interactive shell",
						launchCommand: null,
					},
					...scripts.map((s) => ({
						label: s.name,
						description: s.command,
						serviceName: s.name,
						serviceCommand: s.command,
						launchCommand: s.command,
					})),
				];

				const pick = await vscode.window.showQuickPick(picks, {
					placeHolder: "Start a service in this worktree",
				});
				if (!pick) return;

				const service = ctx.serviceManager.createService(
					featureId,
					pick.serviceName,
					pick.serviceCommand,
					pick.launchCommand,
				);
				if (
					!terminalController.createServiceTerminal(
						feature,
						service,
						feature.worktreePath,
					)
				) {
					ctx.serviceManager.stopService(service.id, featureId);
				}
				sidebarProvider.refresh();
				const home = HomePanel.getInstance();
				if (home) home.refresh();
			},
		),
	);

	// Command: Close Agent ("Job Done")
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.closeAgent",
			async (featureIdArg?: string, agentIdArg?: string) => {
				if (!featureIdArg || !agentIdArg) return;

				const resolved = projectManager.resolveFeature(featureIdArg);
				if (!resolved) return;
				const { ctx, feature } = resolved;

				const agents = ctx.agentManager.getAgents(featureIdArg);
				const agent = agents.find((a) => a.id === agentIdArg);
				if (!agent) return;

				// For per-agent worktree, check if branch is merged
				if (
					agent.worktreePath &&
					!ctx.agentManager.isAgentBranchMerged(agent, feature)
				) {
					const proceed = await vscode.window.showWarningMessage(
						"This agent's branch has unmerged work. Close anyway?",
						"Close Anyway",
						"Cancel",
					);
					if (proceed !== "Close Anyway") return;
				}

				terminalController.killAgentTerminal(agentIdArg, featureIdArg);
				ctx.agentManager.closeAgent(agentIdArg, featureIdArg);
				sidebarProvider.refresh();
				const home = HomePanel.getInstance();
				if (home) home.refresh();
			},
		),
	);

	// Command: Delete Agent
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.deleteAgent",
			async (featureIdArg?: string, agentIdArg?: string) => {
				if (!featureIdArg || !agentIdArg) return;

				const resolved = projectManager.resolveFeature(featureIdArg);
				if (!resolved) return;
				const { ctx } = resolved;

				const agents = ctx.agentManager.getAgents(featureIdArg);
				const agent = agents.find((a) => a.id === agentIdArg);
				if (!agent) return;

				const confirm = await vscode.window.showWarningMessage(
					`Delete agent "${agent.name}"? This will permanently remove the agent and kill its session.`,
					{ modal: true },
					"Delete",
				);
				if (confirm !== "Delete") return;

				// Fail-closed: refuse when the agent's worktree would lose work.
				if (agent.worktreePath) {
					const safety = checkWorktreeDeletionSafety({
						repoRoot: ctx.project.repoPath,
						worktreeBase: ctx.featureManager.getWorktreeBase(),
						worktreePath: agent.worktreePath,
					});
					if (!safety.safe) {
						const choice = await vscode.window.showWarningMessage(
							`Cannot delete agent "${agent.name}" safely:\n\n${safety.reasons.join("\n\n")}\n\nForce deletion may lose work.`,
							{ modal: true },
							"Delete Anyway (force)",
							"Cancel",
						);
						if (choice !== "Delete Anyway (force)") return;
					}
				}

				terminalController.killAgentTerminal(agentIdArg, featureIdArg);
				ctx.agentManager.deleteAgent(agentIdArg, featureIdArg);
				sidebarProvider.refresh();
				const home = HomePanel.getInstance();
				if (home) home.refresh();
			},
		),
	);

	// Command: Reopen Agent
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.reopenAgent",
			(featureIdArg?: string, agentIdArg?: string) => {
				if (!featureIdArg || !agentIdArg) return;

				const resolved = projectManager.resolveFeature(featureIdArg);
				if (!resolved) return;
				const { ctx, feature } = resolved;

				const agent = ctx.agentManager.reopenAgent(agentIdArg, feature);
				if (!agent) {
					vscode.window.showErrorMessage(
						"Failed to reopen agent. Check that its worktree and branch are still available.",
					);
					return;
				}

				const agents = ctx.agentManager.getAgents(featureIdArg);
				const agentIndex = agents.findIndex((a) => a.id === agentIdArg);
				terminalController.createTerminal(feature, agent, agentIndex, true);
				sidebarProvider.refresh();
				const home = HomePanel.getInstance();
				if (home) home.refresh();
			},
		),
	);

	// Command: Toggle Isolation Mode (requires enablePerAgentIsolation)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.toggleIsolation",
			(featureIdArg?: string) => {
				if (!featureIdArg) return;
				if (ProjectManager.isBaseFeatureId(featureIdArg)) return;

				const perAgentEnabled = vscode.workspace
					.getConfiguration("agentSpace")
					.get<boolean>("enablePerAgentIsolation", false);
				if (!perAgentEnabled) return;

				const ctx = projectManager.findContextByFeatureId(featureIdArg);
				if (!ctx) return;

				const feature = ctx.featureManager.getFeature(featureIdArg);
				if (!feature) return;

				const newIsolation =
					feature.isolation === "shared" ? "per-agent" : "shared";
				ctx.featureManager.updateFeatureIsolation(featureIdArg, newIsolation);
				sidebarProvider.refresh();
			},
		),
	);

	// Command: Delete Feature
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.deleteFeature",
			async (featureIdArg?: string) => {
				const featureId = featureIdArg ?? activeFeatureId;
				if (!featureId) return;
				if (ProjectManager.isBaseFeatureId(featureId)) return;

				const ctx = projectManager.findContextByFeatureId(featureId);
				if (!ctx) return;

				const feature = ctx.featureManager.getFeature(featureId);
				if (!feature) return;

				// Fail-closed: show a first confirmation naming the worktree.
				const confirm = await vscode.window.showWarningMessage(
					`Delete feature "${feature.name}"?\n\nWorktree: ${feature.worktreePath}\n\nThis removes the worktree and all agent data.`,
					{ modal: true },
					"Delete",
				);
				if (confirm !== "Delete") return;

				// Check every worktree (feature + per-agent) for loss risk.
				const blockers = collectFeatureDeletionBlockers(ctx, feature);
				if (blockers.length > 0) {
					const choice = await vscode.window.showWarningMessage(
						`Cannot delete "${feature.name}" safely:\n\n${blockers.join("\n\n")}\n\nForce deletion may lose work.`,
						{ modal: true },
						"Delete Anyway (force)",
						"Cancel",
					);
					if (choice !== "Delete Anyway (force)") return;
				}

				sessionNameSyncer.clearFeature(featureId);
				terminalController.killFeatureTerminals(featureId);
				ctx.serviceManager.deleteAllServices(featureId);
				ctx.agentManager.deleteAllAgents(featureId);
				ctx.featureManager.deleteFeature(featureId, {
					force: blockers.length > 0,
				});
				sidebarProvider.refresh();

				if (activeFeatureId === featureId) {
					activeFeatureId = null;
				}
				const home = HomePanel.getInstance();
				if (home) home.showWelcome();
			},
		),
	);

	// Command: Create PR
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.openFeatureGitView",
			async (featureIdArg?: string) => {
				await openFeatureGitView(
					featureIdArg,
					activeFeatureId,
					(featureId) => projectManager.resolveFeature(featureId)?.feature,
					globalStore,
					(worktreePath) =>
						vscode.commands.executeCommand(
							"vscode.openFolder",
							vscode.Uri.file(worktreePath),
							{ forceNewWindow: true },
						),
				);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.bootstrapFeature",
			async (featureIdArg?: string) => {
				let featureId = featureIdArg ?? activeFeatureId;
				if (!featureId) {
					const features = projectManager.getAllContexts().flatMap((ctx) =>
						ctx.featureManager.getFeatures().map((feature) => ({
							label: `${ctx.project.name} / ${feature.name}`,
							description: feature.worktreePath,
							featureId: feature.id,
						})),
					);
					const picked = await vscode.window.showQuickPick(features, {
						placeHolder: "Select a feature worktree to bootstrap",
					});
					if (!picked) return;
					featureId = picked.featureId;
				}

				const resolved = projectManager.resolveFeature(featureId);
				if (!resolved) return;
				const commands = resolved.ctx.featureManager.getBootstrapCommands();
				if (commands.length === 0) {
					vscode.window.showInformationMessage(
						"No bootstrapCommands are configured for this project.",
					);
					return;
				}

				const output = vscode.window.createOutputChannel(
					`Agent Space Bootstrap: ${resolved.feature.name}`,
				);
				output.show(true);
				output.appendLine(
					`Bootstrap worktree: ${resolved.feature.worktreePath}`,
				);
				await runBootstrapCommands(
					commands,
					resolved.feature.worktreePath,
					output,
				);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.inspectWorktrees", () => {
			const output = vscode.window.createOutputChannel(
				"Agent Space Worktree Diagnostics",
			);
			output.clear();
			for (const ctx of projectManager.getAllContexts()) {
				output.appendLine(`Project: ${ctx.project.name}`);
				const diagnostics = ctx.featureManager.inspectFeatureLifecycle();
				if (diagnostics.length === 0) {
					output.appendLine("  No persisted feature worktrees.");
					continue;
				}
				for (const diagnostic of diagnostics) {
					const branch = diagnostic.actualBranch
						? ` actual=${diagnostic.actualBranch}`
						: "";
					output.appendLine(
						`  ${diagnostic.status} ${diagnostic.featureId} declared=${diagnostic.declaredBranch}${branch} path=${diagnostic.featurePath}`,
					);
				}
			}
			output.appendLine("No Git or metadata changes were made.");
			output.show(true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.inspectTmuxSessions", () => {
			const output = vscode.window.createOutputChannel(
				"Agent Space tmux Diagnostics",
			);
			const tracked = new Map<string, string[]>();
			for (const ctx of projectManager.getAllContexts()) {
				for (const feature of ctx.featureManager.getFeatures()) {
					for (const agent of ctx.agentManager.getAgents(feature.id)) {
						if (!agent.tmuxSession) continue;
						const owners = tracked.get(agent.tmuxSession) ?? [];
						owners.push(`${ctx.project.name}/${feature.name}/${agent.name}`);
						tracked.set(agent.tmuxSession, owners);
					}
					for (const service of ctx.serviceManager.getServices(feature.id)) {
						const owners = tracked.get(service.tmuxSession) ?? [];
						owners.push(
							`${ctx.project.name}/${feature.name}/service:${service.name}`,
						);
						tracked.set(service.tmuxSession, owners);
					}
				}
			}

			const live = new Set(projectManager.listTmuxSessions());
			output.clear();
			for (const session of [...live].sort()) {
				const owners = tracked.get(session);
				if (!owners) {
					output.appendLine(`untracked ${session}`);
					continue;
				}
				const state = owners.length > 1 ? "conflict" : "tracked";
				output.appendLine(`${state} ${session} owners=${owners.join(",")}`);
			}
			for (const [session, owners] of tracked) {
				if (!live.has(session)) {
					output.appendLine(`missing ${session} owners=${owners.join(",")}`);
				}
			}
			output.appendLine(
				"No tmux session was stopped, renamed, or otherwise modified.",
			);
			output.show(true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.createPR",
			async (featureIdArg?: string) => {
				const featureId = featureIdArg ?? activeFeatureId;
				if (!featureId) return;
				if (ProjectManager.isBaseFeatureId(featureId)) return;

				const ctx = projectManager.findContextByFeatureId(featureId);
				if (!ctx) return;

				const feature = ctx.featureManager.getFeature(featureId);
				if (!feature) return;

				try {
					// Target the project's configured base branch (e.g.
					// v2_ia_first), never an implicit main.
					const baseBranch = ctx.featureManager.getBaseBranchName();
					await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: `Pushing "${feature.branch}"...`,
							cancellable: false,
						},
						async () => {
							// Push the feature from its worktree. Do not alter branch
							// tracking metadata: it describes Git tracking, not PR base.
							await execAsync(`git push origin "${feature.branch}"`, {
								cwd: feature.worktreePath,
							});
						},
					);
					const remote = await execAsync("git remote get-url origin", {
						cwd: feature.worktreePath,
					});
					const compareUrl = buildGitHubCompareUrl(
						remote.stdout,
						baseBranch,
						feature.branch,
					);
					if (!compareUrl) {
						vscode.window.showErrorMessage(
							"Create PR requires a GitHub origin remote to open the configured base comparison.",
						);
						return;
					}

					const nativeCreateCommand = "pr.create";
					const nativeCreateAvailable = (
						await vscode.commands.getCommands(true)
					).includes(nativeCreateCommand);
					if (nativeCreateAvailable) {
						const baseMetadata = buildGitHubPullRequestBaseMetadata(
							remote.stdout,
							baseBranch,
						);
						if (baseMetadata) {
							// The GitHub PR extension reads this dedicated metadata when
							// selecting the base. It is intentionally separate from Git
							// branch tracking metadata. Best-effort: a failure here must
							// not block opening the PR creation flow.
							try {
								await execFileAsync(
									"git",
									[
										"config",
										`branch.${feature.branch}.github-pr-base-branch`,
										baseMetadata,
									],
									{ cwd: feature.worktreePath },
								);
							} catch {
								// Ignore: the native editor still opens, just without the
								// base branch pre-selected.
							}
						}
						try {
							// { repoPath, compareBranch } matches the argument shape
							// microsoft/vscode-pull-request-github's own internal callers
							// pass to `pr.create`, but it is not a documented/stable API.
							// If a future version of that extension resolves this command
							// without honoring compareBranch as expected, this call
							// succeeds silently and the catch below never fires.
							await vscode.commands.executeCommand(nativeCreateCommand, {
								repoPath: feature.worktreePath,
								compareBranch: feature.branch,
							});
							vscode.window.showInformationMessage(
								`Branch "${feature.branch}" pushed. Opening the GitHub Pull Requests editor.`,
							);
							return;
						} catch {
							// Fall through to the manual comparison below: the branch is
							// already pushed, so the user can still open and submit a PR.
						}
					}

					// Keep the explicit comparison as a fallback when the native
					// GitHub Pull Requests integration is unavailable or fails to open.
					vscode.window.showInformationMessage(
						`Branch "${feature.branch}" pushed. Opening GitHub comparison "${baseBranch}...${feature.branch}" — verify and submit the PR manually.`,
					);
					await vscode.env.openExternal(vscode.Uri.parse(compareUrl));
				} catch (err) {
					const msg =
						err instanceof Error ? err.message : "Failed to push branch";
					vscode.window.showErrorMessage(`Create PR failed: ${msg}`);
				}
			},
		),
	);

	// Command: Add Project
	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.addProject", async () => {
			const uris = await vscode.window.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				openLabel: "Add Project",
			});
			if (!uris || uris.length === 0) return;

			const repoPath = uris[0].fsPath;
			if (!(await isGitRepoAsync(repoPath))) {
				vscode.window.showErrorMessage(
					"Selected folder is not a Git repository.",
				);
				return;
			}

			try {
				const project = projectManager.addProject(repoPath);
				const projectContext = projectManager.getContext(project.id);
				if (!projectContext?.config.agents) {
					const availableTools = toolRegistry.getAvailableTools();
					if (availableTools.length > 0) {
						const selectedTools = await vscode.window.showQuickPick(
							availableTools.map((tool) => ({
								label: tool.name,
								description: tool.command,
								picked: true,
								toolId: tool.id,
							})),
							{
								canPickMany: true,
								placeHolder: "Select coding tools exposed by this project",
								title: `Configure agents for ${project.name}`,
							},
						);

						if (selectedTools && selectedTools.length > 0) {
							const defaultTool = await vscode.window.showQuickPick(
								selectedTools.map((tool) => ({
									label: tool.label,
									description: tool.description,
									toolId: tool.toolId,
								})),
								{
									placeHolder: "Select the default coding tool",
									title: `Default agent for ${project.name}`,
								},
							);

							if (defaultTool) {
								projectManager.updateProjectConfig(project.id, {
									agents: {
										enabled: selectedTools.map((tool) => tool.toolId),
										default: defaultTool.toolId,
									},
								});
							}
						}
					}
				}
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "Failed to add project";
				vscode.window.showErrorMessage(msg);
			}
		}),
	);

	// Command: Edit project base branch
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"agentSpace.editProjectBaseBranch",
			async (projectId?: string) => {
				let selectedProjectId = projectId;
				if (!selectedProjectId) {
					const projects = projectManager.getProjects();
					if (projects.length === 0) {
						vscode.window.showInformationMessage("No projects registered.");
						return;
					}
					const pick = await vscode.window.showQuickPick(
						projects.map((project) => ({
							label: project.name,
							description: project.repoPath,
							id: project.id,
						})),
						{ placeHolder: "Select project to edit" },
					);
					if (!pick) return;
					selectedProjectId = pick.id;
				}

				const context = projectManager.getContext(selectedProjectId);
				if (!context) return;

				const current = context.config.baseBranch?.trim() ?? "";
				const value = await vscode.window.showInputBox({
					title: `Base branch for ${context.project.name}`,
					value: current || context.featureManager.getBaseBranchName(),
					prompt:
						"Enter a local or origin branch. Leave empty to use the current checkout.",
					placeHolder: "main",
					validateInput: async (input) => {
						const branch = input.trim();
						if (!branch) return undefined;
						return (await branchExistsAsync(context.project.repoPath, branch))
							? undefined
							: "Branch not found locally or on origin.";
					},
				});
				if (value === undefined) return;

				const branch = value.trim();
				if (
					branch &&
					!(await ensureLocalBranchAsync(context.project.repoPath, branch))
				) {
					vscode.window.showErrorMessage(
						`Branch "${branch}" is no longer available locally or on origin.`,
					);
					return;
				}

				const config = projectManager.updateProjectConfig(selectedProjectId, {
					baseBranch: branch || undefined,
				});
				if (config) {
					const effective = projectManager
						.getContext(selectedProjectId)
						?.featureManager.getBaseBranchName();
					vscode.window.showInformationMessage(
						`Base branch for ${context.project.name}: ${effective}`,
					);
				}
			},
		),
	);

	// Command: Remove Project
	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.removeProject", async () => {
			const projects = projectManager.getProjects();
			if (projects.length === 0) {
				vscode.window.showInformationMessage("No projects to remove.");
				return;
			}

			const pick = await vscode.window.showQuickPick(
				projects.map((p) => ({
					label: p.name,
					description: p.repoPath,
					id: p.id,
				})),
				{ placeHolder: "Select project to remove" },
			);
			if (!pick) return;

			const ctx = projectManager.getContext(pick.id);
			const features = ctx?.featureManager.getFeatures() ?? [];
			if (features.length > 0) {
				const choice = await vscode.window.showWarningMessage(
					`Remove project "${pick.label}"? This will kill all tmux sessions for ${features.length} feature${features.length === 1 ? "" : "s"}.`,
					{ modal: true },
					"Unregister Only",
					"Full Delete",
					"Cancel",
				);
				if (!choice || choice === "Cancel") return;

				for (const feature of features) {
					sessionNameSyncer.clearFeature(feature.id);
				}
				projectManager.killProjectSessions(pick.id, terminalController);
				if (choice === "Full Delete") {
					projectManager.deleteProjectFeatureData(pick.id);
				}
			}

			if (activeFeatureId) {
				const activeCtx =
					projectManager.findContextByFeatureId(activeFeatureId);
				if (activeCtx?.project.id === pick.id) {
					activeFeatureId = null;
					const home = HomePanel.getInstance();
					if (home) home.showWelcome();
				}
			}

			projectManager.removeProject(pick.id);
		}),
	);
}

export function deactivate(): void {}

async function isGitRepoAsync(cwd: string): Promise<boolean> {
	return execAsyncSilent("git rev-parse --is-inside-work-tree", { cwd });
}

async function branchExistsAsync(
	cwd: string,
	branch: string,
): Promise<boolean> {
	return (await getBranchRefAsync(cwd, branch)) !== undefined;
}

async function ensureLocalBranchAsync(
	cwd: string,
	branch: string,
): Promise<boolean> {
	const ref = await getBranchRefAsync(cwd, branch);
	if (!ref) return false;
	if (ref === "local") return true;

	try {
		await execFileAsync(
			"git",
			["branch", "--track", branch, `refs/remotes/origin/${branch}`],
			{ cwd },
		);
		return true;
	} catch {
		return (await getBranchRefAsync(cwd, branch)) === "local";
	}
}

async function getBranchRefAsync(
	cwd: string,
	branch: string,
): Promise<"local" | "remote" | undefined> {
	for (const [kind, ref] of [
		["local", `refs/heads/${branch}`],
		["remote", `refs/remotes/origin/${branch}`],
	] as const) {
		try {
			await execFileAsync("git", ["show-ref", "--verify", "--quiet", ref], {
				cwd,
			});
			return kind;
		} catch {
			// Try the next ref.
		}
	}
	return undefined;
}
