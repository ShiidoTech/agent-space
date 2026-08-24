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

	configureSession(sessionName: string): void {
		try {
			exec(`tmux set-option -t "${sessionName}" status off`);
			exec(`tmux set-option -t "${sessionName}" mouse on`);
			this.ensureNativeScroll();
		} catch {
			// Session may not exist
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

	createCommand(sessionName: string, innerCommand: string): string {
		return `tmux new-session -d -s "${sessionName}" "${innerCommand}"`;
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
