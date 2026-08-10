import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectConfig } from "./projectConfig";

/**
 * Project-level operational knowledge: canonical agent instructions and runbooks.
 *
 * Agent Space deliberately keeps the source of truth in the repository rather
 * than in a provider's private memory. Two kinds of files live under the repo:
 *
 * - canonical instructions (conventionally `AGENTS.md`, optionally more), meant
 *   to hold project invariants that are true for every agent;
 * - runbooks (`.agentspace/runbooks/*.md`), deterministic procedures for
 *   recurring workflows (validate, package, install, preview…).
 *
 * `config.json` may declare them explicitly so the launch context and Doctor can
 * fail visibly when a declared file is missing instead of silently ignoring it.
 */
export const DEFAULT_INSTRUCTION_RELATIVE_PATH = "AGENTS.md";
export const RUNBOOKS_DIR_RELATIVE_PATH = ".agentspace/runbooks";

export type KnowledgeSource = "conventional" | "declared" | "discovered";

export interface ProjectKnowledgeProblem {
	kind: "invalid-knowledge-field" | "missing-instruction" | "missing-runbook";
	/** The declared reference that is problematic (config path or id). */
	reference: string;
	detail: string;
}

export interface ProjectInstruction {
	id: string;
	relativePath: string;
	absolutePath: string;
	exists: boolean;
	source: KnowledgeSource;
}

export interface ProjectRunbook {
	/** Stable reference used by the launch context, config and Doctor. */
	id: string;
	relativePath: string;
	absolutePath: string;
	exists: boolean;
	/** Human title from front matter, falling back to the id. */
	title: string;
	/** Deterministic commands declared in front matter, in canonical order. */
	commands: string[];
	/**
	 * true = known-good validated procedure; false = troubleshooting notes only;
	 * null when the runbook does not declare its status.
	 */
	canonical: boolean | null;
	source: KnowledgeSource;
}

export interface ProjectKnowledge {
	instructions: ProjectInstruction[];
	runbooks: ProjectRunbook[];
	/** Reasons the knowledge layer cannot be trusted, surfaced by Doctor/launch. */
	problems: ProjectKnowledgeProblem[];
	/** True when the project carries knowledge (or a declared reference broke). */
	hasKnowledge: boolean;
}

