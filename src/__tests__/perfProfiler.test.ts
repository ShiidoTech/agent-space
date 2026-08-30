import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureAgentSpaceDiagnostics } from "../diagnostics/agentSpaceDiagnostics";
import {
	isPerfProfilerEnabled,
	measurePerfAsync,
	measurePerfSync,
	setPerfProfilerEnabled,
} from "../diagnostics/perfProfiler";
import {
	recordSubprocessCall,
	resetSubprocessCounts,
} from "../diagnostics/subprocessCounter";

describe("perfProfiler", () => {
	let messages: string[];

	beforeEach(() => {
		messages = [];
		configureAgentSpaceDiagnostics((message) => messages.push(message));
		resetSubprocessCounts();
		setPerfProfilerEnabled(false);
	});

	it("is disabled by default", () => {
		expect(isPerfProfilerEnabled()).toBe(false);
	});

	it("runs the measured function and reports nothing when disabled", () => {
		const fn = vi.fn(() => "result");
		const result = measurePerfSync("test.op", fn);

		expect(result).toBe("result");
		expect(fn).toHaveBeenCalledTimes(1);
		expect(messages).toHaveLength(0);
	});

	it("reports duration and zero subprocess counts for a clean sync operation", () => {
		setPerfProfilerEnabled(true);

		measurePerfSync("sidebar.refreshState", () => undefined);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("[perf] sidebar.refreshState");
		expect(messages[0]).toMatch(/duration=\d+(\.\d+)?ms/);
		expect(messages[0]).toContain("subprocess=0");
		expect(messages[0]).toContain("tmux=0");
		expect(messages[0]).toContain("git=0");
		expect(messages[0]).toContain("provider=0");
	});

	it("reports the subprocess calls that happened during the measured window, categorized", () => {
		setPerfProfilerEnabled(true);

		measurePerfSync("runtime.reconcile", () => {
			recordSubprocessCall("tmux");
			recordSubprocessCall("git");
			recordSubprocessCall("git");
		});

		expect(messages[0]).toContain("subprocess=3");
		expect(messages[0]).toContain("tmux=1");
		expect(messages[0]).toContain("git=2");
		expect(messages[0]).toContain("provider=0");
	});

	it("supports async operations and still reports after they resolve", async () => {
		setPerfProfilerEnabled(true);

		const result = await measurePerfAsync("Home.refreshLive", async () => {
			recordSubprocessCall("provider");
			return "done";
		});

		expect(result).toBe("done");
		expect(messages[0]).toContain("[perf] Home.refreshLive");
		expect(messages[0]).toContain("provider=1");
	});

	it("still reports when the measured function throws", () => {
		setPerfProfilerEnabled(true);

		expect(() =>
			measurePerfSync("failing.op", () => {
				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("[perf] failing.op");
	});
});
