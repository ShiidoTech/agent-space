import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent } from "../types";
import type { SessionRenameAdapter } from "./sessionProviders/types";

const MAX_TITLE_LENGTH = 40;
const UNNAMED_SYNC_INTERVAL_MS = 15_000;

export class SessionNameSyncer {
	private readonly knownTitles = new Map<string, string>();
	private readonly adapters = new Map<string, SessionRenameAdapter>();
	private projectManager: ProjectManager | undefined;
	private syncTimer?: ReturnType<typeof setInterval>;
	private onRenameCallback?: (agentId: string, featureId: string) => void;

	constructor(adapters: SessionRenameAdapter[]) {
		for (const adapter of adapters) {
			this.adapters.set(adapter.toolId, adapter);
		}
	}

	onAgentRenamed(callback: (agentId: string, featureId: string) => void): void {
		this.onRenameCallback = callback;
	}

	start(
		projectManager: ProjectManager,
		pollIntervalMs = UNNAMED_SYNC_INTERVAL_MS,
	): void {
		this.projectManager = projectManager;
		this.stopPolling();
		if (pollIntervalMs <= 0) return;

		// Provider titles are often created shortly after the CLI starts. Retry
		// only still-unnamed agents so a long-running active terminal does not
		// require a focus change, while avoiding repeated scans of user-owned
		// or already-synced sessions.
		this.syncTimer = setInterval(
			() => this.syncUnnamedAgents(),
			pollIntervalMs,
		);
		this.syncTimer.unref?.();
	}

	syncAll(): void {
		if (!this.projectManager) return;

		for (const ctx of this.projectManager.getAllContexts()) {
			for (const featureId of this.getManagedFeatureIds(ctx)) {
				for (const agent of ctx.agentManager.getAgents(featureId)) {
					this.syncAgent(ctx, featureId, agent);
				}
			}
		}
	}

	syncAgentOnFocus(agentId: string): void {
		if (!this.projectManager) return;

		for (const ctx of this.projectManager.getAllContexts()) {
			for (const featureId of this.getManagedFeatureIds(ctx)) {
				const agent = ctx.agentManager
					.getAgents(featureId)
					.find((candidate) => candidate.id === agentId);
				if (!agent) continue;

				this.syncAgent(ctx, featureId, agent);
				return;
			}
		}
	}

	clearFeature(featureId: string): void {
		if (!this.projectManager) return;

		const ctx = this.projectManager.findContextByFeatureId(featureId);
		if (!ctx) return;

		const agents = ctx.agentManager.getAgents(featureId);
		for (const agent of agents) {
			if (!agent.sessionId) continue;
			this.knownTitles.delete(agent.sessionId);
			for (const adapter of this.adapters.values()) {
				adapter.clearCache?.(agent.sessionId);
			}
		}
	}

	dispose(): void {
		this.stopPolling();
		this.knownTitles.clear();
		for (const adapter of this.adapters.values()) {
			adapter.dispose?.();
		}
	}

	private syncUnnamedAgents(): void {
		if (!this.projectManager) return;

		for (const ctx of this.projectManager.getAllContexts()) {
			for (const featureId of this.getManagedFeatureIds(ctx)) {
				for (const agent of ctx.agentManager.getAgents(featureId)) {
					if (!this.isUnnamed(agent.name)) continue;
					this.syncAgent(ctx, featureId, agent);
				}
			}
		}
	}

	private syncAgent(
		ctx: ProjectContext,
		featureId: string,
		agent: Agent,
	): void {
		const adapter = this.getAdapter(agent.toolId);
		if (!adapter) return;
		if (agent.status === "done") return;
		if (!agent.sessionId) return;

		const title = adapter.readName(agent.sessionId);
		if (!title) return;

		const truncated = this.truncateTitle(title);
		const previous = this.knownTitles.get(agent.sessionId);
		this.knownTitles.set(agent.sessionId, truncated);

		if (agent.name !== truncated && this.shouldRename(agent.name, previous)) {
			ctx.agentManager.renameAgent(agent.id, featureId, truncated);
			this.onRenameCallback?.(agent.id, featureId);
		}
	}

	private getManagedFeatureIds(ctx: ProjectContext): string[] {
		const baseFeatureId = ctx.featureManager.getBaseFeature(ctx.project.id).id;
		// Name synchronization only needs stable feature ids. Read the persisted
		// feature list directly so the 15s retry loop never triggers Git branch
		// reconciliation or any other worktree side effect.
		return [
			baseFeatureId,
			...ctx.store.loadFeatures().map((feature) => feature.id),
		];
	}

	private stopPolling(): void {
		if (!this.syncTimer) return;
		clearInterval(this.syncTimer);
		this.syncTimer = undefined;
	}

	private getAdapter(toolId?: string): SessionRenameAdapter | undefined {
		return this.adapters.get(toolId ?? "claude");
	}

	private isUnnamed(name: string): boolean {
		return /^(New Agent|Agent \d+)/.test(name);
	}

	private shouldRename(
		name: string,
		previousTitle: string | undefined,
	): boolean {
		if (this.isUnnamed(name)) return true;
		// A name equal to the last title observed for this session was assigned
		// by the syncer during this process. A different name is user-owned.
		return previousTitle === name;
	}

	private truncateTitle(title: string, max = MAX_TITLE_LENGTH): string {
		const cleaned = title.replace(/\s+/g, " ").trim();
		if (cleaned.length <= max) return cleaned;
		return `${cleaned.slice(0, max - 1)}\u2026`;
	}
}
