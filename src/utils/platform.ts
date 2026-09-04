import {
	type ExecFileSyncOptions,
	type ExecSyncOptions,
	execFileSync,
	execSync,
} from "node:child_process";
import { existsSync } from "node:fs";
import {
	categorizeCommand,
	recordSubprocessCall,
} from "../diagnostics/subprocessCounter";

/**
 * Cross-platform shell abstraction for Agent Space.
 *
 * Centralises all platform-detection, Git Bash discovery, and exec helpers
 * so the rest of the codebase never calls `execSync` directly.
 */

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function isWindows(): boolean {
	return process.platform === "win32";
}

export function isWsl(): boolean {
	return (
		process.platform === "linux" &&
		Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
	);
}

export function runtimeLabel(): string {
	if (isWsl()) return "WSL / Linux extension host";
	if (isWindows()) return "Windows native extension host";
	if (process.platform === "darwin") return "macOS";
	if (process.platform === "linux") return "Linux native";
	return process.platform;
}

// ---------------------------------------------------------------------------
// Git Bash discovery (Windows only, cached)
// ---------------------------------------------------------------------------

let cachedBashPath: string | null | undefined;

export function findGitBash(): string | null {
	if (!isWindows()) {
		return null;
	}

	if (cachedBashPath !== undefined) {
		return cachedBashPath;
	}

	const candidates: string[] = [];

	const programFiles = process.env.PROGRAMFILES;
	if (programFiles) {
		candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
	}

	const programFilesX86 = process.env["PROGRAMFILES(X86)"];
	if (programFilesX86) {
		candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
	}

	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData) {
		candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
	}

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			cachedBashPath = candidate;
			return cachedBashPath;
		}
	}

	cachedBashPath = null;
	return null;
}

/**
 * Reset the cached Git Bash path. Intended for testing only.
 */
export function _resetBashCache(): void {
	cachedBashPath = undefined;
}

// ---------------------------------------------------------------------------
// Command existence check
// ---------------------------------------------------------------------------

const commandExistsCache = new Map<string, boolean>();

export function commandExists(command: string): boolean {
	if (/[^a-zA-Z0-9._-]/.test(command)) {
		return false;
	}

	const cached = commandExistsCache.get(command);
	if (cached !== undefined) {
		return cached;
	}

	let exists = false;

	// On Windows, check inside Git Bash first (tmux lives in MSYS2's PATH,
	// not on the system PATH visible to cmd.exe / "where").
	if (isWindows()) {
		const bashPath = findGitBash();
		if (bashPath) {
			try {
				execSync(`which ${command}`, {
					shell: bashPath,
					stdio: ["ignore", "pipe", "ignore"],
				});
				exists = true;
			} catch {
				// Not found in Git Bash — fall through to "where" check
			}
		}
	}

	if (!exists) {
		const check = isWindows() ? "where" : "which";
		try {
			execSync(`${check} ${command}`, {
				stdio: ["ignore", "pipe", "ignore"],
			});
			exists = true;
		} catch {
			exists = false;
		}
	}

	commandExistsCache.set(command, exists);
	return exists;
}

export function tmuxFunctional(): boolean {
	const session = `agentspace-doctor-${process.pid}-${Date.now()}`;
	try {
		exec(`tmux new-session -d -s ${session}`);
		return execSilent(`tmux has-session -t ${session}`);
	} catch {
		return false;
	} finally {
		execSilent(`tmux kill-session -t ${session}`);
	}
}

/**
 * Reset the cached command existence results. Intended for testing only.
 */
export function _resetCommandExistsCache(): void {
	commandExistsCache.clear();
}

// ---------------------------------------------------------------------------
// Exec helpers
// ---------------------------------------------------------------------------

export function getExecOptions(cwd?: string): ExecSyncOptions {
	const opts: ExecSyncOptions = {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 30_000,
	};

	if (isWindows()) {
		const bashPath = findGitBash();
		if (bashPath) {
			opts.shell = bashPath;
		}
	}

	if (cwd) {
		opts.cwd = cwd;
	}

	return opts;
}

export function exec(cmd: string, opts?: { cwd?: string }): string {
	recordSubprocessCall(categorizeCommand(cmd));
	return execSync(cmd, getExecOptions(opts?.cwd)) as string;
}

export function execFile(
	file: string,
	args: readonly string[],
	opts?: { cwd?: string },
): string {
	recordSubprocessCall(categorizeCommand(file));
	const bashPath = isWindows() ? findGitBash() : null;
	if (bashPath) {
		return execFileSync(bashPath, ["-lc", 'exec "$0" "$@"', file, ...args], {
			...getExecOptions(opts?.cwd),
			shell: false,
		} as ExecFileSyncOptions) as string;
	}

	return execFileSync(file, args, {
		...getExecOptions(opts?.cwd),
		shell: false,
	} as ExecFileSyncOptions) as string;
}

