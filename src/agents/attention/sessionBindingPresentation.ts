import type {
	AgentSessionBinding,
	AgentSessionBindingState,
	AgentStatus,
} from "../../types";

/**
 * How a session binding state should read in the UI: a short badge label, a
 * CSS class suffix to hang styling off, and a tooltip.
 *
 * `bound` is deliberately not represented here — it is the expected steady
 * state and gets no badge, so the UI stays quiet when nothing needs the
 * user's attention. Every other state means something worth knowing: a
 * provider that hasn't written a session yet, one that can no longer be
 * found, one Agent Space refuses to guess at, or a tool with no session
 * store at all.
 */
export interface SessionBindingBadge {
	label: string;
	/** CSS class suffix, e.g. "pending" -> "binding-badge binding-pending". */
	className: string;
	tooltip: string;
}

const LABELS: Record<Exclude<AgentSessionBindingState, "bound">, string> = {
	pending: "Session pending",
	ambiguous: "Ambiguous session",
	unverified: "Session lost",
	unsupported: "No session tracking",
};

/**
 * Build the badge for an agent's session binding, or `null` when nothing
 * should be shown (no binding recorded yet, or `bound`).
 *
 * Never infers a state from missing data: an agent that has not been
 * classified yet (`binding` undefined) shows nothing here, the same as a
 * confirmed `bound` binding. Only an explicit non-`bound` state produces a
 * badge, and its text comes from `binding.detail`, which the model already
 * wrote for a human — this only shortens it for a badge and never invents
 * new wording.
 */
export function presentSessionBinding(
	binding: AgentSessionBinding | undefined,
	lifecycleStatus?: AgentStatus,
): SessionBindingBadge | null {
	if (!binding || binding.state === "bound" || lifecycleStatus === "done") {
		return null;
	}
	return {
		label: LABELS[binding.state],
		className: `binding-badge binding-${binding.state}`,
		tooltip: bindingTooltip(binding),
	};
}

function bindingTooltip(binding: AgentSessionBinding): string {
	if (binding.state === "ambiguous") {
		return `${binding.detail} Automatic attachment is refused: explicit attachment or strong provider correlation is required.`;
	}
	return binding.detail;
}
