import * as crypto from "node:crypto";
import * as path from "node:path";
import { AgentManager } from "../agents/agentManager";
import { CodingToolRegistry } from "../agents/codingToolRegistry";
import type { TerminalController } from "../agents/terminalController";
import { TmuxIntegration } from "../agents/tmux";
import { FeatureManager } from "../features/featureManager";
import { FeatureGitInspector } from "../git/featureGitInspector";
import { GitClient } from "../git/gitClient";
import { ServiceManager } from "../services/serviceManager";
import type { GlobalStore } from "../storage/globalStore";
import { Store } from "../storage/store";
import type { Feature, Project } from "../types";
import {
	loadProjectConfig,
	type ProjectConfig,
	replaceProjectConfig,
	resolveWorktreeBaseDir,
	saveProjectConfig,
} from "./projectConfig";

export interface ProjectContext {
	project: Project;
	store: Store;
	featureManager: FeatureManager;
	agentManager: AgentManager;
	serviceManager: ServiceManager;
	gitClient: GitClient;
	featureGitInspector: FeatureGitInspector;
	config: ProjectConfig;
}

/**
 * Scope of a change notification, when known, so listeners (in particular
 * `FeatureStateCoordinator`) can invalidate only the affected Feature/Project
 * instead of treating every mutation as workspace-wide.
 */
export interface ProjectChangeScope {
	readonly projectId?: string;
	readonly featureId?: string;
	/**
	 * `false` when the change is a live state update (status, name, service
	 * status, ...) that never adds/removes a card in the Project/Feature/Agent
	 * tree, so listeners may patch the existing webview DOM instead of
	 * rebuilding it. Omit (or `true`) for anything structural — the default
	 * is fail-safe: unknown scope means a full rebuild.
	 */
	readonly structural?: boolean;
}

export class ProjectManager {
	private contexts = new Map<string, ProjectContext>();
	private featureToProject = new Map<string, string>();
	private onChangeCallbacks: Array<(scope?: ProjectChangeScope) => void> = [];

	constructor(
		private readonly globalStore: GlobalStore,
		private readonly storagePath: string,
		private readonly worktreeRelativePath: string = ".worktrees",
		private readonly tmux: TmuxIntegration = new TmuxIntegration(),
		private readonly toolRegistry: CodingToolRegistry = new CodingToolRegistry(),
	) {}

	/** Register a callback fired when projects/features change. */
	onChange(callback: (scope?: ProjectChangeScope) => void): void {
		this.onChangeCallbacks.push(callback);
	}

