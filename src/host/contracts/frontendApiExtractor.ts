import ts from 'typescript';
import type { SchemaFieldSourceLocation } from '../../shared/messages';
import type { EndpointContract } from './internalTypes';

type FunctionContext = {
	start: number;
	end: number;
	returnType?: string;
	returnTypeName?: string;
};

type DiscoveryOptions = {
	fetchFunctions: Set<string>;
	methodClients: Map<string, Set<string>>;
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

const METHODS_WITH_BODY = new Set(['post', 'put', 'patch']);

export function extractFrontendEndpointsFromCode(
	text: string,
	options?: FrontendDiscoveryOptions
): EndpointContract[] {
	const sourceFile = ts.createSourceFile('frontend-source.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const discovery = normalizeDiscoveryOptions(options);
	const constants = collectStringConstants(sourceFile);
	const typeHints = collectTypeHints(sourceFile);
	const typeSchemas = collectTypeSchemas(sourceFile);
	const typeFieldLocations = collectTypeFieldLocations(sourceFile);
	const valueSchemas = collectValueSchemas(sourceFile, typeHints, typeSchemas);
	const headerObjects = collectHeaderObjects(sourceFile);
	const clientAuthHeaders = collectClientAuthHeaders(sourceFile);
	const functionContexts: FunctionContext[] = [];
	const endpoints: EndpointContract[] = [];
	const byKey = new Set<string>();

	const addEndpoint = (
		method: string,
		pathValue: string | undefined,
		call: ts.CallExpression | ts.NewExpression,
		requestSchema?: string,
		responseSchema?: string,
		requestHeaders?: string[]
	): void => {
		if (!pathValue) {
			return;
		}
		const endpointPath = pathValue.trim();
		if (!endpointPath || !(endpointPath.startsWith('/') || endpointPath.startsWith('http://') || endpointPath.startsWith('https://'))) {
			return;
		}

		const normalizedMethod = method.toUpperCase();
		const responseTypeName = normalizeTypeName(responseSchema) ?? inferResponseTypeName(call, functionContexts);
		const requestTypeName = normalizeTypeName(requestSchema);
		const resolvedResponse = resolveSchemaString(responseTypeName, typeSchemas);
		const inferredResponse = inferResponseSchema(call, functionContexts, sourceFile, typeHints);
		const response = resolvedResponse && resolvedResponse !== responseTypeName
			? resolvedResponse
			: inferredResponse ?? resolvedResponse;
		const request = resolveSchemaString(requestTypeName, typeSchemas);
		const key = `${normalizedMethod} ${endpointPath} ${request ?? ''} ${response ?? ''}`;
		if (byKey.has(key)) {
			return;
		}
		byKey.add(key);

		const location = offsetToLineColumn(text, call.getStart(sourceFile));
		const endpoint: EndpointContract = {
			method: normalizedMethod,
			path: endpointPath,
			responseSchema: response,
			sourceLine: location.line,
			sourceColumn: location.column
		};
		if (request) {
			endpoint.requestSchema = request;
		}
		const headers = normalizeHeaderList(requestHeaders);
		if (headers.length > 0) {
			endpoint.requestHeaders = headers;
		}
		const fieldLocations = collectEndpointFieldLocations(call, request, response, sourceFile, typeFieldLocations, requestTypeName, responseTypeName);
		if (fieldLocations.length > 0) {
			endpoint.fieldLocations = fieldLocations;
		}
		endpoints.push(endpoint);
	};

	const visit = (node: ts.Node): void => {
		if (isFunctionLikeWithBody(node)) {
			functionContexts.push({
				start: node.getStart(sourceFile),
				end: node.end,
				returnType: extractReturnType(node, typeSchemas),
				returnTypeName: extractReturnTypeName(node)
			});
		}

		if (ts.isCallExpression(node)) {
			const fetchEndpoint = readFetchCall(node, discovery, constants, typeHints, typeSchemas, valueSchemas, headerObjects, clientAuthHeaders);
			if (fetchEndpoint) {
				addEndpoint(
					fetchEndpoint.method,
					fetchEndpoint.path,
					node,
					fetchEndpoint.requestSchema,
					fetchEndpoint.responseSchema,
					fetchEndpoint.requestHeaders
				);
			}

			const clientEndpoint = readMethodClientCall(node, discovery, constants, typeHints, typeSchemas, valueSchemas, headerObjects, clientAuthHeaders);
			if (clientEndpoint) {
				addEndpoint(
					clientEndpoint.method,
					clientEndpoint.path,
					node,
					clientEndpoint.requestSchema,
					clientEndpoint.responseSchema,
					clientEndpoint.requestHeaders
				);
			}
		}

		if (ts.isNewExpression(node)) {
			for (const websocketEndpoint of readWebSocketCall(node, constants, sourceFile)) {
				addEndpoint('WS', websocketEndpoint.path, node, undefined, undefined, websocketEndpoint.requestHeaders);
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return endpoints;
}

function readFetchCall(
	node: ts.CallExpression,
	discovery: DiscoveryOptions,
	constants: Map<string, string>,
	typeHints: Map<string, string>,
	typeSchemas: Map<string, Record<string, string>>,
	valueSchemas: Map<string, Record<string, string>>,
	headerObjects: Map<string, string[]>,
	clientAuthHeaders: Map<string, string[]>
): { method: string; path?: string; requestSchema?: string; responseSchema?: string; requestHeaders?: string[] } | undefined {
	if (!ts.isIdentifier(node.expression) || !discovery.fetchFunctions.has(node.expression.text)) {
		return undefined;
	}

	const firstArg = node.arguments[0];
	const optionsArg = node.arguments[1];
	const requestFromObject = firstArg ? readRequestObject(firstArg, constants) : undefined;
	const optionsObject = optionsArg && ts.isObjectLiteralExpression(optionsArg) ? optionsArg : undefined;
	const method = requestFromObject?.method ?? readMethodFromOptions(optionsObject, constants) ?? 'GET';
	const requestSchema = readRequestSchemaFromOptions(optionsObject, typeHints, typeSchemas, valueSchemas) ?? readTypeArgument(node, 1);

	return {
		method,
		path: requestFromObject?.path ?? readEndpointPathExpression(firstArg, constants),
		requestSchema,
		responseSchema: readTypeArgument(node, 0),
		requestHeaders: mergeHeaderLists(readHeadersFromOptions(optionsObject, headerObjects), clientAuthHeaders.get(node.expression.text))
	};
}

function readMethodClientCall(
	node: ts.CallExpression,
	discovery: DiscoveryOptions,
	constants: Map<string, string>,
	typeHints: Map<string, string>,
	typeSchemas: Map<string, Record<string, string>>,
	valueSchemas: Map<string, Record<string, string>>,
	headerObjects: Map<string, string[]>,
	clientAuthHeaders: Map<string, string[]>
): { method: string; path?: string; requestSchema?: string; responseSchema?: string; requestHeaders?: string[] } | undefined {
	if (!ts.isPropertyAccessExpression(node.expression)) {
		return undefined;
	}
	const clientName = readClientName(node.expression.expression);
	if (!clientName) {
		return undefined;
	}

	const method = node.expression.name.text.toLowerCase();
	const allowedMethods = discovery.methodClients.get(clientName);
	if (!allowedMethods?.has(method)) {
		return undefined;
	}

	const pathArg = node.arguments[0];
	const bodyArg = node.arguments[1];
	const configArg = METHODS_WITH_BODY.has(method) ? node.arguments[2] : node.arguments[1];
	return {
		method,
		path: readEndpointPathExpression(pathArg, constants),
		requestSchema: METHODS_WITH_BODY.has(method) ? inferRequestBodySchema(bodyArg, typeHints, typeSchemas, valueSchemas) ?? readTypeArgument(node, 1) : undefined,
		responseSchema: readTypeArgument(node, 0),
		requestHeaders: mergeHeaderLists(readHeadersFromExpression(configArg, headerObjects), clientAuthHeaders.get(clientName))
	};
}

function readWebSocketCall(
	node: ts.NewExpression,
	constants: Map<string, string>,
	sourceFile: ts.SourceFile
): Array<{ path: string; requestHeaders?: string[] }> {
	if (!ts.isIdentifier(node.expression) || node.expression.text !== 'WebSocket') {
		return [];
	}
	const requestHeaders = webSocketUsesTokenAuth(node, sourceFile) ? ['Authorization'] : undefined;
	const firstArg = node.arguments?.[0];
	const directPath = readEndpointPathExpression(firstArg, constants);
	if (directPath) {
		return [{ path: directPath, requestHeaders }];
	}
	if (!firstArg || !ts.isIdentifier(firstArg)) {
		return [];
	}
	return findClassPropertyEndpointPaths(node, firstArg.text, constants, sourceFile).map((path) => ({ path, requestHeaders }));
}

function webSocketUsesTokenAuth(node: ts.Node, sourceFile: ts.SourceFile): boolean {
	const containingFunction = findAncestor(node, isFunctionLikeWithBody);
	const searchScope = containingFunction ?? findAncestor(node, ts.isClassLike) ?? node;
	const text = searchScope.getText(sourceFile);
	return /[?&](?:token|access_token|auth|jwt)=/.test(text)
		|| /\b(?:token|accessToken|authToken|jwt)\b/.test(text) && /\bencodeURIComponent\s*\(/.test(text);
}

function readRequestObject(
	expression: ts.Expression,
	constants: Map<string, string>
): { path?: string; method?: string } | undefined {
	if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'Request') {
		return undefined;
	}
	const path = readEndpointPathExpression(expression.arguments?.[0], constants);
	const options = expression.arguments?.[1];
	return {
		path,
		method: options && ts.isObjectLiteralExpression(options) ? readMethodFromOptions(options, constants) : undefined
	};
}

function readEndpointPathExpression(
	expression: ts.Expression | undefined,
	constants: Map<string, string>
): string | undefined {
	const strictValue = readStringExpression(expression, constants);
	const strictPath = normalizeEndpointPath(strictValue);
	if (strictPath) {
		return strictPath;
	}
	return normalizeEndpointPath(readLooseStringExpression(expression, constants));
}

function findClassPropertyEndpointPaths(
	node: ts.Node,
	localUrlName: string,
	constants: Map<string, string>,
	sourceFile: ts.SourceFile
): string[] {
	const classNode = findAncestor(node, ts.isClassLike);
	if (!classNode) {
		return [];
	}

	const propertyNames = new Set<string>();
	const containingFunction = findAncestor(node, isFunctionLikeWithBody);
	if (containingFunction) {
		const visitLocalAssignments = (child: ts.Node): void => {
			if (ts.isBinaryExpression(child)
				&& child.operatorToken.kind === ts.SyntaxKind.EqualsToken
				&& ts.isIdentifier(child.left)
				&& child.left.text === localUrlName
				&& ts.isPropertyAccessExpression(child.right)
				&& child.right.expression.kind === ts.SyntaxKind.ThisKeyword) {
				propertyNames.add(child.right.name.text);
			}
			ts.forEachChild(child, visitLocalAssignments);
		};
		visitLocalAssignments(containingFunction);
	}

	const paths = new Set<string>();
	const visitClassAssignments = (child: ts.Node): void => {
		if (ts.isBinaryExpression(child)
			&& child.operatorToken.kind === ts.SyntaxKind.EqualsToken
			&& ts.isPropertyAccessExpression(child.left)
			&& child.left.expression.kind === ts.SyntaxKind.ThisKeyword
			&& propertyNames.has(child.left.name.text)) {
			const path = readEndpointPathExpression(child.right, constants);
			if (path) {
				paths.add(path);
			}
		}
		ts.forEachChild(child, visitClassAssignments);
	};
	visitClassAssignments(classNode);

	if (paths.size > 0) {
		return Array.from(paths);
	}

	const fallbackPath = extractKnownRoutePath(classNode.getText(sourceFile));
	return fallbackPath ? [fallbackPath] : [];
}

function readLooseStringExpression(
	expression: ts.Expression | undefined,
	constants: Map<string, string>
): string | undefined {
	if (!expression) {
		return undefined;
	}
	if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
		return expression.text;
	}
	if (ts.isIdentifier(expression)) {
		return constants.get(expression.text);
	}
	if (ts.isParenthesizedExpression(expression)) {
		return readLooseStringExpression(expression.expression, constants);
	}
	if (ts.isTemplateExpression(expression)) {
		let value = expression.head.text;
		for (const span of expression.templateSpans) {
			value += readLooseStringExpression(span.expression, constants) ?? expressionToRoutePlaceholder(span.expression);
			value += span.literal.text;
		}
		return value;
	}
	if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = readLooseStringExpression(expression.left, constants) ?? '';
		const right = readLooseStringExpression(expression.right, constants) ?? '';
		return left || right ? left + right : undefined;
	}
	return undefined;
}

function expressionToRoutePlaceholder(expression: ts.Expression): string {
	const raw = expression.getText().trim();
	const segments = raw.split('.');
	const last = segments[segments.length - 1] ?? raw;
	const name = last.replace(/[^A-Za-z0-9_]/g, '') || 'param';
	return `{${name}}`;
}

function normalizeEndpointPath(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	const urlPath = extractPathFromUrl(trimmed);
	const candidate = urlPath ?? extractKnownRoutePath(trimmed);
	if (!candidate) {
		return undefined;
	}
	const [withoutHash] = candidate.split('#', 1);
	const [withoutQuery] = withoutHash.split('?', 1);
	return withoutQuery.length > 1 && withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery || undefined;
}

function extractPathFromUrl(value: string): string | undefined {
	if (!/^(https?|wss?):\/\//i.test(value)) {
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/ws')) {
			return `${url.pathname}${url.search}`;
		}
		return value;
	} catch {
		return undefined;
	}
}

function extractKnownRoutePath(value: string): string | undefined {
	const match = value.match(/\/(?:api|ws)(?:[^\s"'`]*)?/);
	return match?.[0];
}

function readMethodFromOptions(
	options: ts.ObjectLiteralExpression | undefined,
	constants: Map<string, string>
): string | undefined {
	const value = options ? readObjectProperty(options, 'method') : undefined;
	return readStringExpression(value, constants);
}

function readRequestSchemaFromOptions(
	options: ts.ObjectLiteralExpression | undefined,
	typeHints: Map<string, string>,
	typeSchemas: Map<string, Record<string, string>>,
	valueSchemas: Map<string, Record<string, string>>
): string | undefined {
	const body = options ? readObjectProperty(options, 'body') : undefined;
	return inferRequestBodySchema(body, typeHints, typeSchemas, valueSchemas);
}

function readHeadersFromOptions(
	options: ts.ObjectLiteralExpression | undefined,
	headerObjects: Map<string, string[]>
): string[] | undefined {
	const headers = options ? readObjectProperty(options, 'headers') : undefined;
	return mergeHeaderLists(
		readHeadersFromExpression(headers, headerObjects),
		options && hasTruthyObjectFlag(options, 'credentials', 'include') ? ['Authorization'] : undefined
	);
}

function readHeadersFromExpression(
	expression: ts.Expression | undefined,
	headerObjects: Map<string, string[]>
): string[] | undefined {
	if (!expression) {
		return undefined;
	}
	if (ts.isIdentifier(expression)) {
		return headerObjects.get(expression.text);
	}
	if (ts.isObjectLiteralExpression(expression)) {
		const headersProperty = readObjectProperty(expression, 'headers');
		const directHeaders = headersProperty
			? readHeadersFromExpression(headersProperty, headerObjects)
			: isRequestConfigObject(expression)
				? undefined
				: readHeaderObjectKeys(expression);
		return mergeHeaderLists(
			directHeaders,
			hasTruthyObjectFlag(expression, 'withCredentials') || hasTruthyObjectFlag(expression, 'credentials', 'include') ? ['Authorization'] : undefined
		);
	}
	if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'Headers') {
		const firstArg = expression.arguments?.[0];
		return firstArg && ts.isObjectLiteralExpression(firstArg) ? readHeaderObjectKeys(firstArg) : undefined;
	}
	return undefined;
}

function isRequestConfigObject(object: ts.ObjectLiteralExpression): boolean {
	return ['headers', 'withCredentials', 'credentials', 'baseURL', 'timeout', 'params', 'signal', 'mode', 'cache', 'redirect'].some((key) =>
		Boolean(readObjectProperty(object, key))
	);
}

function hasTruthyObjectFlag(object: ts.ObjectLiteralExpression, propertyName: string, expectedString?: string): boolean {
	const value = readObjectProperty(object, propertyName);
	if (!value) {
		return false;
	}
	if (expectedString) {
		const unwrapped = unwrapExpression(value);
		return (ts.isStringLiteralLike(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) && unwrapped.text === expectedString;
	}
	const unwrapped = unwrapExpression(value);
	return unwrapped.kind === ts.SyntaxKind.TrueKeyword;
}

function readHeaderObjectKeys(object: ts.ObjectLiteralExpression): string[] {
	const headers: string[] = [];
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
			continue;
		}
		const name = ts.isShorthandPropertyAssignment(property) ? property.name.text : propertyNameToString(property.name);
		if (name) {
			headers.push(name);
		}
	}
	return headers;
}

function inferRequestBodySchema(
	expression: ts.Expression | undefined,
	typeHints: Map<string, string>,
	typeSchemas: Map<string, Record<string, string>>,
	valueSchemas: Map<string, Record<string, string>>
): string | undefined {
	if (!expression) {
		return undefined;
	}
	if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
		return normalizeTypeName(expression.type.getText());
	}
	if (ts.isCallExpression(expression)
		&& ts.isPropertyAccessExpression(expression.expression)
		&& expression.expression.expression.getText() === 'JSON'
		&& expression.expression.name.text === 'stringify') {
		return inferRequestBodySchema(expression.arguments[0], typeHints, typeSchemas, valueSchemas);
	}
	if (ts.isIdentifier(expression)) {
		const valueSchema = valueSchemas.get(expression.text);
		if (valueSchema) {
			return JSON.stringify(valueSchema);
		}
		return normalizeTypeName(typeHints.get(expression.text)) ?? normalizeTypeName(expression.getText());
	}
	if (ts.isPropertyAccessExpression(expression)) {
		return normalizeTypeName(expression.getText());
	}
	if (ts.isObjectLiteralExpression(expression)) {
		const schema = objectLiteralToSchema(expression, typeHints, typeSchemas);
		return schema ? JSON.stringify(schema) : undefined;
	}
	return undefined;
}

function inferResponseSchema(
	node: ts.CallExpression | ts.NewExpression,
	contexts: FunctionContext[],
	sourceFile: ts.SourceFile,
	typeHints: Map<string, string>
): string | undefined {
	const explicitCast = findNearbyTypeAssertion(node);
	if (explicitCast) {
		return explicitCast;
	}
	const context = findContainingFunctionContext(node.getStart(), contexts);
	const declared = normalizeTypeName(context?.returnType);
	const inferred = inferJsonUsageResponseSchema(node, sourceFile, typeHints);
	return declared?.startsWith('{') ? declared : inferred ?? declared;
}

function inferResponseTypeName(
	node: ts.CallExpression | ts.NewExpression,
	contexts: FunctionContext[]
): string | undefined {
	return findNearbyTypeAssertion(node) ?? normalizeTypeName(findContainingFunctionContext(node.getStart(), contexts)?.returnTypeName);
}

function findNearbyTypeAssertion(node: ts.Node): string | undefined {
	let current: ts.Node | undefined = node;
	for (let depth = 0; current && depth < 5; depth += 1) {
		if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
			return normalizeTypeName(current.type.getText());
		}
		current = current.parent;
	}
	return undefined;
}

function inferJsonUsageResponseSchema(
	node: ts.CallExpression | ts.NewExpression,
	sourceFile: ts.SourceFile,
	typeHints: Map<string, string>
): string | undefined {
	const responseName = findAssignedIdentifier(node);
	if (!responseName) {
		return undefined;
	}
	const containingFunction = findAncestor(node, isFunctionLikeWithBody);
	if (!containingFunction) {
		return undefined;
	}

	const jsonNames = findJsonResultNames(containingFunction, responseName);
	if (jsonNames.size === 0) {
		return undefined;
	}

	const schema: Record<string, string> = {};
	const visit = (child: ts.Node): void => {
		const property = readJsonPropertyAccess(child, jsonNames);
		if (property) {
			const nextType = inferUnpackedPropertyType(child, typeHints);
			const currentType = schema[property];
			if (!currentType || currentType === 'unknown' || nextType !== 'unknown') {
				schema[property] = nextType;
			}
		}
		if (ts.isCallExpression(child)) {
			mergeSchema(schema, inferJsonArrayMapSchema(child, jsonNames, typeHints));
		}
		ts.forEachChild(child, visit);
	};
	visit(containingFunction);
	return Object.keys(schema).length > 0 ? JSON.stringify(schema) : undefined;
}

function mergeSchema(target: Record<string, string>, source: Record<string, string> | undefined): void {
	if (!source) {
		return;
	}
	for (const [key, value] of Object.entries(source)) {
		const current = target[key];
		if (!current || current === 'unknown' || value !== 'unknown') {
			target[key] = value;
		}
	}
}

function collectEndpointFieldLocations(
	call: ts.CallExpression | ts.NewExpression,
	requestSchema: string | undefined,
	responseSchema: string | undefined,
	sourceFile: ts.SourceFile,
	typeFieldLocations: Map<string, SchemaFieldSourceLocation[]>,
	requestTypeName?: string,
	responseTypeName?: string
): SchemaFieldSourceLocation[] {
	const locations: SchemaFieldSourceLocation[] = [];
	const requestKeys = getSchemaObjectKeys(requestSchema);
	const responseKeys = getSchemaObjectKeys(responseSchema);
	const remember = (items: SchemaFieldSourceLocation[]): void => {
		const existing = new Set(locations.map((location) => `${location.scope}:${location.field}`));
		for (const item of items) {
			const key = `${item.scope}:${item.field}`;
			if (!existing.has(key)) {
				locations.push(item);
				existing.add(key);
			}
		}
	};
	if (requestKeys.size > 0 && ts.isCallExpression(call)) {
		remember(collectRequestFieldLocations(call, requestKeys, sourceFile));
		remember(collectTypeLocationsForSchema(requestTypeName, 'request', requestKeys, typeFieldLocations));
	}
	if (responseKeys.size > 0) {
		remember(collectResponseFieldLocations(call, responseKeys, sourceFile));
		remember(collectTypeLocationsForSchema(responseTypeName, 'response', responseKeys, typeFieldLocations));
	}
	return locations;
}

function collectTypeLocationsForSchema(
	typeName: string | undefined,
	scope: 'request' | 'response',
	keys: Set<string>,
	typeFieldLocations: Map<string, SchemaFieldSourceLocation[]>
): SchemaFieldSourceLocation[] {
	const locations = new Map<string, SchemaFieldSourceLocation>();
	for (const candidate of typeNameCandidates(typeName)) {
		for (const location of typeFieldLocations.get(candidate) ?? []) {
			if (keys.has(location.field) && !locations.has(location.field)) {
				locations.set(location.field, { ...location, scope });
			}
		}
	}
	return Array.from(locations.values());
}

function typeNameCandidates(typeName: string | undefined): string[] {
	if (!typeName) {
		return [];
	}
	const candidates = new Set<string>();
	const visit = (value: string): void => {
		const normalized = normalizeTypeName(value);
		if (!normalized || normalized === 'null' || normalized === 'undefined') {
			return;
		}
		const promiseMatch = normalized.match(/^Promise<(.+)>$/);
		if (promiseMatch?.[1]) {
			visit(promiseMatch[1]);
			return;
		}
		const arrayMatch = normalized.match(/^(?:Array<(.+)>|(.+)\[\])$/);
		if (arrayMatch?.[1] || arrayMatch?.[2]) {
			visit((arrayMatch[1] ?? arrayMatch[2]).trim());
			return;
		}
		for (const part of normalized.split('|')) {
			const trimmed = part.trim();
			if (trimmed && trimmed !== normalized) {
				visit(trimmed);
			}
		}
		candidates.add(normalized.replace(/\[\]$/, ''));
	};
	visit(typeName);
	return Array.from(candidates);
}

function getSchemaObjectKeys(schema: string | undefined): Set<string> {
	if (!schema?.trim().startsWith('{')) {
		return new Set();
	}
	try {
		const parsed = JSON.parse(schema) as unknown;
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return new Set(Object.keys(parsed as Record<string, unknown>));
		}
	} catch {
		// Ignore non-JSON schema labels.
	}
	return new Set();
}

