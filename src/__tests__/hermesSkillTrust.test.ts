import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/platform", () => ({
	execFile: vi.fn(),
	execFileAsync: vi.fn(),
}));

import {
	ensureHermesProjectSkillsTrusted,
	ensureHermesProjectSkillsTrustedAsync,
	hasProjectSkills,
} from "../agents/hermesSkillTrust";
import { execFile, execFileAsync } from "../utils/platform";

const mockExecFile = vi.mocked(execFile);
const mockExecFileAsync = vi.mocked(execFileAsync);

describe("hasProjectSkills", () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeWorktree(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ht-skills-"));
		tmpDirs.push(dir);
		return dir;
	}

	it("returns false when no skill directories exist", () => {
		const wt = makeWorktree();
		expect(hasProjectSkills(wt)).toBe(false);
	});

	it("returns true for .agents/skills directory", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents", "skills"), { recursive: true });
		expect(hasProjectSkills(wt)).toBe(true);
	});

	it("returns true for .hermes/skills directory", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".hermes", "skills"), { recursive: true });
		expect(hasProjectSkills(wt)).toBe(true);
	});

	it("returns true when both skill directories exist", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(path.join(wt, ".hermes", "skills"), { recursive: true });
		expect(hasProjectSkills(wt)).toBe(true);
	});

	it("returns false for non-directory entries named skills", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents"), { recursive: true });
		fs.writeFileSync(path.join(wt, ".agents", "skills"), "not a dir");
		expect(hasProjectSkills(wt)).toBe(false);
	});

	it("returns false for non-existent worktree path", () => {
		expect(hasProjectSkills("/nonexistent/path")).toBe(false);
	});
});

describe("ensureHermesProjectSkillsTrusted (sync)", () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		mockExecFile.mockReset();
		for (const dir of tmpDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeWorktree(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ht-trust-"));
		tmpDirs.push(dir);
		return dir;
	}

	it("does nothing when no project skills exist", () => {
		const wt = makeWorktree();
		ensureHermesProjectSkillsTrusted(wt, "agent-space");
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it("invokes hermes skills trust with the correct profile and path", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents", "skills"), { recursive: true });
		mockExecFile.mockReturnValue("");

		ensureHermesProjectSkillsTrusted(wt, "agent-space");

		expect(mockExecFile).toHaveBeenCalledOnce();
		expect(mockExecFile).toHaveBeenCalledWith(
			"hermes",
			["-p", "agent-space", "skills", "trust", wt],
			{ cwd: wt },
		);
	});

	it("passes the default profile via -p default", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents", "skills"), { recursive: true });
		mockExecFile.mockReturnValue("");

		ensureHermesProjectSkillsTrusted(wt, "default");

		expect(mockExecFile).toHaveBeenCalledWith(
			"hermes",
			["-p", "default", "skills", "trust", wt],
			{ cwd: wt },
		);
	});

	it("is idempotent — repeated calls do not fail", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".hermes", "skills"), { recursive: true });
		mockExecFile.mockReturnValue("");

		ensureHermesProjectSkillsTrusted(wt, "agent-space");
		ensureHermesProjectSkillsTrusted(wt, "agent-space");

		expect(mockExecFile).toHaveBeenCalledTimes(2);
	});

	it("throws when the CLI exits non-zero with skills present", () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents", "skills"), { recursive: true });
		mockExecFile.mockImplementation(() => {
			throw new Error("hermes: command not found");
		});

		expect(() => ensureHermesProjectSkillsTrusted(wt, "agent-space")).toThrow(
			"Failed to trust project skills",
		);
	});

	it("two different worktrees each invoke trust independently", () => {
		const wtA = makeWorktree();
		fs.mkdirSync(path.join(wtA, ".agents", "skills"), { recursive: true });
		const wtB = makeWorktree();
		fs.mkdirSync(path.join(wtB, ".hermes", "skills"), { recursive: true });
		mockExecFile.mockReturnValue("");

		ensureHermesProjectSkillsTrusted(wtA, "agent-space");
		ensureHermesProjectSkillsTrusted(wtB, "agent-space");

		expect(mockExecFile).toHaveBeenCalledTimes(2);
		expect(mockExecFile).toHaveBeenNthCalledWith(
			1,
			"hermes",
			["-p", "agent-space", "skills", "trust", wtA],
			{ cwd: wtA },
		);
		expect(mockExecFile).toHaveBeenNthCalledWith(
			2,
			"hermes",
			["-p", "agent-space", "skills", "trust", wtB],
			{ cwd: wtB },
		);
	});
});

describe("ensureHermesProjectSkillsTrustedAsync", () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		mockExecFileAsync.mockReset();
		for (const dir of tmpDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeWorktree(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ht-trust-async-"));
		tmpDirs.push(dir);
		return dir;
	}

	it("does nothing when no project skills exist", async () => {
		const wt = makeWorktree();
		await ensureHermesProjectSkillsTrustedAsync(wt, "agent-space");
		expect(mockExecFileAsync).not.toHaveBeenCalled();
	});

	it("invokes hermes skills trust asynchronously", async () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents", "skills"), { recursive: true });
		mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

		await ensureHermesProjectSkillsTrustedAsync(wt, "agent-space");

		expect(mockExecFileAsync).toHaveBeenCalledOnce();
		expect(mockExecFileAsync).toHaveBeenCalledWith(
			"hermes",
			["-p", "agent-space", "skills", "trust", wt],
			{ cwd: wt },
		);
	});

	it("throws when the async CLI exits non-zero", async () => {
		const wt = makeWorktree();
		fs.mkdirSync(path.join(wt, ".agents", "skills"), { recursive: true });
		mockExecFileAsync.mockRejectedValue(new Error("trust failed"));

		await expect(
			ensureHermesProjectSkillsTrustedAsync(wt, "agent-space"),
		).rejects.toThrow("Failed to trust project skills");
	});
});
