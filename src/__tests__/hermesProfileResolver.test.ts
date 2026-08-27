import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveActiveHermesProfile,
	resolveAgentHermesHome,
	resolveCreationProfile,
	resolveHermesHome,
	resolveHermesProfile,
	resolveHermesRoot,
} from "../agents/hermesProfileResolver";
import type { ProjectConfig } from "../projects/projectConfig";
import type { Agent } from "../types";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "agent-1",
		featureId: "feat-1",
		name: "Agent 1",
		sessionId: null,
		status: "stopped",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("resolveHermesRoot", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns HERMES_HOME when set", () => {
		process.env.HERMES_HOME = "/custom/hermes";
		expect(resolveHermesRoot()).toBe("/custom/hermes");
	});

	it("falls back to ~/.hermes when HERMES_HOME is unset", () => {
		delete process.env.HERMES_HOME;
		expect(resolveHermesRoot()).toBe(path.join(os.homedir(), ".hermes"));
	});
});

describe("resolveHermesHome", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns root itself when profile is undefined", () => {
		delete process.env.HERMES_HOME;
		expect(resolveHermesHome()).toBe(path.join(os.homedir(), ".hermes"));
	});

	it("returns root itself when profile is empty string", () => {
		delete process.env.HERMES_HOME;
		expect(resolveHermesHome("")).toBe(path.join(os.homedir(), ".hermes"));
	});

	it("returns root itself for the literal default profile", () => {
		delete process.env.HERMES_HOME;
		expect(resolveHermesHome("default")).toBe(
			path.join(os.homedir(), ".hermes"),
		);
	});

	it("returns <root>/profiles/<profile> for a named profile", () => {
		delete process.env.HERMES_HOME;
		expect(resolveHermesHome("iqv2")).toBe(
			path.join(os.homedir(), ".hermes", "profiles", "iqv2"),
		);
	});

	it("respects HERMES_HOME as root for named profiles", () => {
		process.env.HERMES_HOME = "/custom/hermes";
		expect(resolveHermesHome("iqv2")).toBe(
			path.join("/custom/hermes", "profiles", "iqv2"),
		);
	});

	it("respects HERMES_HOME for default profile", () => {
		process.env.HERMES_HOME = "/custom/hermes";
		expect(resolveHermesHome()).toBe("/custom/hermes");
	});
});

describe("resolveActiveHermesProfile", () => {
	const originalEnv = { ...process.env };
	const tmpDirs: string[] = [];

	afterEach(() => {
		process.env = { ...originalEnv };
		for (const dir of tmpDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-active-"));
		tmpDirs.push(root);
		return root;
	}

	it("returns default when active_profile file is absent", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;
		expect(resolveActiveHermesProfile()).toBe("default");
	});

	it("returns default when active_profile file is empty", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;
		fs.writeFileSync(path.join(root, "active_profile"), "");
		expect(resolveActiveHermesProfile()).toBe("default");
	});

	it("returns the name written by hermes profile use", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;
		fs.writeFileSync(path.join(root, "active_profile"), "iqv2\n");
		expect(resolveActiveHermesProfile()).toBe("iqv2");
	});
});

describe("resolveCreationProfile", () => {
	it("project profile wins over the active Hermes profile", () => {
		expect(resolveCreationProfile("project-profile")).toBe("project-profile");
	});

	it("falls back to the active Hermes profile when project profile is absent", () => {
		const originalEnv = { ...process.env };
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-create-"));
		try {
			process.env.HERMES_HOME = root;
			fs.writeFileSync(path.join(root, "active_profile"), "iqv2\n");
			expect(resolveCreationProfile()).toBe("iqv2");
		} finally {
			process.env = { ...originalEnv };
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns default when neither project nor active profile is set", () => {
		expect(resolveCreationProfile()).toBe("default");
	});
});

describe("resolveHermesProfile", () => {
	it("returns agent.hermesProfile when set", () => {
		const agent = makeAgent({ hermesProfile: "iqv2" });
		const config: ProjectConfig = {
			providers: { hermes: { profile: "other" } },
		};
		expect(resolveHermesProfile(agent, config)).toBe("iqv2");
	});

	it("falls back to project config when agent has no profile", () => {
		const agent = makeAgent();
		const config: ProjectConfig = {
			providers: { hermes: { profile: "iqv2" } },
		};
		expect(resolveHermesProfile(agent, config)).toBe("iqv2");
	});

	it("returns undefined when neither agent nor config has profile", () => {
		const agent = makeAgent();
		expect(resolveHermesProfile(agent)).toBeUndefined();
		expect(resolveHermesProfile(agent, {})).toBeUndefined();
	});

	it("returns undefined when config has empty providers", () => {
		const agent = makeAgent();
		const config: ProjectConfig = { providers: {} };
		expect(resolveHermesProfile(agent, config)).toBeUndefined();
	});

	it("returns undefined when config has empty hermes block", () => {
		const agent = makeAgent();
		const config: ProjectConfig = { providers: { hermes: {} } };
		expect(resolveHermesProfile(agent, config)).toBeUndefined();
	});
});

describe("resolveAgentHermesHome", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("resolves to default home when no profile anywhere", () => {
		delete process.env.HERMES_HOME;
		const agent = makeAgent();
		expect(resolveAgentHermesHome(agent)).toBe(
			path.join(os.homedir(), ".hermes"),
		);
	});

	it("resolves to profile home from agent", () => {
		delete process.env.HERMES_HOME;
		const agent = makeAgent({ hermesProfile: "iqv2" });
		expect(resolveAgentHermesHome(agent)).toBe(
			path.join(os.homedir(), ".hermes", "profiles", "iqv2"),
		);
	});

	it("resolves to profile home from project config", () => {
		delete process.env.HERMES_HOME;
		const agent = makeAgent();
		const config: ProjectConfig = {
			providers: { hermes: { profile: "prod" } },
		};
		expect(resolveAgentHermesHome(agent, config)).toBe(
			path.join(os.homedir(), ".hermes", "profiles", "prod"),
		);
	});

	it("agent profile takes precedence over project config", () => {
		delete process.env.HERMES_HOME;
		const agent = makeAgent({ hermesProfile: "agent-profile" });
		const config: ProjectConfig = {
			providers: { hermes: { profile: "config-profile" } },
		};
		expect(resolveAgentHermesHome(agent, config)).toBe(
			path.join(os.homedir(), ".hermes", "profiles", "agent-profile"),
		);
	});

	it("respects HERMES_HOME as root", () => {
		process.env.HERMES_HOME = "/data/hermes";
		const agent = makeAgent({ hermesProfile: "iqv2" });
		expect(resolveAgentHermesHome(agent)).toBe(
			path.join("/data/hermes", "profiles", "iqv2"),
		);
	});
});
