import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	deriveHermesTerminalId,
	type HermesPaneTtyResolver,
	HermesSessionProvider,
} from "../agents/sessionProviders/hermesSessionProvider";

/**
 * PR3/6 — Hermes exact identity + native events (issue #120).
 *
 * Agent Space launches each Hermes agent inside its own dedicated tmux session
 * (`agent-space-<feature>-<agent>`), and Hermes drops one per-terminal breadcrumb
 * under `$HERMES_HOME/terminal-sessions/<terminal-id>` keyed by the pane's tty
 * device path. These tests prove Agent Space derives the SAME deterministic
 * terminal id from its own pane and binds exactly — no newest-session, cwd,
 * order or count heuristic — and that it binds nothing rather than bind wrongly
 * when ownership is not demonstrable.
 */

const tmpDirs: string[] = [];

function tmpHome(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface HermesSessionRow {
	id: string;
	title: string;
	cwd: string;
	endedAt?: number | null;
	endReason?: string | null;
}

/** Real `sessions` schema shape (superset of Agent Space's minimal contract). */
function makeStateDb(home: string, sessions: HermesSessionRow[]): void {
	const db = new DatabaseSync(path.join(home, "state.db"), { readOnly: false });
	db.exec(`
		CREATE TABLE sessions(
			id TEXT PRIMARY KEY,
			title TEXT,
			cwd TEXT,
			source TEXT,
			ended_at REAL,
			end_reason TEXT,
			last_activity_at REAL,
			last_activity_description TEXT
		)
	`);
	for (const s of sessions) {
		db.prepare(
			"INSERT INTO sessions(id, title, cwd, source, ended_at, end_reason) VALUES(?,?,?,?,?,?)",
		).run(s.id, s.title, s.cwd, "cli", s.endedAt ?? null, s.endReason ?? null);
	}
	db.close();
}

/** A stub pane-resolver mapping a tmux session name to a fixed pty path. */
function panes(map: Record<string, string>): HermesPaneTtyResolver {
	return {
		getPaneTty: (sessionName) => map[sessionName] ?? null,
		getPaneTtyAsync: async (sessionName) => map[sessionName] ?? null,
	};
}

const WORKTREE = "/tmp/agent-space-wt/feat-x";

describe("Hermes exact identity — correlateOwnedSession", () => {
	it("#1 exact breadcrumb proof maps this pane to the correct session", () => {
		const home = tmpHome("hermes-id-");
		makeStateDb(home, [{ id: "her_a", title: "A", cwd: WORKTREE }]);
		makeBreadcrumb(home, "tty-dev-pts-5", "her_a", WORKTREE);
		const provider = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-a": "/dev/pts/5" }),
		);
		expect(
			provider.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).toBe("her_a");
	});

	it("#2 two agents in the same worktree never cross-bind", () => {
		const home = tmpHome("hermes-two-");
		makeStateDb(home, [
			{ id: "her_a", title: "A", cwd: WORKTREE },
			{ id: "her_b", title: "B", cwd: WORKTREE },
		]);
		makeBreadcrumb(home, "tty-dev-pts-5", "her_a", WORKTREE);
		makeBreadcrumb(home, "tty-dev-pts-6", "her_b", WORKTREE);

		// Two distinct panes => two distinct deterministic terminal ids.
		expect(deriveHermesTerminalId("/dev/pts/5")).not.toBe(
			deriveHermesTerminalId("/dev/pts/6"),
		);

		// Each agent reads its own pane tty, so each resolves only its own
		// session — the correlation is per-terminal; there is no order/cwd to
		// confuse, even when the sibling's session is already in the known set.
		const agentA = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-a": "/dev/pts/5" }),
		);
		const agentB = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-b": "/dev/pts/6" }),
		);
		expect(
			agentA.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(["her_b"]),
				tmuxSession: "agent-space-base-a",
			}),
		).toBe("her_a");
		expect(
			agentB.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(["her_a"]),
				tmuxSession: "agent-space-base-b",
			}),
		).toBe("her_b");
	});

	it("#3 creation order carries no weight — no temporal heuristic", () => {
		const home = tmpHome("hermes-order-");
		// B was created BEFORE A (reversed order); A's breadcrumb is older too.
		makeStateDb(home, [
			{ id: "her_b", title: "B", cwd: WORKTREE },
			{ id: "her_a", title: "A", cwd: WORKTREE },
		]);
		makeBreadcrumb(home, "tty-dev-pts-5", "her_a", WORKTREE, 1000);
		makeBreadcrumb(home, "tty-dev-pts-6", "her_b", WORKTREE, 999_999);
		const agentA = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-a": "/dev/pts/5" }),
		);
		// A still owns her_a purely from its own pane id; never "newest wins".
		expect(
			agentA.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).toBe("her_a");
	});

	it("#4 absence of exact proof -> unresolved, nothing is adopted", () => {
		const home = tmpHome("hermes-none-");
		makeStateDb(home, [{ id: "her_a", title: "A", cwd: WORKTREE }]);
		// The pane has no breadcrumb (never started, or pane unreadable).
		const provider = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-a": "/dev/pts/5" }),
		);
		expect(
			provider.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).toBeUndefined();
	});

	it("#5 reload/restart re-derives the same identity for the same pane", () => {
		const home = tmpHome("hermes-reload-");
		makeStateDb(home, [{ id: "her_a", title: "A", cwd: WORKTREE }]);
		makeBreadcrumb(home, "tty-dev-pts-5", "her_a", WORKTREE);
		const paneA = panes({ "agent-space-base-a": "/dev/pts/5" });

		const before = new HermesSessionProvider(home, paneA);
		const first = before.correlateOwnedSession({
			cwd: WORKTREE,
			knownSessionIds: new Set(),
			tmuxSession: "agent-space-base-a",
		});
		// A fresh provider (fresh Extension Host), same home, same pane tty.
		const after = new HermesSessionProvider(home, paneA);
		expect(
			after.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).toBe(first);
	});

	it("#6 a deleted session is never adopted from a stale breadcrumb", () => {
		const home = tmpHome("hermes-stale-");
		// A readable store that does NOT contain the crumb's session.
		makeStateDb(home, [{ id: "her_other", title: "other", cwd: WORKTREE }]);
		makeBreadcrumb(home, "tty-dev-pts-5", "her_gone", WORKTREE);
		const provider = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-a": "/dev/pts/5" }),
		);
		expect(
			provider.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).toBeUndefined();
	});

	it("root — prefers not to bind rather than bind an already-owned session", () => {
		const home = tmpHome("hermes-own-");
		makeStateDb(home, [{ id: "her_a", title: "A", cwd: WORKTREE }]);
		makeBreadcrumb(home, "tty-dev-pts-5", "her_a", WORKTREE);
		const provider = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-a": "/dev/pts/5" }),
		);
		// her_a is already attributed to another agent. Agent Space must not
		// steal it; it returns undefined, leaving this agent unresolved.
		expect(
			provider.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(["her_a"]),
				tmuxSession: "agent-space-base-a",
			}),
		).toBeUndefined();
	});

	it("#6 profile is read from the agent's persisted home, never the active one", () => {
		const homeA = tmpHome("hermes-profA-");
		const homeB = tmpHome("hermes-profB-");
		makeStateDb(homeA, [{ id: "her_a", title: "A", cwd: WORKTREE }]);
		makeStateDb(homeB, [{ id: "her_b", title: "B", cwd: WORKTREE }]);
		makeBreadcrumb(homeA, "tty-dev-pts-5", "her_a", WORKTREE);
		makeBreadcrumb(homeB, "tty-dev-pts-5", "her_b", WORKTREE);
		const paneA = panes({ "agent-space-base-a": "/dev/pts/5" });
		// Same underlying pane, two different persisted homes (profiles).
		const profileA = new HermesSessionProvider(homeA, paneA);
		const profileB = new HermesSessionProvider(homeB, paneA);
		expect(
			profileA.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).toBe("her_a");
		expect(
			profileB.correlateOwnedSession({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).toBe("her_b");
	});

	it("async correlation (binder periodic path) resolves the same exact session", async () => {
		const home = tmpHome("hermes-async-");
		makeStateDb(home, [{ id: "her_a", title: "A", cwd: WORKTREE }]);
		makeBreadcrumb(home, "tty-dev-pts-7", "her_a", WORKTREE);
		const provider = new HermesSessionProvider(
			home,
			panes({ "agent-space-base-a": "/dev/pts/7" }),
		);
		await expect(
			provider.async.correlateOwnedSession?.({
				cwd: WORKTREE,
				knownSessionIds: new Set(),
				tmuxSession: "agent-space-base-a",
			}),
		).resolves.toBe("her_a");
	});
});

