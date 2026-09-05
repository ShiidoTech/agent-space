import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ProviderSessionAdapter } from "../providers/types";
import { singleUnclaimedCandidate } from "./candidateCorrelation";
import type {
	SessionCorrelationContext,
	SessionInfo,
	SessionProvider,
} from "./types";

const DEFAULT_SESSION_DIR = path.join(
	process.env.HOME || "~",
	".copilot",
	"session-state",
);

/**
 * Reader for the GitHub Copilot CLI session store (read-only).
 *
 * Real layout (verified against production `~/.copilot/session-state`):
 * one directory per session, named by session id, containing
 * - `events.jsonl`: one JSON object per line with
 *   `{id, parentId, timestamp, type, data}`. Types include
 *   `session.start` (data: `{sessionId, startTime, ...}`),
 *   `user.message` (data: `{content|transformedContent, ...}`),
 *   `assistant.turn_start/turn_end`, `tool.execution_start/complete`, ...
 * - `workspace.yaml`: flat `key: value` lines with
 *   `{id, cwd, summary, summary_count, created_at, updated_at}`.
 *   `cwd` is the session's working directory, `summary` its display title.
 *
 * Legacy flat `*.jsonl` files directly under the store (the layout this
 * provider originally assumed) are still read as a fallback.
 *
 * Attention (`working`/`waiting`/`idle`) is deliberately NOT advertised:
 * inferring a live phase from the last JSONL event would be recency
 * inference, which Agent Space refuses. Only durable identity (session
 * existence, name, cwd) is exposed.
 */
