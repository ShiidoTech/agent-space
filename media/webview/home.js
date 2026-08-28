// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

function send(command, data) {
	vscode.postMessage({ command, ...data });
}

// -- Project page delegated actions --------------------------
// Branch names and paths are carried in data-* attributes and read through
// dataset, never interpolated into inline JS: an apostrophe or parenthesis
// in a valid Git branch name cannot break or inject the handler.
document.addEventListener("click", (event) => {
	const target = /** @type {HTMLElement} */ (event.target);
	if (!target || typeof target.closest !== "function") return;

	const deleteButton = target.closest(".worktree-branch-delete");
	if (deleteButton) {
		event.stopPropagation();
		send("deleteWorktreeBranch", {
			projectId: deleteButton.dataset.projectId,
			branchRef: deleteButton.dataset.branchRef,
			worktreePath: deleteButton.dataset.worktreePath,
		});
		return;
	}
	const protectButton = target.closest(".worktree-branch-protect");
	if (protectButton) {
		event.stopPropagation();
		send("addProtectedBranch", {
			projectId: protectButton.dataset.projectId,
			branchRef: protectButton.dataset.branchRef,
		});
		return;
	}

	const updateButton = target.closest(".project-base-update-btn");
	if (updateButton) {
		send("updateBaseBranch", { projectId: updateButton.dataset.projectId });
	}
});

