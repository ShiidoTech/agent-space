import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSessionProvider } from "../agents/sessionProviders/claudeSessionProvider";
import { CodexSessionProvider } from "../agents/sessionProviders/codexSessionProvider";

/**
 * Fixtures written against the shape real provider stores actually have, not
 * the shape the adapters were originally written against.
 *
 * Every defect these cover passed the existing synthetic tests: the transcripts
 * used there had no bookkeeping events, Claude profiles always had a
 * `sessions-index.json`, and Codex `session_meta` carried a `created` field
 * that the real format does not have. The suite was green while nothing worked.
 */

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function writeJsonl(filePath: string, events: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
	);
}

describe("Claude transcripts as they are actually written", () => {
	const sessionId = "fc0a282e-c462-437f-b04e-60dbde2035d2";
	const cwd = "/home/dev/project/.worktrees/feat-36";

	/**
	 * Mirrors the interleaving observed in a real 438 KB transcript: 12 event
	 * types, of which only `user` and `assistant` are conversational.
	 */
	function realisticTranscript(): unknown[] {
		return [
			{ type: "mode", sessionId, mode: "default" },
			{ type: "permission-mode", sessionId, permissionMode: "auto" },
			{
				type: "user",
				sessionId,
				cwd,
				timestamp: "2026-08-08T20:59:09.496Z",
				gitBranch: "feat/36",
			},
			{ type: "attachment", sessionId },
			{
				type: "assistant",
				sessionId,
				timestamp: "2026-08-08T20:59:20.000Z",
				message: { content: [], stop_reason: "tool_use" },
			},
			{ type: "file-history-snapshot", sessionId },
			{ type: "queue-operation", sessionId },
			{ type: "pr-link", sessionId },
			{
				type: "ai-title",
				sessionId,
				aiTitle: "Review and harden GitHub PR #36",
			},
			{ type: "attachment", sessionId },
			{ type: "system", sessionId },
			{ type: "system", sessionId },
		];
	}

	it("keeps the last conversational signal instead of being erased by bookkeeping", () => {
		const projectsDir = tempDir("claude-real-");
		writeJsonl(
			path.join(projectsDir, "-home-dev-project", `${sessionId}.jsonl`),
			realisticTranscript(),
		);

		const signal = new ClaudeSessionProvider(projectsDir).readAttention(
			sessionId,
		);

		// The transcript ends on `attachment, system, system`. Discarding the
		// signal on those left every live Claude agent with no evidence at all.
		expect(signal?.status).toBe("working");
		expect(signal?.evidence).toBe("claude.assistant.tool_use");
		expect(signal?.observedAt).toBe("2026-08-08T20:59:20.000Z");
	});

	it("discovers sessions in a profile that has no sessions-index.json", () => {
		// A CLAUDE_CONFIG_DIR profile (for example a `claude-perso` wrapper) can
		// have no index at all. Index-only discovery reported zero sessions while
		// the transcripts sat right there.
		const projectsDir = tempDir("claude-noindex-");
		writeJsonl(
			path.join(projectsDir, "-home-dev-project", `${sessionId}.jsonl`),
			realisticTranscript(),
		);

		const sessions = new ClaudeSessionProvider(projectsDir).scanSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(sessionId);
		// The directory name is a lossy encoding of the path, so the cwd has to
		// come from the events themselves for a worktree comparison to work.
		expect(sessions[0].projectPath).toBe(cwd);
		expect(sessions[0].created).toBe("2026-08-08T20:59:09.496Z");
	});

	it("reports a session it holds and one it does not", () => {
		const projectsDir = tempDir("claude-has-");
		writeJsonl(
			path.join(projectsDir, "-home-dev-project", `${sessionId}.jsonl`),
			realisticTranscript(),
		);
		const provider = new ClaudeSessionProvider(projectsDir);

		expect(provider.hasSession(sessionId)).toBe(true);
		expect(provider.hasSession("f6d89e21-9bde-4654-b585-5b413829efc7")).toBe(
			false,
		);
	});

	it("reads the title a real transcript records as an ai-title event", () => {
		const projectsDir = tempDir("claude-title-");
		writeJsonl(
			path.join(projectsDir, "-home-dev-project", `${sessionId}.jsonl`),
			realisticTranscript(),
		);

		expect(new ClaudeSessionProvider(projectsDir).readName(sessionId)).toBe(
			"Review and harden GitHub PR #36",
		);
	});
});

