const vscode = acquireVsCodeApi();

function send(command, data) {
	vscode.postMessage({ command, ...data });
}

function selectFeature(id) {
	send("selectFeature", { featureId: id });
}

function openProject(e, projectId) {
	e.stopPropagation();
	send("openProject", { projectId });
}

function openProjectSettings(e, projectId) {
	e.stopPropagation();
	send("openProjectSettings", { projectId });
}

function newFeature(e, projectId) {
	e.stopPropagation();
	send("newFeature", { projectId: projectId });
}

function addAgent(e, id) {
	e.stopPropagation();
	send("addAgent", { featureId: id });
}

function deleteFeature(e, id) {
	e.stopPropagation();
	send("deleteFeature", { featureId: id });
}

function addService(e, id) {
	e.stopPropagation();
	send("addService", { featureId: id });
}

function openGitView(e, id) {
	e.stopPropagation();
	send("openGitView", { featureId: id });
}

function syncNames(e) {
	e.stopPropagation();
	send("syncNames");
}

function focusService(e, featureId, serviceId) {
	e.stopPropagation();
	send("focusService", { featureId: featureId, serviceId: serviceId });
}

function stopService(e, featureId, serviceId) {
	e.stopPropagation();
	send("stopService", { featureId: featureId, serviceId: serviceId });
}

function restartService(e, featureId, serviceId) {
	e.stopPropagation();
	send("restartService", { featureId: featureId, serviceId: serviceId });
}

function reopenAgent(e, featureId, agentId) {
	e.stopPropagation();
	send("reopenAgent", { featureId: featureId, agentId: agentId });
}

function focusAgent(e, featureId, agentId) {
	e.stopPropagation();
	send("focusAgent", { featureId: featureId, agentId: agentId });
}

function deleteAgent(e, featureId, agentId) {
	e.stopPropagation();
	send("deleteAgent", { featureId: featureId, agentId: agentId });
}

function toggleDisabled(e, featureId) {
	e.stopPropagation();
	const body = document.getElementById("disabled-list-" + featureId);
	const toggle = document.getElementById("disabled-toggle-" + featureId);
	if (body && toggle) {
		body.classList.toggle("collapsed");
		const header = e.currentTarget;
		header.classList.toggle("collapsed");
	}
}

function toggleStoppedServices(e, featureId) {
	e.stopPropagation();
	const body = document.getElementById("stopped-svc-list-" + featureId);
	if (body) {
		body.classList.toggle("collapsed");
		const header = e.currentTarget;
		header.classList.toggle("collapsed");
	}
}

// Context Menu Logic
let _menuFeatureId = "";
let _menuAgentId = "";
const _agentMenu = document.getElementById("agentContextMenu");
const MENU_VIEWPORT_GUTTER = 8;

document.getElementById("menuRename").addEventListener("click", (e) => {
	e.stopPropagation();
	_agentMenu.classList.remove("visible");
	send("renameAgent", { featureId: _menuFeatureId, agentId: _menuAgentId });
});

document.getElementById("menuMarkDone").addEventListener("click", (e) => {
	e.stopPropagation();
	_agentMenu.classList.remove("visible");
	send("closeAgent", { featureId: _menuFeatureId, agentId: _menuAgentId });
});

document.getElementById("menuDeleteAgent").addEventListener("click", (e) => {
	e.stopPropagation();
	_agentMenu.classList.remove("visible");
	send("deleteAgent", { featureId: _menuFeatureId, agentId: _menuAgentId });
});

