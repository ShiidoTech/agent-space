import { agentSpaceDiagnostic } from "../diagnostics/agentSpaceDiagnostics";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, Feature } from "../types";
import type { CodingToolRegistry } from "./codingToolRegistry";
import type { SessionCorrelationContext } from "./sessionProviders/types";
import type { TmuxIntegration } from "./tmux";

export interface LiveRuntimeOwner {
	readonly agentId: string;
	readonly featureId: string;
	readonly tmuxSession: string;
}

export interface RuntimeOwnershipCheck {
	readonly allowed: boolean;
	readonly owners: readonly LiveRuntimeOwner[];
	readonly reason?: string;
}

/**
 * Cross-path guard for provider resume. A provider session is not resumable by
 * Agent Space merely because its durable row exists: another live Agent Space
 * pane may already be using that same id. This check is intentionally based on
 * the persisted Agent Space binding plus live tmux evidence, never on cwd or
 * session age.
 */
export class RuntimeOwnershipGuard {
	constructor(
		private readonly projectManager: ProjectManager,
		private readonly tmux: TmuxIntegration,
		private readonly toolRegistry: CodingToolRegistry,
	) {}

	async checkResume(
		sessionId: string,
		exceptAgentId: string,
		effectiveProfile = "default",
	): Promise<RuntimeOwnershipCheck> {
		const owners: LiveRuntimeOwner[] = [];
		for (const { ctx, feature } of managedFeatures(this.projectManager)) {
			for (const agent of agentsFor(ctx, feature.id)) {
				if (agent.id === exceptAgentId) continue;
				const owner = await this.liveOwnerAsync(
					feature,
					agent,
					sessionId,
					effectiveProfile,
				);
				if (owner) owners.push(owner);
			}
		}
		return ownershipResult(sessionId, owners);
	}

	checkResumeSync(
		sessionId: string,
		exceptAgentId: string,
		effectiveProfile = "default",
	): RuntimeOwnershipCheck {
		const owners: LiveRuntimeOwner[] = [];
		for (const { ctx, feature } of managedFeatures(this.projectManager)) {
			for (const agent of agentsFor(ctx, feature.id)) {
				if (agent.id === exceptAgentId) continue;
				const owner = this.liveOwnerSync(
					feature,
					agent,
					sessionId,
					effectiveProfile,
				);
				if (owner) owners.push(owner);
			}
		}
		return ownershipResult(sessionId, owners);
	}

	private async liveOwnerAsync(
		feature: Feature,
		agent: Agent,
		sessionId: string,
		effectiveProfile: string,
	): Promise<LiveRuntimeOwner | undefined> {
		const tmuxSession =
			agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id);
		if (!(await this.tmux.isSessionAliveAsync(tmuxSession))) return undefined;
		const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
		if (
			tool.family === "hermes" &&
			(agent.hermesProfile ?? "default") !== effectiveProfile
		) {
			return undefined;
		}
		const adapter = tool.provider?.sessionAdapter;
		if (tool.family === "hermes" && adapter?.async?.correlateOwnedSession) {
			const found = await adapter.async.correlateOwnedSession(
				correlationContext(feature, agent, tmuxSession),
			);
			if (found === sessionId)
				return { agentId: agent.id, featureId: feature.id, tmuxSession };
			return undefined;
		}
		if (agent.sessionId === sessionId)
			return { agentId: agent.id, featureId: feature.id, tmuxSession };
		return undefined;
	}

	private liveOwnerSync(
		feature: Feature,
		agent: Agent,
		sessionId: string,
		effectiveProfile: string,
	): LiveRuntimeOwner | undefined {
		const tmuxSession =
			agent.tmuxSession ?? this.tmux.sessionName(feature.id, agent.id);
		if (!this.tmux.isSessionAlive(tmuxSession)) return undefined;
		const tool = this.toolRegistry.resolveAgentToolForAgent(agent);
		if (
			tool.family === "hermes" &&
			(agent.hermesProfile ?? "default") !== effectiveProfile
		) {
			return undefined;
		}
		const adapter = tool.provider?.sessionAdapter;
		if (tool.family === "hermes" && adapter?.correlateOwnedSession) {
			const found = adapter.correlateOwnedSession(
				correlationContext(feature, agent, tmuxSession),
			);
			if (found === sessionId)
				return { agentId: agent.id, featureId: feature.id, tmuxSession };
			return undefined;
		}
		if (agent.sessionId === sessionId)
			return { agentId: agent.id, featureId: feature.id, tmuxSession };
		return undefined;
	}
}

