import { spawn } from "node:child_process";

export interface BootstrapOutput {
	appendLine(value: string): void;
}

export type BootstrapExecutor = (
	command: string,
	cwd: string,
	output: BootstrapOutput,
) => Promise<number | null>;

function executeCommand(
	command: string,
	cwd: string,
	output: BootstrapOutput,
): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(command, {
			cwd,
			shell: true,
		});
		child.stdout?.on("data", (data: Buffer) =>
			output.appendLine(data.toString().trimEnd()),
		);
		child.stderr?.on("data", (data: Buffer) =>
			output.appendLine(data.toString().trimEnd()),
		);
		child.on("error", (error) => {
			output.appendLine(`[error] ${error.message}`);
			resolve(null);
		});
		child.on("close", (code) => resolve(code));
	});
}

export interface BootstrapResult {
	success: boolean;
	completed: string[];
	failedCommand?: string;
	exitCode?: number | null;
}

export async function runBootstrapCommands(
	commands: readonly string[],
	cwd: string,
	output: BootstrapOutput,
	execute: BootstrapExecutor = executeCommand,
): Promise<BootstrapResult> {
	const completed: string[] = [];
	for (const command of commands) {
		output.appendLine(`$ ${command}`);
		const exitCode = await execute(command, cwd, output);
		if (exitCode !== 0) {
			output.appendLine(
				`[failed] command exited with ${exitCode === null ? "an execution error" : `code ${exitCode}`}`,
			);
			return { success: false, completed, failedCommand: command, exitCode };
		}
		completed.push(command);
	}
	output.appendLine("[success] Bootstrap commands finished.");
	return { success: true, completed };
}
