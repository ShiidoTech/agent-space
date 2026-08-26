import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

import {
	type FallbackEventKind,
	resetFallbackReporting,
	resetOpenCodeDbPathCache,
	resolveOpenCodeDbPath,
	type SqliteModule,
	SqliteReadOnlyDb,
	setFallbackReporter,
} from "../agents/sessionProviders/sqliteRead";

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqliteread-test-"));
});

afterEach(() => {
	resetFallbackReporting();
	resetOpenCodeDbPathCache();
	vi.useRealTimers();
	for (const name of fs.readdirSync(tmpDir)) {
		try {
			fs.rmSync(path.join(tmpDir, name));
		} catch {
			// best-effort cleanup
		}
	}
});

describe("SqliteReadOnlyDb opening contract", () => {
	it("opens read-only and enforces PRAGMA query_only", () => {
		const execCalls: string[] = [];
		const ctorArgs: Array<{ opts: unknown }> = [];
		class RecordingDb {
			constructor(_p: string, opts: unknown) {
				ctorArgs.push({ opts });
			}
			exec(sql: string) {
				execCalls.push(sql);
			}
			prepare() {
				return { all: () => [] };
			}
			close() {}
		}
		const override = { DatabaseSync: RecordingDb as never } as SqliteModule;
		const dbPath = path.join(tmpDir, "recording.db");
		fs.writeFileSync(dbPath, "");
		const db = new SqliteReadOnlyDb(dbPath, undefined, override);
		db.querySync("SELECT 1");
		expect(ctorArgs[0].opts).toEqual({ readOnly: true });
		expect(execCalls).toContain("PRAGMA query_only = ON");
	});

	it("reopens transparently after an initial failure (non-sticky)", () => {
		const dbPath = path.join(tmpDir, "late.db");
		const db = new SqliteReadOnlyDb(dbPath);
		// File does not exist yet: empty result, no throw.
		expect(db.querySync("SELECT v FROM t")).toEqual([]);

		const writer = new DatabaseSync(dbPath);
		writer.exec("CREATE TABLE t(v TEXT)");
		writer.prepare("INSERT INTO t(v) VALUES('recovered')").run();
		writer.close();

		expect(db.querySync("SELECT v FROM t")).toEqual([
			expect.objectContaining({ v: "recovered" }),
		]);
	});
});

describe("CLI parameter rendering", () => {
	it("escapes single quotes for the argument-vector CLI path", () => {
		const seen: string[] = [];
		const cli = {
			execSync: (sql: string) => {
				seen.push(sql);
				return [];
			},
			execAsync: async () => [],
		};
		const db = new SqliteReadOnlyDb("/tmp/none.db", cli, null);
		db.querySync("SELECT id FROM session WHERE id = ?", ["ses_quo'te"]);
		expect(seen).toEqual(["SELECT id FROM session WHERE id = 'ses_quo''te'"]);
	});

	it("renders numeric parameters without quotes", async () => {
		const seen: string[] = [];
		const cli = {
			execSync: (sql: string) => {
				seen.push(sql);
				return [];
			},
			execAsync: async () => [],
		};
		const db = new SqliteReadOnlyDb("/tmp/none.db", cli, null);
		db.querySync("SELECT * FROM t LIMIT ?", [5]);
		expect(seen).toEqual(["SELECT * FROM t LIMIT 5"]);
	});
});

