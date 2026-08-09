import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_CONFIG_FILE_NAME } from "../projects/projectConfig";
import type { CodingTool, Project } from "../types";
import {
	commandExists,
	exec,
	execSilent,
	runtimeLabel,
	tmuxFunctional,
} from "../utils/platform";

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

/**
 * What Doctor needs to explain, for one persisted agent, why it does or does
 * not have a name and an attention signal.
 *
 * Everything here is resolved through the same code paths the running extension
 * uses, so a green Doctor means the runtime really can read that agent's
 * session — not that the checks were re-implemented optimistically.
 */
export interface DoctorAgentProbe {
	projectName: string;
	featureLabel: string;
	agentName: string;
	toolId: string;
	/** False when the agent's tool id resolves only through the unknown-tool fallback. */
	toolDeclared: boolean;
	/** Session store the provider will actually read, when it is file-backed. */
	sessionsDir?: string;
	sessionId: string | null;
	bindingState: string;
	bindingDetail?: string;
	bindingAttempts?: number;
	/** null when the provider exposes no session store to look in. */
	sessionResolved: boolean | null;
	attentionEvidence?: string;
}

/** A project agent id that is enabled in config but resolves to no known tool. */
export interface DoctorUnknownAgentIds {
	projectName: string;
	ids: string[];
}

export interface DoctorInput {
	extensionId: string;
	extensionVersion: string;
	remoteName?: string;
	projects: Project[];
	tools: CodingTool[];
	defaultToolId?: string;
	worktreeBasePath: string;
	persistencePath?: string;
	perAgentIsolation: boolean;
	syncSessionNames: boolean;
	homeDir?: string;
	agents?: DoctorAgentProbe[];
	unknownProjectAgentIds?: DoctorUnknownAgentIds[];
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
	/**
	 * The untracked `config.local.json` overlay, when present. Reported by the
	 * names of the settings it overrides and never by their values: the whole
	 * point of the file is to hold machine-local paths and personal profiles,
	 * and Doctor output gets pasted into issues. Its presence still has to be
	 * visible, because "the committed config says X but this machine does Y" is
	 * otherwise an invisible source of divergence.
	 */
	localOverlay?: { valid: boolean; keys: string[] };
}

export interface DoctorDeps {
	commandExists(command: string): boolean;
	commandVersion(command: "git" | "tmux"): string | null;
	commandFunctional?(command: "git" | "tmux"): boolean;
	pathReadable(targetPath: string): boolean;
	pathWritable?(targetPath: string): boolean;
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

function readLocalOverlay(
	repoPath: string,
): ProjectConfigProbe["localOverlay"] {
	const filePath = path.join(repoPath, ".agentspace", LOCAL_CONFIG_FILE_NAME);
	if (!fs.existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { valid: false, keys: [] };
		}
		return { valid: true, keys: Object.keys(parsed).sort() };
	} catch {
		return { valid: false, keys: [] };
	}
}

