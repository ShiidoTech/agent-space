import { describe, expect, it } from "vitest";
import {
	classifyLiveTmuxSession,
	findCleanupCandidates,
	shouldCleanupSession,
} from "../diagnostics/tmuxSessionDiagnostics";

describe("tmux session diagnostics", () => {
	it("classifies a tracked Agent Space session", () => {
		expect(classifyLiveTmuxSession("agent-space-f1-a1", ["owner"])).toBe(
			"tracked",
		);
	});

	it("classifies a conflicting Agent Space session", () => {
		expect(classifyLiveTmuxSession("companion-f1-a1", ["one", "two"])).toBe(
			"conflict",
		);
	});

	it("classifies an untracked Agent Space session", () => {
		expect(classifyLiveTmuxSession("agent-space-f1-a1", undefined)).toBe(
			"untracked_agent_space",
		);
	});

	it("keeps foreign sessions out of Agent Space cleanup candidates", () => {
		expect(classifyLiveTmuxSession("personal-shell", undefined)).toBe(
			"foreign",
		);
	});

	it("only returns untracked Agent Space sessions as cleanup candidates", () => {
		const tracked = new Map([["agent-space-f1-a1", ["owner"]]]);
		expect(
			findCleanupCandidates(
				["agent-space-f1-a1", "agent-space-f2-a2", "personal-shell"],
				tracked,
			),
		).toEqual(["agent-space-f2-a2"]);
	});

	it("requires a live session that is still untracked at cleanup time", () => {
		expect(shouldCleanupSession("agent-space-f1-a1", ["owner"], true)).toBe(
			false,
		);
		expect(shouldCleanupSession("agent-space-f1-a1", undefined, false)).toBe(
			false,
		);
		expect(shouldCleanupSession("agent-space-f1-a1", undefined, true)).toBe(
			true,
		);
	});
});
