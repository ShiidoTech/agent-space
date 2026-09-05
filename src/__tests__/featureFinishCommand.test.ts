import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type FeatureFinishDeps,
	type FeatureFinishOutcome,
	type FeatureFinishUi,
	runFeatureFinish,
} from "../features/featureFinishCommand";
import type { Feature } from "../types";

function feature(id = "f1"): Feature {
	return {
		id,
		name: id,
		branch: `feat/${id}`,
		worktreePath: `/repo/.worktrees/${id}`,
		status: "active",
		color: "blue",
		isolation: "shared",
		createdAt: "2026-08-10T00:00:00.000Z",
		createdFromSha: "1".repeat(40),
	};
}

type UiSpy = {
	reports: string[];
	confirmed: string | undefined;
};

function buildUi(
	options: { confirmed?: string; overrides?: Partial<FeatureFinishUi> } = {},
): { ui: FeatureFinishUi; spy: UiSpy } {
	const spy: UiSpy = { reports: [], confirmed: options.confirmed };
	let runTask:
		| ((progress: {
				report: (value: { message?: string }) => void;
		  }) => Promise<FeatureFinishOutcome>)
		| undefined;
	const ui: FeatureFinishUi = {
		showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
		showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
		showWarningMessage: vi.fn(() => Promise.resolve(spy.confirmed)),
		withProgress: vi.fn((_options, task) => {
			runTask = task;
			const progress = {
				report: (value: { message?: string }) => {
					if (value.message) spy.reports.push(value.message);
				},
			};
			return Promise.resolve().then(
				() =>
					runTask?.(progress) ??
					Promise.resolve({ status: "error" as const, message: "no task" }),
			);
		}),
		progressLocationNotification: 1,
		...options.overrides,
	};
	return { ui, spy };
}

