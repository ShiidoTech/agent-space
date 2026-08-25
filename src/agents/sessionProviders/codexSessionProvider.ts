import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ProviderAttentionSignal } from "../providers/types";
import {
	type IncrementalJsonlState,
	readFirstJsonlLine,
	readFirstJsonlLineAsync,
	readIncrementalJsonl,
	readIncrementalJsonlAsync,
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

	/**
	 * Async observation boundary for the non-blocking periodic passes.
	 *
	 * Mirrors the sync methods over `fs/promises` while sharing the same caches,
	 * so an async scan warms the path/name caches the sync readers use and vice
	 * versa. These methods never fall back to the sync filesystem calls.
	 */
	readonly async = {
		scanSessions: async (): Promise<SessionInfo[]> => {
			try {
				await fsp.access(this.sessionsDir);
			} catch {
				return [];
			}
			try {
				return await this.walkDirAsync(this.sessionsDir);
			} catch {
				// Ignore directory errors
				return [];
			}
		},
		hasSession: async (sessionId: string): Promise<boolean> =>
			(await this.findSessionFileAsync(sessionId)) !== null,
		readName: async (sessionId: string): Promise<string | null> => {
			await this.loadSessionIndexAsync();
			return (
				this.nameCache.get(sessionId) ??
				(await this.readTitleFromSessionAsync(sessionId))
			);
		},
		correlateOwnedSession: async (
			cwd: string,
			knownSessionIds: ReadonlySet<string>,
		): Promise<string | undefined> =>
			this.correlateOwnedSession(cwd, knownSessionIds),
	};

	private async walkDirAsync(dir: string): Promise<SessionInfo[]> {
		const results: SessionInfo[] = [];
		const entries = await fsp.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...(await this.walkDirAsync(fullPath)));
			} else if (entry.name.endsWith(".jsonl")) {
				const info = await this.parseSessionFileAsync(fullPath);
				if (info) results.push(info);
			}
		}
		return results;
	}

	private async parseSessionFileAsync(
		filePath: string,
	): Promise<SessionInfo | null> {
		try {
			const firstLine = await readFirstJsonlLineAsync(filePath);
			if (!firstLine) return null;

			const parsed = JSON.parse(firstLine);
			if (parsed.type !== "session_meta" || !parsed.payload) return null;

			const sessionId = parsed.payload.id || parsed.payload.session_id || "";
			if (!sessionId) return null;

			const created =
				parsed.payload.timestamp ||
				parsed.payload.created ||
				parsed.timestamp ||
				"";

			return {
				sessionId,
				prompt: parsed.payload.title || parsed.payload.first_user_message || "",
				created: typeof created === "string" ? created : "",
				projectPath: parsed.payload.cwd || "",
			};
		} catch {
			return null;
		}
	}

	async findSessionFileAsync(sessionId: string): Promise<string | null> {
		const cached = this.pathCache.get(sessionId);
		if (cached) {
			try {
				await fsp.access(cached);
				return cached;
			} catch {
				this.pathCache.delete(sessionId);
			}
		}

		try {
			await fsp.access(this.sessionsDir);
		} catch {
			return null;
		}

		try {
			return await this.searchDirAsync(this.sessionsDir, sessionId);
		} catch {
			return null;
		}
	}

	private async searchDirAsync(
		dir: string,
		sessionId: string,
	): Promise<string | null> {
		const entries = await fsp.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				const result = await this.searchDirAsync(fullPath, sessionId);
				if (result) return result;
			} else if (
				entry.name.endsWith(".jsonl") &&
				entry.name.includes(sessionId)
			) {
				this.pathCache.set(sessionId, fullPath);
				return fullPath;
			} else if (entry.name.endsWith(".jsonl")) {
				try {
					const firstLine = await readFirstJsonlLineAsync(fullPath);
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

	private async loadSessionIndexAsync(): Promise<void> {
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(this.sessionIndexPath);
		} catch {
			this.nameCache.clear();
			this.lastIndexMtimeMs = null;
			return;
		}

		if (this.lastIndexMtimeMs === stat.mtimeMs) return;

		try {
			const content = await fsp.readFile(this.sessionIndexPath, "utf-8");
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

	private async readTitleFromSessionAsync(
		sessionId: string,
	): Promise<string | null> {
		const filePath = await this.findSessionFileAsync(sessionId);
		if (!filePath) return null;
		return this.readTitleAsync(filePath);
	}

	private async readTitleAsync(filePath: string): Promise<string | null> {
		try {
			const firstLine = await readFirstJsonlLineAsync(filePath);
			if (!firstLine) return null;

			const parsed = JSON.parse(firstLine);
			if (parsed.type !== "session_meta" || !parsed.payload) return null;

			const metadataTitle =
				parsed.payload.title || parsed.payload.first_user_message || null;
			if (metadataTitle) return metadataTitle;

			const content = await fsp.readFile(filePath, "utf-8");
			for (const line of content.split("\n")) {
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
					if (
						event.type === "response_item" &&
						payload?.type === "message" &&
						payload.role === "user"
					) {
						const content = Array.isArray(payload.content)
							? (payload.content as unknown[])
									.map((part: unknown) =>
										part && typeof part === "object" && "text" in part
											? (part as { text?: unknown }).text
											: undefined,
									)
									.filter(
										(text: unknown): text is string => typeof text === "string",
									)
									.join("\n")
							: "";
						if (content.trim() && !content.includes("<environment_context>")) {
							return content.trim();
						}
					}
				} catch {
					// Ignore malformed trailing events.
				}
			}
			return null;
		} catch {
			return null;
		}
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

	discoverSessionCandidates(
		cwd: string,
		knownSessionIds: ReadonlySet<string>,
	): SessionInfo[] {
		const normalizedCwd = path.resolve(cwd);
		return this.scanSessions()
			.filter(
				(session) =>
					path.resolve(session.projectPath) === normalizedCwd &&
					!knownSessionIds.has(session.sessionId),
			)
			.sort((left, right) => right.created.localeCompare(left.created));
	}

	/**
	 * Codex writes a session_meta record containing its exact cwd and start time.
	 * A single new candidate is safe to attribute; multiple candidates remain
	 * ambiguous because Codex has no launch token that Agent Space can pass in.
	 */
	correlateOwnedSession(
		cwd: string,
		knownSessionIds: ReadonlySet<string>,
	): string | undefined {
		const candidates = this.discoverSessionCandidates(cwd, knownSessionIds);
		return candidates.length === 1 ? candidates[0]?.sessionId : undefined;
	}

	/** True when a rollout file for `sessionId` exists in this Codex home. */
	hasSession(sessionId: string): boolean {
		return this.findSessionFile(sessionId) !== null;
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
		try {
			const firstLine = readFirstJsonlLine(filePath);
			if (!firstLine) return null;

			const parsed = JSON.parse(firstLine);
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
					if (
						event.type === "response_item" &&
						payload?.type === "message" &&
						payload.role === "user"
					) {
						const content = Array.isArray(payload.content)
							? (payload.content as unknown[])
									.map((part: unknown) =>
										part && typeof part === "object" && "text" in part
											? (part as { text?: unknown }).text
											: undefined,
									)
									.filter(
										(text: unknown): text is string => typeof text === "string",
									)
									.join("\n")
							: "";
						if (content.trim() && !content.includes("<environment_context>")) {
							return content.trim();
						}
					}
				} catch {
					// Ignore malformed trailing events.
				}
			}
			return null;
		} catch {
			return null;
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
			(line, previous) => this.parseAttentionLine(line, previous),
		);
		if (!state) return undefined;
		this.attentionCache.set(sessionId, state);
		return state.value;
	}

	/**
	 * Non-blocking twin of {@link readAttention}: identical parsing and cache
	 * semantics, but session discovery and file reads go through the async
	 * helpers so background observers never block the Extension Host.
	 */
	async readAttentionAsync(
		sessionId: string,
	): Promise<ProviderAttentionSignal | undefined> {
		const filePath = await this.findSessionFileAsync(sessionId);
		if (!filePath) return undefined;

		const state = await readIncrementalJsonlAsync(
			filePath,
			this.attentionCache.get(sessionId),
			(line, previous) => this.parseAttentionLine(line, previous),
		);
		if (!state) return undefined;
		this.attentionCache.set(sessionId, state);
		return state.value;
	}

	private parseAttentionLine(
		line: string,
		previous: ProviderAttentionSignal | undefined,
	): ProviderAttentionSignal | undefined {
		const event = JSON.parse(line) as Record<string, unknown>;
		let signal = previous;

		const payload = event.payload as Record<string, unknown> | undefined;
		const type = event.type;
		const eventType = typeof payload?.type === "string" ? payload.type : "";
		const observedAt =
			typeof event.timestamp === "string" ? event.timestamp : undefined;
		if (type === "user_message") {
			signal = {
				status: "working",
				evidence: "codex.user_message",
				observedAt,
			};
		} else if (type === "event_msg" && eventType === "task_started") {
			signal = {
				status: "working",
				evidence: "codex.task_started",
				observedAt,
			};
		} else if (
			type === "event_msg" &&
			(eventType === "request_user_input" ||
				eventType.includes("approval_request"))
		) {
			signal = {
				status: "waiting_for_user",
				evidence: `codex.${String(eventType)}`,
				observedAt,
			};
		} else if (type === "event_msg" && eventType === "task_complete") {
			signal = {
				status: "idle",
				evidence: "codex.task_complete",
				observedAt,
			};
		} else if (type === "event_msg" && eventType === "turn_aborted") {
			signal = {
				status: "idle",
				evidence: "codex.turn_aborted",
				observedAt,
			};
		} else if (
			type === "event_msg" &&
			(eventType === "error" || eventType === "item_failed")
		) {
			signal = {
				status: "failed",
				evidence: `codex.${String(eventType)}`,
				observedAt,
			};
		} else if (
			type === "response_item" &&
			(eventType === "function_call" || eventType === "custom_tool_call")
		) {
			signal = {
				status: "working",
				evidence: `codex.${String(eventType)}`,
				observedAt,
			};
		}
		return signal;
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
		try {
			// `session_meta` embeds the full base instructions and is far larger
			// than a fixed 4 KB buffer; read the whole first record.
			const firstLine = readFirstJsonlLine(filePath);
			if (!firstLine) return null;

			const parsed = JSON.parse(firstLine);
			if (parsed.type !== "session_meta" || !parsed.payload) return null;

			const sessionId = parsed.payload.id || parsed.payload.session_id || "";
			if (!sessionId) return null;

			// `session_meta` records the session start under `timestamp`; there is
			// no `created` field. Reading the wrong key left every session with an
			// empty date, which made candidate ordering dependent on directory walk.
			const created =
				parsed.payload.timestamp ||
				parsed.payload.created ||
				parsed.timestamp ||
				"";

			return {
				sessionId,
				prompt: parsed.payload.title || parsed.payload.first_user_message || "",
				created: typeof created === "string" ? created : "",
				projectPath: parsed.payload.cwd || "",
			};
		} catch {
			return null;
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
