import type { GitReader } from "../git/gitClient";

const GITHUB_HOST = "github.com";

export interface GithubRepositoryIdentity {
	readonly owner: string;
	readonly repo: string;
	readonly remoteName: string;
	readonly remoteUrl: string;
	readonly urlKind: "https" | "ssh";
}

export interface GithubRemoteRecord {
	readonly name: string;
	readonly url: string;
}

/**
 * Explicit resolution of the GitHub repository behind a project. The four
 * states are deliberate: `known` (one unambiguous GitHub remote), `unavailable`
 * (no remote at all, or the only remote is not GitHub), `unknown`
 * (`ambiguous_remotes` when several GitHub remotes cannot be tied to a primary,
 * `remote_unreadable` when the Git config cannot be read) and `error`. No state
 * ever fabricates an identity.
 */
export type GithubRepositoryObservation =
	| {
			readonly status: "known";
			readonly identity: GithubRepositoryIdentity;
	  }
	| {
			readonly status: "unavailable";
			readonly reason: "no_remotes" | "unsupported_provider";
			readonly detail?: string;
			readonly observedRemotes: readonly GithubRemoteRecord[];
	  }
	| {
			readonly status: "unknown";
			readonly reason: "ambiguous_remotes" | "remote_unreadable";
			readonly detail?: string;
			readonly candidates?: readonly GithubRepositoryIdentity[];
			readonly observedRemotes: readonly GithubRemoteRecord[];
	  };

/**
 * Parse a remote URL into a GitHub repository identity. Supports the HTTPS
 * (`https://github.com/owner/repo(.git)`) and SSH
 * (`git@github.com:owner/repo(.git)`) forms Agent Space already accepts.
 */
export function parseGithubRemoteUrl(url: string): {
	readonly owner: string;
	readonly repo: string;
	readonly kind: "https" | "ssh";
} | null {
	const trimmed = url.trim();
	const scpMatch = trimmed.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
	);
	if (scpMatch) {
		return { owner: scpMatch[1], repo: scpMatch[2], kind: "ssh" };
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null;
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length !== 2) return null;
		return {
			owner: parts[0],
			repo: parts[1].replace(/\.git$/, ""),
			kind: parsed.protocol === "ssh:" ? "ssh" : "https",
		};
	} catch {
		return null;
	}
}

/**
 * Read-only resolution of the GitHub remote of a repository. Reads
 * `remote.*.url` config only; never mutates Git state.
 *
 * `origin` is preferred only when several GitHub remotes coexist (and it is
 * among them) — the same notion the existing "Create PR" flow already relies
 * on. It is never assumed blindly when it is absent.
 */
export async function observeGithubRepository(
	git: GitReader,
	repoRoot: string,
): Promise<GithubRepositoryObservation> {
	const result = await git.read(
		["config", "--get-regexp", "^remote\\..*\\.url$"],
		{ cwd: repoRoot },
	);
	if (result.exitCode === 1 && !result.error) {
		// Exit 1 from config --get-regexp means "no match": no remotes at all.
		return { status: "unavailable", reason: "no_remotes", observedRemotes: [] };
	}
	if (result.exitCode !== 0 || result.error) {
		return {
			status: "unknown",
			reason: "remote_unreadable",
			detail: result.stderr.trim() || result.error?.message,
			observedRemotes: [],
		};
	}

	const remotes = parseRemoteLines(result.stdout);
	const github = remotes
		.map((remote) => parseGithubRemoteUrl(remote.url))
		.map((parsed, index) =>
			parsed
				? {
						identity: {
							owner: parsed.owner,
							repo: parsed.repo,
							remoteName: remotes[index].name,
							remoteUrl: remotes[index].url,
							urlKind: parsed.kind,
						},
					}
				: null,
		)
		.filter(
			(entry): entry is { identity: GithubRepositoryIdentity } =>
				entry !== null,
		);

	if (github.length === 0) {
		return {
			status: "unavailable",
			reason: "unsupported_provider",
			observedRemotes: remotes,
		};
	}
	if (github.length === 1) {
		return { status: "known", identity: github[0].identity };
	}
	const origin = github.find((entry) => entry.identity.remoteName === "origin");
	if (origin) return { status: "known", identity: origin.identity };
	return {
		status: "unknown",
		reason: "ambiguous_remotes",
		candidates: github.map((entry) => entry.identity),
		observedRemotes: remotes,
	};
}

function parseRemoteLines(output: string): GithubRemoteRecord[] {
	const records: GithubRemoteRecord[] = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = trimmed.match(/^remote\.(.+)\.url\s+(.+)$/);
		if (match) records.push({ name: match[1], url: match[2].trim() });
	}
	return records;
}
