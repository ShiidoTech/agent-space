import * as path from "node:path";
import * as vscode from "vscode";
import { CodingToolRegistry } from "../agents/codingToolRegistry";
import { loadProjectConfig } from "../projects/projectConfig";
import { GlobalStore } from "../storage/globalStore";
import { Store } from "../storage/store";
import type { Project } from "../types";
import { commandExists } from "../utils/platform";
import type { DoctorAgentProbe, DoctorUnknownAgentIds } from "./doctor";
import { defaultDoctorDeps, runDoctor } from "./doctor";

/**
 * Resolve every persisted agent the way the running extension does, and report
 * what that resolution actually reaches.
 *
 * Read-only throughout: sessions are looked up, never created, adopted or
 * repaired. Doctor's job is to make an unbound agent visible, not to fix it.
 */
function probeAgents(
	storagePath: string,
	projects: Project[],
	toolRegistry: CodingToolRegistry,
): { agents: DoctorAgentProbe[]; unknown: DoctorUnknownAgentIds[] } {
	const agents: DoctorAgentProbe[] = [];
	const unknown: DoctorUnknownAgentIds[] = [];

	for (const project of projects) {
		const config = loadProjectConfig(project.repoPath);
		const unknownIds = toolRegistry.getUnknownProjectAgentIds(config);
		if (unknownIds.length > 0) {
			unknown.push({ projectName: project.name, ids: unknownIds });
		}

		const store = new Store(path.join(storagePath, "projects", project.id));
		const features = store.loadFeatures();
		for (const feature of features) {
			for (const agent of store.loadAgents(feature.id)) {
				const resolution = toolRegistry.describeAgentTool(agent.toolId);
				const adapter = resolution.adapter;

				let sessionResolved: boolean | null = null;
				if (adapter && agent.sessionId) {
					sessionResolved = adapter.hasSession?.(agent.sessionId) ?? null;
				} else if (adapter) {
					sessionResolved = false;
				}

				let attentionEvidence: string | undefined;
				if (agent.sessionId && sessionResolved === true) {
					attentionEvidence = toolRegistry.getStructuredAttentionSignal(
						resolution.tool,
						agent.sessionId,
					)?.evidence;
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
					attentionEvidence,
				});
			}
		}
	}

	return { agents, unknown };
}

export function registerDoctorCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.doctor", async () => {
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