function showAgentMenu(e, featureId, agentId) {
	e.preventDefault();
	e.stopPropagation();
	if (!_agentMenu) return;

	// Close other menus
	closeAllMenus();

	_menuFeatureId = featureId;
	_menuAgentId = agentId;

	// Capture click coordinates before any DOM mutations
	const clickX = e.clientX;
	const clickY = e.clientY;

	_agentMenu.style.visibility = "hidden";
	_agentMenu.classList.add("visible");
	_agentMenu.style.left = "0px";
	_agentMenu.style.top = "0px";

	// Defer layout reads to next frame to avoid forced synchronous layout
	requestAnimationFrame(function () {
		const menuWidth = _agentMenu.offsetWidth;
		const menuHeight = _agentMenu.offsetHeight;
		const maxLeft = Math.max(
			MENU_VIEWPORT_GUTTER,
			window.innerWidth - menuWidth - MENU_VIEWPORT_GUTTER,
		);
		const maxTop = Math.max(
			MENU_VIEWPORT_GUTTER,
			window.innerHeight - menuHeight - MENU_VIEWPORT_GUTTER,
		);
		const left = Math.min(Math.max(clickX, MENU_VIEWPORT_GUTTER), maxLeft);
		const top = Math.min(Math.max(clickY, MENU_VIEWPORT_GUTTER), maxTop);

		_agentMenu.style.left = left + "px";
		_agentMenu.style.top = top + "px";
		_agentMenu.style.visibility = "";
	});
}

function closeAllMenus() {
	if (_agentMenu) {
		_agentMenu.classList.remove("visible");
		_agentMenu.style.visibility = "";
	}
}

// Global click to close menus
document.addEventListener("click", () => {
	closeAllMenus();
});

// Close on scroll
window.addEventListener(
	"scroll",
	() => {
		closeAllMenus();
	},
	true,
);

window.addEventListener("resize", () => {
	closeAllMenus();
});

function toggleFeatureCard(e, featureId) {
	e.stopPropagation();
	var body = document.getElementById("card-body-" + featureId);
	var chevron = document.getElementById("card-chevron-" + featureId);
	var count = document.getElementById("collapse-count-" + featureId);
	if (body) {
		var collapsed = !body.classList.contains("collapsed");
		body.classList.toggle("collapsed");
		if (chevron) {
			chevron.classList.toggle("rotated", collapsed);
		}
		if (count) {
			count.classList.toggle("visible", collapsed);
		}
	}
}

function toggleIsolation(e, featureId) {
	e.stopPropagation();
	send("toggleIsolation", { featureId: featureId });
}

function removeProject(e) {
	e.stopPropagation();
	send("removeProject");
}

function toggleProject(id) {
	const body = document.getElementById("project-body-" + id);
	const header = document.querySelector(`.project-header[onclick*="${id}"]`);

	if (body && header) {
		body.classList.toggle("collapsed");
		header.classList.toggle("collapsed");
	}
}

// -- Incremental sidebar updates via postMessage ----------------------------
const STATUS_LABELS = {
	"new": "New",
	modified: "Modified",
	ahead: "Ahead",
	merged: "Merged",
};

const ATTENTION_LABELS = {
	working: "Working",
	waiting_for_user: "Waiting for you",
	idle: "Idle",
	failed: "Failed",
	done: "Done",
	unknown: "Unknown",
};

// Mirrors src/agents/attention/sessionBindingPresentation.ts. `bound` (and no
// binding at all) renders nothing — it is the quiet, expected state.
const BINDING_LABELS = {
	pending: "Session pending",
	ambiguous: "Ambiguous session",
	unverified: "Session lost",
	unsupported: "No session tracking",
};

const LIFECYCLE_LABELS = {
	running: "Running",
	stopped: "Stopped",
	done: "Done",
	errored: "Errored",
	idle: "Idle",
};

function updateBindingBadge(agentEl, agent) {
	if (agent.status === "done") {
		var doneBadge = agentEl.querySelector(
			'[data-binding-badge="' + agent.id + '"]',
		);
		if (doneBadge) doneBadge.remove();
		return;
	}
	var badge = agentEl.querySelector('[data-binding-badge="' + agent.id + '"]');
	var state = agent.bindingState;
	var label = state && state !== "bound" ? BINDING_LABELS[state] : null;

	if (!label) {
		if (badge) badge.remove();
		return;
	}

	var tooltip = agent.bindingDetail || "";
	if (state === "ambiguous" && tooltip) {
		tooltip +=
			" Automatic attachment is refused: explicit attachment or strong provider correlation is required.";
	}

	if (!badge) {
		badge = document.createElement("span");
		badge.setAttribute("data-binding-badge", agent.id);
		var statusEl = agentEl.querySelector(".agent-status");
		if (statusEl) statusEl.appendChild(badge);
	}
	badge.className = "binding-badge binding-" + state;
	badge.textContent = label;
	badge.title = tooltip;
}

