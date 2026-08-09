import { describe, expect, it } from "vitest";
import { classifyLiveTmuxSession } from "../diagnostics/tmuxSessionDiagnostics";

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
});
