import { describe, expect, it } from "vitest";
import { GitHubObservationService } from "../github/githubObservationService";

describe("GitHubObservationService invalidation", () => {
	it("does not let an in-flight pre-invalidation response repopulate the cache", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const open = { status: "open" as const };
		const merged = { status: "merged" as const };
		const inspector = {
			observeRepositoryFacts: async () => ({
				repository: {
					status: "known" as const,
					identity: {
						owner: "owner",
						repo: "repo",
						remoteName: "origin",
						remoteUrl: "https://github.com/owner/repo.git",
						urlKind: "https" as const,
					},
				},
				auth: { state: "authenticated" as const, source: "env" as const, token: "test" },
			}),
			observe: async () => {
				const call = ++calls;
				if (call === 1) await firstGate;
				return (call === 1 ? open : merged) as never;
			},
		};
		const service = new GitHubObservationService({
			createInspector: () => inspector as never,
		});
		const request = { repoRoot: "/repo", branch: "fix/check_ci" };

		const first = service.observe(request);
		await Promise.resolve();
		service.invalidate();
		const second = await service.observe(request);
		releaseFirst();
		await first;
		const third = await service.observe(request);

		expect(second).toBe(merged);
		expect(third).toBe(merged);
		expect(calls).toBe(2);
	});
});
