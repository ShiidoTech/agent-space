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

/**
 * The single answer to "where does this Claude profile keep its transcripts?".
 *
 * Everything that needs that path — the provider itself, capability probing in
 * the tool registry, Doctor — must call this, because the two natural ways to
 * write the setting have to agree. `sessionsDir: ~/.claude-perso` means the
 * profile root and the transcripts are one level down in `projects/`, while
 * `sessionsDir: ~/.claude-perso/projects` points straight at them. When only
 * some callers accepted the second form, the provider read the right directory
 * while the registry probed `.../projects/projects`, found nothing, and
 * advertised naming and attention as unavailable for a profile that was in fact
 * perfectly readable.
 */
export function resolveClaudeProjectsDir(sessionsDir?: string): string {
	if (!sessionsDir) return DEFAULT_PROJECTS_DIR;
	const root = path.normalize(sessionsDir);
	// Already the transcripts directory: joining `projects` again would only
	// invent a path that never exists.
	if (path.basename(root) === "projects") return root;
	return path.join(root, "projects");
}

const CHUNK_SIZE = 4096;
/** Bytes of a transcript scanned to recover its session id, cwd and start time. */
const HEADER_SCAN_BYTES = 64 * 1024;
/** Minimum delay between two full rescans of the transcript tree. */
const SCAN_CACHE_MS = 5_000;

