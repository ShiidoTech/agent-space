import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn(() => Promise.resolve()) },
	Uri: { joinPath: vi.fn(() => ({})) },
	ThemeIcon: class {},
	ThemeColor: class {},
}));

import { FeatureSidebarProvider } from "../features/featureSidebarProvider";

describe("FeatureSidebarProvider.handleFocusAgent (issue #69)", () => {
	const feature = {
		id: "f1",
		name: "Feature One",
		branch: "feat/one",
		worktreePath: "/repo/feature-one",
		status: "active",
		color: "terminal.ansiBlue",
		isolation: "shared",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const agent = {
		id: "a1",
		featureId: "f1",
		name: "Agent 1",
		sessionId: "session-1",
		toolId: "claude",
		status: "running",
		createdAt: "2026-03-06T00:00:00Z",
	};

	const getAgents = vi.fn().mockReturnValue([agent]);
	const ctx = { agentManager: { getAgents } };
	const resolveFeature = vi.fn().mockReturnValue({ ctx, feature });

	let postMessage: ReturnType<typeof vi.fn>;
	let getTerminal: ReturnType<typeof vi.fn>;
	let existingShow: ReturnType<typeof vi.fn>;
	let focusOrCreateTerminalAsync: ReturnType<typeof vi.fn>;
	let provider: FeatureSidebarProvider;

	function buildProvider(): FeatureSidebarProvider {
		const p = new FeatureSidebarProvider(
			{ resolveFeature } as never,
			{} as never,
			{} as never,
			undefined,
			{} as never,
		);
		postMessage = vi.fn();
		existingShow = vi.fn();
		getTerminal = vi.fn();
		focusOrCreateTerminalAsync = vi.fn().mockResolvedValue({ show: vi.fn() });

		// biome-ignore lint/suspicious/noExplicitAny: reaching into private fields for a focused unit test
		(p as any)._view = { webview: { postMessage } };
		p.setTerminalController({
			getTerminal,
			focusOrCreateTerminalAsync,
		} as never);
		return p;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		getAgents.mockReturnValue([agent]);
		resolveFeature.mockReturnValue({ ctx, feature });
		provider = buildProvider();
	});

	function focusAgent(agentId = "a1"): void {
		// biome-ignore lint/suspicious/noExplicitAny: invoking the private handler directly
		(provider as any).handleFocusAgent("f1", agentId);
	}

	it("warm path: shows the tracked terminal immediately with no reconciliation call", () => {
		getTerminal.mockReturnValue({ show: existingShow });

		focusAgent();

		expect(existingShow).toHaveBeenCalledTimes(1);
		expect(focusOrCreateTerminalAsync).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "focused",
		});
	});

	it("cold path: posts an immediate opening state and reconciles asynchronously", async () => {
		getTerminal.mockReturnValue(undefined);

		focusAgent();

		// The opening state must be posted synchronously, before the async
		// reconciliation promise has any chance to resolve.
		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "opening",
		});
		expect(focusOrCreateTerminalAsync).toHaveBeenCalledWith(
			feature,
			agent,
			0,
			true,
		);

		await Promise.resolve();
		await Promise.resolve();

		expect(postMessage).toHaveBeenCalledWith({
			type: "agentFocusState",
			agentId: "a1",
			state: "focused",
		});
	});

	it("does nothing when the agent no longer exists", () => {
		getAgents.mockReturnValue([]);

		focusAgent("missing-agent");

		expect(postMessage).not.toHaveBeenCalled();
		expect(focusOrCreateTerminalAsync).not.toHaveBeenCalled();
	});
});
