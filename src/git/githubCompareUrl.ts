const GITHUB_HOST = "github.com";

export function buildGitHubCompareUrl(
	remoteUrl: string,
	baseBranch: string,
	headBranch: string,
): string | null {
	const repository = parseGitHubRemote(remoteUrl);
	if (!repository || !baseBranch || !headBranch) return null;

	const base = encodeRef(baseBranch);
	const head = encodeRef(headBranch);
	return `https://${GITHUB_HOST}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/compare/${base}...${head}?expand=1`;
}

export function buildGitHubPullRequestBaseMetadata(
	remoteUrl: string,
	baseBranch: string,
): string | null {
	const repository = parseGitHubRemote(remoteUrl);
	if (!repository || !baseBranch) return null;
	return `${repository.owner}#${repository.repo}#${baseBranch}`;
}

function parseGitHubRemote(
	remoteUrl: string,
): { owner: string; repo: string } | null {
	const trimmed = remoteUrl.trim();
	const scpMatch = trimmed.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
	);
	if (scpMatch) return { owner: scpMatch[1], repo: scpMatch[2] };

	try {
		const parsed = new URL(trimmed);
		if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null;
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length !== 2) return null;
		return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
	} catch {
		return null;
	}
}

function encodeRef(ref: string): string {
	return ref
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}
