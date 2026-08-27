import { describe, expect, it } from "vitest";
import {
	resolveCreationProfile,
	resolveHermesHome,
} from "../agents/hermesProfileResolver";

describe("Hermes profile parity contract", () => {
	it("explicit default resolves to the root even when HERMES_HOME carries another profile", () => {
		expect(resolveHermesHome("default", "/root/profiles/coder")).toBe("/root");
		expect(resolveHermesHome("Default", "/root/profiles/coder")).toBe("/root");
	});

	it("keeps an implicit HERMES_HOME profile when no explicit profile is supplied", () => {
		expect(resolveHermesHome(undefined, "/root/profiles/coder")).toBe(
			"/root/profiles/coder",
		);
	});

	it.each([
		"profile.3",
		"-profile",
		"_profile",
		"a".repeat(65),
		"hermes",
		"test",
		"tmp",
		"root",
		"sudo",
	])("rejects profile names Hermes itself rejects: %s", (profile) => {
		expect(() => resolveCreationProfile(profile)).toThrow(
			"Invalid Hermes profile name",
		);
		expect(() => resolveHermesHome(profile, "/root")).toThrow(
			"Invalid Hermes profile name",
		);
	});

	it("accepts the exact 64-character Hermes profile limit", () => {
		const profile = `a${"b".repeat(63)}`;
		expect(resolveCreationProfile(profile)).toBe(profile);
		expect(resolveHermesHome(profile, "/root")).toBe(
			`/root/profiles/${profile}`,
		);
	});
});