function fileExists(target: string): boolean {
	try {
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

function isReadable(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeRelativePath(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return raw.trim().replace(/^\.\//, "");
}

function runbookIdFromPath(relativePath: string): string {
	const base = path.basename(relativePath).replace(/\.md$/i, "");
	const slug = base.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
	return slug || base;
}

function humanizeTitle(id: string): string {
	return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function toBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) {
		return value.trim().toLowerCase() === "true";
	}
	return null;
}

/**
 * Minimal front-matter parser for runbooks. Only `title`, `canonical` and
 * `commands` are understood; anything else is left to the markdown body. It is
 * intentionally not a general YAML parser — a malformed block degrades to
 * defaults rather than hiding a bad paragraph behind a parse error.
 */
export function parseRunbookFrontMatter(content: string): {
	title?: string;
	commands?: string[];
	canonical?: boolean;
} {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\n|$)/.exec(content);
	if (!match) return {};

	const result: { title?: string; commands?: string[]; canonical?: boolean } =
		{};
	let listKey: string | null = null;

	for (const rawLine of match[1].split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		if (listKey && /^-\s+/.test(line)) {
			const value = line
				.slice(1)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (listKey === "commands") {
				result.commands = result.commands ?? [];
				result.commands.push(value);
			}
			continue;
		}

		listKey = null;
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (!key) continue;

		const unquoted = value.replace(/^["']|["']$/g, "");
		if (key === "title") {
			result.title = unquoted;
		} else if (key === "canonical") {
			const parsed = toBoolean(value);
			if (parsed !== null) result.canonical = parsed;
		} else if (key === "commands") {
			result.commands = [];
			listKey = key;
		}
	}

	return result;
}

function readRunbookFile(
	relativePath: string,
	absolutePath: string,
	source: KnowledgeSource,
): ProjectRunbook {
	const id = runbookIdFromPath(relativePath);
	try {
		const content = fs.readFileSync(absolutePath, "utf-8");
		const frontMatter = parseRunbookFrontMatter(content);
		return {
			id,
			relativePath,
			absolutePath,
			exists: true,
			title: frontMatter.title ?? humanizeTitle(id),
			commands: frontMatter.commands ?? [],
			canonical: frontMatter.canonical ?? null,
			source,
		};
	} catch {
		return {
			id,
			relativePath,
			absolutePath,
			exists: false,
			title: humanizeTitle(id),
			commands: [],
			canonical: null,
			source,
		};
	}
}

function collectDeclaredRunbooks(
	repoRoot: string,
	declaredRunbooks: unknown,
	problems: ProjectKnowledgeProblem[],
): Map<string, ProjectRunbook> {
	const byPath = new Map<string, ProjectRunbook>();

	if (Array.isArray(declaredRunbooks)) {
		for (const raw of declaredRunbooks) {
			const relativePath = normalizeRelativePath(raw);
			if (!relativePath) {
				problems.push({
					kind: "invalid-knowledge-field",
					reference: "knowledge.runbooks",
					detail: "each runbook reference must be a relative file path",
				});
				continue;
			}
			const absolutePath = path.resolve(repoRoot, relativePath);
			const runbook = readRunbookFile(relativePath, absolutePath, "declared");
			if (!runbook.exists || !isReadable(absolutePath)) {
				problems.push({
					kind: "missing-runbook",
					reference: relativePath,
					detail: `declared runbook \`${relativePath}\` is missing in ${repoRoot}`,
				});
			}
			byPath.set(absolutePath, runbook);
		}
		return byPath;
	}

	if (declaredRunbooks === undefined || declaredRunbooks === null) {
		return byPath;
	}

	if (typeof declaredRunbooks !== "object") {
		problems.push({
			kind: "invalid-knowledge-field",
			reference: "knowledge.runbooks",
			detail:
				"`knowledge.runbooks` must be an array of paths or an object of id → path",
		});
		return byPath;
	}

	for (const [id, raw] of Object.entries(
		declaredRunbooks as Record<string, unknown>,
	)) {
		const relativePath = normalizeRelativePath(raw);
		if (!relativePath) {
			problems.push({
				kind: "invalid-knowledge-field",
				reference: `knowledge.runbooks.${id}`,
				detail: `runbook \`${id}\` must reference a relative file path`,
			});
			continue;
		}
		const absolutePath = path.resolve(repoRoot, relativePath);
		const runbook = readRunbookFile(relativePath, absolutePath, "declared");
		if (!runbook.exists || !isReadable(absolutePath)) {
			problems.push({
				kind: "missing-runbook",
				reference: id,
				detail: `declared runbook \`${id}\` (\`${relativePath}\`) is missing in ${repoRoot}`,
			});
		}
		runbook.id = id;
		byPath.set(absolutePath, runbook);
	}

	return byPath;
}

/**
 * Resolve and validate the project's operational knowledge.
 *
 * Read-only and provider-agnostic: the files are the source of truth, whatever
 * CLI runs inside the worktree reads them the same way any human or agent can.
 * Declared references that cannot be resolved are returned as `problems` so the
 * launch context and Doctor can make them visible instead of ignoring them.
 */
export function discoverProjectKnowledge(
	repoRoot: string,
	config: ProjectConfig = {},
): ProjectKnowledge {
	const instructions: ProjectInstruction[] = [];
	const problems: ProjectKnowledgeProblem[] = [];

	const knowledge = config.knowledge;
	if (knowledge !== undefined) {
		if (
			typeof knowledge !== "object" ||
			knowledge === null ||
			Array.isArray(knowledge)
		) {
			problems.push({
				kind: "invalid-knowledge-field",
				reference: "knowledge",
				detail: "`knowledge` in .agentspace/config.json must be an object",
			});
		} else if (
			knowledge.instructions !== undefined &&
			!Array.isArray(knowledge.instructions)
		) {
			problems.push({
				kind: "invalid-knowledge-field",
				reference: "knowledge.instructions",
				detail:
					"`knowledge.instructions` must be an array of relative file paths",
			});
		}
	}

	// ── Instructions ────────────────────────────────────────────────
	const declaredInstructionSet = new Set<string>();
	for (const raw of knowledge?.instructions ?? []) {
		const normalized = normalizeRelativePath(raw);
		if (normalized) declaredInstructionSet.add(normalized);
	}

	const seenInstructions = new Set<string>();
	for (const relativePath of [
		DEFAULT_INSTRUCTION_RELATIVE_PATH,
		...declaredInstructionSet,
	]) {
		const normalized = normalizeRelativePath(relativePath);
		if (!normalized || seenInstructions.has(normalized)) continue;
		seenInstructions.add(normalized);

		const absolutePath = path.resolve(repoRoot, normalized);
		const exists = fileExists(absolutePath);
		const source: KnowledgeSource =
			normalized === DEFAULT_INSTRUCTION_RELATIVE_PATH
				? "conventional"
				: "declared";

		if (!exists && declaredInstructionSet.has(normalized)) {
			problems.push({
				kind: "missing-instruction",
				reference: normalized,
				detail: `declared instruction \`${normalized}\` is missing in ${repoRoot}`,
			});
		}

		instructions.push({
			id: normalized,
			relativePath: normalized,
			absolutePath,
			exists,
			source,
		});
	}

	// ── Runbooks: discover then apply declared references ───────────
	const discoveredRunbooks = new Map<string, ProjectRunbook>(); // absPath → entry
	const runbooksDir = path.resolve(repoRoot, RUNBOOKS_DIR_RELATIVE_PATH);
	try {
		if (fs.statSync(runbooksDir).isDirectory()) {
			for (const entry of fs.readdirSync(runbooksDir)) {
				if (!entry.toLowerCase().endsWith(".md")) continue;
				const relativePath = `${RUNBOOKS_DIR_RELATIVE_PATH}/${entry}`;
				const absolutePath = path.resolve(runbooksDir, entry);
				discoveredRunbooks.set(
					absolutePath,
					readRunbookFile(relativePath, absolutePath, "discovered"),
				);
			}
		}
	} catch {
		// No runbooks directory — nothing to discover.
	}

	const declaredRunbooks = collectDeclaredRunbooks(
		repoRoot,
		knowledge?.runbooks,
		problems,
	);

	// Declared entries win (explicit id), then fill with discovered files.
	const runbooks = new Map<string, ProjectRunbook>();
	for (const runbook of declaredRunbooks.values()) {
		runbooks.set(runbook.absolutePath, runbook);
	}
	for (const runbook of discoveredRunbooks.values()) {
		if (!runbooks.has(runbook.absolutePath)) {
			runbooks.set(runbook.absolutePath, runbook);
		}
	}

	return {
		instructions,
		runbooks: [...runbooks.values()],
		problems,
		hasKnowledge:
			instructions.some((i) => i.exists) ||
			[...runbooks.values()].some((r) => r.exists) ||
			problems.length > 0,
	};
}

/**
 * Build the launch-context note shown in a newly started agent's terminal.
 *
 * Lists exactly which project instructions and runbooks were made available,
 * and surfaces any knowledge problem visibly. Returns undefined when a project
 * declares no knowledge at all, keeping legacy projects banner-free.
 */
export function buildProjectKnowledgeLaunchNote(
	knowledge: ProjectKnowledge,
): string | undefined {
	if (!knowledge.hasKnowledge) return undefined;

	const lines = [
		"Agent Space — project operational knowledge for this session:",
	];
	const availableInstructions = knowledge.instructions.filter((i) => i.exists);
	const availableRunbooks = knowledge.runbooks.filter((r) => r.exists);

	if (availableInstructions.length > 0) {
		lines.push(
			`  instructions: ${availableInstructions
				.map((i) => i.relativePath)
				.join(", ")}`,
		);
	}
	if (availableRunbooks.length > 0) {
		lines.push(
			`  runbooks: ${availableRunbooks
				.map((r) => `${r.relativePath} (${r.title})`)
				.join(", ")}`,
		);
	}
	if (availableInstructions.length === 0 && availableRunbooks.length === 0) {
		lines.push("  none physically present in this checkout");
	}
	for (const problem of knowledge.problems) {
		lines.push(`  PROBLEM ${problem.reference}: ${problem.detail}`);
	}
	lines.push(
		"Prefer these canonical project procedures over reconstructed commands.",
	);

	return lines.join("\n");
}
