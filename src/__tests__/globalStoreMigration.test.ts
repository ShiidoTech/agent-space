import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	GlobalStore,
	migrateLegacyExtensionStorage,
} from "../storage/globalStore";

const tempDirs: string[] = [];

function makeStorageRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-space-storage-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("migrateLegacyExtensionStorage", () => {
	it("copies the complete legacy storage into a fresh publisher directory", () => {
		const root = makeStorageRoot();
		const legacyDir = path.join(root, "paql4711.agent-space");
		const currentDir = path.join(root, "ShiidoTech.agent-space");

		fs.mkdirSync(path.join(legacyDir, "projects", "project-1"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(legacyDir, "projects.json"),
			JSON.stringify([{ id: "project-1" }]),
		);
		fs.writeFileSync(
			path.join(legacyDir, "preferences.json"),
			JSON.stringify({ defaultTool: "codex" }),
		);
		fs.writeFileSync(
			path.join(legacyDir, "projects", "project-1", "features.json"),
			JSON.stringify([{ id: "feature-1" }]),
		);

		expect(migrateLegacyExtensionStorage(currentDir)).toBe(legacyDir);
		expect(
			fs.readFileSync(path.join(currentDir, "projects.json"), "utf-8"),
		).toContain("project-1");
		expect(
			fs.readFileSync(
				path.join(currentDir, "projects", "project-1", "features.json"),
				"utf-8",
			),
		).toContain("feature-1");
	});

	it("never overwrites storage already owned by the new extension identity", () => {
		const root = makeStorageRoot();
		const legacyDir = path.join(root, "paql4711.agent-space");
		const currentDir = path.join(root, "ShiidoTech.agent-space");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.mkdirSync(currentDir, { recursive: true });
		fs.writeFileSync(path.join(legacyDir, "projects.json"), "legacy");
		fs.writeFileSync(path.join(currentDir, "projects.json"), "current");

		expect(migrateLegacyExtensionStorage(currentDir)).toBeNull();
		expect(
			fs.readFileSync(path.join(currentDir, "projects.json"), "utf-8"),
		).toBe("current");
	});

	it("does nothing when no legacy storage exists", () => {
		const root = makeStorageRoot();
		const currentDir = path.join(root, "ShiidoTech.agent-space");

		expect(migrateLegacyExtensionStorage(currentDir)).toBeNull();
		expect(fs.existsSync(currentDir)).toBe(false);
	});

	it("can read without migrating legacy storage", () => {
		const root = makeStorageRoot();
		const legacyDir = path.join(root, "paql4711.agent-space");
		const currentDir = path.join(root, "ShiidoTech.agent-space");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, "projects.json"),
			JSON.stringify([{ id: "legacy-project" }]),
		);

		const store = new GlobalStore(currentDir, { migrateLegacy: false });

		expect(store.getProjects()).toEqual([]);
		expect(fs.existsSync(currentDir)).toBe(false);
	});
});
