import { execFile, execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { normalizeFeatureName } from "../features/featureName";
import type { ProjectConfig } from "../projects/projectConfig";
import type { Store } from "../storage/store";
import type {
	Agent,
	AgentSessionBinding,
	AgentStatus,
	Feature,
} from "../types";
import { isWorktreePathSafe } from "../utils/worktreeGuard";
import { AgentAttentionResolver } from "./attention/agentAttentionResolver";
import { CodingToolRegistry } from "./codingToolRegistry";
import { resolveCreationProfile } from "./hermesProfileResolver";
import { AgentObservationResolver } from "./observation/agentObservationResolver";
import type { AgentObservation } from "./observation/types";
import type { TmuxIntegration } from "./tmux";

export interface AgentWorktreeRemovalResult {
	readonly removed: boolean;
	readonly worktreePath?: string;
	readonly reason?: string;
}

export class AgentManager {
	private agentsByFeature = new Map<string, Agent[]>();
	/**
	 * Last-known review-inbox snapshot per feature, refreshed on every read
	 * or mutation of the review inbox. Backs {@link peekPendingReviewId}: a
	 * cheap, synchronous, in-memory-only lookup (never a disk read) so
	 * `AgentFocusService` can capture exactly which receipt a click is about
	 * to acknowledge without violating its warm path's zero-I/O guarantee
	 * (issue #120 PR2, review round 3).
	 */
	private lastKnownReviewInbox = new Map<string, Record<string, string>>();
	/**
	 * Last-known {@link AgentObservation} per agentId, refreshed asynchronously
	 * by {@link refreshObservationCache} (called from background reconciliation,
	 * never from a render path). Backs {@link observeCached}: a zero-I/O read
	 * so sidebar/Home presentation never re-probes tmux/provider state on every
	 * refresh (P0 zero-I/O UI mandate).
	 */
	private observationCache = new Map<string, AgentObservation>();
	private cachedDefaultBranch: string | undefined;
	private invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly attentionResolver: AgentAttentionResolver;
	private readonly observationResolver: AgentObservationResolver;
	private readonly execFileAsync = promisify(execFile);

	constructor(
		private readonly store: Store,
		private readonly repoRoot: string,
		private readonly worktreeBase: string,
		private readonly tmux: TmuxIntegration,
		private config: ProjectConfig = {},
		private readonly toolRegistry: CodingToolRegistry = new CodingToolRegistry(),
	) {
		this.attentionResolver = new AgentAttentionResolver(tmux, toolRegistry);
		this.observationResolver = new AgentObservationResolver(tmux, toolRegistry);
	}

	invalidateFeature(featureId: string): void {
		// Debounce: batch rapid invalidation calls (e.g. file watcher events)
		if (this.invalidateTimers.has(featureId)) {
			clearTimeout(this.invalidateTimers.get(featureId));
		}
		this.invalidateTimers.set(
			featureId,
			setTimeout(() => {
				this.agentsByFeature.delete(featureId);
				this.invalidateTimers.delete(featureId);
			}, 100),
		);
	}

	/** Immediately invalidate without debounce. Used by tests and direct mutations. */
	invalidateFeatureImmediate(featureId: string): void {
		const timer = this.invalidateTimers.get(featureId);
		if (timer) {
			clearTimeout(timer);
			this.invalidateTimers.delete(featureId);
		}
		this.agentsByFeature.delete(featureId);
	}

	getAgents(featureId: string): Agent[] {
		const pending = this.loadReviewInbox(featureId);
		return this.loadAgents(featureId).map((agent) =>
			this.withPendingReview(this.withAttentionStatus(agent), pending),
		);
	}

	/**
	 * Non-blocking twin of {@link getAgents}: identical attention semantics,
	 * but the tmux/provider probes run through the async helpers so callers
	 * on background observation paths never block the Extension Host.
	 */
	async getAgentsAsync(featureId: string): Promise<Agent[]> {
		const agents = this.loadAgents(featureId);
		const pending = this.loadReviewInbox(featureId);
		return Promise.all(
			agents.map(async (agent) => {
				const attention = await this.attentionResolver.resolveAsync(agent);
				return this.withPendingReview(
					{
						...agent,
						attentionStatus: attention.status,
						attentionReason: attention.reason,
						attentionSource: attention.source,
					},
					pending,
				);
			}),
		);
	}

	/**
	 * Read the persisted/runtime agent model without probing a provider. This is
	 * the startup/presence read path: provider attention is active observation
	 * and must never block the Extension Host or replace the last-known model.
	 */
	getAgentsReadModel(featureId: string): Agent[] {
		const pending = this.loadReviewInbox(featureId);
		return this.store
			.loadAgents(featureId)
			.map((agent) => this.withPendingReview({ ...agent }, pending));
	}

	/** Persist startup restore state without populating the normalized cache. */
	updateAgentStatusReadModel(
		agentId: string,
		featureId: string,
		status: AgentStatus,
	): void {
		this.mutateReadModel(featureId, agentId, (agent) => {
			agent.status = status;
		});
	}

	getAgent(featureId: string, agentId: string): Agent | undefined {
		const agent = this.loadAgents(featureId).find((a) => a.id === agentId);
		if (!agent) return undefined;
		const pending = this.loadReviewInbox(featureId);
		return this.withPendingReview(this.withAttentionStatus(agent), pending);
	}

	/**
	 * Cheap, synchronous, in-memory-only peek at the review receipt last
	 * seen for this agent — never a disk read. Backs
	 * `AgentFocusDeps.peekPendingReviewId`: `AgentFocusService` calls this
	 * at click time to capture exactly which receipt a focus request is
	 * about to acknowledge (issue #120 PR2, review round 3).
	 */
	peekPendingReviewId(featureId: string, agentId: string): string | undefined {
		return this.lastKnownReviewInbox.get(featureId)?.[agentId];
	}

	getObservation(featureId: string, agentId: string) {
		const agent = this.getAgent(featureId, agentId);
		return agent ? this.observe(agent) : undefined;
	}

	observe(agent: Agent) {
		return this.observationResolver.resolve(agent);
	}

	/**
	 * Zero-I/O read of the last-known observation for this agent: never tmux,
	 * never a provider, never a subprocess. Falls back to a purely
	 * persisted-field synthesis ({@link AgentObservationResolver.resolveReadModel})
	 * when the cache hasn't been populated yet (e.g. before the first
	 * background reconciliation tick). This is the read path presentation
	 * (sidebar, Home) must use instead of {@link observe} (P0 zero-I/O UI
	 * mandate).
	 */
	observeCached(agent: Agent): AgentObservation {
		return (
			this.observationCache.get(agent.id) ??
			this.observationResolver.resolveReadModel(agent)
		);
	}

	/**
	 * Refresh the observation cache for every agent of a feature, using only
	 * async, non-blocking probes. Intended to be called from background
	 * reconciliation (e.g. `FeatureStateCoordinator.reconcilePresence`) —
	 * never awaited on a render path. A single agent's probe failing does not
	 * abort the others; that agent's cache entry is simply left stale.
	 */
	async refreshObservationCache(featureId: string): Promise<void> {
		const agents = this.getAgentsReadModel(featureId);
		await Promise.all(
			agents.map(async (agent) => {
				try {
					const observation =
						await this.observationResolver.resolveAsync(agent);
					this.observationCache.set(agent.id, observation);
				} catch {
					// Leave the previous cache entry (or the read-model default) in
					// place; a transient probe failure should not blank the card.
				}
			}),
		);
	}

	createAgent(feature: Feature, toolId?: string): Agent {
		const agents = this.loadAgents(feature.id);
		const name = this.nextDefaultName(agents);
		const id = crypto.randomUUID();

		let worktreePath: string | undefined;
		if (feature.isolation === "per-agent") {
			const shortId = id.slice(0, 8);
			worktreePath = this.agentWorktreePath(feature, shortId);
			const branch = this.agentBranchName(feature, shortId);
			execSync(
				`git worktree add "${worktreePath}" -b "${branch}" "${feature.branch}"`,
				{
					cwd: this.repoRoot,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		}

		// Conversation identity belongs to the provider contract. AgentManager
		// never guesses it from a CLI family or from sessions found after launch.
		const sessionId = this.toolRegistry.createInitialConversationId(toolId);

		// Resolve the effective Hermes profile at creation time and persist it
		// so resume/restore always targets the same runtime even if the project
		// config or active Hermes profile changes later.
		//
		// Priority: project profile > profile carried by HERMES_HOME (e.g.
		// HERMES_HOME=/root/profiles/coder) > Hermes' active profile (`hermes
		// profile use`) > "default". Always a concrete profile for Hermes
		// agents, so even the implicit default is persisted explicitly and
		// every launch goes through `-p <profile>`.
		let hermesProfile: string | undefined;
		if (toolId === "hermes") {
			const tool = this.toolRegistry.getTool("hermes");
			const envHermesHome = tool?.env?.HERMES_HOME;
			hermesProfile = resolveCreationProfile(
				this.config.providers?.hermes?.profile,
				envHermesHome,
			);
		}

		const agent: Agent = {
			id,
			featureId: feature.id,
			name,
			nameSource: "default",
			sessionId,
			tmuxSession: this.tmux.sessionName(this.sessionLabel(feature.id), id),
			worktreePath,
			toolId,
			hermesProfile,
			status: "stopped",
			hasStarted: false,
			createdAt: new Date().toISOString(),
		};

		agents.push(agent);
		this.saveAgents(feature.id, agents);
		return agent;
	}

	beginAgentStartup(
		agentId: string,
		featureId: string,
		waitingForWorktree = false,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((candidate) => candidate.id === agentId);
		if (!agent) return;
		agent.startup = {
			state: "starting",
			steps: [
				{
					id: "worktree",
					label: "Waiting for feature worktree",
					status: waitingForWorktree ? "running" : "completed",
				},
				{
					id: "terminal",
					label: "Creating terminal",
					status: waitingForWorktree ? "pending" : "running",
				},
				{
					id: "provider",
					label: `Starting ${agent.toolId ?? "agent"}`,
					status: "pending",
				},
			],
		};
		this.saveAgents(featureId, agents);
	}

	/**
	 * Advance startup to the given step: every step before it is marked
	 * `completed` (its phase provably finished, whether or not this method was
	 * ever called for it) and the step itself is marked `running`. Steps after
	 * it are untouched.
	 *
	 * Without this, a step left `running` from `beginAgentStartup` (e.g.
	 * "worktree" when `waitingForWorktree` was true) is still the one
	 * `recordAgentFailure` blames for a failure that actually happened in a
	 * later phase — the worktree gets reported as failed when it was the
	 * provider that crashed after the worktree and terminal both succeeded.
	 */
	advanceStartupStep(
		agentId: string,
		featureId: string,
		stepId: "worktree" | "terminal" | "provider",
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((candidate) => candidate.id === agentId);
		if (!agent?.startup) return;
		const index = agent.startup.steps.findIndex((step) => step.id === stepId);
		if (index === -1) return;
		for (let i = 0; i < index; i++) {
			if (agent.startup.steps[i].status !== "failed") {
				agent.startup.steps[i].status = "completed";
			}
		}
		if (agent.startup.steps[index].status !== "failed") {
			agent.startup.steps[index].status = "running";
		}
		this.saveAgents(featureId, agents);
	}

	renameAgent(agentId: string, featureId: string, name: string): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.name = name;
		agent.nameSource = /^Agent \d+$/.test(name) ? "default" : "user";
		this.saveAgents(featureId, agents);
	}

	/** Legacy compatibility: provider auto-naming may update only generated names. */
	renameAgentFromProvider(
		agentId: string,
		featureId: string,
		name: string,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((candidate) => candidate.id === agentId);
		if (!agent || agent.nameSource === "user") return;
		agent.name = name;
		agent.nameSource = "default";
		this.saveAgents(featureId, agents);
	}

	updateAgentSessionTitle(
		agentId: string,
		featureId: string,
		sessionTitle: string,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((candidate) => candidate.id === agentId);
		if (!agent || agent.sessionTitle === sessionTitle) return;
		agent.sessionTitle = sessionTitle;
		this.saveAgents(featureId, agents);
	}

	updateAgentStatus(
		agentId: string,
		featureId: string,
		status: AgentStatus,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.status = status;
		this.saveAgents(featureId, agents);
	}

	markAgentStarted(agentId: string, featureId: string): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.status = "running";
		agent.hasStarted = true;
		delete agent.lastError;
		delete agent.lastExitCode;
		if (agent.startup) {
			for (const step of agent.startup.steps) step.status = "completed";
			agent.startup.state = "ready";
		}
		this.saveAgents(featureId, agents);
	}

	recordAgentFailure(
		agentId: string,
		featureId: string,
		message: string,
		exitCode?: number | null,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.status = "errored";
		agent.lastError = message;
		agent.lastExitCode = exitCode ?? null;
		if (agent.startup) {
			const step = agent.startup.steps.find(
				(candidate) => candidate.status === "running",
			);
			if (step) {
				step.status = "failed";
				step.error = message;
			}
			agent.startup.state = "failed";
		}
		this.saveAgents(featureId, agents);
	}

	/**
	 * Open a review-inbox entry for one completed turn: persists an opaque
	 * receipt (`pendingReviewId`) until {@link acknowledgeReview} clears it.
	 * Idempotent per call — a later completion always overwrites an earlier
	 * unacknowledged one, since only the most recent completion matters.
	 */
	recordTurnCompleted(
		agentId: string,
		featureId: string,
		reviewId: string,
	): void {
		if (!this.loadAgents(featureId).some((a) => a.id === agentId)) return;
		const pending = this.loadReviewInbox(featureId);
		pending[agentId] = reviewId;
		this.saveReviewInbox(featureId, pending);
	}

	/**
	 * Unconditionally clear a pending review receipt, if any, regardless of
	 * which completion it points to. For agent lifecycle transitions where
	 * the receipt stops making sense outright (closed/deleted agent) — never
	 * for a focus/review action, which must use
	 * {@link acknowledgeReviewIfMatches} so a race can't swallow a newer
	 * receipt. Silent no-op when there is nothing to acknowledge.
	 */
	acknowledgeReview(agentId: string, featureId: string): void {
		const pending = this.loadReviewInbox(featureId);
		if (!(agentId in pending)) return;
		delete pending[agentId];
		this.saveReviewInbox(featureId, pending);
	}

	/**
	 * Compare-and-clear acknowledgement: clears the receipt only if it still
	 * equals `expectedReviewId`. Used by `AgentFocusService` — its
	 * `expectedReviewId` is a snapshot captured synchronously at click time
	 * (via {@link peekPendingReviewId}), so a newer completion that races in
	 * after the click but before the deferred acknowledgement runs is left
	 * untouched instead of being silently marked reviewed (issue #120 PR2,
	 * review round 3). Silent no-op when the receipt no longer matches or is
	 * already gone.
	 */
	acknowledgeReviewIfMatches(
		agentId: string,
		featureId: string,
		expectedReviewId: string,
	): void {
		const pending = this.loadReviewInbox(featureId);
		if (pending[agentId] !== expectedReviewId) return;
		delete pending[agentId];
		this.saveReviewInbox(featureId, pending);
	}

	updateAgentSessionId(
		agentId: string,
		featureId: string,
		sessionId: string,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.sessionId = sessionId;
		this.saveAgents(featureId, agents);
	}

	/**
	 * Persist the observable outcome of session binding. A failed bind is a
	 * reportable state, not a silent no-op: Doctor and the agent tooltip read
	 * this to explain why an agent has no name and no attention evidence.
	 */
	updateSessionBinding(
		agentId: string,
		featureId: string,
		binding: AgentSessionBinding,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		const current = agent.sessionBinding;
		if (
			current &&
			current.state === binding.state &&
			current.detail === binding.detail &&
			current.attempts === binding.attempts &&
			current.checkedAt === binding.checkedAt
		) {
			// Nothing changed; skip the write so a 15s reconciliation loop does not
			// rewrite agents.json forever.
			return;
		}
		agent.sessionBinding = binding;
		this.saveAgents(featureId, agents);
	}

	/**
	 * Record what the provider's session store looked like immediately before
	 * this agent's CLI started. Persisted rather than held in memory so a VS Code
	 * restart cannot make Agent Space adopt a neighbouring agent's session.
	 */
	recordAgentLaunch(
		agentId: string,
		featureId: string,
		launch: { baseline: string[]; launchedAt: string },
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.sessionBaseline = launch.baseline;
		agent.launchedAt = launch.launchedAt;
		agent.sessionBinding = {
			state: "pending",
			checkedAt: launch.launchedAt,
			attempts: 0,
			detail: "Waiting for the provider to record a session for this agent",
		};
		this.saveAgents(featureId, agents);
	}

	closeAgent(agentId: string, featureId: string): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.status = "done";
		delete agent.lastError;
		delete agent.lastExitCode;
		this.saveAgents(featureId, agents);
		// A closed agent takes no further turns, so any unacknowledged
		// receipt can never be reviewed by opening it again; clear it here
		// rather than let it resurface as "Ready for review" if the agent
		// is later reopened.
		this.acknowledgeReview(agentId, featureId);
	}

	/**
	 * Persist the outcome of the post-restart runtime restoration. Blocked
	 * outcomes stay visible in the model so a fail-closed restore is an
	 * explicit, reportable state instead of a silent no-op. Unchanged outcomes
	 * are not rewritten, so an idempotent restore pass never churns agents.json.
	 */
	recordRestoreOutcome(
		agentId: string,
		featureId: string,
		outcome: NonNullable<Agent["restore"]>,
	): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		const current = agent.restore;
		if (
			current &&
			current.state === outcome.state &&
			current.reason === outcome.reason
		) {
			return;
		}
		agent.restore = outcome;
		this.saveAgents(featureId, agents);
	}

	recordRestoreOutcomeReadModel(
		agentId: string,
		featureId: string,
		outcome: NonNullable<Agent["restore"]>,
	): void {
		this.mutateReadModel(featureId, agentId, (agent) => {
			const current = agent.restore;
			if (
				current &&
				current.state === outcome.state &&
				current.reason === outcome.reason
			) {
				return;
			}
			agent.restore = outcome;
		});
	}

	reopenAgent(agentId: string, feature: Feature): Agent | undefined {
		const agents = this.loadAgents(feature.id);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent || agent.status !== "done") return undefined;

		// Recreate per-agent worktree if it was removed
		if (feature.isolation === "per-agent" && agent.worktreePath) {
			if (!this.worktreeExists(agent.worktreePath)) {
				const shortId = agent.id.slice(0, 8);
				const branch = this.agentBranchName(feature, shortId);
				try {
					// Try to reuse existing branch, otherwise create new
					try {
						execSync(`git worktree add "${agent.worktreePath}" "${branch}"`, {
							cwd: this.repoRoot,
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "pipe"],
						});
					} catch {
						execSync(
							`git worktree add "${agent.worktreePath}" -b "${branch}" "${feature.branch}"`,
							{
								cwd: this.repoRoot,
								encoding: "utf-8",
								stdio: ["ignore", "pipe", "pipe"],
							},
						);
					}
				} catch (err) {
					console.error(`[AgentManager] Failed to recreate worktree: ${err}`);
					return undefined;
				}
			}
		}

		agent.status = "stopped";
		delete agent.lastError;
		delete agent.lastExitCode;
		this.saveAgents(feature.id, agents);
		return agent;
	}

	isAgentBranchMerged(agent: Agent, feature: Feature): boolean {
		if (!agent.worktreePath) return true;
		const shortId = agent.id.slice(0, 8);
		const agentBranch = this.agentBranchName(feature, shortId);
		try {
			execSync(
				`git merge-base --is-ancestor "${agentBranch}" "${feature.branch}"`,
				{
					cwd: this.repoRoot,
					stdio: "ignore",
				},
			);
			return true;
		} catch {
			return false;
		}
	}

	deleteAgent(agentId: string, featureId: string): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (agent?.worktreePath) {
			const result = this.removeWorktree(agent.worktreePath);
			if (!result.removed) return;
		}
		this.saveAgents(
			featureId,
			agents.filter((a) => a.id !== agentId),
		);
		this.acknowledgeReview(agentId, featureId);
	}

	deleteAllAgents(featureId: string): void {
		const before = this.loadAgents(featureId);
		const remaining = before.filter((agent) => {
			if (!agent.worktreePath) return false;
			return !this.removeWorktree(agent.worktreePath).removed;
		});
		this.saveAgents(featureId, remaining);
		const stillPresent = new Set(remaining.map((a) => a.id));
		for (const agent of before) {
			if (!stillPresent.has(agent.id)) {
				this.acknowledgeReview(agent.id, featureId);
			}
		}
	}

	/** Remove only the agent worktree; keep its record until Feature cleanup succeeds. */
	async removeAgentWorktreeForFinish(
		agentId: string,
		featureId: string,
		force = false,
	): Promise<AgentWorktreeRemovalResult> {
		const agent = this.loadAgents(featureId).find(
			(candidate) => candidate.id === agentId,
		);
		if (!agent) return { removed: false, reason: "Agent record not found" };
		if (!agent.worktreePath) return { removed: true };
		return this.removeWorktreeAsync(agent.worktreePath, force);
	}

	/** Stable Git branch identity for a per-agent worktree, even after removal. */
	getAgentBranchName(feature: Feature, agentId: string): string {
		return this.agentBranchName(feature, agentId.slice(0, 8));
	}

	private withAttentionStatus(agent: Agent): Agent {
		const attention = this.attentionResolver.resolve(agent);
		return {
			...agent,
			attentionStatus: attention.status,
			attentionReason: attention.reason,
			attentionSource: attention.source,
		};
	}

	/**
	 * Merge a review-inbox receipt onto a read-path copy of an agent. The
	 * receipt lives in its own file (see `Store.loadReviewInbox`), never in
	 * `agents.json`, so this merge happens only here — never inside
	 * `loadAgents()`/`saveAgents()`, which stay the single source of truth
	 * for what actually gets written to `agents.json`.
	 */
	private withPendingReview(
		agent: Agent,
		pending: Record<string, string>,
	): Agent {
		const reviewId = pending[agent.id];
		return reviewId ? { ...agent, pendingReviewId: reviewId } : agent;
	}

	/** Reads the review inbox from disk and refreshes the in-memory snapshot backing {@link peekPendingReviewId}. */
	private loadReviewInbox(featureId: string): Record<string, string> {
		const pending = this.store.loadReviewInbox(featureId);
		this.lastKnownReviewInbox.set(featureId, pending);
		return pending;
	}

	/** Persists the review inbox and refreshes the in-memory snapshot backing {@link peekPendingReviewId}. */
	private saveReviewInbox(
		featureId: string,
		pending: Record<string, string>,
	): void {
		this.store.saveReviewInbox(featureId, pending);
		this.lastKnownReviewInbox.set(featureId, pending);
	}

	private loadAgents(featureId: string): Agent[] {
		if (!this.agentsByFeature.has(featureId)) {
			const agents = this.normalizeAgentSessions(
				featureId,
				this.store.loadAgents(featureId),
			);
			this.agentsByFeature.set(featureId, agents);
		}
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by has() check above
		return this.agentsByFeature.get(featureId)!;
	}

	private saveAgents(featureId: string, agents: Agent[]): void {
		this.agentsByFeature.set(featureId, agents);
		this.store.saveAgents(featureId, agents);
	}

	private mutateReadModel(
		featureId: string,
		agentId: string,
		mutate: (agent: Agent) => void,
	): void {
		const cached = this.agentsByFeature.get(featureId);
		const agents = cached ?? this.store.loadAgents(featureId);
		const agent = agents.find((candidate) => candidate.id === agentId);
		if (!agent) return;
		mutate(agent);
		if (cached) this.saveAgents(featureId, agents);
		else this.store.saveAgents(featureId, agents);
	}

	private normalizeAgentSessions(featureId: string, agents: Agent[]): Agent[] {
		let changed = false;
		const label = this.sessionLabel(featureId);

		for (const agent of agents) {
			const preferredSession = this.tmux.sessionName(label, agent.id);
			const currentSession =
				agent.tmuxSession ?? this.tmux.legacySessionName(featureId, agent.id);

			if (currentSession !== preferredSession) {
				const adopted = this.tmux.adoptSession(
					preferredSession,
					currentSession,
				);
				if (!adopted) {
					if (agent.tmuxSession === undefined) {
						agent.tmuxSession = currentSession;
						changed = true;
					}
					continue;
				}
			}

			if (agent.tmuxSession !== preferredSession) {
				agent.tmuxSession = preferredSession;
				changed = true;
			}
		}

		if (changed) {
			this.store.saveAgents(featureId, agents);
		}

		return agents;
	}

	private removeWorktree(
		worktreePath: string,
		force = false,
	): AgentWorktreeRemovalResult {
		if (!isWorktreePathSafe(worktreePath, this.worktreeBase)) {
			return {
				removed: false,
				worktreePath,
				reason: `Refusing to remove worktree outside base: ${worktreePath}`,
			};
		}
		try {
			// Fail-closed by default: git refuses to remove a worktree that
			// contains modified/untracked files unless --force is passed.
			// We never force as the nominal path.
			execSync(
				`git worktree remove "${worktreePath}"${force ? " --force" : ""}`,
				{
					cwd: this.repoRoot,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			return { removed: true, worktreePath };
		} catch (err) {
			if (!fs.existsSync(worktreePath)) {
				return { removed: true, worktreePath };
			}
			return {
				removed: false,
				worktreePath,
				reason: `Git refused to remove agent worktree: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private async removeWorktreeAsync(
		worktreePath: string,
		force = false,
	): Promise<AgentWorktreeRemovalResult> {
		if (!isWorktreePathSafe(worktreePath, this.worktreeBase)) {
			return {
				removed: false,
				worktreePath,
				reason: `Refusing to remove worktree outside base: ${worktreePath}`,
			};
		}
		try {
			// Fail-closed by default: git refuses to remove a worktree that
			// contains modified/untracked files unless --force is passed.
			// We never force as the nominal path.
			await this.execFileAsync(
				"git",
				["worktree", "remove", worktreePath, ...(force ? ["--force"] : [])],
				{
					cwd: this.repoRoot,
					encoding: "utf8",
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			return { removed: true, worktreePath };
		} catch (err) {
			if (!fs.existsSync(worktreePath)) {
				return { removed: true, worktreePath };
			}
			return {
				removed: false,
				worktreePath,
				reason: `Git refused to remove agent worktree: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private worktreeExists(worktreePath: string): boolean {
		try {
			return fs.existsSync(path.join(worktreePath, ".git"));
		} catch {
			return false;
		}
	}

	private agentBranchName(feature: Feature, shortId: string): string {
		return `feat/${normalizeFeatureName(feature.name)}/agent-${shortId}`;
	}

	private agentWorktreePath(feature: Feature, shortId: string): string {
		return path.join(
			this.worktreeBase,
			`${normalizeFeatureName(feature.name)}--${shortId}`,
		);
	}

	private nextDefaultName(agents: Agent[]): string {
		return `Agent ${agents.length + 1}`;
	}

	/**
	 * Map a featureId to a tmux-friendly label. For `base:<projectId>` features
	 * this returns the repo's checked-out branch name (e.g. "main"); for regular
	 * features the featureId is returned as-is.
	 */
	private sessionLabel(featureId: string): string {
		if (!featureId.startsWith("base:")) {
			return featureId;
		}
		return this.getDefaultBranch();
	}

	private getDefaultBranch(): string {
		if (this.cachedDefaultBranch !== undefined) {
			return this.cachedDefaultBranch;
		}
		const configured = this.config.baseBranch?.trim();
		if (configured) {
			this.cachedDefaultBranch = configured;
			return configured;
		}
		let branch: string;
		try {
			branch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: this.repoRoot,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			branch = "main";
		}
		this.cachedDefaultBranch = branch;
		return branch;
	}

	setProjectConfig(config: ProjectConfig): void {
		this.config = config;
		this.cachedDefaultBranch = undefined;
	}
}
