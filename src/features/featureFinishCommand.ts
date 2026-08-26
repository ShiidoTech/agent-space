import type * as vscode from "vscode";
import type { TerminalController } from "../agents/terminalController";
import type { TmuxIntegration, TmuxSessionsObservation } from "../agents/tmux";
import type { ProjectContext } from "../projects/projectManager";
import type { Feature } from "../types";
import {
	assessFeatureFinish,
	type FeatureFinishAssessment,
	planFeatureFinishRemovals,
	verifySessionsStopped,
} from "./featureFinish";
import type { FeatureSnapshot } from "./featureSnapshot";
import type { FeatureStateCoordinator } from "./featureStateCoordinator";

/**
 * Outcome of a single `Finish Feature` invocation, surfaced for UI decisions
 * and (above all) for deterministic command-level tests.
 */
export type FeatureFinishOutcome =
	| { readonly status: "finished" }
	| { readonly status: "cancelled" }
	| { readonly status: "already_in_progress" }
	| { readonly status: "blocked"; readonly message: string }
	| { readonly status: "error"; readonly message: string };

export interface FeatureFinishDeps {
	readonly projectManager: {
		readonly observeTmuxSessions: () => TmuxSessionsObservation;
		readonly notifyChange: () => void;
	};
	readonly featureStateCoordinator: Pick<
		FeatureStateCoordinator,
		"getSnapshot" | "reconcile"
	>;
	readonly tmux: Pick<TmuxIntegration, "sessionName" | "legacySessionName">;
	readonly terminalController: Pick<TerminalController, "killFeatureTerminals">;
	readonly sessionNameSyncer: { readonly clearFeature: (id: string) => void };
	readonly sidebarProvider: { readonly refresh: () => void };
	readonly homePanel: {
		readonly getInstance: () =>
			| { readonly showWelcome: () => void }
			| undefined;
	};
	readonly getActiveFeatureId: () => string | null;
	readonly setActiveFeatureId: (id: string | null) => void;
	/** True while a Finish is already running for this Feature. */
	readonly isInProgress: (featureId: string) => boolean;
	readonly markInProgress: (featureId: string) => void;
	readonly unmarkInProgress: (featureId: string) => void;
	/**
	 * Injection point for the safety assessment, defaulting to the real
	 * `assessFeatureFinish`. Overridable so the command's orchestration
	 * (immediate feedback, guard release, outcome mapping) can be tested
	 * deterministically without a real Git worktree.
	 */
	assess?: (
		ctx: ProjectContext,
		feature: Feature,
		evidence: { readonly integration: FeatureSnapshot["integration"] },
	) => FeatureFinishAssessment | Promise<FeatureFinishAssessment>;
	readonly openWorktree?: (worktreePath: string) => void;
	readonly removeWorktreeResidue?: (worktreePath: string) =>
		| {
				readonly removed: boolean;
				readonly reason?: string;
				readonly suggestedCommand?: string;
		  }
		| Promise<{
				readonly removed: boolean;
				readonly reason?: string;
				readonly suggestedCommand?: string;
		  }>;
	readonly openTerminalWithCommand?: (command: string) => void;
}

