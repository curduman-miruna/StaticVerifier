import type { EndpointContract } from './internalTypes';

type FunctionBlock = {
	start: number;
	end: number;
	returnType?: string;
};

export function extractFrontendEndpointsFromCode(text: string): EndpointContract[] {
	const endpoints: EndpointContract[] = [];
	const byKey = new Set<string>();
	const functionBlocks = findFunctionBlocks(text);

	const addEndpoint = (method: string, pathValue: string, matchIndex: number, hintText: string): void => {
		const endpointPath = pathValue.trim();
		if (!endpointPath || !(endpointPath.startsWith('/') || endpointPath.startsWith('http://') || endpointPath.startsWith('https://'))) {
			return;
		}
		const normalizedMethod = method.toUpperCase();
		const block = findContainingFunctionBlock(matchIndex, functionBlocks);
		const castSchema = extractCastType(hintText);
		const returnSchema = normalizeTypeName(block?.returnType);
		const responseSchema = castSchema ?? returnSchema;
		const key = `${normalizedMethod} ${endpointPath} ${responseSchema ?? ''}`;
		if (byKey.has(key)) {
			return;
		}
		byKey.add(key);
		endpoints.push({
			method: normalizedMethod,
			path: endpointPath,
			responseSchema
		});
	};

	const fetchRegex = /\b(?:fetch|fetchJson)\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*({[\s\S]*?}))?\s*\)/g;
	let match: RegExpExecArray | null;
	while ((match = fetchRegex.exec(text)) !== null) {
		const options = match[3] ?? '';
		const hintText = text.slice(match.index, Math.min(text.length, match.index + 280));
		const methodMatch = options.match(/method\s*:\s*(['"`])([A-Za-z]+)\1/);
		addEndpoint(methodMatch?.[2] ?? 'GET', match[2], match.index, hintText);
	}

	const methodClientRegex = /\b(?:axios|api|client|http|ky)\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]+)\2/g;
	while ((match = methodClientRegex.exec(text)) !== null) {
		const hintText = text.slice(match.index, Math.min(text.length, match.index + 240));
		addEndpoint(match[1], match[3], match.index, hintText);
	}

	return endpoints;
}

function findFunctionBlocks(text: string): FunctionBlock[] {
	const blocks: FunctionBlock[] = [];
	const declarationRegex = /\b(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*Promise<([^>]+)>)?\s*\{/g;
	const arrowRegex = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*Promise<([^>]+)>)?\s*=>\s*\{/g;

	const pushBlock = (regex: RegExp): void => {
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			const openBraceIndex = text.indexOf('{', match.index);
			if (openBraceIndex === -1) {
				continue;
			}
			const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
			if (closeBraceIndex === -1) {
				continue;
			}
			blocks.push({
				start: openBraceIndex,
				end: closeBraceIndex,
				returnType: normalizeTypeName(match[1])
			});
		}
	};

	pushBlock(declarationRegex);
	pushBlock(arrowRegex);
	return blocks;
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

function findContainingFunctionBlock(index: number, blocks: FunctionBlock[]): FunctionBlock | undefined {
	return blocks.find((block) => index >= block.start && index <= block.end);
}

function extractCastType(text: string): string | undefined {
	const castMatch = text.match(/\bas\s+([A-Za-z_$][\w$<>\[\]\.|,\s]+)/);
	return normalizeTypeName(castMatch?.[1]);
}

function normalizeTypeName(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	const normalized = raw.replace(/\s+/g, ' ').trim().replace(/[),.;]+$/, '');
	if (!normalized || normalized === 'unknown' || normalized === 'any') {
		return undefined;
	}
	return normalized;
}
