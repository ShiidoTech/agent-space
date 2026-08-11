import type { GitHubObservation } from "./githubObservation";
import { githubObservationFromRepository } from "./githubObservation";
import type {
	GithubRepositoryFacts,
	PullRequestInspector,
} from "./pullRequestInspector";

/** How long a per-branch PR observation stays valid between reconciles. */
export const GITHUB_OBSERVATION_TTL_MS = 5 * 60 * 1000;

/** How long a per-repository identity/auth fact stays valid. */
export const GITHUB_REPOSITORY_FACT_TTL_MS = 15 * 60 * 1000;

export interface GithubObservationServiceOptions {
	readonly createInspector: (repoRoot: string) => PullRequestInspector;
	readonly ttlMs?: number;
	readonly repositoryFactTtlMs?: number;
	readonly now?: () => number;
}

export interface GithubObservationRequest {
	readonly repoRoot: string;
	readonly branch: string;
	readonly queriedHeadSha?: string;
	readonly expectedBaseRef?: string;
}

/**
 * Repository-level cache for GitHub observations.
 *
 * GitHub is network I/O and must not run on every 15s reconciliation: a
 * per-branch observation is cached for `ttlMs`, and repository identity +
 * auth facts — which all features of a project share — are fetched once per
 * `repositoryFactTtlMs` and reused across every feature. An explicit
 * `invalidate()` forces re-observation (an explicit user Refresh) but never
 * triggers any implicit Git fetch.
 */
export class GitHubObservationService {
	private readonly ttlMs: number;
	private readonly repositoryFactTtlMs: number;
	private readonly now: () => number;
	private readonly inspectors = new Map<string, PullRequestInspector>();
	private readonly repositoryFacts = new Map<
		string,
		{ readonly facts: GithubRepositoryFacts; readonly at: number }
	>();
	private readonly branchObservations = new Map<
		string,
		{ readonly observation: GitHubObservation; readonly at: number }
	>();

	constructor(private readonly options: GithubObservationServiceOptions) {
		this.ttlMs = options.ttlMs ?? GITHUB_OBSERVATION_TTL_MS;
		this.repositoryFactTtlMs =
			options.repositoryFactTtlMs ?? GITHUB_REPOSITORY_FACT_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	async observe(request: GithubObservationRequest): Promise<GitHubObservation> {
		const branchKey = `${request.repoRoot}\u0000${request.branch}`;
		const cached = this.branchObservations.get(branchKey);
		if (cached && this.now() - cached.at < this.ttlMs) {
			return cached.observation;
		}

		const facts = await this.observeRepositoryFacts(request.repoRoot);
		let observation: GitHubObservation;
		if (
			facts.repository.status !== "known" ||
			facts.auth.state !== "authenticated"
		) {
			observation = githubObservationFromRepositoryForAuth(facts);
		} else {
			const inspector = this.inspectorFor(request.repoRoot);
			observation = await inspector.observe({
				repoRoot: request.repoRoot,
				branch: request.branch,
				queriedHeadSha: request.queriedHeadSha,
				expectedBaseRef: request.expectedBaseRef,
				repository: facts.repository,
				auth: facts.auth,
			});
		}
		this.branchObservations.set(branchKey, {
			observation,
			at: this.now(),
		});
		return observation;
	}

	/** Drop every cached GitHub fact; the next observe re-queries the API. */
	invalidate(): void {
		this.repositoryFacts.clear();
		this.branchObservations.clear();
	}

	dispose(): void {
		this.inspectors.clear();
		this.repositoryFacts.clear();
		this.branchObservations.clear();
	}

	private async observeRepositoryFacts(
		repoRoot: string,
	): Promise<GithubRepositoryFacts> {
		const cached = this.repositoryFacts.get(repoRoot);
		if (cached && this.now() - cached.at < this.repositoryFactTtlMs) {
			return cached.facts;
		}
		const facts =
			await this.inspectorFor(repoRoot).observeRepositoryFacts(repoRoot);
		this.repositoryFacts.set(repoRoot, { facts, at: this.now() });
		return facts;
	}

	private inspectorFor(repoRoot: string): PullRequestInspector {
		let inspector = this.inspectors.get(repoRoot);
		if (!inspector) {
			inspector = this.options.createInspector(repoRoot);
			this.inspectors.set(repoRoot, inspector);
		}
		return inspector;
	}
}

/** Repository identity known but credentials missing (or repo not GitHub). */
function githubObservationFromRepositoryForAuth(
	facts: GithubRepositoryFacts,
): GitHubObservation {
	if (facts.repository.status !== "known") {
		return githubObservationFromRepository(facts.repository);
	}
	return {
		provider: "github",
		status: "unavailable",
		reason: "authentication_missing",
		repository: facts.repository,
		detail:
			facts.auth.state === "authenticated"
				? "Repository resolved but credentials are unavailable."
				: "No GitHub credentials are usable by the extension host.",
		observedAt: new Date().toISOString(),
	};
}
