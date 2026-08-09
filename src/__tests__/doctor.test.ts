import { describe, expect, it } from "vitest";
import {
	type DoctorDeps,
	type DoctorInput,
	runDoctor,
} from "../diagnostics/doctor";

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
	return {
		commandExists: () => true,
		commandVersion: (command) =>
			command === "git" ? "git version 2.50.0" : "tmux 3.5",
		pathReadable: () => true,
		readProjectConfig: () => ({
			exists: true,
			valid: true,
			config: { baseBranch: "main" },
		}),
		isGitRepo: () => true,
		currentBranch: () => "main",
		branchExists: () => true,
		worktreeCount: () => 3,
		...overrides,
	};
}

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
	return {
		extensionId: "ShiidoTech.agent-space",
		extensionVersion: "0.5.3",
		projects: [
			{
				id: "project-1",
				name: "agent-space",
				repoPath: "/home/alice/dev/agent-space",
			},
		],
		tools: [
			{
				id: "claude",
				name: "Claude Code",
				command: "claude",
				family: "claude",
				sessionsDir: "/home/alice/.claude/projects",
			},
		],
		defaultToolId: "claude",
		worktreeBasePath: ".worktrees",
		perAgentIsolation: false,
		syncSessionNames: true,
		homeDir: "/home/alice",
		...overrides,
	};
}

describe("runDoctor", () => {
	it("renders a healthy, copyable report and redacts the home prefix", () => {
		const report = runDoctor(input(), deps());

		expect(report.errors).toBe(0);
		expect(report.warnings).toBe(0);
		expect(report.markdown).toContain("Healthy — no problems detected");
		expect(report.markdown).toContain("ShiidoTech.agent-space v0.5.3");
		expect(report.markdown).toContain("Runtime");
		expect(report.markdown).toContain("~/dev/agent-space");
		expect(report.markdown).toContain("~/.claude/projects");
		expect(report.markdown).not.toContain("/home/alice");
	});

	it("reports missing prerequisites, unavailable default tool and invalid project config", () => {
		const report = runDoctor(
			input({
				tools: [
					{
						id: "claude",
						name: "Claude Code",
						command: "claude",
						family: "claude",
						env: { API_TOKEN: "super-secret-value" },
						args: ["--token", "another-secret"],
						resumeCommand: "claude --resume secret-session",
					},
				],
			}),
			deps({
				commandExists: (command) => command === "git",
				readProjectConfig: () => ({
					exists: true,
					valid: false,
					error: "Unexpected token",
				}),
			}),
		);

		expect(report.errors).toBeGreaterThanOrEqual(3);
		expect(report.markdown).toContain("tmux");
		expect(report.markdown).toContain("configured default CLI");
		expect(report.markdown).toContain("config.json is invalid");
		expect(report.markdown).not.toContain("super-secret-value");
		expect(report.markdown).not.toContain("another-secret");
		expect(report.markdown).not.toContain("secret-session");
	});

	it("reports tmux that is present but not functional", () => {
		const report = runDoctor(
			input(),
			deps({ commandFunctional: (command) => command !== "tmux" }),
		);

		expect(report.errors).toBe(1);
		expect(report.markdown).toContain("found but functional smoke test failed");
	});

	it("gives the native Windows remediation when tmux is unavailable", () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			const report = runDoctor(
				input(),
				deps({ commandExists: (command) => command === "git" }),
			);

			expect(report.markdown).toContain("tmux");
			expect(report.markdown).toContain("not found on PATH");
			expect(report.markdown).toContain("Remote WSL");
			expect(report.markdown).toContain(
				"Native Windows support is experimental",
			);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
		}
	});

	it("reports the VS Code remote extension host context", () => {
		const report = runDoctor(input({ remoteName: "wsl" }), deps());

		expect(report.markdown).toContain("VS Code extension host");
		expect(report.markdown).toContain("wsl");
	});

	it("reports persistence backend readiness", () => {
		const report = runDoctor(
			input({ persistencePath: "/home/alice/.config/agentspace" }),
			deps({ pathWritable: () => false }),
		);

		expect(report.errors).toBe(1);
		expect(report.markdown).toContain("Persistence backend");
		expect(report.markdown).toContain("not writable");
	});

	it("flags an explicitly configured base branch that does not exist", () => {
		const report = runDoctor(input(), deps({ branchExists: () => false }));

		expect(report.errors).toBe(1);
		expect(report.markdown).toContain("configured branch `main` was not found");
	});

	it("does not crash on a malformed base branch value", () => {
		const report = runDoctor(
			input(),
			deps({
				readProjectConfig: () => ({
					exists: true,
					valid: true,
					config: { baseBranch: 42 as unknown as string },
				}),
			}),
		);

		expect(report.markdown).toContain("no explicit baseBranch");
	});

	it("does not count explicitly unsupported providers against binding health", () => {
		const report = runDoctor(
			input({
				agents: [
					{
						projectName: "agent-space",
						featureLabel: "main",
						agentName: "Hermes",
						toolId: "hermes",
						toolDeclared: true,
						sessionId: null,
						bindingState: "unsupported",
						sessionResolved: null,
					},
				],
			}),
			deps(),
		);

		expect(report.errors).toBe(0);
		expect(report.markdown).toContain(
			"0/0 agents requiring binding are bound to a provider session; 1 explicitly unsupported",
		);
	});
});
