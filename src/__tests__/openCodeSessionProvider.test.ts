import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

// Keep the real child_process but make execFile/execSync observable so we can
// assert the direct SQLite path never shells out when the DB is readable.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(actual.execFile),
		execSync: vi.fn(actual.execSync),
	};
});

import { execFile, execSync } from "node:child_process";
import {
	OpenCodeSessionProvider,
	sessionIdsForDirectory,
	sessionsForDirectory,
} from "../agents/sessionProviders/openCodeSessionProvider";

const mockExecFile = vi.mocked(execFile);
const mockExecSync = vi.mocked(execSync);

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
});

afterEach(() => {
	mockExecFile.mockReset();
	mockExecSync.mockReset();
});

interface SeedOptions {
	title?: string | null;
	directory?: string;
	timeCreated?: number;
	messages?: Array<{
		id: string;
		role: string;
		data: Record<string, unknown>;
		timeCreated?: number;
	}>;
	parts?: Array<{ messageId: string; data: Record<string, unknown>; timeUpdated?: number }>;
}

function makeFixture(sessionId: string, opts: SeedOptions = {}): string {
	const dbPath = path.join(tmpDir, `oc-${sessionId}.db`);
	try {
		fs.rmSync(dbPath);
	} catch {
		// not present yet
	}
	const db = new DatabaseSync(dbPath, { readOnly: false });
	db.exec(`
		CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER);
		CREATE TABLE message(id TEXT, session_id TEXT, role TEXT, data TEXT, time_created INTEGER);
		CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_updated INTEGER);
	`);
	db.prepare(
		"INSERT INTO session(id, title, directory, time_created) VALUES(?,?,?,?)",
	).run(
		sessionId,
		opts.title ?? null,
		opts.directory ?? "/work",
		opts.timeCreated ?? 1000,
	);
	for (const m of opts.messages ?? []) {
		db.prepare(
			"INSERT INTO message(id, session_id, role, data, time_created) VALUES(?,?,?,?,?)",
		).run(
			m.id,
			sessionId,
			m.role,
			JSON.stringify(m.data),
			m.timeCreated ?? 1000,
		);
	}
	for (const p of opts.parts ?? []) {
		db.prepare(
			"INSERT INTO part(id, session_id, message_id, data, time_updated) VALUES(?,?,?,?,?)",
		).run(
			`part-${p.messageId}`,
			sessionId,
			p.messageId,
			JSON.stringify(p.data),
			p.timeUpdated ?? 1000,
		);
	}
	db.close();
	return dbPath;
}