describe("Fallback observability", () => {
	it("reports query_failed when both db and cli are absent", () => {
		const events: FallbackEventKind[] = [];
		setFallbackReporter((k) => events.push(k));
		const db = new SqliteReadOnlyDb("/tmp/nonexistent-fallback.db");
		db.querySync("SELECT 1");
		expect(events).toContain("query_failed");
	});

	it("reports query_failed when sqlite fails but cli succeeds", () => {
		const events: FallbackEventKind[] = [];
		setFallbackReporter((k) => events.push(k));
		const cli = {
			execSync: () => [{ ok: true }],
			execAsync: async () => [{ ok: true }],
		};
		// dbPath is undefined → open() returns null, sqlite fails.
		// cli succeeds → rows returned, but sqliteFailed is true.
		const db = new SqliteReadOnlyDb(undefined, cli);
		const rows = db.querySync("SELECT 1");
		expect(rows).toEqual([{ ok: true }]);
		expect(events).toContain("query_failed");
	});

	it("reports query_failed when sqlite query throws but cli succeeds", () => {
		const events: FallbackEventKind[] = [];
		setFallbackReporter((k) => events.push(k));
		const cli = {
			execSync: () => [{ recovered: true }],
			execAsync: async () => [{ recovered: true }],
		};
		class BrokenDb {
			prepare() {
				return {
					all() {
						throw new Error("sqlite corrupted");
					},
				};
			}
			exec() {}
			close() {}
		}
		const override = { DatabaseSync: BrokenDb as never } as SqliteModule;
		const dbPath = path.join(tmpDir, "broken.db");
		fs.writeFileSync(dbPath, "");
		const db = new SqliteReadOnlyDb(dbPath, cli, override);
		const rows = db.querySync("SELECT 1");
		expect(rows).toEqual([{ recovered: true }]);
		expect(events).toContain("query_failed");
	});

	it("fires each event kind at most once (one-shot)", () => {
		const events: FallbackEventKind[] = [];
		setFallbackReporter((k) => events.push(k));
		const db = new SqliteReadOnlyDb("/tmp/nonexistent-once.db");
		db.querySync("SELECT 1");
		db.querySync("SELECT 2");
		const queryFails = events.filter((k) => k === "query_failed");
		expect(queryFails).toHaveLength(1);
	});
});

describe("resolveOpenCodeDbPath retry TTL", () => {
	it("returns undefined immediately on failure and caches for 60s", () => {
		vi.useFakeTimers();
		const mockExec = vi.fn(() => {
			throw new Error("opencode not found");
		});

		// First call: fails, caches the failure.
		const result1 = resolveOpenCodeDbPath(mockExec as never);
		expect(result1).toBeUndefined();
		expect(mockExec).toHaveBeenCalledTimes(1);

		// Second call within TTL: returns cached failure, no re-exec.
		const result2 = resolveOpenCodeDbPath(mockExec as never);
		expect(result2).toBeUndefined();
		expect(mockExec).toHaveBeenCalledTimes(1);

		// Advance past TTL: retries.
		vi.advanceTimersByTime(60_001);
		const result3 = resolveOpenCodeDbPath(mockExec as never);
		expect(result3).toBeUndefined();
		expect(mockExec).toHaveBeenCalledTimes(2);
	});

	it("returns resolved path on success and never retries", () => {
		const mockExec = vi
			.fn()
			.mockReturnValue("/home/user/.local/share/opencode/opencode.db\n");

		const result1 = resolveOpenCodeDbPath(mockExec as never);
		expect(result1).toBe("/home/user/.local/share/opencode/opencode.db");

		// Second call: returns cached success.
		const result2 = resolveOpenCodeDbPath(mockExec as never);
		expect(result2).toBe("/home/user/.local/share/opencode/opencode.db");
		expect(mockExec).toHaveBeenCalledTimes(1);
	});

	it("recovers after TTL window expires", () => {
		vi.useFakeTimers();
		const mockExec = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("not found");
			})
			.mockReturnValueOnce("/tmp/opencode.db");

		// First attempt: fails.
		expect(resolveOpenCodeDbPath(mockExec as never)).toBeUndefined();

		// Within TTL: still returns cached failure.
		vi.advanceTimersByTime(30_000);
		expect(resolveOpenCodeDbPath(mockExec as never)).toBeUndefined();
		expect(mockExec).toHaveBeenCalledTimes(1);

		// After TTL: retries and succeeds.
		vi.advanceTimersByTime(30_001);
		const result = resolveOpenCodeDbPath(mockExec as never);
		expect(result).toBe("/tmp/opencode.db");
		expect(mockExec).toHaveBeenCalledTimes(2);
	});
});
