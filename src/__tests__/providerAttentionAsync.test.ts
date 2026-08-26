import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSessionProvider } from "../agents/sessionProviders/claudeSessionProvider";
import { CodexSessionProvider } from "../agents/sessionProviders/codexSessionProvider";

describe("provider attention async twins (parity with sync reads)", () => {
	const dirs: string[] = [];

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-async-"));
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("claude: readAttentionAsync returns the same signal as readAttention", async () => {
		const projectsDir = tmpDir();
		const sessionDir = path.join(projectsDir, "p1");
		fs.mkdirSync(sessionDir, { recursive: true });
		const filePath = path.join(sessionDir, "sess-1.jsonl");
		const lines = [
			JSON.stringify({ type: "user", timestamp: "2026-03-06T10:00:00Z" }),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-03-06T10:01:00Z",
				message: {
					stop_reason: "tool_use",
					content: [{ type: "tool_use", name: "Bash" }],
				},
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-03-06T10:02:00Z",
				message: {
					content: [{ type: "tool_use", name: "AskUserQuestion" }],
				},
			}),
		];
		fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

		const provider = new ClaudeSessionProvider(projectsDir);
		const syncSignal = provider.readAttention("sess-1");
		const asyncSignal = await provider.readAttentionAsync("sess-1");

		expect(syncSignal).toEqual({
			status: "waiting_for_user",
			evidence: "claude.assistant.ask_user_question",
			observedAt: "2026-03-06T10:02:00Z",
		});
		expect(asyncSignal).toEqual(syncSignal);
	});

	it("codex: readAttentionAsync returns the same signal as readAttention", async () => {
		const sessionsDir = tmpDir();
		const filePath = path.join(sessionsDir, "rollout-1.jsonl");
		const lines = [
			JSON.stringify({
				type: "session_meta",
				payload: { id: "codex-sess-1", timestamp: "2026-03-06T09:00:00Z" },
			}),
			JSON.stringify({
				type: "event_msg",
				payload: { type: "task_started" },
				timestamp: "2026-03-06T09:01:00Z",
			}),
			JSON.stringify({
				type: "event_msg",
				payload: { type: "request_user_input" },
				timestamp: "2026-03-06T09:02:00Z",
			}),
		];
		fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

		const provider = new CodexSessionProvider(sessionsDir);
		const syncSignal = provider.readAttention("codex-sess-1");
		const asyncSignal = await provider.readAttentionAsync("codex-sess-1");

		expect(syncSignal).toEqual({
			status: "waiting_for_user",
			evidence: "codex.request_user_input",
			observedAt: "2026-03-06T09:02:00Z",
		});
		expect(asyncSignal).toEqual(syncSignal);
	});
});