function collectRequestFieldLocations(
	call: ts.CallExpression,
	keys: Set<string>,
	sourceFile: ts.SourceFile
): SchemaFieldSourceLocation[] {
	const locations = new Map<string, SchemaFieldSourceLocation>();
	const visitBody = (expression: ts.Expression | undefined): void => {
		if (!expression) {
			return;
		}
		if (ts.isCallExpression(expression)
			&& ts.isPropertyAccessExpression(expression.expression)
			&& expression.expression.expression.getText() === 'JSON'
			&& expression.expression.name.text === 'stringify') {
			visitBody(expression.arguments[0]);
			return;
		}
		if (!ts.isObjectLiteralExpression(expression)) {
			return;
		}
		for (const property of expression.properties) {
			if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
				continue;
			}
			const name = ts.isShorthandPropertyAssignment(property) ? property.name.text : propertyNameToString(property.name);
			if (name && keys.has(name) && !locations.has(name)) {
				locations.set(name, fieldLocation('request', name, property, sourceFile));
			}
		}
	};

	const fetchEndpoint = ts.isIdentifier(call.expression) ? call.arguments[1] : undefined;
	if (fetchEndpoint && ts.isObjectLiteralExpression(fetchEndpoint)) {
		visitBody(readObjectProperty(fetchEndpoint, 'body'));
	}
	if (ts.isPropertyAccessExpression(call.expression)) {
		const method = call.expression.name.text.toLowerCase();
		if (METHODS_WITH_BODY.has(method)) {
			visitBody(call.arguments[1]);
		}
	}
	return Array.from(locations.values());
}

