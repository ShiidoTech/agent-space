import * as path from "node:path";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, AgentSessionBinding, Feature } from "../types";
import type { CodingToolRegistry } from "./codingToolRegistry";
import type { ProviderSessionAdapter } from "./providers/types";
import type { SessionInfo } from "./sessionProviders/types";
import type { TmuxIntegration } from "./tmux";

const RECONCILE_INTERVAL_MS = 15_000;
/**
 * Clock tolerance when comparing a provider's session timestamp with the launch
 * time Agent Space recorded. Providers and the extension can disagree by a
 * second or two; more than this and the session predates the launch.
 */
const LAUNCH_SKEW_MS = 5_000;

export interface SessionBindingOutcome {
	agentId: string;
	featureId: string;
	binding: AgentSessionBinding;
	/** Set when this pass attributed a new session id to the agent. */
	boundSessionId?: string;
}

interface Candidate {
	sessionId: string;
	createdMs: number | null;
}

interface PendingAgent {
	ctx: ProjectContext;
	featureId: string;
	agent: Agent;
	cwd: string;
	launchedMs: number;
	adapter: ProviderSessionAdapter;
}

/**
 * Keep every agent's provider session binding up to date.
 *
 * Agent Space used to bind an agent to its provider session in a single
 * 7.5 second window right after launching the CLI, and never again. No provider
 * cooperates with that: opencode writes its session row when the human sends a
 * first prompt, Codex writes `session_meta` once initialisation settles, and the
 * Claude family was never discovered at all. Measured on real launches the gap
 * ranged from 11 seconds to nearly two minutes, so the window closed empty every
 * time and left naming, attention and resume keyed on an id that stayed null.
 *
 * Binding is therefore a state that is reconciled for as long as an agent is
 * alive, not an event that happens once. Two rules keep it honest:
 *
 * - a session that already existed in the worktree before the agent launched is
 *   never adopted (the baseline is persisted, so a restart cannot lose it);
 * - a session is attributed to at most one agent, and agents are served oldest
 *   launch first, so siblings in one worktree cannot swap sessions.
 */
export class SessionBinder {
	private projectManager: ProjectManager | undefined;
	private timer?: ReturnType<typeof setInterval>;
	private onBoundCallback?: (outcome: SessionBindingOutcome) => void;

	constructor(
		private readonly toolRegistry: CodingToolRegistry,
		private readonly tmux: TmuxIntegration,
	) {}

	onBound(callback: (outcome: SessionBindingOutcome) => void): void {
		this.onBoundCallback = callback;
	}

