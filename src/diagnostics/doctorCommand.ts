import * as path from "node:path";
import * as vscode from "vscode";
import { CodingToolRegistry } from "../agents/codingToolRegistry";
import { FeatureManager } from "../features/featureManager";
import {
	loadProjectConfig,
	resolveWorktreeBaseDir,
} from "../projects/projectConfig";
import { GlobalStore } from "../storage/globalStore";
import { Store } from "../storage/store";
import type { Project } from "../types";
import { commandExists, refreshCommandCache } from "../utils/platform";
import type {
	DoctorAgentProbe,
	DoctorUnknownAgentIds,
	StorageHealthInput,
} from "./doctor";
import { defaultDoctorDeps, runDoctor } from "./doctor";

/**
 * Resolve every persisted agent the way the running extension does, and report
 * what that resolution actually reaches.
 *
 * Read-only throughout: sessions are looked up, never created, adopted or
 * repaired. Doctor's job is to make an unbound agent visible, not to fix it.
 */
export function probeAgents(
	storagePath: string,
	projects: Project[],
	toolRegistry: CodingToolRegistry,
): {
	agents: DoctorAgentProbe[];
	unknown: DoctorUnknownAgentIds[];
	storageHealth: StorageHealthInput;
} {
	const agents: DoctorAgentProbe[] = [];
	const unknown: DoctorUnknownAgentIds[] = [];
	const corruptedFiles: string[] = [];
	const tmpOrphans: string[] = [];

	for (const project of projects) {
		const config = loadProjectConfig(project.repoPath);
		const unknownIds = toolRegistry.getUnknownProjectAgentIds(config);
		if (unknownIds.length > 0) {
			unknown.push({ projectName: project.name, ids: unknownIds });
		}

		const store = new Store(path.join(storagePath, "projects", project.id));
		const featureManager = new FeatureManager(
			store,
			project.repoPath,
			resolveWorktreeBaseDir(project.repoPath, config, ".worktrees"),
			config,
		);
		const features = [
			featureManager.getBaseFeature(project.id),
			...store.loadFeatures(),
		];
		corruptedFiles.push(...store.corruptedFiles());
		tmpOrphans.push(...store.tmpOrphans());
		for (const feature of features) {
			for (const agent of store.loadAgents(feature.id)) {
				// Resolve through the agent's frozen profile so a Hermes agent
				// probes the store it actually reads (profiles/<name>), not the
				// default ~/.hermes that describeAgentTool would reach.
				const resolution = toolRegistry.describeAgentToolForAgent(agent);
				const adapter = resolution.adapter;
				const provider = toolRegistry.getProvider
					? toolRegistry.getProvider(resolution.tool)
					: resolution.tool.provider;
				const attentionSupported = provider
					? Object.values(provider.capabilities.attention).some(Boolean)
					: false;
				const attentionCapabilities = provider
					? Object.entries(provider.capabilities.attention)
							.filter(([, supported]) => supported)
							.map(([name]) => name)
					: [];

				let sessionResolved: boolean | null = null;
				if (adapter && agent.sessionId) {
					sessionResolved = adapter.hasSession?.(agent.sessionId) ?? null;
				} else if (adapter) {
					sessionResolved = false;
				}

				let attentionEvidence: string | undefined;
				let attentionObservedAt: string | undefined;
				let attentionState = attentionSupported ? "unknown" : "unsupported";
				if (agent.sessionId && sessionResolved === true) {
					const signal = toolRegistry.getStructuredAttentionSignal(
						resolution.tool,
						agent.sessionId,
						agent.worktreePath,
					);
					attentionEvidence = signal?.evidence;
					attentionObservedAt = signal?.observedAt;
					if (signal) attentionState = signal.status;
				}

				agents.push({
					projectName: project.name,
					featureLabel: feature.branch || feature.name,
					agentName: agent.name,
					toolId: agent.toolId ?? "claude",
					toolDeclared: resolution.declared,
					sessionsDir: resolution.sessionStoreDir,
					sessionId: agent.sessionId,
					bindingState: agent.sessionBinding?.state ?? "unknown",
					bindingDetail: agent.sessionBinding?.detail,
					bindingAttempts: agent.sessionBinding?.attempts,
					sessionResolved,
					lifecycleState: agent.status,
					attentionState,
					attentionSupported,
					attentionEvidence,
					attentionObservedAt,
					attentionCapabilities,
					providerOwnership: provider?.conversationIdentity.ownership,
					sessionNamingSupported: provider?.capabilities.sessionNaming,
					tmuxSession: agent.tmuxSession,
					hermesProfile: agent.hermesProfile,
				});
			}
		}
	}

	return { agents, unknown, storageHealth: { corruptedFiles, tmpOrphans } };
}

export function registerDoctorCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.doctor", async () => {
			// Never report stale tool availability: a CLI installed after
			// activation must be visible to this probe (audit P1-7).
			refreshCommandCache();
			const config = vscode.workspace.getConfiguration("agentSpace");
			const storagePath = context.globalStorageUri.fsPath;
			const globalStore = new GlobalStore(storagePath, {
				migrateLegacy: false,
			});
			const toolRegistry = new CodingToolRegistry();
			const projects = globalStore.getProjects();
			const probed = probeAgents(storagePath, projects, toolRegistry);
			const report = runDoctor(
				{
					extensionId: context.extension.id,
					extensionVersion:
						typeof context.extension.packageJSON?.version === "string"
							? context.extension.packageJSON.version
							: "unknown",
					remoteName: vscode.env.remoteName,
					projects,
					tools: toolRegistry.getTools(),
					defaultToolId: toolRegistry.getDefaultToolId(),
					worktreeBasePath: config.get<string>(
						"worktreeBasePath",
						".worktrees",
					),
					persistencePath: context.globalStorageUri.fsPath,
					perAgentIsolation: config.get<boolean>(
						"enablePerAgentIsolation",
						false,
					),
					syncSessionNames: config.get<boolean>(
						"syncSessionNames",
						config.get<boolean>("autoNameAgents", true),
					),
					agents: probed.agents,
					unknownProjectAgentIds: probed.unknown,
					storageHealth: {
						corruptedFiles: [
							...globalStore.corruptedFiles(),
							...probed.storageHealth.corruptedFiles,
						],
						tmpOrphans: [
							...globalStore.tmpOrphans(),
							...probed.storageHealth.tmpOrphans,
						],
					},
				},
				{ ...defaultDoctorDeps, commandExists },
			);

			const document = await vscode.workspace.openTextDocument({
				content: report.markdown,
				language: "markdown",
			});
			await vscode.window.showTextDocument(document, { preview: false });
		}),
	);
}
