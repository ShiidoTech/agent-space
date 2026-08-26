import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionNameSyncer } from "../agents/sessionNameSyncer";
import { ClaudeSessionProvider } from "../agents/sessionProviders/claudeSessionProvider";
import { ProjectManager } from "../projects/projectManager";
import { GlobalStore } from "../storage/globalStore";
import type { Feature } from "../types";

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		})),
	},
}));

const feature: Feature = {
	id: "f1",
	name: "auth",
	branch: "feat/auth",
	worktreePath: "/tmp/worktrees/auth",
	status: "active",
	color: "terminal.ansiBlue",
	isolation: "shared",
	createdAt: "2026-08-08T00:00:00.000Z",
};

function titleEvent(sessionId: string, title: string): string {
	return JSON.stringify({
		type: "ai-title",
		aiTitle: title,
		sessionId,
	});
}

function createProject(tmpDir: string, features: Feature[] = [feature]) {
	const storagePath = path.join(tmpDir, "storage");
	fs.mkdirSync(storagePath, { recursive: true });
	const globalStore = new GlobalStore(storagePath);
	const projectManager = new ProjectManager(globalStore, storagePath);
	const project = projectManager.addProject(tmpDir, "test-project");
	const ctx = projectManager.getContext(project.id);
	if (!ctx) throw new Error("context should exist");
	ctx.store.saveFeatures(features);

	const reloaded = new ProjectManager(globalStore, storagePath);
	const reloadedCtx = reloaded.getContext(project.id);
	if (!reloadedCtx) throw new Error("reloaded context should exist");
	return { projectManager: reloaded, ctx: reloadedCtx, project };
}

describe("live session-name synchronization", () => {
	let tmpDir: string;
	let projectsDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sns-live-"));
		projectsDir = path.join(tmpDir, "claude-profile", "projects");
		fs.mkdirSync(projectsDir, { recursive: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeSession(sessionId: string, title: string): void {
		const projectDir = path.join(projectsDir, "-tmp-worktree");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, `${sessionId}.jsonl`),
			`${titleEvent(sessionId, title)}\n`,
		);
	}

	it("retries unnamed agents without requiring a terminal focus change", async () => {
		vi.useFakeTimers();
		const { projectManager, ctx } = createProject(tmpDir);
		const agent = ctx.agentManager.createAgent(feature, "claude");
		if (!agent.sessionId) throw new Error("expected Claude session id");

		const syncer = new SessionNameSyncer([
			new ClaudeSessionProvider(projectsDir),
		]);
		syncer.start(projectManager, 50);
		syncer.syncAll();
		expect(ctx.agentManager.getAgents(feature.id)[0]?.name).toBe("Agent 1");

		writeSession(agent.sessionId, "Live title discovered");
		// advanceTimersByTimeAsync flushes microtasks but real fsp.readFile
		// promises need real event-loop turns.  vi.waitFor polls the assertion
		// with a short interval until it passes or times out.
		await vi.waitFor(
			() => {
				expect(ctx.agentManager.getAgents(feature.id)[0]?.name).toBe(
					"Live title discovered",
				);
			},
			{ timeout: 5_000, interval: 50 },
		);
		// Drain any remaining fake-timer work so the syncer stops cleanly.
		await vi.advanceTimersByTimeAsync(0);
		syncer.dispose();
	});

	it("includes agents attached to the synthetic base feature", () => {
		const { projectManager, ctx, project } = createProject(tmpDir, []);
		const baseFeature = ctx.featureManager.getBaseFeature(project.id);
		const agent = ctx.agentManager.createAgent(baseFeature, "claude");
		if (!agent.sessionId) throw new Error("expected Claude session id");
		writeSession(agent.sessionId, "Base branch session");

		const syncer = new SessionNameSyncer([
			new ClaudeSessionProvider(projectsDir),
		]);
		syncer.start(projectManager, 0);
		syncer.syncAll();

		expect(ctx.agentManager.getAgents(baseFeature.id)[0]?.name).toBe(
			"Base branch session",
		);
		syncer.dispose();
	});

	it("accepts a Claude sessionsDir that already points to projects", () => {
		const sessionId = "direct-projects-session";
		writeSession(sessionId, "Direct projects path");

		// Extension callers historically append /projects. If a user setting
		// already points there, the provider receives projects/projects.
		const provider = new ClaudeSessionProvider(
			path.join(projectsDir, "projects"),
		);
		expect(provider.readName(sessionId)).toBe("Direct projects path");
	});

	it("periodic retries never overwrite a user-owned agent name", () => {
		vi.useFakeTimers();
		const { projectManager, ctx } = createProject(tmpDir);
		const agent = ctx.agentManager.createAgent(feature, "claude");
		if (!agent.sessionId) throw new Error("expected Claude session id");
		ctx.agentManager.renameAgent(agent.id, feature.id, "My manual name");
		writeSession(agent.sessionId, "Provider title");

		const syncer = new SessionNameSyncer([
			new ClaudeSessionProvider(projectsDir),
		]);
		syncer.start(projectManager, 50);
		vi.advanceTimersByTime(200);

		expect(ctx.agentManager.getAgents(feature.id)[0]?.name).toBe(
			"My manual name",
		);
		syncer.dispose();
	});
});
