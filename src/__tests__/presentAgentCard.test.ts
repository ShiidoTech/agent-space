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
		review: { pending: false },
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
		).toEqual({
			name: "Agent 1",
			primaryState: {
				label: "Running",
				tone: "normal",
				detail: "Activity unknown: Session is ambiguous",
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

	it("keeps provider recovery out of the normal card", () => {
		const card = presentAgentCard(
			observation({
				session: { state: "unverified", detail: "Session disappeared" },
			}),
		);
		expect(card).toMatchObject({
			name: "Agent 1",
			primaryState: { label: "Working", tone: "working" },
		});
		expect(card).not.toHaveProperty("sessionAction");
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
