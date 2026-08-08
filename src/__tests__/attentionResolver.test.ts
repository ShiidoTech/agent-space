import { describe, expect, it } from "vitest";
import { resolveAttention } from "../agents/providers/attentionResolver";
import { NO_ATTENTION_CAPABILITIES } from "../agents/providers/types";

describe("resolveAttention", () => {
	it("returns unknown when a provider has no structured attention capability", () => {
		expect(
			resolveAttention(
				{
					id: "opencode",
					capabilities: {
						launch: true,
						resume: true,
						sessionDiscovery: true,
						sessionNaming: true,
						attention: NO_ATTENTION_CAPABILITIES,
					},
				},
				"session-1",
			),
		).toEqual({ status: "unknown" });
	});

	it("accepts a structured waiting signal", () => {
		const provider = {
			id: "fixture",
			capabilities: {
				launch: true,
				resume: false,
				sessionDiscovery: false,
				sessionNaming: false,
				attention: {
					...NO_ATTENTION_CAPABILITIES,
					"attention.waitingForUser": true,
				},
			},
			getAttentionSignal: () => ({
				status: "waiting" as const,
				evidence: "structured.fixture.waiting",
			}),
		};
		expect(resolveAttention(provider, "session-1")).toEqual({
			status: "waiting",
			evidence: "structured.fixture.waiting",
		});
	});
});
