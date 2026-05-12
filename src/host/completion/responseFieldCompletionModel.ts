import { normalizeEndpointPath } from '../verification/endpointNormalization';

export type ResponseField = {
	name: string;
	type: string;
};

export type ResponseSchemaIndex = Map<string, ResponseField[]>;
export type ApiCompletionIndex = {
	responseSchemas: ResponseSchemaIndex;
	requestSchemas: ResponseSchemaIndex;
	requestHeaders: Map<string, string[]>;
};

export type ResponseFieldCompletion = ResponseField & {
	replacementStart: number;
	replacementEnd: number;
	kind?: 'field' | 'header';
};

const HTTP_METHODS = 'get|post|put|patch|delete|head|options';
const DIRECT_RESPONSE_PATTERN = new RegExp(
	`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:fetchJson|[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:${HTTP_METHODS}))\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`,
	'gi'
);
const FETCH_RESPONSE_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?fetch\s*\(\s*(['"`])([^'"`]+)\2/gi;
const JSON_RESPONSE_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\.json\s*\(/gi;
const ALIAS_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g;
const FUNCTION_ENDPOINT_PATTERN = new RegExp(
	`\\b(?:async\\s+function\\s+|function\\s+)([A-Za-z_$][\\w$]*)[\\s\\S]*?\\b(?:fetchJson|[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:${HTTP_METHODS}))\\s*\\(\\s*(['"\`])([^'"\`]+)\\2[\\s\\S]*?}`,
	'g'
);
const ARROW_FUNCTION_ENDPOINT_PATTERN = new RegExp(
	`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>[\\s\\S]*?\\b(?:fetchJson|[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:${HTTP_METHODS}))\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`,
	'g'
);
const FUNCTION_CALL_RESPONSE_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
const REACT_QUERY_DATA_PATTERN = new RegExp(
	`\\b(?:const|let|var)\\s*{[^}]*\\bdata\\s*:\\s*([A-Za-z_$][\\w$]*)[^}]*}\\s*=\\s*use(?:Query|InfiniteQuery)\\s*\\([\\s\\S]*?\\b(?:fetchJson|[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:${HTTP_METHODS}))\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`,
	'g'
);
const IDENTIFIER = '[A-Za-z_$][\\w$]*';

export function buildResponseFieldCompletions(
	textBeforePosition: string,
	lineText: string,
	positionCharacter: number,
	schemas: ResponseSchemaIndex
): ResponseFieldCompletion[] {
	return buildApiCompletions(textBeforePosition, lineText, positionCharacter, {
		responseSchemas: schemas,
		requestSchemas: new Map(),
		requestHeaders: new Map()
	}).filter((completion) => completion.kind !== 'header');
}

export function buildApiCompletions(
	textBeforePosition: string,
	lineText: string,
	positionCharacter: number,
	index: ApiCompletionIndex
): ResponseFieldCompletion[] {
	const memberAccess = getMemberAccessContext(lineText.slice(0, positionCharacter), positionCharacter);
	if (memberAccess) {
		const endpointPath = inferResponseVariablePaths(textBeforePosition).get(memberAccess.root);
		return endpointPath ? fieldsForPath(index.responseSchemas, endpointPath, memberAccess.fieldPrefix, memberAccess.replacementStart, positionCharacter) : [];
	}

	const destructure = getDestructureContext(lineText, positionCharacter);
	if (destructure) {
		const endpointPath = inferResponseVariablePaths(textBeforePosition).get(destructure.variable);
		return endpointPath ? fieldsForPath(index.responseSchemas, endpointPath, undefined, destructure.replacementStart, positionCharacter, true) : [];
	}

	const headerContext = getHeaderObjectContext(textBeforePosition, lineText, positionCharacter);
	if (headerContext) {
		return headersForPath(index.requestHeaders, headerContext.path, headerContext.replacementStart, positionCharacter);
	}

	const requestContext = getRequestBodyContext(textBeforePosition, lineText, positionCharacter);
	if (requestContext) {
		return fieldsForPath(index.requestSchemas, requestContext.path, undefined, requestContext.replacementStart, positionCharacter, true);
	}

	return [];
}

export function fieldsFromSchema(schema: string | undefined): ResponseField[] {
	if (!schema?.trim().startsWith('{')) {
		return [];
	}
	try {
		const parsed = JSON.parse(schema) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return [];
		}
		return Object.entries(parsed as Record<string, unknown>)
			.map(([name, value]) => ({ name, type: typeof value === 'string' ? value : inferValueType(value) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

function inferResponseVariablePaths(text: string): Map<string, string> {
	const fetchVariables = new Map<string, string>();
	const responseVariables = new Map<string, string>();
	const functionReturns = new Map<string, string>();

	for (const match of text.matchAll(DIRECT_RESPONSE_PATTERN)) {
		const path = normalizeEndpointPath(match[3] ?? '');
		if (path) {
			responseVariables.set(match[1] ?? '', path);
		}
	}
	for (const match of text.matchAll(FETCH_RESPONSE_PATTERN)) {
		const path = normalizeEndpointPath(match[3] ?? '');
		if (path) {
			fetchVariables.set(match[1] ?? '', path);
		}
	}
	for (const match of text.matchAll(JSON_RESPONSE_PATTERN)) {
		const path = fetchVariables.get(match[2] ?? '');
		if (path) {
			responseVariables.set(match[1] ?? '', path);
		}
	}
	for (const match of text.matchAll(FUNCTION_ENDPOINT_PATTERN)) {
		const path = normalizeEndpointPath(match[3] ?? '');
		if (path) {
			functionReturns.set(match[1] ?? '', path);
		}
	}
	for (const match of text.matchAll(ARROW_FUNCTION_ENDPOINT_PATTERN)) {
		const path = normalizeEndpointPath(match[3] ?? '');
		if (path) {
			functionReturns.set(match[1] ?? '', path);
		}
	}
	for (const match of text.matchAll(FUNCTION_CALL_RESPONSE_PATTERN)) {
		const path = functionReturns.get(match[2] ?? '');
		if (path) {
			responseVariables.set(match[1] ?? '', path);
		}
	}
	for (const match of text.matchAll(REACT_QUERY_DATA_PATTERN)) {
		const path = normalizeEndpointPath(match[3] ?? '');
		if (path) {
			responseVariables.set(match[1] ?? '', path);
		}
	}
	for (let pass = 0; pass < 3; pass += 1) {
		for (const match of text.matchAll(ALIAS_PATTERN)) {
			const path = responseVariables.get(match[2] ?? '');
			if (path) {
				responseVariables.set(match[1] ?? '', path);
			}
		}
	}

	return responseVariables;
}

function getMemberAccessContext(
	linePrefix: string,
	positionCharacter: number
): { root: string; fieldPrefix?: string; replacementStart: number } | undefined {
	const match = linePrefix.match(new RegExp(`(${IDENTIFIER}(?:\\.${IDENTIFIER})*)\\.(${IDENTIFIER})?$`));
	if (!match || match.index === undefined) {
		return undefined;
	}
	const expression = match[1] ?? '';
	const parts = expression.split('.');
	return {
		root: parts[0] ?? '',
		fieldPrefix: parts.length > 1 ? parts.slice(1).join('.') : undefined,
		replacementStart: positionCharacter - (match[2]?.length ?? 0)
	};
}

function getDestructureContext(
	lineText: string,
	positionCharacter: number
): { variable: string; replacementStart: number } | undefined {
	const before = lineText.slice(0, positionCharacter);
	const after = lineText.slice(positionCharacter);
	const left = before.match(/\{[^{}]*([A-Za-z_$][\w$]*)?$/);
	const right = after.match(new RegExp(`^[^{}]*}\\s*=\\s*(${IDENTIFIER})\\b`));
	if (!left || !right) {
		return undefined;
	}
	return {
		variable: right[1] ?? '',
		replacementStart: positionCharacter - (left[1]?.length ?? 0)
	};
}

function fieldsForPath(
	schemas: ResponseSchemaIndex,
	path: string,
	fieldPrefix: string | undefined,
	replacementStart: number,
	replacementEnd: number,
	topLevelOnly = false
): ResponseFieldCompletion[] {
	const fields = schemas.get(path) ?? [];
	const prefix = fieldPrefix ? `${fieldPrefix}.` : '';
	return fields
		.filter((field) => {
			if (topLevelOnly && field.name.includes('.')) {
				return false;
			}
			if (!prefix) {
				return !field.name.includes('.');
			}
			const remainder = field.name.slice(prefix.length);
			return field.name.startsWith(prefix) && remainder.length > 0 && !remainder.includes('.');
		})
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((field) => ({
			name: prefix ? field.name.slice(prefix.length) : field.name,
			type: field.type,
			replacementStart,
			replacementEnd,
			kind: 'field' as const
		}));
}

function getRequestBodyContext(
	textBeforePosition: string,
	lineText: string,
	positionCharacter: number
): { path: string; replacementStart: number } | undefined {
	const windowText = textBeforePosition.slice(-2500);
	if (isInsideHeadersObject(windowText)) {
		return undefined;
	}
	const path = findLastRequestEndpointPath(windowText);
	if (!path || !isInsideObjectLiteral(lineText, positionCharacter, windowText)) {
		return undefined;
	}
	return {
		path,
		replacementStart: findIdentifierStart(lineText, positionCharacter)
	};
}

function getHeaderObjectContext(
	textBeforePosition: string,
	lineText: string,
	positionCharacter: number
): { path: string; replacementStart: number } | undefined {
	const windowText = textBeforePosition.slice(-2500);
	if (!isInsideHeadersObject(windowText)) {
		return undefined;
	}
	const path = findLastEndpointPath(windowText);
	if (!path) {
		return undefined;
	}
	return {
		path,
		replacementStart: findHeaderKeyStart(lineText, positionCharacter)
	};
}

function headersForPath(
	headersByPath: Map<string, string[]>,
	path: string,
	replacementStart: number,
	replacementEnd: number
): ResponseFieldCompletion[] {
	return (headersByPath.get(path) ?? [])
		.map((name) => ({ name, type: 'header', replacementStart, replacementEnd, kind: 'header' as const }));
}

function findLastRequestEndpointPath(text: string): string | undefined {
	const methodClient = Array.from(text.matchAll(/\b[\w$]+\s*\.\s*(?:post|put|patch)\s*\(\s*(['"`])([^'"`]+)\1/gi)).at(-1);
	const fetchCall = Array.from(text.matchAll(/\bfetch(?:Json)?\s*\(\s*(['"`])([^'"`]+)\1[\s\S]*?\bmethod\s*:\s*(['"`])(?:POST|PUT|PATCH)\3/gi)).at(-1);
	return normalizeEndpointPath(methodClient?.[2] ?? fetchCall?.[2] ?? '');
}

function findLastEndpointPath(text: string): string | undefined {
	const matches = Array.from(text.matchAll(/\b(?:fetch|fetchJson|[\w$]+\s*\.\s*(?:get|post|put|patch|delete|head|options))\s*\(\s*(['"`])([^'"`]+)\1/gi));
	return normalizeEndpointPath(matches.at(-1)?.[2] ?? '');
}

function isInsideHeadersObject(text: string): boolean {
	const headerIndex = Math.max(text.lastIndexOf('headers'), text.lastIndexOf('Headers'));
	if (headerIndex === -1) {
		return false;
	}
	const after = text.slice(headerIndex);
	const open = after.lastIndexOf('{');
	const close = after.lastIndexOf('}');
	return open !== -1 && open > close;
}

function isInsideObjectLiteral(lineText: string, positionCharacter: number, windowText: string): boolean {
	const linePrefix = lineText.slice(0, positionCharacter);
	if (linePrefix.includes('{')) {
		return true;
	}
	const open = windowText.lastIndexOf('{');
	const close = windowText.lastIndexOf('}');
	return open !== -1 && open > close;
}

function findIdentifierStart(lineText: string, positionCharacter: number): number {
	const prefix = lineText.slice(0, positionCharacter);
	const match = prefix.match(/[A-Za-z_$][\w$]*$/);
	return match ? positionCharacter - match[0].length : positionCharacter;
}

function findHeaderKeyStart(lineText: string, positionCharacter: number): number {
	const prefix = lineText.slice(0, positionCharacter);
	const quoted = prefix.match(/(['"`])[^'"`]*$/);
	if (quoted?.index !== undefined) {
		return quoted.index + 1;
	}
	return findIdentifierStart(lineText, positionCharacter);
}

function inferValueType(value: unknown): string {
	if (Array.isArray(value)) {
		return value.length > 0 ? `${inferValueType(value[0])}[]` : 'unknown[]';
	}
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'object') {
		return 'object';
	}
	return typeof value;
}
