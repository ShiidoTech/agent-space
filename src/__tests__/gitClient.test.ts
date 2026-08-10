import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../git/gitClient";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "agent-space-git-client-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("GitClient", () => {
	it("executes sync reads as argv without shell interpretation", () => {
		const cwd = temporaryDirectory();
		const marker = path.join(cwd, "shell-was-used");
		const result = new GitClient().readSync(
			["rev-parse", "--verify", `HEAD;touch ${marker}`],
			{ cwd },
		);

		expect(result.argv).toEqual([
			"rev-parse",
			"--verify",
			`HEAD;touch ${marker}`,
		]);
		expect(result.exitCode).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("executes async reads and returns non-zero results without throwing", async () => {
		const cwd = temporaryDirectory();
		const client = new GitClient();
		const version = await client.read(["--version"], { cwd });
		const failure = await client.read(["rev-parse", "--verify", "missing"], {
			cwd,
		});

		expect(version.exitCode).toBe(0);
		expect(version.stdout).toMatch(/^git version /);
		expect(failure.exitCode).not.toBe(0);
		expect(failure.argv).toEqual(["rev-parse", "--verify", "missing"]);
	});
});