export class CopilotSessionProvider
	implements SessionProvider, ProviderSessionAdapter
{
	readonly toolId = "copilot";
	private readonly sessionDir: string;
	private readonly pathCache = new Map<string, string>();
	private readonly nameCache = new Map<string, string>();

	constructor(sessionDir?: string) {
		this.sessionDir = sessionDir ?? DEFAULT_SESSION_DIR;
	}

	scanSessions(): SessionInfo[] {
		const results: SessionInfo[] = [];
		if (!fs.existsSync(this.sessionDir)) return results;

		try {
			const entries = fs.readdirSync(this.sessionDir, {
				withFileTypes: true,
			});
			for (const entry of entries) {
				try {
					if (entry.isDirectory()) {
						const session = this.parseSessionDir(
							path.join(this.sessionDir, entry.name),
							entry.name,
						);
						if (session) results.push(session);
					} else if (entry.name.endsWith(".jsonl")) {
						const raw = fs.readFileSync(
							path.join(this.sessionDir, entry.name),
							"utf-8",
						);
						const session = parseSessionJsonl(raw);
						if (session) results.push(session);
					}
				} catch {
					// Skip unreadable entries
				}
			}
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

	/** True when a session directory (or legacy file) for `sessionId` exists. */
	hasSession(sessionId: string): boolean {
		return this.findSessionFile(sessionId) !== null;
	}

	findSessionFile(sessionId: string): string | null {
		const cached = this.pathCache.get(sessionId);
		if (cached) {
			if (fs.existsSync(cached)) return cached;
			this.pathCache.delete(sessionId);
		}
		if (!fs.existsSync(this.sessionDir)) return null;
		try {
			const dirEvents = path.join(this.sessionDir, sessionId, "events.jsonl");
			if (fs.existsSync(dirEvents)) {
				this.pathCache.set(sessionId, dirEvents);
				return dirEvents;
			}
			const flat = path.join(this.sessionDir, `${sessionId}.jsonl`);
			if (fs.existsSync(flat)) {
				this.pathCache.set(sessionId, flat);
				return flat;
			}
			// Fall back to a full scan (session.start may carry an id that
			// differs from the file name).
			for (const session of this.scanSessions()) {
				if (session.sessionId !== sessionId) continue;
				const found =
					this.pathCache.get(sessionId) ??
					path.join(this.sessionDir, `${sessionId}.jsonl`);
				return found;
			}
		} catch {
			return null;
		}
		return null;
	}

	/**
	 * Display name: the `summary` Copilot maintains in `workspace.yaml`,
	 * falling back to the first user prompt.
	 */
	readName(sessionId: string): string | null {
		const cached = this.nameCache.get(sessionId);
		if (cached !== undefined) return cached || null;
		const name = this.readNameUncached(sessionId);
		if (name) this.nameCache.set(sessionId, name);
		return name;
	}

	clearCache(sessionId: string): void {
		this.pathCache.delete(sessionId);
		this.nameCache.delete(sessionId);
	}

	private readNameUncached(sessionId: string): string | null {
		const workspace = readWorkspaceYaml(
			path.join(this.sessionDir, sessionId, "workspace.yaml"),
		);
		if (workspace?.summary) return workspace.summary;
		const filePath = this.findSessionFile(sessionId);
		if (!filePath) return null;
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const session = parseSessionJsonl(raw);
			return session?.prompt || null;
		} catch {
			return null;
		}
	}

	/**
	 * Ownership proof for a provider-assigned id: the single unclaimed
	 * session in this agent's cwd born after its launch. Real ambiguity
	 * still yields `undefined` — never a guess.
	 */
	correlateOwnedSession(
		context: SessionCorrelationContext,
	): string | undefined {
		return singleUnclaimedCandidate(this.scanSessions(), context);
	}

	private async correlateOwnedSessionAsync(
		context: SessionCorrelationContext,
	): Promise<string | undefined> {
		return singleUnclaimedCandidate(await this.async.scanSessions(), context);
	}

	/**
	 * Reconnect to a previously bound Copilot session. Only a session
	 * directory (or legacy file) that actually exists on disk proves
	 * `copilot --resume <sessionId>` will find a session.
	 */
	async resumeConversation(sessionId: string): Promise<boolean> {
		return (await this.async.hasSession(sessionId)) === true;
	}

	readonly async = {
		scanSessions: async (): Promise<SessionInfo[]> => {
			const results: SessionInfo[] = [];
			try {
				await fsp.access(this.sessionDir);
			} catch {
				return [];
			}
			try {
				const entries = await fsp.readdir(this.sessionDir, {
					withFileTypes: true,
				});
				for (const entry of entries) {
					try {
						if (entry.isDirectory()) {
							const session = await this.parseSessionDirAsync(
								path.join(this.sessionDir, entry.name),
								entry.name,
							);
							if (session) results.push(session);
						} else if (entry.name.endsWith(".jsonl")) {
							const raw = await fsp.readFile(
								path.join(this.sessionDir, entry.name),
								"utf-8",
							);
							const session = parseSessionJsonl(raw);
							if (session) results.push(session);
						}
					} catch {
						// Skip unreadable entries
					}
				}
			} catch {
				// Ignore directory errors
			}
			return results;
		},
		hasSession: async (sessionId: string): Promise<boolean> => {
			const dirEvents = path.join(this.sessionDir, sessionId, "events.jsonl");
			try {
				await fsp.access(dirEvents);
				return true;
			} catch {
				// Fall through to the legacy flat file.
			}
			try {
				await fsp.access(path.join(this.sessionDir, `${sessionId}.jsonl`));
				return true;
			} catch {
				return false;
			}
		},
		readName: async (sessionId: string): Promise<string | null> => {
			const cached = this.nameCache.get(sessionId);
			if (cached !== undefined) return cached || null;
			const workspace = await readWorkspaceYamlAsync(
				path.join(this.sessionDir, sessionId, "workspace.yaml"),
			);
			if (workspace?.summary) {
				this.nameCache.set(sessionId, workspace.summary);
				return workspace.summary;
			}
			return this.readName(sessionId);
		},
		correlateOwnedSession: async (
			context: SessionCorrelationContext,
		): Promise<string | undefined> => this.correlateOwnedSessionAsync(context),
	};

	private parseSessionDir(
		dirPath: string,
		dirName: string,
	): SessionInfo | null {
		let session: SessionInfo | null = null;
		try {
			const raw = fs.readFileSync(path.join(dirPath, "events.jsonl"), "utf-8");
			session = parseSessionJsonl(raw, dirName);
		} catch {
			session = null;
		}
		const workspace = readWorkspaceYaml(path.join(dirPath, "workspace.yaml"));
		if (!session) {
			// events.jsonl missing or without session.start: the directory
			// name itself plus workspace.yaml still identify the session.
			if (!workspace) return null;
			return {
				sessionId: workspace.id || dirName,
				prompt: "",
				created: workspace.createdAt || "",
				projectPath: workspace.cwd || "",
			};
		}
		return {
			...session,
			sessionId: session.sessionId || workspace?.id || dirName,
			created: session.created || workspace?.createdAt || "",
			projectPath: workspace?.cwd ?? session.projectPath,
			prompt: session.prompt || "",
		};
	}

	private async parseSessionDirAsync(
		dirPath: string,
		dirName: string,
	): Promise<SessionInfo | null> {
		let session: SessionInfo | null = null;
		try {
			const raw = await fsp.readFile(
				path.join(dirPath, "events.jsonl"),
				"utf-8",
			);
			session = parseSessionJsonl(raw, dirName);
		} catch {
			session = null;
		}
		const workspace = await readWorkspaceYamlAsync(
			path.join(dirPath, "workspace.yaml"),
		);
		if (!session) {
			if (!workspace) return null;
			return {
				sessionId: workspace.id || dirName,
				prompt: "",
				created: workspace.createdAt || "",
				projectPath: workspace.cwd || "",
			};
		}
		return {
			...session,
			sessionId: session.sessionId || workspace?.id || dirName,
			created: session.created || workspace?.createdAt || "",
			projectPath: workspace?.cwd ?? session.projectPath,
			prompt: session.prompt || "",
		};
	}
}

interface CopilotWorkspace {
	id: string;
	cwd: string;
	summary: string;
	createdAt: string;
}

/** Minimal flat `key: value` reader for Copilot's `workspace.yaml` (no dep). */
function readWorkspaceYaml(filePath: string): CopilotWorkspace | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return parseWorkspaceYaml(raw);
	} catch {
		return null;
	}
}

