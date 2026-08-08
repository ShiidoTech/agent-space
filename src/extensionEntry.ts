import type * as vscode from "vscode";
import { registerDoctorCommand } from "./diagnostics/doctorCommand";
import { activate as activateAgentSpace } from "./extension";

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	registerDoctorCommand(context);
	await activateAgentSpace(context);
}
