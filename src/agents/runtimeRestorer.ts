import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, CodingTool, Feature } from "../types";
import { execAsync } from "../utils/platform";
import type { CodingToolRegistry } from "./codingToolRegistry";
import { openCodeBackendManager } from "./codingToolRegistry";
import { reconnectOpenCodeAgent } from "./openCodeReattach";
import {
	RuntimeOwnershipGuard,
	runtimeOwnershipKey,
	withRuntimeSpawnLock,
} from "./runtimeOwnership";
import { sessionIsProven } from "./sessionProven";
import type { TmuxIntegration } from "./tmux";

/**
 * Post-restart runtime restoration for agent sessions.
 *
 * This module is deliberately decoupled from terminal presentation. After a
 * machine reboot (or a VS Code reload where tmux survived) it brings back the
 * agent *runtime* — the tmux session running the agent's CLI — without ever
 * creating or focusing a `vscode.Terminal`. Terminal presentation stays a
 * user-triggered action (the sidebar/home click paths call the
 * TerminalController).
 *
 * The restore is fail-closed and strictly resumes:
 *
 * - an agent that was actually running (`hasStarted === true`, not `done`,
 *   not `errored`) whose tmux session is gone is recreated with a *genuine*
 *   provider resume command. A brand-new conversation is never started
 *   silently: a resume is only issued when the persisted session id exists and
 *   passes the provider's own existence proof (`hasSession`), and the command
 *   is built by `buildStrictResumeLaunchCommand`, which refuses the fresh
 *   launch fallback.
 * - if any precondition fails, the agent is left untouched and reported
 *   `blocked` with a stable reason, and the state is persisted on the agent
 *   record so it is visible instead of a silent no-op.
 *
 * It is idempotent: a tmux session that is alive (whether it survived the
 * restart or was recreated by an earlier restore pass) is only observed as
 * `reattached`, never spawned again.
 */
export type RuntimeRestoreKind = "reattached" | "resumed" | "blocked";

export interface RuntimeRestoreOutcome {
	projectId: string;
	featureId: string;
	agentId: string;
	agentName: string;
	kind: RuntimeRestoreKind;
	/** Stable, short explanation for a `blocked` outcome. */
	reason?: string;
}

export interface RuntimeRestoreReport {
	considered: number;
	reattached: RuntimeRestoreOutcome[];
	resumed: RuntimeRestoreOutcome[];
	blocked: RuntimeRestoreOutcome[];
}

export interface RuntimeRestoreDeps {
	projectManager: ProjectManager;
	tmux: TmuxIntegration;
	toolRegistry: CodingToolRegistry;
}

export async function restoreAgentRuntimes(
	deps: RuntimeRestoreDeps,
): Promise<RuntimeRestoreReport> {
	const report: RuntimeRestoreReport = {
		considered: 0,
		reattached: [],
		resumed: [],
		blocked: [],
	};

	// No tmux, no runtime to restore — fail closed and stay silent.
	if (!(await deps.tmux.isAvailableAsync())) return report;

	for (const ctx of deps.projectManager.getAllContexts()) {
		for (const feature of managedFeatures(ctx)) {
			const agents = ctx.agentManager.getAgentsReadModel(feature.id);
			const ordered = [...agents].sort(byCreatedAt);
			for (const agent of ordered) {
				const outcome = await restoreAgentRuntime(ctx, feature, agent, deps);
				if (!outcome) continue;
				report.considered += 1;
				report[outcome.kind].push(outcome);
			}
		}
	}

	return report;
}

async function restoreAgentRuntime(
	ctx: ProjectContext,
	feature: Feature,
	agent: Agent,
	deps: RuntimeRestoreDeps,
): Promise<RuntimeRestoreOutcome | undefined> {
	return withRuntimeSpawnLock(runtimeOwnershipKey(agent), () =>
		restoreAgentRuntimeUnlocked(ctx, feature, agent, deps),
	);
}

