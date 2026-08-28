import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CodexAppServerEvent,
	CodexAppServerTransport,
} from "../agents/sessionProviders/codexAppServer";
import { CodexSessionProvider } from "../agents/sessionProviders/codexSessionProvider";

describe("CodexSessionProvider", () => {
	let tmpDir: string;
	let sessionIndexPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
		sessionIndexPath = path.join(tmpDir, "session_index.jsonl");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeSessionFile(relativePath: string, lines: string[]): string {
		const filePath = path.join(tmpDir, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, lines.join("\n"));
		return filePath;
	}

	function sessionMeta(
		id: string,
		opts: {
			title?: string;
			first_user_message?: string;
			cwd?: string;
			created?: string;
		} = {},
	) {
		return JSON.stringify({
			type: "session_meta",
			payload: {
				id,
				title: opts.title,
				first_user_message: opts.first_user_message,
				cwd: opts.cwd || "/tmp/project",
				created: opts.created || "2026-03-04T10:00:00.000Z",
			},
		});
	}

	function writeSessionIndex(lines: string[]): string {
		fs.writeFileSync(sessionIndexPath, `${lines.join("\n")}\n`);
		return sessionIndexPath;
	}

	function appServerFake(ids: string[]) {
		let listener: ((event: CodexAppServerEvent) => void) | undefined;
		const transport: CodexAppServerTransport = {
			request: vi.fn(async (method: string) => {
				if (method === "thread/start") return { thread: { id: ids.shift() } };
				if (method === "thread/resume") return { thread: { id: "thread-a" } };
				return {};
			}) as unknown as CodexAppServerTransport["request"],
			onEvent(next) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			close: vi.fn(),
		};
		return {
			transport,
			emit(event: CodexAppServerEvent) {
				listener?.(event);
			},
		};
	}

	describe("controlled app-server identity and events", () => {
		it("persists and observes the exact thread returned by thread/start", async () => {
			const fake = appServerFake(["thread-a"]);
			const provider = new CodexSessionProvider(
				tmpDir,
				sessionIndexPath,
				fake.transport,
			);
			const receipt = await provider.acquireConversation({
				agentId: "agent-a",
				featureId: "feature-a",
				cwd: "/tmp/project",
				knownSessionIds: new Set(),
			});

			expect(receipt).toEqual({
				sessionId: "thread-a",
				proof: "codex.app-server.thread/start",
			});
			fake.emit({
				method: "turn/started",
				params: { threadId: "thread-a", turn: { id: "turn-a" } },
			});
			expect(provider.readAttention("thread-a")?.status).toBe("working");
		});

		it("keeps two same-worktree threads isolated, including reversed prompt order", async () => {
			const fake = appServerFake(["thread-a", "thread-b"]);
			const provider = new CodexSessionProvider(
				tmpDir,
				sessionIndexPath,
				fake.transport,
			);
			const context = {
				cwd: "/tmp/shared",
				knownSessionIds: new Set<string>(),
			};
			const [a, b] = await Promise.all([
				provider.acquireConversation({ ...context, agentId: "a" }),
				provider.acquireConversation({ ...context, agentId: "b" }),
			]);
			expect(new Set([a?.sessionId, b?.sessionId])).toEqual(
				new Set(["thread-a", "thread-b"]),
			);

			fake.emit({ method: "turn/started", params: { threadId: "thread-b" } });
			expect(provider.readAttention("thread-b")?.status).toBe("working");
			expect(provider.readAttention("thread-a")).toBeUndefined();
			fake.emit({
				method: "item/tool/requestUserInput",
				params: {
					threadId: "thread-a",
					turnId: "turn-a",
					itemId: "item-a",
					isBlocking: true,
					questions: [],
				},
			});
			expect(provider.readAttention("thread-a")?.status).toBe(
				"waiting_for_user",
			);
			expect(provider.readAttention("thread-b")?.status).toBe("working");
		});

		it("maps provider-native completion once and keeps structured failures thread-local", () => {
			const fake = appServerFake([]);
			const provider = new CodexSessionProvider(
				tmpDir,
				sessionIndexPath,
				fake.transport,
			);
			fake.emit({ method: "turn/started", params: { threadId: "thread-a" } });
			fake.emit({
				method: "turn/completed",
				params: {
					threadId: "thread-a",
					turn: { status: { type: "completed" } },
				},
			});
			expect(provider.readAttention("thread-a")?.evidence).toBe(
				"codex.app-server.turn/completed",
			);
			fake.emit({ method: "error", params: { threadId: "thread-b" } });
			expect(provider.readAttention("thread-b")?.status).toBe("failed");
			expect(provider.readAttention("thread-a")?.status).toBe("idle");
		});

		it("classifies Codex 0.150.1 string turn statuses correctly", () => {
			const fake = appServerFake([]);
			const provider = new CodexSessionProvider(
				tmpDir,
				sessionIndexPath,
				fake.transport,
			);
			fake.emit({
				method: "turn/started",
				params: { threadId: "thread-failed" },
			});
			fake.emit({
				method: "turn/completed",
				params: {
					threadId: "thread-failed",
					turn: { status: "failed" },
				},
			});
			expect(provider.readAttention("thread-failed")?.status).toBe("failed");
		});

		it("resumes only the persisted thread id", async () => {
			const fake = appServerFake([]);
			const provider = new CodexSessionProvider(
				tmpDir,
				sessionIndexPath,
				fake.transport,
			);
			expect(await provider.resumeConversation("thread-a")).toBe(true);
			expect(fake.transport.request).toHaveBeenCalledWith("thread/resume", {
				threadId: "thread-a",
			});
		});
	});

	describe("scanSessions", () => {
		it("parses session_meta from JSONL files in nested dirs", () => {
			writeSessionFile("2026/03/04/rollout-1709550000-sess-abc.jsonl", [
				sessionMeta("sess-abc", { title: "Fix the bug" }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const sessions = provider.scanSessions();

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("sess-abc");
			expect(sessions[0].prompt).toBe("Fix the bug");
			expect(sessions[0].projectPath).toBe("/tmp/project");
		});

		it("handles multiple session files across date dirs", () => {
			writeSessionFile("2026/03/04/rollout-1000-sess-a.jsonl", [
				sessionMeta("sess-a", { title: "Task A" }),
			]);
			writeSessionFile("2026/03/05/rollout-2000-sess-b.jsonl", [
				sessionMeta("sess-b", { title: "Task B" }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const sessions = provider.scanSessions();

			expect(sessions).toHaveLength(2);
			const ids = sessions.map((s) => s.sessionId).sort();
			expect(ids).toEqual(["sess-a", "sess-b"]);
		});

		it("skips non-jsonl files", () => {
			fs.mkdirSync(path.join(tmpDir, "2026/03/04"), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, "2026/03/04/readme.txt"),
				"not a session",
			);
			writeSessionFile("2026/03/04/rollout-1000-sess-valid.jsonl", [
				sessionMeta("sess-valid", { title: "Valid" }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const sessions = provider.scanSessions();

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("sess-valid");
		});

		it("returns empty array when directory does not exist", () => {
			const provider = new CodexSessionProvider("/nonexistent/path");
			expect(provider.scanSessions()).toEqual([]);
		});

		it("skips files without session_meta event", () => {
			writeSessionFile("2026/03/04/rollout-1000-no-meta.jsonl", [
				JSON.stringify({ type: "user_message", content: "Hello" }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const sessions = provider.scanSessions();

			expect(sessions).toHaveLength(0);
		});

		it("skips files where session_meta has no id", () => {
			writeSessionFile("2026/03/04/rollout-1000-no-id.jsonl", [
				JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp" } }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const sessions = provider.scanSessions();

			expect(sessions).toHaveLength(0);
		});

		it("uses first_user_message as fallback when title is missing", () => {
			writeSessionFile("2026/03/04/rollout-1000-sess-msg.jsonl", [
				sessionMeta("sess-msg", { first_user_message: "Help me refactor" }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const sessions = provider.scanSessions();

			expect(sessions[0].prompt).toBe("Help me refactor");
		});
	});

	it("enumerates all candidate sessions without claiming ownership", () => {
		const cwd = path.join(tmpDir, "shared-worktree");
		writeSessionFile("2026/03/04/session-a.jsonl", [
			sessionMeta("session-a", { cwd, created: "2026-03-04T10:00:00.000Z" }),
		]);
		writeSessionFile("2026/03/04/session-b.jsonl", [
			sessionMeta("session-b", { cwd, created: "2026-03-04T10:01:00.000Z" }),
		]);

		const provider = new CodexSessionProvider(tmpDir, sessionIndexPath);
		const candidates = provider.discoverSessionCandidates(cwd, new Set());

		expect(candidates.map((session) => session.sessionId)).toEqual([
			"session-b",
			"session-a",
		]);
	});

	it("lists candidates without claiming ownership", () => {
		const cwd = path.join(tmpDir, "shared-worktree");
		writeSessionFile("2026/03/04/session-a.jsonl", [
			sessionMeta("session-a", { cwd }),
		]);
		const provider = new CodexSessionProvider(tmpDir, sessionIndexPath);

		expect(
			provider
				.discoverSessionCandidates(cwd, new Set())
				.map((s) => s.sessionId),
		).toEqual(["session-a"]);

		writeSessionFile("2026/03/04/session-b.jsonl", [
			sessionMeta("session-b", { cwd }),
		]);
		expect(
			provider
				.discoverSessionCandidates(cwd, new Set(["session-a"]))
				.map((s) => s.sessionId),
		).toEqual(["session-b"]);
	});

	describe("findSessionFile", () => {
		it("finds file in nested directory by sessionId", () => {
			writeSessionFile("2026/03/04/rollout-1709550000-sess-find.jsonl", [
				sessionMeta("sess-find", { title: "Found" }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const found = provider.findSessionFile("sess-find");
			expect(found).toBe(
				path.join(tmpDir, "2026/03/04/rollout-1709550000-sess-find.jsonl"),
			);
		});

		it("returns null for missing session", () => {
			const provider = new CodexSessionProvider(tmpDir);
			const found = provider.findSessionFile("nonexistent-session");
			expect(found).toBeNull();
		});

		it("caches found paths", () => {
			writeSessionFile("2026/03/04/rollout-1000-sess-cache.jsonl", [
				sessionMeta("sess-cache", { title: "Cached" }),
			]);

			const provider = new CodexSessionProvider(tmpDir);
			const first = provider.findSessionFile("sess-cache");
			const second = provider.findSessionFile("sess-cache");
			expect(first).toBe(second);
		});

		it("re-searches when cached path no longer exists", () => {
			const filePath = writeSessionFile(
				"2026/03/04/rollout-1000-sess-stale.jsonl",
				[sessionMeta("sess-stale", { title: "Stale" })],
			);

			const provider = new CodexSessionProvider(tmpDir);
			const first = provider.findSessionFile("sess-stale");
			expect(first).toBe(filePath);

			// Remove the file and create a new one in a different location
			fs.rmSync(filePath);
			const newPath = writeSessionFile(
				"2026/03/05/rollout-2000-sess-stale.jsonl",
				[sessionMeta("sess-stale", { title: "Moved" })],
			);

			const second = provider.findSessionFile("sess-stale");
			expect(second).toBe(newPath);
		});

		it("returns null when sessions dir does not exist", () => {
			const provider = new CodexSessionProvider("/nonexistent/path");
			expect(provider.findSessionFile("any-id")).toBeNull();
		});
	});

	describe("readTitle", () => {
		it("reads title from session_meta payload", () => {
			const filePath = writeSessionFile(
				"2026/03/04/rollout-1000-sess-title.jsonl",
				[sessionMeta("sess-title", { title: "My Session Title" })],
			);

			const provider = new CodexSessionProvider(tmpDir);
			const title = provider.readTitle(filePath);
			expect(title).toBe("My Session Title");
		});

		it("falls back to first_user_message when title is absent", () => {
			const filePath = writeSessionFile(
				"2026/03/04/rollout-1000-sess-msg.jsonl",
				[sessionMeta("sess-msg", { first_user_message: "User prompt text" })],
			);

			const provider = new CodexSessionProvider(tmpDir);
			const title = provider.readTitle(filePath);
			expect(title).toBe("User prompt text");
		});

		it("returns null for empty file", () => {
			const filePath = writeSessionFile(
				"2026/03/04/rollout-1000-empty.jsonl",
				[],
			);

			const provider = new CodexSessionProvider(tmpDir);
			const title = provider.readTitle(filePath);
			expect(title).toBeNull();
		});

		it("returns null when first line is not session_meta", () => {
			const filePath = writeSessionFile(
				"2026/03/04/rollout-1000-no-meta.jsonl",
				[JSON.stringify({ type: "user_message", content: "Hello" })],
			);

			const provider = new CodexSessionProvider(tmpDir);
			const title = provider.readTitle(filePath);
			expect(title).toBeNull();
		});

		it("returns null when session_meta has no title or first_user_message", () => {
			const filePath = writeSessionFile(
				"2026/03/04/rollout-1000-no-title.jsonl",
				[
					JSON.stringify({
						type: "session_meta",
						payload: { id: "x", cwd: "/tmp" },
					}),
				],
			);

			const provider = new CodexSessionProvider(tmpDir);
			const title = provider.readTitle(filePath);
			expect(title).toBeNull();
		});
	});

	describe("readName", () => {
		it("reads thread_name from session index", () => {
			writeSessionIndex([
				JSON.stringify({
					id: "sess-name",
					thread_name: "Renamed Session",
					updated_at: "2026-03-06T16:28:46.350986641Z",
				}),
			]);

			const provider = new CodexSessionProvider(tmpDir, sessionIndexPath);
			expect(provider.readName("sess-name")).toBe("Renamed Session");
		});

		it("returns null when session index does not contain the session", () => {
			writeSessionIndex([
				JSON.stringify({
					id: "other-session",
					thread_name: "Other Name",
					updated_at: "2026-03-06T16:28:46.350986641Z",
				}),
			]);

			const provider = new CodexSessionProvider(tmpDir, sessionIndexPath);
			expect(provider.readName("missing-session")).toBeNull();
		});

		it("takes the last thread_name for a session id", () => {
			writeSessionIndex([
				JSON.stringify({
					id: "sess-dup",
					thread_name: "First Name",
					updated_at: "2026-03-06T16:28:46.350986641Z",
				}),
				JSON.stringify({
					id: "sess-dup",
					thread_name: "Final Name",
					updated_at: "2026-03-06T16:29:46.350986641Z",
				}),
			]);

			const provider = new CodexSessionProvider(tmpDir, sessionIndexPath);
			expect(provider.readName("sess-dup")).toBe("Final Name");
		});

		it("reloads session index after cache clear", () => {
			writeSessionIndex([
				JSON.stringify({
					id: "sess-clear-name",
					thread_name: "Initial Name",
					updated_at: "2026-03-06T16:28:46.350986641Z",
				}),
			]);

			const provider = new CodexSessionProvider(tmpDir, sessionIndexPath);
			expect(provider.readName("sess-clear-name")).toBe("Initial Name");

			writeSessionIndex([
				JSON.stringify({
					id: "sess-clear-name",
					thread_name: "Updated Name",
					updated_at: "2026-03-06T16:29:46.350986641Z",
				}),
			]);
			provider.clearCache("sess-clear-name");

			expect(provider.readName("sess-clear-name")).toBe("Updated Name");
		});
	});

	describe("clearCache", () => {
		it("clears cached path for a session", () => {
			const filePath = writeSessionFile(
				"2026/03/04/rollout-1000-sess-clear.jsonl",
				[sessionMeta("sess-clear", { title: "Clear" })],
			);

			const provider = new CodexSessionProvider(tmpDir);
			expect(provider.findSessionFile("sess-clear")).toBe(filePath);

			// Remove the file
			fs.rmSync(filePath);

			// Without clearing cache, it would still try the old path then re-search
			provider.clearCache("sess-clear");

			// After clearing, should return null since file is gone
			expect(provider.findSessionFile("sess-clear")).toBeNull();
		});
	});

	it("has toolId codex", () => {
		const provider = new CodexSessionProvider(tmpDir);
		expect(provider.toolId).toBe("codex");
	});

	describe("readAttention", () => {
		it("reads Codex task lifecycle events", () => {
			writeSessionFile("2026/03/04/rollout-1000-sess-attention.jsonl", [
				sessionMeta("sess-attention"),
				JSON.stringify({
					type: "event_msg",
					payload: { type: "task_started" },
				}),
				JSON.stringify({
					type: "response_item",
					payload: { type: "function_call" },
				}),
				JSON.stringify({
					type: "event_msg",
					payload: { type: "task_complete" },
				}),
			]);

			expect(
				new CodexSessionProvider(tmpDir).readAttention("sess-attention"),
			).toEqual({
				status: "idle",
				evidence: "codex.task_complete",
			});
		});

		it("reports active tool work when completion is absent", () => {
			writeSessionFile("2026/03/04/rollout-1000-sess-working.jsonl", [
				sessionMeta("sess-working"),
				JSON.stringify({
					type: "event_msg",
					payload: { type: "task_started" },
				}),
			]);

			expect(
				new CodexSessionProvider(tmpDir).readAttention("sess-working"),
			).toEqual({
				status: "working",
				evidence: "codex.task_started",
			});
		});

		describe("session title fallback", () => {
			it("uses a structured thread name or first user message", () => {
				writeSessionFile("2026/03/04/rollout-1000-sess-title.jsonl", [
					sessionMeta("sess-title"),
					JSON.stringify({
						type: "event_msg",
						payload: {
							type: "user_message",
							message: "Investigate the picker",
						},
					}),
				]);

				expect(new CodexSessionProvider(tmpDir).readName("sess-title")).toBe(
					"Investigate the picker",
				);
			});

			it("reads the response_item user message shape emitted by Codex 0.147", () => {
				writeSessionFile("2026/03/04/rollout-real-shape.jsonl", [
					sessionMeta("sess-real-shape"),
					JSON.stringify({
						type: "response_item",
						payload: {
							type: "message",
							role: "user",
							content: [
								{
									type: "input_text",
									text: "Diagnose the session title sync",
								},
							],
						},
					}),
				]);

				expect(
					new CodexSessionProvider(tmpDir).readName("sess-real-shape"),
				).toBe("Diagnose the session title sync");
			});
		});
	});

	describe("custom sessionsDir (codex-perso) index resolution", () => {
		it("resolves session_index.jsonl at the profile root (parent of sessions)", () => {
			const profileDir = path.join(tmpDir, "codex-perso");
			const sessionsDir = path.join(profileDir, "sessions");
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(profileDir, "session_index.jsonl"),
				`${JSON.stringify({ id: "sess-perso", thread_name: "Custom profile name" })}\n`,
			);
			writeSessionFile(
				path.join("sessions", "2026/03/04/rollout-perso.jsonl"),
				[sessionMeta("sess-perso")],
			);

			expect(new CodexSessionProvider(sessionsDir).readName("sess-perso")).toBe(
				"Custom profile name",
			);
		});

		it("falls back to the first user message when thread_name is absent", () => {
			const profileDir = path.join(tmpDir, "codex-perso-2");
			const sessionsDir = path.join(profileDir, "sessions");
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(profileDir, "session_index.jsonl"),
				`${JSON.stringify({ id: "sess-noname", thread_name: "" })}\n`,
			);
			fs.mkdirSync(
				path.dirname(path.join(sessionsDir, "2026/03/04/rollout-noname.jsonl")),
				{
					recursive: true,
				},
			);
			fs.writeFileSync(
				path.join(sessionsDir, "2026/03/04/rollout-noname.jsonl"),
				[
					sessionMeta("sess-noname"),
					JSON.stringify({
						type: "user_message",
						message: "Provision the staging database",
					}),
				].join("\n"),
			);

			expect(
				new CodexSessionProvider(sessionsDir).readName("sess-noname"),
			).toBe("Provision the staging database");
		});
	});
});