async function readWorkspaceYamlAsync(
	filePath: string,
): Promise<CopilotWorkspace | null> {
	try {
		const raw = await fsp.readFile(filePath, "utf-8");
		return parseWorkspaceYaml(raw);
	} catch {
		return null;
	}
}

function parseWorkspaceYaml(raw: string): CopilotWorkspace | null {
	const values: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		// Only top-level `key: value` lines; nested blocks are out of scope.
		if (/^\s/.test(line)) continue;
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key && !(key in values)) values[key] = value;
	}
	if (!values.id && !values.cwd && !values.summary && !values.created_at) {
		return null;
	}
	return {
		id: values.id ?? "",
		cwd: values.cwd ?? "",
		summary: values.summary ?? "",
		createdAt: values.created_at ?? "",
	};
}

function parseSessionJsonl(
	raw: string,
	fallbackSessionId = "",
): SessionInfo | null {
	const lines = raw.split("\n").filter((l) => l.trim());

	let sessionId = "";
	let startTime = "";
	let prompt = "";

	for (const line of lines) {
		try {
			const event = JSON.parse(line);
			const type = event.type || event.event;

			if (type === "session.start") {
				sessionId =
					event.data?.sessionId ||
					event.sessionId ||
					event.data?.session_id ||
					sessionId;
				startTime =
					event.data?.startTime ||
					event.startTime ||
					event.data?.start_time ||
					event.timestamp ||
					startTime;
			}

			if ((type === "user.message" || type === "user.prompt") && !prompt) {
				const content =
					event.data?.transformedContent ||
					event.data?.content ||
					event.content ||
					"";
				prompt = extractTaskFromContent(content);
			}
		} catch {
			// Skip unparseable lines
		}
	}

	if (!sessionId) sessionId = fallbackSessionId;
	if (!sessionId) return null;

	return {
		sessionId,
		prompt,
		created: startTime,
		// The legacy flat layout carries no project path; the directory
		// layout fills it from workspace.yaml afterwards.
		projectPath: "",
	};
}

function extractTaskFromContent(content: string): string {
	if (typeof content !== "string") return "";
	// Copilot wraps the task in a template: ## TASK\n{task}\n## CONSTRAINTS
	const taskMatch = content.match(/## TASK\n([\s\S]*?)(?:\n## |$)/);
	if (taskMatch?.[1]) {
		return taskMatch[1].trim();
	}
	// Fallback: use the content directly (first line)
	const firstLine = content.split("\n")[0]?.trim() || "";
	return firstLine;
}
