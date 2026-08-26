import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(actual.execFile),
		execFileSync: vi.fn(actual.execFileSync),
	};
});

import { execFile, execFileSync } from "node:child_process";
import { HermesSessionProvider } from "../agents/sessionProviders/hermesSessionProvider";

const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-test-"));
});

afterEach(() => {
	mockExecFile.mockReset();
	mockExecFileSync.mockReset();
});

function makeStateDb(home: string, sessions: Array<{ id: string; title: string }>): void {
	const dbPath = path.join(home, "state.db");
	const db = new DatabaseSync(dbPath, { readOnly: false });
	db.exec(
		"CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT)",
	);
	for (const s of sessions) {
		db.prepare("INSERT INTO sessions(id, title, cwd, source) VALUES(?,?,?,?)").run(
			s.id,
			s.title,
			"/work",
			"cli",
		);
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

describe("HermesSessionProvider readName", () => {
	it("reads the title directly from state.db", () => {
		const home = path.join(tmpDir, "direct");
		fs.mkdirSync(home, { recursive: true });
		makeStateDb(home, [{ id: "her-1", title: "Hermes real title" }]);
		makeBreadcrumb(home, "her-1", "/work");

		const provider = new HermesSessionProvider(home);
		expect(provider.readName("her-1")).toBe("Hermes real title");
		// No subprocess when the DB is readable.
		expect(mockExecFileSync).not.toHaveBeenCalled();
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it("falls back to `hermes sessions export` when the DB is unavailable", () => {
		const home = path.join(tmpDir, "fallback");
		fs.mkdirSync(home, { recursive: true });
		makeBreadcrumb(home, "her-fb", "/work");
		mockExecFileSync.mockReturnValue(
			JSON.stringify({ id: "her-fb", title: "Exported title" }),
		);

		const provider = new HermesSessionProvider(home);
		expect(provider.readName("her-fb")).toBe("Exported title");
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"hermes",
			["sessions", "export", "--session-id", "her-fb", "--format", "jsonl", "-"],
			expect.anything(),
		);
	});

	it("returns null when neither the DB nor the export yields a title", () => {
		const home = path.join(tmpDir, "empty");
		fs.mkdirSync(home, { recursive: true });
		makeBreadcrumb(home, "her-none", "/work");
		mockExecFileSync.mockReturnValue("{}");

		const provider = new HermesSessionProvider(home);
		expect(provider.readName("her-none")).toBeNull();
	});

	it("exposes the title on the async path without spawning the CLI", async () => {
		const home = path.join(tmpDir, "async");
		fs.mkdirSync(home, { recursive: true });
		makeStateDb(home, [{ id: "her-a", title: "Async hermes title" }]);
		makeBreadcrumb(home, "her-a", "/work");

		const provider = new HermesSessionProvider(home);
		expect(
			await (provider.async.readName as (id: string) => Promise<string | null>)("her-a"),
		).toBe("Async hermes title");
		expect(mockExecFile).not.toHaveBeenCalled();
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});

	it("falls back asynchronously too", async () => {
		const home = path.join(tmpDir, "async-fb");
		fs.mkdirSync(home, { recursive: true });
		makeBreadcrumb(home, "her-afb", "/work");
		mockExecFile.mockImplementation((...args: unknown[]) => {
			const cb = args[args.length - 1] as (err: unknown, value: unknown) => void;
			cb(null, {
				stdout: JSON.stringify({ id: "her-afb", title: "Async exported title" }),
				stderr: "",
			});
			return {} as never;
		});

		const provider = new HermesSessionProvider(home);
		expect(
			await (provider.async.readName as (id: string) => Promise<string | null>)("her-afb"),
		).toBe("Async exported title");
		expect(mockExecFile).toHaveBeenCalled();
	});
});
