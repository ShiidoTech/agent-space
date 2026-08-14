import * as path from "node:path";
import type { Disposable } from "vscode";
import type { FeatureGitProjectObservation } from "../git/featureGitInspector";
import {
	type GitObservation,
	known,
	type ObservedCommit,
	unknown,
} from "../git/featureGitObservations";
import {
	type WorktreeBranchInventory,
	WorktreeBranchObserver,
} from "../git/worktreeBranchObserver";
import {
	type GitHubObservation,
	githubObservationFromRepository,
} from "../github/githubObservation";
import { GitHubObservationService } from "../github/githubObservationService";
import {
	HttpGitHubBackend,
	type PullRequestBackend,
} from "../github/pullRequestBackend";
import { PullRequestInspector } from "../github/pullRequestInspector";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { ProjectSummary } from "../projects/projectSummary";
import {
	GitLsRemoteBranchHeadSource,
	normalizeReferenceBranch,
	type ProjectReferenceBranchHealth,
	ProjectReferenceBranchObserver,
	type RemoteBranchHeadSource,
} from "../projects/referenceBranchHealth";
import type { Agent, Feature, Service } from "../types";
import { evaluateAttention } from "./attentionEvaluator";
import { agentSpaceDiagnostic } from "../diagnostics/agentSpaceDiagnostics";
import {
	createFeatureSnapshot,
	type FeatureDeliveryObservation,
	type FeatureSnapshot,
	type FeatureSnapshotSource,
	preferKnownDelivery,
	preferKnownGit,
	preferKnownGithub,
} from "./featureSnapshot";
import {
	evaluateIntegration,
	type MergedHeadGitEvidence,
} from "./integrationEvaluator";
import {
	type FeatureRuntimeObservation,
	knownRuntime,
	observeFeatureRuntime,
	type RuntimeObservation,
	unknownRuntime,
} from "./runtimeObservation";

const RECONCILE_INTERVAL_MS = 15_000;
/** Deep Git/GitHub evidence older than this is refreshed on next focus. */
const DEEP_STALE_MS = 45_000;

export interface FeatureStateCoordinatorOptions {
	/** Injectable GitHub transport factory (per repository). */
	readonly createGithubBackend?: (repoRoot: string) => PullRequestBackend;
	readonly githubTtlMs?: number;
	readonly githubRepositoryFactTtlMs?: number;
	/** Injectable read-only remote head source for project reference health. */
	readonly referenceBranchRemote?: RemoteBranchHeadSource;
}

export class FeatureStateCoordinator implements Disposable {
	private projectManager?: ProjectManager;
	private timer?: ReturnType<typeof setInterval>;
	private snapshots = new Map<string, FeatureSnapshot>();
	private listeners = new Set<
		(snapshot: FeatureSnapshot | undefined) => void
	>();
	private inFlight?: Promise<void>;
	private reconcileAfterFlight = false;
	private disposed = false;
	private generation = 0;
	private consumers = 0;
	/**
	 * Two independent per-feature generation lanes so a background runtime
	 * (agent/service liveness) tick can never discard an in-flight deep Git/
	 * GitHub observation, and vice versa. Each lane's commit only merges the
	 * fields it owns, reading the other lane's latest cached value at commit
	 * time rather than at start time.
	 */
	private featureDeepGenerations = new Map<string, number>();
	private featureRuntimeGenerations = new Map<string, number>();
	/**
	 * When each feature's deep Git/GitHub evidence was last actually
	 * refreshed — set only inside `commitDeep`, never by the runtime lane.
	 * `snapshot.observedAt` alone can't answer "is the deep evidence stale?"
	 * because `commitRuntime` also stamps it (on a feature's first-ever
	 * placeholder snapshot), which would otherwise read as fresh for up to
	 * `DEEP_STALE_MS` despite no deep observation ever having run.
	 */
	private featureDeepObservedAt = new Map<string, number>();
	/**
	 * When a project's repository-level facts (base ref, worktree inventory,
	 * reference-branch health, presence) were last successfully refreshed by
	 * `reconcileProject` — orthogonal to `featureDeepObservedAt`. A Project
	 * page only needs these repository facts, not every Feature deep-observed;
	 * deriving project staleness from per-feature deep freshness made a
	 * Project look stale forever unless every one of its Features had also
	 * been individually deep-observed.
	 */
	private projectRepositoryObservedAt = new Map<string, number>();
	/**
	 * Per-project generation counter that guards the publication of
	 * repository-level facts (base ref, worktree inventory, reference-branch
	 * health, `projectRepositoryObservedAt`). `invalidateProject`/
	 * `invalidateAll` bump it so an in-flight project observation that started
	 * before the mutation can never publish stale facts or re-stamp the
	 * project fresh afterwards — the same compare-and-commit discipline the
	 * per-feature deep/runtime lanes already enforce, but scoped to a project.
	 */
	private projectGenerations = new Map<string, number>();
	private githubServices = new Map<string, GitHubObservationService>();
	private projectReferenceHealth = new Map<
		string,
		ProjectReferenceBranchHealth
	>();
	private worktreeInventories = new Map<string, WorktreeBranchInventory>();
	private readonly injectedReferenceBranchRemote?: RemoteBranchHeadSource;
	private referenceBranchRemotes = new Map<
		string,
		GitLsRemoteBranchHeadSource
	>();
	private githubRefreshes = new Set<string>();
	private githubObservations = new Map<string, GitHubObservation>();
	private githubFallbacks = new Map<string, GitHubObservation>();

	constructor(
		projectManager?: ProjectManager,
		private readonly options: FeatureStateCoordinatorOptions = {},
	) {
		this.projectManager = projectManager;
		this.injectedReferenceBranchRemote = options.referenceBranchRemote;
	}