function collectResponseFieldLocations(
	call: ts.CallExpression | ts.NewExpression,
	keys: Set<string>,
	sourceFile: ts.SourceFile
): SchemaFieldSourceLocation[] {
	const responseName = findAssignedIdentifier(call);
	if (!responseName) {
		return [];
	}
	const containingFunction = findAncestor(call, isFunctionLikeWithBody);
	if (!containingFunction) {
		return [];
	}
	const jsonNames = findJsonResultNames(containingFunction, responseName);
	if (jsonNames.size === 0) {
		return [];
	}
	const locations = new Map<string, SchemaFieldSourceLocation>();
	const remember = (field: string, node: ts.Node): void => {
		if (keys.has(field) && !locations.has(field)) {
			locations.set(field, fieldLocation('response', field, node, sourceFile));
		}
	};
	const visit = (child: ts.Node): void => {
		const property = readJsonPropertyAccess(child, jsonNames);
		if (property) {
			remember(property, child);
		}
		if (ts.isCallExpression(child)) {
			for (const item of collectMappedResponseFieldLocations(child, jsonNames, keys, sourceFile)) {
				if (!locations.has(item.field)) {
					locations.set(item.field, item);
				}
			}
		}
		ts.forEachChild(child, visit);
	};
	visit(containingFunction);
	return Array.from(locations.values());
}