export function execSilent(cmd: string, opts?: { cwd?: string }): boolean {
	try {
		exec(cmd, opts);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Async exec helpers
// ---------------------------------------------------------------------------

type ExecPromiseFn = (
	cmd: string,
	opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let _execPromise: ExecPromiseFn | undefined;

function getExecPromise(): ExecPromiseFn {
	if (!_execPromise) {
		// Lazy init to avoid breaking test mocks that don't include exec
		const { exec: cpExec } = require("node:child_process");
		const { promisify } = require("node:util");
		_execPromise = promisify(cpExec) as ExecPromiseFn;
	}
	return _execPromise;
}

export interface ExecAsyncResult {
	stdout: string;
	stderr: string;
}

export function getExecAsyncOptions(cwd?: string): Record<string, unknown> {
	const opts: Record<string, unknown> = {
		encoding: "utf-8",
		timeout: 30_000,
	};

	if (isWindows()) {
		const bashPath = findGitBash();
		if (bashPath) {
			opts.shell = bashPath;
		}
	}

	if (cwd) {
		opts.cwd = cwd;
	}

	return opts;
}

export function execAsync(
	cmd: string,
	opts?: { cwd?: string } & Record<string, unknown>,
): Promise<ExecAsyncResult> {
	recordSubprocessCall(categorizeCommand(cmd));
	const mergedOpts = { ...getExecAsyncOptions(opts?.cwd), ...opts };
	return getExecPromise()(cmd, mergedOpts);
}

type ExecFileAsyncFn = (
	file: string,
	args: readonly string[],
	opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let _execFileAsync: ExecFileAsyncFn | undefined;

/**
 * Test-only seam: replace or reset the lazily-initialized promisified
 * `execFile`. A top-level import would break tests that mock
 * `node:child_process` without `execFile`; this keeps the lazy init while
 * giving platform.test.ts a way to drive the function directly.
 */
export function _setExecFileAsyncForTest(fn: unknown): void {
	_execFileAsync = fn as ExecFileAsyncFn | undefined;
}

function getExecFileAsync(): ExecFileAsyncFn {
	if (!_execFileAsync) {
		// Lazy init to avoid breaking test mocks that don't include exec
		const { execFile: cpExecFile } = require("node:child_process");
		const { promisify } = require("node:util");
		_execFileAsync = promisify(cpExecFile) as ExecFileAsyncFn;
	}
	return _execFileAsync;
}

/**
 * Non-blocking twin of {@link execFile}. Spawns the process asynchronously
 * so the extension host event loop stays free while it waits — this is the
 * variant reconciliation work must use anywhere it can run off an
 * interactive click path (see `TerminalController.focusOrCreateTerminalAsync`).
 */
export function execFileAsync(
	file: string,
	args: readonly string[],
	opts?: { cwd?: string },
): Promise<ExecAsyncResult> {
	recordSubprocessCall(categorizeCommand(file));
	const bashPath = isWindows() ? findGitBash() : null;
	if (bashPath) {
		return getExecFileAsync()(
			bashPath,
			["-lc", 'exec "$0" "$@"', file, ...args],
			// shell:false keeps execFile a direct argv spawn — without it
			// getExecAsyncOptions' shell:bathPath would wrap the args in an
			// extra shell layer, diverging from the sync execFile twin.
			{ ...getExecAsyncOptions(opts?.cwd), shell: false },
		);
	}

	return getExecFileAsync()(
		file,
		args as string[],
		getExecAsyncOptions(opts?.cwd),
	);
}

export async function execAsyncSilent(
	cmd: string,
	opts?: { cwd?: string },
): Promise<boolean> {
	try {
		await execAsync(cmd, opts);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Terminal shell arguments
// ---------------------------------------------------------------------------

export interface TerminalShellArgs {
	shellPath: string;
	shellArgs: string[];
}

export function getTerminalShellArgs(
	tmuxSessionName: string,
): TerminalShellArgs {
	if (isWindows()) {
		const bashPath = findGitBash();
		if (bashPath) {
			return {
				shellPath: bashPath,
				shellArgs: ["-c", `tmux attach-session -t "${tmuxSessionName}"`],
			};
		}
	}

	// Fallback: direct tmux args. On Windows without Git Bash this is
	// unreachable in practice — the prerequisite checker blocks activation
	// when Git Bash is missing.
	return {
		shellPath: "tmux",
		shellArgs: ["attach-session", "-t", tmuxSessionName],
	};
}
