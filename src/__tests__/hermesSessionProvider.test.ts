import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesSessionProvider } from "../agents/sessionProviders/hermesSessionProvider";

const tempDirs: string[] = [];
const originalHermesHome = process.env.HERMES_HOME;

afterEach(() => {
	if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
	else process.env.HERMES_HOME = originalHermesHome;
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function hermesHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-provider-"));
	tempDirs.push(home);
	fs.mkdirSync(path.join(home, "terminal-sessions"));
	process.env.HERMES_HOME = home;
	return home;
}

describe("HermesSessionProvider", () => {
	it("reads Hermes terminal breadcrumbs as owned sessions", () => {
		const home = hermesHome();
		fs.writeFileSync(
			path.join(home, "terminal-sessions", "tmux_pane--1"),
			JSON.stringify({
				session_id: "20260825_084401_173312",
				cwd: "/worktrees/ops",
				ts: 1787640241.539,
			}),
		);

		const sessions = new HermesSessionProvider().scanSessions();

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: "20260825_084401_173312",
				projectPath: "/worktrees/ops",
			}),
		]);
	});

});