	start(
		projectManager: ProjectManager,
		intervalMs = RECONCILE_INTERVAL_MS,
	): void {
		this.projectManager = projectManager;
		this.stop();
		if (intervalMs <= 0) return;
		this.timer = setInterval(() => this.reconcileAll(), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.stop();
		this.projectManager = undefined;
	}

	/**
	 * Snapshot the sessions that already exist in `cwd` and mark the agent as
	 * awaiting a session of its own. Called immediately before the CLI starts,
	 * so anything recorded here provably predates this agent.
	 */
	recordLaunch(
		ctx: ProjectContext,
		featureId: string,
		agent: Agent,
		cwd: string,
	): void {
		const adapter = this.adapterFor(agent);
		if (!adapter) {
			ctx.agentManager.updateSessionBinding(agent.id, featureId, {
				state: "unsupported",
				checkedAt: new Date().toISOString(),
				attempts: 0,
				detail: "Provider exposes no session store to bind against",
			});
			return;
		}

		const baseline = adapter.scanSessions
			? safeScan(adapter)
					.filter((session) => samePath(session.projectPath, cwd))
					.map((session) => session.sessionId)
			: [];

		ctx.agentManager.recordAgentLaunch(agent.id, featureId, {
			baseline,
			launchedAt: new Date().toISOString(),
		});
	}

	/**
	 * Reconcile every live, unbound agent. Returns the outcomes that changed, so
	 * callers can refresh the UI and re-run name synchronization only when
	 * something actually moved.
	 */
	reconcileAll(): SessionBindingOutcome[] {
		if (!this.projectManager) return [];

		const contexts = this.projectManager.getAllContexts();
		// Every id already attributed to an agent anywhere, so no two agents can
		// ever end up pointing at the same provider session.
		const taken = new Set<string>();
		const pending: PendingAgent[] = [];
		const outcomes: SessionBindingOutcome[] = [];

		for (const ctx of contexts) {
			for (const { featureId, worktreePath } of managedFeatures(ctx)) {
				for (const agent of ctx.agentManager.getAgents(featureId)) {
					if (agent.sessionId) taken.add(agent.sessionId);

					const classification = this.classify(
						ctx,
						featureId,
						agent,
						worktreePath,
					);
					if (classification.kind === "settled") {
						if (classification.binding) {
							outcomes.push({
								agentId: agent.id,
								featureId,
								binding: classification.binding,
							});
						}
						continue;
					}
					pending.push(classification.pending);
				}
			}
		}

		if (pending.length === 0) return outcomes;

		// Oldest launch first: when two agents share a worktree, the one that
		// started first gets the session that appeared first.
		pending.sort((left, right) => left.launchedMs - right.launchedMs);

		const scans = new Map<string, SessionInfo[]>();
		for (const entry of pending) {
			const sessions =
				scans.get(entry.adapter.toolId) ??
				(() => {
					const scanned = safeScan(entry.adapter);
					scans.set(entry.adapter.toolId, scanned);
					return scanned;
				})();

			const outcome = this.bindPending(entry, sessions, taken);
			outcomes.push(outcome);
			if (outcome.boundSessionId) {
				taken.add(outcome.boundSessionId);
				this.onBoundCallback?.(outcome);
			}
		}

		return outcomes;
	}

	private classify(
		ctx: ProjectContext,
		featureId: string,
		agent: Agent,
		worktreePath: string,
	):
		| { kind: "settled"; binding?: AgentSessionBinding }
		| { kind: "pending"; pending: PendingAgent } {
		if (agent.status === "done" || agent.hasStarted !== true) {
			return { kind: "settled" };
		}

		const adapter = this.adapterFor(agent);
		if (!adapter) {
			return {
				kind: "settled",
				binding: this.persist(ctx, featureId, agent, {
					state: "unsupported",
					detail: "Provider exposes no session store to bind against",
					attempts: agent.sessionBinding?.attempts ?? 0,
				}),
			};
		}

		if (agent.sessionBinding?.state === "bound" && agent.sessionId) {
			return { kind: "settled" };
		}

		if (agent.sessionId && adapter.hasSession?.(agent.sessionId) === true) {
			return {
				kind: "settled",
				binding: this.persist(ctx, featureId, agent, {
					state: "bound",
					detail: "Session id resolves in the provider store",
					attempts: agent.sessionBinding?.attempts ?? 0,
				}),
			};
		}

		const cwd = agent.worktreePath ?? worktreePath;
		const tmuxSession =
			agent.tmuxSession ?? this.tmux.sessionName(featureId, agent.id);
		let alive = false;
		try {
			alive = this.tmux.isSessionAlive?.(tmuxSession) ?? false;
		} catch {
			alive = false;
		}
		if (!alive) {
			// A terminated agent must never adopt a session created after it died —
			// that session belongs to whatever is running now.
			return {
				kind: "settled",
				binding: this.persist(ctx, featureId, agent, {
					state: agent.sessionId ? "unverified" : "pending",
					detail: agent.sessionId
						? "Session id is not in the provider store and the terminal is gone"
						: "Terminal is no longer running; nothing left to bind",
					attempts: agent.sessionBinding?.attempts ?? 0,
				}),
			};
		}

		return {
			kind: "pending",
			pending: {
				ctx,
				featureId,
				agent,
				cwd,
				launchedMs: toMs(agent.launchedAt) ?? toMs(agent.createdAt) ?? 0,
				adapter,
			},
		};
	}

	private bindPending(
		entry: PendingAgent,
		sessions: SessionInfo[],
		taken: ReadonlySet<string>,
	): SessionBindingOutcome {
		const { ctx, featureId, agent } = entry;
		const attempts = (agent.sessionBinding?.attempts ?? 0) + 1;
		const baseline = new Set(agent.sessionBaseline ?? []);

		const candidates: Candidate[] = sessions
			.filter((session) => samePath(session.projectPath, entry.cwd))
			.filter((session) => !baseline.has(session.sessionId))
			.filter((session) => !taken.has(session.sessionId))
			.map((session) => ({
				sessionId: session.sessionId,
				createdMs: toMs(session.created),
			}))
			.filter(
				(candidate) =>
					candidate.createdMs === null ||
					entry.launchedMs === 0 ||
					candidate.createdMs >= entry.launchedMs - LAUNCH_SKEW_MS,
			)
			.sort((left, right) => (left.createdMs ?? 0) - (right.createdMs ?? 0));

		const chosen = candidates[0];
		if (!chosen) {
			return {
				agentId: agent.id,
				featureId,
				binding: this.persist(ctx, featureId, agent, {
					state: agent.sessionId ? "unverified" : "pending",
					attempts,
					detail: agent.sessionId
						? `Session id is not in the provider store, and no unclaimed session has appeared in ${path.basename(entry.cwd)}`
						: `No provider session has appeared in ${path.basename(entry.cwd)} yet`,
				}),
			};
		}

		const replaced = agent.sessionId;
		ctx.agentManager.updateAgentSessionId(
			agent.id,
			featureId,
			chosen.sessionId,
		);
		const binding = this.persist(ctx, featureId, agent, {
			state: "bound",
			attempts,
			detail: replaced
				? "Adopted a session started by this agent; the pre-assigned id never appeared in the provider store"
				: "Adopted the session this agent started",
		});

		return {
			agentId: agent.id,
			featureId,
			binding,
			boundSessionId: chosen.sessionId,
		};
	}

	private persist(
		ctx: ProjectContext,
		featureId: string,
		agent: Agent,
		binding: Omit<AgentSessionBinding, "checkedAt">,
	): AgentSessionBinding {
		const next: AgentSessionBinding = {
			...binding,
			checkedAt: new Date().toISOString(),
		};
		ctx.agentManager.updateSessionBinding(agent.id, featureId, next);
		return next;
	}

	private adapterFor(agent: Agent): ProviderSessionAdapter | undefined {
		const tool = this.toolRegistry.resolveAgentTool(agent.toolId);
		return this.toolRegistry.getProvider(tool).sessionAdapter;
	}
}

function managedFeatures(
	ctx: ProjectContext,
): Array<{ featureId: string; worktreePath: string }> {
	const base = ctx.featureManager.getBaseFeature(ctx.project.id);
	// Read persisted features directly: reconciliation must never trigger Git
	// branch reconciliation or any other worktree side effect.
	const persisted: Feature[] = ctx.store.loadFeatures();
	return [
		{ featureId: base.id, worktreePath: base.worktreePath },
		...persisted.map((feature) => ({
			featureId: feature.id,
			worktreePath: feature.worktreePath,
		})),
	];
}

function safeScan(adapter: ProviderSessionAdapter): SessionInfo[] {
	if (!adapter.scanSessions) return [];
	try {
		return adapter.scanSessions();
	} catch {
		// A provider CLI that is not installed, or a store that cannot be read,
		// simply yields no candidates.
		return [];
	}
}

function samePath(left: string, right: string): boolean {
	if (!left || !right) return false;
	return path.resolve(left) === path.resolve(right);
}

function toMs(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}