describe("Hermes native attention — honest, never invented", () => {
	it("#10 a native failure end_reason maps to `failed`", () => {
		const home = tmpHome("hermes-fail-");
		makeStateDb(home, [
			{
				id: "her_ok",
				title: "ok",
				cwd: WORKTREE,
				endedAt: null,
				endReason: null,
			},
			{
				id: "her_err",
				title: "err",
				cwd: WORKTREE,
				endedAt: 1700000100,
				endReason: "error",
			},
		]);
		const provider = new HermesSessionProvider(home, panes({}));
		expect(provider.getAttentionSignal("her_err")).toEqual({
			status: "failed",
			evidence: "Hermes session ended (error)",
		});
		// An active session is never reported failed.
		expect(provider.getAttentionSignal("her_ok")).toBeUndefined();
	});

	it("#7/#9 Hermes does not invent working, idle or needs-you for an active session", () => {
		const home = tmpHome("hermes-honest-");
		// Active, healthy session: no end, no failure.
		makeStateDb(home, [{ id: "her_live", title: "live", cwd: WORKTREE }]);
		const provider = new HermesSessionProvider(home, panes({}));
		// Hermes persists no authoritative per-turn phase, so no signal is
		// fabricated: no working, no idle/turn_completed, no needs-you. The
		// resolver reads this as unknown/unsupported, never as a finished turn.
		expect(provider.getAttentionSignal("her_live")).toBeUndefined();
	});

	it("#8 a clean tmux exit alone can never produce a Hermes turn_completed", () => {
		const home = tmpHome("hermes-exit-");
		makeStateDb(home, [{ id: "her_live", title: "live", cwd: WORKTREE }]);
		const provider = new HermesSessionProvider(home, panes({}));
		// Hermes emits no `idle` provider signal at all (and does not advertise
		// attention.idle). A pane exiting cleanly is a `tmux`-source observation,
		// which the PR2 detector refuses to convert into turn_completed — so
		// Hermes never fabricates a finished turn from a dead pane or exit 0.
		expect(provider.getAttentionSignal("her_live")).toBeUndefined();
	});
});

/** Helper reused above: write a breadcrumb mapping a terminal id to a session. */
function makeBreadcrumb(
	home: string,
	terminalId: string,
	sessionId: string,
	cwd: string,
	ts = 1700000000,
): void {
	const dir = path.join(home, "terminal-sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, terminalId),
		JSON.stringify({ session_id: sessionId, cwd, ts }),
	);
}
