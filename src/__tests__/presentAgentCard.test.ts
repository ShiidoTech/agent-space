import { describe, expect, it } from "vitest";
import { presentAgentCard } from "../agents/observation/presentAgentCard";
import type { AgentObservation } from "../agents/observation/types";

function observation(
	overrides: Partial<AgentObservation> = {},
): AgentObservation {
	return {
		identity: { agentName: "Agent 1", providerId: "codex" },
		lifecycle: { state: "running", source: "tmux" },
		attention: { state: "working" },
		session: { state: "bound", sessionId: "session-1" },
		...overrides,
	};
}

describe("presentAgentCard", () => {
	it("shows proven runtime while preserving unknown activity in the detail", () => {
		expect(
			presentAgentCard(
				observation({
					attention: { state: "unknown", reason: "Session is ambiguous" },
					session: {
						state: "ambiguous",
						detail: "7 candidate sessions cannot be attributed",
					},
				}),
			),
		).toMatchObject({
			primaryState: {
				label: "Running",
				tone: "normal",
				detail: "Activity unknown: Session is ambiguous",
			},
			sessionAction: {
				kind: "ambiguous",
				label: "Choose session",
				title: "Session needs confirmation",
				description:
					"Activity stays unknown until you choose the matching provider session.",
				className: "binding-badge binding-ambiguous",
			},
		});
	});

	it("keeps an unknown lifecycle unknown", () => {
		expect(
			presentAgentCard(
				observation({
					lifecycle: {
						state: "unknown",
						source: "tmux",
						reason: "tmux unavailable",
					},
					attention: { state: "unknown" },
				}),
			).primaryState,
		).toMatchObject({ label: "Unknown", tone: "warning" });
	});

	it("uses one explicit action for an unverified session", () => {
		expect(
			presentAgentCard(
				observation({
					session: { state: "unverified", detail: "Session disappeared" },
				}),
			).sessionAction,
		).toMatchObject({
			kind: "unverified",
			label: "Choose session",
			title: "Provider session unavailable",
			className: "binding-badge binding-unverified",
		});
	});

	it.each(["bound", "pending", "unsupported"] as const)(
		"keeps %s session health quiet on the card",
		(state) => {
			expect(
				presentAgentCard(observation({ session: { state } })).sessionAction,
			).toBeUndefined();
		},
	);

	it("does not offer a stale session action for a done agent", () => {
		expect(
			presentAgentCard(
				observation({
					lifecycle: { state: "done", source: "agentspace" },
					session: { state: "ambiguous", detail: "Old candidates" },
				}),
			).sessionAction,
		).toBeUndefined();
	});

	it("deduplicates a provider title equal to the stable name", () => {
		expect(
			presentAgentCard(
				observation({
					identity: {
						agentName: "Review checkout",
						sessionTitle: "  review   CHECKOUT ",
					},
				}),
			).secondaryTitle,
		).toBeUndefined();
	});

	it("keeps a distinct provider title secondary", () => {
		expect(
			presentAgentCard(
				observation({
					identity: {
						agentName: "Reviewer",
						sessionTitle: "Review checkout flow",
					},
				}),
			).secondaryTitle,
		).toBe("Review checkout flow");
	});
});
