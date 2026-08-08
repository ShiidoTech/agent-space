export type FeatureStatus = "active" | "done";
export type GitAwareStatus = "new" | "modified" | "ahead" | "merged";
export type AgentStatus = "running" | "idle" | "stopped" | "done" | "errored";
export type AgentAttentionStatus =
	| "working"
	| "waiting_for_user"
	| "idle"
	| "failed"
	| "done"
	| "unknown";
export type IsolationMode = "shared" | "per-agent";

export interface Feature {
	id: string;
	name: string;
	branch: string;
	worktreePath: string;
	status: FeatureStatus;
	color: string;
	isolation: IsolationMode;
	createdAt: string;
	/** Commit the feature branch was created from, when known. */
	createdFromSha?: string;
}

/**
 * A coding CLI that Agent Space can launch inside a tmux-backed terminal.
 *
 * - `command`/`args` build the process to start.
 * - `env` are merged into the launched process environment (e.g. a personal
 *   profile config dir).
 * - `family` drives session handling. "claude" CLIs are launched with a
 *   pre-assigned `--session-id` and resumed with `--resume <sessionId>`;
 *   "codex" generates its own id and is resumed with `codex resume`;
 *   "opencode"/"generic" manage their own sessions.
 * - `sessionsDir` tells Agent Space where the CLI stores its session index
 *   so names can be discovered for display/rename.
 * - `resumeCommand` is an optional explicit template. `{command}` and
 *   `{sessionId}` are substituted when provided.
 */
export interface CodingTool {
	id: string;
	name: string;
	command: string;
	/** When false (only meaningful for custom `codingTools` entries), the tool is removed from the registry. */
	enabled?: boolean;
	args?: string[];
	env?: Record<string, string>;
	family?: "claude" | "codex" | "opencode" | "generic";
	sessionsDir?: string;
	resumeCommand?: string;
}

export interface Agent {
	id: string;
	featureId: string;
	name: string;
	sessionId: string | null;
	worktreePath?: string;
	tmuxSession?: string;
	toolId?: string;
	/** Persisted lifecycle state. Do not use this as a precise activity signal. */
	status: AgentStatus;
	/**
	 * Derived, provider-neutral attention state. This is deliberately not
	 * persisted: it is recomputed from current tmux/session evidence so a
	 * restart cannot leave a stale "working" or "waiting" flag behind.
	 */
	attentionStatus?: AgentAttentionStatus;
	/** Human-readable evidence summary for tooltips/debugging; never provider payload text. */
	attentionReason?: string;
	hasStarted?: boolean;
	lastError?: string;
	lastExitCode?: number | null;
	createdAt: string;
}

export interface CompanionState {
	features: Feature[];
}

export interface FeatureAgents {
	agents: Agent[];
}

export interface Project {
	id: string;
	name: string;
	repoPath: string;
}

export type ServiceStatus = "running" | "stopped" | "errored";

export interface Service {
	id: string;
	featureId: string;
	name: string;
	command: string;
	launchCommand?: string | null;
	tmuxSession: string;
	status: ServiceStatus;
	createdAt: string;
}

export interface FeatureServices {
	services: Service[];
}
