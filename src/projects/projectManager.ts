import * as crypto from "node:crypto";
import * as path from "node:path";
import { AgentManager } from "../agents/agentManager";
import { CodingToolRegistry } from "../agents/codingToolRegistry";
import type { TerminalController } from "../agents/terminalController";
import { TmuxIntegration } from "../agents/tmux";
import { FeatureManager } from "../features/featureManager";
import { ServiceManager } from "../services/serviceManager";
import type { GlobalStore } from "../storage/globalStore";
import { Store } from "../storage/store";
import type { Feature, Project } from "../types";
import {
	loadProjectConfig,
	type ProjectConfig,
	resolveWorktreeBaseDir,
	saveProjectConfig,
} from "./projectConfig";

export interface ProjectContext {
	project: Project;
	store: Store;
	featureManager: FeatureManager;
	agentManager: AgentManager;
	serviceManager: ServiceManager;
	config: ProjectConfig;
}

export class ProjectManager {
	private contexts = new Map<string, ProjectContext>();
	private featureToProject = new Map<string, string>();
	private onChangeCallbacks: Array<() => void> = [];

	constructor(
		private readonly globalStore: GlobalStore,
		private readonly storagePath: string,
		private readonly worktreeRelativePath: string = ".worktrees",
		private readonly tmux: TmuxIntegration = new TmuxIntegration(),
		private readonly toolRegistry: CodingToolRegistry = new CodingToolRegistry(),
	) {}

	/** Register a callback fired when projects are added/removed. */
	onChange(callback: () => void): void {
		this.onChangeCallbacks.push(callback);
	}

	notifyChange(): void {
		for (const cb of this.onChangeCallbacks) {
			cb();
		}
	}

	// ── CRUD ─────────────────────────────────────────────

	getProjects(): Project[] {
		return this.globalStore.getProjects();
	}

	addProject(repoPath: string, name?: string): Project {
		const projects = this.getProjects();
		if (projects.some((p) => p.repoPath === repoPath)) {
			throw new Error(`Project at "${repoPath}" is already registered`);
		}

		const project: Project = {
			id: crypto.randomUUID(),
			name: name ?? path.basename(repoPath),
			repoPath,
		};

		projects.push(project);
		this.globalStore.saveProjects(projects);
		this.notifyChange();
		return project;
	}

	removeProject(projectId: string): void {
		// Clear reverse index entries for this project's features
		const ctx = this.contexts.get(projectId);
		if (ctx) {
			for (const feature of ctx.featureManager.getFeatures()) {
				this.featureToProject.delete(feature.id);
			}
		}

		const projects = this.getProjects().filter((p) => p.id !== projectId);
		this.globalStore.saveProjects(projects);
		this.contexts.delete(projectId);
		this.notifyChange();
	}

	updateProjectConfig(
		projectId: string,
		updates: Partial<ProjectConfig>,
	): ProjectConfig | undefined {
		const project = this.getProjects().find(
			(candidate) => candidate.id === projectId,
		);
		if (!project) return undefined;

		const config = saveProjectConfig(project.repoPath, updates);
		const context = this.contexts.get(projectId);
		if (context) {
			context.config = config;
			context.featureManager.setProjectConfig(config);
			context.agentManager.setProjectConfig(config);
		}
		this.notifyChange();
		return config;
	}

	// ── Cross-window sync ────────────────────────────────

	handleExternalFileChange(uri: { fsPath: string }): void {
		const rel = path.relative(this.storagePath, uri.fsPath);
		const parts = rel.split(path.sep);

		// projects.json → reload project list
		if (parts.length === 1 && parts[0] === "projects.json") {
			this.contexts.clear();
			this.featureToProject.clear();
			this.notifyChange();
			return;
		}

		// preferences.json → just notify (HomePanel re-reads on refresh)
		if (parts.length === 1 && parts[0] === "preferences.json") {
			this.notifyChange();
			return;
		}

		// projects/{id}/features.json → reload features
		if (
			parts.length === 3 &&
			parts[0] === "projects" &&
			parts[2] === "features.json"
		) {
			const projectId = parts[1];
			const ctx = this.contexts.get(projectId);
			if (ctx) ctx.featureManager.reload();
			this.notifyChange();
			return;
		}

		// projects/{id}/features/{fid}/agents.json → invalidate agent cache
		if (
			parts.length === 5 &&
			parts[0] === "projects" &&
			parts[2] === "features" &&
			parts[4] === "agents.json"
		) {
			const projectId = parts[1];
			const featureId = parts[3];
			const ctx = this.contexts.get(projectId);
			if (ctx) ctx.agentManager.invalidateFeature(featureId);
			this.notifyChange();
			return;
		}

		// projects/{id}/features/{fid}/services.json → invalidate service cache
		if (
			parts.length === 5 &&
			parts[0] === "projects" &&
			parts[2] === "features" &&
			parts[4] === "services.json"
		) {
			const projectId = parts[1];
			const featureId = parts[3];
			const ctx = this.contexts.get(projectId);
			if (ctx) ctx.serviceManager.invalidateFeature(featureId);
			this.notifyChange();
			return;
		}
	}