describe("Codex rollouts as they are actually written", () => {
	function rollout(sessionId: string, startedAt: string, cwd: string) {
		return {
			timestamp: "2026-08-09T08:18:25.322Z",
			ordinal: 0,
			type: "session_meta",
			payload: {
				session_id: sessionId,
				id: sessionId,
				// The real payload timestamps the session start here. There is no
				// `created` field; reading one left every session with an empty date.
				timestamp: startedAt,
				cwd,
				originator: "codex-tui",
			},
		};
	}

	it("dates a session from payload.timestamp", () => {
		const sessionsDir = tempDir("codex-real-");
		const id = "019fe599-e4b9-7821-b6f8-be61c517958d";
		writeJsonl(
			path.join(sessionsDir, "2026", "08", "09", `rollout-${id}.jsonl`),
			[rollout(id, "2026-08-09T08:18:15.875Z", "/home/dev/project")],
		);

		const sessions = new CodexSessionProvider(sessionsDir).scanSessions();

		expect(sessions[0].created).toBe("2026-08-09T08:18:15.875Z");
	});

	it("picks the newest session when two agents share a worktree", () => {
		// With an empty `created` on every entry the "newest first" sort was a
		// no-op, so the winner was whatever the directory walk happened to yield.
		const sessionsDir = tempDir("codex-order-");
		const cwd = "/home/dev/project/.worktrees/feat-synchro";
		const older = "019fe599-e4b9-7821-b6f8-be61c517958d";
		const newer = "019fe599-e9a7-7071-a517-bcf97dd25bf6";
		writeJsonl(
			path.join(sessionsDir, "2026", "08", "09", `rollout-a-${older}.jsonl`),
			[rollout(older, "2026-08-09T08:18:15.875Z", cwd)],
		);
		writeJsonl(
			path.join(sessionsDir, "2026", "08", "09", `rollout-b-${newer}.jsonl`),
			[rollout(newer, "2026-08-09T08:18:17.145Z", cwd)],
		);

		const provider = new CodexSessionProvider(sessionsDir);
		const chosen = provider.discoverSessionId(cwd, new Set([older]));

		expect(chosen).toBe(newer);
	});
});

/**
 * Opt-in replay against a transcript this machine really produced.
 *
 * Real transcripts belong to the developer and are never committed, so this is
 * skipped unless a path is supplied:
 *
 *   AGENT_SPACE_REAL_CLAUDE_TRANSCRIPT=~/.claude/projects/<dir>/<id>.jsonl \
 *     npx vitest run realProviderShapes
 *
 * It is the one check the synthetic suite cannot make: that the reader survives
 * whatever event types the installed CLI version is writing today.
 */
const realTranscript = process.env.AGENT_SPACE_REAL_CLAUDE_TRANSCRIPT;
describe.skipIf(!realTranscript)("real Claude transcript replay", () => {
	it("produces a signal instead of nothing", () => {
		const filePath = path.resolve(realTranscript as string);
		const projectsDir = path.dirname(path.dirname(filePath));
		const sessionId = path.basename(filePath, ".jsonl");

		const provider = new ClaudeSessionProvider(projectsDir);
		const signal = provider.readAttention(sessionId);

		expect(
			signal,
			"no attention signal derived from a real transcript",
		).toBeDefined();
		expect(["working", "idle", "waiting_for_user", "failed"]).toContain(
			signal?.status,
		);
		expect(provider.hasSession(sessionId)).toBe(true);
	});
});
