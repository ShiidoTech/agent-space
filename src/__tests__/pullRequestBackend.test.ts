import { describe, expect, it } from "vitest";
import {
	type PullRequestApiRecord,
	toPullRequestObservation,
} from "../github/pullRequestBackend";

function record(
	overrides: Partial<PullRequestApiRecord> = {},
): PullRequestApiRecord {
	return {
		number: 1187,
		html_url: "https://github.com/shiidotech-com/infinite-quiz_v2/pull/1187",
		state: "closed",
		draft: false,
		head: {
			ref: "feature/pnpm_update",
			sha: "a9d16ad844eaa9bcd14d5e67666121005dc2e316",
		},
		base: { ref: "v2_ia_first" },
		...overrides,
	};
}

describe("toPullRequestObservation", () => {
	it("recognizes a merged pull from merged_at when the list endpoint omits merged", () => {
		expect(
			toPullRequestObservation(
				record({
					merged_at: "2026-08-12T09:58:09Z",
					merge_commit_sha: "71a4d1285a7dbc15d8c7a9a9be1d8a3bb67ac239",
				}),
			),
		).toMatchObject({
			number: 1187,
			state: "merged",
			mergedAt: "2026-08-12T09:58:09Z",
			mergeCommitSha: "71a4d1285a7dbc15d8c7a9a9be1d8a3bb67ac239",
		});
	});

	it("keeps a closed pull closed without positive merge evidence", () => {
		expect(
			toPullRequestObservation(record({ merged: false, merged_at: null }))
				.state,
		).toBe("closed");
	});

	it("keeps an open pull open even if an inconsistent payload has merged_at", () => {
		expect(
			toPullRequestObservation(
				record({ state: "open", merged_at: "2026-08-12T09:58:09Z" }),
			).state,
		).toBe("open");
	});
});
