import type { EndpointContract } from './internalTypes';

type FunctionBlock = {
	start: number;
	end: number;
	returnType?: string;
};

export type FrontendDiscoveryMethodClient = {
	client: string;
	methods: string[];
};

export type FrontendDiscoveryOptions = {
	fetchFunctions?: string[];
	methodClients?: FrontendDiscoveryMethodClient[];
};

const DEFAULT_FETCH_FUNCTIONS = ['fetch', 'fetchJson'];
const DEFAULT_METHOD_CLIENTS: FrontendDiscoveryMethodClient[] = [
	{ client: 'axios', methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
	{ client: 'api', methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
	{ client: 'client', methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
	{ client: 'http', methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] },
	{ client: 'ky', methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] }
];

export function extractFrontendEndpointsFromCode(
	text: string,
	options?: FrontendDiscoveryOptions
): EndpointContract[] {
	const endpoints: EndpointContract[] = [];
	const byKey = new Set<string>();
	const functionBlocks = findFunctionBlocks(text);
	const discovery = normalizeDiscoveryOptions(options);
	const fetchPattern = discovery.fetchFunctions.map(escapeRegex).join('|');
	const clientPattern = discovery.methodClients.map((item) => escapeRegex(item.client)).join('|');
	const allMethods = Array.from(
		new Set(discovery.methodClients.flatMap((item) => item.methods.map((method) => method.toLowerCase())))
	);
	const methodPattern = allMethods.map(escapeRegex).join('|');
	const methodMap = new Map(
		discovery.methodClients.map((item) => [item.client, new Set(item.methods.map((method) => method.toLowerCase()))] as const)
	);

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
			responseSchema,
			sourceLine: offsetToLineColumn(text, matchIndex).line,
			sourceColumn: offsetToLineColumn(text, matchIndex).column
		});
	};

	const fetchRegex = fetchPattern
		? new RegExp(`\\b(?:${fetchPattern})\\s*\\(\\s*(['"\`])([^'"\`]+)\\1\\s*(?:,\\s*({[\\s\\S]*?}))?\\s*\\)`, 'g')
		: undefined;
	let match: RegExpExecArray | null;
	while (fetchRegex && (match = fetchRegex.exec(text)) !== null) {
		const requestOptions = match[3] ?? '';
		const hintText = text.slice(match.index, Math.min(text.length, match.index + 280));
		const methodMatch = requestOptions.match(/method\s*:\s*(['"`])([A-Za-z]+)\1/);
		addEndpoint(methodMatch?.[2] ?? 'GET', match[2], match.index, hintText);
	}

	const methodClientRegex = clientPattern && methodPattern
		? new RegExp(`\\b(${clientPattern})\\.(${methodPattern})\\s*\\(\\s*(['"\`])([^'"\`]+)\\3`, 'g')
		: undefined;
	while (methodClientRegex && (match = methodClientRegex.exec(text)) !== null) {
		const clientName = match[1];
		const method = match[2].toLowerCase();
		const allowedMethods = methodMap.get(clientName);
		if (!allowedMethods || !allowedMethods.has(method)) {
			continue;
		}
		const hintText = text.slice(match.index, Math.min(text.length, match.index + 240));
		addEndpoint(method, match[4], match.index, hintText);
	}

	return endpoints;
}

function normalizeDiscoveryOptions(options?: FrontendDiscoveryOptions): {
	fetchFunctions: string[];
	methodClients: FrontendDiscoveryMethodClient[];
} {
	const fetchFunctions = (options?.fetchFunctions ?? DEFAULT_FETCH_FUNCTIONS)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	const methodClients = (options?.methodClients ?? DEFAULT_METHOD_CLIENTS)
		.map((item) => ({
			client: item.client.trim(),
			methods: item.methods.map((method) => method.trim()).filter((method) => method.length > 0)
		}))
		.filter((item) => item.client.length > 0 && item.methods.length > 0);
	return {
		fetchFunctions,
		methodClients
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
