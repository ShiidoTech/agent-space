import type { AgentStatus, CodingTool } from "../../types";
import {
	type CodingAgentProvider,
	hasCapability,
	type ProviderAttention,
} from "./types";

export type AttentionStatus = Extract<
	AgentStatus,
	"running" | "waiting" | "errored" | "unknown"
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
		signal.status === "running"
			? "attention.working"
			: signal.status === "waiting"
				? "attention.waitingForUser"
				: "attention.failed";
	return hasCapability(provider, capability)
		? { status: signal.status, evidence: signal.evidence }
		: { status: "unknown" };
}

export function resolveDisplayStatus(
	tool: CodingTool,
	status: AgentStatus,
	resolveProvider: (tool: CodingTool) => CodingAgentProvider,
): AgentStatus {
	if (status !== "idle") return status;
	return resolveAttention(resolveProvider(tool)).status;
}
