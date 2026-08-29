import type { TerminalController } from "../agents/terminalController";
import type { TmuxIntegration } from "../agents/tmux";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Feature } from "../types";
import { verifySessionsStopped } from "./featureFinish";

export interface CleanupOrphanedFeaturesDeps {
	readonly projectManager: Pick<
		ProjectManager,
		"getAllContexts" | "observeTmuxSessions"
	>;
	readonly terminalController: Pick<TerminalController, "killFeatureTerminals">;
	readonly tmux: Pick<TmuxIntegration, "sessionName" | "legacySessionName">;
	readonly sessionNameSyncer: { clearFeature(id: string): void };
}

export type CleanupOrphanedFeaturesOutcome =
	| { status: "nothing_to_do" }
	| { status: "blocked"; reason: string }
	| { status: "cleaned"; count: number };

/**
 * Orchestrate orphaned feature cleanup: kill tracked tmux sessions, verify
 * they are actually stopped, then remove metadata. Extracted from the
 * extension command so the fail-closed verification path is testable.
 */
export async function cleanupOrphanedFeatures(
	deps: CleanupOrphanedFeaturesDeps,
): Promise<CleanupOrphanedFeaturesOutcome> {
	const orphans: Array<{ ctx: ProjectContext; feature: Feature }> = [];
	for (const ctx of deps.projectManager.getAllContexts()) {
		for (const orphan of ctx.featureManager.getOrphanedFeatures()) {
			orphans.push({ ctx, feature: orphan });
		}
	}
	if (orphans.length === 0) {
		return { status: "nothing_to_do" };
	}

	// Collect tracked tmux sessions for all orphans before killing.
	const trackedSessions = new Set<string>();
	for (const { ctx, feature } of orphans) {
		for (const agent of ctx.agentManager.getAgents(feature.id)) {
			const session =
				agent.tmuxSession ?? deps.tmux.sessionName(feature.id, agent.id);
			trackedSessions.add(session);
			trackedSessions.add(deps.tmux.legacySessionName(feature.id, agent.id));
		}
		for (const service of ctx.serviceManager.getServices(feature.id)) {
			trackedSessions.add(service.tmuxSession);
		}
	}

	// Kill terminals for all orphans.
	for (const { feature } of orphans) {
		deps.terminalController.killFeatureTerminals(feature.id);
	}

	// Verify sessions actually stopped before removing metadata.
	if (trackedSessions.size > 0) {
		const verification = verifySessionsStopped(
			trackedSessions,
			deps.projectManager.observeTmuxSessions(),
		);
		if (verification.status === "blocked") {
			return { status: "blocked", reason: verification.reason };
		}
	}

	for (const { ctx, feature } of orphans) {
		deps.sessionNameSyncer.clearFeature(feature.id);
		ctx.featureManager.forgetFinishedFeature(feature.id);
	}

	return { status: "cleaned", count: orphans.length };
}
