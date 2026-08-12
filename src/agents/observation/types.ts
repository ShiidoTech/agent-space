import type {
	AgentAttentionStatus,
	AgentSessionBindingState,
	AgentStatus,
} from "../../types";

export type AgentLifecycleState = AgentStatus | "starting" | "unknown";

export type AgentObservationAttention =
	| Exclude<AgentAttentionStatus, "done">
	| "unsupported";

export interface AgentObservation {
	identity: {
		agentName: string;
		sessionTitle?: string;
		providerId?: string;
	};
	lifecycle: {
		state: AgentLifecycleState;
		source: "agentspace" | "tmux" | "process";
		reason?: string;
	};
	attention: {
		state: AgentObservationAttention;
		observedAt?: string;
		reason?: string;
	};
	session: {
		state: AgentSessionBindingState;
		sessionId?: string;
		detail?: string;
	};
}

export interface PresentedAgentState {
	label: string;
	tone: "normal" | "working" | "warning" | "error" | "muted";
	detail?: string;
}
