import type { AgentAttentionStatus } from "../../types";
import {
	type CodingAgentProvider,
	hasCapability,
	type ProviderAttention,
} from "./types";

export type AttentionStatus = Extract<
	AgentAttentionStatus,
	"working" | "waiting_for_user" | "idle" | "failed" | "unknown"
>;

export interface ResolvedAttention {
	status: AttentionStatus;
	evidence?: string;
}

/** Resolve only structured provider signals; lack of one is explicitly unknown. */
export function resolveAttention(
	provider: CodingAgentProvider,
	sessionId?: string | null,
): ResolvedAttention {
	if (!sessionId) {
		return { status: "unknown" };
	}
	const signal = provider.getAttentionSignal?.(sessionId);
	if (!signal) return { status: "unknown" };
	const capability: ProviderAttention =
		signal.status === "working"
			? "attention.working"
			: signal.status === "waiting_for_user"
				? "attention.waitingForUser"
				: signal.status === "idle"
					? "attention.idle"
					: "attention.failed";
	return hasCapability(provider, capability)
		? { status: signal.status, evidence: signal.evidence }
		: { status: "unknown" };
}