async function restoreAgentRuntimeUnlocked(
	ctx: ProjectContext,
	feature: Feature,
	agent: Agent,
	deps: RuntimeRestoreDeps,
): Promise<RuntimeRestoreOutcome | undefined> {
	const base = {
		projectId: ctx.project.id,
		featureId: feature.id,
		agentId: agent.id,
		agentName: agent.name,
	};

	// Only agents that really had (or were about to have, after a reopen) a
	// runtime are restored. Done, errored and never-started agents are left to
	// the user.
	if (agent.status === "done" || agent.status === "errored") return undefined;
	if (agent.hasStarted !== true) return undefined;

	const outcome = (kind: RuntimeRestoreKind, reason?: string) => ({
		...base,
		kind,
		reason,
	});

	const sessionName =
		agent.tmuxSession ?? deps.tmux.sessionName(feature.id, agent.id);
	const legacySessionName = deps.tmux.legacySessionName(feature.id, agent.id);

	const tool = deps.toolRegistry.resolveAgentToolForAgent(agent);

	if (await deps.tmux.adoptSessionAsync(sessionName, legacySessionName)) {
		// Case A: the runtime survived (VS Code reload with a live tmux), or a
		// previous restore pass already recreated it.
		//
		// For every other provider, tmux-alive genuinely implies a working
		// runtime and nothing else is needed. OpenCode is different: the tmux
		// pane only ever runs `opencode attach <backend-url> ...`, and the
		// `opencode serve` backend it points at is a child of the Extension
		// Host, not of tmux — it does not survive a reload, and can also die
		// independently while VS Code stays open. A live pane therefore does
		// NOT imply a live session here, so an agent is only ever considered
		// `reattached` once its attach client is proven wired to the
		// worktree's current, healthy backend.
		if (tool.id === "opencode") {
			const cwd = agent.worktreePath ?? feature.worktreePath;
			const result = await reconnectOpenCodeAgent(
				agent,
				tool,
				cwd,
				sessionName,
				deps,
			);
			if (result.kind === "blocked") {
				return persistBlocked(ctx, agent, result.reason, outcome);
			}
			// "reconnected" (freshly respawned onto the current backend) and
			// "skipped" (already pointed at it) both mean the agent is reattached.
			ctx.agentManager.recordRestoreOutcomeReadModel(agent.id, feature.id, {
				state: "reattached",
				at: new Date().toISOString(),
			});
			return outcome("reattached");
		}

		ctx.agentManager.recordRestoreOutcomeReadModel(agent.id, feature.id, {
			state: "reattached",
			at: new Date().toISOString(),
		});
		return outcome("reattached");
	}

	// Case B: the runtime is gone. Only a genuinely provable resume may rebuild
	// it — a silent fresh launch is never acceptable on this path.
	if (!supportsResume(deps, tool)) {
		const reason =
			"Provider has no resume capability; the agent runtime was not recreated";
		return persistBlocked(ctx, agent, reason, outcome);
	}
	if (!agent.sessionId) {
		const reason =
			"No provider session id is persisted; the agent runtime was not recreated";
		return persistBlocked(ctx, agent, reason, outcome);
	}
	if (!(await sessionIsProven(deps, tool, agent))) {
		const reason =
			"Persisted session id could not be verified in the provider store; refusing an unattributable resume";
		return persistBlocked(ctx, agent, reason, outcome);
	}

	const cwd = agent.worktreePath ?? feature.worktreePath;

	// For OpenCode controlled backend, ensure the backend is running so
	// buildStrictResumeLaunchCommand can construct the correct attach command.
	if (tool.id === "opencode") {
		try {
			await openCodeBackendManager.ensure(cwd);
		} catch (error) {
			console.warn(
				`[RuntimeRestorer] OpenCode backend ensure failed for ${cwd}: ${error}`,
			);
			return persistBlocked(
				ctx,
				agent,
				"OpenCode backend could not be started; agent runtime not recreated",
				outcome,
			);
		}
	}

	const resumeCommand = deps.toolRegistry.buildStrictResumeLaunchCommand(
		tool,
		agent.sessionId,
		cwd,
	);
	if (!resumeCommand) {
		const reason =
			"Provider could not build a resume command for the persisted session; the agent runtime was not recreated";
		return persistBlocked(ctx, agent, reason, outcome);
	}

	// Hermes ownership guard: prevent duplicate live runtimes for the same session.
	const ownership =
		tool.family === "hermes"
			? await new RuntimeOwnershipGuard(
					deps.projectManager,
					deps.tmux,
					deps.toolRegistry,
				).checkResume(
					agent.sessionId,
					agent.id,
					agent.hermesProfile ?? "default",
				)
			: { allowed: true, owners: [] };
	if (!ownership.allowed) {
		return persistBlocked(ctx, agent, ownership.reason as string, outcome);
	}

	try {
		await execAsync(deps.tmux.createCommand(sessionName, resumeCommand), {
			cwd,
		});
		await deps.tmux.configureSessionAsync(sessionName);
	} catch (error) {
		console.warn(`[RuntimeRestorer] tmux resume failed: ${error}`);
		return persistBlocked(
			ctx,
			agent,
			"tmux session could not be recreated; see extension log",
			outcome,
		);
	}

	if (!(await deps.tmux.isSessionAliveAsync(sessionName))) {
		return persistBlocked(
			ctx,
			agent,
			"the recreated tmux session did not stay alive",
			outcome,
		);
	}

	// The CLI is running again. Reflect that on the record so the UI shows a
	// live agent; the SessionBinder re-validates the exact bounded session.
	ctx.agentManager.updateAgentStatusReadModel(agent.id, feature.id, "running");
	ctx.agentManager.recordRestoreOutcomeReadModel(agent.id, feature.id, {
		state: "resumed",
		at: new Date().toISOString(),
	});
	return outcome("resumed");
}

function supportsResume(deps: RuntimeRestoreDeps, tool: CodingTool): boolean {
	if (tool.resumeCommand) return true;
	return deps.toolRegistry.getProvider(tool).capabilities.resume === true;
}

function persistBlocked(
	ctx: ProjectContext,
	agent: Agent,
	reason: string,
	outcome: (kind: RuntimeRestoreKind, reason?: string) => RuntimeRestoreOutcome,
): RuntimeRestoreOutcome {
	ctx.agentManager.recordRestoreOutcomeReadModel(agent.id, agent.featureId, {
		state: "blocked",
		reason,
		at: new Date().toISOString(),
	});
	return outcome("blocked", reason);
}

/** Restore is ordered by oldest-first so the outcome order is deterministic. */
function byCreatedAt(left: Agent, right: Agent): number {
	if (left.createdAt < right.createdAt) return -1;
	if (left.createdAt > right.createdAt) return 1;
	return 0;
}

/**
 * The persisted agents live on the base feature (repo root) and on every
 * persisted feature. This is the same enumeration the SessionBinder uses, so
 * restoration and binding always agree on what an agent is.
 */
function managedFeatures(ctx: ProjectContext): Feature[] {
	const base = ctx.featureManager.getBaseFeature(ctx.project.id);
	const persisted = [...ctx.store.loadFeatures()].sort((left, right) => {
		if (left.createdAt < right.createdAt) return -1;
		if (left.createdAt > right.createdAt) return 1;
		return 0;
	});
	return [base, ...persisted];
}