// -- Welcome View Actions ------------------------------------
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function openFeature(featureId) {
	send("showFeature", { featureId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function newFeature(projectId) {
	send("newFeature", { projectId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function addProject() {
	send("addProject");
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function editProjectBaseBranch(projectId) {
	send("editProjectBaseBranch", { projectId });
}

/** @param {string} projectId */
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function showProject(projectId) {
	send("showProject", { projectId });
}

/** @param {string=} projectId */
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function showProblems(projectId) {
	send("showProblems", { projectId });
}

/** @param {string} severity */
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function filterProblems(severity) {
	document.body.dataset.severityFilter = severity;
	for (const btn of document.querySelectorAll(".problems-filter")) {
		btn.classList.toggle(
			"active",
			/** @type {HTMLElement} */ (btn.dataset.severity ?? "all") === severity,
		);
	}
}

/** @param {string} projectId */
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function showProjectSettings(projectId) {
	send("showProjectSettings", { projectId });
}

/** @param {string} projectId */
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function saveProjectConfig(projectId) {
	const editor = /** @type {HTMLTextAreaElement|null} */ (
		document.getElementById("project-config-" + projectId)
	);
	if (!editor) return;
	send("saveProjectConfig", { projectId, content: editor.value });
}

/** @param {string} projectId */
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function removeProject(projectId) {
	send("removeProject", { projectId });
}

function attachProviderSession(featureId, agentId) {
	send("attachProviderSession", { featureId, agentId });
}

// -- Feature Home Actions ------------------------------------
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function goHome() {
	send("showWelcome");
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function focusAgent(featureId, agentId) {
	send("focusAgent", { featureId, agentId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function focusService(featureId, serviceId) {
	send("focusService", { featureId, serviceId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function killAgentSession(featureId, agentId) {
	send("killAgentSession", { featureId, agentId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function killServiceSession(featureId, serviceId) {
	send("killServiceSession", { featureId, serviceId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function killFeatureSessions(featureId) {
	send("killFeatureSessions", { featureId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function killProjectSessions(projectId) {
	send("killProjectSessions", { projectId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function markAgentDone(featureId, agentId) {
	const agentName =
		document.getElementById(`agent-name-${agentId}`)?.textContent?.trim() ||
		"this agent";
	showConfirmation(
		`Mark "${agentName}" as done?`,
		"This will stop the agent session.",
		() => send("closeAgent", { featureId, agentId }),
	);
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function reopenAgent(featureId, agentId) {
	send("reopenAgent", { featureId, agentId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function deleteFeature(featureId) {
	send("deleteFeature", { featureId });
}

// The extension host resolves the observed PR URL from the Feature snapshot;
// the webview supplies only the Feature identity.
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function openPullRequest(featureId) {
	send("openPullRequest", { featureId });
}

// -- Inline Confirmation Banner ------------------------------
function showConfirmation(title, message, onConfirm, danger = false) {
	dismissConfirmation();

	const banner = document.createElement("div");
	banner.className = `confirmation-banner ${danger ? "danger" : ""}`;
	banner.id = "active-confirmation";
	banner.innerHTML = `
		<div class="confirmation-content">
			<strong>${title}</strong>
			<span>${message}</span>
		</div>
		<div class="confirmation-actions">
			<button class="confirm-btn ${danger ? "danger" : ""}" id="confirm-yes">
				${danger ? "Delete" : "Confirm"}
			</button>
			<button class="confirm-btn cancel" id="confirm-cancel">Cancel</button>
		</div>
	`;

	document.body.prepend(banner);

	document.getElementById("confirm-yes").addEventListener("click", () => {
		onConfirm();
		dismissConfirmation();
	});
	document.getElementById("confirm-cancel").addEventListener("click", () => {
		dismissConfirmation();
	});
}

function dismissConfirmation() {
	const existing = document.getElementById("active-confirmation");
	if (existing) existing.remove();
}

// -- Quick Actions -------------------------------------------
// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function quickAction(action, featureId) {
	switch (action) {
		case "addAgent":
			send("addAgent", { featureId });
			break;
		case "addService":
			send("addService", { featureId });
			break;
		case "createPR":
			send("createPR", { featureId });
			break;
		case "openGitView":
			send("openGitView", { featureId });
			break;
		case "bootstrapFeature":
			send("bootstrapFeature", { featureId });
			break;
		case "refresh":
			send("refresh");
			break;
	}
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function toggleStoppedServicesHome(header) {
	header.classList.toggle("collapsed");
	const list = header.nextElementSibling;
	if (list) list.classList.toggle("collapsed");
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
/** @param {HTMLElement} header */
function toggleCardCollapse(header) {
	header.classList.toggle("collapsed");
	const body = header.nextElementSibling;
	if (body) body.classList.toggle("collapsed");
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function serviceAction(action, featureId, serviceId) {
	switch (action) {
		case "stop":
			send("stopService", { featureId, serviceId });
			break;
		case "restart":
			send("restartService", { featureId, serviceId });
			break;
	}
}

// -- Activity Expand/Collapse --------------------------------
const expandedAgents = new Set();
const expandedServices = new Set();
let autoRefreshInterval = null;

function togglePanel(prefix, id, expandedSet, requestCmd, requestPayload) {
	const panel = document.getElementById(`${prefix}-activity-${id}`);
	const chevron = document.getElementById(`${prefix}-chevron-${id}`);
	const header = document.getElementById(`${prefix}-header-${id}`);
	const toggle = document.getElementById(`${prefix}-toggle-${id}`);
	if (!panel || !chevron || !header) return;

	if (expandedSet.has(id)) {
		expandedSet.delete(id);
		panel.classList.remove("expanded");
		chevron.classList.remove("expanded");
		header.classList.remove("expanded");
		if (toggle) toggle.setAttribute("aria-expanded", "false");
	} else {
		expandedSet.add(id);
		panel.classList.add("expanded");
		chevron.classList.add("expanded");
		header.classList.add("expanded");
		if (toggle) toggle.setAttribute("aria-expanded", "true");
		send(requestCmd, requestPayload);
	}
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function toggleAgent(agentId) {
	togglePanel("agent", agentId, expandedAgents, "requestActivity", { agentId });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function toggleService(serviceId) {
	togglePanel(
		"service",
		serviceId,
		expandedServices,
		"requestServiceActivity",
		{ serviceId },
	);
}

// -- Message Handling from Extension -------------------------
function updateActivityContent(preId, emptyId, content) {
	const pre = document.getElementById(preId);
	const empty = document.getElementById(emptyId);
	if (pre) {
		pre.textContent = content || "";
		pre.style.display = content ? "block" : "none";
	}
	if (empty) {
		empty.style.display = content ? "none" : "block";
	}
	const container = pre?.closest(".activity-content");
	if (container) {
		const isNearBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight <
			60;
		if (isNearBottom) {
			container.scrollTop = container.scrollHeight;
		}
	}
}

function updateAttention(agent) {
	const card = agent.cardPresentation || {};
	const presented = card.primaryState || { label: "Unknown", tone: "muted" };
	const dot = document.getElementById(`agent-attention-dot-${agent.id}`);
	if (dot) {
		dot.className = `agent-status-dot primary-state-${presented.tone}`;
	}

	const lifecycleBadge = document.getElementById(
		`agent-lifecycle-badge-${agent.id}`,
	);
	if (lifecycleBadge) {
		lifecycleBadge.textContent = presented.label;
		lifecycleBadge.className = `agent-primary-state primary-state-${presented.tone}`;
		lifecycleBadge.title = presented.detail || "";
	}

	// Provider-derived name/session title are projections of the same card
	// presentation used at initial render — keep them live so a rename never
	// needs a full document reload to become visible (issue #120).
	if (card.name) {
		const nameEl = document.getElementById(`agent-name-${agent.id}`);
		if (nameEl) {
			nameEl.textContent = card.name;
			nameEl.title = card.name;
		}
	}

	const sessionTitleEl = document.getElementById(
		`agent-session-title-${agent.id}`,
	);
	if (sessionTitleEl) {
		if (card.secondaryTitle) {
			sessionTitleEl.textContent = `Session · ${card.secondaryTitle}`;
			sessionTitleEl.title = card.secondaryTitle;
			sessionTitleEl.style.display = "";
		} else {
			sessionTitleEl.style.display = "none";
		}
	}
}

window.addEventListener("message", (event) => {
	const message = event.data;
	switch (message.type) {
		case "activityUpdate":
			updateActivityContent(
				`activity-pre-${message.agentId}`,
				`activity-empty-${message.agentId}`,
				message.content,
			);
			break;
		case "serviceActivityUpdate":
			updateActivityContent(
				`service-activity-pre-${message.serviceId}`,
				`service-activity-empty-${message.serviceId}`,
				message.content,
			);
			break;
		case "agentAttentionUpdate":
			for (const agent of message.agents || []) updateAttention(agent);
			break;
		case "gitStatsUpdate": {
			const statsEl = document.getElementById("git-stats-content");
			if (statsEl) statsEl.innerHTML = message.html;
			break;
		}
		case "featureRuntimeUpdate": {
			// Patches only the specific runtime-derived Feature-page fields
			// (cockpit headline/primary action/runtime label/alerts, tmux
			// diagnostics) via stable ids — never a parent container's
			// innerHTML — so any <details> the user has expanded elsewhere
			// on the page (work/committed files, services activity panels)
			// and any focus/scroll position are left untouched. Issue #120
			// review: a prior version replaced whole subtrees, which silently
			// recreated nested <details> (resetting their open state) and
			// could wipe live service-activity content on an unrelated agent
			// attention tick. The Services section is never touched here —
			// stop/restart/add/remove already go through a full rebuild.
			const headlineEl = document.getElementById("feature-cockpit-headline");
			if (headlineEl && typeof message.headline === "string") {
				headlineEl.textContent = message.headline;
			}
			const detailEl = document.getElementById("feature-cockpit-detail");
			if (detailEl) {
				if (message.detail) {
					detailEl.textContent = message.detail;
					detailEl.style.display = "";
				} else {
					detailEl.style.display = "none";
				}
			}
			const runtimeLabelEl = document.getElementById(
				"feature-cockpit-runtime-label",
			);
			if (runtimeLabelEl && typeof message.runtimeLabel === "string") {
				runtimeLabelEl.textContent = message.runtimeLabel;
			}
			const primaryActionEl = document.getElementById(
				"feature-cockpit-primary-action",
			);
			if (primaryActionEl && typeof message.primaryActionHtml === "string") {
				primaryActionEl.innerHTML = message.primaryActionHtml;
			}
			const alertsEl = document.getElementById("feature-cockpit-alerts");
			if (alertsEl && typeof message.alertsHtml === "string") {
				alertsEl.innerHTML = message.alertsHtml;
			}
			const diagnosticsSummaryEl = document.getElementById(
				"feature-diagnostics-summary",
			);
			if (
				diagnosticsSummaryEl &&
				typeof message.diagnosticsSummary === "string"
			) {
				diagnosticsSummaryEl.textContent = `Diagnostics · ${message.diagnosticsSummary}`;
			}
			const diagnosticsContentEl = document.getElementById(
				"feature-diagnostics-content",
			);
			if (
				diagnosticsContentEl &&
				typeof message.diagnosticsContentHtml === "string"
			) {
				diagnosticsContentEl.innerHTML = message.diagnosticsContentHtml;
			}
			break;
		}
	}
});

// -- Debounced send for high-frequency polling commands ------
const _debouncedTimers = {};
function sendDebounced(command, data, delay) {
	if (_debouncedTimers[command]) {
		clearTimeout(_debouncedTimers[command]);
	}
	_debouncedTimers[command] = setTimeout(() => {
		delete _debouncedTimers[command];
		send(command, data);
	}, delay);
}

// -- Auto-refresh for expanded agents ------------------------
function startAutoRefresh() {
	if (autoRefreshInterval) return;
	autoRefreshInterval = setInterval(() => {
		if (expandedAgents.size > 0) {
			sendDebounced(
				"refreshActivity",
				{ agentIds: Array.from(expandedAgents) },
				200,
			);
		}
		if (expandedServices.size > 0) {
			sendDebounced(
				"refreshServiceActivity",
				{
					serviceIds: Array.from(expandedServices),
				},
				200,
			);
		}
	}, 10000);
}

startAutoRefresh();
window.addEventListener("beforeunload", () => {
	if (autoRefreshInterval) clearInterval(autoRefreshInterval);
});