function collectMappedResponseFieldLocations(
	node: ts.CallExpression,
	jsonNames: Set<string>,
	keys: Set<string>,
	sourceFile: ts.SourceFile
): SchemaFieldSourceLocation[] {
	if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'map') {
		return [];
	}
	if (!ts.isIdentifier(node.expression.expression) || !jsonNames.has(node.expression.expression.text)) {
		return [];
	}
	const callback = node.arguments[0];
	if (!callback || !isFunctionLikeWithBody(callback)) {
		return [];
	}
	const firstParam = callback.parameters[0]?.name;
	if (!firstParam || !ts.isIdentifier(firstParam)) {
		return [];
	}
	const itemName = firstParam.text;
	const aliases = collectObjectAliases(callback, itemName);
	const locations = new Map<string, SchemaFieldSourceLocation>();
	const visit = (child: ts.Node): void => {
		const property = readMappedItemPropertyAccess(child, itemName, aliases);
		if (property && keys.has(property) && !locations.has(property)) {
			locations.set(property, fieldLocation('response', property, child, sourceFile));
		}
		if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer && keys.has(child.name.text)) {
			const sourceKey = findFirstMappedPropertyKey(child.initializer, itemName, aliases);
			if (sourceKey && !isObjectAliasInitializer(child.initializer) && !locations.has(child.name.text)) {
				locations.set(child.name.text, fieldLocation('response', child.name.text, child.name, sourceFile));
			}
		}
		ts.forEachChild(child, visit);
	};
	visit(callback);
	return Array.from(locations.values());
}

function fieldLocation(
	scope: 'request' | 'response',
	field: string,
	node: ts.Node,
	sourceFile: ts.SourceFile
): SchemaFieldSourceLocation {
	const start = getFieldTokenStart(node, sourceFile);
	const location = offsetToLineColumn(sourceFile.text, start);
	return {
		uri: '',
		scope,
		field,
		line: location.line,
		column: location.column,
		highlightText: field.split('.').pop()?.replace(/\[]$/, '') ?? field
	};
}

