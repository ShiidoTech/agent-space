import { describe, expect, it } from "vitest";
import { runBootstrapCommands } from "../features/bootstrapRunner";

function output() {
	const lines: string[] = [];
	return { lines, appendLine: (line: string) => lines.push(line) };
}

describe("runBootstrapCommands", () => {
	it("runs sequentially in the requested cwd and reports success", async () => {
		const log = output();
		const calls: Array<[string, string]> = [];
		const result = await runBootstrapCommands(
			["bun install", "bun run generate"],
			"/worktree/feature",
			log,
			async (command, cwd) => {
				calls.push([command, cwd]);
				return 0;
			},
		);

		expect(result).toEqual({
			success: true,
			completed: ["bun install", "bun run generate"],
		});
		expect(calls).toEqual([
			["bun install", "/worktree/feature"],
			["bun run generate", "/worktree/feature"],
		]);
		expect(log.lines.at(-1)).toContain("success");
	});

	it("stops after the first failed command and omits success", async () => {
		const log = output();
		const calls: string[] = [];
		const result = await runBootstrapCommands(
			["bun install", "bun run generate", "bun test"],
			"/worktree/feature",
			log,
			async (command) => {
				calls.push(command);
				return command === "bun run generate" ? 1 : 0;
			},
		);

		expect(result).toMatchObject({
			success: false,
			completed: ["bun install"],
			failedCommand: "bun run generate",
			exitCode: 1,
		});
		expect(calls).toEqual(["bun install", "bun run generate"]);
		expect(log.lines.some((line) => line.includes("[success]"))).toBe(false);
	});

	it("can be retried after a failure", async () => {
		const log = output();
		let attempts = 0;
		const execute = async () => {
			attempts += 1;
			return attempts === 1 ? 1 : 0;
		};

		const first = await runBootstrapCommands(
			["setup"],
			"/worktree",
			log,
			execute,
		);
		const second = await runBootstrapCommands(
			["setup"],
			"/worktree",
			log,
			execute,
		);

		expect(first.success).toBe(false);
		expect(second.success).toBe(true);
		expect(attempts).toBe(2);
	});
});
