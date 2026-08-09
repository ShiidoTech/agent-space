import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

import { BUILTIN_PROVIDERS } from "../agents/codingToolRegistry";
import { resolveAttention } from "../agents/providers/attentionResolver";
import {
	OpenCodeSessionProvider,
	sessionIdsForDirectory,
	sessionsForDirectory,
} from "../agents/sessionProviders/openCodeSessionProvider";

// Mock child_process.execSync since we can't run `opencode` in CI
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
	mockExecSync.mockReset();
});

describe("OpenCodeSessionProvider", () => {
	it.each([
		["question", "waiting_for_user", "opencode.question.waiting"],
		["plan_exit", "waiting_for_user", "opencode.plan_exit.waiting"],
		["working", "working", "opencode.assistant.working"],
		["idle", "idle", "opencode.assistant.completed"],
		["failed", "failed", "opencode.assistant.error"],
	])(
		"exposes structured %s attention through the builtin provider",
		(tool, status, evidence) => {
			const message =
				status === "idle"
					? { role: "assistant", time: { completed: 123 } }
					: status === "failed"
						? { role: "assistant", error: "failed" }
						: status === "working"
							? { role: "assistant" }
							: { role: "assistant" };
			mockExecSync.mockReturnValue(
				JSON.stringify([
					{
						message_data: JSON.stringify(message),
						gate_data:
							status === "waiting_for_user"
								? JSON.stringify({ tool, state: { status: "pending" } })
								: null,
					},
				]),
			);

			const provider = BUILTIN_PROVIDERS.find((p) => p.id === "opencode");
			if (!provider) throw new Error("builtin OpenCode provider missing");
			expect(resolveAttention(provider, "oc-bound")).toEqual({
				status,
				evidence,
			});
		},
	);
	it("parses opencode db output into SessionInfo[]", () => {
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{
					id: "oc-1",
					title: "Add unit tests",
					directory: "/home/user/project",
					time_created: 1709550000000,
				},
				{
					id: "oc-2",
					title: "Fix CSS layout",
					directory: "/home/user/other-project",
					time_created: 1709553600000,
				},
			]),
		);

		const provider = new OpenCodeSessionProvider();
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toEqual({
			sessionId: "oc-1",
			prompt: "Add unit tests",
			created: new Date(1709550000000).toISOString(),
			projectPath: "/home/user/project",
		});
		expect(sessions[1]).toEqual({
			sessionId: "oc-2",
			prompt: "Fix CSS layout",
			created: new Date(1709553600000).toISOString(),
			projectPath: "/home/user/other-project",
		});
	});

	it("returns empty array when opencode CLI is not available", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("command not found: opencode");
		});

		const provider = new OpenCodeSessionProvider();
		expect(provider.scanSessions()).toEqual([]);
	});

	it("returns empty array for non-array JSON response", () => {
		mockExecSync.mockReturnValue(JSON.stringify({ error: "no sessions" }));

		const provider = new OpenCodeSessionProvider();
		expect(provider.scanSessions()).toEqual([]);
	});

	it("filters out rows without id", () => {
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{ id: "oc-1", title: "Valid", directory: "/tmp", time_created: 1000 },
				{ id: "", title: "No ID", directory: "/tmp", time_created: 2000 },
				{ title: "Missing ID", directory: "/tmp", time_created: 3000 },
			]),
		);

		const provider = new OpenCodeSessionProvider();
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("oc-1");
	});

	it("handles missing optional fields gracefully", () => {
		mockExecSync.mockReturnValue(JSON.stringify([{ id: "oc-sparse" }]));

		const provider = new OpenCodeSessionProvider();
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toEqual({
			sessionId: "oc-sparse",
			prompt: "",
			created: "",
			projectPath: "",
		});
	});

	it("calls opencode with the right command", () => {
		mockExecSync.mockReturnValue("[]");

		const provider = new OpenCodeSessionProvider();
		provider.scanSessions();

		expect(mockExecSync).toHaveBeenCalledWith(
			'opencode db "SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC LIMIT 200" --format json',
			expect.objectContaining({
				encoding: "utf-8",
				timeout: 5000,
			}),
		);
	});

	it("has toolId opencode", () => {
		const provider = new OpenCodeSessionProvider();
		expect(provider.toolId).toBe("opencode");
	});

	it("reads a session title by its exact id", () => {
		mockExecSync.mockReturnValue(
			JSON.stringify([{ title: "Exact OpenCode title" }]),
		);

		const provider = new OpenCodeSessionProvider();
		expect(provider.readName("ses_exact-1")).toBe("Exact OpenCode title");
		expect(mockExecSync).toHaveBeenCalledWith(
			"opencode db \"SELECT title FROM session WHERE id = 'ses_exact-1'\" --format json",
			expect.objectContaining({ timeout: 5000 }),
		);
	});

	it("returns null when a session has no title", () => {
		mockExecSync.mockReturnValue(JSON.stringify([{ title: null }]));
		expect(
			new OpenCodeSessionProvider().readName("ses_without-title"),
		).toBeNull();
	});
});

