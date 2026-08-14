import { execFile } from "node:child_process";
import * as https from "node:https";
import { promisify } from "node:util";
import type { PullRequestObservation } from "./pullRequest";

const execFileAsync = promisify(execFile);

const GITHUB_API_HOST = "api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 5_000;

export type GitHubAuthStatus =
	| {
			readonly state: "authenticated";
			readonly source: "env" | "gh-cli";
			readonly token: string;
	  }
	| {
			readonly state: "unauthenticated";
			readonly reason:
				| "no_token_found"
				| "gh_cli_not_available"
				| "gh_cli_unauthenticated";
	  };

/** Raw GitHub REST record for the pulls list endpoint. */
export interface PullRequestApiRecord {
	readonly number: number;
	readonly html_url: string;
	readonly state: "open" | "closed";
	readonly draft?: boolean;
	readonly merged?: boolean;
	readonly merged_at?: string | null;
	readonly merge_commit_sha?: string | null;
	readonly title?: string | null;
	readonly head: { readonly ref: string; readonly sha: string };
	readonly base: { readonly ref: string };
}

export type ListPullRequestsResult =
	| {
			readonly status: "ok";
			readonly pulls: readonly PullRequestApiRecord[];
	  }
	| {
			readonly status: "error";
			readonly kind: "network" | "api" | "auth";
			readonly detail: string;
	  };

/**
 * Injectable GitHub transport. The extension host owns every call; the webview
 * never talks to GitHub. Implementations must be non-interactive: a background
 * observation must never trigger an authentication popup.
 */
export interface PullRequestBackend {
	/** Resolve the credentials currently usable by the extension host. */
	auth(): Promise<GitHubAuthStatus>;
	listPullRequests(options: {
		readonly owner: string;
		readonly repo: string;
		readonly head: string;
		readonly token: string;
	}): Promise<ListPullRequestsResult>;
}

/**
 * Real GitHub REST transport over HTTPS. Authentication is resolved silently:
 * env token first, then the `gh` CLI when available and already authenticated.
 * Neither path opens a browser or prompts the user.
 */
export class HttpGitHubBackend implements PullRequestBackend {
	async auth(): Promise<GitHubAuthStatus> {
		const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
		if (envToken?.trim()) {
			return { state: "authenticated", source: "env", token: envToken.trim() };
		}
		try {
			const result = await execFileAsync("gh", ["auth", "token"], {
				encoding: "utf8",
				// Authentication is optional background evidence. Do not let a slow or
				// unavailable gh installation block the local feature snapshot.
				timeout: 2_000,
				windowsHide: true,
			});
			const token = result.stdout.trim();
			if (token) {
				return { state: "authenticated", source: "gh-cli", token };
			}
			return { state: "unauthenticated", reason: "gh_cli_unauthenticated" };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { state: "unauthenticated", reason: "gh_cli_not_available" };
			}
			return { state: "unauthenticated", reason: "gh_cli_unauthenticated" };
		}
	}

	async listPullRequests(options: {
		readonly owner: string;
		readonly repo: string;
		readonly head: string;
		readonly token: string;
	}): Promise<ListPullRequestsResult> {
		const path = `/repos/${options.owner}/${options.repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${options.owner}:${options.head}`)}`;
		let statusCode: number;
		let body: string;
		try {
			const startedAt = Date.now();
			const response = await requestJson(path, options.token);
			console.debug(
				`[agentSpace] GitHub PR query ${options.owner}/${options.repo}#${options.head} completed in ${Date.now() - startedAt}ms`,
			);
			statusCode = response.statusCode;
			body = response.body;
		} catch (error) {
			console.warn(
				`[agentSpace] GitHub PR query ${options.owner}/${options.repo}#${options.head} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return {
				status: "error",
				kind: "network",
				detail: error instanceof Error ? error.message : String(error),
			};
		}

		if (statusCode >= 200 && statusCode < 300) {
			try {
				const records = JSON.parse(body) as PullRequestApiRecord[];
				return { status: "ok", pulls: records };
			} catch {
				return {
					status: "error",
					kind: "api",
					detail: "GitHub returned an unparseable response payload.",
				};
			}
		}
		if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
			return {
				status: "error",
				kind: "auth",
				detail: `GitHub rejected the pull request query (HTTP ${statusCode}).`,
			};
		}
		return {
			status: "error",
			kind: "api",
			detail: `GitHub API responded with HTTP ${statusCode}.`,
		};
	}
}

export function toPullRequestObservation(
	record: PullRequestApiRecord,
): PullRequestObservation {
	// The REST list endpoint represents merged pull requests as `state: closed`.
	// Unlike the single-PR endpoint, it may omit the boolean `merged` field while
	// still returning `merged_at`. Treat either positive field as merge proof;
	// never infer a merge from `state: closed` alone.
	const merged = record.merged === true || Boolean(record.merged_at);
	const state = record.state === "open" ? "open" : merged ? "merged" : "closed";
	return {
		number: record.number,
		url: record.html_url,
		state,
		draft: Boolean(record.draft),
		headRef: record.head.ref,
		headSha: record.head.sha,
		baseRef: record.base.ref,
		...(record.title ? { title: record.title } : {}),
		...(record.merged_at ? { mergedAt: record.merged_at } : {}),
		...(record.merge_commit_sha
			? { mergeCommitSha: record.merge_commit_sha }
			: {}),
	};
}

function requestJson(
	path: string,
	token: string,
): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = https.request(
			{
				host: GITHUB_API_HOST,
				path,
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
					Authorization: `Bearer ${token}`,
					"User-Agent": "agent-space",
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(chunk as Buffer));
				response.on("end", () => {
					resolve({
						statusCode: response.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		request.setTimeout(GITHUB_REQUEST_TIMEOUT_MS, () =>
			request.destroy(new Error(`GitHub request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms`)),
		);
		request.on("error", reject);
		request.end();
	});
}
