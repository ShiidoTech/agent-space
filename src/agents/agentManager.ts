import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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
import { AgentObservationResolver } from "./observation/agentObservationResolver";
import type { TmuxIntegration } from "./tmux";

export interface AgentWorktreeRemovalResult {
	readonly removed: boolean;
	readonly worktreePath?: string;
	readonly reason?: string;
}

export class AgentManager {
	private agentsByFeature = new Map<string, Agent[]>();
	private cachedDefaultBranch: string | undefined;
	private invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly attentionResolver: AgentAttentionResolver;
	private readonly observationResolver: AgentObservationResolver;

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

	/**
	 * True when the tool resolved by the registry is a claude-family CLI
	 * (built-in "claude", or a wrapped variant declared via
	 * `agentSpace.codingTools` with an explicit `family: "claude"` or a
	 * claude-prefixed id). Delegates to the registry — the single source of
	 * truth for tool identity and family.
	 */
	private isClaudeFamilyTool(toolId?: string): boolean {
		return this.toolRegistry.isClaudeFamilyTool(toolId);
	}

	getAgents(featureId: string): Agent[] {
		return this.loadAgents(featureId).map((agent) =>
			this.withAttentionStatus(agent),
		);
	}

	getAgent(featureId: string, agentId: string): Agent | undefined {
		const agent = this.loadAgents(featureId).find((a) => a.id === agentId);
		return agent ? this.withAttentionStatus(agent) : undefined;
	}

	getObservation(featureId: string, agentId: string) {
		const agent = this.getAgent(featureId, agentId);
		return agent ? this.observe(agent) : undefined;
	}

	observe(agent: Agent) {
		return this.observationResolver.resolve(agent);
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

		// Claude-family CLIs (built-in "claude" or a wrapped variant declared
		// in project config) get a pre-assigned session ID so a later resume
		// targets the exact same session. Codex auto-generates its own
		// (discovered post-launch); opencode/generic manage their own.
		const sessionId = this.isClaudeFamilyTool(toolId)
			? crypto.randomUUID()
			: null;

		const agent: Agent = {
			id,
			featureId: feature.id,
			name,
			nameSource: "default",
			sessionId,
			tmuxSession: this.tmux.sessionName(this.sessionLabel(feature.id), id),
			worktreePath,
			toolId,
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
	}

	deleteAllAgents(featureId: string): void {
		const remaining = this.loadAgents(featureId).filter((agent) => {
			if (!agent.worktreePath) return false;
			return !this.removeWorktree(agent.worktreePath).removed;
		});
		this.saveAgents(featureId, remaining);
	}

	/** Remove only the agent worktree; keep its record until Feature cleanup succeeds. */
	removeAgentWorktreeForFinish(
		agentId: string,
		featureId: string,
		force = false,
	): AgentWorktreeRemovalResult {
		const agent = this.loadAgents(featureId).find(
			(candidate) => candidate.id === agentId,
		);
		if (!agent) return { removed: false, reason: "Agent record not found" };
		if (!agent.worktreePath) return { removed: true };
		return this.removeWorktree(agent.worktreePath, force);
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
		};
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
