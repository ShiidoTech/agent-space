import type { Disposable } from "vscode";
import type { FeatureGitProjectObservation } from "../git/featureGitInspector";
import type { FeatureGitObservations } from "../git/featureGitObservations";
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
import type { Agent, Feature, Service } from "../types";
import { evaluateAttention } from "./attentionEvaluator";
import {
	createFeatureSnapshot,
	type FeatureSnapshot,
	type FeatureSnapshotSource,
} from "./featureSnapshot";
import {
	evaluateIntegration,
	type MergedHeadGitEvidence,
} from "./integrationEvaluator";
import {
	knownRuntime,
	observeFeatureRuntime,
	type RuntimeObservation,
	unknownRuntime,
} from "./runtimeObservation";

const RECONCILE_INTERVAL_MS = 15_000;

export interface FeatureStateCoordinatorOptions {
	/** Injectable GitHub transport factory (per repository). */
	readonly createGithubBackend?: (repoRoot: string) => PullRequestBackend;
	readonly githubTtlMs?: number;
	readonly githubRepositoryFactTtlMs?: number;
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
	private githubServices = new Map<string, GitHubObservationService>();

	constructor(
		projectManager?: ProjectManager,
		private readonly options: FeatureStateCoordinatorOptions = {},
	) {
		this.projectManager = projectManager;
	}

	start(
		projectManager?: ProjectManager,
		intervalMs = RECONCILE_INTERVAL_MS,
	): void {
		if (this.disposed) return;
		this.generation += 1;
		if (projectManager) this.projectManager = projectManager;
		this.stop();
		void this.reconcile();
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
		void this.reconcile();
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
	}

	getSnapshot(featureId: string): FeatureSnapshot | undefined {
		return this.snapshots.get(featureId);
	}

	getProjectSnapshots(projectId: string): readonly FeatureSnapshot[] {
		return [...this.snapshots.values()].filter(
			(snapshot) => snapshot.projectId === projectId,
		);
	}

	invalidate(featureId?: string): void {
		if (this.disposed) return;
		this.generation += 1;
		if (featureId) this.snapshots.delete(featureId);
		for (const service of this.githubServices.values()) service.invalidate();
		if (this.inFlight) {
			this.reconcileAfterFlight = true;
			return;
		}
		void this.reconcile();
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
		this.inFlight = this.reconcileOnce().finally(() => {
			this.inFlight = undefined;
			if (this.reconcileAfterFlight && !this.disposed) {
				this.reconcileAfterFlight = false;
				void this.reconcile();
			}
		});
		return this.inFlight;
	}

	private async reconcileOnce(): Promise<void> {
		const manager = this.projectManager;
		if (!manager) return;
		const generation = this.generation;
		const seen = new Set<string>();
		const nextSnapshots: FeatureSnapshot[] = [];
		const tmuxObservation = manager.observeTmuxSessions();
		const tmuxSessions =
			tmuxObservation.status === "known"
				? knownRuntime(tmuxObservation.sessions)
				: unknownRuntime("read_failed", tmuxObservation.detail);

		for (const ctx of manager.getAllContexts()) {
			if (this.disposed) return;
			const baseRef = await observeBaseRef(ctx);
			const base = createBaseFeature(ctx, baseRef);
			let features: Feature[];
			let source: FeatureSnapshotSource = { status: "known" };
			try {
				features = [base, ...ctx.store.loadFeatures()];
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
			const projectObservation = await ctx.featureGitInspector.observeProject(
				ctx.project.repoPath,
			);

			const observed = await Promise.all(
				features.map(async (feature) => ({
					feature,
					snapshot: await this.observe(
						ctx,
						feature,
						feature.id === base.id,
						baseRef,
						tmuxSessions,
						projectObservation,
						source,
					),
				})),
			);
			for (const { feature, snapshot } of observed) {
				if (this.disposed) return;
				seen.add(feature.id);
				nextSnapshots.push(snapshot);
			}
		}
		if (generation !== this.generation || this.disposed) return;

		for (const snapshot of nextSnapshots) {
			const previous = this.snapshots.get(snapshot.feature.id);
			if (previous && equivalent(previous, snapshot)) continue;
			this.snapshots.set(snapshot.feature.id, snapshot);
			this.emit(snapshot);
		}

		for (const featureId of this.snapshots.keys()) {
			if (seen.has(featureId)) continue;
			this.snapshots.delete(featureId);
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
		const git = await ctx.featureGitInspector
			.inspect(
				{
					repoRoot: ctx.project.repoPath,
					worktreePath: feature.worktreePath,
					featureBranch: feature.branch,
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
		const github = await this.observeGithub(ctx, git, feature.branch, baseRef);
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
		});
		const attention = evaluateAttention({
			git,
			github,
			integration,
			runtime,
			source,
			isBaseFeature,
		});

		return createFeatureSnapshot({
			projectId: ctx.project.id,
			feature,
			git,
			github,
			integration,
			runtime,
			source,
			attention,
			observedAt: new Date().toISOString(),
		});
	}

	private async observeGithub(
		ctx: ProjectContext,
		git: FeatureGitObservations,
		branch: string,
		baseRef: string | undefined,
	): Promise<GitHubObservation> {
		try {
			const service = this.githubServiceFor(ctx);
			return await service.observe({
				repoRoot: ctx.project.repoPath,
				branch,
				queriedHeadSha:
					git.feature.status === "known" ? git.feature.value.sha : undefined,
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

	private configurePolling(intervalMs: number): void {
		if (this.consumers === 0 || intervalMs <= 0 || this.timer) return;
		this.timer = setInterval(() => void this.reconcile(), intervalMs);
		this.timer.unref?.();
	}

	private emit(snapshot: FeatureSnapshot | undefined): void {
		for (const listener of this.listeners) listener(snapshot);
	}
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
