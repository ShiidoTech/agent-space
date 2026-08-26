/**
 * Smoke test for real provider session stores.
 *
 * Disabled by default: run with AGENTSPACE_SMOKE=1 npm run smoke:test
 *
 * Validates the actual OpenCode / Hermes / Codex stores present on the
 * developer machine against the schema contract Agent Space depends on.
 * No real prompt content is ever logged — only structural assertions.
 *
 * When the DB is readable, the SQLite path is used directly: zero subprocess
 * is spawned.  The CLI fallback is only a compatibility net for unreadable DBs.
 */
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const SMOKE = process.env.AGENTSPACE_SMOKE === "1";

function skipUnless(condition: boolean, label: string) {
	if (!condition) return it.skip(`${label} — store not present`, () => {});
}

function dbExists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

describe.skipIf(!SMOKE)("session-stores smoke", () => {
	it("AGENTSPACE_SMOKE gate is active", () => {
		expect(SMOKE).toBe(true);
	});

	describe("OpenCode", () => {
		const canonicalDbPath =
			process.env.OPENCODE_DB_PATH ||
			`${process.env.HOME}/.local/share/opencode/opencode.db`;

		skipUnless(dbExists(canonicalDbPath), "OpenCode store");

		it("schema has expected tables and columns", async () => {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(canonicalDbPath, { readOnly: true });

			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all()
				.map((r: { name: string }) => r.name);
			expect(tables).toContain("session");
			expect(tables).toContain("message");
			expect(tables).toContain("part");

			const msgCols = db
				.prepare("PRAGMA table_info(message)")
				.all()
				.map((c: { name: string }) => c.name);
			expect(msgCols).toContain("session_id");
			expect(msgCols).toContain("data");
			// Must NOT have a top-level 'role' column — role is in data JSON.
			expect(msgCols).not.toContain("role");

			const partCols = db
				.prepare("PRAGMA table_info(part)")
				.all()
				.map((c: { name: string }) => c.name);
			expect(partCols).toContain("message_id");
			expect(partCols).toContain("data");

			db.close();
		});

		it("readName resolves real sessions with zero subprocess", async () => {
			const spy = vi.spyOn(childProcess, "execFileSync");

			const { OpenCodeSessionProvider } = await import(
				"../src/agents/sessionProviders/openCodeSessionProvider"
			);
			const provider = new OpenCodeSessionProvider({ dbPath: canonicalDbPath });

			const sessions = provider.scanSessions();
			expect(sessions.length).toBeGreaterThan(0);

			const firstId = sessions[0].sessionId;
			const name = provider.readName(firstId);
			// readName must return a string (title or first prompt) or null.
			// If non-null, the SQLite path worked; null means no title/prompt.
			if (name !== null) {
				expect(typeof name).toBe("string");
				expect(name.length).toBeGreaterThan(0);
			}

			// DB is readable => no subprocess was spawned.
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		});
	});

	describe("Hermes", () => {
		const dbPath =
			process.env.HERMES_DB_PATH ||
			`${process.env.HOME}/.hermes/state.db`;

		skipUnless(dbExists(dbPath), "Hermes store");

		it("schema has sessions table", async () => {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath, { readOnly: true });

			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all()
				.map((r: { name: string }) => r.name);
			expect(tables).toContain("sessions");

			const cols = db
				.prepare("PRAGMA table_info(sessions)")
				.all()
				.map((c: { name: string }) => c.name);
			expect(cols).toContain("id");
			expect(cols).toContain("title");

			db.close();
		});

		it("readName resolves real sessions", async () => {
			const { HermesSessionProvider } = await import(
				"../src/agents/sessionProviders/hermesSessionProvider"
			);
			// HERMES_DB_PATH points to the .db file; constructor expects the home dir.
			const hermesHome =
				process.env.HERMES_HOME ??
				(process.env.HERMES_DB_PATH
					? require("node:path").dirname(process.env.HERMES_DB_PATH)
					: undefined);
			const provider = new HermesSessionProvider(hermesHome);

			const sessions = provider.scanSessions();
			if (sessions.length === 0) {
				provider.dispose();
				return; // no sessions to test
			}

			const firstId = sessions[0].sessionId;
			const name = provider.readName(firstId);
			expect(typeof name === "string" || name === null).toBe(true);
			provider.dispose();
		});
	});

	describe("Codex", () => {
		const indexPath =
			process.env.CODEX_INDEX_PATH ||
			`${process.env.HOME}/.codex/session_index.jsonl`;

		skipUnless(dbExists(indexPath), "Codex store");

		it("readName resolves real sessions", async () => {
			const { CodexSessionProvider } = await import(
				"../src/agents/sessionProviders/codexSessionProvider"
			);
			const provider = new CodexSessionProvider(undefined, indexPath);

			const sessions = provider.scanSessions();
			if (sessions.length === 0) {
				return; // empty store
			}

			const firstId = sessions[0].sessionId;
			const name = provider.readName(firstId);
			// Codex may return null if no title is set — that's valid.
			expect(typeof name === "string" || name === null).toBe(true);
		});
	});
});