window.addEventListener("message", function (event) {
	var msg = event.data;
	if (msg.type !== "sidebarUpdate" || !msg.data) return;

	var needsFullRefresh = false;
	var projects = msg.data.projects;

	for (var p = 0; p < projects.length; p++) {
		var proj = projects[p];
		for (var f = 0; f < proj.features.length; f++) {
			var feat = proj.features[f];
			var card = document.querySelector('[data-feature-id="' + feat.id + '"]');
			if (!card) {
				needsFullRefresh = true;
				continue;
			}

			// Update git status badge
			if (!feat.isBase && feat.gitStatus) {
				var badge = card.querySelector('[data-status-badge="' + feat.id + '"]');
				if (badge) {
					badge.className = "status-badge status-" + feat.gitStatus;
					badge.textContent = STATUS_LABELS[feat.gitStatus] || feat.gitStatus;
				}
			}

			// Update agent lifecycle + attention status
			for (var a = 0; a < feat.agents.length; a++) {
				var agent = feat.agents[a];
				var agentEl = card.querySelector('[data-agent-id="' + agent.id + '"]');
				if (!agentEl) {
					needsFullRefresh = true;
					continue;
				}

				var attention = agent.attentionStatus || "unknown";
				var presented = agent.presentedState || {
					label:
						attention === "unsupported"
							? "Running"
							: ATTENTION_LABELS[attention] || attention,
					tone: attention,
				};
				var dot = agentEl.querySelector(
					'[data-attention-dot="' + agent.id + '"]',
				);
				if (dot) {
					dot.className = "status-dot " + presented.tone;
				}

				updateBindingBadge(agentEl, agent);
				var lifecycleBadge = agentEl.querySelector(
					'[data-lifecycle-badge="' + agent.id + '"]',
				);
				if (lifecycleBadge) {
					lifecycleBadge.textContent = presented.label;
					lifecycleBadge.className =
						"lifecycle-badge primary-state-" + presented.tone;
					lifecycleBadge.title = presented.detail || "";
				}

				// Keep card-level classes tied to persisted lifecycle state.
				var statusClass = "idle";
				if (agent.status === "running") statusClass = "running";
				if (agent.status === "stopped") statusClass = "stopped";
				if (agent.status === "done") statusClass = "done";
				if (agent.status === "errored") statusClass = "errored";

				agentEl.className =
					agentEl.className
						.replace(/\b(idle|running|stopped|done|errored)\b/g, "")
						.trim() +
					" " +
					statusClass;
			}

			// Update service statuses
			for (var s = 0; s < feat.services.length; s++) {
				var svc = feat.services[s];
				var svcEl = card.querySelector('[data-service-id="' + svc.id + '"]');
				if (!svcEl) {
					needsFullRefresh = true;
					continue;
				}
				svcEl.className =
					svcEl.className.replace(/\b(running|stopped|errored)\b/g, "").trim() +
					" " +
					svc.status;
			}

			// Update collapse count
			var activeCount =
				feat.agents.filter(function (a) {
					return a.status !== "done";
				}).length +
				feat.services.filter(function (s) {
					return s.status === "running";
				}).length;
			var countEl = document.getElementById("collapse-count-" + feat.id);
			if (countEl) {
				countEl.textContent = activeCount > 0 ? String(activeCount) : "";
			}
		}
	}

	if (needsFullRefresh) {
		send("requestFullRefresh");
	}
});
