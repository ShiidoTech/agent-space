import { describe, expect, it, vi } from "vitest";
import { createFeatureChangeFlusher } from "../features/featureChangeRouting";
import type { FeatureSnapshot } from "../features/featureSnapshot";

function snapshot(featureId: string): FeatureSnapshot {
	return { feature: { id: featureId } } as unknown as FeatureSnapshot;
}

// Issue #120 PR review (blocker 3, then residual blocker on the second
// re-review): `FeatureStateCoordinator.onDidChange` is the *real* listener
// extension.ts wires up — these tests exercise the actual routing function
// it uses, not a stand-in, so a pass here proves the production event path.
describe("createFeatureChangeFlusher (issue #120 real event routing)", () => {
	function build(openFeaturePanels: string[] = []) {
		const refreshSidebarState = vi.fn();
		const refreshHomeAll = vi.fn();
		const refreshHomeInstance = vi.fn();
		const open = new Set(openFeaturePanels);
		const patchHomeFeature = vi.fn((featureId: string) => open.has(featureId));
		const nudgeAttention = vi.fn();
		let scheduled: (() => void) | undefined;
		const schedule = vi.fn((fn: () => void) => {
			scheduled = fn;
		});
		const flush = createFeatureChangeFlusher(
			{
				refreshSidebarState,
				refreshHomeAll,
				patchHomeFeature,
				refreshHomeInstance,
				nudgeAttention,
			},
			150,
			schedule,
		);
		return {
			flush,
			refreshSidebarState,
			refreshHomeAll,
			refreshHomeInstance,
			patchHomeFeature,
			nudgeAttention,
			runScheduled: () => scheduled?.(),
		};
	}

	it("a lone runtime-kind event on an open Feature panel patches it, no instance/full rebuild", () => {
		const deps = build(["f1"]);
		deps.flush(snapshot("f1"), "runtime");
		deps.runScheduled();

		expect(deps.refreshSidebarState).toHaveBeenCalledTimes(1);
		expect(deps.refreshHomeAll).not.toHaveBeenCalled();
		expect(deps.patchHomeFeature).toHaveBeenCalledWith("f1");
		expect(deps.refreshHomeInstance).not.toHaveBeenCalled();
		expect(deps.nudgeAttention).toHaveBeenCalledTimes(1);
	});

	it("a runtime event on a Feature with no open panel triggers exactly one bounded instance refresh, never a full rebuild", () => {
		const deps = build([]);
		deps.flush(snapshot("f1"), "runtime");
		deps.runScheduled();

		expect(deps.refreshHomeAll).not.toHaveBeenCalled();
		expect(deps.refreshHomeInstance).toHaveBeenCalledTimes(1);
	});

	it("a deep-kind event in the same window forces a full Home rebuild", () => {
		const deps = build(["f1"]);
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f1"), "deep");
		deps.runScheduled();

		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);
		expect(deps.patchHomeFeature).not.toHaveBeenCalled();
		expect(deps.refreshHomeInstance).not.toHaveBeenCalled();
	});

	it("a structural (undefined snapshot) event in the window forces a full Home rebuild", () => {
		const deps = build(["f1"]);
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(undefined, "structural");
		deps.runScheduled();

		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);
		expect(deps.patchHomeFeature).not.toHaveBeenCalled();
	});

	it("batches runtime events for multiple Features: only the open one is patched, the closed one contributes to a single bounded instance refresh — never a full rebuild, never another Feature's panel", () => {
		const deps = build(["f1"]);
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f2"), "runtime");
		deps.flush(snapshot("f1"), "runtime");
		deps.runScheduled();

		expect(deps.refreshHomeAll).not.toHaveBeenCalled();
		expect(deps.patchHomeFeature).toHaveBeenCalledWith("f1");
		expect(deps.patchHomeFeature).toHaveBeenCalledWith("f2");
		expect(deps.patchHomeFeature).toHaveBeenCalledTimes(2);
		// f2 has no open panel — this must cost at most one instance refresh
		// for the whole flush, not one full rebuild per unopened Feature.
		expect(deps.refreshHomeInstance).toHaveBeenCalledTimes(1);
	});

	it("many runtime Features with no open panel still cost exactly one instance refresh per flush", () => {
		const deps = build([]);
		for (const id of ["f1", "f2", "f3", "f4"]) {
			deps.flush(snapshot(id), "runtime");
		}
		deps.runScheduled();

		expect(deps.refreshHomeAll).not.toHaveBeenCalled();
		expect(deps.refreshHomeInstance).toHaveBeenCalledTimes(1);
	});

	it("coalesces a burst into a single scheduled flush", () => {
		const deps = build(["f1"]);
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f1"), "runtime");
		deps.flush(snapshot("f1"), "runtime");

		expect(deps.refreshSidebarState).not.toHaveBeenCalled();
		deps.runScheduled();
		expect(deps.refreshSidebarState).toHaveBeenCalledTimes(1);
	});

	it("resets tracked state after each flush, so the next window starts clean", () => {
		const deps = build(["f1"]);
		deps.flush(undefined, "structural");
		deps.runScheduled();
		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);

		deps.flush(snapshot("f1"), "runtime");
		deps.runScheduled();

		expect(deps.refreshHomeAll).toHaveBeenCalledTimes(1);
		expect(deps.patchHomeFeature).toHaveBeenCalledWith("f1");
		expect(deps.refreshHomeInstance).not.toHaveBeenCalled();
	});
});
