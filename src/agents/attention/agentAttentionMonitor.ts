import type { AgentAttentionAlert, AttentionWatchedAgent } from "./agentAttentionNotifier";
import { AgentAttentionNotifier } from "./agentAttentionNotifier";

export interface AgentAttentionMonitorDeps {
	/**
	 * Collect the agents worth watching right now. This is the only probing
	 * entry point and it runs on the monitor's own clock (poll tick or
	 * coalesced nudge), never synchronously on a caller's change stack.
	 */
	collect(): AttentionWatchedAgent[];
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
 * a synchronous probe sweep of the whole fleet on the Extension Host.
 *
 * Instead this monitor polls on its own clock and fires alerts on the
 * transition itself (one alert per continuous waiting episode, deduplicated
 * by {@link AgentAttentionNotifier}). External change hints arrive via
 * {@link nudge}, which coalesces bursts and always runs off the caller's
 * stack.
 */
export class AgentAttentionMonitor {
	private readonly notifier = new AgentAttentionNotifier();
	private timer?: ReturnType<typeof setInterval>;
	private nudgeTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(
		private readonly deps: AgentAttentionMonitorDeps,
		private readonly options: AgentAttentionMonitorOptions,
	) {}

	start(): void {
		if (this.disposed || this.timer) return;
		this.timer = setInterval(
			() => this.scanOnce(),
			this.options.pollIntervalMs,
		);
	}

	/** External change hint: coalesced, asynchronous, never on-stack. */
	nudge(): void {
		if (this.disposed || this.timer === undefined || this.nudgeTimer) return;
		this.nudgeTimer = setTimeout(() => {
			this.nudgeTimer = undefined;
			this.scanOnce();
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

	private scanOnce(): void {
		if (this.disposed) return;
		let watched: readonly AttentionWatchedAgent[];
		try {
			watched = this.deps.collect();
		} catch (error) {
			this.deps.onError?.(error);
			return;
		}
		try {
			for (const alert of this.notifier.scan(watched)) {
				this.deps.onAlert(alert);
			}
		} catch (error) {
			this.deps.onError?.(error);
		}
	}
}
