import { describe, expect, it } from "vitest";
import { projectFleetRollup } from "../agents/fleetRollup";
import type { AgentObservation } from "../agents/observation/types";
import type { Agent } from "../types";

const agent = (
	id: string,
	_attention: AgentObservation["attention"]["state"],
	extra: Partial<Agent> = {},
): Agent => ({
	id,
	featureId: "feature-1",
	name: id,
	sessionId: `session-${id}`,
	status: "running",
	createdAt: new Date(0).toISOString(),
	...extra,
});

const observation = (
	a: Agent,
	attention: AgentObservation["attention"]["state"],
): AgentObservation => ({
	identity: { agentName: a.name },
	lifecycle: { state: a.status, source: "agentspace" },
	attention: { state: attention },
	session: { state: a.sessionBinding?.state ?? "bound" },
	review: { pending: Boolean(a.pendingReviewId) },
});

describe("fleet rollup", () => {
	it("uses the product priority and preserves exact action targets", () => {
		const agents = [
			agent("need", "waiting_for_user"),
			agent("failed", "working", {
				sessionBinding: {
					state: "unverified",
					checkedAt: "now",
					attempts: 1,
					detail: "missing",
				},
			}),
			agent("review", "idle", { pendingReviewId: "receipt" }),
			agent("working", "working"),
			agent("unknown", "unknown"),
		];
		const rollup = projectFleetRollup(
			agents.map((a) => ({
				agent: a,
				observation: observation(
					a,
					a.id === "review"
						? "idle"
						: a.id === "need"
							? "waiting_for_user"
							: a.id === "working"
								? "working"
								: a.id === "failed"
									? "working"
									: "unknown",
				),
			})),
		);
		expect(rollup).toMatchObject({
			needsYou: 1,
			failed: 1,
			readyForReview: 1,
			working: 1,
			unknown: 1,
		});
		expect(rollup.items.map((item) => item.bucket)).toEqual([
			"needsYou",
			"failed",
			"readyForReview",
			"working",
			"unknown",
		]);
		expect(
			rollup.items.map(({ featureId, agentId }) => ({ featureId, agentId })),
		).toEqual(agents.map(({ featureId, id }) => ({ featureId, agentId: id })));
	});

	it("does not promote non-running lifecycle states or duplicate degraded state", () => {
		const cases = [
			["idle", "idle", "unknown"],
			["starting", "working", "unknown"],
			["stopped", "working", "unknown"],
			["done", "working", "unknown"],
		] as const;
		for (const [id, attention, expected] of cases) {
			const current = agent(id, attention, { status: "running" });
			const result = projectFleetRollup([
				{
					agent: current,
					observation: {
						...observation(current, attention),
						lifecycle: {
							state: id === "starting" ? "starting" : id,
							source: "agentspace",
						},
					},
				},
			]);
			expect(result.items[0]?.bucket, id).toBe(expected);
		}
		const stopped = agent("stopped-ambiguous", "working", {
			status: "stopped",
			sessionBinding: {
				state: "ambiguous",
				checkedAt: "now",
				attempts: 1,
				detail: "two candidates",
			},
		});
		const result = projectFleetRollup([
			{
				agent: stopped,
				observation: {
					...observation(stopped, "working"),
					lifecycle: { state: "stopped", source: "agentspace" },
				},
			},
		]);
		expect(result).toMatchObject({ failed: 0, unknown: 1 });
	});
});