export function runtimeOwnershipKey(agent: Agent): string {
	return `hermes:${agent.hermesProfile ?? "default"}:session:${agent.sessionId ?? `agent:${agent.featureId}:${agent.id}`}`;
}

const spawnLocks = new Map<string, Promise<unknown>>();

/** A pendu spawn must never serialize its key forever (audit P1-5). */
export const RUNTIME_SPAWN_LOCK_TIMEOUT_MS = 30_000;

/** Serialize every Agent Space spawn path for one logical agent/runtime. */
export async function withRuntimeSpawnLock<T>(
	key: string,
	spawn: () => Promise<T>,
	timeoutMs = RUNTIME_SPAWN_LOCK_TIMEOUT_MS,
): Promise<T> {
	const previous = spawnLocks.get(key);
	const current = (async () => {
		if (previous) {
			let timedOut = false;
			await Promise.race([
				previous.catch(() => undefined),
				new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						timedOut = true;
						resolve();
					}, timeoutMs);
					(timer as unknown as { unref?: () => void }).unref?.();
				}),
			]);
			if (timedOut) {
				agentSpaceDiagnostic(
					`spawn lock timeout key=${key} after ${timeoutMs}ms; proceeding without waiting for the pendu spawn`,
				);
			}
		}
		return spawn();
	})();
	spawnLocks.set(key, current);
	try {
		return await current;
	} finally {
		if (spawnLocks.get(key) === current) spawnLocks.delete(key);
	}
}

/** The sync path cannot await an async spawn, so it fails closed while queued. */
export function withRuntimeSpawnLockSync<T>(
	key: string,
	spawn: () => T,
): T | undefined {
	if (spawnLocks.has(key) || syncSpawnLocks.has(key)) return undefined;
	syncSpawnLocks.add(key);
	try {
		return spawn();
	} finally {
		syncSpawnLocks.delete(key);
	}
}

const syncSpawnLocks = new Set<string>();

function ownershipResult(
	sessionId: string,
	owners: LiveRuntimeOwner[],
): RuntimeOwnershipCheck {
	if (owners.length === 0) return { allowed: true, owners };
	const ownerText = owners
		.map((owner) => `${owner.agentId} (${owner.tmuxSession})`)
		.join(", ");
	return {
		allowed: false,
		owners,
		reason: `Refusing to resume Hermes session ${sessionId}: it is already owned by live Agent Space runtime(s) ${ownerText}`,
	};
}

function correlationContext(
	feature: Feature,
	agent: Agent,
	tmuxSession: string,
): SessionCorrelationContext {
	return {
		agentId: agent.id,
		featureId: feature.id,
		cwd: agent.worktreePath ?? feature.worktreePath,
		knownSessionIds: new Set(),
		tmuxSession,
		launchedAtMs: agent.launchedAt ? Date.parse(agent.launchedAt) : undefined,
	};
}

function agentsFor(ctx: ProjectContext, featureId: string): Agent[] {
	const readModel = ctx.agentManager.getAgentsReadModel;
	return readModel
		? readModel.call(ctx.agentManager, featureId)
		: ctx.agentManager.getAgents(featureId);
}

function managedFeatures(
	projectManager: ProjectManager,
): Array<{ ctx: ProjectContext; feature: Feature }> {
	const getAllContexts = (
		projectManager as ProjectManager & {
			getAllContexts?: () => ProjectContext[];
		}
	).getAllContexts;
	if (!getAllContexts) return [];
	return getAllContexts.call(projectManager).flatMap((ctx) => {
		const base = ctx.featureManager.getBaseFeature(ctx.project.id);
		return [
			{ ctx, feature: base },
			...ctx.store.loadFeatures().map((feature) => ({ ctx, feature })),
		];
	});
}
