import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotSessionProvider } from "../agents/sessionProviders/copilotSessionProvider";

describe("CopilotSessionProvider", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(filename: string, lines: string[]) {
		fs.writeFileSync(path.join(tmpDir, filename), lines.join("\n"));
	}

	it("parses session.start and user.message events", () => {
		writeJsonl("abc-123.jsonl", [
			JSON.stringify({
				type: "session.start",
				sessionId: "sess-abc",
				startTime: "2026-03-04T10:00:00.000Z",
			}),
			JSON.stringify({
				type: "user.message",
				data: {
					content:
						"## TASK\nImplement dark mode\n## CONSTRAINTS\nUse CSS variables",
				},
			}),
		]);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("sess-abc");
		expect(sessions[0].prompt).toBe("Implement dark mode");
		expect(sessions[0].created).toBe("2026-03-04T10:00:00.000Z");
		expect(sessions[0].projectPath).toBe("");
	});

	it("extracts task title from ## TASK block", () => {
		writeJsonl("task-extract.jsonl", [
			JSON.stringify({
				type: "session.start",
				sessionId: "sess-task",
				startTime: "2026-03-04T10:00:00.000Z",
			}),
			JSON.stringify({
				type: "user.message",
				data: {
					content:
						"## TASK\nAdd error handling to API endpoints\n## CONSTRAINTS\nFollow REST conventions",
				},
			}),
		]);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions[0].prompt).toBe("Add error handling to API endpoints");
	});

	it("falls back to first line when no ## TASK block", () => {
		writeJsonl("no-task.jsonl", [
			JSON.stringify({
				type: "session.start",
				sessionId: "sess-plain",
				startTime: "2026-03-04T10:00:00.000Z",
			}),
			JSON.stringify({
				type: "user.message",
				data: { content: "Fix the login page CSS" },
			}),
		]);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions[0].prompt).toBe("Fix the login page CSS");
	});

	it("uses nested data.sessionId and data.startTime", () => {
		writeJsonl("nested.jsonl", [
			JSON.stringify({
				type: "session.start",
				data: {
					sessionId: "sess-nested",
					startTime: "2026-03-04T12:00:00.000Z",
				},
			}),
			JSON.stringify({
				type: "user.message",
				data: { content: "Refactor database layer" },
			}),
		]);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions[0].sessionId).toBe("sess-nested");
		expect(sessions[0].created).toBe("2026-03-04T12:00:00.000Z");
	});

	it("handles multiple session files", () => {
		writeJsonl("session-a.jsonl", [
			JSON.stringify({
				type: "session.start",
				sessionId: "sess-a",
				startTime: "2026-03-04T10:00:00.000Z",
			}),
			JSON.stringify({
				type: "user.message",
				data: { content: "Task A" },
			}),
		]);

		writeJsonl("session-b.jsonl", [
			JSON.stringify({
				type: "session.start",
				sessionId: "sess-b",
				startTime: "2026-03-04T11:00:00.000Z",
			}),
			JSON.stringify({
				type: "user.message",
				data: { content: "Task B" },
			}),
		]);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(2);
		const ids = sessions.map((s) => s.sessionId).sort();
		expect(ids).toEqual(["sess-a", "sess-b"]);
	});

	it("skips non-jsonl files", () => {
		fs.writeFileSync(path.join(tmpDir, "readme.txt"), "not a session");
		writeJsonl("valid.jsonl", [
			JSON.stringify({
				type: "session.start",
				sessionId: "sess-valid",
				startTime: "2026-03-04T10:00:00.000Z",
			}),
		]);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("sess-valid");
	});

	it("returns empty array when directory does not exist", () => {
		const provider = new CopilotSessionProvider("/nonexistent/path");
		expect(provider.scanSessions()).toEqual([]);
	});

	it("skips files without session.start event", () => {
		writeJsonl("no-start.jsonl", [
			JSON.stringify({
				type: "user.message",
				data: { content: "Hello" },
			}),
		]);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(0);
	});

	it("has toolId copilot", () => {
		const provider = new CopilotSessionProvider(tmpDir);
		expect(provider.toolId).toBe("copilot");
	});
});

