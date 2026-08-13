import type { GithubRepositoryObservation } from "./githubRepository";
import type {
	PullRequestObservation,
	PullRequestResolution,
} from "./pullRequest";

export type GitHubObservationStatus =
	| "known"
	| "unavailable"
	| "unknown"
	| "error";

export type GitHubObservationReason =
	| "unsupported_provider"
	| "repository_unknown"
	| "remote_unreadable"
	| "ambiguous_repository"
	| "authentication_missing"
	| "ambiguous_pull_requests"
	| "api_error"
	| "network_error";

/**
 * Full GitHub observation for one feature. The remote state is deliberately NOT
 * reduced to `PR | null`:
 *
 * - `known` — a GitHub repository was resolved and the query succeeded; `pulls`
 *   is the candidate list (possibly empty) and `resolution` decides between no
 *   PR, one PR, or an ambiguity.
 * - `unavailable` — GitHub cannot be queried (private repo or no usable
 *   credentials, a non-GitHub remote, or no remote at all). Never "no PR".
 * - `unknown` — candidates cannot be tied deterministically, or the remote
 *   config cannot be read.
 * - `error` — the GitHub API/network failed.
 *
 * Provenance (local Git vs GitHub) is preserved: `queriedHeadSha` records the
 * local SHA the PR query was matched against and is never silently replaced by
 * a remote SHA.
 */
export type GitHubObservation =
	| GitHubKnownObservation
	| GitHubUnavailableObservation
	| GitHubUnknownObservation
	| GitHubErrorObservation;

interface GitHubObservationShared {
	readonly provider: "github";
	readonly repository: GithubRepositoryObservation;
	readonly observedAt: string;
}

export interface GitHubKnownObservation extends GitHubObservationShared {
	readonly status: "known";
	readonly pulls: readonly PullRequestObservation[];
	readonly resolution: PullRequestResolution;
	/** Local feature head the PR evidence was matched against. */
	readonly queriedHeadSha?: string;
	/** Agent Space's expected base branch when observed. */
	readonly expectedBaseRef?: string;
	/** The branch the PR query was made for; identifies the delivery vector. */
	readonly queriedBranch?: string;
	readonly authSource?: "env" | "gh-cli";
}

export interface GitHubUnavailableObservation extends GitHubObservationShared {
	readonly status: "unavailable";
	readonly reason:
		| "unsupported_provider"
		| "repository_unknown"
		| "authentication_missing";
	readonly detail?: string;
}

export interface GitHubUnknownObservation extends GitHubObservationShared {
	readonly status: "unknown";
	readonly reason:
		| "remote_unreadable"
		| "ambiguous_repository"
		| "ambiguous_pull_requests";
	readonly detail?: string;
	readonly pulls?: readonly PullRequestObservation[];
	readonly queriedHeadSha?: string;
	readonly expectedBaseRef?: string;
	readonly queriedBranch?: string;
}

export interface GitHubErrorObservation extends GitHubObservationShared {
	readonly status: "error";
	readonly reason: "api_error" | "network_error";
	readonly detail: string;
}

/** Build the observation from repository identity alone, without a PR query. */
export function githubObservationFromRepository(
	repository: GithubRepositoryObservation,
): GitHubObservation {
	const shared = { provider: "github", repository } as const;
	switch (repository.status) {
		case "unknown":
			return {
				...shared,
				status: "unknown",
				reason:
					repository.reason === "remote_unreadable"
						? "remote_unreadable"
						: "ambiguous_repository",
				...(repository.detail ? { detail: repository.detail } : {}),
				observedAt: new Date().toISOString(),
			};
		case "unavailable":
			return {
				...shared,
				status: "unavailable",
				reason:
					repository.reason === "unsupported_provider"
						? "unsupported_provider"
						: "repository_unknown",
				...(repository.detail ? { detail: repository.detail } : {}),
				observedAt: new Date().toISOString(),
			};
		case "known":
			return {
				...shared,
				status: "unavailable",
				reason: "authentication_missing",
				detail: "Repository resolved but credentials are unavailable.",
				observedAt: new Date().toISOString(),
			};
	}
}