export interface FeatureFinishUi {
	readonly showInformationMessage: (
		message: string,
	) => Thenable<string | undefined>;
	readonly showErrorMessage: (
		message: string,
		...items: string[]
	) => Thenable<string | undefined>;
	readonly showWarningMessage: (
		message: string,
		options: vscode.MessageOptions,
		...items: string[]
	) => Thenable<string | undefined>;
	readonly copyToClipboard?: (text: string) => Thenable<void>;
	readonly withProgress: (
		options: {
			location: number;
			title?: string;
			cancellable?: boolean;
		},
		task: (progress: {
			readonly report: (value: { readonly message?: string }) => void;
		}) => Thenable<FeatureFinishOutcome>,
	) => Thenable<FeatureFinishOutcome>;
	/** `vscode.ProgressLocation.Notification`. */
	readonly progressLocationNotification: number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The whole `Finish Feature` command flow, extracted so it can be exercised at
 * the command level. Immediate observable feedback and a hard `try/finally`
 * guarantee on the in-progress guard are invariants here, not decoration:
 *
 * - the progress notification starts on the first line (before any evidence
 *   reconciliation), so a click is never met with silence;
 * - when no observation snapshot exists yet, the single fallback reconcile is
 *   itself reported as a visible phase;
 * - every exit path releases the per-Feature in-progress guard, including
 *   unexpected exceptions, so a failure can never lock Finish until reload.
 */
export async function runFeatureFinish(
	ctx: ProjectContext,
	feature: Feature,
	deps: FeatureFinishDeps,
	ui: FeatureFinishUi,
): Promise<FeatureFinishOutcome> {
	if (deps.isInProgress(feature.id)) {
		void ui.showInformationMessage(
			`Feature "${feature.name}" is already being finished.`,
		);
		return { status: "already_in_progress" };
	}
	deps.markInProgress(feature.id);
	try {
		return await ui.withProgress(
			{
				location: ui.progressLocationNotification,
				title: `Finishing "${feature.name}"…`,
			},
			async (progress) => {
				progress.report({ message: "Checking feature…" });
				let snapshot: FeatureSnapshot | undefined =
					deps.featureStateCoordinator.getSnapshot(feature.id);
				if (!snapshot) {
					progress.report({ message: "Checking integration…" });
					await deps.featureStateCoordinator.reconcile();
					snapshot = deps.featureStateCoordinator.getSnapshot(feature.id);
				}
				if (snapshot?.integration.status === "unknown") {
					progress.report({ message: "Refreshing integration evidence…" });
					await deps.featureStateCoordinator.reconcile();
					snapshot = deps.featureStateCoordinator.getSnapshot(feature.id);
				}
				if (!snapshot) {
					const message = `Cannot assess "${feature.name}" safely: Feature integration evidence was not observed`;
					void ui.showErrorMessage(message);
					return { status: "error", message };
				}

				let assessment: FeatureFinishAssessment;
				try {
					assessment = await (deps.assess ?? assessFeatureFinish)(
						ctx,
						feature,
						{ integration: snapshot.integration },
					);
				} catch (error) {
					const message = `Cannot assess "${feature.name}" safely: ${messageOf(error)}`;
					void ui.showErrorMessage(message);
					return { status: "error", message };
				}

				if (!assessment.safe && !assessment.forceable) {
					const residue = assessment.checks.find(
						(check) => check.disposition === "residue",
					);
					if (residue) {
						const action = await ui.showWarningMessage(
							`Feature "${feature.name}" has an unregistered worktree residue at ${residue.worktreePath}.`,
							{ modal: true },
							...(deps.openWorktree ? ["Inspect residue"] : []),
							...(deps.removeWorktreeResidue ? ["Remove residue"] : []),
						);
						if (action === "Inspect residue") {
							deps.openWorktree?.(residue.worktreePath);
						} else if (action === "Remove residue") {
							const removal = await deps.removeWorktreeResidue?.(
								residue.worktreePath,
							);
							if (removal?.removed) {
								void ui.showInformationMessage(
									`Removed worktree residue at ${residue.worktreePath}. Run Finish Feature again to remove the Agent Space record.`,
								);
								return {
									status: "blocked",
									message: `Removed worktree residue at ${residue.worktreePath}. Run Finish Feature again to remove the Agent Space record.`,
								};
							} else {
								const reason = removal?.reason ?? "unknown error";
								const suggestedCommand = removal?.suggestedCommand;
								const message = suggestedCommand
									? `Could not remove worktree residue: ${reason}\n\nRemove it with:\n${suggestedCommand}`
									: `Could not remove worktree residue: ${reason}`;
								const actions = [
									...(suggestedCommand && deps.openTerminalWithCommand
										? ["Run command in terminal"]
										: []),
									...(suggestedCommand && ui.copyToClipboard
										? ["Copy command"]
										: []),
								];
								const action = await ui.showErrorMessage(message, ...actions);
								if (action === "Run command in terminal" && suggestedCommand) {
									deps.openTerminalWithCommand?.(suggestedCommand);
								} else if (action === "Copy command" && suggestedCommand) {
									void ui.copyToClipboard?.(suggestedCommand);
								}
								return { status: "blocked", message };
							}
						}
					}
					const message = `Cannot finish "${feature.name}" because safety is unknown:\n\n${assessment.reasons.join("\n\n")}\n\nNo worktree, session or metadata was removed.`;
					void ui.showErrorMessage(message);
					return { status: "blocked", message };
				}

				const action = assessment.safe
					? "Finish Feature"
					: "Finish with known risks";
				const risks = assessment.reasons.length
					? `\n\nKnown risks and retained Git work:\n${assessment.reasons.join("\n")}`
					: "";
				const confirm = await ui.showWarningMessage(
					`Finish feature "${feature.name}"?\n\nThis stops its ${ctx.agentManager.getAgents(feature.id).length} agent(s) and ${ctx.serviceManager.getServices(feature.id).length} service(s), removes ${assessment.checks.length} worktree(s), then removes the Agent Space feature record. Git branches are preserved.${risks}`,
					{ modal: true },
					action,
				);
				if (confirm !== action) return { status: "cancelled" };

				// Stop execution first, but preserve every record until Git cleanup succeeds.
				progress.report({ message: "Stopping agents and services…" });
				const trackedSessions = new Set<string>();
				for (const agent of ctx.agentManager.getAgents(feature.id)) {
					const session =
						agent.tmuxSession ?? deps.tmux.sessionName(feature.id, agent.id);
					trackedSessions.add(session);
					trackedSessions.add(
						deps.tmux.legacySessionName(feature.id, agent.id),
					);
				}
				for (const service of ctx.serviceManager.getServices(feature.id)) {
					trackedSessions.add(service.tmuxSession);
				}
				deps.terminalController.killFeatureTerminals(feature.id);
				if (trackedSessions.size > 0) {
					const stopVerification = verifySessionsStopped(
						trackedSessions,
						deps.projectManager.observeTmuxSessions(),
					);
					if (stopVerification.status === "blocked") {
						const message = `Feature "${feature.name}" was not finished because ${stopVerification.reason}. No worktree or metadata was removed.`;
						void ui.showErrorMessage(message);
						return { status: "blocked", message };
					}
				}

				// Reassess with the same observation evidence but fresh local Git
				// safety (assessFeatureFinish re-reads worktree state
				// synchronously). Stopping sessions cannot change Git/GitHub
				// state, so a second full reconcile here would only add network
				// latency without improving the safety fingerprint.
				progress.report({ message: "Checking worktree safety…" });
				let current: FeatureFinishAssessment;
				try {
					current = await (deps.assess ?? assessFeatureFinish)(ctx, feature, {
						integration: snapshot.integration,
					});
				} catch (error) {
					const message = `Feature "${feature.name}" could not be reassessed after stopping sessions: ${messageOf(error)}. No worktree or metadata was removed.`;
					void ui.showErrorMessage(message);
					return { status: "error", message };
				}
				if (
					current.fingerprint !== assessment.fingerprint ||
					(!current.safe && !current.forceable)
				) {
					const message = `Feature "${feature.name}" changed after confirmation. Cleanup stopped before removing worktrees or metadata; review it and try again.`;
					void ui.showErrorMessage(message);
					return { status: "blocked", message };
				}

				const removalPlan = planFeatureFinishRemovals(current);
				const featureRemovalPlan = removalPlan.find(
					(entry) => entry.kind === "feature",
				);
				if (featureRemovalPlan) {
					progress.report({ message: "Removing worktrees…" });
					try {
						const featureRemoval =
							await ctx.featureManager.removeFeatureWorktreeForFinish(
								feature.id,
								{
									force: featureRemovalPlan.force,
									...(featureRemovalPlan.acceptedPullRequestHeadSha
										? {
												acceptedPullRequestHeadSha:
													featureRemovalPlan.acceptedPullRequestHeadSha,
											}
										: {}),
								},
							);
						if (!featureRemoval.deleted) {
							const message = `Feature "${feature.name}" was not finished:\n\n${featureRemoval.reasons.join("\n")}\n\nAll Agent Space records were preserved.`;
							void ui.showErrorMessage(message);
							return { status: "blocked", message };
						}
					} catch (error) {
						const message = `Feature "${feature.name}" was not finished: ${messageOf(error)}. All Agent Space records were preserved.`;
						void ui.showErrorMessage(message);
						return { status: "error", message };
					}
				}
				for (const entry of removalPlan) {
					if (entry.kind !== "agent" || !entry.agentId) continue;
					const removal = await ctx.agentManager.removeAgentWorktreeForFinish(
						entry.agentId,
						feature.id,
						entry.force,
					);
					if (!removal.removed) {
						const message = `Feature "${feature.name}" was not finished: ${removal.reason ?? "an agent worktree could not be removed"}. Feature, agent and service records were preserved.`;
						void ui.showErrorMessage(message);
						return { status: "blocked", message };
					}
				}

				progress.report({ message: "Finalizing…" });
				ctx.featureManager.forgetFinishedFeature(feature.id);
				deps.sessionNameSyncer.clearFeature(feature.id);
				// Invalidate the coordinator so the finished Feature leaves every
				// snapshot-driven surface (sidebar, home) deterministically without
				// waiting for the next poll cycle.
				deps.projectManager.notifyChange();
				deps.sidebarProvider.refresh();

				if (deps.getActiveFeatureId() === feature.id) {
					deps.setActiveFeatureId(null);
				}
				deps.homePanel.getInstance()?.showWelcome();
				return { status: "finished" };
			},
		);
	} finally {
		deps.unmarkInProgress(feature.id);
	}
}
