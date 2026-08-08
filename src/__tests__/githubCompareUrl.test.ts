import { describe, expect, it } from "vitest";
import {
	buildGitHubCompareUrl,
	buildGitHubPullRequestBaseMetadata,
} from "../git/githubCompareUrl";

describe("buildGitHubCompareUrl", () => {
	it("builds an explicit base-to-head URL for an HTTPS remote", () => {
		expect(
			buildGitHubCompareUrl(
				"https://github.com/ShiidoTech/agent-space.git",
				"v2_ia_first",
				"feature/1066_closure",
			),
		).toBe(
			"https://github.com/ShiidoTech/agent-space/compare/v2_ia_first...feature/1066_closure?expand=1",
		);
	});

	it("supports SSH remotes and encodes ref segments", () => {
		expect(
			buildGitHubCompareUrl(
				"git@github.com:shiidotech-com/infinite-quiz_v2.git",
				"release candidate",
				"feature/1066 closure",
			),
		).toBe(
			"https://github.com/shiidotech-com/infinite-quiz_v2/compare/release%20candidate...feature/1066%20closure?expand=1",
		);
	});

	it("returns null for a non-GitHub or malformed remote", () => {
		expect(
			buildGitHubCompareUrl(
				"https://gitlab.example.com/team/project.git",
				"develop",
				"feature/x",
			),
		).toBeNull();
	});
});

describe("buildGitHubPullRequestBaseMetadata", () => {
	it("uses the GitHub PR extension metadata format", () => {
		expect(
			buildGitHubPullRequestBaseMetadata(
				"git@github.com:ShiidoTech/agent-space.git",
				"v2_ia_first",
			),
		).toBe("ShiidoTech#agent-space#v2_ia_first");
	});

	it("returns null for a non-GitHub or incomplete base", () => {
		expect(
			buildGitHubPullRequestBaseMetadata(
				"https://gitlab.example.com/team/project.git",
				"main",
			),
		).toBeNull();
		expect(
			buildGitHubPullRequestBaseMetadata(
				"https://github.com/team/project.git",
				"",
			),
		).toBeNull();
	});
});
