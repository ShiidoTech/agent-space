import { describe, expect, it } from "vitest";
import { presentSessionBinding } from "../agents/attention/sessionBindingPresentation";
import type { AgentSessionBinding, AgentSessionBindingState } from "../types";

function binding(
	state: AgentSessionBindingState,
	detail: string,
): AgentSessionBinding {
	return { state, detail, checkedAt: new Date().toISOString(), attempts: 1 };
}

describe("presentSessionBinding", () => {
	it("shows nothing when no binding has been recorded yet", () => {
		expect(presentSessionBinding(undefined)).toBeNull();
	});

	it("shows nothing for a bound session — the quiet, expected state", () => {
		expect(
			presentSessionBinding(binding("bound", "Session id resolves")),
		).toBeNull();
	});

	it("shows no binding badge for a done agent, even if its old binding is persisted", () => {
		expect(
			presentSessionBinding(
				binding("unverified", "Session disappeared"),
				"done",
			),
		).toBeNull();
	});

	it("badges pending without alarm styling classes", () => {
		const badge = presentSessionBinding(
			binding("pending", "No provider session has appeared in foo yet"),
		);
		expect(badge).not.toBeNull();
		expect(badge?.className).toBe("binding-badge binding-pending");
		expect(badge?.label).toBe("Session pending");
		expect(badge?.tooltip).toBe("No provider session has appeared in foo yet");
	});

	it("badges ambiguous with the fail-closed attachment remediation", () => {
		const badge = presentSessionBinding(
			binding("ambiguous", "2 unclaimed sessions appeared in foo"),
		);
		expect(badge?.className).toBe("binding-badge binding-ambiguous");
		expect(badge?.label).toBe("Ambiguous session");
		expect(badge?.tooltip).toBe(
			"2 unclaimed sessions appeared in foo Automatic attachment is refused: explicit attachment or strong provider correlation is required.",
		);
	});

	it("badges unverified as a lost session, reusing the model's detail verbatim", () => {
		const badge = presentSessionBinding(
			binding("unverified", "Session id is not in the provider store"),
		);
		expect(badge?.className).toBe("binding-badge binding-unverified");
		expect(badge?.label).toBe("Session lost");
		expect(badge?.tooltip).toBe("Session id is not in the provider store");
	});

	it("badges unsupported tools without implying an error", () => {
		const badge = presentSessionBinding(
			binding(
				"unsupported",
				"Provider exposes no session store to bind against",
			),
		);
		expect(badge?.className).toBe("binding-badge binding-unsupported");
		expect(badge?.label).toBe("No session tracking");
	});

	it("never reuses the attention-badge vocabulary — binding and attention are distinct states", () => {
		const state: AgentSessionBindingState[] = [
			"pending",
			"ambiguous",
			"unverified",
			"unsupported",
		];
		for (const s of state) {
			const badge = presentSessionBinding(binding(s, "detail"));
			expect(badge?.label).not.toMatch(/^(Working|Idle|Failed|Done|Unknown)$/);
		}
	});
});
