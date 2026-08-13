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
import {
	GitLsRemoteBranchHeadSource,
	normalizeReferenceBranch,
	type ProjectReferenceBranchHealth,
	ProjectReferenceBranchObserver,
	type RemoteBranchHeadSource,
} from "../projects/referenceBranchHealth";
import type { Agent, Feature, Service } from "../types";
import { evaluateAttention } from "./attentionEvaluator";
import {
	createFeatureSnapshot,
	type FeatureDeliveryObservation,
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
		this.projectReferenceHealth.clear();
		this.worktreeInventories.clear();
		this.referenceBranchRemotes.clear();
	}

	getSnapshot(featureId: string): FeatureSnapshot | undefined {
		return this.snapshots.get(featureId);
	}

	getProjectSnapshots(projectId: string): readonly FeatureSnapshot[] {
		return [...this.snapshots.values()].filter(
			(snapshot) => snapshot.projectId === projectId,
		);
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

	/** Explicit network refresh; ordinary runtime changes keep cached remote proof. */
	refreshProjectReferenceHealth(): void {
		if (this.disposed) return;
		this.generation += 1;
		this.injectedReferenceBranchRemote?.invalidate?.();
		for (const remote of this.referenceBranchRemotes.values())
			remote.invalidate();
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

	private async reconcileOnce(): Promise<void> {
		const manager = this.projectManager;
		if (!manager) return;
		const generation = this.generation;
		const seen = new Set<string>();
		const seenProjects = new Set<string>();
		const nextSnapshots: FeatureSnapshot[] = [];
		const tmuxObservation = manager.observeTmuxSessions();
		const tmuxSessions =
			tmuxObservation.status === "known"
				? knownRuntime(tmuxObservation.sessions)
				: unknownRuntime("read_failed", tmuxObservation.detail);

		for (const ctx of manager.getAllContexts()) {
			if (this.disposed) return;
			seenProjects.add(ctx.project.id);
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
						this.acceptReferenceHealth(generation, ctx.project.id, health),
					)
					.catch(() => undefined);
			}
			const base = createBaseFeature(ctx, baseRef);
			let features: Feature[];
			let source: FeatureSnapshotSource = { status: "known" };
			try {
				// Probe the persisted source so a read failure remains explicit, then use
				// FeatureManager's read-only Git reconciliation. This ensures legacy
				// branch recovery happens before the first local/GitHub observation.
				ctx.store.loadFeatures();
				features = [base, ...ctx.featureManager.getFeatures()];
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
			if (projectObservation.worktrees.status === "known") {
				new WorktreeBranchObserver({ git: ctx.gitClient })
					.observe({
						repoPath: ctx.project.repoPath,
						worktrees: projectObservation.worktrees.value,
						baseRef,
						featureBranches: featureBranchRefs(features),
					})
					.then((inventory) =>
						this.acceptWorktreeInventory(generation, ctx.project.id, inventory),
					)
					.catch(() => undefined);
			} else if (this.worktreeInventories.has(ctx.project.id)) {
				// The worktree list can no longer be observed: transition a previously
				// known inventory to unknown instead of letting it appear stale-known.
				this.acceptWorktreeInventory(generation, ctx.project.id, {
					repoPath: ctx.project.repoPath,
					...(baseRef ? { baseRef } : {}),
					status: "unknown",
					reason: "worktrees_unavailable",
					branches: [],
					observedAt: new Date().toISOString(),
				});
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

		let snapshotChanged = false;
		for (const snapshot of nextSnapshots) {
			const previous = this.snapshots.get(snapshot.feature.id);
			if (previous && equivalent(previous, snapshot)) continue;
			this.snapshots.set(snapshot.feature.id, snapshot);
			snapshotChanged = true;
			this.emit(snapshot);
		}

		for (const featureId of this.snapshots.keys()) {
			if (seen.has(featureId)) continue;
			this.snapshots.delete(featureId);
			snapshotChanged = true;
			this.emit(undefined);
		}
		if (referenceHealthChanged && !snapshotChanged) this.emit(undefined);
		if (inventoryChanged && !snapshotChanged && !referenceHealthChanged) {
			this.emit(undefined);
		}
	}

	private acceptWorktreeInventory(
		generation: number,
		projectId: string,
		inventory: WorktreeBranchInventory,
	): void {
		if (this.disposed || generation !== this.generation) return;
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
		const github = await this.observeGithub(
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
		generation: number,
		projectId: string,
		health: ProjectReferenceBranchHealth,
	): void {
		if (this.disposed || generation !== this.generation) return;
		const previous = this.projectReferenceHealth.get(projectId);
		this.projectReferenceHealth.set(projectId, health);
		if (!previous || !equivalentReferenceHealth(previous, health)) {
			this.emit(undefined);
		}
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
	const linked = new Set([
		feature.branch,
		...(feature.primaryBranchRef ? [feature.primaryBranchRef] : []),
		...(feature.branchLinks?.map((link) => link.ref) ?? []),
	]);
	if (projectObservation.worktrees.status === "known") {
		const checkout = projectObservation.worktrees.value.find(
			(worktree) =>
				path.resolve(worktree.path) === path.resolve(feature.worktreePath) &&
				worktree.branchRef &&
				linked.has(worktree.branchRef),
		);
		if (checkout?.branchRef) return checkout.branchRef;
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