	start(
		projectManager?: ProjectManager,
		intervalMs = RECONCILE_INTERVAL_MS,
	): void {
		if (this.disposed) return;
		this.generation += 1;
		if (projectManager) this.projectManager = projectManager;
		this.stop();
		// Startup seeds lightweight presence (feature list + runtime) only.
		// Deep Git/GitHub evidence is demand-driven per Project/Feature focus.
		void this.reconcilePresence();
		this.configurePolling(intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	acquireConsumer(intervalMs = RECONCILE_INTERVAL_MS): { dispose: () => void } {
		if (this.disposed) return { dispose: () => {} };
		this.consumers += 1;
		this.configurePolling(intervalMs);
		// Becoming visible only refreshes lightweight presence/runtime facts.
		// Deep evidence for the focused Project/Feature is requested explicitly
		// by the caller (see HomePanel/FeatureSidebarProvider) when stale.
		void this.reconcilePresence();
		let released = false;
		return {
			dispose: () => {
				if (released) return;
				released = true;
				this.consumers = Math.max(0, this.consumers - 1);
				if (this.consumers === 0) this.stop();
			},
		};
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.projectManager = undefined;
		for (const service of this.githubServices.values()) service.dispose();
		this.githubServices.clear();
		this.listeners.clear();
		this.snapshots.clear();
		this.featureDeepObservedAt.clear();
		this.projectRepositoryObservedAt.clear();
		this.projectGenerations.clear();
		this.projectReferenceHealth.clear();
		this.worktreeInventories.clear();
		this.referenceBranchRemotes.clear();
		this.githubRefreshes.clear();
		this.githubObservations.clear();
		this.githubFallbacks.clear();
	}

	getSnapshot(featureId: string): FeatureSnapshot | undefined {
		return this.snapshots.get(featureId);
	}

	getProjectSnapshots(projectId: string): readonly FeatureSnapshot[] {
		return [...this.snapshots.values()].filter(
			(snapshot) => snapshot.projectId === projectId,
		);
	}

	/**
	 * Cheap portfolio rollup for Home: a pure aggregation of whatever is
	 * already cached (never triggers a new Git/GitHub observation).
	 */
	getProjectSummary(ctx: ProjectContext): ProjectSummary {
		const snapshots = this.getProjectSnapshots(ctx.project.id);
		let agentsActive = 0;
		let servicesActive = 0;
		let attentionCount = 0;
		let lastObservedAt: string | undefined;
		let featureCount = 0;
		for (const snapshot of snapshots) {
			if (!snapshot.feature.id.startsWith("base:")) featureCount += 1;
			if (snapshot.runtime.agents.status === "known") {
				agentsActive += snapshot.runtime.agents.value.length;
			}
			if (snapshot.runtime.services.status === "known") {
				servicesActive += snapshot.runtime.services.value.length;
			}
			attentionCount += snapshot.attention.length;
			if (!lastObservedAt || snapshot.observedAt < lastObservedAt) {
				lastObservedAt = snapshot.observedAt;
			}
		}
		return {
			projectId: ctx.project.id,
			projectName: ctx.project.name,
			featureCount,
			agentsActive,
			servicesActive,
			attentionCount,
			lastObservedAt,
		};
	}

	getProjectReferenceHealth(
		projectId: string,
	): ProjectReferenceBranchHealth | undefined {
		return this.projectReferenceHealth.get(projectId);
	}

	/** Read-only per-project inventory of every worktree branch and its state. */
	getProjectWorktreeBranches(
		projectId: string,
	): WorktreeBranchInventory | undefined {
		return this.worktreeInventories.get(projectId);
	}

	/**
	 * Marks a feature's deep Git/GitHub evidence stale without discarding the
	 * last-known snapshot: the UI keeps showing known facts until a fresh
	 * observation actually commits (see `commitDeep`). Does not itself trigger
	 * a reconcile — callers decide whether the affected scope is currently
	 * focused and worth refreshing now (see HomePanel/FeatureSidebarProvider).
	 */
	invalidateFeature(featureId: string): void {
		if (this.disposed) return;
		this.beginDeepObservation(featureId);
		this.featureDeepObservedAt.delete(featureId);
	}

	/** Rarely-needed global fallback (e.g. extension-wide settings change). */
	invalidateAll(): void {
		if (this.disposed) return;
		this.generation += 1;
		// Cover every known feature, including not-yet-published ones (via the
		// cheap read-model), so an in-flight deep observation of any of them is
		// superseded even if it hasn't produced a snapshot yet.
		const featureIds = new Set<string>();
		const projectIds = new Set<string>();
		for (const snapshot of this.snapshots.values()) {
			featureIds.add(snapshot.feature.id);
			projectIds.add(snapshot.projectId);
		}
		for (const ctx of this.projectManager?.getAllContexts() ?? []) {
			projectIds.add(ctx.project.id);
			for (const id of this.projectFeatureIds(ctx)) featureIds.add(id);
		}
		for (const featureId of featureIds) {
			this.beginDeepObservation(featureId);
			this.featureDeepObservedAt.delete(featureId);
		}
		this.projectRepositoryObservedAt.clear();
		for (const projectId of projectIds) this.beginProjectObservation(projectId);
		for (const service of this.githubServices.values()) service.invalidate();
	}

	/**
	 * Explicit network refresh of one project's remote reference-branch proof
	 * (or every project when no id is given); ordinary runtime changes keep
	 * cached remote proof. Does not itself reconcile — see `reconcileProject`.
	 */
	refreshProjectReferenceHealth(projectId?: string): void {
		if (this.disposed) return;
		this.generation += 1;
		if (projectId) {
			const ctx = this.projectManager?.getContext(projectId);
			if (ctx) {
				this.beginProjectObservation(projectId);
				this.referenceRemoteFor(ctx).invalidate?.();
				this.githubServices.get(ctx.project.repoPath)?.invalidate();
			}
			return;
		}
		this.injectedReferenceBranchRemote?.invalidate?.();
		this.githubObservations.clear();
		for (const remote of this.referenceBranchRemotes.values())
			remote.invalidate();
		const projectIds = new Set<string>();
		for (const snapshot of this.snapshots.values()) projectIds.add(snapshot.projectId);
		for (const id of projectIds) this.beginProjectObservation(id);
	}

	onDidChange(
		listener: (snapshot: FeatureSnapshot | undefined) => void,
	): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	reconcile(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		this.inFlight = (async () => {
			do {
				this.reconcileAfterFlight = false;
				await this.reconcileOnce();
			} while (this.reconcileAfterFlight && !this.disposed);
		})().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	/** Full unscoped deep sweep. No longer on any automatic hot path (startup
	 * seeds lightweight presence only, and focus refreshes only its own
	 * scope) — kept for tests and as a manual escape hatch. */
	private async reconcileOnce(): Promise<void> {
		const startedAt = Date.now();
		agentSpaceDiagnostic("reconcile started scope=full");
		const manager = this.projectManager;
		if (!manager) return;
		const generation = this.generation;
		const seen = new Set<string>();
		const seenProjects = new Set<string>();
		const tmuxSessions = this.observeTmuxRuntime(manager);

		// Capture every known feature's deep generation before any await, so a
		// mutation arriving mid-sweep supersedes this pass even for Features
		// that have not yet published a snapshot (mirrors reconcileFeature's
		// early capture).
		const contexts = manager.getAllContexts();
		for (const ctx of contexts) {
			if (this.disposed) return;
			for (const id of this.projectFeatureIds(ctx)) {
				this.beginDeepObservation(id);
			}
		}

		await Promise.all(
			contexts.map(async (ctx) => {
				if (this.disposed) return;
				seenProjects.add(ctx.project.id);
				const projectGen = this.beginProjectObservation(ctx.project.id);
				const { baseRef, projectObservation } =
					await this.refreshProjectRepositoryFacts(ctx, projectGen);
				if (this.isProjectObservationCurrent(ctx.project.id, projectGen)) {
					this.projectRepositoryObservedAt.set(ctx.project.id, Date.now());
				}
				const { base, features, source } = this.discoverProjectFeatures(
					ctx,
					baseRef,
				);
				await Promise.all(
					features.map(async (feature) => {
						if (this.disposed) return;
						seen.add(feature.id);
						const gen =
							this.featureDeepGenerations.get(feature.id) ??
							this.beginDeepObservation(feature.id);
						const snapshot = await this.observe(
							ctx,
							feature,
							feature.id === base.id,
							baseRef,
							tmuxSessions,
							projectObservation,
							source,
						);
						this.commitDeep(gen, ctx.project.id, feature, snapshot);
					}),
				);
			}),
		);
		if (generation !== this.generation || this.disposed) return;

		let referenceHealthChanged = false;
		for (const projectId of this.projectReferenceHealth.keys()) {
			if (seenProjects.has(projectId)) continue;
			this.projectReferenceHealth.delete(projectId);
			referenceHealthChanged = true;
		}

		let inventoryChanged = false;
		for (const projectId of this.worktreeInventories.keys()) {
			if (seenProjects.has(projectId)) continue;
			this.worktreeInventories.delete(projectId);
			inventoryChanged = true;
		}

		for (const featureId of this.snapshots.keys()) {
			if (seen.has(featureId)) continue;
			this.snapshots.delete(featureId);
			this.emit(undefined);
		}
		if (referenceHealthChanged) this.emit(undefined);
		if (inventoryChanged) this.emit(undefined);
		agentSpaceDiagnostic(
			`reconcile completed in ${Date.now() - startedAt}ms scope=full`,
		);
	}

	/**
	 * Refreshes only what a Project page needs: repository/worktree facts and
	 * lightweight per-feature presence. Deep per-feature Git/GitHub inspection
	 * stays demand-driven — it only happens when that specific Feature is
	 * opened (see `reconcileFeature`).
	 */
	async reconcileProject(projectId: string): Promise<void> {
		const ctx = this.projectManager?.getContext(projectId);
		if (!ctx || this.disposed) return;
		const startedAt = Date.now();
		agentSpaceDiagnostic(`reconcile started scope=project:${projectId}`);
		const generation = this.beginProjectObservation(projectId);
		await this.refreshProjectRepositoryFacts(ctx, generation);
		await this.reconcilePresence(projectId);
		// Compare-and-commit: only re-stamp the project fresh if this
		// observation is still the current one. A mutation that arrived during
		// the observation bumped the project generation, so a stale pass cannot
		// revive a project invalidated mid-flight.
		if (this.isProjectObservationCurrent(projectId, generation)) {
			this.projectRepositoryObservedAt.set(projectId, Date.now());
		}
		agentSpaceDiagnostic(
			`reconcile completed in ${Date.now() - startedAt}ms scope=project:${projectId}`,
		);
	}

	/**
	 * Deep observation of exactly one feature, plus the minimal local
	 * repository fact it needs (the worktree list, to resolve its active
	 * branch). Never touches another feature or another project.
	 */
	async reconcileFeature(featureId: string): Promise<void> {
		const ctx = this.projectManager?.findContextByFeatureId(featureId);
		const resolved = this.projectManager?.resolveFeature(featureId);
		if (!ctx || !resolved || this.disposed) return;
		const startedAt = Date.now();
		agentSpaceDiagnostic(`reconcile started scope=feature:${featureId}`);
		// Capture the deep generation before any await: a mutation that lands
		// while the shared repository reads below are in flight must supersede
		// this pass, even though it hasn't reached `observe`/`commitDeep` yet.
		// Renewing the generation here would let a pre-mutation observation
		// publish stale inputs and re-stamp the feature fresh.
		const gen = this.beginDeepObservation(featureId);
		const baseRef = await observeBaseRef(ctx);
		const projectObservation = await ctx.featureGitInspector.observeProject(
			ctx.project.repoPath,
		);
		const tmuxSessions = this.observeTmuxRuntime(this.projectManager!);
		const source: FeatureSnapshotSource = { status: "known" };
		const isBaseFeature = resolved.feature.id === `base:${ctx.project.id}`;
		const snapshot = await this.observe(
			ctx,
			resolved.feature,
			isBaseFeature,
			baseRef,
			tmuxSessions,
			projectObservation,
			source,
		);
		this.commitDeep(gen, ctx.project.id, resolved.feature, snapshot);
		agentSpaceDiagnostic(
			`reconcile completed in ${Date.now() - startedAt}ms scope=feature:${featureId}`,
		);
	}

	/**
	 * Cheap tier: feature presence (added/removed) and runtime (agent/service
	 * liveness) only — no Git subprocess beyond the already-cheap persisted
	 * feature read, no GitHub. Safe to run frequently and across every
	 * project; this is what keeps the sidebar live.
	 */
	async reconcilePresence(scopeProjectId?: string): Promise<void> {
		const manager = this.projectManager;
		if (!manager || this.disposed) return;
		const tmuxSessions = this.observeTmuxRuntime(manager);
		const contexts = scopeProjectId
			? [manager.getContext(scopeProjectId)].filter(
					(ctx): ctx is ProjectContext => ctx !== undefined,
				)
			: manager.getAllContexts();
		for (const ctx of contexts) {
			if (this.disposed) return;
			const { features } = this.discoverProjectFeatures(
				ctx,
				undefined,
				true,
			);
			const seenIds = new Set(features.map((feature) => feature.id));
			for (const snapshot of this.getProjectSnapshots(ctx.project.id)) {
				if (seenIds.has(snapshot.feature.id)) continue;
				this.snapshots.delete(snapshot.feature.id);
				this.featureDeepGenerations.delete(snapshot.feature.id);
				this.featureRuntimeGenerations.delete(snapshot.feature.id);
				this.featureDeepObservedAt.delete(snapshot.feature.id);
				this.emit(undefined);
			}
			for (const feature of features) {
				const agents = readRuntime<Agent[]>(() =>
					ctx.agentManager.getAgentsReadModel(feature.id),
				);
				const services = readRuntime<Service[]>(() =>
					ctx.serviceManager.getServices(feature.id),
				);
				const runtime = observeFeatureRuntime({
					agents,
					services,
					agentTmux: runtimeMap(agents, tmuxSessions, (agent) =>
						this.projectManager?.agentTmuxSessionName(
							feature.id,
							agent.id,
							agent.tmuxSession,
						),
					),
					serviceTmux: runtimeMap(services, tmuxSessions, (service) =>
						service.tmuxSession,
					),
				});
				const gen = this.beginRuntimeObservation(feature.id);
				this.commitRuntime(gen, ctx.project.id, feature, runtime);
			}
		}
	}

	/** Whether this feature's deep Git/GitHub evidence needs a refresh. A
	 * feature that only ever received runtime-lane updates (never deep-
	 * observed) is always stale, regardless of how recently a runtime tick
	 * touched its snapshot. */
	isFeatureStale(featureId: string, maxAgeMs = DEEP_STALE_MS): boolean {
		const observedAt = this.featureDeepObservedAt.get(featureId);
		if (observedAt === undefined) return true;
		return Date.now() - observedAt > maxAgeMs;
	}

	/** Whether this project's repository-level facts (base ref, worktree
	 * inventory, reference-branch health) need a refresh. Orthogonal to
	 * per-feature deep staleness: a Project page only needs `reconcileProject`
	 * to have run, not every one of its Features individually deep-observed. */
	isProjectStale(projectId: string, maxAgeMs = DEEP_STALE_MS): boolean {
		const observedAt = this.projectRepositoryObservedAt.get(projectId);
		if (observedAt === undefined) return true;
		return Date.now() - observedAt > maxAgeMs;
	}

	private observeTmuxRuntime(
		manager: ProjectManager,
	): RuntimeObservation<readonly string[]> {
		const observation = manager.observeTmuxSessions();
		return observation.status === "known"
			? knownRuntime(observation.sessions)
			: unknownRuntime("read_failed", observation.detail);
	}

	/**
	 * Persisted feature list for one project. `baseRef` is only passed by
	 * callers that already paid to observe it fresh
	 * (`refreshProjectRepositoryFacts`); the cheap presence path falls back to
	 * whatever base ref was last observed.
	 *
	 * `light` (used only by `reconcilePresence`) reads the in-memory list via
	 * `listFeaturesCached()` — no Git subprocess at all. The default (used by
	 * every deep path) calls `getFeatures()`, which also reconciles branch
	 * links via synchronous Git reads; deep paths already pay for Git, so
	 * that cost is fine there, but the presence lane must never pay it.
	 */
	private discoverProjectFeatures(
		ctx: ProjectContext,
		baseRef?: string,
		light = false,
	): {
		base: Feature;
		features: Feature[];
		source: FeatureSnapshotSource;
	} {
		const base = createBaseFeature(ctx, baseRef ?? this.cachedBaseRef(ctx));
		let features: Feature[];
		let source: FeatureSnapshotSource = { status: "known" };
		try {
			// Probe the persisted source so a read failure remains explicit.
			ctx.store.loadFeatures();
			features = [
				base,
				...(light
					? ctx.featureManager.listFeaturesCached()
					: ctx.featureManager.getFeatures()),
			];
		} catch (error) {
			source = {
				status: "unknown",
				reason: "storage_read_failed",
				detail: error instanceof Error ? error.message : String(error),
			};
			features = [
				base,
				...this.getProjectSnapshots(ctx.project.id)
					.map((snapshot) => structuredClone(snapshot.feature) as Feature)
					.filter((feature) => feature.id !== base.id),
			];
		}
		return { base, features, source };
	}

	private cachedBaseRef(ctx: ProjectContext): string | undefined {
		const configured = ctx.config.baseBranch?.trim();
		if (configured) return configured;
		const existing = this.getProjectSnapshots(ctx.project.id).find(
			(snapshot) => snapshot.feature.id === `base:${ctx.project.id}`,
		);
		return existing?.feature.branch === "(unknown base)"
			? undefined
			: existing?.feature.branch;
	}

	/** Project-level facts: base ref, remote reference-branch health (network),
	 * and the local worktree inventory. Never inspects individual features. */
	private async refreshProjectRepositoryFacts(
		ctx: ProjectContext,
		projectGeneration: number,
	): Promise<{
		baseRef: string | undefined;
		projectObservation: FeatureGitProjectObservation;
	}> {
		const baseRef = await observeBaseRef(ctx);
		if (baseRef) {
			const normalizedReference = normalizeReferenceBranch(baseRef);
			void new ProjectReferenceBranchObserver({
				git: ctx.gitClient,
				remote: this.referenceRemoteFor(ctx),
			})
				.observe({
					repoPath: ctx.project.repoPath,
					branch: normalizedReference.branch,
					remoteName: normalizedReference.remoteName,
				})
				.then((health) =>
					this.acceptReferenceHealth(
						projectGeneration,
						ctx.project.id,
						health,
					),
				)
				.catch(() => undefined);
		}
		const projectObservation = await ctx.featureGitInspector.observeProject(
			ctx.project.repoPath,
		);
		const { features } = this.discoverProjectFeatures(ctx, baseRef);
		if (projectObservation.worktrees.status === "known") {
			new WorktreeBranchObserver({ git: ctx.gitClient })
				.observe({
					repoPath: ctx.project.repoPath,
					worktrees: projectObservation.worktrees.value,
					baseRef,
					featureBranches: featureBranchRefs(features),
				})
				.then((inventory) =>
					this.acceptWorktreeInventory(
						projectGeneration,
						ctx.project.id,
						inventory,
					),
				)
				.catch(() => undefined);
		} else if (this.worktreeInventories.has(ctx.project.id)) {
			// The worktree list can no longer be observed: transition a previously
			// known inventory to unknown instead of letting it appear stale-known.
			this.acceptWorktreeInventory(projectGeneration, ctx.project.id, {
				repoPath: ctx.project.repoPath,
				...(baseRef ? { baseRef } : {}),
				status: "unknown",
				reason: "worktrees_unavailable",
				branches: [],
				observedAt: new Date().toISOString(),
			});
		}
		return { baseRef, projectObservation };
	}

	private beginDeepObservation(featureId: string): number {
		const gen = (this.featureDeepGenerations.get(featureId) ?? 0) + 1;
		this.featureDeepGenerations.set(featureId, gen);
		return gen;
	}

	private beginRuntimeObservation(featureId: string): number {
		const gen = (this.featureRuntimeGenerations.get(featureId) ?? 0) + 1;
		this.featureRuntimeGenerations.set(featureId, gen);
		return gen;
	}

	private beginProjectObservation(projectId: string): number {
		const gen = (this.projectGenerations.get(projectId) ?? 0) + 1;
		this.projectGenerations.set(projectId, gen);
		return gen;
	}

	/**
	 * Every Feature id that currently belongs to a project: the persisted
	 * read-model (via the cheap `listFeaturesCached`, never Git), the base
	 * feature, plus any already-published snapshot. Used by project/global
	 * invalidation so a mutation supersedes an in-flight deep observation of a
	 * Feature that has not yet published its first snapshot.
	 */
	private projectFeatureIds(ctx: ProjectContext): ReadonlySet<string> {
		const ids = new Set<string>([`base:${ctx.project.id}`]);
		try {
			for (const feature of ctx.featureManager.listFeaturesCached()) {
				ids.add(feature.id);
			}
		} catch {
			// Read-model unavailable; published snapshots still cover it below.
		}
		for (const snapshot of this.getProjectSnapshots(ctx.project.id)) {
			ids.add(snapshot.feature.id);
		}
		return ids;
	}

	/** Invalidates every feature currently known for one project. */
	invalidateProject(projectId: string): void {
		if (this.disposed) return;
		// Bump this project's generation so any in-flight project observation
		// can no longer publish facts observed before this mutation or re-stamp
		// the project fresh.
		this.beginProjectObservation(projectId);
		const ctx = this.projectManager?.getContext(projectId);
		const featureIds = ctx
			? this.projectFeatureIds(ctx)
			: new Set(
					this.getProjectSnapshots(projectId).map(
						(snapshot) => snapshot.feature.id,
					),
				);
		for (const featureId of featureIds) {
			this.beginDeepObservation(featureId);
			this.featureDeepObservedAt.delete(featureId);
		}
		this.projectRepositoryObservedAt.delete(projectId);
		this.referenceBranchRemotes.get(
			this.projectManager?.getContext(projectId)?.project.repoPath ?? "",
		)?.invalidate();
	}

	/** Whether the given project generation is still the current one. */
	private isProjectObservationCurrent(
		projectId: string,
		gen: number,
	): boolean {
		return this.projectGenerations.get(projectId) === gen;
	}

	/**
	 * Publishes deep Git/GitHub evidence for one feature. Discards the result
	 * if a newer deep observation for this same feature has started since
	 * (`gen` mismatch) — protects publication itself, not just the end of a
	 * whole reconcile pass. Always merges against whatever the runtime lane
	 * most recently committed, so a concurrent presence tick can never be
	 * clobbered by a slower deep observation landing late.
	 */
	private commitDeep(
		gen: number,
		projectId: string,
		feature: Feature,
		observed: FeatureSnapshot,
	): boolean {
		if (this.disposed) return false;
		if (this.featureDeepGenerations.get(feature.id) !== gen) return false;
		const previous = this.snapshots.get(feature.id);
		// The runtime lane owns `runtime` once it has published anything for
		// this feature; only fall back to this pass's own (freshly computed)
		// runtime reading when nothing has been published yet.
		const runtime = previous?.runtime ?? observed.runtime;
		const git = preferKnownGit(previous?.git, observed.git);
		const delivery = observed.delivery
			? preferKnownDelivery(previous?.delivery, observed.delivery)
			: previous?.delivery;
		const github = preferKnownGithub(previous?.github, observed.github);
		const integration = evaluateIntegration({
			git,
			github,
			createdFromSha: feature.createdFromSha,
			delivery,
		});
		const attention = evaluateAttention({
			git,
			github,
			integration,
			delivery,
			runtime,
			source: observed.source,
			isBaseFeature: feature.id.startsWith("base:"),
		});
		const snapshot = createFeatureSnapshot({
			projectId,
			feature,
			git,
			...(delivery ? { delivery } : {}),
			github,
			integration,
			runtime,
			source: observed.source,
			attention,
			observedAt: new Date().toISOString(),
		});
		this.featureDeepObservedAt.set(feature.id, Date.now());
		if (previous && equivalent(previous, snapshot)) return false;
		this.snapshots.set(feature.id, snapshot);
		this.emit(snapshot);
		return true;
	}

	/**
	 * Publishes a runtime-only update for one feature, always merging against
	 * whatever the deep lane most recently committed (or an empty placeholder
	 * on first observation) — never touches Git/GitHub evidence.
	 */
	private commitRuntime(
		gen: number,
		projectId: string,
		feature: Feature,
		runtime: FeatureRuntimeObservation,
	): boolean {
		if (this.disposed) return false;
		if (this.featureRuntimeGenerations.get(feature.id) !== gen) return false;
		const previous = this.snapshots.get(feature.id);
		const git = previous?.git ?? unavailableGit(feature.worktreePath);
		const github = previous?.github ?? unavailableGithub(feature.worktreePath);
		const source: FeatureSnapshotSource = previous?.source ?? {
			status: "known",
		};
		const integration =
			previous?.integration ??
			evaluateIntegration({
				git,
				github,
				createdFromSha: feature.createdFromSha,
				delivery: previous?.delivery,
			});
		const attention = evaluateAttention({
			git,
			github,
			integration,
			delivery: previous?.delivery,
			runtime,
			source,
			isBaseFeature: feature.id.startsWith("base:"),
		});
		const snapshot = createFeatureSnapshot({
			projectId,
			feature,
			git,
			...(previous?.delivery ? { delivery: previous.delivery } : {}),
			github,
			integration,
			runtime,
			source,
			attention,
			observedAt: previous?.observedAt ?? new Date().toISOString(),
		});
		if (previous && equivalent(previous, snapshot)) return false;
		this.snapshots.set(feature.id, snapshot);
		this.emit(snapshot);
		return true;
	}

	private acceptWorktreeInventory(
		projectGeneration: number,
		projectId: string,
		inventory: WorktreeBranchInventory,
	): void {
		if (
			this.disposed ||
			!this.isProjectObservationCurrent(projectId, projectGeneration)
		) {
			return;
		}
		const previous = this.worktreeInventories.get(projectId);
		this.worktreeInventories.set(projectId, inventory);
		if (!previous || !equivalentInventory(previous, inventory)) {
			this.emit(undefined);
		}
	}

	private async observe(
		ctx: ProjectContext,
		feature: Feature,
		isBaseFeature: boolean,
		baseRef: string | undefined,
		tmuxSessions: RuntimeObservation<readonly string[]>,
		projectObservation: FeatureGitProjectObservation,
		source: FeatureSnapshotSource,
	): Promise<FeatureSnapshot> {
		const deliveryBranch = deliveryBranchRef(feature);
		const inspectionBranch = inspectionBranchRef(feature, projectObservation);
		const git = await ctx.featureGitInspector
			.inspect(
				{
					repoRoot: ctx.project.repoPath,
					worktreePath: feature.worktreePath,
					featureBranch: inspectionBranch,
					baseRef,
					...(feature.createdFromSha
						? { createdFromSha: feature.createdFromSha }
						: {}),
				},
				projectObservation,
			)
			.catch(() => unavailableGit(ctx.project.repoPath));

		const [agents, services] = [
			readRuntime<Agent[]>(() => ctx.agentManager.getAgents(feature.id)),
			readRuntime<Service[]>(() => ctx.serviceManager.getServices(feature.id)),
		];
		const runtime = observeFeatureRuntime({
			agents,
			services,
			agentTmux: runtimeMap(agents, tmuxSessions, (agent) =>
				this.projectManager?.agentTmuxSessionName(
					feature.id,
					agent.id,
					agent.tmuxSession,
				),
			),
			serviceTmux: runtimeMap(
				services,
				tmuxSessions,
				(service) => service.tmuxSession,
			),
		});
		const delivery = await observeDelivery(ctx, deliveryBranch, git.feature);
		const deliveryHeadSha =
			delivery.head.status === "known" ? delivery.head.value.sha : undefined;
		const activeHeadSha =
			git.feature.status === "known" ? git.feature.value.sha : undefined;
		const activeIsContinuation =
			delivery.activeRelation.status === "known" &&
			delivery.activeRelation.value.isAncestor;
		const githubKey = this.githubObservationKey(
			ctx,
			feature,
			deliveryBranch,
			deliveryHeadSha,
			activeHeadSha,
			baseRef,
		);
		let github = this.githubObservations.get(githubKey);
		if (!github) {
			github = this.githubFallbacks.get(githubKey);
			if (!github) {
				github = unavailableGithub(ctx.project.repoPath);
				this.githubFallbacks.set(githubKey, github);
			}
		}
		this.deferGithubObservation(
			ctx,
			feature,
			deliveryBranch,
			deliveryHeadSha,
			activeHeadSha,
			activeIsContinuation,
			baseRef,
		);
		const delivered = withDeliveredVia(delivery, feature, github, git.feature);
		const mergedHead =
			github.status === "known" &&
			github.resolution.outcome === "selected" &&
			github.resolution.pull.state === "merged" &&
			git.feature.status === "known"
				? await observeMergedHead(
						ctx,
						github.resolution.pull.headSha,
						git.feature.value.sha,
					)
				: undefined;
		const integration = evaluateIntegration({
			git,
			github,
			createdFromSha: feature.createdFromSha,
			mergedHead,
			delivery: delivered,
		});
		const attention = evaluateAttention({
			git,
			github,
			integration,
			delivery: delivered,
			runtime,
			source,
			isBaseFeature,
		});

		return createFeatureSnapshot({
			projectId: ctx.project.id,
			feature,
			git,
			delivery: delivered,
			github,
			integration,
			runtime,
			source,
			attention,
			observedAt: new Date().toISOString(),
		});
	}

	private deferGithubObservation(
		ctx: ProjectContext,
		feature: Feature,
		deliveryBranch: string,
		deliveryHeadSha: string | undefined,
		activeHeadSha: string | undefined,
		activeIsContinuation: boolean,
		baseRef: string | undefined,
	): void {
		const key = [
			this.githubObservationKey(
				ctx,
				feature,
				deliveryBranch,
				deliveryHeadSha,
				activeHeadSha,
				baseRef,
			),
		].join("\u0000");
		if (this.githubObservations.has(key)) return;
		if (this.githubRefreshes.has(key)) return;
		this.githubRefreshes.add(key);
		void this.observeGithub(
			ctx,
			feature,
			deliveryBranch,
			deliveryHeadSha,
			activeHeadSha,
			activeIsContinuation,
			baseRef,
		)
			.then((observation) => {
				this.githubObservations.set(key, observation);
				this.githubFallbacks.delete(key);
				// The GitHub cache now has fresh evidence for this one feature;
				// re-run its deep observation to publish it (scoped, no fan-out).
				if (observation.status !== "unavailable") {
					void this.reconcileFeature(feature.id);
				}
			})
			.catch((error) =>
				console.warn(`[agentSpace] deferred GitHub observation failed: ${String(error)}`),
			)
			.finally(() => this.githubRefreshes.delete(key));
	}

	private githubObservationKey(
		ctx: ProjectContext,
		feature: Feature,
		deliveryBranch: string,
		deliveryHeadSha: string | undefined,
		activeHeadSha: string | undefined,
		baseRef: string | undefined,
	): string {
		return [
			ctx.project.repoPath,
			feature.id,
			deliveryBranch,
			deliveryHeadSha ?? "",
			activeHeadSha ?? "",
			baseRef ?? "",
		].join("\u0000");
	}

	/**
	 * Observe GitHub pull-request evidence for every candidate delivery vector
	 * and select the strongest proof:
	 * - `deliveryBranch` is the feature's historical branch (e.g. `fix/1203`);
	 * - `feature.branch` is the active checkout (e.g. `dev/improvements`), which
	 *   is where an agent may have actually delivered the work.
	 * The active branch is only considered when it is a proven continuation of
	 * the historical branch: a PR merged from the active branch is only proof of
	 * delivery if that branch descends from the historical branch.
	 * A merged PR targeting the expected base wins; otherwise the delivery
	 * branch observation is preserved (legacy behavior).
	 */
	private async observeGithub(
		ctx: ProjectContext,
		feature: Feature,
		deliveryBranch: string,
		deliveryHeadSha: string | undefined,
		activeHeadSha: string | undefined,
		activeIsContinuation: boolean,
		baseRef: string | undefined,
	): Promise<GitHubObservation> {
		const candidates: Array<{
			branch: string;
			queriedHeadSha: string | undefined;
		}> = [];
		const push = (branch: string, queriedHeadSha: string | undefined) => {
			if (!candidates.some((candidate) => candidate.branch === branch)) {
				candidates.push({ branch, queriedHeadSha });
			}
		};
		push(deliveryBranch, deliveryHeadSha);
		if (activeIsContinuation) {
			push(feature.branch, activeHeadSha);
		}
		const observations = await Promise.all(
			candidates.map((candidate) =>
				this.observeGithubBranch(
					ctx,
					candidate.branch,
					candidate.queriedHeadSha,
					baseRef,
				),
			),
		);
		return selectGithubObservation(
			deliveryBranch,
			baseRef,
			activeHeadSha,
			candidates.map((candidate, index) => ({
				branch: candidate.branch,
				observation: observations[index],
			})),
		);
	}

	private async observeGithubBranch(
		ctx: ProjectContext,
		branch: string,
		queriedHeadSha: string | undefined,
		baseRef: string | undefined,
	): Promise<GitHubObservation> {
		try {
			const service = this.githubServiceFor(ctx);
			return await service.observe({
				repoRoot: ctx.project.repoPath,
				branch,
				queriedHeadSha,
				expectedBaseRef: baseRef,
			});
		} catch {
			return unavailableGithub(ctx.project.repoPath);
		}
	}

	private githubServiceFor(ctx: ProjectContext): GitHubObservationService {
		let service = this.githubServices.get(ctx.project.repoPath);
		if (!service) {
			const backend = this.options.createGithubBackend
				? this.options.createGithubBackend(ctx.project.repoPath)
				: new HttpGitHubBackend();
			const inspector = new PullRequestInspector(ctx.gitClient, backend);
			service = new GitHubObservationService({
				createInspector: () => inspector,
				...(this.options.githubTtlMs !== undefined
					? { ttlMs: this.options.githubTtlMs }
					: {}),
				...(this.options.githubRepositoryFactTtlMs !== undefined
					? { repositoryFactTtlMs: this.options.githubRepositoryFactTtlMs }
					: {}),
			});
			this.githubServices.set(ctx.project.repoPath, service);
		}
		return service;
	}

	private referenceRemoteFor(ctx: ProjectContext): RemoteBranchHeadSource {
		if (this.injectedReferenceBranchRemote) {
			return this.injectedReferenceBranchRemote;
		}
		let remote = this.referenceBranchRemotes.get(ctx.project.repoPath);
		if (!remote) {
			remote = new GitLsRemoteBranchHeadSource({ git: ctx.gitClient });
			this.referenceBranchRemotes.set(ctx.project.repoPath, remote);
		}
		return remote;
	}

	private acceptReferenceHealth(
		projectGeneration: number,
		projectId: string,
		health: ProjectReferenceBranchHealth,
	): void {
		if (
			this.disposed ||
			!this.isProjectObservationCurrent(projectId, projectGeneration)
		) {
			return;
		}
		const previous = this.projectReferenceHealth.get(projectId);
		this.projectReferenceHealth.set(projectId, health);
		if (!previous || !equivalentReferenceHealth(previous, health)) {
			this.emit(undefined);
		}
	}

	/** The recurring timer only drives the lightweight presence lane — a full
	 * deep sweep is never on an automatic/periodic hot path. */
	private configurePolling(intervalMs: number): void {
		if (this.consumers === 0 || intervalMs <= 0 || this.timer) return;
		this.timer = setInterval(() => void this.reconcilePresence(), intervalMs);
		this.timer.unref?.();
	}

	private emit(snapshot: FeatureSnapshot | undefined): void {
		for (const listener of this.listeners) listener(snapshot);
	}
}

function deliveryBranchRef(feature: Feature): string {
	return (
		feature.primaryBranchRef ??
		feature.branchLinks?.find((link) => link.role === "primary")?.ref ??
		feature.branch
	);
}

function inspectionBranchRef(
	feature: Feature,
	projectObservation: FeatureGitProjectObservation,
): string {
	if (projectObservation.worktrees.status === "known") {
		const checkout = projectObservation.worktrees.value.find(
			(worktree) =>
				path.resolve(worktree.path) === path.resolve(feature.worktreePath) &&
				worktree.branchRef,
		);
		if (checkout?.branchRef) return checkout.branchRef.replace(/^refs\/heads\//u, "");
	}
	return feature.branch;
}

/**
 * Model the delivery source explicitly. `delivery.branchRef` stays the
 * feature's historical branch; `deliveredVia` records the branch GitHub proved
 * as the merged PR head when that differs from the historical branch (an agent
 * checked out a continuation branch and delivered there).
 */
function withDeliveredVia(
	delivery: FeatureDeliveryObservation,
	_feature: Feature,
	github: GitHubObservation,
	activeHead: GitObservation<ObservedCommit>,
): FeatureDeliveryObservation {
	if (
		github.status !== "known" ||
		github.resolution.outcome !== "selected" ||
		github.resolution.pull.state !== "merged" ||
		activeHead.status !== "known"
	) {
		return delivery;
	}
	const queriedBranch = github.queriedBranch;
	if (!queriedBranch || queriedBranch === delivery.branchRef) {
		return delivery;
	}
	const pull = github.resolution.pull;
	if (!sameSha(pull.headSha, activeHead.value.sha)) {
		return delivery;
	}
	if (
		github.expectedBaseRef === undefined ||
		pull.baseRef !== github.expectedBaseRef
	) {
		return delivery;
	}
	return {
		...delivery,
		deliveredVia: {
			branchRef: queriedBranch,
			head: activeHead.value,
			pullNumber: pull.number,
		},
	};
}

/**
 * Select the strongest GitHub observation among the candidate delivery
 * vectors. A merged PR targeting the expected base is the strongest delivery
 * proof; on ties the delivery branch is preserved (legacy behavior).
 */
function selectGithubObservation(
	deliveryBranch: string,
	expectedBaseRef: string | undefined,
	activeHeadSha: string | undefined,
	candidates: ReadonlyArray<{
		branch: string;
		observation: GitHubObservation;
	}>,
): GitHubObservation {
	let best: GitHubObservation | undefined;
	let bestRank = -1;
	let bestIsDelivery = false;
	for (const candidate of candidates) {
		const rank = githubObservationRank(
			candidate.observation,
			expectedBaseRef,
			activeHeadSha,
		);
		const isDelivery = candidate.branch === deliveryBranch;
		if (
			rank > bestRank ||
			(rank === bestRank && best !== undefined && isDelivery && !bestIsDelivery)
		) {
			best = candidate.observation;
			bestRank = rank;
			bestIsDelivery = isDelivery;
		}
	}
	return best ?? unavailableGithub("unknown");
}

function githubObservationRank(
	observation: GitHubObservation,
	expectedBaseRef: string | undefined,
	activeHeadSha: string | undefined,
): number {
	if (observation.status !== "known") return 0;
	if (observation.resolution.outcome !== "selected") return 1;
	const pull = observation.resolution.pull;
	if (pull.state === "merged") {
		if (expectedBaseRef !== undefined && pull.baseRef !== expectedBaseRef) {
			return 3;
		}
		// A merged PR whose head is the exact active head proves delivery of
		// the current work; prefer it over a historical PR targeting the same
		// base when the active branch is a proven continuation.
		return activeHeadSha !== undefined && sameSha(pull.headSha, activeHeadSha)
			? 5
			: 4;
	}
	if (pull.state === "open") return 2;
	return 1;
}

function sameSha(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

async function observeDelivery(
	ctx: ProjectContext,
	branch: string,
	activeHead: GitObservation<ObservedCommit>,
): Promise<FeatureDeliveryObservation> {
	if (activeHead.status === "known" && activeHead.value.ref === branch) {
		return {
			branchRef: branch,
			head: activeHead,
			activeRelation: known({
				ancestor: activeHead.value,
				descendant: activeHead.value,
				isAncestor: true,
			}),
			commitsAfter: known({
				ancestorSha: activeHead.value.sha,
				descendantSha: activeHead.value.sha,
				count: 0,
			}),
		};
	}
	const result = await ctx.gitClient.read(
		["rev-parse", "--verify", `${branch}^{commit}`],
		{ cwd: ctx.project.repoPath },
	);
	const sha = result.stdout.trim();
	const head =
		result.exitCode === 0 && !result.error && /^[0-9a-f]{40,64}$/iu.test(sha)
			? known({ ref: branch, sha })
			: unknown(
					"ref_not_found",
					result.stderr.trim() || result.error?.message,
					{
						ref: branch,
					},
				);
	if (head.status === "unknown" || activeHead.status === "unknown") {
		const relation = unknown("ancestry_unknown", undefined, {
			delivery: head.status === "known" ? head.value : head.observed,
			active:
				activeHead.status === "known" ? activeHead.value : activeHead.observed,
		});
		return {
			branchRef: branch,
			head,
			activeRelation: relation,
			commitsAfter: unknown("git_command_failed", undefined, relation.observed),
		};
	}
	const activeRelation = await ctx.featureGitInspector.isCommitAncestor(
		head.value.sha,
		activeHead.value.sha,
		ctx.project.repoPath,
	);
	const commitsAfter =
		activeRelation.status === "known" && activeRelation.value.isAncestor
			? await ctx.featureGitInspector.countCommitsAfter(
					head.value.sha,
					activeHead.value.sha,
					ctx.project.repoPath,
				)
			: unknown("git_command_failed", undefined, {
					delivery: head.value,
					active: activeHead.value,
				});
	return { branchRef: branch, head, activeRelation, commitsAfter };
}

function readRuntime<T>(read: () => T) {
	try {
		return knownRuntime(read());
	} catch (error) {
		return unknownRuntime(
			"read_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function observeBaseRef(
	ctx: ProjectContext,
): Promise<string | undefined> {
	const configured = ctx.config.baseBranch?.trim();
	if (configured) return configured;
	const result = await ctx.gitClient.read(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		{ cwd: ctx.project.repoPath },
	);
	return result.exitCode === 0 && !result.error
		? result.stdout.trim() || undefined
		: undefined;
}

function createBaseFeature(
	ctx: ProjectContext,
	baseRef: string | undefined,
): Feature {
	const branch = baseRef ?? "(unknown base)";
	return {
		id: `base:${ctx.project.id}`,
		name: branch,
		branch,
		worktreePath: ctx.project.repoPath,
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: new Date(0).toISOString(),
	};
}

function runtimeMap<T extends { id: string }>(
	items: RuntimeObservation<readonly T[]>,
	sessions: RuntimeObservation<readonly string[]>,
	sessionName: (item: T) => string | undefined,
): ReadonlyMap<string, RuntimeObservation<boolean>> {
	const result = new Map<string, RuntimeObservation<boolean>>();
	if (items.status === "unknown") return result;
	for (const item of items.value) {
		const name = sessionName(item);
		if (!name) {
			result.set(item.id, unknownRuntime("not_observed"));
		} else if (sessions.status === "unknown") {
			result.set(item.id, sessions);
		} else {
			result.set(item.id, knownRuntime(sessions.value.includes(name)));
		}
	}
	return result;
}

function equivalent(left: FeatureSnapshot, right: FeatureSnapshot): boolean {
	const { observedAt: _leftObservedAt, ...leftState } = left;
	const { observedAt: _rightObservedAt, ...rightState } = right;
	return JSON.stringify(leftState) === JSON.stringify(rightState);
}

function equivalentReferenceHealth(
	left: ProjectReferenceBranchHealth,
	right: ProjectReferenceBranchHealth,
): boolean {
	const project = (health: ProjectReferenceBranchHealth) => ({
		repoPath: health.repoPath,
		branch: health.branch,
		remoteName: health.remoteName,
		local: stripObservationTime(health.local),
		remoteTracking: stripObservationTime(health.remoteTracking),
		verifiedRemote: stripObservationTime(health.verifiedRemote),
		remoteTrackingRelation: health.remoteTrackingRelation,
		verifiedRemoteRelation: health.verifiedRemoteRelation,
		state: health.state,
		freshness: health.remoteFreshness.status,
	});
	return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

function equivalentInventory(
	left: WorktreeBranchInventory,
	right: WorktreeBranchInventory,
): boolean {
	const inventory = (value: WorktreeBranchInventory) => ({
		repoPath: value.repoPath,
		baseRef: value.baseRef,
		status: value.status,
		reason: value.reason,
		branches: value.branches,
	});
	return JSON.stringify(inventory(left)) === JSON.stringify(inventory(right));
}

/** Maps every ref a Feature owns (primary, links, active branch) to its id. */
function featureBranchRefs(
	features: readonly Feature[],
): ReadonlyMap<string, string> {
	const map = new Map<string, string>();
	for (const feature of features) {
		if (feature.id.startsWith("base:")) continue;
		const refs = new Set<string>();
		if (feature.primaryBranchRef) refs.add(feature.primaryBranchRef);
		refs.add(feature.branch);
		for (const link of feature.branchLinks ?? []) refs.add(link.ref);
		for (const ref of refs) {
			if (!map.has(ref)) map.set(ref, feature.id);
		}
	}
	return map;
}

function stripObservationTime<T extends { readonly observedAt: string }>(
	observation: T,
): Omit<T, "observedAt"> {
	const { observedAt: _observedAt, ...state } = observation;
	return state;
}

function unavailableGit(root: string) {
	const value = {
		status: "unknown" as const,
		reason: "repository_unavailable" as const,
		observed: { root },
	};
	return {
		repository: value,
		worktree: value,
		branch: value,
		head: value,
		feature: value,
		base: value,
		creationPoint: value,
		creationPointInFeature: value,
		upstream: value,
		upstreamDivergence: value,
		featureDelta: value,
		featureDiff: value,
		workingTree: value,
		worktrees: value,
		featureInBase: value,
	};
}

async function observeMergedHead(
	ctx: ProjectContext,
	mergedHeadSha: string,
	featureHeadSha: string,
): Promise<MergedHeadGitEvidence> {
	const ancestor = await ctx.featureGitInspector.isCommitAncestor(
		mergedHeadSha,
		featureHeadSha,
		ctx.project.repoPath,
	);
	const commitsAfter = await ctx.featureGitInspector.countCommitsAfter(
		mergedHeadSha,
		featureHeadSha,
		ctx.project.repoPath,
	);
	return {
		mergedHeadSha,
		relation: ancestor,
		commitsAfter,
	};
}

function unavailableGithub(root: string): GitHubObservation {
	return githubObservationFromRepository({
		status: "unavailable",
		reason: "no_remotes",
		observedRemotes: [],
		detail: `No GitHub remote resolved for ${root}.`,
	});
}
