import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome } from "../../projects/projectConfig";
import type { Agent, AgentAttentionStatus, CodingTool } from "../../types";
import { isClaudeFamily } from "../codingToolRegistry";
import type { CodingToolRegistry } from "../codingToolRegistry";
import { ClaudeSessionProvider } from "../sessionProviders/claudeSessionProvider";
import { CodexSessionProvider } from "../sessionProviders/codexSessionProvider";
import type { TmuxIntegration } from "../tmux";

const MAX_TAIL_BYTES = 128 * 1024;

export interface AgentAttentionSnapshot {
	status: AgentAttentionStatus;
	reason: string;
	source: "lifecycle" | "tmux" | "claude" | "codex" | "fallback";
}

interface ProviderSignal {
	status: "working" | "waiting_for_user" | "failed";
	reason: string;
}

export interface AgentAttentionResolverOptions {
	codexProvider?: CodexSessionProvider;
	claudeProviderFactory?: (tool: CodingTool) => ClaudeSessionProvider;
}

/**
 * Resolve the human-attention state of an agent from current evidence.
 *
 * Important: this is deliberately conservative. A live CLI process does not
 * prove that the model is working, and a quiet terminal does not prove that it
 * is waiting for the user. Precise states are emitted only from lifecycle
 * facts or structured provider events. Everything else degrades to idle or
 * unknown instead of guessing.
 */
export class AgentAttentionResolver {
	private readonly codexProvider: CodexSessionProvider;
	private readonly claudeProviders = new Map<string, ClaudeSessionProvider>();

	constructor(
		private readonly tmux: TmuxIntegration,
		private readonly toolRegistry: CodingToolRegistry,
		private readonly options: AgentAttentionResolverOptions = {},
	) {
		this.codexProvider = options.codexProvider ?? new CodexSessionProvider();
	}

	resolve(agent: Agent): AgentAttentionSnapshot {
		if (agent.status === "done") {
			return {
				status: "done",
				reason: "Agent was explicitly marked done",
				source: "lifecycle",
			};
		}
		if (agent.status === "errored" || agent.lastError) {
			return {
				status: "failed",
				reason: "Agent lifecycle recorded a failure",
				source: "lifecycle",
			};
		}
		if (agent.hasStarted !== true) {
			return {
				status: "unknown",
				reason: "Agent has not started yet",
				source: "lifecycle",
			};
		}

		const sessionName =
			agent.tmuxSession ?? this.tmux.sessionName(agent.featureId, agent.id);
		const alive = this.tmux.isSessionAlive(sessionName);
		if (!alive) {
			return {
				status: "unknown",
				reason: "No live tmux session is available",
				source: "tmux",
			};
		}

		const pane = this.tmux.getPaneStatus(sessionName);
		if (pane?.dead) {
			if (pane.exitCode !== 0) {
				return {
					status: "failed",
					reason: `tmux pane exited with code ${pane.exitCode}`,
					source: "tmux",
				};
			}
			return {
				status: "idle",
				reason: "tmux pane exited cleanly",
				source: "tmux",
			};
		}

		const tool = this.toolRegistry.resolveAgentTool(agent.toolId);
		const providerSignal = this.readProviderSignal(tool, agent.sessionId);
		if (providerSignal) {
			return {
				...providerSignal,
				source: isClaudeFamily(tool) ? "claude" : "codex",
			};
		}

		return {
			status: "idle",
			reason: "Session is alive but no structured activity signal is available",
			source: "fallback",
		};
	}

	private readProviderSignal(
		tool: CodingTool,
		sessionId: string | null,
	): ProviderSignal | null {
		if (!sessionId) return null;
		if (isClaudeFamily(tool)) {
			return this.readClaudeSignal(tool, sessionId);
		}
		if (tool.family === "codex" || tool.id === "codex") {
			return this.readCodexSignal(sessionId);
		}
		return null;
	}

