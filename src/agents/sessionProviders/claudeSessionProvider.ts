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

const DEFAULT_PROJECTS_DIR = path.join(
	process.env.HOME || "~",
	".claude",
	"projects",
);

const CHUNK_SIZE = 4096;

export class ClaudeSessionProvider
	implements SessionProvider, SessionRenameAdapter, SessionTitleProvider
{
	readonly toolId: string;
	private readonly projectsDir: string;
	private readonly pathCache = new Map<string, string>();
	private readonly contentPathIndex = new Map<string, string>();
	private contentPathIndexBuiltAt = 0;
	private readonly indexCache = new Map<
		string,
		{ mtimeMs: number; titles: Map<string, string> }
	>();
	private readonly attentionCache = new Map<
		string,
		IncrementalJsonlState<ProviderAttentionSignal>
	>();

	constructor(projectsDir?: string, toolId = "claude") {
		this.toolId = toolId;
		this.projectsDir = normalizeProjectsDir(
			projectsDir ?? DEFAULT_PROJECTS_DIR,
		);
	}

	scanSessions(): SessionInfo[] {
		const results: SessionInfo[] = [];
		if (!fs.existsSync(this.projectsDir)) return results;

		try {
			const projectDirs = fs.readdirSync(this.projectsDir);
			for (const dir of projectDirs) {
				const indexPath = path.join(
					this.projectsDir,
					dir,
					"sessions-index.json",
				);
				if (!fs.existsSync(indexPath)) continue;

				try {
					const raw = fs.readFileSync(indexPath, "utf-8");
					const parsed = JSON.parse(raw);

					// Handle both { version, entries } wrapper and plain array formats
					const entries = Array.isArray(parsed)
						? parsed
						: Array.isArray(parsed?.entries)
							? parsed.entries
							: null;
					if (!entries) continue;

					// Fallback project path: originalPath from wrapper, then decode dir name
					const fallbackPath = parsed?.originalPath || decodeProjectPath(dir);

					for (const s of entries) {
						const sessionId = s.sessionId || s.session_id || "";
						const prompt = s.summary || s.firstPrompt || s.first_prompt || "";
						const created = s.created || s.createdAt || "";
						const projectPath = s.projectPath || fallbackPath;
						if (sessionId) {
							results.push({ sessionId, prompt, created, projectPath });
						}
					}
				} catch {
					// Skip unparseable files
				}
			}
		} catch {
			// Ignore directory errors
		}

		return results;
	}

	findSessionFile(sessionId: string): string | null {
		const cached = this.pathCache.get(sessionId);
		if (cached) {
			if (fs.existsSync(cached)) return cached;
			this.pathCache.delete(sessionId);
		}

		if (!fs.existsSync(this.projectsDir)) return null;

		try {
			const dirs = fs.readdirSync(this.projectsDir);
			for (const dir of dirs) {
				const indexPath = path.join(
					this.projectsDir,
					dir,
					"sessions-index.json",
				);
				const indexedPath = this.findIndexedSessionFile(indexPath, sessionId);
				if (indexedPath) {
					this.pathCache.set(sessionId, indexedPath);
					return indexedPath;
				}
				const candidate = path.join(
					this.projectsDir,
					dir,
					`${sessionId}.jsonl`,
				);
				if (fs.existsSync(candidate)) {
					this.pathCache.set(sessionId, candidate);
					return candidate;
				}
			}
			this.ensureContentPathIndex();
			const found = this.contentPathIndex.get(sessionId);
			if (found) {
				this.pathCache.set(sessionId, found);
				return found;
			}
			if (Date.now() - this.contentPathIndexBuiltAt > 1000) {
				this.buildContentPathIndex();
				const refreshed = this.contentPathIndex.get(sessionId);
				if (refreshed) {
					this.pathCache.set(sessionId, refreshed);
					return refreshed;
				}
			}
		} catch {
			// Ignore directory read errors
		}

		return null;
	}

	private ensureContentPathIndex(): void {
		if (this.contentPathIndexBuiltAt > 0) return;
		this.buildContentPathIndex();
	}

	private buildContentPathIndex(): void {
		this.contentPathIndex.clear();
		this.contentPathIndexBuiltAt = Date.now();
		this.indexSessionFiles(this.projectsDir);
	}

	private indexSessionFiles(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const candidate = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				this.indexSessionFiles(candidate);
				continue;
			}
			if (!entry.name.endsWith(".jsonl")) continue;
			try {
				const firstLine = readFirstJsonlLine(candidate);
				if (!firstLine) continue;
				const parsed = JSON.parse(firstLine) as Record<string, unknown>;
				if (typeof parsed.sessionId === "string") {
					this.contentPathIndex.set(parsed.sessionId, candidate);
				}
			} catch {
				// Ignore files that are not readable session JSONL.
			}
		}
	}

	private findIndexedSessionFile(
		indexPath: string,
		sessionId: string,
	): string | null {
		if (!fs.existsSync(indexPath)) return null;
		try {
			const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
			const entries = Array.isArray(parsed)
				? parsed
				: Array.isArray(parsed?.entries)
					? parsed.entries
					: [];
			const entry = entries.find(
				(candidate: Record<string, unknown>) =>
					candidate.sessionId === sessionId &&
					typeof candidate.fullPath === "string",
			);
			return entry && fs.existsSync(entry.fullPath as string)
				? (entry.fullPath as string)
				: null;
		} catch {
			return null;
		}
	}

	readName(sessionId: string): string | null {
		const filePath = this.findSessionFile(sessionId);
		if (!filePath) return this.readIndexedName(sessionId);
		return (
			this.readTitle(filePath) ??
			this.readIndexFallback(path.dirname(filePath), sessionId) ??
			this.readIndexedName(sessionId)
		);
	}

	private readIndexedName(sessionId: string): string | null {
		if (!fs.existsSync(this.projectsDir)) return null;
		try {
			for (const dir of fs.readdirSync(this.projectsDir)) {
				const indexPath = path.join(
					this.projectsDir,
					dir,
					"sessions-index.json",
				);
				if (!fs.existsSync(indexPath)) continue;
				const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
				const entries = Array.isArray(parsed)
					? parsed
					: Array.isArray(parsed?.entries)
						? parsed.entries
						: [];
				const entry = entries.find(
					(candidate: Record<string, unknown>) =>
						candidate.sessionId === sessionId,
				);
				const title =
					entry?.summary ?? entry?.firstPrompt ?? entry?.first_prompt;
				if (typeof title === "string" && title.trim()) return title.trim();
			}
		} catch {
			return null;
		}
		return null;
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
				const explicitSessionId = event.sessionId ?? event.session_id;
				if (
					typeof explicitSessionId === "string" &&
					explicitSessionId !== sessionId
				) {
					return signal;
				}

				if (event.type === "user") {
					signal = { status: "working", evidence: "claude.user" };
					return signal;
				}
				if (event.type === "result") {
					signal = {
						status: event.is_error === true ? "failed" : "idle",
						evidence:
							event.is_error === true ? "claude.result.error" : "claude.result",
					};
					return signal;
				}
				if (event.type === "assistant") {
					const message = event.message as Record<string, unknown> | undefined;
					const stopReason = message?.stop_reason ?? event.stop_reason;
					const content = Array.isArray(message?.content)
						? message.content
						: [];
					const asksUser = content.some((item) => {
						const block = item as Record<string, unknown>;
						return (
							block.type === "tool_use" && block.name === "AskUserQuestion"
						);
					});
					if (asksUser) {
						signal = {
							status: "waiting_for_user",
							evidence: "claude.assistant.ask_user_question",
						};
					} else if (stopReason === "tool_use") {
						signal = {
							status: "working",
							evidence: "claude.assistant.tool_use",
						};
					} else if (stopReason === "end_turn") {
						signal = {
							status: "idle",
							evidence: "claude.assistant.end_turn",
						};
					}
					return signal;
				}
				// A newer unrecognized event invalidates the previous precise signal.
				return undefined;
			},
		);
		if (!state) return undefined;
		this.attentionCache.set(sessionId, state);
		return state.value;
	}

	readTitle(filePath: string): string | null {
		let fd: number | undefined;
		let aiTitle: string | null = null;
		try {
			fd = fs.openSync(filePath, "r");
			const stat = fs.fstatSync(fd);
			const fileSize = stat.size;
			if (fileSize === 0) return null;

			let offset = fileSize;
			let remainder = "";

			while (offset > 0) {
				const readSize = Math.min(CHUNK_SIZE, offset);
				offset -= readSize;

				const buffer = Buffer.alloc(readSize);
				fs.readSync(fd, buffer, 0, readSize, offset);

				const chunk = buffer.toString("utf-8") + remainder;
				const lines = chunk.split("\n");

				// The first element may be a partial line if we're not at the start
				remainder = offset > 0 ? (lines.shift() ?? "") : "";

				// Process lines from end to start
				for (let i = lines.length - 1; i >= 0; i--) {
					const trimmed = lines[i].trim();
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed);
						const title = titleFromEvent(parsed);
						if (title?.kind === "custom" && title.value) return title.value;
						if (title?.kind === "ai" && title.value && !aiTitle) {
							aiTitle = title.value;
						}
					} catch {
						// Skip non-JSON lines
					}
				}
			}

			// Process any remaining partial line
			if (remainder.trim()) {
				try {
					const parsed = JSON.parse(remainder.trim());
					const title = titleFromEvent(parsed);
					if (title?.kind === "custom" && title.value) return title.value;
					if (title?.kind === "ai" && title.value && !aiTitle) {
						aiTitle = title.value;
					}
				} catch {
					// Skip
				}
			}

			return aiTitle;
		} catch {
			return null;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	clearCache(sessionId: string): void {
		this.pathCache.delete(sessionId);
		this.contentPathIndex.delete(sessionId);
		this.attentionCache.delete(sessionId);
	}

	dispose(): void {
		this.pathCache.clear();
		this.contentPathIndex.clear();
		this.contentPathIndexBuiltAt = 0;
		this.indexCache.clear();
		this.attentionCache.clear();
	}

	private readIndexFallback(
		projectDir: string,
		sessionId: string,
	): string | null {
		const indexPath = path.join(projectDir, "sessions-index.json");
		if (!fs.existsSync(indexPath)) return null;

		try {
			const stat = fs.statSync(indexPath);
			let cached = this.indexCache.get(projectDir);
			if (!cached || cached.mtimeMs !== stat.mtimeMs) {
				const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
				const entries = Array.isArray(parsed)
					? parsed
					: Array.isArray(parsed?.entries)
						? parsed.entries
						: [];
				const titles = new Map<string, string>();
				for (const entry of entries) {
					if (typeof entry?.sessionId !== "string") continue;
					const title =
						typeof entry.summary === "string" && entry.summary.trim()
							? entry.summary.trim()
							: typeof entry.firstPrompt === "string"
								? entry.firstPrompt.trim()
								: "";
					if (title) titles.set(entry.sessionId, title);
				}
				cached = { mtimeMs: stat.mtimeMs, titles };
				this.indexCache.set(projectDir, cached);
			}
			return cached.titles.get(sessionId) ?? null;
		} catch {
			return null;
		}
	}
}

