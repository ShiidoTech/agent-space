import { beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxIntegration } from "../agents/tmux";
import { verifySessionsStopped } from "../features/featureFinish";

vi.mock("../utils/platform", () => ({
	commandExists: vi.fn(),
	exec: vi.fn(),
	execAsync: vi.fn(),
	execFile: vi.fn(),
	execFileAsync: vi.fn(),
	execSilent: vi.fn(),
}));

import {
	commandExists,
	exec,
	execAsync,
	execFile,
	execFileAsync,
} from "../utils/platform";

const mockCommandExists = vi.mocked(commandExists);
const mockExec = vi.mocked(exec);
const mockExecAsync = vi.mocked(execAsync);
const mockExecFile = vi.mocked(execFile);
const mockExecFileAsync = vi.mocked(execFileAsync);
describe("TmuxIntegration", () => {
	const tmux = new TmuxIntegration();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// -------------------------------------------------------------------
	// sessionName / serviceSessionName
	// -------------------------------------------------------------------
	describe("sessionName", () => {
		it("generates deterministic session name", () => {
			const name = tmux.sessionName("feat-1", "agent-1");
			expect(name).toBe("agent-space-feat-1-agent-1");
		});

		it("sanitizes colons from feature IDs", () => {
			const name = tmux.sessionName("base:project-id", "agent-1");
			expect(name).toBe("agent-space-base_project-id-agent-1");
		});

		it("sanitizes dots from session names", () => {
			const name = tmux.sessionName("feat.1", "agent.1");
			expect(name).toBe("agent-space-feat_1-agent_1");
		});

		it("sanitizes slashes from branch-based labels", () => {
			const name = tmux.sessionName("feat/auth-system", "agent-1");
			expect(name).toBe("agent-space-feat_auth-system-agent-1");
		});
	});

	describe("serviceSessionName", () => {
		it("generates service session names with svc infix", () => {
			expect(tmux.serviceSessionName("f1", "s1")).toBe("agent-space-svc-f1-s1");
		});

		it("sanitizes colons from service session names", () => {
			expect(tmux.serviceSessionName("base:proj-id", "s1")).toBe(
				"agent-space-svc-base_proj-id-s1",
			);
		});
	});

	describe("legacy session names", () => {
		it("returns the previous agent session prefix", () => {
			expect(tmux.legacySessionName("feat-1", "agent-1")).toBe(
				"companion-feat-1-agent-1",
			);
		});

		it("returns the previous service session prefix", () => {
			expect(tmux.legacyServiceSessionName("f1", "s1")).toBe(
				"companion-svc-f1-s1",
			);
		});

		it("sanitizes colons in legacy names", () => {
			expect(tmux.legacySessionName("base:proj-id", "a1")).toBe(
				"companion-base_proj-id-a1",
			);
		});
	});

	// -------------------------------------------------------------------
	// isAvailable
	// -------------------------------------------------------------------
	describe("isAvailable", () => {
		it("returns true when tmux is on PATH", () => {
			mockCommandExists.mockReturnValue(true);
			expect(tmux.isAvailable()).toBe(true);
			expect(mockCommandExists).toHaveBeenCalledWith("tmux");
		});

		it("returns false when tmux is not found", () => {
			mockCommandExists.mockReturnValue(false);
			expect(tmux.isAvailable()).toBe(false);
			expect(mockCommandExists).toHaveBeenCalledWith("tmux");
		});
	});

	// -------------------------------------------------------------------
	// isSessionAlive
	// -------------------------------------------------------------------
	describe("isSessionAlive", () => {
		it("returns true for existing session", () => {
			mockExecFile.mockReturnValue("");
			expect(tmux.isSessionAlive("agent-space-f1-a1")).toBe(true);
			expect(mockExecFile).toHaveBeenCalledWith("tmux", [
				"has-session",
				"-t",
				"agent-space-f1-a1",
			]);
		});

		it("returns false for missing session", () => {
			mockExecFile.mockImplementation(() => {
				throw new Error("missing");
			});
			expect(tmux.isSessionAlive("agent-space-f1-a1")).toBe(false);
			expect(mockExecFile).toHaveBeenCalledWith("tmux", [
				"has-session",
				"-t",
				"agent-space-f1-a1",
			]);
		});
	});

	describe("killSession", () => {
		it("passes the session name as an argument, never through a shell", () => {
			tmux.killSession("agent-space-safe; touch /tmp/pwned");
			expect(mockExecFile).toHaveBeenCalledWith("tmux", [
				"kill-session",
				"-t",
				"agent-space-safe; touch /tmp/pwned",
			]);
		});
	});

	describe("observeSessions", () => {
		it("proves an empty session set when tmux reports that no server is running", () => {
			mockCommandExists.mockReturnValue(true);
			mockExecFile.mockImplementation(() => {
				throw Object.assign(new Error("tmux exited"), {
					status: 1,
					stderr: "no server running on /tmp/tmux-1000/default",
				});
			});

			const observation = tmux.observeSessions();

			expect(observation).toEqual({ status: "known", sessions: [] });
			expect(
				verifySessionsStopped(new Set(["agent-space-f1-a1"]), observation),
			).toEqual({ status: "verified" });
		});

		it("keeps permission and arbitrary tmux failures unknown", () => {
			mockCommandExists.mockReturnValue(true);
			mockExecFile.mockImplementation(() => {
				throw Object.assign(new Error("tmux exited"), {
					status: 1,
					stderr: "permission denied",
				});
			});

			expect(tmux.observeSessions()).toMatchObject({ status: "unknown" });
		});
	});

	// -------------------------------------------------------------------
	// configureSession
	// -------------------------------------------------------------------
	describe("configureSession", () => {
		it("disables status bar, enables mouse, and enables native scroll", () => {
			const fresh = new TmuxIntegration();
			mockExec.mockReturnValue("");
			fresh.configureSession("my-session");
			expect(mockExec).toHaveBeenCalledWith(
				'tmux set-option -t "my-session" status off',
			);
			expect(mockExec).toHaveBeenCalledWith(
				'tmux set-option -t "my-session" mouse on',
			);
			expect(mockExec).toHaveBeenCalledWith("tmux show -sv terminal-overrides");
			expect(mockExec).toHaveBeenCalledWith(
				'tmux set -sa terminal-overrides ",*:smcup@:rmcup@:XM@"',
			);
		});

		it("skips override when smcup@ already present", () => {
			const fresh = new TmuxIntegration();
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("show -sv")) return ",*:smcup@:rmcup@:XM@";
				return "";
			});
			fresh.configureSession("my-session");
			expect(mockExec).not.toHaveBeenCalledWith(
				'tmux set -sa terminal-overrides ",*:smcup@:rmcup@:XM@"',
			);
		});

		it("swallows errors when session does not exist", () => {
			mockExec.mockImplementation(() => {
				throw new Error("no session");
			});
			expect(() => tmux.configureSession("gone")).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// configureServiceSession
	// -------------------------------------------------------------------
	describe("configureServiceSession", () => {
		it("calls configureSession then sets remain-on-exit", () => {
			const fresh = new TmuxIntegration();
			mockExec.mockReturnValue("");
			fresh.configureServiceSession("svc-session");
			expect(mockExec).toHaveBeenCalledWith(
				'tmux set-option -t "svc-session" status off',
			);
			expect(mockExec).toHaveBeenCalledWith(
				'tmux set-option -t "svc-session" remain-on-exit on',
			);
		});

		it("swallows errors for remain-on-exit when session is gone", () => {
			const fresh = new TmuxIntegration();
			mockExec.mockImplementation((cmd: string) => {
				if (cmd.includes("remain-on-exit")) {
					throw new Error("no session");
				}
				return "";
			});
			expect(() => fresh.configureServiceSession("svc-session")).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// getPaneStatus
	// -------------------------------------------------------------------
	describe("getPaneStatus", () => {
		it("returns dead=false when pane is alive", () => {
			mockExec.mockReturnValue("0 0\n");
			const result = tmux.getPaneStatus("my-session");
			expect(result).toEqual({ dead: false, exitCode: 0 });
			expect(mockExec).toHaveBeenCalledWith(
				'tmux display-message -t "my-session" -p "#{pane_dead} #{pane_dead_status}"',
			);
		});

		it("returns dead=true with exit code when pane has exited", () => {
			mockExec.mockReturnValue("1 137\n");
			const result = tmux.getPaneStatus("my-session");
			expect(result).toEqual({ dead: true, exitCode: 137 });
		});

		it("returns null when session does not exist", () => {
			mockExec.mockImplementation(() => {
				throw new Error("no session");
			});
			expect(tmux.getPaneStatus("gone")).toBeNull();
		});
	});

	// -------------------------------------------------------------------
	// createCommand / attachCommand (unchanged — no exec calls)
	// -------------------------------------------------------------------
	describe("createCommand / attachCommand", () => {
		it("returns create command string", () => {
			const cmd = tmux.createCommand("my-session", "claude");
			expect(cmd).toBe('tmux new-session -d -s "my-session" "claude"');
		});

		it("returns attach command string", () => {
			const cmd = tmux.attachCommand("my-session");
			expect(cmd).toBe('tmux attach-session -t "my-session"');
		});
	});

	describe("listSessions", () => {
		it("returns tmux session names", () => {
			mockExec.mockReturnValue("agent-space-f1-a1\nagent-space-svc-f1-s1\n");
			expect(tmux.listSessions()).toEqual([
				"agent-space-f1-a1",
				"agent-space-svc-f1-s1",
			]);
			expect(mockExec).toHaveBeenCalledWith(
				'tmux list-sessions -F "#{session_name}"',
			);
		});

		it("returns empty array when tmux list fails", () => {
			mockExec.mockImplementation(() => {
				throw new Error("tmux unavailable");
			});
			expect(tmux.listSessions()).toEqual([]);
		});
	});

	describe("observeSessions", () => {
		it("keeps unavailable tmux unknown", () => {
			mockCommandExists.mockReturnValue(false);
			expect(tmux.observeSessions()).toEqual({
				status: "unknown",
				detail: "tmux is not available",
			});
		});

		it("keeps list failures unknown", () => {
			mockCommandExists.mockReturnValue(true);
			mockExecFile.mockImplementation(() => {
				throw new Error("server unavailable");
			});
			expect(tmux.observeSessions()).toEqual({
				status: "unknown",
				detail: "server unavailable",
			});
		});

		it("returns only successfully observed session names", () => {
			mockCommandExists.mockReturnValue(true);
			mockExecFile.mockReturnValue("agent-space-a\nagent-space-b\n");
			expect(tmux.observeSessions()).toEqual({
				status: "known",
				sessions: ["agent-space-a", "agent-space-b"],
			});
		});

		it("distinguishes a successful empty listing from a failed observation", () => {
			mockCommandExists.mockReturnValue(true);
			mockExecFile.mockReturnValue("");
			expect(tmux.observeSessions()).toEqual({
				status: "known",
				sessions: [],
			});
		});
	});

	// -------------------------------------------------------------------
	// killSession
	// -------------------------------------------------------------------
	describe("killSession", () => {
		it("calls execFile with tmux kill-session arguments", () => {
			mockExecFile.mockReturnValue("");
			tmux.killSession("my-session");
			expect(mockExecFile).toHaveBeenCalledWith("tmux", [
				"kill-session",
				"-t",
				"my-session",
			]);
		});

		it("swallows errors when session is already gone", () => {
			mockExecFile.mockImplementation(() => {
				throw new Error("no session");
			});
			expect(() => tmux.killSession("gone")).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// capturePane
	// -------------------------------------------------------------------
	describe("capturePane", () => {
		it("returns trimmed pane output", () => {
			mockExec.mockReturnValue("line1\nline2\n  \n");
			const result = tmux.capturePane("my-session");
			expect(result).toBe("line1\nline2");
			expect(mockExec).toHaveBeenCalledWith(
				'tmux capture-pane -t "my-session" -p -S -50',
			);
		});

		it("respects custom line count", () => {
			mockExec.mockReturnValue("output\n");
			tmux.capturePane("my-session", 100);
			expect(mockExec).toHaveBeenCalledWith(
				'tmux capture-pane -t "my-session" -p -S -100',
			);
		});

		it("returns null when session does not exist", () => {
			mockExec.mockImplementation(() => {
				throw new Error("no session");
			});
			expect(tmux.capturePane("gone")).toBeNull();
		});
	});

	describe("adoptSession", () => {
		it("returns true when the preferred session already exists", () => {
			mockExecFile.mockReturnValueOnce("").mockImplementationOnce(() => {
				throw new Error("missing");
			});
			expect(tmux.adoptSession("agent-space-f1-a1", "companion-f1-a1")).toBe(
				true,
			);
			expect(mockExec).not.toHaveBeenCalled();
		});

		it("reports ambiguity without killing either session when both exist", () => {
			mockExecFile.mockReturnValue("");
			expect(tmux.adoptSession("agent-space-f1-a1", "companion-f1-a1")).toBe(
				false,
			);
			expect(mockExec).not.toHaveBeenCalled();
		});

		it("renames the current session when only the legacy session exists", () => {
			mockExecFile
				.mockImplementationOnce(() => {
					throw new Error("missing");
				})
				.mockReturnValueOnce("");
			mockExec.mockReturnValue("");
			expect(tmux.adoptSession("agent-space-f1-a1", "companion-f1-a1")).toBe(
				true,
			);
			expect(mockExec).toHaveBeenCalledWith(
				'tmux rename-session -t "companion-f1-a1" "agent-space-f1-a1"',
			);
		});

		it("returns false when neither session exists", () => {
			mockExecFile.mockImplementation(() => {
				throw new Error("missing");
			});
			expect(tmux.adoptSession("agent-space-f1-a1", "companion-f1-a1")).toBe(
				false,
			);
			expect(mockExec).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------
	// isSessionAliveAsync / adoptSessionAsync — the non-blocking twins used
	// off the interactive click path (see TerminalController.focusOrCreateTerminalAsync).
	// They must never touch the synchronous exec/execFile helpers.
	// -------------------------------------------------------------------
	describe("isSessionAliveAsync", () => {
		it("returns true for an existing session using the async exec path only", async () => {
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
			await expect(tmux.isSessionAliveAsync("agent-space-f1-a1")).resolves.toBe(
				true,
			);
			expect(mockExecFileAsync).toHaveBeenCalledWith("tmux", [
				"has-session",
				"-t",
				"agent-space-f1-a1",
			]);
			expect(mockExecFile).not.toHaveBeenCalled();
			expect(mockExec).not.toHaveBeenCalled();
		});

		it("returns false for a missing session", async () => {
			mockExecFileAsync.mockRejectedValue(new Error("missing"));
			await expect(tmux.isSessionAliveAsync("agent-space-f1-a1")).resolves.toBe(
				false,
			);
			expect(mockExecFile).not.toHaveBeenCalled();
			expect(mockExec).not.toHaveBeenCalled();
		});
	});

	describe("adoptSessionAsync", () => {
		it("returns true when the preferred session already exists, using only async exec", async () => {
			mockExecFileAsync
				.mockResolvedValueOnce({ stdout: "", stderr: "" })
				.mockRejectedValueOnce(new Error("missing"));
			await expect(
				tmux.adoptSessionAsync("agent-space-f1-a1", "companion-f1-a1"),
			).resolves.toBe(true);
			expect(mockExecAsync).not.toHaveBeenCalled();
			expect(mockExecFile).not.toHaveBeenCalled();
			expect(mockExec).not.toHaveBeenCalled();
		});

		it("reports ambiguity without killing either session when both exist", async () => {
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
			await expect(
				tmux.adoptSessionAsync("agent-space-f1-a1", "companion-f1-a1"),
			).resolves.toBe(false);
			expect(mockExecAsync).not.toHaveBeenCalled();
		});

		it("renames the current session asynchronously when only the legacy session exists", async () => {
			mockExecFileAsync
				.mockRejectedValueOnce(new Error("missing"))
				.mockResolvedValueOnce({ stdout: "", stderr: "" });
			mockExecAsync.mockResolvedValue({ stdout: "", stderr: "" });
			await expect(
				tmux.adoptSessionAsync("agent-space-f1-a1", "companion-f1-a1"),
			).resolves.toBe(true);
			expect(mockExecAsync).toHaveBeenCalledWith(
				'tmux rename-session -t "companion-f1-a1" "agent-space-f1-a1"',
			);
			expect(mockExec).not.toHaveBeenCalled();
			expect(mockExecFile).not.toHaveBeenCalled();
		});

		it("returns false when neither session exists", async () => {
			mockExecFileAsync.mockRejectedValue(new Error("missing"));
			await expect(
				tmux.adoptSessionAsync("agent-space-f1-a1", "companion-f1-a1"),
			).resolves.toBe(false);
			expect(mockExecAsync).not.toHaveBeenCalled();
		});
	});
});