	// ── Context lifecycle ────────────────────────────────

	getContext(projectId: string): ProjectContext | undefined {
		if (!this.contexts.has(projectId)) {
			const project = this.getProjects().find((p) => p.id === projectId);
			if (!project) return undefined;
			this.contexts.set(projectId, this.initializeContext(project));
		}
		return this.contexts.get(projectId);
	}

	getAllContexts(): ProjectContext[] {
		for (const project of this.getProjects()) {
			if (!this.contexts.has(project.id)) {
				this.contexts.set(project.id, this.initializeContext(project));
			}
		}
		return [...this.contexts.values()];
	}

	/** Return the current tmux sessions without mutating any session state. */
	listTmuxSessions(): string[] {
		return this.tmux.listSessions();
	}

	findContextByFeatureId(featureId: string): ProjectContext | undefined {
		if (featureId.startsWith("base:")) {
			const projectId = featureId.slice("base:".length);
			return this.getContext(projectId);
		}

		// Fast path: O(1) lookup via reverse index
		const projectId = this.featureToProject.get(featureId);
		if (projectId) {
			const ctx = this.getContext(projectId);
			if (ctx?.featureManager.getFeature(featureId)) {
				return ctx;
			}
			// Index was stale — remove and fall through
			this.featureToProject.delete(featureId);
		}

		// Slow path: linear scan (populates index on hit)
		for (const ctx of this.getAllContexts()) {
			if (ctx.featureManager.getFeature(featureId)) {
				this.featureToProject.set(featureId, ctx.project.id);
				return ctx;
			}
		}
		return undefined;
	}

	/**
	 * Resolve a featureId (regular or `base:<projectId>`) to its context and Feature object.
	 */
	resolveFeature(
		featureId: string,
	): { ctx: ProjectContext; feature: Feature } | undefined {
		const ctx = this.findContextByFeatureId(featureId);
		if (!ctx) return undefined;

		if (featureId.startsWith("base:")) {
			const feature = ctx.featureManager.getBaseFeature(ctx.project.id);
			return { ctx, feature };
		}

		const feature = ctx.featureManager.getFeature(featureId);
		if (!feature) return undefined;
		return { ctx, feature };
	}

	static isBaseFeatureId(featureId: string): boolean {
		return featureId.startsWith("base:");
	}

	// ── Internal ─────────────────────────────────────────

	private initializeContext(project: Project): ProjectContext {
		const storeDir = path.join(this.storagePath, "projects", project.id);
		const store = new Store(storeDir);

		// Per-repository configuration (base branch, branch kinds, dedicated
		// worktrees dir) read from `<repo>/.agentspace/config.json`.
		const config = loadProjectConfig(project.repoPath);
		const worktreeBase = resolveWorktreeBaseDir(
			project.repoPath,
			config,
			this.worktreeRelativePath,
		);
		const featureManager = new FeatureManager(
			store,
			project.repoPath,
			worktreeBase,
			config,
		);
		const agentManager = new AgentManager(
			store,
			project.repoPath,
			worktreeBase,
			this.tmux,
			config,
			this.toolRegistry,
		);
		const serviceManager = new ServiceManager(
			store,
			project.repoPath,
			this.tmux,
		);

		// Populate reverse index
		for (const feature of featureManager.getFeatures()) {
			this.featureToProject.set(feature.id, project.id);
		}

		return {
			project,
			store,
			featureManager,
			agentManager,
			serviceManager,
			config,
		};
	}

	killProjectSessions(
		projectId: string,
		terminalController?: Pick<TerminalController, "killFeatureTerminals">,
	): void {
		const ctx = this.getContext(projectId);
		if (!ctx) return;

		for (const feature of ctx.featureManager.getFeatures()) {
			if (terminalController) {
				terminalController.killFeatureTerminals(feature.id);
				continue;
			}

			for (const agent of ctx.agentManager.getAgents(feature.id)) {
				this.tmux.killSession(
					agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id),
				);
				this.tmux.killSession(
					this.tmux.legacySessionName(feature.id, agent.id),
				);
			}

			for (const service of ctx.serviceManager.getServices(feature.id)) {
				this.tmux.killSession(service.tmuxSession);
			}
		}
	}

	deleteProjectFeatureData(projectId: string): void {
		const ctx = this.getContext(projectId);
		if (!ctx) return;

		for (const feature of [...ctx.featureManager.getFeatures()]) {
			ctx.serviceManager.deleteAllServices(feature.id);
			ctx.agentManager.deleteAllAgents(feature.id);
			ctx.featureManager.deleteFeature(feature.id);
		}
	}
}
