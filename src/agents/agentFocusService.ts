import type {
	ProjectContext,
	ProjectManager,
} from "../projects/projectManager";
import type { Agent, Feature } from "../types";
import type { TerminalController } from "./terminalController";

/**
 * Behavioral source of truth for "bring this coding agent's terminal to the
 * foreground". Every surface that focuses an agent terminal — sidebar cards,
 * Home panel cards, notifications — must go through here so they cannot
 * diverge.
 *
 * CONTRACT (guarantees offered to any caller):
 *
 * G1. Warm path is free of side effects and free of resolution: an already
 *     tracked terminal is revealed with ZERO exec/shell/tmux call AND zero
 *     feature/agent lookup (resolveFeature can run synchronous git execs on
 *     the Extension Host). This is the hot switching path and must stay
 *     synchronous and instant.
 *
 * G2. Cold path never blocks the caller: when the VS Code terminal is not
 *     tracked yet (window reload, foreign spawn), tmux/session reconciliation
 *     runs asynchronously off the click stack. The caller gets an immediate
 *     `opening` state instead of waiting.
 *
 * G3. Focus arbitration is global to this service (one monotonic sequence
 *     shared by ALL consumers). A cold resolution whose stamp is no longer
 *     the latest reveals nothing and emits no state: a slow reconciliation
 *     can never steal focus from a newer request (e.g. A cold → B warm).
 *
 * G4. State emission per request, exactly once each, in order:
 *     - warm: one `focused` (synchronous), never `onSettled`.
 *     - cold: one `opening` (synchronous), then exactly one of
 *       `focused` | `failed` when reconciliation settles. `onSettled` fires
 *       once when the reconciliation settles, even if superseded (callers
 *       use it to refresh views, never to claim focus).
 *
 * G5. Unknown feature/agent, missing terminal controller: silent no-op —
 *     no state, no observation, no error surfaced to the user.
 */

export type AgentFocusState = "opening" | "focused" | "failed";

export interface AgentFocusObserver {
	onState?(state: AgentFocusState): void;
	/** Cold path only. Fires when reconciliation settles, even if superseded. */
	onSettled?(): void;
}

export interface AgentFocusDeps {
	getTerminalController(): TerminalController | undefined;
	resolveFeature: ProjectManager["resolveFeature"];
	/**
	 * Cheap, synchronous, in-memory peek at the review receipt currently
	 * shown for this agent — never a disk read. Called synchronously at the
	 * top of {@link requestFocus}, before any async work, to capture exactly
	 * which receipt this click is about to acknowledge. This snapshot is
	 * what later gets compared against in {@link acknowledgeReview}: a
	 * receipt that arrives *after* the click but before the deferred
	 * acknowledgement runs must never be silently swallowed by it (issue
	 * #120 PR2, review round 3).
	 */
	peekPendingReviewId?(featureId: string, agentId: string): string | undefined;
	/**
	 * Compare-and-clear receipt acknowledgement: clears the receipt only if
	 * it still equals `expectedReviewId` (the value captured by
	 * {@link peekPendingReviewId} at click time) — a newer, unrelated
	 * completion that raced in after the click is left untouched. Called
	 * only after a request has genuinely revealed a terminal to the user —
	 * never on a request that fails, is superseded, or targets an unknown
	 * feature/agent — and always deferred off the calling stack (see
	 * {@link requestFocus}), so it can do real (synchronous disk) work
	 * without violating the warm path's zero-exec-on-the-click guarantee
	 * (G1).
	 */
	acknowledgeReview?(
		featureId: string,
		agentId: string,
		expectedReviewId: string,
	): void;
}

/** Unified agent-listing policy: prefer the non-probing read model. */
function listAgents(ctx: ProjectContext, feature: Feature): Agent[] {
	const agentManager = ctx.agentManager;
	return typeof agentManager.getAgentsReadModel === "function"
		? agentManager.getAgentsReadModel(feature.id)
		: agentManager.getAgents(feature.id);
}

export class AgentFocusService {
	private focusSequence = 0;

	constructor(private readonly deps: AgentFocusDeps) {}

