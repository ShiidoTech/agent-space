import type { Disposable } from "vscode";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, Feature, Service } from "../types";
import { evaluateAttention } from "./attentionEvaluator";
import { createFeatureSnapshot, type FeatureSnapshot } from "./featureSnapshot";
import { evaluateIntegration } from "./integrationEvaluator";
import {
	knownRuntime,
	observeFeatureRuntime,
	type RuntimeObservation,
	unknownRuntime,
} from "./runtimeObservation";

const RECONCILE_INTERVAL_MS = 15_000;

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

	constructor(projectManager?: ProjectManager) {
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
		if (intervalMs <= 0) return;
		this.timer = setInterval(() => void this.reconcile(), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.projectManager = undefined;
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
			try {
				features = [base, ...ctx.store.loadFeatures()];
			} catch {
				features = [
					base,
					...this.getProjectSnapshots(ctx.project.id)
						.map((snapshot) => structuredClone(snapshot.feature) as Feature)
						.filter((feature) => feature.id !== base.id),
				];
			}

			const observed = await Promise.all(
				features.map(async (feature) => ({
					feature,
					snapshot: await this.observe(
						ctx,
						feature,
						feature.id === base.id,
						baseRef,
						tmuxSessions,
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
	): Promise<FeatureSnapshot> {
		const git = await ctx.featureGitInspector
			.inspect({
				repoRoot: ctx.project.repoPath,
				worktreePath: feature.worktreePath,
				featureBranch: feature.branch,
				baseRef,
				...(feature.createdFromSha
					? { createdFromSha: feature.createdFromSha }
					: {}),
			})
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
		const integration = evaluateIntegration(git, feature.createdFromSha);
		const attention = evaluateAttention({
			git,
			integration,
			runtime,
			isBaseFeature,
		});

		return createFeatureSnapshot({
			projectId: ctx.project.id,
			feature,
			git,
			integration,
			runtime,
			attention,
			observedAt: new Date().toISOString(),
		});
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
