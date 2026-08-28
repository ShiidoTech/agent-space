/**
 * The launch context a provider needs to *prove* (not guess) which session its
 * own agent owns. Issue #120 section A: candidate discovery is explicitly never
 * enough — the correlation API must receive the launch context it actually
 * needs (agent id, worktree, tmux session/pane identity, launch timestamp),
 * not only a cwd and a list of already-known ids.
 *
 * A provider uses `tmuxSession` (the agent's dedicated tmux session name) to
 * derive an exact pane/terminal identity and map it to its own native
 * per-terminal state (e.g. Hermes `$HERMES_HOME/terminal-sessions/<terminal-id>`).
 */
export interface SessionCorrelationContext {
	/** The agent's worktree / effective working directory. */
	readonly cwd: string;
	/** Sessions already attributed elsewhere (pre-launch baseline + taken by other agents). */
	readonly knownSessionIds: ReadonlySet<string>;
	/** The dedicated tmux session name the agent runs in, when one exists. */
	readonly tmuxSession?: string;
	/** Milliseconds since epoch when the agent was launched. */
	readonly launchedAtMs?: number;
}

export interface SessionInfo {
	sessionId: string;
	prompt: string;
	created: string;
	projectPath: string;
	/** Provider id, populated when a session is presented for explicit attach. */
	provider?: string;
}

export interface SessionProvider {
	toolId: string;
	scanSessions(options?: { fresh?: boolean }): SessionInfo[];
}

export interface SessionRenameAdapter {
	toolId: string;
	readName(sessionId: string): string | null;
	clearCache?(sessionId: string): void;
	dispose?(): void;
}

export interface SessionTitleProvider {
	toolId: string;
	findSessionFile(sessionId: string): string | null;
	readTitle(filePath: string): string | null;
	clearCache?(sessionId: string): void;
	dispose?(): void;
}

export interface AsyncSessionObservationAdapter {
	scanSessions?(options?: { fresh?: boolean }): Promise<SessionInfo[]>;
	hasSession?(sessionId: string): Promise<boolean>;
	readName?(sessionId: string): Promise<string | null>;
	correlateOwnedSession?(
		context: SessionCorrelationContext,
	): Promise<string | undefined>;
}
