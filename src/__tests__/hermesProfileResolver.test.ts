import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalizeHermesProfile,
	resolveActiveHermesProfile,
	resolveAgentHermesHome,
	resolveCreationProfile,
	resolveHermesHome,
	resolveHermesProfile,
	resolveHermesRootAndProfile,
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

describe("resolveHermesRootAndProfile", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns default root and no profile when HERMES_HOME unset", () => {
		delete process.env.HERMES_HOME;
		const { root, hermesHomeProfile } = resolveHermesRootAndProfile();
		expect(root).toBe(path.join(os.homedir(), ".hermes"));
		expect(hermesHomeProfile).toBeUndefined();
	});

	it("returns HERMES_HOME as root when it is a plain directory", () => {
		process.env.HERMES_HOME = "/custom/hermes";
		const { root, hermesHomeProfile } = resolveHermesRootAndProfile();
		expect(root).toBe("/custom/hermes");
		expect(hermesHomeProfile).toBeUndefined();
	});

	it("splits root and profile when HERMES_HOME points to a profile directory", () => {
		process.env.HERMES_HOME = "/custom/hermes/profiles/coder";
		const { root, hermesHomeProfile } = resolveHermesRootAndProfile();
		expect(root).toBe("/custom/hermes");
		expect(hermesHomeProfile).toBe("coder");
	});

	it("splits root and profile with explicit envHermesHome argument", () => {
		const { root, hermesHomeProfile } = resolveHermesRootAndProfile(
			"/data/hermes/profiles/iqv2",
		);
		expect(root).toBe("/data/hermes");
		expect(hermesHomeProfile).toBe("iqv2");
	});

	it("returns full path as root when profile segment is malformed", () => {
		// Missing profile name after profiles/
		process.env.HERMES_HOME = "/custom/hermes/profiles/";
		const { root, hermesHomeProfile } = resolveHermesRootAndProfile();
		expect(root).toBe("/custom/hermes/profiles/");
		expect(hermesHomeProfile).toBeUndefined();

		// Nested profiles — last /profiles/ wins
		process.env.HERMES_HOME = "/custom/hermes/profiles/foo/profiles/bar";
		const { root: root2, hermesHomeProfile: profile2 } =
			resolveHermesRootAndProfile();
		expect(root2).toBe("/custom/hermes/profiles/foo");
		expect(profile2).toBe("bar");
	});
});