function getFieldTokenStart(node: ts.Node, sourceFile: ts.SourceFile): number {
	if (ts.isPropertyAccessExpression(node)) {
		return node.name.getStart(sourceFile);
	}
	if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
		return node.argumentExpression.getStart(sourceFile) + 1;
	}
	if (ts.isPropertyAssignment(node)) {
		return node.name.getStart(sourceFile) + (ts.isStringLiteralLike(node.name) ? 1 : 0);
	}
	if (ts.isShorthandPropertyAssignment(node)) {
		return node.name.getStart(sourceFile);
	}
	if (ts.isIdentifier(node)) {
		return node.getStart(sourceFile);
	}
	return node.getStart(sourceFile);
}

function inferJsonArrayMapSchema(
	node: ts.CallExpression,
	jsonNames: Set<string>,
	typeHints: Map<string, string>
): Record<string, string> | undefined {
	if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'map') {
		return undefined;
	}
	if (!ts.isIdentifier(node.expression.expression) || !jsonNames.has(node.expression.expression.text)) {
		return undefined;
	}
	const callback = node.arguments[0];
	if (!callback || !isFunctionLikeWithBody(callback)) {
		return undefined;
	}
	const firstParam = callback.parameters[0]?.name;
	if (!firstParam || !ts.isIdentifier(firstParam)) {
		return undefined;
	}
	const itemName = firstParam.text;
	const aliases = collectObjectAliases(callback, itemName);
	const valueAliases = collectValueAliases(callback, itemName, aliases, typeHints);
	const schema: Record<string, string> = {};
	const visit = (child: ts.Node): void => {
		const property = readMappedItemPropertyAccess(child, itemName, aliases);
		if (property) {
			const nextType = inferUnpackedPropertyType(child, typeHints);
			const currentType = schema[property];
			if (!currentType || currentType === 'unknown' || nextType !== 'unknown') {
				schema[property] = nextType;
			}
		}
		ts.forEachChild(child, visit);
	};
	visit(callback);
	for (const alias of valueAliases.values()) {
		if (schema[alias.responseKey]) {
			continue;
		}
		const aliasSourceType = schema[alias.sourceKey];
		schema[alias.responseKey] = alias.type !== 'unknown' ? alias.type : aliasSourceType ?? 'unknown';
	}
	return Object.keys(schema).length > 0 ? schema : undefined;
}

function collectObjectAliases(root: ts.Node, itemName: string): Map<string, string> {
	const aliases = new Map<string, string>();
	const visit = (child: ts.Node): void => {
		if (ts.isVariableDeclaration(child)
			&& ts.isIdentifier(child.name)
			&& child.initializer
			&& ts.isBinaryExpression(child.initializer)
			&& child.initializer.operatorToken.kind === ts.SyntaxKind.BarBarToken
			&& ts.isPropertyAccessExpression(child.initializer.left)
			&& ts.isIdentifier(child.initializer.left.expression)
			&& child.initializer.left.expression.text === itemName) {
			aliases.set(child.name.text, child.initializer.left.name.text);
		}
		ts.forEachChild(child, visit);
	};
	visit(root);
	return aliases;
}

function collectValueAliases(
	root: ts.Node,
	itemName: string,
	objectAliases: Map<string, string>,
	typeHints: Map<string, string>
): Map<string, { responseKey: string; sourceKey: string; type: string }> {
	const aliases = new Map<string, { responseKey: string; sourceKey: string; type: string }>();
	const visit = (child: ts.Node): void => {
		if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer) {
			const sourceKey = findFirstMappedPropertyKey(child.initializer, itemName, objectAliases);
			if (sourceKey && !isObjectAliasInitializer(child.initializer)) {
				aliases.set(child.name.text, {
					responseKey: child.name.text,
					sourceKey,
					type: inferExpressionChainType(child.initializer, typeHints)
				});
			}
		}
		ts.forEachChild(child, visit);
	};
	visit(root);
	return aliases;
}

function isObjectAliasInitializer(expression: ts.Expression): boolean {
	if (ts.isBinaryExpression(expression)
		&& (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
		return isObjectAliasInitializer(expression.left) || isObjectAliasInitializer(expression.right);
	}
	if (ts.isParenthesizedExpression(expression)) {
		return isObjectAliasInitializer(expression.expression);
	}
	return ts.isObjectLiteralExpression(expression);
}

function findFirstMappedPropertyKey(
	expression: ts.Expression,
	itemName: string,
	objectAliases: Map<string, string>
): string | undefined {
	const direct = readMappedItemPropertyAccess(expression, itemName, objectAliases);
	if (direct) {
		return direct;
	}
	if (ts.isBinaryExpression(expression)
		&& (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
		return findFirstMappedPropertyKey(expression.left, itemName, objectAliases)
			?? findFirstMappedPropertyKey(expression.right, itemName, objectAliases);
	}
	if (ts.isParenthesizedExpression(expression)) {
		return findFirstMappedPropertyKey(expression.expression, itemName, objectAliases);
	}
	return undefined;
}

function inferExpressionChainType(expression: ts.Expression, typeHints: Map<string, string>): string {
	if (ts.isBinaryExpression(expression)
		&& (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
		const left = inferExpressionChainType(expression.left, typeHints);
		const right = inferExpressionChainType(expression.right, typeHints);
		return mergeSchemaTypes(left, right);
	}
	return expressionToSimpleType(expression, typeHints) ?? 'unknown';
}

function mergeSchemaTypes(left: string, right: string): string {
	if (left === right) {
		return left;
	}
	if ((left === 'unknown' && right === 'null') || (left === 'null' && right === 'unknown')) {
		return 'unknown | null';
	}
	if (left === 'unknown') {
		return right;
	}
	if (right === 'unknown') {
		return left;
	}
	const parts = new Set([...left.split('|').map((part) => part.trim()), ...right.split('|').map((part) => part.trim())]);
	return Array.from(parts).join(' | ');
}

function readMappedItemPropertyAccess(
	node: ts.Node,
	itemName: string,
	aliases: Map<string, string>
): string | undefined {
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
		if (node.expression.text === itemName) {
			return node.name.text;
		}
		const aliasRoot = aliases.get(node.expression.text);
		if (aliasRoot) {
			return `${aliasRoot}.${node.name.text}`;
		}
	}
	if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
		const argument = node.argumentExpression;
		if (!argument || !ts.isStringLiteralLike(argument)) {
			return undefined;
		}
		if (node.expression.text === itemName) {
			return argument.text;
		}
		const aliasRoot = aliases.get(node.expression.text);
		if (aliasRoot) {
			return `${aliasRoot}.${argument.text}`;
		}
	}
	return undefined;
}

function findAssignedIdentifier(node: ts.Node): string | undefined {
	let current: ts.Node = node;
	while (current.parent && (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent))) {
		current = current.parent;
	}
	const parent = current.parent;
	if (parent && ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)) {
		return parent.name.text;
	}
	if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === current && ts.isIdentifier(parent.left)) {
		return parent.left.text;
	}
	return findPromiseAllArrayBindingName(node);
}

function findPromiseAllArrayBindingName(node: ts.Node): string | undefined {
	let current: ts.Node = node;
	while (current.parent && !ts.isArrayLiteralExpression(current.parent)) {
		current = current.parent;
	}
	const arrayLiteral = current.parent;
	if (!arrayLiteral || !ts.isArrayLiteralExpression(arrayLiteral)) {
		return undefined;
	}
	const elementIndex = arrayLiteral.elements.findIndex((element) => element === current);
	if (elementIndex < 0) {
		return undefined;
	}
	const promiseAllCall = arrayLiteral.parent;
	if (!promiseAllCall
		|| !ts.isCallExpression(promiseAllCall)
		|| !ts.isPropertyAccessExpression(promiseAllCall.expression)
		|| promiseAllCall.expression.expression.getText() !== 'Promise'
		|| promiseAllCall.expression.name.text !== 'all') {
		return undefined;
	}
	let assignmentTarget: ts.Node = promiseAllCall;
	while (assignmentTarget.parent && (ts.isAwaitExpression(assignmentTarget.parent) || ts.isParenthesizedExpression(assignmentTarget.parent))) {
		assignmentTarget = assignmentTarget.parent;
	}
	const declaration = assignmentTarget.parent;
	if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== assignmentTarget || !ts.isArrayBindingPattern(declaration.name)) {
		return undefined;
	}
	const binding = declaration.name.elements[elementIndex];
	return binding && ts.isBindingElement(binding) && ts.isIdentifier(binding.name) ? binding.name.text : undefined;
}

