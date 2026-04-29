import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SchemaFieldSourceLocation } from '../../shared/messages';
import type { EndpointContract } from './internalTypes';

type RouteMatch = {
	method: string;
	path: string;
	index: number;
};

type FieldSourceLocation = {
	uri?: string;
	line: number;
	column: number;
};

type SchemaResolver = {
	resolve: (typeName: string | undefined) => string | undefined;
	fieldLocations: (typeName: string | undefined, scope: 'request' | 'response') => SchemaFieldSourceLocation[];
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const FASTAPI_DECORATORS = [...HTTP_METHODS, 'websocket'];
const DEFAULT_FASTAPI_API_PREFIX = '/api/v1';
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

export function extractBackendEndpointsFromCode(text: string, sourcePath?: string): EndpointContract[] {
	const endpoints: EndpointContract[] = [];
	const byKey = new Set<string>();
	const fastApiRouterPrefix = extractFastApiRouterPrefix(text);
	const fileApiPrefix = inferFileApiPrefix(text);
	const schemaResolver = createPythonSchemaResolver(text, sourcePath);

	const addEndpoint = (match: RouteMatch): void => {
		const endpointPath = normalizeEndpointPath(joinPaths(fileApiPrefix, fastApiRouterPrefix, match.path));
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
		const responseType = inferResponseSchema(text, match.index);
		const declaredResponseSchema = schemaResolver.resolve(responseType);
		const inferredResponseSchema = inferReturnedObjectSchema(text, match.index);
		const endpoint: EndpointContract = {
			method,
			path: endpointPath,
			responseSchema: declaredResponseSchema ?? inferredResponseSchema,
			sourceLine: location.line,
			sourceColumn: location.column
		};
		const requestType = inferRequestSchemaType(text, match.index);
		const requestSchema = requestType ? schemaResolver.resolve(requestType) ?? requestType : undefined;
		if (requestSchema) {
			endpoint.requestSchema = requestSchema;
		}
		const fieldLocations = [
			...(requestSchema ? schemaResolver.fieldLocations(requestType, 'request') : []),
			...(declaredResponseSchema ? schemaResolver.fieldLocations(responseType, 'response') : inferReturnedObjectFieldLocations(text, match.index))
		];
		if (fieldLocations.length > 0) {
			endpoint.fieldLocations = fieldLocations;
		}
		const requestHeaders = inferRequiredHeaders(text, match.index);
		if (requestHeaders.length > 0) {
			endpoint.requestHeaders = requestHeaders;
		}
		endpoints.push(endpoint);
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
	const methods = FASTAPI_DECORATORS.map(escapeRegex).join('|');
	const routeRegex = new RegExp(`\\b(?:app|router|server|fastify)\\.(${methods})\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`, 'gi');
	let match: RegExpExecArray | null;
	while ((match = routeRegex.exec(text)) !== null) {
		const method = match[1].toLowerCase() === 'websocket' ? 'WS' : match[1];
		matches.push({
			method,
			path: match[3],
			index: match.index
		});
	}
	return matches;
}

function extractFastApiRouterPrefix(text: string): string {
	const match = text.match(/\brouter\s*=\s*APIRouter\s*\(([\s\S]*?)\)/);
	if (!match) {
		return '';
	}
	const prefixMatch = match[1].match(/\bprefix\s*=\s*(['"`])([^'"`]*)\1/);
	return prefixMatch?.[2] ?? '';
}

function inferFileApiPrefix(text: string): string {
	if (/\bAPIRouter\b/.test(text) && /\bfrom\s+app\.api\.v1\b/.test(text)) {
		return DEFAULT_FASTAPI_API_PREFIX;
	}
	return '';
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
	const responseModelMatch = hint.match(/\bresponse_model\s*=\s*([^,\)\n]+)/);
	const genericMatch = hint.match(/\b(?:Promise|Observable)<\s*([A-Za-z_$][\w$.[\]<>|,\s]*)\s*>/);
	const annotationMatch = hint.match(/\)[ \t]*:[ \t]*([A-Za-z_$][\w$.[\]<>|,\s]*?)[ \t]*(?:=>|\{)/);
	return normalizeTypeName(responseModelMatch?.[1] ?? genericMatch?.[1] ?? annotationMatch?.[1]);
}

function inferReturnedObjectSchema(text: string, routeIndex: number): string | undefined {
	const functionBlock = extractPythonFunctionBlock(text, routeIndex);
	if (!functionBlock) {
		return undefined;
	}
	const returnIndex = functionBlock.indexOf('return');
	if (returnIndex === -1) {
		return undefined;
	}
	const objectStart = functionBlock.indexOf('{', returnIndex);
	if (objectStart === -1) {
		return undefined;
	}
	const objectEnd = findMatchingBrace(functionBlock, objectStart);
	if (objectEnd === -1) {
		return undefined;
	}
	const schema = parsePythonDictSchema(functionBlock.slice(objectStart + 1, objectEnd));
	return Object.keys(schema).length > 0 ? JSON.stringify(schema) : undefined;
}

function inferReturnedObjectFieldLocations(text: string, routeIndex: number): SchemaFieldSourceLocation[] {
	const functionBlock = extractPythonFunctionBlock(text, routeIndex);
	if (!functionBlock) {
		return [];
	}
	const returnIndex = functionBlock.indexOf('return');
	if (returnIndex === -1) {
		return [];
	}
	const objectStart = functionBlock.indexOf('{', returnIndex);
	if (objectStart === -1) {
		return [];
	}
	const objectEnd = findMatchingBrace(functionBlock, objectStart);
	if (objectEnd === -1) {
		return [];
	}
	const blockStart = text.indexOf(functionBlock);
	const dictBodyStart = blockStart + objectStart + 1;
	const dictBody = functionBlock.slice(objectStart + 1, objectEnd);
	const locations: SchemaFieldSourceLocation[] = [];
	const entryRegex = /(['"`])([^'"`]+)\1\s*:/g;
	let match: RegExpExecArray | null;
	while ((match = entryRegex.exec(dictBody)) !== null) {
		const location = offsetToLineColumn(text, dictBodyStart + match.index + 1);
		locations.push({
			uri: '',
			scope: 'response',
			field: match[2],
			line: location.line,
			column: location.column,
			highlightText: match[2]
		});
	}
	return locations;
}

function extractPythonFunctionBlock(text: string, routeIndex: number): string | undefined {
	const functionMatch = /(?:async\s+def|def)\s+\w+\s*\(/g;
	functionMatch.lastIndex = routeIndex;
	const match = functionMatch.exec(text);
	if (!match) {
		return undefined;
	}
	const start = match.index;
	const nextRoute = text.slice(start + 1).search(/\n\s*@(?:router|app)\./);
	return nextRoute === -1 ? text.slice(start) : text.slice(start, start + 1 + nextRoute);
}

function parsePythonDictSchema(dictBody: string): Record<string, string> {
	const schema: Record<string, string> = {};
	const entryRegex = /(['"`])([^'"`]+)\1\s*:\s*([^,\n}]+)/g;
	let match: RegExpExecArray | null;
	while ((match = entryRegex.exec(dictBody)) !== null) {
		schema[match[2]] = pythonExpressionToSchemaType(match[3].trim());
	}
	return schema;
}

function pythonExpressionToSchemaType(expression: string): string {
	if (/^str\s*\(/.test(expression)) {
		return 'string';
	}
	if (/^(?:int|float)\s*\(/.test(expression)) {
		return 'number';
	}
	if (/^bool\s*\(/.test(expression)) {
		return 'boolean';
	}
	if (/^["'`]/.test(expression)) {
		return 'string';
	}
	if (/^(?:True|False)\b/.test(expression)) {
		return 'boolean';
	}
	if (/^\d+(?:\.\d+)?\b/.test(expression)) {
		return 'number';
	}
	if (/\.(?:id|email|username|avatar_url|name)\b/.test(expression)) {
		return 'string';
	}
	return 'unknown';
}

function inferRequestSchemaType(text: string, routeIndex: number): string | undefined {
	const hint = text.slice(routeIndex, Math.min(text.length, routeIndex + 1200));
	const signatureMatch = hint.match(/async\s+def\s+\w+\s*\(([\s\S]*?)\)\s*(?:->|:)/)
		?? hint.match(/def\s+\w+\s*\(([\s\S]*?)\)\s*(?:->|:)/);
	if (!signatureMatch) {
		return undefined;
	}
	for (const parameter of splitTopLevel(signatureMatch[1], ',')) {
		if (/\b(?:Depends|Query|Path|Header|Cookie)\b/.test(parameter)) {
			continue;
		}
		const parsed = parsePythonParameter(parameter);
		if (!parsed || isNonBodyFastApiParameter(parsed.name, parsed.annotation)) {
			continue;
		}
		return parsed.annotation;
	}
	return undefined;
}

function inferRequiredHeaders(text: string, routeIndex: number): string[] {
	const hint = text.slice(routeIndex, Math.min(text.length, routeIndex + 1200));
	const headers = new Set<string>();
	const securityHeaders = collectFastApiSecurityHeaders(text);
	const signatureMatch = hint.match(/async\s+def\s+\w+\s*\(([\s\S]*?)\)\s*(?:->|:)/)
		?? hint.match(/def\s+\w+\s*\(([\s\S]*?)\)\s*(?:->|:)/);
	if (signatureMatch) {
		for (const parameter of splitTopLevel(signatureMatch[1], ',')) {
			const parsed = parsePythonParameter(parameter);
			if (/\bHeader\s*\(/.test(parameter)) {
				headers.add(extractHeaderAlias(parameter) ?? parameterNameToHeader(parsed?.name));
			}
			const dependsName = parameter.match(/\bDepends\s*\(\s*([A-Za-z_]\w*)/)?.[1];
			const securityHeader = dependsName ? securityHeaders.get(dependsName) : undefined;
			if (securityHeader) {
				headers.add(securityHeader);
			}
			if (dependsName && /(?:current_user|auth|token|jwt|oauth|bearer)/i.test(dependsName)) {
				headers.add('Authorization');
			}
		}
	}
	return Array.from(headers).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function collectFastApiSecurityHeaders(text: string): Map<string, string> {
	const headers = new Map<string, string>();
	for (const match of text.matchAll(/\b(\w+)\s*=\s*APIKeyHeader\s*\(([\s\S]*?)\)/g)) {
		const name = match[2].match(/\bname\s*=\s*(['"`])([^'"`]+)\1/)?.[2];
		if (name) {
			headers.set(match[1], name);
		}
	}
	for (const match of text.matchAll(/\b(\w+)\s*=\s*(?:OAuth2PasswordBearer|HTTPBearer)\s*\(/g)) {
		headers.set(match[1], 'Authorization');
	}
	return headers;
}

function extractHeaderAlias(parameter: string): string | undefined {
	return parameter.match(/\b(?:alias|convert_underscores)\s*=\s*(['"`])([^'"`]+)\1/)?.[2]
		?? parameter.match(/\bHeader\s*\(\s*(['"`])([^'"`]+)\1/)?.[2];
}

function parameterNameToHeader(name: string | undefined): string {
	if (!name) {
		return 'Authorization';
	}
	return name.split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join('-');
}

function parsePythonParameter(raw: string): { name: string; annotation: string } | undefined {
	const withoutDefault = splitTopLevel(raw, '=')[0]?.trim() ?? '';
	const separatorIndex = withoutDefault.indexOf(':');
	if (separatorIndex === -1) {
		return undefined;
	}
	const name = withoutDefault.slice(0, separatorIndex).trim();
	const annotation = unwrapPythonAnnotation(normalizeTypeName(withoutDefault.slice(separatorIndex + 1)));
	if (!name || !annotation) {
		return undefined;
	}
	return { name, annotation };
}

function unwrapPythonAnnotation(annotation: string | undefined): string | undefined {
	if (!annotation) {
		return undefined;
	}
	const annotatedMatch = annotation.match(/^Annotated\[(.+)]$/);
	if (annotatedMatch) {
		return normalizeTypeName(splitTopLevel(annotatedMatch[1], ',')[0]);
	}
	return annotation;
}

function isNonBodyFastApiParameter(name: string, annotation: string): boolean {
	if (name === 'self' || name === 'request' || name === 'websocket') {
		return true;
	}
	if (/\b(?:Depends|Query|Path|Header|Cookie|Request|WebSocket|BackgroundTasks|Response)\b/.test(annotation)) {
		return true;
	}
	return /^(?:str|int|float|bool|UUID|Optional\[UUID\]|list\[UUID\]|List\[UUID\])$/.test(annotation);
}

function createPythonSchemaResolver(text: string, sourcePath: string | undefined): SchemaResolver {
	const localSchemas = collectPythonClassSchemas(text);
	const importedSchemas = sourcePath ? collectImportedPythonSchemas(text, sourcePath) : new Map<string, Record<string, string>>();
	const allSchemas = new Map([...importedSchemas, ...localSchemas]);
	const localLocations = collectPythonClassFieldLocations(text);
	const importedLocations = sourcePath ? collectImportedPythonFieldLocations(text, sourcePath) : new Map<string, Map<string, FieldSourceLocation>>();
	const allLocations = new Map([...importedLocations, ...localLocations]);
	return {
		resolve: (typeName) => {
			const normalized = normalizeTypeName(typeName);
			if (!normalized) {
				return undefined;
			}
			const unwrapped = unwrapPythonAnnotation(normalized) ?? normalized;
			const schema = resolvePythonSchemaShape(unwrapped, allSchemas);
			return schema ? JSON.stringify(schema) : unwrapped;
		},
		fieldLocations: (typeName, scope) => {
			const normalized = normalizeTypeName(typeName);
			if (!normalized) {
				return [];
			}
			const unwrapped = unwrapPythonAnnotation(normalized) ?? normalized;
			return resolvePythonSchemaFieldLocations(unwrapped, scope, allSchemas, allLocations);
		}
	};
}

function resolvePythonSchemaFieldLocations(
	typeName: string,
	scope: 'request' | 'response',
	schemas: Map<string, Record<string, string>>,
	locations: Map<string, Map<string, FieldSourceLocation>>,
	seen: Set<string> = new Set(),
	prefix = ''
): SchemaFieldSourceLocation[] {
	const baseType = unwrapPythonCollectionType(typeName);
	const schema = schemas.get(baseType);
	if (!schema || seen.has(baseType)) {
		return [];
	}
	const nextSeen = new Set(seen);
	nextSeen.add(baseType);
	const result: SchemaFieldSourceLocation[] = [];
	const modelLocations = locations.get(baseType);
	for (const [fieldName, fieldType] of Object.entries(schema)) {
		const fieldPath = prefix ? `${prefix}.${fieldName}` : fieldName;
		const source = modelLocations?.get(fieldName);
		if (source) {
			result.push({
				uri: source.uri ?? '',
				scope,
				field: fieldPath,
				line: source.line,
				column: source.column,
				highlightText: fieldName
			});
		}
		const nested = getNestedPythonModelType(fieldType);
		if (nested) {
			const nestedPrefix = nested.isArray ? `${fieldPath}[]` : fieldPath;
			result.push(...resolvePythonSchemaFieldLocations(nested.typeName, scope, schemas, locations, nextSeen, nestedPrefix));
		}
	}
	return result;
}

function unwrapPythonCollectionType(typeName: string): string {
	const normalized = normalizeTypeName(typeName) ?? typeName.trim();
	const listMatch = normalized.match(/^(?:list|List)\[(.+)]$/);
	if (listMatch) {
		return unwrapPythonCollectionType(listMatch[1]);
	}
	return normalized.replace(/\[\]$/, '').trim();
}

function resolvePythonSchemaShape(
	typeName: string,
	schemas: Map<string, Record<string, string>>,
	seen: Set<string> = new Set()
): Record<string, string> | undefined {
	const direct = schemas.get(typeName);
	if (direct) {
		return expandPythonSchemaShape(typeName, direct, schemas, seen);
	}
	const listMatch = typeName.match(/^(?:list|List)\[(.+)]$/);
	const itemType = listMatch?.[1]?.trim();
	const itemSchema = itemType ? schemas.get(itemType) : undefined;
	return itemType && itemSchema ? expandPythonSchemaShape(itemType, itemSchema, schemas, seen) : undefined;
}

function expandPythonSchemaShape(
	typeName: string,
	schema: Record<string, string>,
	schemas: Map<string, Record<string, string>>,
	seen: Set<string>
): Record<string, string> {
	if (seen.has(typeName)) {
		return schema;
	}
	const nextSeen = new Set(seen);
	nextSeen.add(typeName);
	const expanded: Record<string, string> = { ...schema };
	for (const [fieldName, fieldType] of Object.entries(schema)) {
		const nested = getNestedPythonModelType(fieldType);
		if (!nested || nextSeen.has(nested.typeName)) {
			continue;
		}
		const nestedSchema = schemas.get(nested.typeName);
		if (!nestedSchema) {
			continue;
		}
		const nestedExpanded = expandPythonSchemaShape(nested.typeName, nestedSchema, schemas, nextSeen);
		const prefix = nested.isArray ? `${fieldName}[]` : fieldName;
		for (const [nestedFieldName, nestedFieldType] of Object.entries(nestedExpanded)) {
			expanded[`${prefix}.${nestedFieldName}`] = nestedFieldType;
		}
	}
	return expanded;
}

function getNestedPythonModelType(typeName: string): { typeName: string; isArray: boolean } | undefined {
	const normalized = normalizeTypeName(typeName) ?? typeName.trim();
	const arraySuffix = normalized.match(/^(.+)\[\]$/);
	if (arraySuffix) {
		const inner = arraySuffix[1].trim();
		return /^[A-Z]\w+$/.test(inner) ? { typeName: inner, isArray: true } : undefined;
	}
	const listMatch = normalized.match(/^(?:list|List)\[(.+)]$/);
	if (listMatch) {
		const inner = pythonTypeToSchemaType(listMatch[1]);
		return getNestedPythonModelType(`${inner}[]`);
	}
	return /^[A-Z]\w+$/.test(normalized) ? { typeName: normalized, isArray: false } : undefined;
}

function collectPythonClassSchemas(text: string): Map<string, Record<string, string>> {
	const schemas = new Map<string, Record<string, string>>();
	const classRegex = /(?:^|\n)class\s+(\w+)\([^)]*(?:BaseModel|Schema)[^)]*\):([\s\S]*?)(?=\nclass\s+\w+\(|$)/g;
	let match: RegExpExecArray | null;
	while ((match = classRegex.exec(text)) !== null) {
		const schema = parsePythonFields(match[2]);
		if (Object.keys(schema).length > 0) {
			schemas.set(match[1], schema);
		}
	}
	return schemas;
}

function collectPythonClassFieldLocations(text: string, sourcePath?: string): Map<string, Map<string, FieldSourceLocation>> {
	const locations = new Map<string, Map<string, FieldSourceLocation>>();
	const classRegex = /(?:^|\n)class\s+(\w+)\([^)]*(?:BaseModel|Schema)[^)]*\):([\s\S]*?)(?=\nclass\s+\w+\(|$)/g;
	let match: RegExpExecArray | null;
	while ((match = classRegex.exec(text)) !== null) {
		const classLocations = new Map<string, FieldSourceLocation>();
		const classBody = match[2];
		const classBodyStart = match.index + match[0].indexOf(classBody);
		const fieldRegex = /^(\s{4,})(\w+)\s*:/gm;
		let fieldMatch: RegExpExecArray | null;
		while ((fieldMatch = fieldRegex.exec(classBody)) !== null) {
			const fieldName = fieldMatch[2];
			if (fieldName.startsWith('_')) {
				continue;
			}
			const location = offsetToLineColumn(text, classBodyStart + fieldMatch.index + fieldMatch[1].length);
			classLocations.set(fieldName, {
				uri: sourcePath ? pathToFileUri(sourcePath) : undefined,
				line: location.line,
				column: location.column
			});
		}
		if (classLocations.size > 0) {
			locations.set(match[1], classLocations);
		}
	}
	return locations;
}

function collectImportedPythonSchemas(
	text: string,
	sourcePath: string,
	visited: Set<string> = new Set()
): Map<string, Record<string, string>> {
	const schemas = new Map<string, Record<string, string>>();
	const appRoot = findPythonAppRoot(sourcePath);
	if (!appRoot) {
		return schemas;
	}
	for (const match of text.matchAll(/^\s*from\s+(app\.[\w.]+)\s+import\s+(.+)$/gm)) {
		const modulePath = path.join(appRoot, ...match[1].split('.').slice(1)) + '.py';
		if (!fs.existsSync(modulePath)) {
			continue;
		}
		if (visited.has(modulePath)) {
			continue;
		}
		visited.add(modulePath);
		const importedNames = match[2].split(',').map((item) => item.trim().split(/\s+as\s+/)[0]).filter(Boolean);
		let moduleText = '';
		try {
			moduleText = fs.readFileSync(modulePath, 'utf8');
		} catch {
			continue;
		}
		const moduleSchemas = collectPythonClassSchemas(moduleText);
		for (const [name, schema] of moduleSchemas) {
			schemas.set(name, schema);
		}
		for (const name of importedNames) {
			const schema = moduleSchemas.get(name);
			if (schema) {
				schemas.set(name, schema);
			}
		}
		for (const [name, schema] of collectImportedPythonSchemas(moduleText, modulePath, visited)) {
			schemas.set(name, schema);
		}
	}
	return schemas;
}

function collectImportedPythonFieldLocations(
	text: string,
	sourcePath: string,
	visited: Set<string> = new Set()
): Map<string, Map<string, FieldSourceLocation>> {
	const locations = new Map<string, Map<string, FieldSourceLocation>>();
	const appRoot = findPythonAppRoot(sourcePath);
	if (!appRoot) {
		return locations;
	}
	for (const match of text.matchAll(/^\s*from\s+(app\.[\w.]+)\s+import\s+(.+)$/gm)) {
		const modulePath = path.join(appRoot, ...match[1].split('.').slice(1)) + '.py';
		if (!fs.existsSync(modulePath) || visited.has(modulePath)) {
			continue;
		}
		visited.add(modulePath);
		let moduleText = '';
		try {
			moduleText = fs.readFileSync(modulePath, 'utf8');
		} catch {
			continue;
		}
		for (const [name, fieldLocations] of collectPythonClassFieldLocations(moduleText, modulePath)) {
			locations.set(name, fieldLocations);
		}
		for (const [name, fieldLocations] of collectImportedPythonFieldLocations(moduleText, modulePath, visited)) {
			locations.set(name, fieldLocations);
		}
	}
	return locations;
}

function pathToFileUri(filePath: string): string {
	return `file:///${path.resolve(filePath).replace(/\\/g, '/')}`;
}

function parsePythonFields(classBody: string): Record<string, string> {
	const schema: Record<string, string> = {};
	for (const line of classBody.split(/\r?\n/)) {
		const match = line.match(/^\s{4,}(\w+)\s*:\s*([^=#\n]+)/);
		if (!match || match[1].startsWith('_')) {
			continue;
		}
		schema[match[1]] = pythonTypeToSchemaType(match[2].trim());
	}
	return schema;
}

function pythonTypeToSchemaType(typeName: string): string {
	const normalized = normalizeTypeName(typeName) ?? typeName.trim();
	if (normalized.includes('|')) {
		return normalized.split('|').map((item) => pythonTypeToSchemaType(item.trim())).filter((item) => item !== 'null' && item !== 'None').join(' | ');
	}
	const optionalMatch = normalized.match(/^(?:Optional|Union)\[(.+)]$/);
	if (optionalMatch) {
		return optionalMatch[1].split(',').map((item) => pythonTypeToSchemaType(item.trim())).filter((item) => item !== 'null' && item !== 'None').join(' | ');
	}
	const listMatch = normalized.match(/^(?:list|List)\[(.+)]$/);
	if (listMatch) {
		return `${pythonTypeToSchemaType(listMatch[1])}[]`;
	}
	const mapping: Record<string, string> = {
		str: 'string',
		int: 'integer',
		float: 'number',
		bool: 'boolean',
		UUID: 'string',
		EmailStr: 'string',
		AnyUrl: 'string',
		HttpUrl: 'string',
		datetime: 'datetime',
		date: 'date'
	};
	return mapping[normalized] ?? normalized;
}

function splitTopLevel(value: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === '[' || char === '(' || char === '{') {
			depth += 1;
		} else if (char === ']' || char === ')' || char === '}') {
			depth = Math.max(0, depth - 1);
		} else if (char === separator && depth === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

function findPythonAppRoot(sourcePath: string): string | undefined {
	const parts = path.normalize(sourcePath).split(path.sep);
	const appIndex = parts.lastIndexOf('app');
	if (appIndex === -1) {
		return undefined;
	}
	return parts.slice(0, appIndex + 1).join(path.sep);
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

function joinPaths(...parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join('/')
		.replace(/\/+/g, '/');
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
