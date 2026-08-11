import type { Agent, Service } from "../types";

export type RuntimeObservation<T> =
	| { readonly status: "known"; readonly value: T }
	| {
			readonly status: "unknown";
			readonly reason: "not_observed" | "read_failed";
			readonly detail?: string;
	  };

export interface AgentRuntimeEvidence {
	readonly agent: Readonly<Agent>;
	readonly tmuxAlive: RuntimeObservation<boolean>;
}

export interface ServiceRuntimeEvidence {
	readonly service: Readonly<Service>;
	readonly tmuxAlive: RuntimeObservation<boolean>;
}

export interface FeatureRuntimeInput {
	readonly agents: RuntimeObservation<readonly Agent[]>;
	readonly services: RuntimeObservation<readonly Service[]>;
	readonly agentTmux?: ReadonlyMap<string, RuntimeObservation<boolean>>;
	readonly serviceTmux?: ReadonlyMap<string, RuntimeObservation<boolean>>;
}

export interface FeatureRuntimeObservation {
	readonly agents: RuntimeObservation<readonly AgentRuntimeEvidence[]>;
	readonly services: RuntimeObservation<readonly ServiceRuntimeEvidence[]>;
}

export function knownRuntime<T>(value: T): RuntimeObservation<T> {
	return { status: "known", value };
}

export function unknownRuntime(
	reason: "not_observed" | "read_failed",
	detail?: string,
): RuntimeObservation<never> {
	return { status: "unknown", reason, ...(detail ? { detail } : {}) };
}

/** Purely packages runtime reads; absent tmux evidence remains unknown. */
export function observeFeatureRuntime(
	input: FeatureRuntimeInput,
): FeatureRuntimeObservation {
	return {
		agents:
			input.agents.status === "unknown"
				? input.agents
				: knownRuntime(
						input.agents.value.map((agent) => ({
							agent: structuredClone(agent),
							tmuxAlive:
								input.agentTmux?.get(agent.id) ??
								unknownRuntime("not_observed"),
						})),
					),
		services:
			input.services.status === "unknown"
				? input.services
				: knownRuntime(
						input.services.value.map((service) => ({
							service: structuredClone(service),
							tmuxAlive:
								input.serviceTmux?.get(service.id) ??
								unknownRuntime("not_observed"),
						})),
					),
	};
}

export class RuntimeObserver {
	observe(input: FeatureRuntimeInput): FeatureRuntimeObservation {
		return observeFeatureRuntime(input);
	}
}
