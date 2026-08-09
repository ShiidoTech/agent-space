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
/**
 * How long a `bound` verdict is trusted before the provider store is consulted
 * again. Long enough that the common case costs nothing, short enough that a
 * store that moved or a transcript that was deleted stops being asserted.
 */
const REVALIDATE_BOUND_MS = 5 * 60_000;

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
 * - an attribution is made only when the provider supplies a correlation that
 *   proves ownership: either an already assigned session id resolves in the
 *   provider store, or a provider's explicit `correlateOwnedSession` hook
 *   returns an id using provider-specific ownership evidence. Candidate
 *   discovery is never enough: a human can start a CLI in the same cwd after
 *   Agent Space launched;
 * - ordering
 *   agents by launch time and sessions by creation time looks like it resolves
 *   siblings sharing a worktree, but the two orders are unrelated: a session is
 *   born on the first prompt, so launching A then B and then talking to B then
 *   A produces the sessions in the opposite order and pairs everyone wrong.
 *   There is no tiebreak here that is merely likely to be right — a mispaired
 *   agent sends the user's next prompt, and this agent's name, into somebody
 *   else's conversation, while looking perfectly bound. So when the provider
 *   cannot correlate a session, nothing is bound: the state is reported
 *   `ambiguous` until strong provider correlation or explicit attachment
 *   supplies the missing proof.
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
	 * Attach a provider session only after the user has selected it explicitly.
	 * This is the escape hatch for providers (notably Codex/OpenCode) that do
	 * not expose ownership proof. The selected id is still checked against the
	 * provider store and the agent worktree; no automatic guess is introduced.
	 */
	attachExplicitly(
		featureId: string,
		agentId: string,
		sessionId: string,
	): boolean {
		if (!this.projectManager) return false;
		const resolved = this.resolveFeatureForAttachment(featureId);
		if (!resolved) return false;
		const { ctx, feature } = resolved;
		const agent = ctx.agentManager
			.getAgents(featureId)
			.find((a) => a.id === agentId);
		if (!agent) return false;
		const adapter = this.adapterFor(agent);
		if (!adapter?.scanSessions || !adapter.hasSession?.(sessionId))
			return false;
		const cwd = agent.worktreePath ?? feature.worktreePath;
		const session = safeScan(adapter).find(
			(candidate) => candidate.sessionId === sessionId,
		);
		if (!session || !samePath(session.projectPath, cwd)) return false;
		const alreadyOwned = this.projectManager
			.getAllContexts()
			.some((otherCtx) =>
				otherCtx.store
					.loadFeatures()
					.some((otherFeature) =>
						otherCtx.agentManager
							.getAgents(otherFeature.id)
							.some(
								(other) =>
									other.id !== agentId && other.sessionId === sessionId,
							),
					),
			);
		if (alreadyOwned) return false;
		ctx.agentManager.updateAgentSessionId(agentId, featureId, sessionId);
		ctx.agentManager.updateSessionBinding(agentId, featureId, {
			state: "bound",
			checkedAt: new Date().toISOString(),
			attempts: agent.sessionBinding?.attempts ?? 0,
			detail:
				"Attached explicitly by the user to the selected provider session",
		});
		this.onBoundCallback?.({
			agentId,
			featureId,
			binding: ctx.agentManager.getAgent(featureId, agentId)
				?.sessionBinding ?? {
				state: "bound",
				checkedAt: new Date().toISOString(),
				attempts: 0,
				detail:
					"Attached explicitly by the user to the selected provider session",
			},
			boundSessionId: sessionId,
		});
		return true;
	}

	listAttachableSessions(featureId: string, agentId: string): SessionInfo[] {
		if (!this.projectManager) return [];
		const resolved = this.resolveFeatureForAttachment(featureId);
		if (!resolved) return [];
		const agent = resolved.ctx.agentManager
			.getAgents(featureId)
			.find((a) => a.id === agentId);
		if (!agent) return [];
		const adapter = this.adapterFor(agent);
		if (!adapter?.scanSessions) return [];
		const cwd = agent.worktreePath ?? resolved.feature.worktreePath;
		return safeScan(adapter).filter((session) =>
			samePath(session.projectPath, cwd),
		);
	}

	private resolveFeatureForAttachment(
		featureId: string,
	): { ctx: ProjectContext; feature: Feature } | undefined {
		const resolved = this.projectManager?.resolveFeature(featureId);
		if (resolved) return resolved;
		for (const ctx of this.projectManager?.getAllContexts() ?? []) {
			const feature = featureId.startsWith("base:")
				? ctx.featureManager.getBaseFeature(ctx.project.id)
				: ctx.store
						.loadFeatures()
						.find((candidate) => candidate.id === featureId);
			if (feature) return { ctx, feature };
		}
		return undefined;
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
			? safeScan(adapter, true)
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

		// Every candidate set is computed before anything is bound, because
		// deciding whether an attribution is unique requires knowing what the
		// other agents could also have claimed.
		const scans = new Map<string, SessionInfo[]>();
		const claims = pending.map((entry) => {
			const sessions =
				scans.get(entry.adapter.toolId) ??
				(() => {
					const scanned = safeScan(entry.adapter);
					scans.set(entry.adapter.toolId, scanned);
					return scanned;
				})();
			const candidates = candidatesFor(entry, sessions, taken);
			const providerSessionId = safeCorrelate(entry, taken);
			return { entry, candidates, providerSessionId };
		});

		const claimantCount = new Map<string, number>();
		for (const { candidates } of claims) {
			for (const candidate of candidates) {
				claimantCount.set(
					candidate.sessionId,
					(claimantCount.get(candidate.sessionId) ?? 0) + 1,
				);
			}
		}

		for (const { entry, candidates, providerSessionId } of claims) {
			const outcome = this.resolveClaim(
				entry,
				candidates,
				claimantCount,
				providerSessionId,
			);
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

		// A binding is a reconciled state, so `bound` is re-checked too, just far
		// less often: a profile can be repointed, a store can move, a transcript
		// can be deleted. Skipping the check forever would leave the UI asserting
		// a binding that stopped being true. Between checks the answer is reused,
		// because `hasSession` walks the provider store.
		if (agent.sessionBinding?.state === "bound" && agent.sessionId) {
			const checkedMs = toMs(agent.sessionBinding.checkedAt);
			const fresh =
				checkedMs !== null && Date.now() - checkedMs < REVALIDATE_BOUND_MS;
			if (fresh || adapter.hasSession === undefined) {
				return { kind: "settled" };
			}
			if (adapter.hasSession(agent.sessionId)) {
				return {
					kind: "settled",
					binding: this.persist(ctx, featureId, agent, {
						state: "bound",
						detail: "Session id resolves in the provider store",
						attempts: agent.sessionBinding.attempts,
					}),
				};
			}
			// Fall through: the store no longer knows this id. Never rewrite the
			// id silently — the agent goes back through the normal path, which
			// reports `unverified` unless explicit ownership evidence is supplied.
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

	/**
	 * Turn one agent's candidate set into a binding, or refuse to.
	 *
	 * A newly discovered candidate is never enough by itself: provider data does
	 * not distinguish an Agent Space CLI from a manually launched CLI in the same
	 * cwd. Only an already assigned id that resolves in the provider store is a
	 * binding proof. Anything else is reported for what it is.
	 */
	private resolveClaim(
		entry: PendingAgent,
		candidates: Candidate[],
		claimantCount: ReadonlyMap<string, number>,
		providerSessionId?: string,
	): SessionBindingOutcome {
		const { ctx, featureId, agent } = entry;
		// Attempts are diagnostic metadata, not a heartbeat. Keeping the last
		// value stable prevents an unchanged pending/ambiguous observation from
		// becoming a persistence mutation on every poll.
		const attempts = agent.sessionBinding?.attempts ?? 0;
		const where = path.basename(entry.cwd);

		if (candidates.length === 0) {
			return {
				agentId: agent.id,
				featureId,
				binding: this.persist(ctx, featureId, agent, {
					state: agent.sessionId ? "unverified" : "pending",
					attempts,
					detail: agent.sessionId
						? `Session id is not in the provider store, and no unclaimed session has appeared in ${where}`
						: `No provider session has appeared in ${where} yet`,
				}),
			};
		}

		const chosen = providerSessionId
			? candidates.find(
					(candidate) => candidate.sessionId === providerSessionId,
				)
			: undefined;
		if (!chosen) {
			return {
				agentId: agent.id,
				featureId,
				binding: this.persist(ctx, featureId, agent, {
					state: "ambiguous",
					attempts,
					detail:
						candidates.length === 1 && !providerSessionId
							? `Session candidate detected in ${where}, but ownership cannot be proven; Agent Space refused to attach it automatically`
							: providerSessionId && candidates.length > 0
								? `The provider ownership correlator did not return a session that passes the launch baseline and worktree checks in ${where}; refusing to guess`
								: `${candidates.length} unclaimed sessions appeared in ${where} after this agent started; none can be attributed with certainty`,
				}),
			};
		}

		const claimants = claimantCount.get(chosen.sessionId) ?? 1;
		if (claimants > 1) {
			// Providers create a session on the first prompt, so creation order
			// carries no information about which agent it belongs to.
			return {
				agentId: agent.id,
				featureId,
				binding: this.persist(ctx, featureId, agent, {
					state: "ambiguous",
					attempts,
					detail: `${claimants} live agents in ${where} could own the same new session; refusing to guess`,
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
		const current = agent.sessionBinding;
		const sameObservableState =
			current?.state === binding.state &&
			current.detail === binding.detail &&
			current.attempts === binding.attempts;
		// Pending/ambiguous are deliberately stable observations. Refreshing their
		// timestamp on every poll would turn a non-event into a disk write. A bound
		// revalidation is different: its checkedAt is the five-minute lease.
		if (sameObservableState && binding.state !== "bound" && current) {
			return current;
		}
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

/**
 * The sessions this agent could plausibly own: in its worktree, absent from the
 * baseline captured before it launched, not already attributed elsewhere, and
 * not predating the launch. Deliberately unordered — no ordering of this set
 * carries information about ownership.
 */
function candidatesFor(
	entry: PendingAgent,
	sessions: SessionInfo[],
	taken: ReadonlySet<string>,
): Candidate[] {
	const baseline = new Set(entry.agent.sessionBaseline ?? []);
	return sessions
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
		);
}

function safeScan(
	adapter: ProviderSessionAdapter,
	fresh = false,
): SessionInfo[] {
	if (!adapter.scanSessions) return [];
	try {
		return adapter.scanSessions(fresh ? { fresh: true } : undefined);
	} catch {
		// A provider CLI that is not installed, or a store that cannot be read,
		// simply yields no candidates.
		return [];
	}
}

/**
 * Only an explicit provider-owned correlation is acceptable for a new session.
 * Candidate enumeration hooks are intentionally not called here. A Promise is
 * ignored because reconciliation is synchronous; providers used by the
 * runtime expose the synchronous form.
 */
function safeCorrelate(
	entry: PendingAgent,
	taken: ReadonlySet<string>,
): string | undefined {
	if (!entry.adapter.correlateOwnedSession) return undefined;
	try {
		const known = new Set([...(entry.agent.sessionBaseline ?? []), ...taken]);
		const discovered = entry.adapter.correlateOwnedSession(entry.cwd, known);
		return typeof discovered === "string" ? discovered : undefined;
	} catch {
		return undefined;
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
