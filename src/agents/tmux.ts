import {
	commandExists,
	exec,
	execAsync,
	execFile,
	execFileAsync,
} from "../utils/platform";

export const TMUX_SESSION_PREFIX = "agent-space";
export const LEGACY_TMUX_SESSION_PREFIX = "companion";

export type TmuxSessionsObservation =
	| { readonly status: "known"; readonly sessions: readonly string[] }
	| { readonly status: "unknown"; readonly detail: string };

function noTmuxSessionsAreRunning(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as {
		status?: unknown;
		stderr?: unknown;
		message?: unknown;
	};
	if (candidate.status !== 1) return false;
	const stderr = Buffer.isBuffer(candidate.stderr)
		? candidate.stderr.toString("utf8")
		: typeof candidate.stderr === "string"
			? candidate.stderr
			: "";
	const evidence = `${stderr}\n${typeof candidate.message === "string" ? candidate.message : ""}`;
	return /\b(?:no server running|no sessions)\b/iu.test(evidence);
}

/**
 * Replace characters that tmux interprets as target-specification separators.
 * `:` delimits session:window and `.` delimits window.pane — both break
 * `-t` lookups when they appear inside a session name.
 */
function sanitizeSessionName(name: string): string {
	return name.replace(/[:./]/g, "_");
}

export class TmuxIntegration {
	private nativeScrollConfigured = false;

	sessionName(featureId: string, agentId: string): string {
		return sanitizeSessionName(
			`${TMUX_SESSION_PREFIX}-${featureId}-${agentId}`,
		);
	}

	serviceSessionName(featureId: string, serviceId: string): string {
		return sanitizeSessionName(
			`${TMUX_SESSION_PREFIX}-svc-${featureId}-${serviceId}`,
		);
	}

	legacySessionName(featureId: string, agentId: string): string {
		return sanitizeSessionName(
			`${LEGACY_TMUX_SESSION_PREFIX}-${featureId}-${agentId}`,
		);
	}

	legacyServiceSessionName(featureId: string, serviceId: string): string {
		return sanitizeSessionName(
			`${LEGACY_TMUX_SESSION_PREFIX}-svc-${featureId}-${serviceId}`,
		);
	}

	isAvailable(): boolean {
		return commandExists("tmux");
	}

	async isAvailableAsync(): Promise<boolean> {
		try {
			await execFileAsync("tmux", ["-V"]);
			return true;
		} catch {
			return false;
		}
	}

