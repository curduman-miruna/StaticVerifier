import type { EndpointContract } from './internalTypes';

type RouteMatch = {
	method: string;
	path: string;
	index: number;
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const METHOD_DECORATORS = new Map([
	['Get', 'GET'],
	['Post', 'POST'],
	['Put', 'PUT'],
	['Patch', 'PATCH'],
	['Delete', 'DELETE'],
	['Head', 'HEAD'],
	['Options', 'OPTIONS'],
	['GetMapping', 'GET'],
	['PostMapping', 'POST'],
	['PutMapping', 'PUT'],
	['PatchMapping', 'PATCH'],
	['DeleteMapping', 'DELETE']
]);

export function extractBackendEndpointsFromCode(text: string): EndpointContract[] {
	const endpoints: EndpointContract[] = [];
	const byKey = new Set<string>();

	const addEndpoint = (match: RouteMatch): void => {
		const endpointPath = normalizeEndpointPath(match.path);
		if (!endpointPath) {
			return;
		}
		const method = match.method.toUpperCase();
		const key = `${method} ${endpointPath}`;
		if (byKey.has(key)) {
			return;
		}
		byKey.add(key);
		const location = offsetToLineColumn(text, match.index);
		endpoints.push({
			method,
			path: endpointPath,
			responseSchema: inferResponseSchema(text, match.index),
			sourceLine: location.line,
			sourceColumn: location.column
		});
	};

	for (const match of extractExpressStyleRoutes(text)) {
		addEndpoint(match);
	}
	for (const match of extractObjectStyleRoutes(text)) {
		addEndpoint(match);
	}
	for (const match of extractDecoratorRoutes(text)) {
		addEndpoint(match);
	}

	return endpoints;
}

function extractExpressStyleRoutes(text: string): RouteMatch[] {
	const matches: RouteMatch[] = [];
	const methods = HTTP_METHODS.map(escapeRegex).join('|');
	const routeRegex = new RegExp(`\\b(?:app|router|server|fastify)\\.(${methods})\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`, 'gi');
	let match: RegExpExecArray | null;
	while ((match = routeRegex.exec(text)) !== null) {
		matches.push({
			method: match[1],
			path: match[3],
			index: match.index
		});
	}
	return matches;
}

function extractObjectStyleRoutes(text: string): RouteMatch[] {
	const matches: RouteMatch[] = [];
	const routeObjectRegex = /\b(?:app|server|fastify)\.route\s*\(\s*\{[\s\S]*?\}\s*\)/g;
	let match: RegExpExecArray | null;
	while ((match = routeObjectRegex.exec(text)) !== null) {
		const block = match[0];
		const methodMatch = block.match(/\bmethod\s*:\s*(?:\[\s*)?(['"`])([A-Za-z]+)\1/);
		const pathMatch = block.match(/\b(?:url|path)\s*:\s*(['"`])([^'"`]+)\1/);
		if (!methodMatch || !pathMatch) {
			continue;
		}
		matches.push({
			method: methodMatch[2],
			path: pathMatch[2],
			index: match.index + (pathMatch.index ?? 0)
		});
	}
	return matches;
}

function extractDecoratorRoutes(text: string): RouteMatch[] {
	const matches: RouteMatch[] = [];
	const classBlocks = findClassBlocks(text);
	for (const block of classBlocks) {
		const classPrefix = extractControllerPrefix(text.slice(Math.max(0, block.start - 500), block.start));
		const classText = text.slice(block.start, block.end + 1);
		const decoratorRegex = /@([A-Za-z]+Mapping|Get|Post|Put|Patch|Delete|Head|Options)\s*(?:\(\s*(?:(['"`])([^'"`]*)\2|[^)]*)\s*\))?/g;
		let match: RegExpExecArray | null;
		while ((match = decoratorRegex.exec(classText)) !== null) {
			const method = METHOD_DECORATORS.get(match[1]);
			if (!method) {
				continue;
			}
			const routePath = match[3] ?? '';
			matches.push({
				method,
				path: joinPaths(classPrefix, routePath),
				index: block.start + match.index
			});
		}
	}
	return matches;
}

function extractControllerPrefix(textBeforeClass: string): string {
	const decorators = Array.from(textBeforeClass.matchAll(/@(Controller|RequestMapping)\s*(?:\(\s*(?:(['"`])([^'"`]*)\2|[^)]*)\s*\))?/g));
	const last = decorators[decorators.length - 1];
	return last?.[3] ?? '';
}

function findClassBlocks(text: string): Array<{ start: number; end: number }> {
	const blocks: Array<{ start: number; end: number }> = [];
	const classRegex = /\bclass\s+[A-Za-z_$][\w$]*[^{]*\{/g;
	let match: RegExpExecArray | null;
	while ((match = classRegex.exec(text)) !== null) {
		const openBraceIndex = text.indexOf('{', match.index);
		if (openBraceIndex === -1) {
			continue;
		}
		const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
		if (closeBraceIndex === -1) {
			continue;
		}
		blocks.push({ start: openBraceIndex, end: closeBraceIndex });
	}
	return blocks;
}

function inferResponseSchema(text: string, routeIndex: number): string | undefined {
	const hint = text.slice(routeIndex, Math.min(text.length, routeIndex + 600));
	const genericMatch = hint.match(/\b(?:Promise|Observable)<\s*([A-Za-z_$][\w$.[\]<>|,\s]*)\s*>/);
	const annotationMatch = hint.match(/\)\s*:\s*([A-Za-z_$][\w$.[\]<>|,\s]*)\s*(?:=>|\{)/);
	return normalizeTypeName(genericMatch?.[1] ?? annotationMatch?.[1]);
}

function normalizeEndpointPath(rawPath: string): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return '/';
	}
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		try {
			return normalizePathToken(new URL(trimmed).pathname);
		} catch {
			return undefined;
		}
	}
	return normalizePathToken(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
}

function normalizePathToken(path: string): string | undefined {
	const noQuery = path.split(/[?#]/)[0];
	const collapsed = noQuery.replace(/\/+/g, '/').trim();
	if (!collapsed.startsWith('/')) {
		return undefined;
	}
	return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

function joinPaths(prefix: string, routePath: string): string {
	return `${normalizeEndpointPath(prefix) ?? ''}/${routePath}`.replace(/\/+/g, '/');
}

function findMatchingBrace(text: string, openBraceIndex: number): number {
	let depth = 0;
	for (let index = openBraceIndex; index < text.length; index += 1) {
		const char = text[index];
		if (char === '{') {
			depth += 1;
			continue;
		}
		if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
	const safeOffset = Math.max(0, Math.min(offset, text.length));
	const before = text.slice(0, safeOffset);
	const lines = before.split(/\r?\n/);
	return {
		line: Math.max(1, lines.length),
		column: (lines[lines.length - 1]?.length ?? 0) + 1
	};
}

function normalizeTypeName(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	const normalized = raw.replace(/\s+/g, ' ').trim().replace(/[),.;{]+$/, '');
	if (!normalized || normalized === 'unknown' || normalized === 'any' || normalized === 'void') {
		return undefined;
	}
	return normalized;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