function buildDeps(overrides: Partial<FeatureFinishDeps> = {}): {
	deps: FeatureFinishDeps;
	inProgress: Set<string>;
} {
	const inProgress = new Set<string>();
	const deps: FeatureFinishDeps = {
		projectManager: {
			observeTmuxSessions: vi.fn(
				() => ({ status: "known", sessions: [] as string[] }) as const,
			),
			notifyChange: vi.fn(),
		},
		featureStateCoordinator: {
			getSnapshot: vi.fn(() => undefined),
			reconcile: vi.fn(() => Promise.resolve()),
		},
		tmux: {
			sessionName: vi.fn((f, a) => `tmux-${f}-${a}`),
			legacySessionName: vi.fn((f, a) => `legacy-${f}-${a}`),
		},
		terminalController: { killFeatureTerminals: vi.fn() },
		sessionNameSyncer: { clearFeature: vi.fn() },
		sidebarProvider: { refresh: vi.fn() },
		homePanel: { getInstance: vi.fn(() => undefined) },
		getActiveFeatureId: vi.fn(() => "f1"),
		setActiveFeatureId: vi.fn(),
		isInProgress: (id) => inProgress.has(id),
		markInProgress: (id) => {
			inProgress.add(id);
		},
		unmarkInProgress: (id) => {
			inProgress.delete(id);
		},
		...overrides,
	};
	return { deps, inProgress };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runFeatureFinish command flow", () => {
	it("reports an immediate checking phase even when no snapshot exists, and reconciles once", async () => {
		const { deps, inProgress } = buildDeps();
		const { ui, spy } = buildUi();
		const reconcile = deps.featureStateCoordinator.reconcile as ReturnType<
			typeof vi.fn
		>;

		// First report of "Checking feature…" must happen even when the
		// snapshot is missing; the fallback reconcile is also a visible phase.
		await runFeatureFinish(
			{ project: { repoPath: "/repo" } } as never,
			feature(),
			deps,
			ui,
		);

		expect(spy.reports[0]).toBe("Checking feature…");
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(inProgress.has("f1")).toBe(false);
	});

	it("releases the in-progress guard via try/finally even on an unexpected exception", async () => {
		const { deps, inProgress } = buildDeps();
		const { ui } = buildUi({
			overrides: { withProgress: () => Promise.reject(new Error("boom")) },
		});

		await expect(
			runFeatureFinish(
				{ project: { repoPath: "/repo" } } as never,
				feature(),
				deps,
				ui,
			),
		).rejects.toThrow("boom");

		// The finally must have run: a later Finish is possible again.
		expect(inProgress.has("f1")).toBe(false);
	});

	it("returns already_in_progress and shows an info message without re-entering", async () => {
		const { deps, inProgress } = buildDeps();
		inProgress.add("f1");
		const info = vi.fn(() => Promise.resolve(undefined));
		const { ui } = buildUi({ overrides: { showInformationMessage: info } });

		const outcome = await runFeatureFinish(
			{ project: { repoPath: "/repo" } } as never,
			feature(),
			deps,
			ui,
		);

		expect(outcome).toEqual({ status: "already_in_progress" });
		expect(info).toHaveBeenCalledWith(
			expect.stringContaining("already being finished"),
		);
	});

	it("surfaces a blocked assessment as an error message and keeps the guard released", async () => {
		const { deps, inProgress } = buildDeps();
		deps.assess = () => ({
			checks: [],
			reasons: ["Integration evidence is unknown."],
			safe: false,
			forceable: false,
			fingerprint: "fp",
			canDeleteBranches: false,
		});
		const errorMessage = vi.fn(() => Promise.resolve(undefined));
		const { ui, spy } = buildUi({
			overrides: { showErrorMessage: errorMessage },
		});
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		});

		const outcome = await runFeatureFinish(
			{ project: { repoPath: "/repo" } } as never,
			feature(),
			deps,
			ui,
		);

		expect(outcome.status).toBe("blocked");
		expect(errorMessage).toHaveBeenCalled();
		expect(spy.reports[0]).toBe("Checking feature…");
		expect(inProgress.has("f1")).toBe(false);
	});

	it("refreshes stale unknown integration evidence before assessing finish", async () => {
		const { deps } = buildDeps();
		const assess = vi.fn(() => ({
			checks: [],
			reasons: [],
			safe: true,
			forceable: true,
			requiresForce: false,
			fingerprint: "fresh",
			canDeleteBranches: false,
		}));
		deps.assess = assess;
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot
			.mockReturnValueOnce({
				integration: {
					status: "unknown",
					reason: "ancestry_unknown",
					evidence: {},
				},
			})
			.mockReturnValueOnce({
				integration: {
					status: "known",
					outcome: "no_feature_commits",
					evidence: {},
				},
			});
		const { ui } = buildUi({ confirmed: "Finish Feature" });
		const ctx = {
			project: { repoPath: "/repo" },
			agentManager: {
				getAgents: () => [{ worktreePath: "/repo/.worktrees/f1-agent" }],
			},
			serviceManager: { getServices: () => [] },
			featureManager: {
				removeFeatureWorktreeForFinish: vi.fn(() => ({
					deleted: true,
					reasons: [],
				})),
				forgetFinishedFeature: vi.fn(),
			},
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, ui);

		expect(outcome.status).toBe("finished");
		expect(deps.featureStateCoordinator.reconcile).toHaveBeenCalledTimes(1);
		expect(assess).toHaveBeenCalledTimes(2);
	});

	it("offers explicit residue removal without forgetting the feature", async () => {
		const { deps } = buildDeps({
			removeWorktreeResidue: vi.fn(() => ({ removed: true })),
		});
		deps.assess = () => ({
			checks: [
				{
					kind: "feature",
					worktreePath: "/repo/.worktrees/f1",
					disposition: "residue",
					safe: false,
					forceable: false,
					requiresForce: false,
					reasons: ["files remain on disk"],
				},
			],
			reasons: ["files remain on disk"],
			safe: false,
			forceable: false,
			fingerprint: "residue",
			canDeleteBranches: false,
		});
		const { ui } = buildUi({ confirmed: "Remove residue" });
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		});
		const forget = vi.fn();
		const ctx = {
			project: { repoPath: "/repo" },
			agentManager: { getAgents: () => [] },
			serviceManager: { getServices: () => [] },
			featureManager: { forgetFinishedFeature: forget },
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, ui);

		expect(outcome.status).toBe("blocked");
		expect(deps.removeWorktreeResidue).toHaveBeenCalledWith(
			"/repo/.worktrees/f1",
		);
		expect(forget).not.toHaveBeenCalled();
	});

	it("proposes the sudo command with terminal and copy actions when residue removal is permission-blocked", async () => {
		const openTerminal = vi.fn();
		const copy = vi.fn(() => Promise.resolve());
		const removeWorktreeResidue = vi.fn(() => ({
			removed: false,
			reason:
				"EACCES: permission denied, denied. The residue contains files owned by another user.",
			suggestedCommand: "sudo rm -rf '/repo/.worktrees/f1'",
		}));
		const { deps } = buildDeps({
			removeWorktreeResidue,
			openTerminalWithCommand: openTerminal,
		});
		deps.assess = () => ({
			checks: [
				{
					kind: "feature",
					worktreePath: "/repo/.worktrees/f1",
					disposition: "residue",
					safe: false,
					forceable: false,
					requiresForce: false,
					reasons: ["files remain on disk"],
				},
			],
			reasons: ["files remain on disk"],
			safe: false,
			forceable: false,
			fingerprint: "residue",
			canDeleteBranches: false,
		});
		const errorMessage = vi.fn(() =>
			Promise.resolve("Run command in terminal"),
		);
		const { ui } = buildUi({
			confirmed: "Remove residue",
			overrides: {
				showErrorMessage: errorMessage,
				copyToClipboard: copy,
			},
		});
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		});
		const forget = vi.fn();
		const ctx = {
			project: { repoPath: "/repo" },
			agentManager: { getAgents: () => [] },
			serviceManager: { getServices: () => [] },
			featureManager: { forgetFinishedFeature: forget },
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, ui);

		expect(outcome.status).toBe("blocked");
		expect(errorMessage).toHaveBeenCalledWith(
			expect.stringContaining("sudo rm -rf '/repo/.worktrees/f1'"),
			"Run command in terminal",
			"Copy command",
		);
		expect(openTerminal).toHaveBeenCalledWith(
			"sudo rm -rf '/repo/.worktrees/f1'",
		);
		expect(copy).not.toHaveBeenCalled();
		expect(errorMessage).toHaveBeenCalledTimes(1);
		expect(forget).not.toHaveBeenCalled();
	});

	it("copies the suggested command when the user picks Copy command", async () => {
		const openTerminal = vi.fn();
		const copy = vi.fn(() => Promise.resolve());
		const { deps } = buildDeps({
			removeWorktreeResidue: vi.fn(() => ({
				removed: false,
				reason: "EACCES: permission denied.",
				suggestedCommand: "sudo rm -rf '/repo/.worktrees/f1'",
			})),
			openTerminalWithCommand: openTerminal,
		});
		deps.assess = () => ({
			checks: [
				{
					kind: "feature",
					worktreePath: "/repo/.worktrees/f1",
					disposition: "residue",
					safe: false,
					forceable: false,
					requiresForce: false,
					reasons: ["files remain on disk"],
				},
			],
			reasons: ["files remain on disk"],
			safe: false,
			forceable: false,
			fingerprint: "residue",
			canDeleteBranches: false,
		});
		const errorMessage = vi.fn(() => Promise.resolve("Copy command"));
		const { ui } = buildUi({
			confirmed: "Remove residue",
			overrides: {
				showErrorMessage: errorMessage,
				copyToClipboard: copy,
			},
		});
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		});
		const ctx = {
			project: { repoPath: "/repo" },
			agentManager: { getAgents: () => [] },
			serviceManager: { getServices: () => [] },
			featureManager: { forgetFinishedFeature: vi.fn() },
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, ui);

		expect(outcome.status).toBe("blocked");
		expect(copy).toHaveBeenCalledWith("sudo rm -rf '/repo/.worktrees/f1'");
		expect(openTerminal).not.toHaveBeenCalled();
		expect(errorMessage).toHaveBeenCalledTimes(1);
	});

	it("cancels cleanly when the user does not confirm and does not touch metadata", async () => {
		const { deps, inProgress } = buildDeps();
		deps.assess = () => ({
			checks: [],
			reasons: [],
			safe: true,
			forceable: true,
			fingerprint: "fp",
			canDeleteBranches: false,
		});
		const { ui } = buildUi({ confirmed: "Cancel" });
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		});
		const forget = vi.fn();
		const ctx = {
			project: { repoPath: "/tmp/clean-repo" },
			agentManager: { getAgents: () => [] },
			serviceManager: { getServices: () => [] },
			featureManager: { forgetFinishedFeature: forget },
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, ui);

		expect(outcome).toEqual({ status: "cancelled" });
		expect(forget).not.toHaveBeenCalled();
		expect(inProgress.has("f1")).toBe(false);
	});

	it("finishes successfully with phase reports and deterministic cleanup", async () => {
		const { deps, inProgress } = buildDeps();
		deps.assess = () => ({
			checks: [
				{
					kind: "feature",
					worktreePath: "/tmp/clean-repo",
					disposition: "registered",
					safe: true,
					forceable: true,
					requiresForce: false,
					reasons: [],
				},
			],
			reasons: [],
			safe: true,
			forceable: true,
			fingerprint: "fp",
			canDeleteBranches: false,
		});
		const { ui, spy } = buildUi({ confirmed: "Finish Feature" });
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "unknown",
				reason: "integration_unknown",
				evidence: {},
			},
		});
		const forget = vi.fn();
		const ctx = {
			project: { repoPath: "/tmp/clean-repo" },
			agentManager: {
				getAgents: () => [],
				removeAgentWorktreeForFinish: vi.fn(),
			},
			serviceManager: { getServices: () => [] },
			featureManager: {
				forgetFinishedFeature: forget,
				removeFeatureWorktreeForFinish: vi.fn(() => ({
					deleted: true,
					reasons: [],
				})),
			},
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, ui);

		expect(outcome).toEqual({ status: "finished" });
		expect(spy.reports).toContain("Checking feature…");
		expect(spy.reports).toContain("Removing worktrees…");
		expect(spy.reports).toContain("Finalizing…");
		expect(ui.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining('Finish feature "f1"?'),
			expect.objectContaining({ modal: true }),
			"Finish Feature",
		);
		expect(forget).toHaveBeenCalledWith("f1");
		expect(deps.projectManager.notifyChange).toHaveBeenCalled();
		expect(deps.sidebarProvider.refresh).toHaveBeenCalled();
		expect(inProgress.has("f1")).toBe(false);
	});

	it("offers branch deletion only when proven safe, and calls it on choice", async () => {
		const { deps } = buildDeps();
		const headSha = "a".repeat(40);
		deps.assess = () => ({
			checks: [
				{
					kind: "feature",
					branch: "feat/f1",
					worktreePath: "/tmp/clean-repo",
					disposition: "registered",
					safe: true,
					forceable: true,
					requiresForce: false,
					acceptedPullRequestHeadSha: headSha,
					reasons: [],
				},
			],
			reasons: [],
			safe: true,
			forceable: true,
			fingerprint: "fp",
			canDeleteBranches: true,
		});
		const { ui } = buildUi({ confirmed: "Finish and delete branches" });
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "known",
				outcome: "integrated_by_pull_request",
				evidence: {},
			},
		});
		const deleteFinishedBranches = vi.fn(() => ({
			deleted: true,
			reasons: [],
		}));
		const forget = vi.fn();
		const ctx = {
			project: { repoPath: "/tmp/clean-repo" },
			agentManager: {
				getAgents: () => [],
				removeAgentWorktreeForFinish: vi.fn(),
			},
			serviceManager: { getServices: () => [] },
			featureManager: {
				forgetFinishedFeature: forget,
				removeFeatureWorktreeForFinish: vi.fn(() => ({
					deleted: true,
					reasons: [],
				})),
				deleteFinishedBranches,
			},
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, ui);

		expect(outcome).toEqual({ status: "finished" });
		expect(ui.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("will be deleted"),
			expect.objectContaining({ modal: true }),
			"Finish and delete branches",
			"Finish Feature",
		);
		expect(deleteFinishedBranches).toHaveBeenCalledWith("f1", {
			branch: "feat/f1",
			acceptedPullRequestHeadSha: headSha,
		});
		expect(forget).toHaveBeenCalledWith("f1");
	});

	it("blocks with records preserved when branch deletion fails", async () => {
		const { deps } = buildDeps();
		const headSha = "b".repeat(40);
		deps.assess = () => ({
			checks: [
				{
					kind: "feature",
					branch: "feat/f1",
					worktreePath: "/tmp/clean-repo",
					disposition: "registered",
					safe: true,
					forceable: true,
					requiresForce: false,
					acceptedPullRequestHeadSha: headSha,
					reasons: [],
				},
			],
			reasons: [],
			safe: true,
			forceable: true,
			fingerprint: "fp",
			canDeleteBranches: true,
		});
		const { ui } = buildUi({ confirmed: "Finish and delete branches" });
		const getSnapshot = deps.featureStateCoordinator.getSnapshot as ReturnType<
			typeof vi.fn
		>;
		getSnapshot.mockReturnValue({
			integration: {
				status: "known",
				outcome: "integrated_by_pull_request",
				evidence: {},
			},
		});
		const errorMessage = vi.fn(() => Promise.resolve(undefined));
		const forget = vi.fn();
		const ctx = {
			project: { repoPath: "/tmp/clean-repo" },
			agentManager: {
				getAgents: () => [],
				removeAgentWorktreeForFinish: vi.fn(),
			},
			serviceManager: { getServices: () => [] },
			featureManager: {
				forgetFinishedFeature: forget,
				removeFeatureWorktreeForFinish: vi.fn(() => ({
					deleted: true,
					reasons: [],
				})),
				deleteFinishedBranches: vi.fn(() => ({
					deleted: false,
					reasons: ["Remote branch origin/feat/f1 was preserved."],
					suggestedCommand: "git push origin --delete feat/f1",
				})),
			},
		} as never;

		const outcome = await runFeatureFinish(ctx, feature(), deps, {
			...ui,
			showErrorMessage: errorMessage,
		} as never);

		expect(outcome.status).toBe("blocked");
		expect(forget).not.toHaveBeenCalled();
		expect(errorMessage).toHaveBeenCalledWith(
			expect.stringContaining("git push origin --delete feat/f1"),
		);
	});
});
