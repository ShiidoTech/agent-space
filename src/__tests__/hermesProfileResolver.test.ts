import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveAgentHermesHome,
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
