import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process and node:fs at the top level so every dynamic
// import() of the platform module picks up these mocks.
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	execSync: vi.fn(),
	exec: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
}));

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);

// Helper: dynamically import the platform module so each test gets fresh
// module-level state (e.g. the cached bash path is reset).
async function loadPlatform() {
	const mod = await import("../utils/platform");
	mod._resetBashCache();
	mod._resetCommandExistsCache();
	return mod;
}

describe("platform", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------------------
	// isWindows
	// -----------------------------------------------------------------------
	describe("isWindows", () => {
		it("returns true when process.platform is win32", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			try {
				const { isWindows } = await loadPlatform();
				expect(isWindows()).toBe(true);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("returns false on linux", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				const { isWindows } = await loadPlatform();
				expect(isWindows()).toBe(false);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("returns false on darwin", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "darwin" });
			try {
				const { isWindows } = await loadPlatform();
				expect(isWindows()).toBe(false);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});
	});

	describe("runtimeLabel", () => {
		it("identifies WSL as a Linux extension host", async () => {
			const originalPlatform = process.platform;
			const originalEnv = { ...process.env };
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.WSL_DISTRO_NAME = "Ubuntu";
			try {
				const { runtimeLabel } = await loadPlatform();
				expect(runtimeLabel()).toBe("WSL / Linux extension host");
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform });
				process.env = originalEnv;
			}
		});
	});

	// -----------------------------------------------------------------------
	// findGitBash
	// -----------------------------------------------------------------------
	describe("findGitBash", () => {
		it("returns null on non-Windows platforms", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				const { findGitBash } = await loadPlatform();
				expect(findGitBash()).toBeNull();
				expect(mockExistsSync).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("returns PROGRAMFILES Git Bash path when it exists", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			process.env["PROGRAMFILES(X86)"] = "C:\\Program Files (x86)";
			process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				const { findGitBash } = await loadPlatform();
				expect(findGitBash()).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("falls back to PROGRAMFILES(X86) when PROGRAMFILES path missing", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			process.env["PROGRAMFILES(X86)"] = "C:\\Program Files (x86)";
			process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
				);
				const { findGitBash } = await loadPlatform();
				expect(findGitBash()).toBe(
					"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
				);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("falls back to LOCALAPPDATA when earlier paths missing", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			process.env["PROGRAMFILES(X86)"] = "C:\\Program Files (x86)";
			process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
			try {
				mockExistsSync.mockImplementation(
					(p) =>
						p ===
						"C:\\Users\\test\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
				);
				const { findGitBash } = await loadPlatform();
				expect(findGitBash()).toBe(
					"C:\\Users\\test\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
				);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("returns null when no Git Bash is found on Windows", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			process.env["PROGRAMFILES(X86)"] = "C:\\Program Files (x86)";
			process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
			try {
				mockExistsSync.mockReturnValue(false);
				const { findGitBash } = await loadPlatform();
				expect(findGitBash()).toBeNull();
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("caches the result after first call", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				const { findGitBash } = await loadPlatform();
				findGitBash();
				findGitBash();
				// existsSync should only be called once due to caching
				expect(mockExistsSync).toHaveBeenCalledTimes(1);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("caches null result too", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			process.env["PROGRAMFILES(X86)"] = undefined;
			process.env.LOCALAPPDATA = undefined;
			try {
				mockExistsSync.mockReturnValue(false);
				const { findGitBash } = await loadPlatform();
				expect(findGitBash()).toBeNull();
				expect(findGitBash()).toBeNull();
				// Called once for the single candidate, then cached
				expect(mockExistsSync).toHaveBeenCalledTimes(1);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});
	});

	// -----------------------------------------------------------------------
	// commandExists
	// -----------------------------------------------------------------------
	describe("commandExists", () => {
		it("uses 'which' on non-Windows and returns true on success", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockReturnValue(Buffer.from("/usr/bin/tmux\n"));
				const { commandExists } = await loadPlatform();
				expect(commandExists("tmux")).toBe(true);
				expect(mockExecSync).toHaveBeenCalledWith("which tmux", {
					stdio: ["ignore", "pipe", "ignore"],
				});
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("checks Git Bash first on Windows, then falls back to where", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				// "which tmux" succeeds in Git Bash
				mockExecSync.mockReturnValue(Buffer.from("/usr/bin/tmux\n"));
				const { commandExists } = await loadPlatform();
				expect(commandExists("tmux")).toBe(true);
				expect(mockExecSync).toHaveBeenCalledWith("which tmux", {
					shell: "C:\\Program Files\\Git\\bin\\bash.exe",
					stdio: ["ignore", "pipe", "ignore"],
				});
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("falls back to where when Git Bash which fails on Windows", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				let callCount = 0;
				mockExecSync.mockImplementation(() => {
					callCount++;
					if (callCount === 1) throw new Error("not in bash");
					return Buffer.from("C:\\Program Files\\Git\\bin\\git.exe\n");
				});
				const { commandExists } = await loadPlatform();
				expect(commandExists("git")).toBe(true);
				// First call: which in Git Bash (fails)
				// Second call: where (succeeds)
				expect(mockExecSync).toHaveBeenCalledTimes(2);
				expect(mockExecSync).toHaveBeenLastCalledWith("where git", {
					stdio: ["ignore", "pipe", "ignore"],
				});
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("rejects commands with shell metacharacters", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				const { commandExists } = await loadPlatform();
				expect(commandExists("foo; rm -rf /")).toBe(false);
				expect(commandExists("foo && bar")).toBe(false);
				expect(commandExists("$(whoami)")).toBe(false);
				expect(mockExecSync).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("returns false when command is not found", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockImplementation(() => {
					throw new Error("not found");
				});
				const { commandExists } = await loadPlatform();
				expect(commandExists("nonexistent")).toBe(false);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});
	});

	// -----------------------------------------------------------------------
	// getExecOptions
	// -----------------------------------------------------------------------
	describe("getExecOptions", () => {
		it("returns base options on non-Windows", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				const { getExecOptions } = await loadPlatform();
				const opts = getExecOptions();
				expect(opts.encoding).toBe("utf-8");
				expect(opts.stdio).toEqual(["ignore", "pipe", "ignore"]);
				expect(opts.shell).toBeUndefined();
				expect(opts.cwd).toBeUndefined();
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("includes cwd when provided", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				const { getExecOptions } = await loadPlatform();
				const opts = getExecOptions("/some/path");
				expect(opts.cwd).toBe("/some/path");
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("adds shell option on Windows when Git Bash is found", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				const { getExecOptions } = await loadPlatform();
				const opts = getExecOptions();
				expect(opts.shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("omits shell option on Windows when Git Bash is not found", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			process.env["PROGRAMFILES(X86)"] = undefined;
			process.env.LOCALAPPDATA = undefined;
			try {
				mockExistsSync.mockReturnValue(false);
				const { getExecOptions } = await loadPlatform();
				const opts = getExecOptions();
				expect(opts.shell).toBeUndefined();
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});
	});

	// -----------------------------------------------------------------------
	// exec
	// -----------------------------------------------------------------------
	describe("exec", () => {
		it("calls execSync with getExecOptions and returns the output", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockReturnValue("hello world\n");
				const { exec } = await loadPlatform();
				const result = exec("echo hello");
				expect(result).toBe("hello world\n");
				expect(mockExecSync).toHaveBeenCalledWith(
					"echo hello",
					expect.objectContaining({
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "ignore"],
					}),
				);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("passes cwd through to execSync", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockReturnValue("ok");
				const { exec } = await loadPlatform();
				exec("ls", { cwd: "/tmp" });
				expect(mockExecSync).toHaveBeenCalledWith(
					"ls",
					expect.objectContaining({ cwd: "/tmp" }),
				);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("propagates errors from execSync", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockImplementation(() => {
					throw new Error("command failed");
				});
				const { exec } = await loadPlatform();
				expect(() => exec("bad-command")).toThrow("command failed");
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});
	});

	describe("tmuxFunctional", () => {
		it("runs and cleans up a collision-safe smoke-test session", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockReturnValue("");
				const { tmuxFunctional } = await loadPlatform();
				expect(tmuxFunctional()).toBe(true);
				expect(mockExecSync).toHaveBeenCalledWith(
					expect.stringMatching(/^tmux new-session -d -s agentspace-doctor-/),
					expect.any(Object),
				);
				expect(mockExecSync).toHaveBeenCalledWith(
					expect.stringMatching(/^tmux has-session -t agentspace-doctor-/),
					expect.any(Object),
				);
				expect(mockExecSync).toHaveBeenCalledWith(
					expect.stringMatching(/^tmux kill-session -t agentspace-doctor-/),
					expect.any(Object),
				);
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform });
			}
		});

		it("returns false when has-session fails and still cleans up", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockImplementation((command: string) => {
					if (command.startsWith("tmux has-session")) {
						throw new Error("session is not functional");
					}
					return "";
				});
				const { tmuxFunctional } = await loadPlatform();
				expect(tmuxFunctional()).toBe(false);
				expect(mockExecSync).toHaveBeenCalledWith(
					expect.stringMatching(/^tmux kill-session -t agentspace-doctor-/),
					expect.any(Object),
				);
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform });
			}
		});

		it("returns false and still attempts cleanup when the smoke test fails", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockImplementation((command: string) => {
					if (command.startsWith("tmux new-session")) {
						throw new Error("tmux failed");
					}
					return "";
				});
				const { tmuxFunctional } = await loadPlatform();
				expect(tmuxFunctional()).toBe(false);
				expect(mockExecSync).toHaveBeenCalledWith(
					expect.stringMatching(/^tmux kill-session -t agentspace-doctor-/),
					expect.any(Object),
				);
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform });
			}
		});
	});

	// -----------------------------------------------------------------------
	// execFile
	// -----------------------------------------------------------------------
	describe("execFile", () => {
		it("uses direct argv execution on Linux", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecFileSync.mockReturnValue("ok");
				const { execFile } = await loadPlatform();
				expect(
					execFile("tmux", ["kill-session", "-t", "agent-space-x; evil"]),
				).toBe("ok");
				expect(mockExecFileSync).toHaveBeenCalledWith(
					"tmux",
					["kill-session", "-t", "agent-space-x; evil"],
					expect.objectContaining({ shell: false }),
				);
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform });
			}
		});

		it("uses Git Bash without interpolating Windows tmux arguments", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				mockExecFileSync.mockReturnValue("ok");
				const { execFile } = await loadPlatform();
				execFile("tmux", ["kill-session", "-t", "agent-space-x; evil"]);
				expect(mockExecFileSync).toHaveBeenCalledWith(
					"C:\\Program Files\\Git\\bin\\bash.exe",
					[
						"-lc",
						'exec "$0" "$@"',
						"tmux",
						"kill-session",
						"-t",
						"agent-space-x; evil",
					],
					expect.objectContaining({ shell: false }),
				);
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform });
				process.env = originalEnv;
			}
		});
	});

	// -----------------------------------------------------------------------
	// execSilent
	// -----------------------------------------------------------------------
	describe("execSilent", () => {
		it("returns true on success", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockReturnValue("ok");
				const { execSilent } = await loadPlatform();
				expect(execSilent("echo hello")).toBe(true);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("returns false on error", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockImplementation(() => {
					throw new Error("fail");
				});
				const { execSilent } = await loadPlatform();
				expect(execSilent("bad-command")).toBe(false);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("passes cwd option through", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				mockExecSync.mockReturnValue("ok");
				const { execSilent } = await loadPlatform();
				execSilent("ls", { cwd: "/tmp" });
				expect(mockExecSync).toHaveBeenCalledWith(
					"ls",
					expect.objectContaining({ cwd: "/tmp" }),
				);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});
	});

	// -----------------------------------------------------------------------
	// getTerminalShellArgs
	// -----------------------------------------------------------------------
	describe("getTerminalShellArgs", () => {
		it("returns tmux direct args on non-Windows", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			try {
				const { getTerminalShellArgs } = await loadPlatform();
				const result = getTerminalShellArgs("my-session");
				expect(result).toEqual({
					shellPath: "tmux",
					shellArgs: ["attach-session", "-t", "my-session"],
				});
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
			}
		});

		it("returns Git Bash wrapper args on Windows with Git Bash", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				const { getTerminalShellArgs } = await loadPlatform();
				const result = getTerminalShellArgs("my-session");
				expect(result).toEqual({
					shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
					shellArgs: ["-c", 'tmux attach-session -t "my-session"'],
				});
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("falls back to tmux direct args on Windows without Git Bash", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			process.env["PROGRAMFILES(X86)"] = undefined;
			process.env.LOCALAPPDATA = undefined;
			try {
				mockExistsSync.mockReturnValue(false);
				const { getTerminalShellArgs } = await loadPlatform();
				const result = getTerminalShellArgs("my-session");
				expect(result).toEqual({
					shellPath: "tmux",
					shellArgs: ["attach-session", "-t", "my-session"],
				});
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});

		it("properly quotes session names with special characters", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			const originalEnv = { ...process.env };
			process.env.PROGRAMFILES = "C:\\Program Files";
			try {
				mockExistsSync.mockImplementation(
					(p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
				);
				const { getTerminalShellArgs } = await loadPlatform();
				const result = getTerminalShellArgs("agent-space-feat-1-agent-1");
				expect(result.shellArgs[1]).toBe(
					'tmux attach-session -t "agent-space-feat-1-agent-1"',
				);
			} finally {
				Object.defineProperty(process, "platform", {
					value: originalPlatform,
				});
				process.env = originalEnv;
			}
		});
	});
});
