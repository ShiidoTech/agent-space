import type { AgentAttentionStatus } from "../../types";
import type {
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
	scanSessions?(options?: { fresh?: boolean }): SessionInfo[];
	/**
	 * True when `sessionId` resolves to a session that actually exists in this
	 * provider's store. Lets Agent Space tell "not bound yet" apart from "bound
	 * to an id the provider has never heard of".
	 */
	hasSession?(sessionId: string): boolean;
	discoverSessionId?(
		cwd: string,
		knownSessionIds: ReadonlySet<string>,
	): string | undefined | Promise<string | undefined>;
}

/**
 * Internal provider contract. Providers are compiled into the extension and
 * added through PRs; project config only selects their stable IDs.
 */
export interface CodingAgentProvider {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
	readonly launchArgs?: (sessionId?: string | null) => string[];
	readonly resumeArgs?: (sessionId?: string | null) => string[];
	getAttentionSignal?(sessionId: string): ProviderAttentionSignal | undefined;
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