export class ClaudeSessionProvider
	implements SessionProvider, SessionRenameAdapter, SessionTitleProvider
{
	readonly toolId: string;
	private readonly projectsDir: string;
	private readonly pathCache = new Map<string, string>();
	private readonly contentPathIndex = new Map<string, string>();
	private contentPathIndexBuiltAt = 0;
	private scanCache: { builtAt: number; sessions: SessionInfo[] } | undefined;
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

	/**
	 * Enumerate the sessions this Claude profile knows about.
	 *
	 * Two sources, because neither is sufficient on its own. `sessions-index.json`
	 * is the cheap path but it is not written by every Claude profile — a
	 * `CLAUDE_CONFIG_DIR` profile can have none at all, in which case an
	 * index-only scan reports zero sessions while transcripts sit right there.
	 * So transcripts are also read directly: the first line carries `sessionId`,
	 * and the first conversational event carries `cwd` and `timestamp`, which is
	 * what binding needs to attribute a session to a worktree.
	 */
	scanSessions(options?: { fresh?: boolean }): SessionInfo[] {
		const now = Date.now();
		if (
			!options?.fresh &&
			this.scanCache &&
			now - this.scanCache.builtAt < SCAN_CACHE_MS
		) {
			return this.scanCache.sessions;
		}
		const byId = new Map<string, SessionInfo>();
		for (const session of this.scanIndexedSessions()) {
			byId.set(session.sessionId, session);
		}
		for (const session of this.scanTranscriptSessions(this.projectsDir)) {
			const existing = byId.get(session.sessionId);
			// Transcript headers win for projectPath/created: they are read from
			// the session's own events rather than a lossy encoded directory name.
			byId.set(session.sessionId, {
				sessionId: session.sessionId,
				prompt: existing?.prompt || session.prompt,
				created: session.created || existing?.created || "",
				projectPath: session.projectPath || existing?.projectPath || "",
			});
		}
		const sessions = [...byId.values()];
		this.scanCache = { builtAt: now, sessions };
		return sessions;
	}

	/** True when the transcript for `sessionId` exists in this profile. */
	hasSession(sessionId: string): boolean {
		return this.findSessionFile(sessionId) !== null;
	}

	private scanTranscriptSessions(dir: string): SessionInfo[] {
		const results: SessionInfo[] = [];
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return results;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...this.scanTranscriptSessions(fullPath));
				continue;
			}
			if (!entry.name.endsWith(".jsonl")) continue;
			const header = readTranscriptHeader(fullPath);
			if (!header) continue;
			this.pathCache.set(header.sessionId, fullPath);
			results.push({
				sessionId: header.sessionId,
				prompt: "",
				created: header.created,
				projectPath: header.projectPath,
			});
		}
		return results;
	}

	private scanIndexedSessions(): SessionInfo[] {
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

	/**
	 * Derive attention from the transcript's conversational events.
	 *
	 * Only `user` and `assistant` move the state. A real interactive transcript
	 * interleaves a lot of bookkeeping — `attachment`, `system`, `pr-link`,
	 * `mode`, `permission-mode`, `file-history-*`, `queue-operation`, `ai-title`
	 * — around almost every turn. Treating those as "unknown, so forget what we
	 * knew" erased the signal within seconds of it being produced and left every
	 * live Claude agent with no evidence at all. Unrecognized events are now
	 * carried through unchanged, which is also how the Codex reader behaves.
	 *
	 * Sub-agent turns (`isSidechain`) are skipped: a sidechain finishing its turn
	 * says nothing about whether the main agent is still working.
	 */
	readAttention(sessionId: string): ProviderAttentionSignal | undefined {
		const filePath = this.findSessionFile(sessionId);
		if (!filePath) return undefined;

		const state = readIncrementalJsonl(
			filePath,
			this.attentionCache.get(sessionId),
			(line, previous): ProviderAttentionSignal | undefined => {
				const event = JSON.parse(line) as Record<string, unknown>;
				let signal = previous;
				const explicitSessionId = event.sessionId ?? event.session_id;
				if (
					typeof explicitSessionId === "string" &&
					explicitSessionId !== sessionId
				) {
					return signal;
				}
				if (event.isSidechain === true) return signal;

				const observedAt =
					typeof event.timestamp === "string" ? event.timestamp : undefined;

				if (event.type === "user") {
					return { status: "working", evidence: "claude.user", observedAt };
				}
				// `result` events only exist in the `-p --output-format stream-json`
				// transcript shape, never in an interactive session. Kept so headless
				// runs stay readable.
				if (event.type === "result") {
					const failed = event.is_error === true;
					const resultSignal: ProviderAttentionSignal = {
						status: failed ? "failed" : "idle",
						evidence: failed ? "claude.result.error" : "claude.result",
						observedAt,
					};
					return resultSignal;
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
							observedAt,
						};
					} else if (stopReason === "tool_use") {
						signal = {
							status: "working",
							evidence: "claude.assistant.tool_use",
							observedAt,
						};
					} else if (stopReason === "end_turn") {
						signal = {
							status: "idle",
							evidence: "claude.assistant.end_turn",
							observedAt,
						};
					}
					return signal;
				}
				// Bookkeeping event: carry the last conversational signal through
				// unchanged rather than discarding hard-won evidence.
				return signal;
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
		this.scanCache = undefined;
	}

	dispose(): void {
		this.pathCache.clear();
		this.contentPathIndex.clear();
		this.contentPathIndexBuiltAt = 0;
		this.indexCache.clear();
		this.attentionCache.clear();
		this.scanCache = undefined;
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

interface TranscriptHeader {
	sessionId: string;
	projectPath: string;
	created: string;
}

/**
 * Recover a transcript's identity from its own content.
 *
 * The enclosing directory name is a lossy encoding of the working directory
 * (`/`, `.` and `_` all collapse to `-`), so it cannot be decoded back into a
 * path that would compare equal to a worktree. The events themselves carry an
 * exact `cwd` and an ISO `timestamp`; only a bounded prefix is read so a large
 * transcript never costs more than one small read.
 */
function readTranscriptHeader(filePath: string): TranscriptHeader | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const size = fs.fstatSync(fd).size;
		if (size === 0) return null;
		const length = Math.min(HEADER_SCAN_BYTES, size);
		const buffer = Buffer.alloc(length);
		fs.readSync(fd, buffer, 0, length, 0);

		let sessionId = "";
		let projectPath = "";
		let created = "";
		const lines = buffer.toString("utf-8").split("\n");
		// The final line may be truncated by the bounded read.
		const complete = length < size ? lines.slice(0, -1) : lines;
		for (const line of complete) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (!sessionId && typeof event.sessionId === "string") {
				sessionId = event.sessionId;
			}
			if (!projectPath && typeof event.cwd === "string") {
				projectPath = event.cwd;
			}
			if (!created && typeof event.timestamp === "string") {
				created = event.timestamp;
			}
			if (sessionId && projectPath && created) break;
		}
		if (!sessionId) return null;
		return { sessionId, projectPath, created };
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
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