function findJsonResultNames(root: ts.Node, responseName: string): Set<string> {
	const names = new Set<string>();
	const visit = (child: ts.Node): void => {
		if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer && isJsonCallForResponse(child.initializer, responseName)) {
			names.add(child.name.text);
		}
		if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(child.left) && isJsonCallForResponse(child.right, responseName)) {
			names.add(child.left.text);
		}
		ts.forEachChild(child, visit);
	};
	visit(root);
	return names;
}

function isJsonCallForResponse(expression: ts.Expression, responseName: string): boolean {
	const unwrapped = unwrapAwaitExpression(expression);
	return ts.isCallExpression(unwrapped)
		&& ts.isPropertyAccessExpression(unwrapped.expression)
		&& unwrapped.expression.name.text === 'json'
		&& ts.isIdentifier(unwrapped.expression.expression)
		&& unwrapped.expression.expression.text === responseName;
}

function unwrapAwaitExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
		current = ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) ? current.expression : current.expression;
	}
	return current;
}

function readJsonPropertyAccess(node: ts.Node, jsonNames: Set<string>): string | undefined {
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && jsonNames.has(node.expression.text)) {
		if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
			return undefined;
		}
		return node.name.text;
	}
	if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && jsonNames.has(node.expression.text)) {
		const argument = node.argumentExpression;
		if (argument && ts.isStringLiteralLike(argument)) {
			return argument.text;
		}
	}
	return undefined;
}

function inferUnpackedPropertyType(node: ts.Node, typeHints: Map<string, string>): string {
	const fallbackType = findLogicalFallbackType(node, typeHints);
	if (fallbackType) {
		return fallbackType === 'null' ? 'unknown | null' : fallbackType;
	}
	const parent = node.parent;
	if (parent && ts.isCallExpression(parent)) {
		const callee = parent.expression.getText();
		if (callee === 'String') {
			return 'string';
		}
		if (callee === 'Number') {
			return 'number';
		}
		if (callee === 'Boolean') {
			return 'boolean';
		}
	}
	if (parent && ts.isNewExpression(parent) && parent.expression.getText() === 'Date') {
		return 'datetime';
	}
	if (parent && ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
		const other = parent.left === node ? parent.right : parent.left;
		return expressionToSimpleType(other, typeHints) ?? 'unknown';
	}
	return 'unknown';
}

function findLogicalFallbackType(node: ts.Node, typeHints: Map<string, string>): string | undefined {
	let current: ts.Node = node;
	while (current.parent
		&& ts.isBinaryExpression(current.parent)
		&& (current.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken || current.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
		const parent = current.parent;
		const other = parent.left === current ? parent.right : parent.left;
		const otherType = expressionToSimpleType(other, typeHints);
		if (otherType) {
			return otherType;
		}
		current = parent;
	}
	return undefined;
}

function expressionToSimpleType(expression: ts.Expression, typeHints: Map<string, string>): string | undefined {
	if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
		return 'string';
	}
	if (ts.isNumericLiteral(expression)) {
		return 'number';
	}
	if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
		return 'boolean';
	}
	if (expression.kind === ts.SyntaxKind.NullKeyword) {
		return 'null';
	}
	if (ts.isIdentifier(expression)) {
		const hinted = typeHints.get(expression.text);
		if (hinted === 'string' || hinted === 'number' || hinted === 'boolean') {
			return hinted;
		}
	}
	return undefined;
}

function readStringExpression(
	expression: ts.Expression | undefined,
	constants: Map<string, string>
): string | undefined {
	if (!expression) {
		return undefined;
	}
	if (ts.isStringLiteralLike(expression)) {
		return expression.text;
	}
	if (ts.isNoSubstitutionTemplateLiteral(expression)) {
		return expression.text;
	}
	if (ts.isIdentifier(expression)) {
		return constants.get(expression.text);
	}
	if (ts.isParenthesizedExpression(expression)) {
		return readStringExpression(expression.expression, constants);
	}
	if (ts.isTemplateExpression(expression)) {
		let value = expression.head.text;
		for (const span of expression.templateSpans) {
			const constant = readStringExpression(span.expression, constants);
			if (constant === undefined) {
				return undefined;
			}
			value += constant + span.literal.text;
		}
		return value;
	}
	if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = readStringExpression(expression.left, constants);
		const right = readStringExpression(expression.right, constants);
		return left !== undefined && right !== undefined ? left + right : undefined;
	}
	return undefined;
}

function readObjectProperty(object: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | undefined {
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) {
			continue;
		}
		const name = property.name;
		if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === propertyName) {
			return property.initializer;
		}
	}
	return undefined;
}