	requestFocus(
		featureId: string,
		agentId: string,
		observer?: AgentFocusObserver,
	): void {
		const terminalController = this.deps.getTerminalController();
		if (!terminalController || !featureId) return;

		// Captured synchronously, before any async work — including before
		// the warm-path reveal below — so the receipt this click ends up
		// acknowledging is exactly the one the user was shown, never one
		// that races in later. Cheap in-memory peek only (never disk), so
		// it costs nothing against G1's warm-path guarantee.
		const expectedReviewId = this.deps.peekPendingReviewId?.(
			featureId,
			agentId,
		);

		// G1 — strict fast path FIRST, before any feature/agent resolution:
		// resolving a feature can run synchronous git execs on the Extension
		// Host, and this is the hot interactive path. A tracked terminal is
		// revealed with zero exec of any kind.
		const existing = terminalController.getTerminal(agentId);
		if (existing) {
			// Supersede any in-flight cold reconciliation before claiming
			// focus: this warm click is now the latest request.
			this.focusSequence += 1;
			existing.show();
			observer?.onState?.("focused");
			// Opening/focusing this exact agent is the acknowledgement signal
			// for its "ready for review" receipt (issue #120 section B/PR2).
			// Fired only now that the reveal has genuinely happened, and
			// deferred off this call stack so its disk write can never count
			// against G1's zero-exec-on-the-click guarantee.
			if (expectedReviewId) {
				this.deferAcknowledgeReview(featureId, agentId, expectedReviewId);
			}
			return;
		}

		// Cold path only — resolution happens here, never above.
		const resolved = this.deps.resolveFeature(featureId);
		if (!resolved) return;
		const { ctx, feature } = resolved;
		const agents = listAgents(ctx, feature);
		const agent = agents.find((candidate) => candidate.id === agentId);
		if (!agent) return;
		const agentIndex = agents.indexOf(agent);

		const focusSeq = ++this.focusSequence;

		// G2/G3 — cold path: immediate `opening`, reconciliation off-stack,
		// reveal gated by the latest-stamp rule. Rejections are folded into a
		// `failed` state; a superseded request reveals and claims nothing but
		// still settles (callers refresh their views).
		observer?.onState?.("opening");
		const settle = (state?: AgentFocusState): void => {
			try {
				if (state) observer?.onState?.(state);
			} finally {
				try {
					observer?.onSettled?.();
				} catch (error) {
					console.warn(`[AgentSpace] focus observer failed: ${error}`);
				}
			}
		};
		const finish = (
			terminal:
				| Awaited<ReturnType<TerminalController["focusOrCreateTerminalAsync"]>>
				| undefined,
		): void => {
			const current = focusSeq === this.focusSequence;
			if (current && terminal) {
				terminal.show();
				// Only a genuine, non-superseded reveal acknowledges the
				// receipt — never on failure, never when a newer request has
				// already taken over.
				if (expectedReviewId) {
					this.deferAcknowledgeReview(featureId, agentId, expectedReviewId);
				}
			}
			settle(current ? (terminal ? "focused" : "failed") : undefined);
		};
		void terminalController
			.focusOrCreateTerminalAsync(feature, agent, agentIndex, true)
			.then(finish, (error) => {
				console.warn(
					`[AgentSpace] agent focus reconciliation failed: ${error}`,
				);
				finish(undefined);
			});
	}

	/**
	 * Runs the review-acknowledgement dep off the calling stack (a macrotask
	 * away) so its synchronous disk write never counts against the warm
	 * path's "zero exec on the click" guarantee (G1) — isolated in a
	 * try/catch so a misbehaving dep can never surface as a focus failure.
	 * `expectedReviewId` is the snapshot captured synchronously at click
	 * time (see {@link AgentFocusDeps.peekPendingReviewId}), not whatever
	 * happens to be pending when this timer fires.
	 */
	private deferAcknowledgeReview(
		featureId: string,
		agentId: string,
		expectedReviewId: string,
	): void {
		if (!this.deps.acknowledgeReview) return;
		setTimeout(() => {
			try {
				this.deps.acknowledgeReview?.(featureId, agentId, expectedReviewId);
			} catch (error) {
				console.warn(`[AgentSpace] review acknowledgement failed: ${error}`);
			}
		}, 0);
	}
}