	isSessionAlive(sessionName: string): boolean {
		try {
			execFile("tmux", ["has-session", "-t", sessionName]);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Non-blocking twin of {@link isSessionAlive}. Used by reconciliation
	 * paths that must not run synchronous tmux discovery on the interactive
	 * click path (see `TerminalController.focusOrCreateTerminalAsync`).
	 */
	async isSessionAliveAsync(sessionName: string): Promise<boolean> {
		try {
			await execFileAsync("tmux", ["has-session", "-t", sessionName]);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Non-blocking twin of {@link adoptSession}. Preserves the exact same
	 * fail-closed ownership semantics — it never adopts a session unless the
	 * preferred name is free and the legacy/current name is the only live
	 * candidate — it just performs the discovery asynchronously.
	 */
	async adoptSessionAsync(
		preferredName: string,
		currentName: string,
	): Promise<boolean> {
		if (preferredName === currentName) {
			return this.isSessionAliveAsync(preferredName);
		}

		// Both probes are independent — run them concurrently to halve the
		// cold-path latency instead of serializing two tmux round trips.
		const [preferredAlive, currentAlive] = await Promise.all([
			this.isSessionAliveAsync(preferredName),
			this.isSessionAliveAsync(currentName),
		]);

		if (preferredAlive) {
			if (currentAlive) {
				return false;
			}
			return true;
		}

		if (!currentAlive) {
			return false;
		}

		try {
			await execAsync(
				`tmux rename-session -t "${currentName}" "${preferredName}"`,
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Revert one session to the ordinary "session dies with its pane" behavior
	 * once startup diagnostics for it are no longer needed. A CLI that crashes
	 * later, mid-conversation, must still make the whole session disappear so
	 * the existing close detection (the VS Code terminal's `tmux attach`
	 * exiting, firing `onDidCloseTerminal`) keeps working — a dead pane that
	 * lingers forever under the server-wide default would silently stop that.
	 */
	clearRemainOnExitForSession(sessionName: string): void {
		try {
			exec(`tmux set-option -t "${sessionName}" remain-on-exit off`);
		} catch {
			// Session may not exist
		}
	}

	async clearRemainOnExitForSessionAsync(sessionName: string): Promise<void> {
		try {
			await execAsync(`tmux set-option -t "${sessionName}" remain-on-exit off`);
		} catch {
			// Session may not exist
		}
	}

	configureSession(sessionName: string): void {
		try {
			exec(`tmux set-option -t "${sessionName}" status off`);
			exec(`tmux set-option -t "${sessionName}" mouse on`);
			this.ensureNativeScroll();
		} catch {
			// Session may not exist
		}
	}

	async configureSessionAsync(sessionName: string): Promise<void> {
		try {
			await Promise.all([
				execAsync(`tmux set-option -t "${sessionName}" status off`),
				execAsync(`tmux set-option -t "${sessionName}" mouse on`),
			]);
			await this.ensureNativeScrollAsync();
		} catch {
			// Session may not exist
		}
	}

	private async ensureNativeScrollAsync(): Promise<void> {
		if (this.nativeScrollConfigured) return;
		try {
			const overrides = (await execAsync("tmux show -sv terminal-overrides"))
				.toString()
				.trim();
			if (!overrides.includes("smcup@")) {
				await execAsync(
					'tmux set -sa terminal-overrides ",*:smcup@:rmcup@:XM@"',
				);
			}
			this.nativeScrollConfigured = true;
		} catch {
			// Ignore — server may not be ready
		}
	}

	/**
	 * Disable alternate-screen mode (smcup/rmcup) and mouse-tracking
	 * pass-through (XM) on the outer terminal so that VS Code's xterm.js
	 * keeps its normal scrollback buffer and handles scroll-wheel events
	 * natively instead of forwarding them as input to the CLI tool.
	 */
	private ensureNativeScroll(): void {
		if (this.nativeScrollConfigured) {
			return;
		}
		try {
			const overrides = exec("tmux show -sv terminal-overrides").trim();
			if (!overrides.includes("smcup@")) {
				exec('tmux set -sa terminal-overrides ",*:smcup@:rmcup@:XM@"');
			}
			this.nativeScrollConfigured = true;
		} catch {
			// Ignore — server may not be ready
		}
	}

	configureServiceSession(sessionName: string): void {
		this.configureSession(sessionName);
		try {
			exec(`tmux set-option -t "${sessionName}" remain-on-exit on`);
		} catch {
			// Session may not exist
		}
	}

	/**
	 * Check if the pane process in a session has exited.
	 * Returns null if session doesn't exist, otherwise { dead, exitCode }.
	 */
	getPaneStatus(
		sessionName: string,
	): { dead: boolean; exitCode: number } | null {
		try {
			const output = exec(
				`tmux display-message -t "${sessionName}" -p "#{pane_dead} #{pane_dead_status}"`,
			).trim();
			const [deadStr, codeStr] = output.split(" ");
			return {
				dead: deadStr === "1",
				exitCode: Number.parseInt(codeStr ?? "0", 10),
			};
		} catch {
			return null;
		}
	}

	/**
	 * Non-blocking twin of {@link getPaneStatus}. Used by background
	 * observation paths (attention monitoring) that must never block the
	 * Extension Host on a synchronous tmux round trip.
	 */
	async getPaneStatusAsync(
		sessionName: string,
	): Promise<{ dead: boolean; exitCode: number } | null> {
		try {
			const output = (
				await execAsync(
					`tmux display-message -t "${sessionName}" -p "#{pane_dead} #{pane_dead_status}"`,
				)
			)
				.toString()
				.trim();
			const [deadStr, codeStr] = output.split(" ");
			return {
				dead: deadStr === "1",
				exitCode: Number.parseInt(codeStr ?? "0", 10),
			};
		} catch {
			return null;
		}
	}

	/**
	 * The pty device path of the session's pane (e.g. `/dev/pts/5`). Mirrors
	 * the tty Hermes reads with `os.ttyname()` inside the pane, so Agent Space
	 * can derive the exact Hermes breadcrumb terminal id for this agent's own
	 * pane — the deterministic, fail-closed Hermes identity link.
	 * Returns null when the session is gone or has no pane tty.
	 */
	getPaneTty(sessionName: string): string | null {
		try {
			const output = exec(
				`tmux display-message -t "${sessionName}" -p "#{pane_tty}"`,
			).trim();
			return output || null;
		} catch {
			return null;
		}
	}

	/**
	 * Non-blocking twin of {@link getPaneTty} for background observation
	 * paths that must never block the Extension Host on a subprocess.
	 */
	async getPaneTtyAsync(sessionName: string): Promise<string | null> {
		try {
			const output = (
				await execAsync(
					`tmux display-message -t "${sessionName}" -p "#{pane_tty}"`,
				)
			)
				.toString()
				.trim();
			return output || null;
		} catch {
			return null;
		}
	}

	/**
	 * Create the session and mark its own pane `remain-on-exit` in the same
	 * tmux invocation, chained with `\;` so the server processes both as one
	 * client request. That keeps a pane whose command crashes almost
	 * immediately (e.g. the CLI binary is missing) around as a dead pane
	 * instead of tearing the session down before anything could read its exit
	 * code or output — without ever touching the server-wide `-g` default,
	 * which would otherwise change `remain-on-exit` for every tmux session on
	 * the machine, including ones outside Agent Space.
	 */
	createCommand(sessionName: string, innerCommand: string): string {
		return `tmux new-session -d -s "${sessionName}" "${innerCommand}" \\; set-option -t "${sessionName}" remain-on-exit on`;
	}

	/**
	 * Replace the running command in an existing session's pane in place,
	 * keeping the same tmux session (and therefore the same VS Code terminal
	 * attached to it) rather than killing and recreating it. Used to reconnect
	 * a live `opencode attach` pane to a replacement backend without dropping
	 * the terminal the user has open. Runtime restoration uses this only for
	 * providers whose native process must be restarted; a live direct OpenCode
	 * pane is treated as already survived.
	 *
	 * Throws if the session does not exist or `respawn-pane` fails — callers
	 * that want a kill/recreate fallback must catch and do so explicitly;
	 * this primitive never falls back on its own.
	 */
	async respawnSessionCommandAsync(
		sessionName: string,
		innerCommand: string,
		cwd?: string,
	): Promise<void> {
		const cwdFlag = cwd ? `-c "${cwd}" ` : "";
		await execAsync(
			`tmux respawn-pane -k ${cwdFlag}-t "${sessionName}" "${innerCommand}"`,
		);
	}

	createShellCommand(sessionName: string): string {
		return `tmux new-session -d -s "${sessionName}"`;
	}

	attachCommand(sessionName: string): string {
		return `tmux attach-session -t "${sessionName}"`;
	}

	listSessions(): string[] {
		try {
			return exec('tmux list-sessions -F "#{session_name}"')
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	observeSessions(): TmuxSessionsObservation {
		if (!this.isAvailable()) {
			return { status: "unknown", detail: "tmux is not available" };
		}
		try {
			const sessions = execFile("tmux", [
				"list-sessions",
				"-F",
				"#{session_name}",
			])
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			return { status: "known", sessions };
		} catch (error) {
			if (noTmuxSessionsAreRunning(error)) {
				return { status: "known", sessions: [] };
			}
			return {
				status: "unknown",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	killSession(sessionName: string): void {
		try {
			execFile("tmux", ["kill-session", "-t", sessionName]);
		} catch {
			// Session may already be gone
		}
	}

	capturePane(sessionName: string, lines = 50): string | null {
		try {
			return exec(
				`tmux capture-pane -t "${sessionName}" -p -S -${lines}`,
			).trimEnd();
		} catch {
			return null;
		}
	}

	/** Non-blocking twin of {@link capturePane}. */
	async capturePaneAsync(
		sessionName: string,
		lines = 50,
	): Promise<string | null> {
		try {
			return (
				await execAsync(`tmux capture-pane -t "${sessionName}" -p -S -${lines}`)
			)
				.toString()
				.trimEnd();
		} catch {
			return null;
		}
	}

	adoptSession(preferredName: string, currentName: string): boolean {
		if (preferredName === currentName) {
			return this.isSessionAlive(preferredName);
		}

		const preferredAlive = this.isSessionAlive(preferredName);
		const currentAlive = this.isSessionAlive(currentName);

		if (preferredAlive) {
			if (currentAlive) {
				return false;
			}
			return true;
		}

		if (!currentAlive) {
			return false;
		}

		try {
			exec(`tmux rename-session -t "${currentName}" "${preferredName}"`);
			return true;
		} catch {
			return false;
		}
	}
}