function collectStringConstants(sourceFile: ts.SourceFile): Map<string, string> {
	const constants = new Map<string, string>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableStatement(node)) {
			const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
			if (isConst) {
				for (const declaration of node.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name) && declaration.initializer) {
						const value = readStringExpression(declaration.initializer, constants);
						if (value !== undefined) {
							constants.set(declaration.name.text, value);
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return constants;
}

function collectTypeHints(sourceFile: ts.SourceFile): Map<string, string> {
	const hints = new Map<string, string>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const annotated = normalizeTypeName(node.type?.getText());
			const asserted = node.initializer && (ts.isAsExpression(node.initializer) || ts.isTypeAssertionExpression(node.initializer))
				? normalizeTypeName(node.initializer.type.getText())
				: undefined;
			const type = annotated ?? asserted;
			if (type) {
				hints.set(node.name.text, type);
			}
		}
		if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
			const type = normalizeTypeName(node.type?.getText());
			if (type) {
				hints.set(node.name.text, type);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return hints;
}

function collectTypeSchemas(sourceFile: ts.SourceFile): Map<string, Record<string, string>> {
	const schemas = new Map<string, Record<string, string>>();
	const visit = (node: ts.Node): void => {
		if (ts.isInterfaceDeclaration(node)) {
			const schema = membersToSchema(node.members);
			if (schema) {
				schemas.set(node.name.text, schema);
			}
		}
		if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
			const schema = membersToSchema(node.type.members);
			if (schema) {
				schemas.set(node.name.text, schema);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return schemas;
}

function collectTypeFieldLocations(sourceFile: ts.SourceFile): Map<string, SchemaFieldSourceLocation[]> {
	const locations = new Map<string, SchemaFieldSourceLocation[]>();
	const visit = (node: ts.Node): void => {
		if (ts.isInterfaceDeclaration(node)) {
			locations.set(node.name.text, membersToFieldLocations(node.members, sourceFile));
		}
		if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
			locations.set(node.name.text, membersToFieldLocations(node.type.members, sourceFile));
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return locations;
}

function membersToFieldLocations(
	members: ts.NodeArray<ts.TypeElement>,
	sourceFile: ts.SourceFile
): SchemaFieldSourceLocation[] {
	const locations: SchemaFieldSourceLocation[] = [];
	for (const member of members) {
		if (!ts.isPropertySignature(member)) {
			continue;
		}
		const name = propertyNameToString(member.name);
		if (!name) {
			continue;
		}
		locations.push(fieldLocation('response', name, member.name, sourceFile));
	}
	return locations;
}

function collectValueSchemas(
	sourceFile: ts.SourceFile,
	typeHints: Map<string, string>,
	typeSchemas: Map<string, Record<string, string>>
): Map<string, Record<string, string>> {
	const schemas = new Map<string, Record<string, string>>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const initializer = unwrapExpression(node.initializer);
			if (ts.isObjectLiteralExpression(initializer)) {
				const schema = objectLiteralToSchema(initializer, typeHints, typeSchemas);
				if (schema) {
					schemas.set(node.name.text, schema);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return schemas;
}

function collectHeaderObjects(sourceFile: ts.SourceFile): Map<string, string[]> {
	const headers = new Map<string, string[]>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const initializer = unwrapExpression(node.initializer);
			if (ts.isObjectLiteralExpression(initializer)) {
				const keys = readHeaderObjectKeys(initializer);
				if (keys.length > 0 && node.name.text.toLowerCase().includes('header')) {
					headers.set(node.name.text, keys);
				}
			}
			if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'Headers') {
				const keys = readHeadersFromExpression(initializer, headers);
				if (keys?.length) {
					headers.set(node.name.text, keys);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return headers;
}

function collectClientAuthHeaders(sourceFile: ts.SourceFile): Map<string, string[]> {
	const clients = new Map<string, string[]>();
	const remember = (client: string | undefined, headers: string[] | undefined): void => {
		if (!client || !headers?.length) {
			return;
		}
		clients.set(client, mergeHeaderLists(clients.get(client), headers) ?? headers);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const initializer = unwrapExpression(node.initializer);
			if (ts.isCallExpression(initializer)
				&& ts.isPropertyAccessExpression(initializer.expression)
				&& initializer.expression.expression.getText(sourceFile) === 'axios'
				&& initializer.expression.name.text === 'create') {
				const config = initializer.arguments[0];
				if (config && ts.isObjectLiteralExpression(config)) {
					remember(node.name.text, readHeadersFromExpression(config, new Map()));
				}
			}
			if (isFunctionLikeWithBody(initializer) && functionBodyAddsAuth(initializer, sourceFile)) {
				remember(node.name.text, ['Authorization']);
			}
		}
		if (ts.isFunctionDeclaration(node) && node.name && functionBodyAddsAuth(node, sourceFile)) {
			remember(node.name.text, ['Authorization']);
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const client = readAuthAssignmentClient(node.left);
			if (client) {
				remember(client, ['Authorization']);
			}
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const client = readInterceptorClient(node.expression);
			if (client && node.getText(sourceFile).match(/\b(?:Authorization|Bearer|token|jwt|withCredentials|credentials)\b/i)) {
				remember(client, ['Authorization']);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return clients;
}

function functionBodyAddsAuth(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): boolean {
	return Boolean(node.body?.getText(sourceFile).match(/\b(?:Authorization|Bearer|withCredentials|credentials\s*:\s*['"`]include['"`])\b/i));
}

function readAuthAssignmentClient(expression: ts.Expression): string | undefined {
	if (!ts.isPropertyAccessExpression(expression)) {
		return undefined;
	}
	const text = expression.getText();
	if (!/\b(?:Authorization|withCredentials)\b/.test(text)) {
		return undefined;
	}
	let current: ts.Expression = expression;
	while (ts.isPropertyAccessExpression(current)) {
		if (ts.isIdentifier(current.expression)) {
			return current.expression.text;
		}
		current = current.expression;
	}
	return undefined;
}

function readInterceptorClient(expression: ts.PropertyAccessExpression): string | undefined {
	if (expression.name.text !== 'use' || !ts.isPropertyAccessExpression(expression.expression)) {
		return undefined;
	}
	const interceptors = expression.expression;
	if (interceptors.name.text !== 'request' || !ts.isPropertyAccessExpression(interceptors.expression)) {
		return undefined;
	}
	const root = interceptors.expression;
	return root.name.text === 'interceptors' && ts.isIdentifier(root.expression) ? root.expression.text : undefined;
}

function membersToSchema(members: ts.NodeArray<ts.TypeElement>): Record<string, string> | undefined {
	const schema: Record<string, string> = {};
	for (const member of members) {
		if (!ts.isPropertySignature(member)) {
			continue;
		}
		const name = propertyNameToString(member.name);
		if (!name) {
			continue;
		}
		schema[name] = typeNodeToSchemaType(member.type);
	}
	return Object.keys(schema).length > 0 ? schema : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isParenthesizedExpression(current)) {
		current = ts.isParenthesizedExpression(current) ? current.expression : current.expression;
	}
	return current;
}

function objectLiteralToSchema(
	object: ts.ObjectLiteralExpression,
	typeHints: Map<string, string>,
	typeSchemas: Map<string, Record<string, string>>
): Record<string, string> | undefined {
	const schema: Record<string, string> = {};
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property)) {
			const name = propertyNameToString(property.name);
			if (!name) {
				continue;
			}
			schema[name] = expressionToSchemaType(property.initializer, typeHints, typeSchemas);
		}
		if (ts.isShorthandPropertyAssignment(property)) {
			const name = property.name.text;
			const hinted = typeHints.get(name);
			schema[name] = resolveSchemaTypeName(hinted, typeSchemas) ?? hinted ?? 'unknown';
		}
	}
	return Object.keys(schema).length > 0 ? schema : undefined;
}

function propertyNameToString(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return undefined;
}

function expressionToSchemaType(
	expression: ts.Expression,
	typeHints: Map<string, string>,
	typeSchemas: Map<string, Record<string, string>>
): string {
	if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
		return 'string';
	}
	if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
		return 'boolean';
	}
	if (expression.kind === ts.SyntaxKind.NullKeyword) {
		return 'null';
	}
	if (ts.isNumericLiteral(expression)) {
		return 'number';
	}
	if (ts.isArrayLiteralExpression(expression)) {
		return 'array';
	}
	if (ts.isObjectLiteralExpression(expression)) {
		return 'object';
	}
	if (ts.isIdentifier(expression)) {
		const hinted = typeHints.get(expression.text);
		return resolveSchemaTypeName(hinted, typeSchemas) ?? hinted ?? 'unknown';
	}
	if (ts.isPropertyAccessExpression(expression)) {
		const hinted = typeHints.get(expression.name.text);
		return resolveSchemaTypeName(hinted, typeSchemas) ?? hinted ?? 'unknown';
	}
	if (ts.isCallExpression(expression)) {
		return callExpressionToSchemaType(expression);
	}
	return 'unknown';
}

function callExpressionToSchemaType(expression: ts.CallExpression): string {
	const text = expression.expression.getText();
	if (text === 'String' || text.endsWith('.toString')) {
		return 'string';
	}
	if (text.endsWith('.toISOString')) {
		return 'string';
	}
	if (text === 'Number') {
		return 'number';
	}
	if (text === 'Boolean') {
		return 'boolean';
	}
	return 'unknown';
}

function typeNodeToSchemaType(type: ts.TypeNode | undefined): string {
	if (!type) {
		return 'unknown';
	}
	if (type.kind === ts.SyntaxKind.StringKeyword) {
		return 'string';
	}
	if (type.kind === ts.SyntaxKind.NumberKeyword) {
		return 'number';
	}
	if (type.kind === ts.SyntaxKind.BooleanKeyword) {
		return 'boolean';
	}
	if (ts.isArrayTypeNode(type)) {
		return `${typeNodeToSchemaType(type.elementType)}[]`;
	}
	if (ts.isTypeReferenceNode(type)) {
		const name = type.typeName.getText();
		if (name === 'Array' && type.typeArguments?.[0]) {
			return `${typeNodeToSchemaType(type.typeArguments[0])}[]`;
		}
		return name;
	}
	if (ts.isUnionTypeNode(type)) {
		return type.types.map((item) => typeNodeToSchemaType(item)).join(' | ');
	}
	if (ts.isLiteralTypeNode(type)) {
		return type.literal.getText();
	}
	if (ts.isTypeLiteralNode(type)) {
		return 'object';
	}
	return type.getText();
}

function resolveSchemaString(
	typeName: string | undefined,
	typeSchemas: Map<string, Record<string, string>>
): string | undefined {
	if (!typeName) {
		return undefined;
	}
	const schema = resolveSchemaShape(typeName, typeSchemas);
	return schema ? JSON.stringify(schema) : typeName;
}

function resolveSchemaShape(
	typeName: string,
	typeSchemas: Map<string, Record<string, string>>
): Record<string, string> | undefined {
	const direct = typeSchemas.get(typeName);
	if (direct) {
		return direct;
	}
	for (const part of typeName.split('|').map((item) => item.trim())) {
		const schema = typeSchemas.get(part.replace(/\[\]$/, ''));
		if (schema) {
			return schema;
		}
	}
	const arrayMatch = typeName.match(/^(?:Array<(.+)>|(.+)\[\])$/);
	const itemType = arrayMatch?.[1] ?? arrayMatch?.[2];
	return itemType ? typeSchemas.get(itemType.trim()) : undefined;
}

function resolveSchemaTypeName(
	typeName: string | undefined,
	typeSchemas: Map<string, Record<string, string>>
): string | undefined {
	if (!typeName) {
		return undefined;
	}
	return resolveSchemaShape(typeName, typeSchemas) ? 'object' : undefined;
}

function readClientName(expression: ts.Expression): string | undefined {
	if (ts.isIdentifier(expression)) {
		return expression.text;
	}
	return undefined;
}

function readTypeArgument(node: ts.CallExpression, index: number): string | undefined {
	return normalizeTypeName(node.typeArguments?.[index]?.getText());
}

function extractReturnType(
	node: ts.FunctionLikeDeclaration,
	typeSchemas: Map<string, Record<string, string>>
): string | undefined {
	if (!node.type) {
		return undefined;
	}
	return typeNodeToResponseSchemaString(node.type, typeSchemas);
}

function extractReturnTypeName(node: ts.FunctionLikeDeclaration): string | undefined {
	return node.type ? typeNodeToResponseTypeName(node.type) : undefined;
}

function typeNodeToResponseTypeName(type: ts.TypeNode): string | undefined {
	if (ts.isTypeReferenceNode(type)) {
		const name = type.typeName.getText();
		if (name === 'Promise' && type.typeArguments?.[0]) {
			return typeNodeToResponseTypeName(type.typeArguments[0]);
		}
		const normalized = normalizeTypeName(type.getText());
		return normalized === 'unknown' || normalized === 'any' || normalized === 'void' ? undefined : normalized;
	}
	if (ts.isArrayTypeNode(type)) {
		const itemType = typeNodeToResponseTypeName(type.elementType) ?? typeNodeToSchemaType(type.elementType);
		return itemType && itemType !== 'unknown' && itemType !== 'any' && itemType !== 'void' ? `${itemType}[]` : undefined;
	}
	if (ts.isUnionTypeNode(type)) {
		return type.types
			.map((item) => typeNodeToResponseTypeName(item))
			.find((item): item is string => Boolean(item));
	}
	return undefined;
}

function typeNodeToResponseSchemaString(
	type: ts.TypeNode,
	typeSchemas: Map<string, Record<string, string>>
): string | undefined {
	if (ts.isTypeReferenceNode(type)) {
		const name = type.typeName.getText();
		if (name === 'Promise' && type.typeArguments?.[0]) {
			return typeNodeToResponseSchemaString(type.typeArguments[0], typeSchemas);
		}
		const schema = typeSchemas.get(name);
		if (schema) {
			return JSON.stringify(schema);
		}
		return normalizeTypeName(type.getText());
	}
	if (ts.isArrayTypeNode(type)) {
		return `${typeNodeToSchemaType(type.elementType)}[]`;
	}
	if (ts.isTypeLiteralNode(type)) {
		const schema = membersToSchema(type.members);
		return schema ? JSON.stringify(schema) : 'object';
	}
	if (ts.isUnionTypeNode(type)) {
		const concrete = type.types
			.map((item) => typeNodeToResponseSchemaString(item, typeSchemas))
			.filter((item): item is string => Boolean(item) && item !== 'null' && item !== 'undefined');
		if (concrete.length === 1) {
			return concrete[0];
		}
		const schema = concrete.map((item) => resolveSchemaString(item, typeSchemas) ?? item).find((item) => item.startsWith('{'));
		return schema ?? normalizeTypeName(type.getText());
	}
	return normalizeTypeName(type.getText());
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
	return (
		(ts.isFunctionDeclaration(node)
			|| ts.isFunctionExpression(node)
			|| ts.isArrowFunction(node)
			|| ts.isMethodDeclaration(node))
		&& Boolean(node.body)
	);
}

function findContainingFunctionContext(index: number, contexts: FunctionContext[]): FunctionContext | undefined {
	return contexts.find((context) => index >= context.start && index <= context.end);
}

function findAncestor<T extends ts.Node>(
	node: ts.Node,
	predicate: (value: ts.Node) => value is T
): T | undefined {
	let current = node.parent;
	while (current) {
		if (predicate(current)) {
			return current;
		}
		current = current.parent;
	}
	return undefined;
}

function normalizeDiscoveryOptions(options?: FrontendDiscoveryOptions): DiscoveryOptions {
	const fetchFunctions = new Set(
		(options?.fetchFunctions ?? DEFAULT_FETCH_FUNCTIONS)
			.map((item) => item.trim())
			.filter((item) => item.length > 0)
	);
	const methodClients = new Map<string, Set<string>>();
	for (const item of options?.methodClients ?? DEFAULT_METHOD_CLIENTS) {
		const client = item.client.trim();
		const methods = item.methods.map((method) => method.trim().toLowerCase()).filter((method) => method.length > 0);
		if (client && methods.length > 0) {
			methodClients.set(client, new Set(methods));
		}
	}
	return {
		fetchFunctions,
		methodClients
	};
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
	const normalized = raw.replace(/\s+/g, ' ').trim().replace(/[),.;]+$/, '');
	if (!normalized || normalized === 'unknown' || normalized === 'any' || normalized === 'void') {
		return undefined;
	}
	return normalized;
}

function normalizeHeaderList(headers: string[] | undefined): string[] {
	const normalized = new Map<string, string>();
	for (const header of headers ?? []) {
		const value = header.trim();
		if (value) {
			normalized.set(value.toLowerCase(), value);
		}
	}
	return Array.from(normalized.values()).sort((a, b) => a.localeCompare(b));
}

function mergeHeaderLists(...headers: Array<string[] | undefined>): string[] | undefined {
	const merged = normalizeHeaderList(headers.flatMap((item) => item ?? []));
	return merged.length > 0 ? merged : undefined;
}
