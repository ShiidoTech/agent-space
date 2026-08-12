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

function attachProviderSession(e, featureId, agentId) {
	e.stopPropagation();
	send("attachProviderSession", { featureId: featureId, agentId: agentId });
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

let _lastFocusedAgentEl = null;

function focusAgent(e, featureId, agentId) {
	e.stopPropagation();
	// Give immediate visual feedback on click, before the round trip to the
	// extension host — the click must never wait on tmux/session work to
	// feel acknowledged.
	var el =
		(e.currentTarget && e.currentTarget.nodeType === 1 && e.currentTarget) ||
		document.querySelector('[data-agent-id="' + agentId + '"]');
	if (_lastFocusedAgentEl && _lastFocusedAgentEl !== el) {
		_lastFocusedAgentEl.classList.remove("agent-focused", "opening");
	}
	if (el) {
		el.classList.add("agent-focused");
		el.classList.add("opening");
		_lastFocusedAgentEl = el;
	}
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
	integrated: "Integrated",
	merged: "Merged",
};

function updateSessionAction(agentEl, agentId, action) {
	var badge = agentEl.querySelector('[data-binding-badge="' + agentId + '"]');
	if (!badge) return;
	if (!action) {
		badge.style.display = "none";
		badge.title = "";
		return;
	}

	badge.className = "binding-action " + action.className;
	badge.textContent = action.label;
	badge.title = action.tooltip || "";
	badge.style.display = "";
}

window.addEventListener("message", function (event) {
	var msg = event.data;

	if (msg.type === "agentFocusState") {
		var focusEl = document.querySelector(
			'[data-agent-id="' + msg.agentId + '"]',
		);
		if (focusEl) {
			focusEl.classList.toggle("opening", msg.state === "opening");
		}
		return;
	}

	if (msg.type !== "sidebarUpdate" || !msg.data) return;

	var needsFullRefresh = false;
	var projects = msg.data.projects;
	var observedFeatureIds = {};

	for (var p = 0; p < projects.length; p++) {
		var proj = projects[p];
		for (var f = 0; f < proj.features.length; f++) {
			var feat = proj.features[f];
			observedFeatureIds[feat.id] = true;
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
			var observedAgentIds = {};
			for (
				var a = 0;
				feat.agentsKnown !== false && a < feat.agents.length;
				a++
			) {
				var agent = feat.agents[a];
				observedAgentIds[agent.id] = true;
				var agentEl = card.querySelector('[data-agent-id="' + agent.id + '"]');
				if (!agentEl) {
					needsFullRefresh = true;
					continue;
				}

				var cardPresentation = agent.cardPresentation || {};
				var presented = cardPresentation.primaryState || {
					label: "Unknown",
					tone: "muted",
				};
				var dot = agentEl.querySelector(
					'[data-attention-dot="' + agent.id + '"]',
				);
				if (dot) {
					dot.className = "status-dot primary-state-" + presented.tone;
				}

				updateSessionAction(agentEl, agent.id, cardPresentation.sessionAction);
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
			if (feat.agentsKnown !== false) {
				card.querySelectorAll("[data-agent-id]").forEach(function (agentEl) {
					if (!observedAgentIds[agentEl.getAttribute("data-agent-id")]) {
						needsFullRefresh = true;
					}
				});
			}

			// Update service statuses
			var observedServiceIds = {};
			for (
				var s = 0;
				feat.servicesKnown !== false && s < feat.services.length;
				s++
			) {
				var svc = feat.services[s];
				observedServiceIds[svc.id] = true;
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
			if (feat.servicesKnown !== false) {
				card
					.querySelectorAll("[data-service-id]")
					.forEach(function (serviceEl) {
						if (
							!observedServiceIds[serviceEl.getAttribute("data-service-id")]
						) {
							needsFullRefresh = true;
						}
					});
			}

			// Update collapse count
			var activeCount =
				feat.agentsKnown === false || feat.servicesKnown === false
					? null
					: feat.agents.filter(function (a) {
							return a.status !== "done";
						}).length +
						feat.services.filter(function (s) {
							return s.status === "running";
						}).length;
			var countEl = document.getElementById("collapse-count-" + feat.id);
			if (countEl) {
				countEl.textContent =
					activeCount === null
						? "?"
						: activeCount > 0
							? String(activeCount)
							: "";
			}
		}
	}
	document.querySelectorAll("[data-feature-id]").forEach(function (card) {
		if (!observedFeatureIds[card.getAttribute("data-feature-id")]) {
			needsFullRefresh = true;
		}
	});

	if (needsFullRefresh) {
		send("requestFullRefresh");
	}
});
