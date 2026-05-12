export function findMissingRequiredHeaders(
	frontendHeaders: string[] | undefined,
	backendHeaders: string[] | undefined
): string[] {
	const frontend = new Set((frontendHeaders ?? []).map(normalizeHeaderName));
	return (backendHeaders ?? [])
		.filter((header) => !frontend.has(normalizeHeaderName(header)))
		.sort((a, b) => a.localeCompare(b));
}

function normalizeHeaderName(header: string): string {
	return header.trim().toLowerCase();
}
