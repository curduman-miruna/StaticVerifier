import ts from 'typescript';
import type { EndpointContract } from './internalTypes';

type FunctionContext = {
	start: number;
	end: number;
	returnType?: string;
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
	const functionContexts: FunctionContext[] = [];
	const endpoints: EndpointContract[] = [];
	const byKey = new Set<string>();

	const addEndpoint = (
		method: string,
		pathValue: string | undefined,
		call: ts.CallExpression | ts.NewExpression,
		requestSchema?: string,
		responseSchema?: string
	): void => {
		if (!pathValue) {
			return;
		}
		const endpointPath = pathValue.trim();
		if (!endpointPath || !(endpointPath.startsWith('/') || endpointPath.startsWith('http://') || endpointPath.startsWith('https://'))) {
			return;
		}

		const normalizedMethod = method.toUpperCase();
		const response = normalizeTypeName(responseSchema) ?? inferResponseSchema(call, functionContexts);
		const request = normalizeTypeName(requestSchema);
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
		endpoints.push(endpoint);
	};

	const visit = (node: ts.Node): void => {
		if (isFunctionLikeWithBody(node)) {
			functionContexts.push({
				start: node.getStart(sourceFile),
				end: node.end,
				returnType: extractReturnType(node)
			});
		}

		if (ts.isCallExpression(node)) {
			const fetchEndpoint = readFetchCall(node, discovery, constants, typeHints);
			if (fetchEndpoint) {
				addEndpoint(
					fetchEndpoint.method,
					fetchEndpoint.path,
					node,
					fetchEndpoint.requestSchema,
					fetchEndpoint.responseSchema
				);
			}

			const clientEndpoint = readMethodClientCall(node, discovery, constants, typeHints);
			if (clientEndpoint) {
				addEndpoint(
					clientEndpoint.method,
					clientEndpoint.path,
					node,
					clientEndpoint.requestSchema,
					clientEndpoint.responseSchema
				);
			}
		}

		if (ts.isNewExpression(node)) {
			for (const websocketPath of readWebSocketCall(node, constants, sourceFile)) {
				addEndpoint('WS', websocketPath, node);
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
	typeHints: Map<string, string>
): { method: string; path?: string; requestSchema?: string; responseSchema?: string } | undefined {
	if (!ts.isIdentifier(node.expression) || !discovery.fetchFunctions.has(node.expression.text)) {
		return undefined;
	}

	const firstArg = node.arguments[0];
	const optionsArg = node.arguments[1];
	const requestFromObject = firstArg ? readRequestObject(firstArg, constants) : undefined;
	const optionsObject = optionsArg && ts.isObjectLiteralExpression(optionsArg) ? optionsArg : undefined;
	const method = requestFromObject?.method ?? readMethodFromOptions(optionsObject, constants) ?? 'GET';
	const requestSchema = readRequestSchemaFromOptions(optionsObject, typeHints) ?? readTypeArgument(node, 1);

	return {
		method,
		path: requestFromObject?.path ?? readEndpointPathExpression(firstArg, constants),
		requestSchema,
		responseSchema: readTypeArgument(node, 0)
	};
}

function readMethodClientCall(
	node: ts.CallExpression,
	discovery: DiscoveryOptions,
	constants: Map<string, string>,
	typeHints: Map<string, string>
): { method: string; path?: string; requestSchema?: string; responseSchema?: string } | undefined {
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
	return {
		method,
		path: readEndpointPathExpression(pathArg, constants),
		requestSchema: METHODS_WITH_BODY.has(method) ? inferRequestBodySchema(bodyArg, typeHints) ?? readTypeArgument(node, 1) : undefined,
		responseSchema: readTypeArgument(node, 0)
	};
}

function readWebSocketCall(
	node: ts.NewExpression,
	constants: Map<string, string>,
	sourceFile: ts.SourceFile
): string[] {
	if (!ts.isIdentifier(node.expression) || node.expression.text !== 'WebSocket') {
		return [];
	}
	const firstArg = node.arguments?.[0];
	const directPath = readEndpointPathExpression(firstArg, constants);
	if (directPath) {
		return [directPath];
	}
	if (!firstArg || !ts.isIdentifier(firstArg)) {
		return [];
	}
	return findClassPropertyEndpointPaths(node, firstArg.text, constants, sourceFile);
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
	typeHints: Map<string, string>
): string | undefined {
	const body = options ? readObjectProperty(options, 'body') : undefined;
	return inferRequestBodySchema(body, typeHints);
}

function inferRequestBodySchema(
	expression: ts.Expression | undefined,
	typeHints: Map<string, string>
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
		return inferRequestBodySchema(expression.arguments[0], typeHints);
	}
	if (ts.isIdentifier(expression)) {
		return normalizeTypeName(typeHints.get(expression.text)) ?? normalizeTypeName(expression.getText());
	}
	if (ts.isPropertyAccessExpression(expression)) {
		return normalizeTypeName(expression.getText());
	}
	return undefined;
}

function inferResponseSchema(node: ts.CallExpression | ts.NewExpression, contexts: FunctionContext[]): string | undefined {
	const explicitCast = findNearbyTypeAssertion(node);
	if (explicitCast) {
		return explicitCast;
	}
	const context = findContainingFunctionContext(node.getStart(), contexts);
	return normalizeTypeName(context?.returnType);
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

function readClientName(expression: ts.Expression): string | undefined {
	if (ts.isIdentifier(expression)) {
		return expression.text;
	}
	return undefined;
}

function readTypeArgument(node: ts.CallExpression, index: number): string | undefined {
	return normalizeTypeName(node.typeArguments?.[index]?.getText());
}

function extractReturnType(node: ts.FunctionLikeDeclaration): string | undefined {
	const raw = node.type?.getText();
	if (!raw) {
		return undefined;
	}
	const promiseMatch = raw.match(/^Promise<(.+)>$/);
	return normalizeTypeName(promiseMatch?.[1] ?? raw);
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
