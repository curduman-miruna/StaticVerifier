type EndpointInlineCompletion = {
	insertText: string;
	replacementStart: number;
};

const HTTP_METHODS = 'get|post|put|patch|delete|head|options';
const HTTP_CALL_PATH_PATTERN = new RegExp(
	[
		'(?:',
		'(?:\\b(?:fetch|fetchJson)\\s*\\(\\s*)',
		`|(?:\\b[\\w$]+\\s*\\.\\s*(?:${HTTP_METHODS})\\s*\\(\\s*)`,
		')([\'"`])([^\'"`]*)$'
	].join(''),
	'i'
);

export function buildEndpointInlineCompletions(
	linePrefix: string,
	endpointPaths: string[],
	limit: number
): EndpointInlineCompletion[] {
	const match = linePrefix.match(HTTP_CALL_PATH_PATTERN);
	if (!match || match.index === undefined) {
		return [];
	}

	const quote = match[1] ?? '';
	const fragment = match[2] ?? '';
	const replacementStart = match.index + match[0].lastIndexOf(quote) + quote.length;
	if (fragment.length > 0 && !fragment.startsWith('/')) {
		return [];
	}

	const uniquePaths = Array.from(new Set(endpointPaths))
		.filter((path) => path.startsWith(fragment) && path !== fragment)
		.sort((a, b) => a.length - b.length || a.localeCompare(b));

	return uniquePaths.slice(0, limit).map((path) => ({
		insertText: path,
		replacementStart
	}));
}
