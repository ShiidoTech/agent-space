/**
 * Counts full-document webview rebuilds (`webview.html = ...`) triggered
 * after the initial mount, per surface. Ordinary state transitions must
 * route through the incremental postMessage protocols instead — a nonzero
 * count during a normal multi-agent transition scenario is a regression
 * (see issue #120: "Zero reload").
 *
 * Initial mount is not counted here — only call `recordFullRebuild` from
 * the *post-mount* refresh path of a provider/panel.
 */

export type WebviewSurface = "sidebar" | "home";

const counts: Record<WebviewSurface, number> = {
	sidebar: 0,
	home: 0,
};

export function recordFullRebuild(surface: WebviewSurface): void {
	counts[surface] += 1;
}

export function getWebviewRebuildCounts(): Readonly<
	Record<WebviewSurface, number>
> {
	return { ...counts };
}

/** Test-only: reset counters between scenarios. */
export function resetWebviewRebuildCounts(): void {
	counts.sidebar = 0;
	counts.home = 0;
}
