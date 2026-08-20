import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	hasLocalProjectConfig,
	hasSharedProjectConfig,
	loadProjectConfig,
	loadSharedProjectConfig,
	mergeProjectConfig,
	type ProjectConfig,
	projectConfigTemplate,
	pruneEmptyConfig,
	replaceProjectConfig,
	saveProjectConfig,
} from "../projects/projectConfig";

const tempDirs: string[] = [];

/** A repo carrying the committed config, and optionally the local overlay. */
function repo(shared?: ProjectConfig, local?: ProjectConfig): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspace-config-"));
	tempDirs.push(root);
	const dir = path.join(root, ".agentspace");
	fs.mkdirSync(dir, { recursive: true });
	if (shared) {
		fs.writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify(shared, null, 2),
		);
	}
	if (local) {
		fs.writeFileSync(
			path.join(dir, "config.local.json"),
			JSON.stringify(local, null, 2),
		);
	}
	return root;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("mergeProjectConfig", () => {
	it("adds the machine's agents to the shared allowlist instead of replacing it", () => {
		// The overlay exists so a personal profile can be used on a curated
		// project. Letting it replace `enabled` would silently drop the agents the
		// team agreed on, which is the opposite of the intent.
		const merged = mergeProjectConfig(
			{ agents: { enabled: ["codex", "opencode"] } },
			{ agents: { enabled: ["claude-perso"] } },
		);

		expect(merged.agents?.enabled).toEqual([
			"codex",
			"opencode",
			"claude-perso",
		]);
	});

	it("does not duplicate an agent both files enable", () => {
		const merged = mergeProjectConfig(
			{ agents: { enabled: ["codex"] } },
			{ agents: { enabled: ["codex", "claude-perso"] } },
		);

		expect(merged.agents?.enabled).toEqual(["codex", "claude-perso"]);
	});

	it("lets the machine override the preferred agent outright", () => {
		const merged = mergeProjectConfig(
			{ agents: { enabled: ["codex"], default: "codex" } },
			{ agents: { enabled: ["claude-perso"], default: "claude-perso" } },
		);

		expect(merged.agents?.default).toBe("claude-perso");
	});

	it("overrides plain settings rather than merging them", () => {
		const merged = mergeProjectConfig(
			{ baseBranch: "main", branchKinds: ["feature", "fix"] },
			{ branchKinds: ["spike"] },
		);

		expect(merged.baseBranch).toBe("main");
		expect(merged.branchKinds).toEqual(["spike"]);
	});
});

describe("loadProjectConfig", () => {
	it("applies the overlay on top of the committed conventions", () => {
		const root = repo(
			{ baseBranch: "main", agents: { enabled: ["codex"] } },
			{ agents: { enabled: ["claude-perso"], default: "claude-perso" } },
		);

		const effective = loadProjectConfig(root);

		expect(effective.baseBranch).toBe("main");
		expect(effective.agents?.enabled).toEqual(["codex", "claude-perso"]);
		expect(effective.agents?.default).toBe("claude-perso");
	});

	it("reads the committed file alone when no overlay exists", () => {
		const root = repo({ baseBranch: "main", agents: { enabled: ["codex"] } });

		expect(loadProjectConfig(root).agents?.enabled).toEqual(["codex"]);
		expect(hasLocalProjectConfig(root)).toBe(false);
	});

	it("works from an overlay alone, with no committed config", () => {
		const root = repo(undefined, { agents: { default: "claude-perso" } });

		expect(loadProjectConfig(root).agents?.default).toBe("claude-perso");
		expect(hasLocalProjectConfig(root)).toBe(true);
	});

	it("ignores an unparseable overlay rather than losing the shared config", () => {
		const root = repo({ baseBranch: "main" });
		fs.writeFileSync(
			path.join(root, ".agentspace", "config.local.json"),
			"{ not json",
		);

		expect(loadProjectConfig(root).baseBranch).toBe("main");
	});
});

