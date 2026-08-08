import * as vscode from "vscode";
import { CodingToolRegistry } from "../agents/codingToolRegistry";
import { GlobalStore } from "../storage/globalStore";
import { commandExists } from "../utils/platform";
import { defaultDoctorDeps, runDoctor } from "./doctor";

export function registerDoctorCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("agentSpace.doctor", async () => {
			const config = vscode.workspace.getConfiguration("agentSpace");
			const globalStore = new GlobalStore(context.globalStorageUri.fsPath);
			const toolRegistry = new CodingToolRegistry();
			const report = runDoctor(
				{
					extensionId: context.extension.id,
					extensionVersion:
						typeof context.extension.packageJSON?.version === "string"
							? context.extension.packageJSON.version
							: "unknown",
					projects: globalStore.getProjects(),
					tools: toolRegistry.getTools(),
					defaultToolId: toolRegistry.getDefaultToolId(),
					worktreeBasePath: config.get<string>("worktreeBasePath", ".worktrees"),
					perAgentIsolation: config.get<boolean>(
						"enablePerAgentIsolation",
						false,
					),
					syncSessionNames: config.get<boolean>(
						"syncSessionNames",
						config.get<boolean>("autoNameAgents", true),
					),
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
