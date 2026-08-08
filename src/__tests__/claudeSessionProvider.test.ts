import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeSessionProvider } from "../agents/sessionProviders/claudeSessionProvider";

describe("ClaudeSessionProvider attention", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-attention-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads structured user and assistant turn boundaries", () => {
		const projectDir = path.join(tmpDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "session-1.jsonl"),
			[
				JSON.stringify({ type: "user", message: { content: "Fix it" } }),
				JSON.stringify({
					type: "assistant",
					message: { stop_reason: "tool_use" },
				}),
			].join("\n"),
		);

		const provider = new ClaudeSessionProvider(tmpDir);
		const signal = provider.readAttention("session-1");
		expect(signal).toEqual({
			status: "working",
			evidence: "claude.assistant.tool_use",
		});

		fs.appendFileSync(
			path.join(projectDir, "session-1.jsonl"),
			`\n${JSON.stringify({ type: "result" })}`,
		);
		expect(provider.readAttention("session-1")).toEqual({
			status: "idle",
			evidence: "claude.result",
		});
	});
});
