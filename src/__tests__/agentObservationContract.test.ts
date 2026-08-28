import { describe, expect, it } from "vitest";
import { presentAgentState } from "../agents/observation/presentAgentState";
import type { AgentObservation } from "../agents/observation/types";

function observation(
	overrides: Partial<AgentObservation> = {},
): AgentObservation {
	return {
		identity: { agentName: "Hermes 1" },
		lifecycle: { state: "running", source: "agentspace" },
		attention: { state: "unsupported" },
		session: { state: "unsupported" },
		review: { pending: false },
		...overrides,
	};
}

describe("Agent observation contract", () => {
	it("keeps an incomplete provider useful", () => {
		expect(presentAgentState(observation())).toMatchObject({
			label: "Running",
			tone: "normal",
		});
		expect(presentAgentState(observation()).label).not.toBe("Unknown");
	});

	it("prioritizes user attention over working", () => {
		expect(
			presentAgentState(
				observation({ attention: { state: "waiting_for_user" } }),
			),
		).toMatchObject({ label: "Needs you", tone: "warning" });
	});

	it("keeps binding health out of the primary state", () => {
		expect(
			presentAgentState(
				observation({
					attention: { state: "working" },
					session: { state: "ambiguous", detail: "Two candidates" },
				}),
			),
		).toMatchObject({ label: "Working", tone: "working" });
	});

	it("does not let a done agent regress to live attention", () => {
		expect(
			presentAgentState(
				observation({
					lifecycle: { state: "done", source: "agentspace" },
					attention: { state: "working" },
				}),
			),
		).toMatchObject({ label: "Done", tone: "muted" });
	});

	it("uses Unknown only for a supported provider without evidence", () => {
		expect(
			presentAgentState(
				observation({
					attention: { state: "unknown", reason: "Read failed" },
				}),
			),
		).toMatchObject({ label: "Unknown", detail: "Read failed" });
	});

	it("presents lifecycle observation failures as unknown, not stopped", () => {
		expect(
			presentAgentState(
				observation({
					lifecycle: {
						state: "unknown",
						source: "tmux",
						reason: "tmux observation failed: unavailable",
					},
				}),
			),
		).toMatchObject({
			label: "Unknown",
			tone: "warning",
			detail: "tmux observation failed: unavailable",
		});
	});

	it("exposes tones consumed by the Sidebar primary-state dot classes", () => {
		const cases = [
			["working", "working"],
			["waiting_for_user", "warning"],
			["failed", "error"],
			["unsupported", "normal"],
			["unknown", "muted"],
		] as const;

		for (const [attention, tone] of cases) {
			expect(
				presentAgentState(observation({ attention: { state: attention } })),
			).toMatchObject({ tone });
		}
	});

	describe("review-inbox state (issue #120, PR2 blocker 3)", () => {
		it("shows Ready for review instead of Idle when a completed turn is unacknowledged", () => {
			expect(
				presentAgentState(
					observation({
						attention: { state: "idle" },
						review: { pending: true },
					}),
				),
			).toMatchObject({ label: "Ready for review", tone: "review" });
		});

		it("shows plain Idle once the review receipt is acknowledged", () => {
			expect(
				presentAgentState(
					observation({
						attention: { state: "idle" },
						review: { pending: false },
					}),
				),
			).toMatchObject({ label: "Idle", tone: "normal" });
		});

		it("never lets a pending review mask Needs you or Failed", () => {
			expect(
				presentAgentState(
					observation({
						attention: { state: "waiting_for_user" },
						review: { pending: true },
					}),
				),
			).toMatchObject({ label: "Needs you", tone: "warning" });

			expect(
				presentAgentState(
					observation({
						attention: { state: "failed" },
						review: { pending: true },
					}),
				),
			).toMatchObject({ label: "Failed", tone: "error" });
		});

		// PR2 review round 2, blocker 3: the receipt is independent of the
		// current runtime attention reading — it must outrank Working and
		// Unknown/Unsupported too, not just plain Idle, since it stays true
		// until the user actually opens the agent regardless of what the
		// provider reports in the meantime.
		it("outranks Working: an autonomous next turn does not hide an unacknowledged completion", () => {
			expect(
				presentAgentState(
					observation({
						attention: { state: "working" },
						review: { pending: true },
					}),
				),
			).toMatchObject({ label: "Ready for review", tone: "review" });
		});

		it("outranks Unknown/Unsupported: a quiet provider does not hide an unacknowledged completion", () => {
			expect(
				presentAgentState(
					observation({
						attention: { state: "unknown" },
						review: { pending: true },
					}),
				),
			).toMatchObject({ label: "Ready for review", tone: "review" });

			expect(
				presentAgentState(
					observation({
						attention: { state: "unsupported" },
						review: { pending: true },
					}),
				),
			).toMatchObject({ label: "Ready for review", tone: "review" });
		});

		it("does not apply once the agent has left the running lifecycle", () => {
			expect(
				presentAgentState(
					observation({
						lifecycle: { state: "stopped", source: "agentspace" },
						attention: { state: "idle" },
						review: { pending: true },
					}),
				),
			).toMatchObject({ label: "Stopped", tone: "muted" });
		});
	});
});
