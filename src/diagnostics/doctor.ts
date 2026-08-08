import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodingTool, Project } from "../types";
import { commandExists, exec, execSilent } from "../utils/platform";

export type DoctorLevel = "ok" | "info" | "warn" | "error";

export interface DoctorCheck {
	level: DoctorLevel;
	label: string;
	detail: string;
	remediation?: string;
}

export interface DoctorReport {
	markdown: string;
	checks: DoctorCheck[];
	errors: number;
	warnings: number;
}

export interface DoctorInput {
	extensionId: string;
	extensionVersion: string;
	projects: Project[];
	tools: CodingTool[];
	defaultToolId?: string;
	worktreeBasePath: string;
	perAgentIsolation: boolean;
	syncSessionNames: boolean;
	homeDir?: string;
}

export interface ProjectConfigProbe {
	exists: boolean;
	valid: boolean;
	config?: {
		baseBranch?: string;
		branchKinds?: string[];
		defaultBranchKind?: string;
		worktreesDir?: string;
	};
	error?: string;
}

export interface DoctorDeps {
	commandExists(command: string): boolean;
	commandVersion(command: "git" | "tmux"): string | null;
	pathReadable(targetPath: string): boolean;
	readProjectConfig(repoPath: string): ProjectConfigProbe;
	isGitRepo(repoPath: string): boolean;
	currentBranch(repoPath: string): string | null;
	branchExists(repoPath: string, branch: string): boolean;
	worktreeCount(repoPath: string): number | null;
}

const iconFor: Record<DoctorLevel, string> = {
	ok: "✅",
	info: "ℹ️",
	warn: "⚠️",
	error: "❌",
};

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultReadProjectConfig(repoPath: string): ProjectConfigProbe {
	const filePath = path.join(repoPath, ".agentspace", "config.json");
	if (!fs.existsSync(filePath)) {
		return { exists: false, valid: true, config: {} };
	}

	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				exists: true,
				valid: false,
				error: "config.json must contain a JSON object",
			};
		}
		const config = parsed as Record<string, unknown>;
		if (
			(config.baseBranch !== undefined && typeof config.baseBranch !== "string") ||
			(config.defaultBranchKind !== undefined &&
				typeof config.defaultBranchKind !== "string") ||
			(config.worktreesDir !== undefined && typeof config.worktreesDir !== "string") ||
			(config.branchKinds !== undefined &&
				(!Array.isArray(config.branchKinds) ||
					config.branchKinds.some((kind) => typeof kind !== "string")))
		) {
			return {
				exists: true,
				valid: false,
				error: "config.json contains fields with invalid types",
			};
		}
		return { exists: true, valid: true, config: parsed };
	} catch (error) {
		return {
			exists: true,
			valid: false,
			error: error instanceof Error ? error.message : "invalid JSON",
		};
	}
}

export const defaultDoctorDeps: DoctorDeps = {
	commandExists,
	commandVersion(command) {
		try {
			return exec(`${command} --version`).trim().split("\n")[0] || null;
		} catch {
			return null;
		}
	},
	pathReadable(targetPath) {
		try {
			fs.accessSync(targetPath, fs.constants.R_OK);
			return true;
		} catch {
			return false;
		}
	},
	readProjectConfig: defaultReadProjectConfig,
	isGitRepo(repoPath) {
		return execSilent("git rev-parse --is-inside-work-tree", { cwd: repoPath });
	},
	currentBranch(repoPath) {
		try {
			return exec("git rev-parse --abbrev-ref HEAD", { cwd: repoPath }).trim() || null;
		} catch {
			return null;
		}
	},
	branchExists(repoPath, branch) {
		const local = `refs/heads/${branch}`;
		const remote = `refs/remotes/origin/${branch}`;
		return (
			execSilent(`git show-ref --verify --quiet ${shellQuote(local)}`, {
				cwd: repoPath,
			}) ||
			execSilent(`git show-ref --verify --quiet ${shellQuote(remote)}`, {
				cwd: repoPath,
			})
		);
	},
	worktreeCount(repoPath) {
		try {
			const output = exec("git worktree list --porcelain", { cwd: repoPath });
			return output
				.split("\n")
				.filter((line) => line.startsWith("worktree ")).length;
		} catch {
			return null;
		}
	},
};

