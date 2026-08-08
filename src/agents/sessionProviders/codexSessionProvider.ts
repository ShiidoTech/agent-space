import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderAttentionSignal } from "../providers/types";
import {
	type IncrementalJsonlState,
	readFirstJsonlLine,
	readIncrementalJsonl,
} from "./incrementalJsonl";
import type {
	SessionInfo,
	SessionProvider,
	SessionRenameAdapter,
	SessionTitleProvider,
} from "./types";

const DEFAULT_CODEX_SESSIONS_DIR = path.join(
	process.env.HOME || "~",
	".codex",
	"sessions",
);
const DEFAULT_CODEX_SESSION_INDEX_PATH = path.join(
	process.env.HOME || "~",
	".codex",
	"session_index.jsonl",
);

const CHUNK_SIZE = 4096;
const claimedCodexSessionIds = new Set<string>();

export class CodexSessionProvider
	implements SessionProvider, SessionRenameAdapter, SessionTitleProvider
{
	readonly toolId = "codex";
	private readonly sessionsDir: string;
	private readonly sessionIndexPath: string;
	private readonly pathCache = new Map<string, string>();
	private readonly nameCache = new Map<string, string>();
	private lastIndexMtimeMs: number | null = null;
	private readonly attentionCache = new Map<
		string,
		IncrementalJsonlState<ProviderAttentionSignal>
	>();

	constructor(sessionsDir?: string, sessionIndexPath?: string) {
		this.sessionsDir = sessionsDir ?? DEFAULT_CODEX_SESSIONS_DIR;
		this.sessionIndexPath =
			sessionIndexPath ?? DEFAULT_CODEX_SESSION_INDEX_PATH;
	}

	scanSessions(): SessionInfo[] {
		const results: SessionInfo[] = [];
		if (!fs.existsSync(this.sessionsDir)) return results;

		try {
			this.walkDir(this.sessionsDir, results);
		} catch {
			// Ignore directory errors
		}

		return results;
	}

	discoverSessionId(
		cwd: string,
		knownSessionIds: ReadonlySet<string>,
	): string | undefined {
		const normalizedCwd = path.resolve(cwd);
		const candidate = this.scanSessions()
			.filter(
				(session) =>
					path.resolve(session.projectPath) === normalizedCwd &&
					!knownSessionIds.has(session.sessionId) &&
					!claimedCodexSessionIds.has(session.sessionId),
			)
			.sort((left, right) => right.created.localeCompare(left.created))[0];
		if (!candidate) return undefined;
		claimedCodexSessionIds.add(candidate.sessionId);
		return candidate.sessionId;
	}

	findSessionFile(sessionId: string): string | null {
		const cached = this.pathCache.get(sessionId);
		if (cached) {
			if (fs.existsSync(cached)) return cached;
			this.pathCache.delete(sessionId);
		}

		if (!fs.existsSync(this.sessionsDir)) return null;

		try {
			return this.searchDir(this.sessionsDir, sessionId);
		} catch {
			return null;
		}
	}

	readTitle(filePath: string): string | null {
		let fd: number | undefined;
		try {
			fd = fs.openSync(filePath, "r");
			const buffer = Buffer.alloc(CHUNK_SIZE);
			const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, 0);
			if (bytesRead === 0) return null;

			const content = buffer.toString("utf-8", 0, bytesRead);
			const firstNewline = content.indexOf("\n");
			const firstLine =
				firstNewline >= 0 ? content.slice(0, firstNewline) : content;

			const parsed = JSON.parse(firstLine.trim());
			if (parsed.type !== "session_meta" || !parsed.payload) return null;

			const metadataTitle =
				parsed.payload.title || parsed.payload.first_user_message || null;
			if (metadataTitle) return metadataTitle;

			for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					const payload = event.payload;
					if (
						event.type === "event_msg" &&
						payload?.type === "thread_name_updated" &&
						typeof payload.thread_name === "string"
					) {
						return payload.thread_name;
					}
					if (
						(event.type === "event_msg" && payload?.type === "user_message") ||
						event.type === "user_message"
					) {
						const message =
							typeof event.message === "string"
								? event.message
								: typeof payload?.message === "string"
									? payload.message
									: typeof event.text === "string"
										? event.text
										: null;
						if (message?.trim()) return message.trim();
					}
				} catch {
					// Ignore malformed trailing events.
				}
			}
			return null;
		} catch {
			return null;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	readName(sessionId: string): string | null {
		this.loadSessionIndex();
		return (
			this.nameCache.get(sessionId) ?? this.readTitleFromSession(sessionId)
		);
	}

	private readTitleFromSession(sessionId: string): string | null {
		const filePath = this.findSessionFile(sessionId);
		if (!filePath) return null;
		return this.readTitle(filePath);
	}

	readAttention(sessionId: string): ProviderAttentionSignal | undefined {
		const filePath = this.findSessionFile(sessionId);
		if (!filePath) return undefined;

		const state = readIncrementalJsonl(
			filePath,
			this.attentionCache.get(sessionId),
			(line, previous) => {
				const event = JSON.parse(line) as Record<string, unknown>;
				let signal = previous;

				const payload = event.payload as Record<string, unknown> | undefined;
				const type = event.type;
				const eventType = typeof payload?.type === "string" ? payload.type : "";
				if (type === "user_message") {
					signal = {
						status: "working",
						evidence: "codex.user_message",
					};
				} else if (type === "event_msg" && eventType === "task_started") {
					signal = {
						status: "working",
						evidence: "codex.task_started",
					};
				} else if (
					type === "event_msg" &&
					(eventType === "request_user_input" ||
						eventType.includes("approval_request"))
				) {
					signal = {
						status: "waiting_for_user",
						evidence: `codex.${String(eventType)}`,
					};
				} else if (type === "event_msg" && eventType === "task_complete") {
					signal = {
						status: "idle",
						evidence: "codex.task_complete",
					};
				} else if (type === "event_msg" && eventType === "turn_aborted") {
					signal = {
						status: "idle",
						evidence: "codex.turn_aborted",
					};
				} else if (
					type === "event_msg" &&
					(eventType === "error" || eventType === "item_failed")
				) {
					signal = {
						status: "failed",
						evidence: `codex.${String(eventType)}`,
					};
				} else if (
					type === "response_item" &&
					(eventType === "function_call" || eventType === "custom_tool_call")
				) {
					signal = {
						status: "working",
						evidence: `codex.${String(eventType)}`,
					};
				}
				return signal;
			},
		);
		if (!state) return undefined;
		this.attentionCache.set(sessionId, state);
		return state.value;
	}

	clearCache(sessionId: string): void {
		this.pathCache.delete(sessionId);
		this.nameCache.delete(sessionId);
		this.lastIndexMtimeMs = null;
		this.attentionCache.delete(sessionId);
	}

	dispose(): void {
		this.pathCache.clear();
		this.nameCache.clear();
		this.lastIndexMtimeMs = null;
		this.attentionCache.clear();
	}

	private walkDir(dir: string, results: SessionInfo[]): void {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				this.walkDir(fullPath, results);
			} else if (entry.name.endsWith(".jsonl")) {
				const info = this.parseSessionFile(fullPath);
				if (info) results.push(info);
			}
		}
	}

	private parseSessionFile(filePath: string): SessionInfo | null {
		let fd: number | undefined;
		try {
			fd = fs.openSync(filePath, "r");
			const buffer = Buffer.alloc(CHUNK_SIZE);
			const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, 0);
			if (bytesRead === 0) return null;

			const content = buffer.toString("utf-8", 0, bytesRead);
			const firstNewline = content.indexOf("\n");
			const firstLine =
				firstNewline >= 0 ? content.slice(0, firstNewline) : content;

			const parsed = JSON.parse(firstLine.trim());
			if (parsed.type !== "session_meta" || !parsed.payload) return null;

			const sessionId = parsed.payload.id || "";
			if (!sessionId) return null;

			return {
				sessionId,
				prompt: parsed.payload.title || parsed.payload.first_user_message || "",
				created: parsed.payload.created || "",
				projectPath: parsed.payload.cwd || "",
			};
		} catch {
			return null;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	private searchDir(dir: string, sessionId: string): string | null {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				const result = this.searchDir(fullPath, sessionId);
				if (result) return result;
			} else if (
				entry.name.endsWith(".jsonl") &&
				entry.name.includes(sessionId)
			) {
				this.pathCache.set(sessionId, fullPath);
				return fullPath;
			} else if (entry.name.endsWith(".jsonl")) {
				try {
					const firstLine = readFirstJsonlLine(fullPath);
					if (!firstLine) continue;
					const parsed = JSON.parse(firstLine) as Record<string, unknown>;
					const payload = parsed.payload as Record<string, unknown> | undefined;
					if (payload?.id === sessionId) {
						this.pathCache.set(sessionId, fullPath);
						return fullPath;
					}
				} catch {
					// Ignore files that are not readable session JSONL.
				}
			}
		}
		return null;
	}

	private loadSessionIndex(): void {
		if (!fs.existsSync(this.sessionIndexPath)) {
			this.nameCache.clear();
			this.lastIndexMtimeMs = null;
			return;
		}

		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.sessionIndexPath);
		} catch {
			return;
		}

		if (this.lastIndexMtimeMs === stat.mtimeMs) return;

		try {
			const content = fs.readFileSync(this.sessionIndexPath, "utf-8");
			const nextCache = new Map<string, string>();

			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed);
					const sessionId =
						typeof parsed.id === "string" ? parsed.id.trim() : "";
					const threadName =
						typeof parsed.thread_name === "string"
							? parsed.thread_name.trim()
							: "";
					if (!sessionId || !threadName) continue;
					nextCache.set(sessionId, threadName);
				} catch {
					// Ignore malformed JSONL rows
				}
			}

			this.nameCache.clear();
			for (const [sessionId, threadName] of nextCache) {
				this.nameCache.set(sessionId, threadName);
			}
			this.lastIndexMtimeMs = stat.mtimeMs;
		} catch {
			// Ignore read errors and keep the previous cache
		}
	}
}

export function readCodexAttentionSignal(
	sessionId: string,
): ProviderAttentionSignal | undefined {
	return new CodexSessionProvider().readAttention(sessionId);
}