describe("canonicalizeHermesProfile", () => {
	it("lowercases and trims", () => {
		expect(canonicalizeHermesProfile("  IQV2  ")).toBe("iqv2");
	});

	it("normalizes 'default' in any case to 'default'", () => {
		expect(canonicalizeHermesProfile("Default")).toBe("default");
		expect(canonicalizeHermesProfile("DEFAULT")).toBe("default");
		expect(canonicalizeHermesProfile("default")).toBe("default");
	});

	it("throws on empty or whitespace-only", () => {
		expect(() => canonicalizeHermesProfile("")).toThrow("cannot be empty");
		expect(() => canonicalizeHermesProfile("   ")).toThrow("cannot be empty");
	});

	it("throws on path traversal", () => {
		expect(() => canonicalizeHermesProfile("../foo")).toThrow("path traversal");
		expect(() => canonicalizeHermesProfile("foo/../bar")).toThrow(
			"path traversal",
		);
	});

	it("throws on directory separators", () => {
		expect(() => canonicalizeHermesProfile("foo/bar")).toThrow("separator");
		expect(() => canonicalizeHermesProfile("foo\\bar")).toThrow("separator");
	});

	it("throws on shell metacharacters", () => {
		expect(() => canonicalizeHermesProfile("foo;bar")).toThrow("metacharacter");
		expect(() => canonicalizeHermesProfile("foo&bar")).toThrow("metacharacter");
		expect(() => canonicalizeHermesProfile("foo|bar")).toThrow("metacharacter");
		expect(() => canonicalizeHermesProfile("foo$bar")).toThrow("metacharacter");
		expect(() => canonicalizeHermesProfile("foo`bar")).toThrow("metacharacter");
	});

	it("allows alphanumeric, dash, underscore, dot", () => {
		expect(canonicalizeHermesProfile("profile-1")).toBe("profile-1");
		expect(canonicalizeHermesProfile("profile_2")).toBe("profile_2");
		expect(canonicalizeHermesProfile("profile.3")).toBe("profile.3");
		expect(canonicalizeHermesProfile("Profile-Name")).toBe("profile-name");
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

	it("uses envHermesHome argument over process.env", () => {
		process.env.HERMES_HOME = "/process/hermes";
		expect(resolveHermesHome("iqv2", "/arg/hermes")).toBe(
			path.join("/arg/hermes", "profiles", "iqv2"),
		);
	});

	it("detects profile from envHermesHome when profile is undefined", () => {
		// When no explicit profile is passed, but envHermesHome points to a profile dir
		expect(resolveHermesHome(undefined, "/root/profiles/coder")).toBe(
			"/root/profiles/coder",
		);
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

	it("canonicalises the name from active_profile", () => {
		const root = makeRoot();
		process.env.HERMES_HOME = root;
		fs.writeFileSync(path.join(root, "active_profile"), "  IQV2  \n");
		expect(resolveActiveHermesProfile()).toBe("iqv2");
	});

	it("uses envHermesHome argument over process.env", () => {
		const root = makeRoot();
		fs.writeFileSync(path.join(root, "active_profile"), "arg-profile\n");
		expect(resolveActiveHermesProfile(root)).toBe("arg-profile");
	});

	it("reads active_profile from root when HERMES_HOME points to a profile dir", () => {
		// HERMES_HOME = /root/profiles/coder → root = /root, active_profile at /root/active_profile
		const root = makeRoot();
		const profileDir = path.join(root, "profiles", "coder");
		fs.mkdirSync(profileDir, { recursive: true });
		fs.writeFileSync(path.join(root, "active_profile"), "from-root\n");
		expect(resolveActiveHermesProfile(profileDir)).toBe("from-root");
	});
});

describe("resolveCreationProfile", () => {
	const originalEnv = { ...process.env };
	const tmpDirs: string[] = [];

	afterEach(() => {
		process.env = { ...originalEnv };
		for (const dir of tmpDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-create-"));
		tmpDirs.push(root);
		return root;
	}

	it("project profile wins over everything (canonicalised)", () => {
		expect(resolveCreationProfile("Project-Profile")).toBe("project-profile");
	});

	it("falls back to HERMES_HOME profile when project profile absent", () => {
		expect(resolveCreationProfile(undefined, "/root/profiles/coder")).toBe(
			"coder",
		);
	});

	it("falls back to active Hermes profile when no HERMES_HOME profile", () => {
		const root = makeRoot();
		fs.writeFileSync(path.join(root, "active_profile"), "active-profile\n");
		expect(resolveCreationProfile(undefined, root)).toBe("active-profile");
	});

	it("returns default when nothing else is set", () => {
		expect(resolveCreationProfile()).toBe("default");
	});

	it("canonicalises project profile (lowercase, trim)", () => {
		expect(resolveCreationProfile("  My-Profile  ")).toBe("my-profile");
	});

	it("canonicalises HERMES_HOME profile", () => {
		expect(resolveCreationProfile(undefined, "/root/profiles/My-Profile")).toBe(
			"my-profile",
		);
	});

	it("rejects invalid project profile (throws)", () => {
		expect(() => resolveCreationProfile("../evil")).toThrow("path traversal");
	});

	it("rejects invalid HERMES_HOME profile (throws)", () => {
		expect(() =>
			resolveCreationProfile(undefined, "/root/profiles/../evil"),
		).toThrow("path traversal");
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
