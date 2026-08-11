export type PullRequestState = "open" | "closed" | "merged";

/**
 * Observed proof about one pull request. The core fields come from the GitHub
 * REST `/pulls` list; `mergeability` and `checks` are intentionally NOT filled
 * by the current backend (they would require one extra call per pull request)
 * and are reserved here so a later backend can populate them without reshaping
 * the model. An absence of those fields must never be rendered as a PASS.
 */
export interface PullRequestObservation {
	readonly number: number;
	readonly url: string;
	readonly state: PullRequestState;
	readonly draft: boolean;

	readonly headRef: string;
	readonly headSha: string;

	readonly baseRef: string;

	readonly title?: string;
	readonly mergedAt?: string;
	readonly mergeCommitSha?: string;

	readonly mergeability?: PullRequestMergeability;
	readonly checks?: PullRequestChecks;
}

export interface PullRequestMergeability {
	readonly mergeable: boolean | null;
	readonly mergeableState: string | null;
}

export interface PullRequestChecks {
	readonly state: string | null;
	readonly totalCount: number | null;
	readonly successCount: number | null;
	readonly failureCount: number | null;
}

/**
 * Deterministic selection among PR candidates for one feature branch. Multiple
 * candidates are legitimate state (an old closed PR plus a fresh open PR, or
 * several historical merges), so selection never guesses when no explicit rule
 * applies — it reports ambiguity instead of silently picking a PR.
 */
export type PullRequestResolution =
	| {
			readonly outcome: "no_pr";
			readonly observedHeadSha: string;
	  }
	| {
			readonly outcome: "selected";
			readonly pull: PullRequestObservation;
			readonly observedHeadSha: string;
			readonly open: boolean;
			readonly matches: {
				/** PR head SHA equals the locally observed feature head. */
				readonly headSha: boolean;
				/** PR base ref equals Agent Space's expected base (true when unverifiable). */
				readonly baseRef: boolean;
			};
	  }
	| {
			readonly outcome: "ambiguous";
			readonly observedHeadSha: string;
			readonly candidates: readonly PullRequestObservation[];
	  };

/**
 * Select a PR candidate from observed pull requests.
 *
 * Rules, in order:
 * - exactly one open PR → selected (an open PR targeting this head is the
 *   strongest, most actionable signal);
 * - several open PRs → the one whose head SHA matches the observed head, or
 *   `ambiguous` when more than one still qualifies;
 * - no open PR → a single merged PR, or the merged PR whose head matches the
 *   observed head, or `ambiguous` when several merges remain;
 * - otherwise a single closed PR, or the closed PR whose head matches, or
 *   `ambiguous`.
 */
export function resolvePullRequest(
	pulls: readonly PullRequestObservation[],
	observedHeadSha: string,
	expectedBaseRef?: string,
): PullRequestResolution {
	if (pulls.length === 0) {
		return { outcome: "no_pr", observedHeadSha };
	}

	const open = pulls.filter((pull) => pull.state === "open");
	if (open.length === 1) {
		return select(open[0], observedHeadSha, expectedBaseRef);
	}
	if (open.length > 1) {
		const openMatched = open.filter((pull) =>
			sameSha(pull.headSha, observedHeadSha),
		);
		if (openMatched.length === 1) {
			return select(openMatched[0], observedHeadSha, expectedBaseRef);
		}
		return { outcome: "ambiguous", observedHeadSha, candidates: open };
	}

	const merged = pulls.filter((pull) => pull.state === "merged");
	if (merged.length === 1) {
		return select(merged[0], observedHeadSha, expectedBaseRef);
	}
	if (merged.length > 1) {
		const mergedMatched = merged.filter((pull) =>
			sameSha(pull.headSha, observedHeadSha),
		);
		if (mergedMatched.length === 1) {
			return select(mergedMatched[0], observedHeadSha, expectedBaseRef);
		}
		return { outcome: "ambiguous", observedHeadSha, candidates: merged };
	}

	if (pulls.length === 1) {
		return select(pulls[0], observedHeadSha, expectedBaseRef);
	}
	const closedMatched = pulls.filter((pull) =>
		sameSha(pull.headSha, observedHeadSha),
	);
	if (closedMatched.length === 1) {
		return select(closedMatched[0], observedHeadSha, expectedBaseRef);
	}
	return { outcome: "ambiguous", observedHeadSha, candidates: pulls };
}

function select(
	pull: PullRequestObservation,
	observedHeadSha: string,
	expectedBaseRef?: string,
): PullRequestResolution {
	return {
		outcome: "selected",
		pull,
		observedHeadSha,
		open: pull.state === "open",
		matches: {
			headSha: sameSha(pull.headSha, observedHeadSha),
			baseRef:
				expectedBaseRef === undefined || pull.baseRef === expectedBaseRef,
		},
	};
}

function sameSha(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}
