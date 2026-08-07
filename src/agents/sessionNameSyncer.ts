import type { ProjectManager } from "../projects/projectManager";
import type { SessionRenameAdapter } from "./sessionProviders/types";

const MAX_TITLE_LENGTH = 40;

export class SessionNameSyncer {
	private readonly knownTitles = new Map<string, string>();
	private readonly adapters = new Map<string, SessionRenameAdapter>();
	private projectManager: ProjectManager | undefined;
	private onRenameCallback?: (agentId: string, featureId: string) => void;

	constructor(adapters: SessionRenameAdapter[]) {
		for (const adapter of adapters) {
			this.adapters.set(adapter.toolId, adapter);
		}
	}

	onAgentRenamed(callback: (agentId: string, featureId: string) => void): void {
		this.onRenameCallback = callback;
	}

	start(projectManager: ProjectManager): void {
		this.projectManager = projectManager;
	}

	syncAll(): void {
		if (!this.projectManager) return;

		for (const ctx of this.projectManager.getAllContexts()) {
			for (const feature of ctx.featureManager.getFeatures()) {
				const agents = ctx.agentManager.getAgents(feature.id);
				for (const agent of agents) {
					const adapter = this.getAdapter(agent.toolId);
					if (!adapter) continue;
					if (agent.status === "done") continue;
					if (!agent.sessionId) continue;

					const title = adapter.readName(agent.sessionId);
					if (!title) continue;

					const truncated = this.truncateTitle(title);
					const previous = this.knownTitles.get(agent.sessionId);
					this.knownTitles.set(agent.sessionId, truncated);

					if (
						agent.name !== truncated &&
						this.shouldRename(agent.name, previous)
					) {
						ctx.agentManager.renameAgent(agent.id, feature.id, truncated);
						this.onRenameCallback?.(agent.id, feature.id);
					}
				}
			}
		}
	}

	syncAgentOnFocus(agentId: string): void {
		if (!this.projectManager) return;

		for (const ctx of this.projectManager.getAllContexts()) {
			for (const feature of ctx.featureManager.getFeatures()) {
				const agents = ctx.agentManager.getAgents(feature.id);
				const agent = agents.find((a) => a.id === agentId);
				if (!agent) continue;

				const adapter = this.getAdapter(agent.toolId);
				if (!adapter) return;
				if (agent.status === "done") return;
				if (!agent.sessionId) return;

				const title = adapter.readName(agent.sessionId);
				if (!title) return;

				const truncated = this.truncateTitle(title);
				const previous = this.knownTitles.get(agent.sessionId);
				if (previous === truncated) return;

				this.knownTitles.set(agent.sessionId, truncated);
				if (!this.shouldRename(agent.name, previous)) return;
				ctx.agentManager.renameAgent(agent.id, feature.id, truncated);
				this.onRenameCallback?.(agent.id, feature.id);
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
		this.knownTitles.clear();
		for (const adapter of this.adapters.values()) {
			adapter.dispose?.();
		}
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