describe("OpenCodeSessionProvider scanSessions", () => {
	it("parses opencode db rows into SessionInfo[]", () => {
		const dbPath = makeFixture("oc-1", {
			title: "Add unit tests",
			directory: "/home/user/project",
			timeCreated: 1709550000000,
		});
		const provider = new OpenCodeSessionProvider({ dbPath });
		const sessions = provider.scanSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toEqual({
			sessionId: "oc-1",
			prompt: "Add unit tests",
			created: new Date(1709550000000).toISOString(),
			projectPath: "/home/user/project",
		});
	});

	it("reads only from SQLite: no opencode db subprocess is spawned", () => {
		const dbPath = makeFixture("oc-nosub", {
			title: "direct read",
			directory: "/work",
		});
		const provider = new OpenCodeSessionProvider({ dbPath });
		provider.scanSessions();
		provider.readName("oc-nosub");
		expect(mockExecSync).not.toHaveBeenCalled();
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it("filters out rows without id", () => {
		const dbPath = makeFixture("oc-1", { title: "Valid" });
		const provider = new OpenCodeSessionProvider({ dbPath });
		// Only one row seeded; sanity that id survives
		expect(provider.scanSessions()[0].sessionId).toBe("oc-1");
	});
});

describe("OpenCodeSessionProvider readName", () => {
	it("returns the session title", () => {
		const dbPath = makeFixture("ses_exact-1", { title: "Exact OpenCode title" });
		const provider = new OpenCodeSessionProvider({ dbPath });
		expect(provider.readName("ses_exact-1")).toBe("Exact OpenCode title");
	});

	it("returns null when a session has no title and no prompt", () => {
		const dbPath = makeFixture("ses_without-title", { title: null });
		const provider = new OpenCodeSessionProvider({ dbPath });
		expect(provider.readName("ses_without-title")).toBeNull();
	});

	it("falls back to the first user prompt when the title is empty", () => {
		const dbPath = makeFixture("ses_prompt", {
			title: "",
			messages: [
				{
					id: "m1",
					role: "user",
					data: { role: "user", parts: [{ text: "Refactor the auth module" }] },
				},
				{
					id: "m2",
					role: "assistant",
					data: { role: "assistant", parts: [{ text: "On it." }] },
				},
			],
		});
		const provider = new OpenCodeSessionProvider({ dbPath });
		expect(provider.readName("ses_prompt")).toBe("Refactor the auth module");
	});
});

describe("OpenCodeSessionProvider hasSession", () => {
	it("is true for an existing session", () => {
		const dbPath = makeFixture("ses_exists");
		const provider = new OpenCodeSessionProvider({ dbPath });
		expect(provider.hasSession("ses_exists")).toBe(true);
		expect(provider.hasSession("ses_missing")).toBe(false);
	});
});

describe("OpenCodeSessionProvider readAttention (regression)", () => {
	const cases: Array<[string, SeedOptions, string, string]> = [
		[
			"waiting_question",
			{
				messages: [{ id: "m1", role: "assistant", data: { role: "assistant" } }],
				parts: [
					{
						messageId: "m1",
						data: { type: "tool", state: { status: "pending" }, tool: "question" },
					},
				],
			},
			"waiting_for_user",
			"opencode.question.waiting",
		],
		[
			"waiting_plan_exit",
			{
				messages: [{ id: "m1", role: "assistant", data: { role: "assistant" } }],
				parts: [
					{
						messageId: "m1",
						data: { type: "tool", state: { status: "running" }, tool: "plan_exit" },
					},
				],
			},
			"waiting_for_user",
			"opencode.plan_exit.waiting",
		],
		[
			"idle",
			{
				messages: [
					{ id: "m1", role: "assistant", data: { role: "assistant", time: { completed: 123 } } },
				],
			},
			"idle",
			"opencode.assistant.completed",
		],
		[
			"failed",
			{
				messages: [
					{ id: "m1", role: "assistant", data: { role: "assistant", error: "boom" } },
				],
			},
			"failed",
			"opencode.assistant.error",
		],
		[
			"working",
			{
				messages: [{ id: "m1", role: "assistant", data: { role: "assistant" } }],
			},
			"working",
			"opencode.assistant.working",
		],
		[
			"user",
			{
				messages: [{ id: "m1", role: "user", data: { role: "user" } }],
			},
			"working",
			"OpenCode has received user input and has not completed a response",
		],
	];

	it.each(cases)(
		"exposes structured %s attention from SQLite",
		(sessionId, seed, status, evidence) => {
			const dbPath = makeFixture(sessionId, seed);
			const provider = new OpenCodeSessionProvider({ dbPath });
			expect(provider.readAttention(sessionId)).toEqual({ status, evidence });
		},
	);

	it("returns null when the session has no messages", () => {
		const dbPath = makeFixture("ses_silent", { title: "silence" });
		const provider = new OpenCodeSessionProvider({ dbPath });
		expect(provider.readAttention("ses_silent")).toBeNull();
	});

	it("reads attention only from SQLite on the async path", async () => {
		const dbPath = makeFixture("ses_async", {
			messages: [
				{ id: "m1", role: "assistant", data: { role: "assistant", time: { completed: 1 } } },
			],
		});
		const provider = new OpenCodeSessionProvider({ dbPath });
		const signal = await provider.readAttentionAsync("ses_async");
		expect(signal).toEqual({ status: "idle", evidence: "opencode.assistant.completed" });
		expect(mockExecSync).not.toHaveBeenCalled();
		expect(mockExecFile).not.toHaveBeenCalled();
	});
});

describe("OpenCodeSessionProvider CLI fallback (SQLite unavailable)", () => {
	it("falls back to `opencode db` when the module is unavailable", () => {
		const dbPath = makeFixture("ses_fb", { title: "Fallback title" });
		mockExecSync.mockReturnValue(
			JSON.stringify([{ title: "Fallback title" }]),
		);
		const provider = new OpenCodeSessionProvider({
			dbPath,
			sqliteOverride: null,
		});
		expect(provider.readName("ses_fb")).toBe("Fallback title");
		expect(mockExecSync).toHaveBeenCalled();
	});

	it("falls back asynchronously too", async () => {
		const dbPath = makeFixture("ses_fb_async", { title: "Async fallback" });
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cb = args[args.length - 1] as (err: unknown, value: unknown) => void;
			cb(null, { stdout: JSON.stringify([{ title: "Async fallback" }]), stderr: "" });
			return {} as never;
		});
		const provider = new OpenCodeSessionProvider({
			dbPath,
			sqliteOverride: null,
		});
		expect(await provider.async.readName("ses_fb_async")).toBe("Async fallback");
		expect(mockExecFile).toHaveBeenCalled();
	});
});

describe("sessionIdsForDirectory", () => {
	it("snapshots the ids of sessions already started in cwd", () => {
		const dbPath = makeFixture("A", {
			title: "pre-existing",
			directory: "/work",
			timeCreated: 1000,
		});
		expect(sessionIdsForDirectory("/work", { dbPath })).toEqual(new Set(["A"]));
	});
});

describe("OpenCode candidate enumeration", () => {
	let multiCounter = 0;
	function makeMulti(sessions: Array<{ id: string; timeCreated: number }>): string {
		const dbPath = path.join(tmpDir, `oc-multi-${++multiCounter}.db`);
		const db = new DatabaseSync(dbPath, { readOnly: false });
		db.exec(
			"CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER);",
		);
		for (const s of sessions) {
			db.prepare(
				"INSERT INTO session(id, title, directory, time_created) VALUES(?,?,?,?)",
			).run(s.id, "", "/work", s.timeCreated);
		}
		db.close();
		return dbPath;
	}

	it("returns candidates without claiming ownership", () => {
		const dbPath = makeMulti([
			{ id: "B", timeCreated: 2000 },
			{ id: "A", timeCreated: 1000 },
		]);
		expect(sessionsForDirectory("/work", new Set(), { dbPath }).map((s) => s.sessionId)).toEqual([
			"B",
			"A",
		]);
	});

	it("never claims a session that existed before the launch (baseline)", () => {
		const dbPath = makeMulti([{ id: "A", timeCreated: 1000 }]);
		const baseline = sessionIdsForDirectory("/work", { dbPath });
		expect(baseline).toEqual(new Set(["A"]));
		expect(sessionsForDirectory("/work", baseline, { dbPath })).toEqual([]);
	});

	it("ignores pre-existing sessions even when they are still the newest", () => {
		const dbPath = makeMulti([
			{ id: "A", timeCreated: 2000 },
			{ id: "B", timeCreated: 1000 },
		]);
		expect(
			sessionsForDirectory("/work", new Set(["A"]), { dbPath }).map((s) => s.sessionId),
		).toEqual(["B"]);
	});
});
