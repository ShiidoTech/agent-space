import * as fs from "node:fs";
import * as path from "node:path";
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
	private readonly indexCache = new Map<
		string,
		{ mtimeMs: number; titles: Map<string, string> }
	>();

	constructor(projectsDir?: string, toolId = "claude") {
		this.toolId = toolId;
		this.projectsDir = normalizeProjectsDir(projectsDir ?? DEFAULT_PROJECTS_DIR);
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
		} catch {
			// Ignore directory read errors
		}

		return null;
	}

	readName(sessionId: string): string | null {
		const filePath = this.findSessionFile(sessionId);
		if (!filePath) return null;
		return (
			this.readTitle(filePath) ??
			this.readIndexFallback(path.dirname(filePath), sessionId)
		);
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
	}

	dispose(): void {
		this.pathCache.clear();
		this.indexCache.clear();
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
