import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadProjectConfig,
	type ProjectConfig,
} from "../projects/projectConfig";
import {
	buildProjectKnowledgeLaunchNote,
	discoverProjectKnowledge,
	parseRunbookFrontMatter,
	RUNBOOKS_DIR_RELATIVE_PATH,
} from "../projects/projectKnowledge";

const tempDirs: string[] = [];

function repo(
	config?: ProjectConfig,
	files: Record<string, string> = {},
): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspace-knowledge-"));
	tempDirs.push(root);
	const dir = path.join(root, ".agentspace");
	fs.mkdirSync(dir, { recursive: true });
	if (config) {
		fs.writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify(config, null, 2),
		);
	}
	for (const [relative, content] of Object.entries(files)) {
		const absolute = path.join(root, relative);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, content);
	}
	return root;
}

function runbookFile(title: string, commands: string[]): string {
	return [
		"---",
		`title: ${title}`,
		"canonical: true",
		"commands:",
		...commands.map((c) => `  - ${c}`),
		"---",
		"",
		"# Body",
	].join("\n");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("discoverProjectKnowledge", () => {
	it("reports an empty project as having no knowledge", () => {
		const root = repo();

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.hasKnowledge).toBe(false);
		expect(knowledge.instructions).toHaveLength(1); // AGENTS.md is conventional
		expect(knowledge.instructions[0].exists).toBe(false);
		expect(knowledge.runbooks).toHaveLength(0);
		expect(knowledge.problems).toHaveLength(0);
	});

	it("discovers the conventional AGENTS.md instruction", () => {
		const root = repo({}, { "AGENTS.md": "# Agent Space" });

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.hasKnowledge).toBe(true);
		const instruction = knowledge.instructions.find(
			(i) => i.relativePath === "AGENTS.md",
		);
		expect(instruction?.exists).toBe(true);
		expect(instruction?.source).toBe("conventional");
		expect(knowledge.problems).toHaveLength(0);
	});

	it("reports a declared instruction that is missing", () => {
		const root = repo({
			knowledge: { instructions: ["docs/CONTRIBUTING.md"] },
		});

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.hasKnowledge).toBe(true);
		expect(knowledge.problems).toEqual([
			expect.objectContaining({
				kind: "missing-instruction",
				reference: "docs/CONTRIBUTING.md",
			}),
		]);
	});

	it("discovers runbooks dropped in .agentspace/runbooks", () => {
		const root = repo(
			{},
			{
				[`${RUNBOOKS_DIR_RELATIVE_PATH}/local-extension-test.md`]: runbookFile(
					"Local extension test",
					["npm run typecheck", "npm run package"],
				),
			},
		);

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.runbooks).toHaveLength(1);
		const runbook = knowledge.runbooks[0];
		expect(runbook.id).toBe("local-extension-test");
		expect(runbook.title).toBe("Local extension test");
		expect(runbook.commands).toEqual(["npm run typecheck", "npm run package"]);
		expect(runbook.canonical).toBe(true);
		expect(runbook.exists).toBe(true);
		expect(runbook.source).toBe("discovered");
		expect(knowledge.problems).toHaveLength(0);
	});

	it("flags a declared runbook (array form) that is missing", () => {
		const root = repo({
			knowledge: {
				runbooks: [".agentspace/runbooks/gone.md"],
			},
		});

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.problems).toEqual([
			expect.objectContaining({
				kind: "missing-runbook",
				reference: ".agentspace/runbooks/gone.md",
			}),
		]);
		expect(knowledge.runbooks).toHaveLength(1);
		expect(knowledge.runbooks[0].exists).toBe(false);
	});

	it("honors explicit ids for declared runbooks (map form)", () => {
		const root = repo(
			{
				knowledge: {
					runbooks: {
						"local-test": ".agentspace/runbooks/local-extension-test.md",
					},
				},
			},
			{
				[`${RUNBOOKS_DIR_RELATIVE_PATH}/local-extension-test.md`]: runbookFile(
					"Local extension test",
					[],
				),
			},
		);

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.runbooks).toHaveLength(1);
		expect(knowledge.runbooks[0].id).toBe("local-test");
		expect(knowledge.problems).toHaveLength(0);
	});

	it("rejects a knowledge field that is not an object", () => {
		const root = repo({
			knowledge: ["AGENTS.md"],
		} as unknown as ProjectConfig);

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.problems).toEqual([
			expect.objectContaining({
				kind: "invalid-knowledge-field",
				reference: "knowledge",
			}),
		]);
	});

	it("rejects runbooks declared in a shape that is neither array nor object", () => {
		const root = repo({
			knowledge: { runbooks: ".agentspace/runbooks/x.md" },
		} as unknown as ProjectConfig);

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.problems).toEqual([
			expect.objectContaining({
				kind: "invalid-knowledge-field",
				reference: "knowledge.runbooks",
			}),
		]);
	});

	it("does not duplicate a runbook that is both declared and discovered", () => {
		const root = repo(
			{
				knowledge: {
					runbooks: [".agentspace/runbooks/local-extension-test.md"],
				},
			},
			{
				[`${RUNBOOKS_DIR_RELATIVE_PATH}/local-extension-test.md`]: runbookFile(
					"Local extension test",
					[],
				),
			},
		);

		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(knowledge.runbooks).toHaveLength(1);
		expect(knowledge.runbooks[0].source).toBe("declared");
		expect(knowledge.problems).toHaveLength(0);
	});
});

describe("parseRunbookFrontMatter", () => {
	it("parses title, commands and canonical status", () => {
		const parsed = parseRunbookFrontMatter(
			runbookFile("Local extension test", ["npm run typecheck"]),
		);

		expect(parsed).toEqual({
			title: "Local extension test",
			commands: ["npm run typecheck"],
			canonical: true,
		});
	});

	it("returns defaults when there is no front matter block", () => {
		expect(parseRunbookFrontMatter("# Just a heading\n\nbody")).toEqual({});
	});

	it("treats a troubleshooting-only runbook as non-canonical", () => {
		const content = [
			"---",
			"title: IPC workaround",
			"canonical: false",
			"---",
			"",
			"# body",
		].join("\n");

		expect(parseRunbookFrontMatter(content).canonical).toBe(false);
	});
});

describe("buildProjectKnowledgeLaunchNote", () => {
	it("returns undefined when the project carries no knowledge", () => {
		const root = repo();
		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		expect(buildProjectKnowledgeLaunchNote(knowledge)).toBeUndefined();
	});

	it("lists available instructions and runbooks", () => {
		const root = repo(
			{
				knowledge: {
					runbooks: [".agentspace/runbooks/local-extension-test.md"],
				},
			},
			{
				"AGENTS.md": "# Agent Space",
				[`${RUNBOOKS_DIR_RELATIVE_PATH}/local-extension-test.md`]: runbookFile(
					"Local extension test",
					["npm run package"],
				),
			},
		);
		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		const note = buildProjectKnowledgeLaunchNote(knowledge);

		expect(note).toBeDefined();
		expect(note).toContain("AGENTS.md");
		expect(note).toContain("local-extension-test.md (Local extension test)");
		expect(note).not.toContain("PROBLEM");
	});

	it("surfaces knowledge problems visibly", () => {
		const root = repo({
			knowledge: {
				runbooks: [".agentspace/runbooks/gone.md"],
			},
		});
		const knowledge = discoverProjectKnowledge(root, loadProjectConfig(root));

		const note = buildProjectKnowledgeLaunchNote(knowledge);

		expect(note).toContain("PROBLEM .agentspace/runbooks/gone.md");
		expect(note).toContain("missing");
	});
});
