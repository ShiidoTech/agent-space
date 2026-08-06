import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeFeatureName } from "../features/featureName";
import type { ProjectConfig } from "../projects/projectConfig";
import type { Store } from "../storage/store";
import type { Agent, AgentStatus, Feature } from "../types";
import { isWorktreePathSafe } from "../utils/worktreeGuard";
import type { TmuxIntegration } from "./tmux";

export class AgentManager {
	private agentsByFeature = new Map<string, Agent[]>();
	private cachedDefaultBranch: string | undefined;
	private invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly store: Store,
		private readonly repoRoot: string,
		private readonly worktreeBase: string,
		private readonly tmux: TmuxIntegration,
		private readonly config: ProjectConfig = {},
	) {}

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
		return [...this.loadAgents(featureId)];
	}

	getAgent(featureId: string, agentId: string): Agent | undefined {
		return this.loadAgents(featureId).find((a) => a.id === agentId);
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

		// Claude gets a pre-assigned session ID; Codex auto-generates its own
		// (discovered post-launch by CodexSessionWatcher); others get none
		const sessionId =
			!toolId || toolId === "claude" ? crypto.randomUUID() : null;

		const agent: Agent = {
			id,
			featureId: feature.id,
			name,
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

	renameAgent(agentId: string, featureId: string, name: string): void {
		const agents = this.loadAgents(featureId);
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		agent.name = name;
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
			this.removeWorktree(agent.worktreePath);
		}
		this.saveAgents(
			featureId,
			agents.filter((a) => a.id !== agentId),
		);
	}

	deleteAllAgents(featureId: string): void {
		for (const agent of this.loadAgents(featureId)) {
			if (agent.worktreePath) {
				this.removeWorktree(agent.worktreePath);
			}
		}
		this.saveAgents(featureId, []);
		this.store.deleteFeatureData(featureId);
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
				this.tmux.adoptSession(preferredSession, currentSession);
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

	private removeWorktree(worktreePath: string, force = false): void {
		if (!isWorktreePathSafe(worktreePath, this.worktreeBase)) {
			console.error(
				`[AgentManager] Refusing to remove worktree outside base: "${worktreePath}"`,
			);
			return;
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
		} catch (err) {
			console.error(`[AgentManager] Failed to remove worktree: ${err}`);
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
}
