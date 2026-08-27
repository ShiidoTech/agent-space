import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(actual.execFile),
		execFileSync: vi.fn(actual.execFileSync),
	};
});

vi.mock("../utils/platform", () => ({
	commandExists: vi.fn().mockReturnValue(true),
}));

import { CodingToolRegistry } from "../agents/codingToolRegistry";
import { resolveHermesHome } from "../agents/hermesProfileResolver";
import type { Agent } from "../types";

/**
 * Real isolation test: two Hermes homes (two distinct profiles) that both
 * contain the *same* sessionId but with different titles and cwd. Proves that
 * a Hermes agent's adapter reads only its own profile's store — hasSession,
 * readName and scanSessions never leak across profiles, even for a shared id.
 *
 * HERMES_HOME is pointed at a temp root so every profile home is a real,
 * on-disk directory the adapters genuinely read.
 */
describe("Hermes profile isolation", () => {
	const originalEnv = { ...process.env };
	const roots: string[] = [];

	function makeRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-root-"));
		roots.push(root);
		return root;
	}

	function makeStateDb(
		home: string,
		sessions: Array<{ id: string; title: string; cwd?: string }>,
	): void {
		fs.mkdirSync(home, { recursive: true });
		const db = new DatabaseSync(path.join(home, "state.db"), {
			readOnly: false,
		});
		db.exec(
			"CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT)",
		);
		for (const s of sessions) {
			db.prepare(
				"INSERT INTO sessions(id, title, cwd, source) VALUES(?,?,?,?)",
			).run(s.id, s.title, s.cwd ?? "/work", "cli");
		}
		db.close();
	}

	function makeBreadcrumb(home: string, sessionId: string, cwd: string): void {
		const dir = path.join(home, "terminal-sessions");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `tmux-${sessionId}`),
			JSON.stringify({ session_id: sessionId, cwd, ts: 1700000000 }),
		);
	}

	afterEach(() => {
		process.env = { ...originalEnv };
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	function hermesAgent(overrides: Partial<Agent> = {}): Agent {
		return {
			id: "agent-1",
			featureId: "feat-1",
			name: "Agent 1",
			sessionId: null,
			status: "stopped",
			createdAt: new Date().toISOString(),
			toolId: "hermes",
			...overrides,
		};
	}

	it("adapter hasSession is isolated per profile for a shared sessionId", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;

		const homeA = resolveHermesHome("profile-a");
		const homeB = resolveHermesHome("profile-b");
		makeStateDb(homeA, [{ id: "shared-id", title: "Title A" }]);
		makeStateDb(homeB, [{ id: "shared-id", title: "Title B" }]);
		makeBreadcrumb(homeA, "shared-id", "/worktree/a");
		makeBreadcrumb(homeB, "shared-id", "/worktree/b");

		const registry = new CodingToolRegistry();
		const adapterA = registry.getSessionAdapterForAgent(
			hermesAgent({ hermesProfile: "profile-a" }),
		);
		const adapterB = registry.getSessionAdapterForAgent(
			hermesAgent({ hermesProfile: "profile-b" }),
		);

		expect(adapterA?.toolId).toBe("hermes");
		expect(adapterB?.toolId).toBe("hermes");
		expect(adapterA).not.toBe(adapterB);

		// Both profiles own the same id, so both answer true — but each only
		// because *its own* store has the session.
		expect(adapterA?.hasSession?.("shared-id")).toBe(true);
		expect(adapterB?.hasSession?.("shared-id")).toBe(true);

		// An id that exists in neither profile is not reported by either.
		expect(adapterA?.hasSession?.("ghost-id")).toBe(false);
		expect(adapterB?.hasSession?.("ghost-id")).toBe(false);
	});

	it("adapter readName returns each profile's own title for a shared sessionId", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;

		const homeA = resolveHermesHome("profile-a");
		const homeB = resolveHermesHome("profile-b");
		makeStateDb(homeA, [{ id: "shared-id", title: "Title A" }]);
		makeStateDb(homeB, [{ id: "shared-id", title: "Title B" }]);
		makeBreadcrumb(homeA, "shared-id", "/worktree/a");
		makeBreadcrumb(homeB, "shared-id", "/worktree/b");

		const registry = new CodingToolRegistry();
		const adapterA = registry.getSessionAdapterForAgent(
			hermesAgent({ hermesProfile: "profile-a" }),
		);
		const adapterB = registry.getSessionAdapterForAgent(
			hermesAgent({ hermesProfile: "profile-b" }),
		);

		expect(adapterA?.readName("shared-id")).toBe("Title A");
		expect(adapterB?.readName("shared-id")).toBe("Title B");
	});

	it("adapter scanSessions only surfaces its own profile's sessions", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;

		const homeA = resolveHermesHome("profile-a");
		const homeB = resolveHermesHome("profile-b");
		makeStateDb(homeA, [{ id: "shared-id", title: "Title A" }]);
		makeStateDb(homeB, [
			{ id: "shared-id", title: "Title B" },
			{ id: "only-b", title: "Only B" },
		]);
		makeBreadcrumb(homeA, "shared-id", "/worktree/a");
		makeBreadcrumb(homeB, "shared-id", "/worktree/b");
		makeBreadcrumb(homeB, "only-b", "/worktree/b2");

		const registry = new CodingToolRegistry();
		const adapterA = registry.getSessionAdapterForAgent(
			hermesAgent({ hermesProfile: "profile-a" }),
		);
		const adapterB = registry.getSessionAdapterForAgent(
			hermesAgent({ hermesProfile: "profile-b" }),
		);

		const sessionsA = adapterA?.scanSessions?.() ?? [];
		const sessionsB = adapterB?.scanSessions?.() ?? [];

		const idsA = sessionsA.map((s) => s.sessionId);
		const idsB = sessionsB.map((s) => s.sessionId);

		// A only sees its own shared-id (from its own store), not B's "only-b".
		expect(idsA).toEqual(["shared-id"]);
		expect(idsB.sort()).toEqual(["only-b", "shared-id"]);

		// The cwd recorded in each profile's breadcrumb is preserved, proving
		// each adapter read from a different directory.
		const byId = (list: typeof sessionsA) =>
			new Map(list.map((s) => [s.sessionId, s.projectPath]));
		expect(byId(sessionsA).get("shared-id")).toBe("/worktree/a");
		expect(byId(sessionsB).get("shared-id")).toBe("/worktree/b");
	});

	it("launch and resume commands target each profile explicitly", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;

		const registry = new CodingToolRegistry();
		const agentA = hermesAgent({ hermesProfile: "profile-a" });
		const agentB = hermesAgent({
			hermesProfile: "profile-b",
			sessionId: "sess-9",
		});

		const toolA = registry.resolveAgentToolForAgent(agentA);
		const toolB = registry.resolveAgentToolForAgent(agentB);

		expect(registry.buildLaunchCommand(toolA)).toBe("hermes -p profile-a");
		expect(registry.buildStrictResumeLaunchCommand(toolB, "sess-9")).toBe(
			"hermes -p profile-b --resume sess-9 --no-restore-cwd",
		);
	});

	it("explicit default profile maps to the base home and still uses -p default", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;

		// The default profile is the root itself — never profiles/default.
		expect(resolveHermesHome("default")).toBe(root);

		// Persisting an explicit "default" profile means the agent is still
		// launched with an explicit -p flag, so a later `hermes profile use`
		// cannot silently change its runtime.
		const registry = new CodingToolRegistry();
		const agent = hermesAgent({ hermesProfile: "default" });
		const tool = registry.resolveAgentToolForAgent(agent);
		expect(registry.buildLaunchCommand(tool)).toBe("hermes -p default");
		expect(registry.buildStrictResumeLaunchCommand(tool, "sess-1")).toBe(
			"hermes -p default --resume sess-1 --no-restore-cwd",
		);
	});
});
