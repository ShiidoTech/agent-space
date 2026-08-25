import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ProviderSessionAdapter } from "../providers/types";
import type { SessionInfo } from "./types";

interface HermesBreadcrumb {
	session_id?: unknown;
	cwd?: unknown;
	ts?: unknown;
}

/** Hermes records the owning session and cwd for every interactive terminal. */
export class HermesSessionProvider implements ProviderSessionAdapter {
	readonly toolId = "hermes";
	readonly async = {
		scanSessions: async (): Promise<SessionInfo[]> => this.scanSessions(),
		hasSession: async (sessionId: string): Promise<boolean> =>
			this.hasSession(sessionId),
		readName: async (): Promise<string | null> => null,
		correlateOwnedSession: async (
			cwd: string,
			knownSessionIds: ReadonlySet<string>,
		): Promise<string | undefined> =>
			this.correlateOwnedSession(cwd, knownSessionIds),
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

	correlateOwnedSession(
		cwd: string,
		knownSessionIds: ReadonlySet<string>,
	): string | undefined {
		const candidates = this.scanSessions().filter(
			(session) =>
				session.projectPath === cwd && !knownSessionIds.has(session.sessionId),
		);
		return candidates.length === 1 ? candidates[0]?.sessionId : undefined;
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
}

function isSafeSessionId(sessionId: string): boolean {
	return /^[a-zA-Z0-9_-]+$/u.test(sessionId);
}
