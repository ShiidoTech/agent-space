import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Issue #120, PR #121 fourth review: a `"featureRuntimeUpdate"` message must
 * patch only specific leaf elements by id — never a parent container's
 * `innerHTML` — so `<details>` the user has expanded elsewhere on the
 * Feature page (work/committed files, the diagnostics block itself) and any
 * live service-activity content survive an ordinary runtime-only tick (e.g.
 * an agent's attention flipping to `waiting_for_user`). This loads the real
 * `media/webview/home.js` in a `vm` sandbox — not a reimplementation of its
 * logic — and dispatches a real `message` event at its real listener, the
 * same way VS Code's webview host does.
 */
function loadHomeJs() {
	// biome-ignore lint/suspicious/noExplicitAny: minimal DOM stand-in for a vm sandbox
	function makeElement(): any {
		return {
			_innerHTML: "",
			innerHTMLSetCount: 0,
			textContent: "",
			style: {},
			dataset: {},
			get innerHTML() {
				return this._innerHTML;
			},
			set innerHTML(value: string) {
				this._innerHTML = value;
				this.innerHTMLSetCount += 1;
			},
		};
	}

	const registeredIds = [
		"feature-cockpit-headline",
		"feature-cockpit-detail",
		"feature-cockpit-runtime-label",
		"feature-cockpit-primary-action",
		"feature-cockpit-alerts",
		"feature-diagnostics-summary",
		"feature-diagnostics-content",
		// Never referenced by the runtime patch — proves the parent
		// <details>/services subtree can't be touched: there's no id for it
		// to be fetched by.
		"service-activity-pre-svc1",
	] as const;
	// biome-ignore lint/suspicious/noExplicitAny: minimal DOM stand-in for a vm sandbox
	const elements = new Map<string, any>(
		registeredIds.map((id) => [id, makeElement()]),
	);
	elements.get("service-activity-pre-svc1").textContent =
		"captured pane output";

	const requestedIds: string[] = [];
	let messageListener: ((event: { data: unknown }) => void) | undefined;

	const sandbox = {
		acquireVsCodeApi: () => ({ postMessage: () => {} }),
		document: {
			addEventListener: () => {},
			getElementById: (id: string) => {
				requestedIds.push(id);
				return elements.get(id) ?? null;
			},
		},
		window: {
			addEventListener: (type: string, listener: (e: unknown) => void) => {
				if (type === "message") {
					messageListener = listener as (event: { data: unknown }) => void;
				}
			},
		},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
		console,
	};
	vm.createContext(sandbox);
	const code = readFileSync(
		path.join(process.cwd(), "media", "webview", "home.js"),
		"utf-8",
	);
	vm.runInContext(code, sandbox, { filename: "home.js" });

	return {
		dispatch: (message: unknown) => {
			requestedIds.length = 0;
			messageListener?.({ data: message });
		},
		elements,
		requestedIds,
	};
}

describe("home.js featureRuntimeUpdate DOM contract (issue #120, PR #121 fourth review)", () => {
	it("patches only the cockpit/diagnostics leaf fields by id, never a parent container or the services subtree", () => {
		const { dispatch, elements, requestedIds } = loadHomeJs();

		dispatch({
			type: "featureRuntimeUpdate",
			headline: "Needs you",
			detail: "Agent is waiting for input",
			runtimeLabel: "1 agent waiting",
			primaryActionHtml:
				"<button onclick=\"focusAgent('f1','a1')\">Open Agent 1</button>",
			primaryActionKey: "action-1",
			alertsHtml: "",
			alertsKey: "alerts-1",
			diagnosticsSummary: "1 live session",
			diagnosticsContentHtml: "<div>live</div>",
			diagnosticsContentKey: "diag-1",
		});

		expect(elements.get("feature-cockpit-headline").textContent).toBe(
			"Needs you",
		);
		expect(elements.get("feature-cockpit-detail").textContent).toBe(
			"Agent is waiting for input",
		);
		expect(elements.get("feature-cockpit-detail").style.display).toBe("");
		expect(elements.get("feature-cockpit-runtime-label").textContent).toBe(
			"1 agent waiting",
		);
		expect(elements.get("feature-cockpit-primary-action").innerHTML).toContain(
			"Open Agent 1",
		);
		expect(elements.get("feature-diagnostics-summary").textContent).toBe(
			"Diagnostics · 1 live session",
		);
		expect(elements.get("feature-diagnostics-content").innerHTML).toBe(
			"<div>live</div>",
		);

		// Exactly the leaf ids the patch is documented to touch — nothing else,
		// and in particular never any wrapping "*-container" id or a
		// service-activity id (which would imply a parent-subtree replace).
		expect(new Set(requestedIds)).toEqual(
			new Set([
				"feature-cockpit-headline",
				"feature-cockpit-detail",
				"feature-cockpit-runtime-label",
				"feature-cockpit-primary-action",
				"feature-cockpit-alerts",
				"feature-diagnostics-summary",
				"feature-diagnostics-content",
			]),
		);

		// Live service-activity content is untouched: neither its id was
		// requested nor its innerHTML ever assigned.
		const serviceActivity = elements.get("service-activity-pre-svc1");
		expect(serviceActivity.innerHTMLSetCount).toBe(0);
		expect(serviceActivity.textContent).toBe("captured pane output");
	});

	it("hides the detail span instead of clearing it when the update carries no detail", () => {
		const { dispatch, elements } = loadHomeJs();

		dispatch({
			type: "featureRuntimeUpdate",
			headline: "In progress",
			detail: "",
			runtimeLabel: "1 agent running",
			primaryActionHtml: "<button>Continue</button>",
			alertsHtml: "",
			diagnosticsSummary: "1 live session",
			diagnosticsContentHtml: "<div>live</div>",
		});

		expect(elements.get("feature-cockpit-detail").style.display).toBe("none");
	});

	// PR #121 fifth review: an unrelated runtime tick (e.g. a different
	// agent's attention changing) must leave an *unchanged* leaf fragment
	// completely alone — not just avoid touching its parent/siblings — so a
	// "more alerts" <details> the user opened, a collapsed tmux group, or
	// focus inside a Kill button all survive. This proves the three
	// innerHTML-based leaves (primary action, alerts, diagnostics content)
	// are skipped when the server-computed key repeats, and only reassigned
	// when the key actually changes.
	it("only reassigns a leaf's innerHTML when its content key changes, leaving unchanged leaves untouched", () => {
		const { dispatch, elements } = loadHomeJs();
		const primaryAction = elements.get("feature-cockpit-primary-action");
		const alerts = elements.get("feature-cockpit-alerts");
		const diagnosticsContent = elements.get("feature-diagnostics-content");
		// Simulate state a user set inside these leaves before the tick, to
		// prove it isn't touched when the key repeats.
		primaryAction.focusedSentinel = "user-focused-button";
		alerts.openSentinel = "user-expanded-details";
		diagnosticsContent.collapsedSentinel = "user-expanded-group";

		const firstUpdate = {
			type: "featureRuntimeUpdate",
			headline: "1 agent working",
			detail: "",
			runtimeLabel: "1 agent running",
			primaryActionHtml: "<button>Continue</button>",
			primaryActionKey: "action-1",
			alertsHtml: "<details>alerts</details>",
			alertsKey: "alerts-1",
			diagnosticsSummary: "1 live session",
			diagnosticsContentHtml: "<div>diagnostics</div>",
			diagnosticsContentKey: "diag-1",
		};
		dispatch(firstUpdate);
		expect(primaryAction.innerHTMLSetCount).toBe(1);
		expect(alerts.innerHTMLSetCount).toBe(1);
		expect(diagnosticsContent.innerHTMLSetCount).toBe(1);

		// Second tick: only the headline changed (a different agent went
		// waiting_for_user); every leaf key repeats.
		dispatch({
			...firstUpdate,
			headline: "Needs you",
			runtimeLabel: "1 agent waiting",
		});

		expect(elements.get("feature-cockpit-headline").textContent).toBe(
			"Needs you",
		);
		// The three keyed leaves were never reassigned a second time...
		expect(primaryAction.innerHTMLSetCount).toBe(1);
		expect(alerts.innerHTMLSetCount).toBe(1);
		expect(diagnosticsContent.innerHTMLSetCount).toBe(1);
		// ...and whatever lived inside them (a sentinel standing in for open/
		// focused/collapsed UI state) is exactly as it was.
		expect(primaryAction.focusedSentinel).toBe("user-focused-button");
		expect(alerts.openSentinel).toBe("user-expanded-details");
		expect(diagnosticsContent.collapsedSentinel).toBe("user-expanded-group");

		// A third tick where diagnostics genuinely changed (a tmux session
		// died) patches only that leaf.
		dispatch({
			...firstUpdate,
			diagnosticsContentHtml: "<div>diagnostics — session stopped</div>",
			diagnosticsContentKey: "diag-2",
		});
		expect(diagnosticsContent.innerHTML).toBe(
			"<div>diagnostics — session stopped</div>",
		);
		expect(diagnosticsContent.innerHTMLSetCount).toBe(2);
		expect(primaryAction.innerHTMLSetCount).toBe(1);
		expect(alerts.innerHTMLSetCount).toBe(1);
	});
});
