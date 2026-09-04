import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import type { AgentObservation } from "../agents/observation/types";
import { HomePanel } from "../home/homePanel";
import type { Agent, Feature } from "../types";

const feature: Feature = {
	id: "feature-1",
	name: "Agent cards",
	branch: "feat/agent-cards",
	worktreePath: "/repo/.worktrees/agent-cards",
	status: "active",
	color: "terminal.ansiBlue",
	isolation: "shared",
	createdAt: "2026-08-12T00:00:00.000Z",
};

const agent: Agent = {
	id: "agent-1",
	featureId: feature.id,
	name: "Checkout review",
	sessionTitle: "Inspect checkout regressions",
	sessionId: null,
	toolId: "codex",
	status: "running",
	hasStarted: true,
	createdAt: "2026-08-12T00:00:00.000Z",
};

function renderAgent(observation: AgentObservation): string {
	const panel = Object.create(HomePanel.prototype) as HomePanel;
	Object.assign(panel, {
		toolRegistry: {
			resolveAgentTool: () => ({ id: "codex", name: "Codex" }),
		},
		projectManager: {
			resolveFeature: () => ({
				feature,
				ctx: { agentManager: { observe: () => observation } },
			}),
			findContextByFeatureId: () => ({
				agentManager: { observeCached: () => observation },
			}),
			peekWarmContext: () => ({
				agentManager: { observeCached: () => observation },
			}),
		},
	});

	return (
		panel as unknown as {
			renderAgentPanel: (
				agent: Agent,
				allAgents: Agent[],
				feature: Feature,
			) => string;
		}
	).renderAgentPanel(agent, [agent], feature);
}

function observation(session: AgentObservation["session"]): AgentObservation {
	return {
		identity: {
			agentName: agent.name,
			sessionTitle: agent.sessionTitle,
			providerId: "codex",
		},
		lifecycle: { state: "running", source: "tmux" },
		attention: { state: "unknown", reason: "No attributable session" },
		session,
		review: { pending: false },
	};
}

describe("Home agent card render contract", () => {
	it("keeps identity dominant and separates state from provider metadata", () => {
		const html = renderAgent(
			observation({
				state: "ambiguous",
				detail: "7 candidates cannot be attributed",
			}),
		);

		expect(html).toContain('class="agent-panel-summary"');
		expect(html).toContain('id="agent-name-agent-1"');
		expect(html).toContain(">Checkout review</span>");
		expect(html).toContain('class="agent-primary-state primary-state-normal"');
		expect(html).toContain(">Running</span>");
		expect(html).toContain("Provider &middot; Codex");
		expect(html).toContain("Session &middot; Inspect checkout regressions");
		expect(html.indexOf("Checkout review")).toBeLessThan(
			html.indexOf("Provider &middot; Codex"),
		);
	});

	it("keeps ambiguous provider recovery out of the normal card", () => {
		const html = renderAgent(
			observation({
				state: "ambiguous",
				detail: "7 candidates cannot be attributed",
			}),
		);

		expect(html).not.toContain("agent-session-intervention");
		expect(html).not.toContain("Link conversation");
		expect(html).not.toContain(">Ambiguous session<");
	});

	it("uses textual controls and keeps activity explicitly expandable", () => {
		const html = renderAgent(observation({ state: "bound" }));

		expect(html).toContain(">Open terminal</button>");
		expect(html).toContain(">Mark done</button>");
		expect(html).toContain(">Activity <span");
		expect(html).toContain('id="agent-activity-agent-1"');
		expect(html).not.toContain("&#9243;");
		expect(html).not.toContain("agent-session-intervention");
	});
});
