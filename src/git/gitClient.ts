import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { agentSpaceDiagnostic } from "../diagnostics/agentSpaceDiagnostics";

const execFileAsync = promisify(execFile);

export interface GitReadOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
	timeoutMs?: number;
}

export interface GitReadResult {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: Error;
}

export interface GitReader {
	read(
		argv: readonly string[],
		options: GitReadOptions,
	): Promise<GitReadResult>;
	readSync(argv: readonly string[], options: GitReadOptions): GitReadResult;
}

/** Raw, read-only-by-convention Git process execution. Callers supply all argv. */
export class GitClient implements GitReader {
	constructor(private readonly executable = "git") {}

	readSync(argv: readonly string[], options: GitReadOptions): GitReadResult {
		const args = [...argv];
		const startedAt = Date.now();
		const result = spawnSync(this.executable, args, {
			cwd: options.cwd,
			env: options.env,
			encoding: "utf8",
			maxBuffer: options.maxBuffer,
			timeout: options.timeoutMs,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		this.logSlowRead(args, options.cwd, Date.now() - startedAt);

		return {
			argv: args,
			cwd: options.cwd,
			exitCode: result.status,
			signal: result.signal,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			...(result.error ? { error: result.error } : {}),
		};
	}

	async read(
		argv: readonly string[],
		options: GitReadOptions,
	): Promise<GitReadResult> {
		const args = [...argv];
		const startedAt = Date.now();
		try {
			const result = await execFileAsync(this.executable, args, {
				cwd: options.cwd,
				env: options.env,
				encoding: "utf8",
				maxBuffer: options.maxBuffer,
				timeout: options.timeoutMs,
				shell: false,
			});
			this.logSlowRead(args, options.cwd, Date.now() - startedAt);
			return {
				argv: args,
				cwd: options.cwd,
				exitCode: 0,
				signal: null,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		} catch (cause) {
			const error = cause as Error & {
				code?: number | string;
				signal?: NodeJS.Signals;
				stdout?: string;
				stderr?: string;
			};
			this.logSlowRead(args, options.cwd, Date.now() - startedAt);
			return {
				argv: args,
				cwd: options.cwd,
				exitCode: typeof error.code === "number" ? error.code : null,
				signal: error.signal ?? null,
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
				error,
			};
		}
	}

	private logSlowRead(argv: readonly string[], cwd: string, elapsedMs: number): void {
		if (elapsedMs < 500) return;
		agentSpaceDiagnostic(
			`slow Git read ${elapsedMs}ms cwd=${cwd} command=${argv.join(" ")}`,
		);
	}
}

export const defaultGitClient = new GitClient();

export function readGitSync(
	argv: readonly string[],
	options: GitReadOptions,
): GitReadResult {
	return defaultGitClient.readSync(argv, options);
}

export function readGit(
	argv: readonly string[],
	options: GitReadOptions,
): Promise<GitReadResult> {
	return defaultGitClient.read(argv, options);
}
