import { describe, expect, it, vi } from "vitest";
import { createFeatureChangeFlusher } from "../features/featureChangeRouting";
import type { FeatureSnapshot } from "../features/featureSnapshot";

function snapshot(featureId: string): FeatureSnapshot {
	return { feature: { id: featureId } } as unknown as FeatureSnapshot;
}

// Issue #120 PR review (blocker 3): `FeatureStateCoordinator.onDidChange` is
// the *real* listener extension.ts wires up — these tests exercise the
// actual routing function it uses, not a stand-in, so a pass here proves the
// production event path, not just a scenario that calls the incremental
// functions directly.
describe("createFeatureChangeFlusher (issue #120 real event routing)", () => {
	function build() {
		const refreshSidebarState = vi.fn();
		const refreshHomeAll = vi.fn();
		const refreshHomeLive = vi.fn();
		const nudgeAttention = vi.fn();
		let scheduled: (() => void) | undefined;
		const schedule = vi.fn((fn: () => void) => {
			scheduled = fn;
		});
		const flush = createFeatureChangeFlusher(
			{ refreshSidebarState, refreshHomeAll, refreshHomeLive, nudgeAttention },
			150,
			schedule,
		);
		return {
			flush,
			refreshSidebarState,
			refreshHomeAll,
			refreshHomeLive,
			nudgeAttention,
			runScheduled: () => scheduled?.(),
		};
	}

	it("a lone runtime-kind event patches Home incrementally for that Feature only", () => {
		const deps = build();
		deps.flush(snapshot("f1"), "runtime");
		deps.runScheduled();

		expect(deps.refreshSidebarState).toHaveBeenCalledTimes(1);
		expect(deps.refreshHomeAll).not.toHaveBeenCalled();
		expect(deps.refreshHomeLive).toHaveBeenCalledWith({
			featureId: "f1",
			structural: false,
		});
		expect(deps.nudgeAttention).toHaveBeenCalledTimes(1);
	});

	it("a deep-kind event in the same window forces a full Home rebuild", () => {
		const deps = build();
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f1"), "deep");
		deps.runScheduled();

		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);
		expect(deps.refreshHomeLive).not.toHaveBeenCalled();
	});

	it("a structural (undefined snapshot) event in the window forces a full Home rebuild", () => {
		const deps = build();
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(undefined, "structural");
		deps.runScheduled();

		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);
		expect(deps.refreshHomeLive).not.toHaveBeenCalled();
	});

	it("batches runtime events for multiple Features into one incremental patch each", () => {
		const deps = build();
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f2"), "runtime");
		deps.flush(snapshot("f1"), "runtime");
		deps.runScheduled();

		expect(deps.refreshHomeAll).not.toHaveBeenCalled();
		expect(deps.refreshHomeLive).toHaveBeenCalledTimes(2);
		expect(deps.refreshHomeLive).toHaveBeenCalledWith({
			featureId: "f1",
			structural: false,
		});
		expect(deps.refreshHomeLive).toHaveBeenCalledWith({
			featureId: "f2",
			structural: false,
		});
	});

	it("coalesces a burst into a single scheduled flush", () => {
		const deps = build();
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f1"), "runtime");

		expect(deps.refreshSidebarState).not.toHaveBeenCalled();
		deps.runScheduled();
		expect(deps.refreshSidebarState).toHaveBeenCalledTimes(1);
	});

	it("resets tracked state after each flush, so the next window starts clean", () => {
		const deps = build();
		deps.flush(undefined, "structural");
		deps.runScheduled();
		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);

		deps.flush(snapshot("f1"), "runtime");
		deps.runScheduled();

		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);
		expect(deps.refreshHomeLive).toHaveBeenCalledWith({
			featureId: "f1",
			structural: false,
		});
	});
});
