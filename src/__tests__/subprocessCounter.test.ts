import { beforeEach, describe, expect, it } from "vitest";
import {
	categorizeCommand,
	diffSubprocessCounts,
	recordSubprocessCall,
	resetSubprocessCounts,
	snapshotSubprocessCounts,
} from "../diagnostics/subprocessCounter";

describe("subprocessCounter", () => {
	beforeEach(() => {
		resetSubprocessCounts();
	});

	describe("categorizeCommand", () => {
		it("recognizes tmux commands", () => {
			expect(categorizeCommand("tmux")).toBe("tmux");
			expect(categorizeCommand("tmux list-sessions")).toBe("tmux");
		});

		it("recognizes git commands", () => {
			expect(categorizeCommand("git")).toBe("git");
			expect(categorizeCommand("git rev-parse --abbrev-ref HEAD")).toBe("git");
		});

		it("falls back to other for anything else", () => {
			expect(categorizeCommand("opencode")).toBe("other");
			expect(categorizeCommand("hermes")).toBe("other");
		});
	});

	describe("recordSubprocessCall / snapshotSubprocessCounts", () => {
		it("starts at zero for every category", () => {
			expect(snapshotSubprocessCounts()).toEqual({
				tmux: 0,
				git: 0,
				provider: 0,
				other: 0,
			});
		});

		it("increments only the recorded category", () => {
			recordSubprocessCall("tmux");
			recordSubprocessCall("tmux");
			recordSubprocessCall("git");

			expect(snapshotSubprocessCounts()).toEqual({
				tmux: 2,
				git: 1,
				provider: 0,
				other: 0,
			});
		});
	});

	describe("diffSubprocessCounts", () => {
		it("reports only what changed between two snapshots", () => {
			const before = snapshotSubprocessCounts();
			recordSubprocessCall("tmux");
			recordSubprocessCall("provider");
			const after = snapshotSubprocessCounts();

			expect(diffSubprocessCounts(before, after)).toEqual({
				tmux: 1,
				git: 0,
				provider: 1,
				other: 0,
			});
		});
	});
});