function redactHome(value: string, homeDir: string): string {
	const normalizedHome = path.resolve(homeDir);
	const normalizedValue = path.resolve(value);
	if (normalizedValue === normalizedHome) return "~";
	if (normalizedValue.startsWith(`${normalizedHome}${path.sep}`)) {
		return `~${path.sep}${path.relative(normalizedHome, normalizedValue)}`;
	}
	return value;
}

function add(
	checks: DoctorCheck[],
	level: DoctorLevel,
	label: string,
	detail: string,
	remediation?: string,
): void {
	checks.push({ level, label, detail, remediation });
}

function renderSection(title: string, checks: DoctorCheck[]): string[] {
	if (checks.length === 0) return [];
	const lines = [`## ${title}`, ""];
	for (const check of checks) {
		lines.push(`${iconFor[check.level]} **${check.label}** — ${check.detail}`);
		if (check.remediation) {
			lines.push(`   - Fix: ${check.remediation}`);
		}
	}
	lines.push("");
	return lines;
}

export function runDoctor(
	input: DoctorInput,
	deps: DoctorDeps = defaultDoctorDeps,
): DoctorReport {
	const homeDir = input.homeDir ?? os.homedir();
	const systemChecks: DoctorCheck[] = [];
	const toolChecks: DoctorCheck[] = [];
	const projectChecks: DoctorCheck[] = [];
	const configChecks: DoctorCheck[] = [];

	const gitAvailable = deps.commandExists("git");
	if (gitAvailable) {
		add(
			systemChecks,
			"ok",
			"Git",
			deps.commandVersion("git") ?? "available (version unavailable)",
		);
	} else {
		add(systemChecks, "error", "Git", "not found on PATH", "Install Git and reload VS Code.");
	}

	const tmuxAvailable = deps.commandExists("tmux");
	if (tmuxAvailable) {
		add(
			systemChecks,
			"ok",
			"tmux",
			deps.commandVersion("tmux") ?? "available (version unavailable)",
		);
	} else {
		add(
			systemChecks,
			"error",
			"tmux",
			"not found on PATH",
			process.platform === "win32"
				? "Install tmux in Git Bash (for example: pacman -S tmux), then reload VS Code."
				: "Install tmux with your system package manager, then reload VS Code.",
		);
	}

	add(configChecks, "info", "Extension", `${input.extensionId} v${input.extensionVersion}`);
	add(
		configChecks,
		"info",
		"Worktree base",
		input.worktreeBasePath,
	);
	add(
		configChecks,
		"info",
		"Per-agent isolation",
		input.perAgentIsolation ? "enabled" : "disabled (shared feature worktree)",
	);
	add(
		configChecks,
		"info",
		"Session-name sync",
		input.syncSessionNames ? "enabled" : "disabled",
	);

	let availableToolCount = 0;
	for (const tool of input.tools) {
		const available = deps.commandExists(tool.command);
		if (available) availableToolCount += 1;
		add(
			toolChecks,
			available ? "ok" : tool.id === input.defaultToolId ? "error" : "warn",
			`${tool.name} (${tool.id})`,
			available
				? `command \`${tool.command}\` is available${tool.family ? `; family=${tool.family}` : ""}`
				: `command \`${tool.command}\` is not available`,
			available
				? undefined
				: tool.id === input.defaultToolId
					? "Install the configured default CLI or choose another agentSpace.defaultTool."
					: "Install the CLI or disable/remove this tool configuration if it is not used.",
		);

		if (tool.sessionsDir) {
			const expanded = tool.sessionsDir.startsWith("~")
				? path.join(homeDir, tool.sessionsDir.slice(1).replace(/^[/\\]/, ""))
				: tool.sessionsDir;
			const readable = deps.pathReadable(expanded);
			add(
				toolChecks,
				readable ? "ok" : "warn",
				`${tool.name} sessions`,
				`${redactHome(expanded, homeDir)} is ${readable ? "readable" : "missing or unreadable"}`,
				readable
					? undefined
					: "Check agentSpace.codingTools.sessionsDir and filesystem permissions.",
			);
		}
	}

	if (input.tools.length === 0 || availableToolCount === 0) {
		add(
			toolChecks,
			"error",
			"Coding CLI availability",
			"no configured coding CLI is currently available",
			"Install at least one coding CLI or fix agentSpace.codingTools.",
		);
	}

	if (input.defaultToolId && !input.tools.some((tool) => tool.id === input.defaultToolId)) {
		add(
			toolChecks,
			"error",
			"Default coding tool",
			`\`${input.defaultToolId}\` is configured but does not resolve to an enabled tool`,
			"Choose an enabled tool for agentSpace.defaultTool.",
		);
	}

	if (input.projects.length === 0) {
		add(projectChecks, "info", "Projects", "no projects are registered yet");
	}

	for (const project of input.projects) {
		const repoPath = redactHome(project.repoPath, homeDir);
		if (!deps.pathReadable(project.repoPath)) {
			add(
				projectChecks,
				"error",
				project.name,
				`${repoPath} is missing or unreadable`,
				"Restore the repository path or remove/re-add the project in Agent Space.",
			);
			continue;
		}

		if (!gitAvailable || !deps.isGitRepo(project.repoPath)) {
			add(
				projectChecks,
				"error",
				project.name,
				`${repoPath} is not a usable Git worktree`,
				gitAvailable
					? "Check the repository path and Git metadata."
					: "Install Git first, then rerun Doctor.",
			);
			continue;
		}

		const worktrees = deps.worktreeCount(project.repoPath);
		add(
			projectChecks,
			"ok",
			project.name,
			`${repoPath} is a Git repository${worktrees === null ? "" : `; ${worktrees} worktree${worktrees === 1 ? "" : "s"} registered`}`,
		);

		const config = deps.readProjectConfig(project.repoPath);
		if (!config.valid) {
			add(
				projectChecks,
				"error",
				`${project.name} config`,
				`.agentspace/config.json is invalid: ${config.error ?? "unknown parse error"}`,
				"Fix the JSON before relying on project-specific branching/worktree conventions.",
			);
			continue;
		}

		if (!config.exists) {
			add(
				projectChecks,
				"info",
				`${project.name} config`,
				"no .agentspace/config.json; Agent Space will use checkout-based defaults",
			);
		}

		const configuredBase =
			typeof config.config?.baseBranch === "string"
				? config.config.baseBranch.trim()
				: undefined;
		const effectiveBase = configuredBase || deps.currentBranch(project.repoPath);
		if (!effectiveBase) {
			add(
				projectChecks,
				"warn",
				`${project.name} base branch`,
				"could not determine an effective base branch",
				"Set baseBranch explicitly in .agentspace/config.json.",
			);
		} else if (configuredBase && !deps.branchExists(project.repoPath, configuredBase)) {
			add(
				projectChecks,
				"error",
				`${project.name} base branch`,
				`configured branch \`${configuredBase}\` was not found locally or at origin`,
				"Fetch the branch or correct baseBranch in .agentspace/config.json.",
			);
		} else {
			add(
				projectChecks,
				configuredBase ? "ok" : "info",
				`${project.name} base branch`,
				configuredBase
					? `configured base \`${configuredBase}\` exists`
					: `no explicit baseBranch; current checkout \`${effectiveBase}\` is the fallback`,
			);
		}
	}

	const checks = [
		...systemChecks,
		...configChecks,
		...toolChecks,
		...projectChecks,
	];
	const errors = checks.filter((check) => check.level === "error").length;
	const warnings = checks.filter((check) => check.level === "warn").length;
	const summary =
		errors === 0 && warnings === 0
			? "✅ Healthy — no problems detected."
			: `${errors > 0 ? `❌ ${errors} error${errors === 1 ? "" : "s"}` : "✅ 0 errors"}, ${warnings > 0 ? `⚠️ ${warnings} warning${warnings === 1 ? "" : "s"}` : "0 warnings"}.`;

	const markdown = [
		"# Agent Space Doctor",
		"",
		summary,
		"",
		"> Read-only diagnostics. Environment-variable values, CLI arguments and resume commands are intentionally omitted.",
		"",
		...renderSection("System", systemChecks),
		...renderSection("Agent Space", configChecks),
		...renderSection("Coding tools", toolChecks),
		...renderSection("Projects", projectChecks),
	].join("\n");

	return { markdown, checks, errors, warnings };
}
