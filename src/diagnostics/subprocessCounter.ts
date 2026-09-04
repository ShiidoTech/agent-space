/**
 * Process-wide subprocess call counters, categorized by what triggered them.
 * Backs the P0 zero-I/O UI perf profiler (`perfProfiler.ts`): a hot path is
 * proven zero-I/O by taking a snapshot before and after it runs and checking
 * every category stayed at zero, not by inspection alone.
 *
 * Kept independent of `perfProfiler.ts` so the low-level exec choke points
 * (`utils/platform.ts`, `gitClient.ts`, provider readers) can record a call
 * unconditionally — recording is a cheap counter increment, not gated by
 * whether a profiler measurement is currently in flight.
 */

export type SubprocessCategory = "tmux" | "git" | "provider" | "other";

const categories: readonly SubprocessCategory[] = [
	"tmux",
	"git",
	"provider",
	"other",
];

function zeroCounts(): Record<SubprocessCategory, number> {
	return { tmux: 0, git: 0, provider: 0, other: 0 };
}

const counts = zeroCounts();

export function recordSubprocessCall(category: SubprocessCategory): void {
	counts[category] += 1;
}

/** Categorize a command/executable string for {@link recordSubprocessCall}. */
export function categorizeCommand(command: string): SubprocessCategory {
	const lower = command.toLowerCase();
	if (/\btmux\b/.test(lower)) return "tmux";
	if (/\bgit\b/.test(lower)) return "git";
	return "other";
}

export function snapshotSubprocessCounts(): Readonly<
	Record<SubprocessCategory, number>
> {
	return { ...counts };
}

export function diffSubprocessCounts(
	before: Readonly<Record<SubprocessCategory, number>>,
	after: Readonly<Record<SubprocessCategory, number>>,
): Record<SubprocessCategory, number> {
	const delta = zeroCounts();
	for (const category of categories) {
		delta[category] = after[category] - before[category];
	}
	return delta;
}

/** Test-only: reset counters between scenarios. */
export function resetSubprocessCounts(): void {
	counts.tmux = 0;
	counts.git = 0;
	counts.provider = 0;
	counts.other = 0;
}
