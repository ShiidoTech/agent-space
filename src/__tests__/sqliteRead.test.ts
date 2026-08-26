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