describe("saveProjectConfig", () => {
	it("never writes the machine-local overlay into the committed file", () => {
		// The failure this guards is quiet and only visible to other people: a
		// personal CLI profile committed into everyone's checkout, where it
		// resolves to no installed command.
		const root = repo(
			{ baseBranch: "main", agents: { enabled: ["codex"] } },
			{ agents: { enabled: ["claude-perso"], default: "claude-perso" } },
		);

		saveProjectConfig(root, { baseBranch: "develop" });

		const committed = loadSharedProjectConfig(root);
		expect(committed.baseBranch).toBe("develop");
		expect(committed.agents?.enabled).toEqual(["codex"]);
		expect(committed.agents?.default).toBeUndefined();
	});

	it("returns the effective config, overlay included", () => {
		// Callers install the result as the running config, so handing back only
		// the committed half would drop the overlay until the next reload.
		const root = repo(
			{ baseBranch: "main", agents: { enabled: ["codex"] } },
			{ agents: { default: "claude-perso" } },
		);

		const effective = saveProjectConfig(root, { baseBranch: "develop" });

		expect(effective.baseBranch).toBe("develop");
		expect(effective.agents?.default).toBe("claude-perso");
	});
});

describe("pruneEmptyConfig", () => {
	it("drops the untouched discovery template so nothing but chosen values persists", () => {
		const cleaned = pruneEmptyConfig({
			baseBranch: "develop",
			branchKinds: null,
			defaultBranchKind: null,
			worktreesDir: null,
			bootstrapCommands: null,
			agents: { enabled: null, default: null },
			knowledge: { instructions: null, runbooks: null },
		});

		expect(cleaned).toEqual({ baseBranch: "develop" });
	});

	it("keeps nested objects that carry at least one real value", () => {
		const cleaned = pruneEmptyConfig({
			baseBranch: null,
			agents: { enabled: ["codex"], default: null },
			knowledge: { instructions: ["AGENTS.md"], runbooks: [] },
		});

		expect(cleaned).toEqual({
			agents: { enabled: ["codex"] },
			knowledge: { instructions: ["AGENTS.md"], runbooks: [] },
		});
	});

	it("preserves an explicitly empty agents.enabled (zero tools) instead of pruning it", () => {
		// `agents.enabled: []` disables every agent; omitting the key exposes all
		// of them. Collapsing the two would turn a locked-down project into an
		// open one on the next save.
		const cleaned = pruneEmptyConfig({ agents: { enabled: [] } });

		expect(cleaned).toEqual({ agents: { enabled: [] } });
	});

	it("collapses an untouched template to an empty config", () => {
		expect(pruneEmptyConfig(projectConfigTemplate())).toEqual({});
	});
});

describe("project settings editor — shared-based, non-destructive", () => {
	it("(a) a single-field edit on a project with no shared config persists only that field", () => {
		// The editor shows the discovery template (empty placeholders). Editing
		// only baseBranch then saving must not write the untouched placeholder
		// keys into .agentspace/config.json.
		const root = repo();
		expect(hasSharedProjectConfig(root)).toBe(false);

		const edited = pruneEmptyConfig({
			...projectConfigTemplate(),
			baseBranch: "develop",
		});
		replaceProjectConfig(root, edited);

		expect(loadSharedProjectConfig(root)).toEqual({ baseBranch: "develop" });
	});

	it("(b) a local overlay does not leak into the shared file, nor block the template", () => {
		// With only .agentspace/config.local.json and no config.json, the editor
		// must not display (nor later write) the machine-local values. Saving the
		// shared file must leave the overlay untouched.
		const root = repo(undefined, { agents: { default: "claude-perso" } });

		expect(hasSharedProjectConfig(root)).toBe(false);
		expect(loadSharedProjectConfig(root)).toEqual({});

		replaceProjectConfig(root, { baseBranch: "main" });

		expect(loadSharedProjectConfig(root)).toEqual({ baseBranch: "main" });
		expect(loadProjectConfig(root).agents?.default).toBe("claude-perso");
	});
});
