import * as vscode from "vscode";
import {
	commandExists,
	findGitBash,
	isWindows,
	tmuxFunctional,
} from "./utils/platform";

export class PrerequisiteChecker {
	private static readonly REQUIRED_TOOLS = [
		{ name: "tmux", command: "tmux" },
		{ name: "git", command: "git" },
	];

	private static readonly GH_PR_EXTENSION_ID =
		"GitHub.vscode-pull-request-github";

	checkRequired(): { ok: boolean; missing: string[] } {
		if (isWindows() && !findGitBash()) {
			return { ok: false, missing: ["Git for Windows (Git Bash)"] };
		}

		const missing: string[] = [];
		for (const tool of PrerequisiteChecker.REQUIRED_TOOLS) {
			if (
				!commandExists(tool.command) ||
				(tool.command === "tmux" && !tmuxFunctional())
			) {
				missing.push(tool.name);
			}
		}
		return { ok: missing.length === 0, missing };
	}

	showMissingToolsError(missing: string[]): void {
		if (isWindows() && missing.includes("Git for Windows (Git Bash)")) {
			const action = "Download Git for Windows";
			vscode.window
				.showErrorMessage(
					"Agent Space requires Git for Windows (includes Git Bash). Download and reload VS Code.",
					action,
				)
				.then((selected) => {
					if (selected === action) {
						vscode.env.openExternal(
							vscode.Uri.parse("https://gitforwindows.org/"),
						);
					}
				});
			return;
		}

		if (isWindows() && missing.includes("tmux")) {
			const action = "Copy Install Command";
			vscode.window
				.showErrorMessage(
					"Agent Space could not run tmux in the current Windows runtime. Recommended: reopen this repository in VS Code Remote WSL, then install tmux inside WSL.",
					action,
				)
				.then((selected) => {
					if (selected === action) {
						vscode.env.clipboard.writeText(
							"Reopen this repository in VS Code Remote WSL, then install tmux inside WSL.",
						);
						vscode.window.showInformationMessage(
							"Copied the recommended WSL setup guidance to the clipboard.",
						);
					}
				});
			return;
		}

		vscode.window.showErrorMessage(
			`Agent Space requires: ${missing.join(", ")}. Install and reload.`,
		);
	}

	isGhPrExtensionInstalled(): boolean {
		return (
			vscode.extensions.getExtension(PrerequisiteChecker.GH_PR_EXTENSION_ID) !==
			undefined
		);
	}
}
