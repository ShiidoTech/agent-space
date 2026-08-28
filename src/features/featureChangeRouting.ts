import type { FeatureSnapshot } from "./featureSnapshot";
import type { FeatureSnapshotChangeKind } from "./featureStateCoordinator";

export interface FeatureChangeRoutingDeps {
	/** Patch the sidebar's live state (never a full webview rebuild). */
	refreshSidebarState(): void;
	/** Full rebuild of every open Home/Feature panel. */
	refreshHomeAll(): void;
	/**
	 * Patch one already-open Feature panel incrementally. Must return
	 * `false` (no side effect) when that Feature has no open panel — the
	 * flusher uses the return value to decide whether the portfolio
	 * singleton needs a bounded fallback, and must never rebuild an
	 * unrelated Feature panel to cover this case.
	 */
	patchHomeFeature(featureId: string): boolean;
	/**
	 * Rebuild only the singleton portfolio/project Home panel — never a
	 * Feature panel. Called at most once per flush, only when at least one
	 * runtime-changed Feature had no open panel to patch (portfolio/project
	 * rollups aren't incremental yet — issue #120 follow-up).
	 */
	refreshHomeInstance(): void;
	nudgeAttention(): void;
}

/**
 * Builds the `FeatureStateCoordinator.onDidChange` listener: debounces a
 * burst of change events into one flush (matching the previous behavior),
 * but — issue #120 — only routes Home to an incremental per-Feature patch
 * when *every* event in the debounce window was a pure `"runtime"` update
 * (agent/service liveness, never adds/removes a card). Anything else in the
 * window (deep Git/GitHub evidence, a structural add/remove, or an unscoped
 * event) falls back to a full rebuild of every open Home/Feature panel, so
 * stale delivery/Git state is never shown.
 *
 * Within a runtime-only window, each changed Feature's own open panel (if
 * any) is patched directly; a Feature with no open panel never triggers a
 * rebuild of other, unrelated Feature panels — at most one bounded
 * portfolio-singleton refresh covers that case, regardless of how many
 * such Features changed in the window.
 */
export function createFeatureChangeFlusher(
	deps: FeatureChangeRoutingDeps,
	debounceMs = 150,
	schedule: (fn: () => void, ms: number) => void = setTimeout,
): (
	snapshot: FeatureSnapshot | undefined,
	kind: FeatureSnapshotChangeKind,
) => void {
	let queued = false;
	let onlyRuntime = true;
	const runtimeFeatureIds = new Set<string>();

	return (snapshot, kind) => {
		if (kind !== "runtime" || !snapshot) {
			onlyRuntime = false;
		} else {
			runtimeFeatureIds.add(snapshot.feature.id);
		}
		if (queued) return;
		queued = true;
		schedule(() => {
			queued = false;
			const flushOnlyRuntime = onlyRuntime;
			const flushFeatureIds = [...runtimeFeatureIds];
			onlyRuntime = true;
			runtimeFeatureIds.clear();

			deps.refreshSidebarState();
			if (flushOnlyRuntime && flushFeatureIds.length > 0) {
				let needsInstanceRefresh = false;
				for (const featureId of flushFeatureIds) {
					if (!deps.patchHomeFeature(featureId)) {
						needsInstanceRefresh = true;
					}
				}
				if (needsInstanceRefresh) deps.refreshHomeInstance();
			} else {
				deps.refreshHomeAll();
			}
			deps.nudgeAttention();
		}, debounceMs);
	};
}