describe("sessionIdsForDirectory", () => {
	it("snapshots the ids of sessions already started in cwd", () => {
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{
					id: "A",
					title: "pre-existing",
					directory: "/work",
					time_created: 1000,
				},
				{
					id: "B",
					title: "other dir",
					directory: "/elsewhere",
					time_created: 2000,
				},
			]),
		);
		expect(sessionIdsForDirectory("/work")).toEqual(new Set(["A"]));
	});

	it("returns an empty set when opencode is unavailable", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("command not found: opencode");
		});
		expect(sessionIdsForDirectory("/work")).toEqual(new Set());
	});
});

describe("OpenCode candidate enumeration", () => {
	it("returns candidates without claiming ownership", () => {
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{ id: "B", title: "", directory: "/work", time_created: 2000 },
				{ id: "A", title: "", directory: "/work", time_created: 1000 },
			]),
		);
		expect(sessionsForDirectory("/work").map((s) => s.sessionId)).toEqual([
			"B",
			"A",
		]);
	});

	it("never claims a session that existed before the launch (baseline)", () => {
		// Before launch: only session A exists in the worktree.
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{ id: "A", title: "", directory: "/work", time_created: 1000 },
			]),
		);
		const baseline = sessionIdsForDirectory("/work");
		expect(baseline).toEqual(new Set(["A"]));

		// Before the new session appears, there are no candidates.
		expect(sessionsForDirectory("/work", baseline)).toEqual([]);

		// After launch, session B appears: the agent must receive B, never A.
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{ id: "B", title: "", directory: "/work", time_created: 2000 },
				{ id: "A", title: "", directory: "/work", time_created: 1000 },
			]),
		);
		expect(
			sessionsForDirectory("/work", baseline).map((s) => s.sessionId),
		).toEqual(["B"]);
	});

	it("ignores pre-existing sessions even when they are still the newest", () => {
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{ id: "A", title: "", directory: "/work", time_created: 2000 },
				{ id: "B", title: "", directory: "/work", time_created: 1000 },
			]),
		);
		// A is the newest session, but it predates the launch and must not win.
		expect(
			sessionsForDirectory("/work", new Set(["A"])).map((s) => s.sessionId),
		).toEqual(["B"]);
	});

	it("does not reserve a candidate for a later caller", () => {
		mockExecSync.mockReturnValue(
			JSON.stringify([
				{ id: "B", title: "", directory: "/work", time_created: 2000 },
				{ id: "A", title: "", directory: "/work", time_created: 1000 },
			]),
		);
		const baseline = new Set(["A"]);

		expect(
			sessionsForDirectory("/work", baseline).map((s) => s.sessionId),
		).toEqual(["B"]);
		expect(
			sessionsForDirectory("/work", baseline).map((s) => s.sessionId),
		).toEqual(["B"]);
	});
});
