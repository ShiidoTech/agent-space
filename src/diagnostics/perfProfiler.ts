import { agentSpaceDiagnostic } from "./agentSpaceDiagnostics";
import {
	diffSubprocessCounts,
	snapshotSubprocessCounts,
} from "./subprocessCounter";

/**
 * Lightweight perf profiler for the P0 zero-I/O UI mandate: measures wall
 * time and subprocess counts around a named hot-path operation, and reports
 * both to the "Agent Space Diagnostics" output channel. Disabled by default
 * — {@link setPerfProfilerEnabled} is wired to a workspace setting so it
 * costs nothing (not even a `performance.now()` call) when off.
 *
 * Report format (mandate §11):
 * ```
 * [perf] sidebar.refreshState
 * duration=3ms
 * subprocess=0
 * tmux=0
 * git=0
 * provider=0
 * ```
 */

let enabled = false;

export function setPerfProfilerEnabled(next: boolean): void {
	enabled = next;
}

export function isPerfProfilerEnabled(): boolean {
	return enabled;
}

function report(
	name: string,
	durationMs: number,
	startCounts: ReturnType<typeof snapshotSubprocessCounts>,
): void {
	const delta = diffSubprocessCounts(startCounts, snapshotSubprocessCounts());
	const total = delta.tmux + delta.git + delta.provider + delta.other;
	agentSpaceDiagnostic(
		`[perf] ${name}\nduration=${durationMs.toFixed(1)}ms\nsubprocess=${total}\ntmux=${delta.tmux}\ngit=${delta.git}\nprovider=${delta.provider}`,
	);
}

/** Measure a synchronous hot-path operation. No-op overhead when disabled. */
export function measurePerfSync<T>(name: string, fn: () => T): T {
	if (!enabled) return fn();
	const startCounts = snapshotSubprocessCounts();
	const start = performance.now();
	try {
		return fn();
	} finally {
		report(name, performance.now() - start, startCounts);
	}
}

/** Measure an async hot-path operation. No-op overhead when disabled. */
export async function measurePerfAsync<T>(
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (!enabled) return fn();
	const startCounts = snapshotSubprocessCounts();
	const start = performance.now();
	try {
		return await fn();
	} finally {
		report(name, performance.now() - start, startCounts);
	}
}