function defaultReadProjectConfig(repoPath: string): ProjectConfigProbe {
	const filePath = path.join(repoPath, ".agentspace", "config.json");
	const localOverlay = readLocalOverlay(repoPath);
	if (!fs.existsSync(filePath)) {
		return { exists: false, valid: true, config: {}, localOverlay };
	}

	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				exists: true,
				valid: false,
				error: "config.json must contain a JSON object",
				localOverlay,
			};
		}
		const config = parsed as Record<string, unknown>;
		if (
			(config.baseBranch !== undefined &&
				typeof config.baseBranch !== "string") ||
			(config.defaultBranchKind !== undefined &&
				typeof config.defaultBranchKind !== "string") ||
			(config.worktreesDir !== undefined &&
				typeof config.worktreesDir !== "string") ||
			(config.branchKinds !== undefined &&
				(!Array.isArray(config.branchKinds) ||
					config.branchKinds.some((kind) => typeof kind !== "string")))
		) {
			return {
				exists: true,
				valid: false,
				error: "config.json contains fields with invalid types",
				localOverlay,
			};
		}
		return { exists: true, valid: true, config: parsed, localOverlay };
	} catch (error) {
		return {
			exists: true,
			valid: false,
			error: error instanceof Error ? error.message : "invalid JSON",
			localOverlay,
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
	commandFunctional(command) {
		return command === "tmux" ? tmuxFunctional() : commandExists(command);
	},
	pathReadable(targetPath) {
		try {
			fs.accessSync(targetPath, fs.constants.R_OK);
			return true;
		} catch {
			return false;
		}
	},
	pathWritable(targetPath) {
		try {
			fs.accessSync(targetPath, fs.constants.W_OK);
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
			return (
				exec("git rev-parse --abbrev-ref HEAD", { cwd: repoPath }).trim() ||
				null
			);
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
			return output.split("\n").filter((line) => line.startsWith("worktree "))
				.length;
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

/**
 * Report, agent by agent, whether Agent Space can actually reach the provider
 * session behind it.
 *
 * This is the section that would have caught the whole class of failure it was
 * written for: a tool id enabled in project config but declared nowhere, a
 * session store resolved to the wrong home directory, and a session id that
 * exists in Agent Space's own storage and nowhere else. All three used to
 * render as a quiet agent with no name.
 */
function buildAgentChecks(input: DoctorInput, homeDir: string): DoctorCheck[] {
	const checks: DoctorCheck[] = [];

	for (const unknown of input.unknownProjectAgentIds ?? []) {
		if (unknown.ids.length === 0) continue;
		add(
			checks,
			"error",
			`${unknown.projectName} agent curation`,
			`.agentspace/config.json enables ${unknown.ids.map((id) => `\`${id}\``).join(", ")}, which resolve to no configured tool`,
			"Declare the tool in agentSpace.codingTools (id, command, family, sessionsDir) or remove the id from agents.enabled.",
		);
	}

	const agents = input.agents ?? [];
	if (agents.length === 0) {
		add(checks, "info", "Agents", "no agents are persisted yet");
		return checks;
	}

	let bound = 0;
	for (const probe of agents) {
		const label = `${probe.projectName} / ${probe.featureLabel} / ${probe.agentName}`;
		const facts = [`tool \`${probe.toolId}\``];
		if (!probe.toolDeclared)
			facts.push("not declared in agentSpace.codingTools");
		if (probe.sessionsDir) {
			facts.push(`sessions ${redactHome(probe.sessionsDir, homeDir)}`);
		}
		facts.push(
			`session ${probe.sessionId ? `\`${probe.sessionId}\`` : "none"}`,
		);
		if (probe.sessionResolved !== null) {
			facts.push(
				probe.sessionResolved ? "found in store" : "not found in store",
			);
		}
		facts.push(`binding ${probe.bindingState}`);
		if (probe.attentionEvidence)
			facts.push(`evidence ${probe.attentionEvidence}`);
		if (probe.bindingDetail) facts.push(probe.bindingDetail.toLowerCase());

		let level: DoctorLevel;
		let remediation: string | undefined;
		if (probe.bindingState === "unsupported") {
			level = "info";
		} else if (probe.sessionResolved === true) {
			level = "ok";
			bound += 1;
		} else if (!probe.toolDeclared) {
			level = "error";
			remediation =
				"Declare this tool in agentSpace.codingTools with its own command and sessionsDir; the fallback reads the default session store, which is the wrong one for a wrapped CLI profile.";
		} else if (probe.bindingState === "unverified") {
			level = "error";
			remediation =
				"The stored session id does not exist in the provider store. Agent Space will adopt the session this agent actually started on the next reconciliation; check sessionsDir if it never does.";
		} else if (probe.bindingState === "ambiguous") {
			level = "warn";
			remediation =
				"Several sessions or several agents compete for the same binding in this worktree, and provider session order does not say which is which. Agent Space will not guess. Close the agents you no longer need, or run one agent per worktree, and the attribution becomes forced.";
		} else {
			level = "warn";
			remediation =
				"Providers record a session on the first prompt, not at launch. Send a prompt to this agent, then rerun Doctor.";
		}

		add(checks, level, label, facts.join("; "), remediation);
	}

	add(
		checks,
		bound === agents.length ? "ok" : bound === 0 ? "error" : "warn",
		"Session binding",
		`${bound}/${agents.length} agent${agents.length === 1 ? "" : "s"} bound to a provider session`,
		bound === agents.length
			? undefined
			: "Naming, attention and resume all read through this binding; unbound agents have none of them.",
	);

	return checks;
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

	add(systemChecks, "info", "Runtime", runtimeLabel());
	add(
		systemChecks,
		"info",
		"VS Code extension host",
		input.remoteName ?? "local",
	);

	const gitAvailable = deps.commandExists("git");
	if (gitAvailable) {
		add(
			systemChecks,
			"ok",
			"Git",
			deps.commandVersion("git") ?? "available (version unavailable)",
		);
	} else {
		add(
			systemChecks,
			"error",
			"Git",
			"not found on PATH",
			"Install Git and reload VS Code.",
		);
	}

	const tmuxAvailable = deps.commandExists("tmux");
	const tmuxWorks = tmuxAvailable && (deps.commandFunctional?.("tmux") ?? true);
	if (tmuxWorks) {
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
			tmuxAvailable
				? "found but functional smoke test failed"
				: "not found on PATH",
			process.platform === "win32"
				? "Reopen this repository in VS Code Remote WSL and install tmux inside WSL. Native Windows support is experimental."
				: "Install tmux with your system package manager, then reload VS Code.",
		);
	}

	add(
		configChecks,
		"info",
		"Extension",
		`${input.extensionId} v${input.extensionVersion}`,
	);
	add(configChecks, "info", "Worktree base", input.worktreeBasePath);
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
	if (input.persistencePath) {
		const writable = deps.pathWritable?.(input.persistencePath) ?? true;
		add(
			systemChecks,
			writable ? "ok" : "error",
			"Persistence backend",
			`${redactHome(input.persistencePath, homeDir)} is ${writable ? "writable" : "not writable"}`,
			writable
				? undefined
				: "Grant the extension access to its global storage directory, then rerun Doctor.",
		);
	}

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

	if (
		input.defaultToolId &&
		!input.tools.some((tool) => tool.id === input.defaultToolId)
	) {
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

		if (config.localOverlay) {
			add(
				projectChecks,
				config.localOverlay.valid ? "info" : "error",
				`${project.name} local overlay`,
				config.localOverlay.valid
					? `${LOCAL_CONFIG_FILE_NAME} overrides ${config.localOverlay.keys.length === 0 ? "nothing" : config.localOverlay.keys.join(", ")} on this machine`
					: `${LOCAL_CONFIG_FILE_NAME} is not a readable JSON object and is being ignored`,
				config.localOverlay.valid
					? undefined
					: `Fix or delete ${LOCAL_CONFIG_FILE_NAME}; until then this machine runs on the committed config alone.`,
			);
		}

		const configuredBase =
			typeof config.config?.baseBranch === "string"
				? config.config.baseBranch.trim()
				: undefined;
		const effectiveBase =
			configuredBase || deps.currentBranch(project.repoPath);
		if (!effectiveBase) {
			add(
				projectChecks,
				"warn",
				`${project.name} base branch`,
				"could not determine an effective base branch",
				"Set baseBranch explicitly in .agentspace/config.json.",
			);
		} else if (
			configuredBase &&
			!deps.branchExists(project.repoPath, configuredBase)
		) {
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

	const agentChecks = buildAgentChecks(input, homeDir);

	const checks = [
		...systemChecks,
		...configChecks,
		...toolChecks,
		...projectChecks,
		...agentChecks,
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
		...renderSection("Agent sessions", agentChecks),
	].join("\n");

	return { markdown, checks, errors, warnings };
}
