import type { AgentAttentionAlert, AttentionWatchedAgent } from "./agentAttentionNotifier";
import { AgentAttentionNotifier } from "./agentAttentionNotifier";

export interface AgentAttentionMonitorDeps {
	/**
	 * Collect the agents worth watching right now. Must be non-blocking:
	 * it runs on the monitor's own clock and may only use cached models and
	 * async probes — never synchronous process APIs. Overlapping scans are
	 * coalesced: while a collection is in flight, further ticks are skipped.
	 */
	collect(): Promise<readonly AttentionWatchedAgent[]>;
	/** Surface one alert — the host decides how (notification, sound, ...). */
	onAlert(alert: AgentAttentionAlert): void;
	onError?(error: unknown): void;
}

export interface AgentAttentionMonitorOptions {
	pollIntervalMs: number;
	nudgeDebounceMs?: number;
}

const DEFAULT_NUDGE_DEBOUNCE_MS = 150;

/**
 * Dedicated observation source for agent attention transitions.
 *
 * Why not piggyback on FeatureState changes: the coordinator's light poll
 * uses non-probing read models, so a provider-side transition
 * working -> waiting_for_user does not by itself produce a coordinator
 * change — and reacting to every unrelated change would turn each one into
 * a probe sweep of the whole fleet.
 *
 * This monitor polls on its own clock, fires alerts on the transition
 * itself (one alert per continuous waiting episode, deduplicated by
 * {@link AgentAttentionNotifier}) and keeps the Extension Host free:
 * collection is asynchronous end to end and in-flight scans coalesce —
 * a slow tick never stacks up behind itself. External change hints arrive
 * via {@link nudge}, which coalesces bursts off the caller's stack.
 */
export class AgentAttentionMonitor {
	private readonly notifier = new AgentAttentionNotifier();
	private timer?: ReturnType<typeof setInterval>;
	private nudgeTimer?: ReturnType<typeof setTimeout>;
	private scanning = false;
	private disposed = false;

	constructor(
		private readonly deps: AgentAttentionMonitorDeps,
		private readonly options: AgentAttentionMonitorOptions,
	) {}

	start(): void {
		if (this.disposed || this.timer) return;
		this.timer = setInterval(
			() => void this.scanOnce(),
			this.options.pollIntervalMs,
		);
	}

	/** External change hint: coalesced, asynchronous, never on-stack. */
	nudge(): void {
		if (this.disposed || this.timer === undefined || this.nudgeTimer) return;
		this.nudgeTimer = setTimeout(() => {
			this.nudgeTimer = undefined;
			void this.scanOnce();
		}, this.options.nudgeDebounceMs ?? DEFAULT_NUDGE_DEBOUNCE_MS);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.nudgeTimer !== undefined) {
			clearTimeout(this.nudgeTimer);
			this.nudgeTimer = undefined;
		}
	}

	private async scanOnce(): Promise<void> {
		if (this.disposed || this.scanning) return;
		this.scanning = true;
		try {
			const watched = await this.deps.collect();
			if (this.disposed) return;
			try {
				for (const alert of this.notifier.scan(watched)) {
					this.deps.onAlert(alert);
				}
			} catch (error) {
				this.deps.onError?.(error);
			}
		} catch (error) {
			this.deps.onError?.(error);
		} finally {
			this.scanning = false;
		}
	}
}
