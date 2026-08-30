import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/agentManager";
import { TmuxIntegration } from "../agents/tmux";
import {
	diffSubprocessCounts,
	resetSubprocessCounts,
	snapshotSubprocessCounts,
} from "../diagnostics/subprocessCounter";
import { FeatureStateCoordinator } from "../features/featureStateCoordinator";
import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import { ServiceManager } from "../services/serviceManager";
import { Store } from "../storage/store";
import type { Feature, Service } from "../types";
import { _setExecFileAsyncForTest } from "../utils/platform";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

/**
 * Contractual regression for the P0 zero-I/O UI mandate: a `reconcilePresence`
 * tick must issue exactly ONE tmux subprocess no matter how many agents or
 * services it observes — not one per agent, not one per service. This test
 * wires up the REAL AgentManager/ServiceManager/TmuxIntegration (only the
 * lowest-level `execFile` seam is replaced, so `platform.ts`'s own
 * `recordSubprocessCall` bookkeeping still runs) so an accidental
 * reintroduction of a per-item tmux probe fails here, not just in a mocked
 * unit test that hides the call count.
 */
describe("reconcilePresence subprocess contract (real AgentManager/ServiceManager/TmuxIntegration)", () => {
	let tmpDir: string;
	let store: Store;
	let tmux: TmuxIntegration;
	let agentManager: AgentManager;
	let serviceManager: ServiceManager;
	let feature: Feature;
	let execFileAsyncCalls: Array<{ file: string; args: readonly string[] }>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-contract-"));
		store = new Store(tmpDir);
		tmux = new TmuxIntegration();
		agentManager = new AgentManager(
			store,
			tmpDir,
			path.join(tmpDir, ".worktrees"),
			tmux,
		);
		serviceManager = new ServiceManager(store, tmpDir, tmux);

		feature = {
			id: "f1",
			name: "auth",
			branch: "feat/auth",
			worktreePath: path.join(tmpDir, ".worktrees", "auth"),
			status: "active",
			color: "terminal.ansiBlue",
			isolation: "shared",
			createdAt: "2026-03-04T00:00:00Z",
		};
		store.saveFeatures([feature]);

		execFileAsyncCalls = [];
		_setExecFileAsyncForTest(async (file: string, args: readonly string[]) => {
			execFileAsyncCalls.push({ file, args });
			return { stdout: "", stderr: "" };
		});
		resetSubprocessCounts();
	});

	afterEach(() => {
		_setExecFileAsyncForTest(undefined);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeContext(): ProjectContext {
		return {
			project: { id: "p1", name: "p1", repoPath: tmpDir },
			store,
			featureManager: {
				getBaseFeature: () => ({ ...feature, id: "base:p1" }),
				getBaseBranchName: () => "main",
				getFeatures: vi.fn(() => [feature]),
				listFeaturesCached: vi.fn(() => [feature]),
				getOrphanedFeatures: vi.fn(() => []),
				getWorktreeBase: () => path.join(tmpDir, ".worktrees"),
			},
			featureGitInspector: {
				inspect: vi.fn(),
				isCommitAncestor: vi.fn(),
				countCommitsAfter: vi.fn(),
				observeProject: vi.fn(),
			},
			gitClient: { read: vi.fn() },
			config: { baseBranch: "main" },
			agentManager,
			serviceManager,
		} as unknown as ProjectContext;
	}

	function makeManager(ctx: ProjectContext): ProjectManager {
		return {
			getAllContexts: vi.fn(() => [ctx]),
			getContext: vi.fn(() => ctx),
			observeTmuxSessions: vi.fn(() => ({
				status: "known" as const,
				sessions: [] as string[],
			})),
			observeTmuxPanesAsync: vi.fn(() => tmux.observePanesAsync()),
			agentTmuxSessionName: vi.fn(
				(_featureId: string, _agentId: string, persisted?: string) => persisted,
			),
			findContextByFeatureId: vi.fn(() => ctx),
			resolveFeature: vi.fn(() => undefined),
		} as unknown as ProjectManager;
	}

	it("issues exactly one tmux subprocess for 10 agents + 5 services in a single reconcilePresence tick", async () => {
		for (let i = 0; i < 10; i++) {
			const agent = agentManager.createAgent(feature, "generic");
			agentManager.markAgentStarted(agent.id, feature.id);
		}

		const services: Service[] = Array.from({ length: 5 }, (_, i) => {
			const id = `svc-${i}`;
			return {
				id,
				featureId: feature.id,
				name: `service-${i}`,
				command: "npm run dev",
				// Must already match TmuxIntegration's canonical naming so
				// ServiceManager's cold-load session-migration check (a legacy
				// legacy-name adoption path, unrelated to this contract) is a
				// no-op and doesn't add its own sync tmux calls.
				tmuxSession: tmux.serviceSessionName(feature.id, id),
				status: "running",
				createdAt: "2026-03-04T00:00:00Z",
			};
		});
		store.saveServices(feature.id, services);

		const ctx = makeContext();
		const coordinator = new FeatureStateCoordinator(makeManager(ctx));
		const before = snapshotSubprocessCounts();

		await coordinator.reconcilePresence();
		// Attention commit from AgentAttentionMonitor is out of scope for this
		// tick (it runs on its own cadence) — refreshObservationCache is
		// fire-and-forget here, so flush microtasks before asserting.
		await new Promise((resolve) => setImmediate(resolve));

		const delta = diffSubprocessCounts(before, snapshotSubprocessCounts());
		expect(delta.tmux).toBe(1);
		expect(execFileAsyncCalls).toHaveLength(1);
		expect(execFileAsyncCalls[0]).toMatchObject({ file: "tmux" });

		coordinator.dispose();
	});
});
