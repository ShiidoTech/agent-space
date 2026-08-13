import type { GitReader } from "../git/gitClient";
import {
	type GitHubObservation,
	githubObservationFromRepository,
} from "./githubObservation";
import {
	type GithubRepositoryObservation,
	observeGithubRepository,
} from "./githubRepository";
import { resolvePullRequest } from "./pullRequest";
import {
	type GitHubAuthStatus,
	type PullRequestBackend,
	toPullRequestObservation,
} from "./pullRequestBackend";

export interface PullRequestInspectionInput {
	readonly repoRoot: string;
	readonly branch: string;
	/** Locally observed feature head used to match PR heads. */
	readonly queriedHeadSha?: string;
	/** Agent Space's expected base branch. */
	readonly expectedBaseRef?: string;
	/** Precomputed repository identity (shared across features of one repo). */
	readonly repository?: GithubRepositoryObservation;
	/** Precomputed authentication status (shared across features of one repo). */
	readonly auth?: GitHubAuthStatus;
}

export interface GithubRepositoryFacts {
	readonly repository: GithubRepositoryObservation;
	readonly auth: GitHubAuthStatus;
}

/**
 * Observe GitHub pull-request evidence for one feature branch.
 *
 * Deliberately independent from FeatureGitInspector conclusions: Git answers
 * local commit-graph questions, GitHub answers PR questions, and
 * IntegrationEvaluator combines the two later. PR existence is never inferred
 * from refs/remotes/*, upstream config or branch names — only the GitHub API
 * (through an injected, non-interactive backend) decides.
 */
export class PullRequestInspector {
	constructor(
		private readonly git: GitReader,
		private readonly backend: PullRequestBackend,
	) {}

	/** Repository identity + auth availability for one repository. */
	async observeRepositoryFacts(
		repoRoot: string,
	): Promise<GithubRepositoryFacts> {
		const repository = await observeGithubRepository(this.git, repoRoot);
		const auth = await this.backend.auth();
		return { repository, auth };
	}

	async observe(input: PullRequestInspectionInput): Promise<GitHubObservation> {
		const repository =
			input.repository ??
			(await observeGithubRepository(this.git, input.repoRoot));
		if (repository.status !== "known") {
			return githubObservationFromRepository(repository);
		}

		const auth = input.auth ?? (await this.backend.auth());
		if (auth.state !== "authenticated") {
			return {
				provider: "github",
				status: "unavailable",
				reason: "authentication_missing",
				repository,
				detail:
					auth.reason === "gh_cli_not_available"
						? "No GITHUB_TOKEN is set and the gh CLI is unavailable."
						: "No GitHub credentials are usable by the extension host.",
				observedAt: new Date().toISOString(),
			};
		}

		const result = await this.backend.listPullRequests({
			owner: repository.identity.owner,
			repo: repository.identity.repo,
			head: input.branch,
			token: auth.token,
		});
		if (result.status === "error") {
			return {
				provider: "github",
				status: "error",
				reason: result.kind === "network" ? "network_error" : "api_error",
				repository,
				detail: result.detail,
				observedAt: new Date().toISOString(),
			};
		}

		const pulls = result.pulls.map(toPullRequestObservation);
		const resolution = resolvePullRequest(
			pulls,
			input.queriedHeadSha ?? "",
			input.expectedBaseRef,
		);
		if (resolution.outcome === "ambiguous") {
			return {
				provider: "github",
				status: "unknown",
				reason: "ambiguous_pull_requests",
				repository,
				pulls,
				queriedHeadSha: input.queriedHeadSha,
				queriedBranch: input.branch,
				expectedBaseRef: input.expectedBaseRef,
				detail: `Multiple pull request candidates exist for ${input.branch} and none can be selected deterministically.`,
				observedAt: new Date().toISOString(),
			};
		}
		return {
			provider: "github",
			status: "known",
			repository,
			pulls,
			resolution,
			queriedHeadSha: input.queriedHeadSha,
			queriedBranch: input.branch,
			expectedBaseRef: input.expectedBaseRef,
			authSource: auth.source,
			observedAt: new Date().toISOString(),
		};
	}
}

export async function inspectPullRequests(
	input: PullRequestInspectionInput,
	git: GitReader,
	backend: PullRequestBackend,
): Promise<GitHubObservation> {
	return new PullRequestInspector(git, backend).observe(input);
}