export function readClaudeAttentionSignal(
	sessionId: string,
): ProviderAttentionSignal | undefined {
	return new ClaudeSessionProvider().readAttention(sessionId);
}

function normalizeProjectsDir(projectsDir: string): string {
	const normalized = path.normalize(projectsDir);
	// Callers historically appended `/projects` to `sessionsDir`. Accept the
	// equally natural setting where sessionsDir already points at that folder,
	// preventing `.../projects/projects` from silently disabling discovery.
	if (
		path.basename(normalized) === "projects" &&
		path.basename(path.dirname(normalized)) === "projects"
	) {
		return path.dirname(normalized);
	}
	return normalized;
}

function titleFromEvent(
	parsed: Record<string, unknown>,
): { kind: "custom" | "ai"; value: string } | null {
	if (
		parsed.type === "custom-title" &&
		typeof parsed.customTitle === "string"
	) {
		return { kind: "custom", value: parsed.customTitle.trim() };
	}
	if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
		return { kind: "ai", value: parsed.aiTitle.trim() };
	}
	return null;
}

function decodeProjectPath(encoded: string): string {
	// Defensive fallback only — prefer projectPath from session entries.
	// Claude's encoding replaces "/" with "-", but legitimate hyphens in
	// directory names are also preserved as "-", making lossless decoding
	return encoded.replace(/^-/, "/").replace(/-/g, "/");
}
