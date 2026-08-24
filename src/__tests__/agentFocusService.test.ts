import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFocusObserver } from "../agents/agentFocusService";
import { AgentFocusService } from "../agents/agentFocusService";
import type { Agent, Feature } from "../types";

describe("AgentFocusService (behavioral contract)", () => {
	const feature: Feature = {
		id: "f1",
		name: "Feature One",
		branch: "feat/one",
		worktreePath: "/repo/feature-one",
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const agentA: Agent = {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: "session-1",
		toolId: "claude",
		status: "running",
		createdAt: "2026-03-06T00:00:00Z",
	};
	const agentB = { ...agentA, id: "a2", name: "Agent 2" };

	let agents: Agent[];
	const getAgents = vi.fn(() => agents);
	const getAgentsReadModel = vi.fn(() => agents);
	const ctx = {
		agentManager: { getAgents, getAgentsReadModel },
	} as never;
	const resolveFeature = vi.fn(() => ({ ctx, feature }));

	let getTerminal: ReturnType<typeof vi.fn>;
	let focusOrCreateTerminalAsync: ReturnType<typeof vi.fn>;

	function buildService(
		controller?: Record<string, unknown> | null,
	): AgentFocusService {
		return new AgentFocusService({
			getTerminalController: () =>
				(controller === null
					? undefined
					: (controller ??
						({ getTerminal, focusOrCreateTerminalAsync } as never))) as never,
			resolveFeature: resolveFeature as never,
		});
	}

	function track(
		states: string[],
		settled: number[] = [],
	): AgentFocusObserver {
		return {
			onState: (state) => states.push(state),
			onSettled: () => settled.push(1),
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		agents = [agentA, agentB];
		getAgents.mockImplementation(() => agents);
		getAgentsReadModel.mockImplementation(() => agents);
		resolveFeature.mockReturnValue({ ctx, feature });
		getTerminal = vi.fn();
		focusOrCreateTerminalAsync = vi.fn().mockResolvedValue({ show: vi.fn() });
	});

	it("warm path: reveals the tracked terminal with zero reconciliation and emits focused once", () => {
		const show = vi.fn();
		getTerminal.mockReturnValue({ show });
		const states: string[] = [];
		const settled: number[] = [];

		buildService().requestFocus("f1", "a1", track(states, settled));

		expect(show).toHaveBeenCalledTimes(1);
		expect(focusOrCreateTerminalAsync).not.toHaveBeenCalled();
		expect(states).toEqual(["focused"]);
		expect(settled).toEqual([]);
	});

	it("warm path: never resolves the feature or lists agents (zero exec guarantee)", () => {
		getTerminal.mockReturnValue({ show: vi.fn() });

		buildService().requestFocus("f1", "a1");

		expect(resolveFeature).not.toHaveBeenCalled();
		expect(getAgentsReadModel).not.toHaveBeenCalled();
		expect(getAgents).not.toHaveBeenCalled();
	});

	it("cold path: emits opening synchronously, then focused with a single settle", async () => {
		getTerminal.mockReturnValue(undefined);
		const states: string[] = [];
		const settled: number[] = [];

		buildService().requestFocus("f1", "a1", track(states, settled));

		expect(states).toEqual(["opening"]);
		expect(focusOrCreateTerminalAsync).toHaveBeenCalledWith(
			feature,
			agentA,
			0,
			true,
		);

		await Promise.resolve();
		await Promise.resolve();

		expect(states).toEqual(["opening", "focused"]);
		expect(settled.length).toBe(1);
	});

	it("cold path: emits failed when reconciliation returns no terminal", async () => {
		getTerminal.mockReturnValue(undefined);
		focusOrCreateTerminalAsync.mockResolvedValue(undefined);
		const states: string[] = [];

		buildService().requestFocus("f1", "a1", track(states));

		await Promise.resolve();
		await Promise.resolve();

		expect(states).toEqual(["opening", "failed"]);
	});

	it("cold path: folds controller rejection into failed without throwing", async () => {
		getTerminal.mockReturnValue(undefined);
		focusOrCreateTerminalAsync.mockRejectedValue(new Error("boom"));
		const states: string[] = [];
		const settled: number[] = [];
		vi.spyOn(console, "warn").mockImplementation(() => {});

		buildService().requestFocus("f1", "a1", track(states, settled));

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(states).toEqual(["opening", "failed"]);
		expect(settled.length).toBe(1);
	});

	it("cross-consumer arbitration: A cold then B warm — B wins, A claims nothing but still settles", async () => {
		getTerminal.mockImplementation((id: string) =>
			id === "a2" ? { show: vi.fn() } : undefined,
		);
		let resolveA!: (terminal: unknown) => void;
		focusOrCreateTerminalAsync.mockReturnValue(
			new Promise((resolve) => {
				resolveA = resolve;
			}),
		);

		const service = buildService();
		const statesA: string[] = [];
		const settledA: number[] = [];
		const statesB: string[] = [];
		service.requestFocus("f1", "a1", track(statesA, settledA));
		service.requestFocus("f1", "a2", track(statesB));

		expect(statesB).toEqual(["focused"]);

		resolveA({ show: vi.fn() });
		await Promise.resolve();
		await Promise.resolve();

		expect(statesA).toEqual(["opening"]);
		expect(settledA.length).toBe(1);
	});

	it("double cold click on one in-flight reconciliation: only the latest request reveals", async () => {
		getTerminal.mockReturnValue(undefined);
		const terminalShow = vi.fn();
		let resolveA!: (terminal: unknown) => void;
		focusOrCreateTerminalAsync.mockReturnValue(
			new Promise((resolve) => {
				resolveA = resolve;
			}),
		);

		const service = buildService();
		const states1: string[] = [];
		const states2: string[] = [];
		service.requestFocus("f1", "a1", track(states1));
		service.requestFocus("f1", "a1", track(states2));
		expect(focusOrCreateTerminalAsync).toHaveBeenCalledTimes(2);

		resolveA({ show: terminalShow });
		await Promise.resolve();
		await Promise.resolve();

		expect(states1).toEqual(["opening"]);
		expect(states2).toEqual(["opening", "focused"]);
		expect(terminalShow).toHaveBeenCalledTimes(1);
	});

	it("unknown feature or agent is a silent no-op", () => {
		resolveFeature.mockReturnValue(undefined as never);
		const states: string[] = [];

		buildService().requestFocus("nope", "a1", track(states));

		resolveFeature.mockReturnValue({ ctx, feature });
		agents = [];
		buildService().requestFocus("f1", "ghost", track(states));

		// Only the cheap tracked-terminal lookup runs before validation; no
		// reconciliation is ever started for an unknown feature/agent.
		expect(focusOrCreateTerminalAsync).not.toHaveBeenCalled();
		expect(states).toEqual([]);
	});

	it("missing terminal controller is a silent no-op", () => {
		const states: string[] = [];
		buildService(null).requestFocus("f1", "a1", track(states));
		expect(resolveFeature).not.toHaveBeenCalled();
		expect(states).toEqual([]);
	});

	it("cold path: prefers the non-probing read model when available, falls back to probing getAgents", () => {
		getTerminal.mockReturnValue(undefined);

		buildService().requestFocus("f1", "a1");

		expect(getAgentsReadModel).toHaveBeenCalledWith("f1");
		expect(getAgents).not.toHaveBeenCalled();

		const ctxWithoutReadModel = {
			agentManager: { getAgents },
		} as never;
		resolveFeature.mockReturnValue({
			ctx: ctxWithoutReadModel,
			feature,
		});
		buildService().requestFocus("f1", "a1");

		expect(getAgents).toHaveBeenCalledWith(feature.id);
	});
});
