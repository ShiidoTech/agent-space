export type FeatureStatus = "active" | "done";
export type GitAwareStatus = "new" | "modified" | "ahead" | "merged";
export type AgentStatus = "running" | "idle" | "stopped" | "done" | "errored";
export type AgentAttentionStatus =
	| "working"
	| "waiting_for_user"
	| "idle"
	| "failed"
	| "done"
	| "unknown"
	| "unsupported";
export type AgentNameSource = "default" | "user";
export type IsolationMode = "shared" | "per-agent";

/**
 * How confident Agent Space is that an agent is linked to a real provider
 * session.
 *
 * The link is the key every session-derived feature reads through: display
 * name, attention evidence and resume all fail closed without it. It is
 * therefore an explicit, persisted, observable state rather than the implicit
 * "sessionId is set" it used to be.
 *
 * - `unsupported` — the provider exposes no session store to bind against.
 * - `pending` — the agent is running and no provider session has appeared yet.
 *   Providers write their session record when the human sends a first prompt,
 *   not when the binary starts, so this state is normal and can last minutes.
 * - `bound` — `sessionId` resolves to a session that actually exists.
 * - `ambiguous` — several sessions could legitimately belong to this agent, or
 *   one session could belong to several agents. Guessing here is worse than
 *   admitting it: a wrong guess sends the user's prompts and this agent's name
 *   to somebody else's conversation, and looks like a working binding.
 * - `unverified` — `sessionId` is set but the provider store does not contain
 *   it. Never silently rewritten: the value is kept and reported as-is.
 */
export type AgentSessionBindingState =
	| "unsupported"
	| "pending"
	| "bound"
	| "ambiguous"
	| "unverified";

export interface AgentSessionBinding {
	state: AgentSessionBindingState;
	/** ISO timestamp of the last reconciliation attempt. */
	checkedAt: string;
	/** Number of reconciliation attempts made since the agent was launched. */
	attempts: number;
	/** Short, non-sensitive explanation shown in Doctor and tooltips. */
	detail: string;
}

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
	/** Internal adapter. Never loaded from project/user configuration. */
	provider?: import("./agents/providers/types").CodingAgentProvider;
}

export interface Agent {
	id: string;
	featureId: string;
	name: string;
	/** Stable Agent Space identity; provider titles are stored separately. */
	nameSource?: AgentNameSource;
	/** Last provider title observed for this agent's bound session. */
	sessionTitle?: string;
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
	/**
	 * Observable outcome of session binding. Persisted so a failed bind is a
	 * reportable state instead of a silent no-op, and so Doctor can explain why
	 * an agent has no name and no attention evidence.
	 */
	sessionBinding?: AgentSessionBinding;
	/**
	 * Provider session ids that already existed in this agent's working
	 * directory when it was launched. Persisted (not just held in memory) so a
	 * VS Code restart cannot make Agent Space adopt a neighbouring agent's
	 * session as its own.
	 */
	sessionBaseline?: string[];
	/** ISO timestamp of the launch this binding relates to. */
	launchedAt?: string;
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
