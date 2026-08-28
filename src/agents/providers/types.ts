import type { AgentAttentionStatus } from "../../types";
import type {
	AsyncSessionObservationAdapter,
	SessionCorrelationContext,
	SessionInfo,
	SessionRenameAdapter,
} from "../sessionProviders/types";

export type ProviderCapability =
	| "launch"
	| "resume"
	| "sessionDiscovery"
	| "sessionNaming"
	| "attention.working"
	| "attention.waitingForUser"
	| "attention.idle"
	| "attention.failed";

export type ProviderAttention = Extract<
	ProviderCapability,
	`attention.${string}`
>;

export interface ProviderCapabilities {
	readonly launch: boolean;
	readonly resume: boolean;
	readonly sessionDiscovery: boolean;
	readonly sessionNaming: boolean;
	readonly attention: Readonly<Record<ProviderAttention, boolean>>;
}

export interface ProviderAttentionSignal {
	status: Extract<
		AgentAttentionStatus,
		"working" | "waiting_for_user" | "idle" | "failed"
	>;
	/** Structured evidence supplied by the provider, never terminal scraping. */
	evidence: string;
	/**
	 * ISO timestamp of the provider event this signal was derived from, when
	 * the provider records one. Used to show how long a state has held. It is
	 * never converted into a different state: an old `working` stays `working`,
	 * because silence is not evidence of waiting.
	 */
	observedAt?: string;
}

export interface ProviderSessionAdapter extends SessionRenameAdapter {
	readonly async?: AsyncSessionObservationAdapter;
	scanSessions?(options?: { fresh?: boolean }): SessionInfo[];
	/**
	 * True when `sessionId` resolves to a session that actually exists in this
	 * provider's store. Lets Agent Space tell "not bound yet" apart from "bound
	 * to an id the provider has never heard of".
	 */
	hasSession?(sessionId: string): boolean;
	/** Best-effort candidates only; this never proves ownership. */
	discoverSessionCandidates?(
		cwd: string,
		knownSessionIds: ReadonlySet<string>,
	): SessionInfo[];
	/** Return an id only with provider-specific proof this launch owns it. */
	correlateOwnedSession?(
		context: SessionCorrelationContext,
	): string | undefined | Promise<string | undefined>;
}

export type ProviderConversationIdentity =
	| {
			/** Agent Space chooses the id before launch and passes it to the CLI. */
			readonly ownership: "preassigned";
			readonly createId: () => string;
	  }
	| {
			/** The provider chooses the id; a provider receipt must prove it later. */
			readonly ownership: "provider_assigned";
	  }
	| {
			/** This provider exposes no durable conversation identity. */
			readonly ownership: "unsupported";
	  };

/**
 * Internal provider contract. Providers are compiled into the extension and
 * added through PRs; project config only selects their stable IDs.
 */
export interface CodingAgentProvider {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
	/**
	 * Provider-owned conversation lifecycle. Callers must not infer this from a
	 * CLI family or from the number/order of files found after launch.
	 */
	readonly conversationIdentity: ProviderConversationIdentity;
	readonly launchArgs?: (sessionId?: string | null) => string[];
	readonly resumeArgs?: (sessionId?: string | null) => string[];
	getAttentionSignal?(sessionId: string): ProviderAttentionSignal | undefined;
	getAttentionSignalAsync?(
		sessionId: string,
	): Promise<ProviderAttentionSignal | undefined>;
	readonly sessionAdapter?: ProviderSessionAdapter;
}

export const NO_ATTENTION_CAPABILITIES: ProviderCapabilities["attention"] = {
	"attention.working": false,
	"attention.waitingForUser": false,
	"attention.idle": false,
	"attention.failed": false,
};

export function hasCapability(
	provider: CodingAgentProvider,
	capability: ProviderCapability,
): boolean {
	if (capability.startsWith("attention.")) {
		return provider.capabilities.attention[capability as ProviderAttention];
	}
	return provider.capabilities[
		capability as "launch" | "resume" | "sessionDiscovery" | "sessionNaming"
	];
}