	/** Omit `scope` only when the change is genuinely workspace-wide. */
	notifyChange(scope?: ProjectChangeScope): void {
		for (const cb of this.onChangeCallbacks) {
			cb(scope);
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
		this.notifyChange({ projectId: project.id });
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
		this.notifyChange({ projectId });
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
		this.notifyChange({ projectId });
		return config;
	}

	replaceProjectConfig(
		projectId: string,
		config: ProjectConfig,
	): ProjectConfig | undefined {
		const project = this.getProjects().find(
			(candidate) => candidate.id === projectId,
		);
		if (!project) return undefined;

		const nextConfig = replaceProjectConfig(project.repoPath, config);
		const context = this.contexts.get(projectId);
		if (context) {
			context.config = nextConfig;
			context.featureManager.setProjectConfig(nextConfig);
			context.agentManager.setProjectConfig(nextConfig);
		}
		this.notifyChange({ projectId });
		return nextConfig;
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
			this.notifyChange({ projectId });
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
			this.notifyChange({ projectId, featureId });
			return;
		}

		// projects/{id}/features/{fid}/review-inbox.json → live patch, never a
		// full rebuild: this file can never add/remove an agent (issue #120
		// PR2 review round 2, blocker 2), so a self-write from this window's
		// own AgentFocusService.acknowledgeReview, or a genuine write from a
		// sibling window, is always safely structural: false. No agent-cache
		// invalidation needed: `AgentManager` re-reads the review inbox from
		// disk on every call, uncached.
		if (
			parts.length === 5 &&
			parts[0] === "projects" &&
			parts[2] === "features" &&
			parts[4] === "review-inbox.json"
		) {
			const projectId = parts[1];
			const featureId = parts[3];
			this.notifyChange({ projectId, featureId, structural: false });
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
			this.notifyChange({ projectId, featureId });
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

	observeTmuxSessions() {
		return this.tmux.observeSessions();
	}

	/**
	 * Canonical non-blocking tmux sweep — one call yields liveness AND
	 * pane-dead/exit-code/tty for every session. Used by the hot
	 * `reconcilePresence` tick, shared by every downstream
	 * AgentManager/ServiceManager refresh in that tick instead of each
	 * re-probing tmux individually.
	 */
	observeTmuxPanesAsync() {
		return this.tmux.observePanesAsync();
	}

	agentTmuxSessionName(
		featureId: string,
		agentId: string,
		persisted?: string,
	): string {
		return persisted ?? this.tmux.sessionName(featureId, agentId);
	}

	/**
	 * Same lookup as {@link findContextByFeatureId}, but never calls
	 * `featureManager.getFeature()` — which reconciles branch links with a
	 * synchronous Git exec. Existence is checked against
	 * `listFeaturesCached()` instead (in-memory, no exec), so this is safe
	 * to call from both a hot, latency-sensitive path (e.g. every
	 * agent-focus click) and a background poll tick (e.g. every attention
	 * scan) without ever blocking the Extension Host on Git. `getContext()`
	 * may still lazily construct a project's managers on first touch (cheap,
	 * in-memory), same as the non-fast lookup.
	 */
	findContextByFeatureIdFast(featureId: string): ProjectContext | undefined {
		if (featureId.startsWith("base:")) {
			return this.getContext(featureId.slice("base:".length));
		}

		const projectId = this.featureToProject.get(featureId);
		if (projectId) {
			const ctx = this.getContext(projectId);
			if (
				ctx?.featureManager
					.listFeaturesCached()
					.some((feature) => feature.id === featureId)
			) {
				return ctx;
			}
			this.featureToProject.delete(featureId);
		}

		for (const ctx of this.getAllContexts()) {
			if (
				ctx.featureManager
					.listFeaturesCached()
					.some((feature) => feature.id === featureId)
			) {
				this.featureToProject.set(featureId, ctx.project.id);
				return ctx;
			}
		}
		return undefined;
	}

	/**
	 * Strictly cache-only lookup: returns a context only if it — and, for a
	 * regular feature, its project mapping — are already warm in memory.
	 * Unlike {@link findContextByFeatureIdFast}, this NEVER reads
	 * `projects.json`, never calls `getProjects()`/`getAllContexts()`, and
	 * never constructs a context: a cold cache returns `undefined` rather
	 * than falling back to any of that. Fail-closed by design — callers on
	 * a genuinely hot path (e.g. a peek that must stay zero-I/O, see
	 * `AgentFocusService`'s G1) are expected to treat `undefined` as "skip,
	 * don't resolve" rather than as an error (issue #120 PR2, review
	 * round 4).
	 */
	peekWarmContext(featureId: string): ProjectContext | undefined {
		if (featureId.startsWith("base:")) {
			return this.contexts.get(featureId.slice("base:".length));
		}
		const projectId = this.featureToProject.get(featureId);
		return projectId ? this.contexts.get(projectId) : undefined;
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

	/**
	 * Zero-I/O twin of {@link resolveFeature}: uses {@link peekWarmContext}
	 * (strictly cache-only, never lazy-inits a project's Store/FeatureManager)
	 * and {@link FeatureManager.getFeatureCached} (no Git branch-link
	 * reconciliation). For render/navigation paths (P0 zero-I/O UI mandate)
	 * that only need feature identity, not up-to-the-moment checkout state —
	 * a cold cache returns `undefined` rather than paying to warm it.
	 */
	resolveFeatureCached(
		featureId: string,
	): { ctx: ProjectContext; feature: Feature } | undefined {
		const ctx = this.peekWarmContext(featureId);
		if (!ctx) return undefined;

		if (featureId.startsWith("base:")) {
			// Zero-I/O: getBaseFeatureCached() never runs Git — unlike
			// getBaseFeature(), which can fall into a synchronous
			// `git rev-parse --abbrev-ref HEAD` when baseBranch isn't configured
			// or cached yet. The base card is clickable via showFeature("base:...")
			// so this path must stay Git-free before first paint (P0 zero-I/O UI
			// mandate).
			const feature = ctx.featureManager.getBaseFeatureCached(ctx.project.id);
			return { ctx, feature };
		}

		const feature = ctx.featureManager.getFeatureCached(featureId);
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
		const gitClient = new GitClient();
		const featureGitInspector = new FeatureGitInspector(gitClient);
		const featureManager = new FeatureManager(
			store,
			project.repoPath,
			worktreeBase,
			config,
		);
		featureManager.setOnChange(() =>
			this.notifyChange({ projectId: project.id }),
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
		for (const feature of store.loadFeatures()) {
			this.featureToProject.set(feature.id, project.id);
		}

		return {
			project,
			store,
			featureManager,
			agentManager,
			serviceManager,
			gitClient,
			featureGitInspector,
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

	async deleteProjectFeatureData(projectId: string): Promise<void> {
		const ctx = this.getContext(projectId);
		if (!ctx) return;

		for (const feature of [...ctx.featureManager.getFeatures()]) {
			ctx.serviceManager.deleteAllServices(feature.id);
			ctx.agentManager.deleteAllAgents(feature.id);
			await ctx.featureManager.deleteFeature(feature.id);
		}
	}
}