	private readClaudeSignal(
		tool: CodingTool,
		sessionId: string,
	): ProviderSignal | null {
		const provider = this.getClaudeProvider(tool);
		const filePath = provider.findSessionFile(sessionId);
		if (!filePath) return null;

		for (const event of readTailJsonObjects(filePath)) {
			if (!eventMatchesSession(event, sessionId)) continue;

			if (event.type === "assistant") {
				const message = asRecord(event.message);
				const content = Array.isArray(message?.content) ? message.content : [];
				if (containsAskUserQuestion(content)) {
					return {
						status: "waiting_for_user",
						reason: "Claude emitted a structured AskUserQuestion tool call",
					};
				}

				const stopReason = message?.stop_reason;
				if (stopReason === "end_turn") {
					return {
						status: "waiting_for_user",
						reason: "Claude completed its turn",
					};
				}
				if (stopReason === "tool_use") {
					return {
						status: "working",
						reason: "Claude turn is continuing through tool use",
					};
				}
				// Assistant output without a terminal stop reason is evidence that
				// the turn is in progress, but never evidence of user attention.
				if (message) {
					return {
						status: "working",
						reason: "Claude emitted assistant activity without completing the turn",
					};
				}
			}

			if (event.type === "user" && event.isMeta !== true) {
				return {
					status: "working",
					reason: "Claude received user/tool-result input for the current turn",
				};
			}
		}
		return null;
	}

	private readCodexSignal(sessionId: string): ProviderSignal | null {
		const filePath = this.codexProvider.findSessionFile(sessionId);
		if (!filePath) return null;

		for (const event of readTailJsonObjects(filePath)) {
			const type = event.type;
			if (type === "event_msg") {
				const payload = asRecord(event.payload);
				const eventType = typeof payload?.type === "string" ? payload.type : "";
				if (!eventType) continue;

				if (
					eventType === "request_user_input" ||
					eventType.includes("approval_request")
				) {
					return {
						status: "waiting_for_user",
						reason: `Codex emitted ${eventType}`,
					};
				}
				if (eventType === "task_complete" || eventType === "turn_complete") {
					return {
						status: "waiting_for_user",
						reason: "Codex completed its current turn",
					};
				}
				if (eventType === "error" || eventType === "turn_failed") {
					return {
						status: "failed",
						reason: "Codex emitted a terminal error event",
					};
				}
				if (
					eventType === "task_started" ||
					eventType === "turn_started" ||
					eventType === "user_message" ||
					eventType === "agent_message"
				) {
					return {
						status: "working",
						reason: `Codex emitted ${eventType}`,
					};
				}
			}

			if (type === "response_item" || type === "turn_context") {
				return {
					status: "working",
					reason: `Codex emitted ${String(type)} activity before turn completion`,
				};
			}
		}
		return null;
	}

	private getClaudeProvider(tool: CodingTool): ClaudeSessionProvider {
		if (this.options.claudeProviderFactory) {
			return this.options.claudeProviderFactory(tool);
		}

		const root = tool.sessionsDir ? expandHome(tool.sessionsDir) : "<default>";
		const key = `${tool.id}:${root}`;
		const existing = this.claudeProviders.get(key);
		if (existing) return existing;

		const provider = tool.sessionsDir
			? new ClaudeSessionProvider(
					path.join(expandHome(tool.sessionsDir), "projects"),
					tool.id,
				)
			: new ClaudeSessionProvider(undefined, tool.id);
		this.claudeProviders.set(key, provider);
		return provider;
	}
}

function readTailJsonObjects(filePath: string): Record<string, unknown>[] {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const stat = fs.fstatSync(fd);
		if (stat.size <= 0) return [];
		const bytes = Math.min(stat.size, MAX_TAIL_BYTES);
		const offset = stat.size - bytes;
		const buffer = Buffer.alloc(bytes);
		fs.readSync(fd, buffer, 0, bytes, offset);
		let text = buffer.toString("utf-8");
		if (offset > 0) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
		}
		const events: Record<string, unknown>[] = [];
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					events.push(parsed as Record<string, unknown>);
				}
			} catch {
				// Ignore malformed/partial rows. The resolver must never break UI.
			}
		}
		return events;
	} catch {
		return [];
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function eventMatchesSession(
	event: Record<string, unknown>,
	sessionId: string,
): boolean {
	const explicitSessionId = event.sessionId ?? event.session_id;
	return (
		typeof explicitSessionId !== "string" ||
		explicitSessionId.length === 0 ||
		explicitSessionId === sessionId
	);
}

function containsAskUserQuestion(content: unknown[]): boolean {
	return content.some((item) => {
		const block = asRecord(item);
		return block?.type === "tool_use" && block.name === "AskUserQuestion";
	});
}