describe("CopilotSessionProvider directory layout (real store)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-dir-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeSessionDir(
		sessionId: string,
		options: {
			cwd?: string;
			summary?: string;
			createdAt?: string;
			prompt?: string;
			startTime?: string;
		} = {},
	) {
		const dir = path.join(tmpDir, sessionId);
		fs.mkdirSync(dir, { recursive: true });
		const lines = [
			JSON.stringify({
				id: "e1",
				parentId: null,
				timestamp: options.startTime ?? "2026-03-04T10:00:00.000Z",
				type: "session.start",
				data: {
					sessionId,
					startTime: options.startTime ?? "2026-03-04T10:00:00.000Z",
				},
			}),
		];
		if (options.prompt !== undefined) {
			lines.push(
				JSON.stringify({
					id: "e2",
					parentId: "e1",
					timestamp: options.startTime ?? "2026-03-04T10:00:01.000Z",
					type: "user.message",
					data: { content: options.prompt },
				}),
			);
		}
		fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n"));
		const yaml = [
			`id: ${sessionId}`,
			`cwd: ${options.cwd ?? "/repo/worktree"}`,
			`summary: ${options.summary ?? ""}`,
			`summary_count: 0`,
			`created_at: ${options.createdAt ?? options.startTime ?? "2026-03-04T10:00:00.000Z"}`,
			`updated_at: ${options.createdAt ?? options.startTime ?? "2026-03-04T10:00:00.000Z"}`,
		].join("\n");
		fs.writeFileSync(path.join(dir, "workspace.yaml"), yaml);
	}

	it("reads cwd, summary and prompt from the directory layout", () => {
		writeSessionDir("sess-dir-1", {
			cwd: "/repo/worktree",
			summary: "Review Code Changes",
			prompt: "## TASK\nImplement dark mode\n## CONSTRAINTS\nUse CSS variables",
		});

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: "sess-dir-1",
			prompt: "Implement dark mode",
			projectPath: "/repo/worktree",
		});
		expect(provider.readName("sess-dir-1")).toBe("Review Code Changes");
		expect(provider.hasSession("sess-dir-1")).toBe(true);
		expect(provider.hasSession("sess-nope")).toBe(false);
	});

	it("falls back to the first prompt when workspace.yaml has no summary", () => {
		writeSessionDir("sess-nosummary", { prompt: "Fix the login page CSS" });

		const provider = new CopilotSessionProvider(tmpDir);
		expect(provider.readName("sess-nosummary")).toBe("Fix the login page CSS");
	});

	it("discovers candidates filtered by cwd, newest first", () => {
		writeSessionDir("sess-old", {
			cwd: "/repo/a",
			startTime: "2026-03-04T09:00:00.000Z",
			prompt: "old",
		});
		writeSessionDir("sess-new", {
			cwd: "/repo/a",
			startTime: "2026-03-04T11:00:00.000Z",
			prompt: "new",
		});
		writeSessionDir("sess-other", { cwd: "/repo/b", prompt: "other" });

		const provider = new CopilotSessionProvider(tmpDir);
		const candidates = provider.discoverSessionCandidates(
			"/repo/a",
			new Set(["sess-old"]),
		);

		expect(candidates.map((c) => c.sessionId)).toEqual(["sess-new"]);
	});

	it("correlates the single unclaimed session born after launch", () => {
		writeSessionDir("sess-owned", {
			cwd: "/repo/a",
			startTime: "2026-03-04T11:00:00.000Z",
			prompt: "mine",
		});

		const provider = new CopilotSessionProvider(tmpDir);
		const owned = provider.correlateOwnedSession({
			cwd: "/repo/a",
			knownSessionIds: new Set(),
			launchedAtMs: Date.parse("2026-03-04T10:59:00.000Z"),
		});
		expect(owned).toBe("sess-owned");

		// Predating the launch: no proof, no bind.
		expect(
			provider.correlateOwnedSession({
				cwd: "/repo/a",
				knownSessionIds: new Set(),
				launchedAtMs: Date.parse("2026-03-05T00:00:00.000Z"),
			}),
		).toBeUndefined();
	});

	it("refuses to correlate when two unclaimed candidates exist", () => {
		writeSessionDir("sess-1", { cwd: "/repo/a", prompt: "one" });
		writeSessionDir("sess-2", { cwd: "/repo/a", prompt: "two" });

		const provider = new CopilotSessionProvider(tmpDir);
		expect(
			provider.correlateOwnedSession({
				cwd: "/repo/a",
				knownSessionIds: new Set(),
				launchedAtMs: Date.parse("2026-03-04T09:00:00.000Z"),
			}),
		).toBeUndefined();
	});

	it("exposes async twins for the non-blocking passes", async () => {
		writeSessionDir("sess-async", {
			cwd: "/repo/a",
			summary: "Async Title",
			prompt: "hello",
		});

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = await provider.async.scanSessions();
		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-async"]);
		expect(await provider.async.hasSession("sess-async")).toBe(true);
		expect(await provider.async.hasSession("sess-nope")).toBe(false);
		expect(await provider.async.readName("sess-async")).toBe("Async Title");
		expect(await provider.resumeConversation("sess-async")).toBe(true);
		expect(await provider.resumeConversation("sess-nope")).toBe(false);
	});

	it("skips session dirs without events or workspace", () => {
		fs.mkdirSync(path.join(tmpDir, "empty-dir"));
		const provider = new CopilotSessionProvider(tmpDir);
		expect(provider.scanSessions()).toEqual([]);
	});

	it("skips malformed events.jsonl lines without losing the session", () => {
		const dir = path.join(tmpDir, "sess-badline");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "events.jsonl"),
			[
				"not json at all",
				JSON.stringify({
					type: "session.start",
					data: {
						sessionId: "sess-badline",
						startTime: "2026-03-04T10:00:00.000Z",
					},
				}),
				JSON.stringify({
					type: "user.message",
					data: { content: "Surviving prompt" },
				}),
			].join("\n"),
		);

		const provider = new CopilotSessionProvider(tmpDir);
		const sessions = provider.scanSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0].prompt).toBe("Surviving prompt");
	});
});
