type ParsedGitHubLink =
	| { kind: 'repo'; owner: string; repo: string }
	| { kind: 'tree'; owner: string; repo: string; branch: string; subpath: string }
	| { kind: 'blob'; owner: string; repo: string; branch: string; filepath: string }
	| { kind: 'raw'; owner: string; repo: string; branch: string; filepath: string };

export function normalizeGitHubRawUrl(url: string): string {
	const blobPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
	const match = url.match(blobPattern);
	if (!match) {
		return url;
	}
	const [, owner, repo, branch, filePath] = match;
	return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
}

export async function countGitHubFiles(url: string): Promise<number> {
	const parsed = parseGitHubLink(url);
	if (!parsed) {
		return 0;
	}
	if (parsed.kind === 'blob' || parsed.kind === 'raw') {
		return 1;
	}

	const owner = parsed.owner;
	const repo = parsed.repo;
	const branch = parsed.kind === 'tree' ? parsed.branch : await fetchDefaultBranch(owner, repo);
	if (!branch) {
		return 0;
	}

	const treeResponse = await fetchGitHubJson<{ tree?: Array<{ path: string; type: string }> }>(
		`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
	);
	if (!treeResponse?.tree || treeResponse.tree.length === 0) {
		return 0;
	}
	const prefix = parsed.kind === 'tree' ? parsed.subpath.replace(/^\/+|\/+$/g, '') : '';
	const normalizedPrefix = prefix ? `${prefix}/` : '';
	return treeResponse.tree.filter((entry) => entry.type === 'blob'
		&& (!normalizedPrefix || entry.path === prefix || entry.path.startsWith(normalizedPrefix))).length;
}

function parseGitHubLink(rawUrl: string): ParsedGitHubLink | undefined {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		return undefined;
	}
	const host = parsedUrl.hostname.toLowerCase();
	const segments = parsedUrl.pathname.split('/').filter(Boolean);
	if (segments.length < 2) {
		return undefined;
	}
	if (host === 'github.com') {
		const owner = segments[0];
		const repo = segments[1].replace(/\.git$/i, '');
		if (segments.length === 2) {
			return { kind: 'repo', owner, repo };
		}
		if (segments[2] === 'tree' && segments.length >= 4) {
			return { kind: 'tree', owner, repo, branch: segments[3], subpath: segments.slice(4).join('/') };
		}
		if (segments[2] === 'blob' && segments.length >= 5) {
			return { kind: 'blob', owner, repo, branch: segments[3], filepath: segments.slice(4).join('/') };
		}
		return { kind: 'repo', owner, repo };
	}
	if (host === 'raw.githubusercontent.com' && segments.length >= 4) {
		return {
			kind: 'raw',
			owner: segments[0],
			repo: segments[1],
			branch: segments[2],
			filepath: segments.slice(3).join('/')
		};
	}
	return undefined;
}

async function fetchDefaultBranch(owner: string, repo: string): Promise<string | undefined> {
	return (await fetchGitHubJson<{ default_branch?: string }>(`https://api.github.com/repos/${owner}/${repo}`))?.default_branch;
}

async function fetchGitHubJson<T>(url: string): Promise<T | undefined> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'staticverifier' }
		});
	} catch {
		return undefined;
	}
	if (!response.ok) {
		return undefined;
	}
	try {
		return await response.json() as T;
	} catch {
		return undefined;
	}
}
