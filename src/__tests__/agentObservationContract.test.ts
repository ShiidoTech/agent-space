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
});
