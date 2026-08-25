import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderSessionAdapter } from "../providers/types";
import type { SessionInfo } from "./types";

const execFileAsync = promisify(execFile);

interface HermesBreadcrumb {
	session_id?: unknown;
	cwd?: unknown;
	ts?: unknown;
}

/** Hermes records the owning session and cwd for every interactive terminal. */
export class HermesSessionProvider implements ProviderSessionAdapter {
	readonly toolId = "hermes";
	readonly async = {
		scanSessions: async (): Promise<SessionInfo[]> => this.scanSessionsAsync(),
		hasSession: async (sessionId: string): Promise<boolean> =>
			this.hasSessionAsync(sessionId),
		readName: async (): Promise<string | null> => null,
	};

	scanSessions(): SessionInfo[] {
		const sessions = new Map<string, SessionInfo>();
		for (const breadcrumb of this.readBreadcrumbs()) {
			if (!breadcrumb.sessionId || !breadcrumb.projectPath) continue;
			sessions.set(breadcrumb.sessionId, {
				sessionId: breadcrumb.sessionId,
				prompt: "",
				created: breadcrumb.created,
				projectPath: breadcrumb.projectPath,
			});
		}
		return [...sessions.values()];
	}

	readName(): string | null {
		// Hermes does not expose a stable, cheap title lookup for terminal clients.
		return null;
	}

	hasSession(sessionId: string): boolean {
		if (!isSafeSessionId(sessionId)) return false;
		try {
			const output = execFileSync(
				"hermes",
				[
					"sessions",
					"export",
					"--dry-run",
					"--session-id",
					sessionId,
					"--format",
					"jsonl",
					"-",
				],
				{ encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
			);
			return /Would export 1 session/u.test(output);
		} catch {
			return false;
		}
	}

	private async hasSessionAsync(sessionId: string): Promise<boolean> {
		if (!isSafeSessionId(sessionId)) return false;
		try {
			const { stdout } = await execFileAsync(
				"hermes",
				[
					"sessions",
					"export",
					"--dry-run",
					"--session-id",
					sessionId,
					"--format",
					"jsonl",
					"-",
				],
				{ encoding: "utf8", timeout: 5_000 },
			);
			return /Would export 1 session/u.test(stdout);
		} catch {
			return false;
		}
	}

	private async scanSessionsAsync(): Promise<SessionInfo[]> {
		const sessions = new Map<string, SessionInfo>();
		for (const breadcrumb of await this.readBreadcrumbsAsync()) {
			if (!breadcrumb.sessionId || !breadcrumb.projectPath) continue;
			sessions.set(breadcrumb.sessionId, {
				sessionId: breadcrumb.sessionId,
				prompt: "",
				created: breadcrumb.created,
				projectPath: breadcrumb.projectPath,
			});
		}
		return [...sessions.values()];
	}

	private readBreadcrumbs(): Array<{
		sessionId: string;
		projectPath: string;
		created: string;
	}> {
		const directory = path.join(
			process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
			"terminal-sessions",
		);
		let names: string[];
		try {
			names = fs.readdirSync(directory);
		} catch {
			return [];
		}

		const result: Array<{
			sessionId: string;
			projectPath: string;
			created: string;
		}> = [];
		for (const name of names) {
			try {
				const value = JSON.parse(
					fs.readFileSync(path.join(directory, name), "utf8"),
				) as HermesBreadcrumb;
				const sessionId =
					typeof value.session_id === "string" ? value.session_id : "";
				const projectPath = typeof value.cwd === "string" ? value.cwd : "";
				if (!sessionId || !projectPath) continue;
				const timestamp = typeof value.ts === "number" ? value.ts * 1000 : 0;
				result.push({
					sessionId,
					projectPath,
					created: timestamp > 0 ? new Date(timestamp).toISOString() : "",
				});
			} catch {
				// A concurrently rewritten breadcrumb is ignored until the next pass.
			}
		}
		return result;
	}

	private async readBreadcrumbsAsync(): Promise<
		Array<{ sessionId: string; projectPath: string; created: string }>
	> {
		const directory = path.join(
			process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
			"terminal-sessions",
		);
		let names: string[];
		try {
			names = await fsp.readdir(directory);
		} catch {
			return [];
		}
		const result: Array<{
			sessionId: string;
			projectPath: string;
			created: string;
		}> = [];
		for (const name of names) {
			try {
				const value = JSON.parse(
					await fsp.readFile(path.join(directory, name), "utf8"),
				) as HermesBreadcrumb;
				const sessionId =
					typeof value.session_id === "string" ? value.session_id : "";
				const projectPath = typeof value.cwd === "string" ? value.cwd : "";
				if (!sessionId || !projectPath) continue;
				const timestamp = typeof value.ts === "number" ? value.ts * 1000 : 0;
				result.push({
					sessionId,
					projectPath,
					created: timestamp > 0 ? new Date(timestamp).toISOString() : "",
				});
			} catch {
				// A concurrently rewritten breadcrumb is ignored until the next pass.
			}
		}
		return result;
	}
}

function isSafeSessionId(sessionId: string): boolean {
	return /^[a-zA-Z0-9_-]+$/u.test(sessionId);
}
