import type { ContractSide } from '../../shared/contracts';

type JsonObject = Record<string, unknown>;

export type OpenApiEndpoint = {
	side: ContractSide;
	method: string;
	path: string;
	source: string;
	requestSchema?: string;
	responseSchema?: string;
	requestHeaders?: string[];
};

export type OpenApiDocument = {
	openapi: '3.0.3';
	info: { title: string; version: string };
	tags: Array<{ name: string; description?: string }>;
	paths: Record<string, Record<string, unknown>>;
	components: {
		schemas: Record<string, unknown>;
		securitySchemes: Record<string, unknown>;
	};
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const AUTH_HEADER_PATTERN = /^(?:authorization|x-api-key|api-key|x-auth-token|x-access-token)$/i;

export function buildOpenApiDocumentFromEndpoints(endpoints: OpenApiEndpoint[]): OpenApiDocument {
	const document: OpenApiDocument = {
		openapi: '3.0.3',
		info: {
			title: 'StaticVerifier Discovered API',
			version: '0.0.1'
		},
		tags: [],
		paths: {},
		components: {
			schemas: {},
			securitySchemes: {}
		}
	};
	const tags = new Map<string, string>();

	for (const endpoint of endpoints) {
		if (!HTTP_METHODS.has(endpoint.method)) {
			continue;
		}

		const tag = buildTag(endpoint);
		tags.set(tag, `Discovered ${endpoint.side} endpoints from ${endpoint.source}`);
		const path = openApiPath(endpoint.path);
		const pathItem = document.paths[path] ?? {};
		const requestHeaders = endpoint.requestHeaders ?? [];
		const security = collectSecuritySchemes(requestHeaders, document.components.securitySchemes);
		const pathParams = pathParameters(path);
		const regularHeaders = requestHeaders
			.filter((header) => !AUTH_HEADER_PATTERN.test(header))
			.map((header) => headerParameter(header));

		pathItem[endpoint.method.toLowerCase()] = removeUndefined({
			operationId: operationId(endpoint),
			summary: `${endpoint.side.toUpperCase()} ${endpoint.method} ${endpoint.path}`,
			tags: [tag],
			'x-staticverifier-source': endpoint.source,
			parameters: [...pathParams, ...regularHeaders],
			security: security.length > 0 ? security : undefined,
			requestBody: endpoint.requestSchema ? {
				required: true,
				content: {
					'application/json': {
						schema: schemaToOpenApi(endpoint.requestSchema, document.components.schemas),
						example: schemaExample(endpoint.requestSchema)
					}
				}
			} : undefined,
			responses: {
				'200': removeUndefined({
					description: 'OK',
					content: endpoint.responseSchema ? {
						'application/json': {
							schema: schemaToOpenApi(endpoint.responseSchema, document.components.schemas),
							example: schemaExample(endpoint.responseSchema)
						}
					} : undefined
				})
			}
		});
		document.paths[path] = pathItem;
	}

	document.tags = Array.from(tags.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, description]) => ({ name, description }));
	return document;
}

function buildTag(endpoint: OpenApiEndpoint): string {
	const sourceName = endpoint.source
		.split(/[\\/]/)
		.filter(Boolean)
		.at(-2) ?? endpoint.source.split(/[\\/]/).filter(Boolean).at(-1);
	const safeSource = sourceName?.replace(/[^A-Za-z0-9_-]/g, '-');
	return safeSource ? `${endpoint.side}:${safeSource}` : endpoint.side;
}

function operationId(endpoint: OpenApiEndpoint): string {
	return [
		endpoint.side,
		endpoint.method.toLowerCase(),
		...endpoint.path.split('/').filter(Boolean).map((part) => part.replace(/[{}:]/g, 'by_'))
	].join('_').replace(/[^A-Za-z0-9_]/g, '_');
}

function openApiPath(path: string): string {
	let paramIndex = 0;
	return path
		.replace(/\{param}/g, () => `{param${++paramIndex}}`)
		.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function pathParameters(path: string): unknown[] {
	return Array.from(path.matchAll(/\{([^}]+)}/g)).map((match) => ({
		name: match[1],
		in: 'path',
		required: true,
		schema: { type: 'string' }
	}));
}

function headerParameter(header: string): unknown {
	return {
		name: header,
		in: 'header',
		required: true,
		schema: { type: 'string' }
	};
}

function collectSecuritySchemes(headers: string[], schemes: Record<string, unknown>): Array<Record<string, string[]>> {
	const security: Array<Record<string, string[]>> = [];
	for (const header of headers) {
		if (!AUTH_HEADER_PATTERN.test(header)) {
			continue;
		}
		const schemeName = securitySchemeName(header);
		schemes[schemeName] = header.toLowerCase() === 'authorization'
			? { type: 'http', scheme: 'bearer' }
			: { type: 'apiKey', in: 'header', name: header };
		security.push({ [schemeName]: [] });
	}
	return security;
}

function securitySchemeName(header: string): string {
	if (header.toLowerCase() === 'authorization') {
		return 'bearerAuth';
	}
	return header.replace(/(^|-)([a-z])/gi, (_match, _separator: string, char: string) => char.toUpperCase());
}

function schemaToOpenApi(schema: string, components: Record<string, unknown>): unknown {
	const trimmed = schema.trim();
	if (trimmed.startsWith('{')) {
		try {
			return objectSchemaToOpenApi(JSON.parse(trimmed) as Record<string, unknown>);
		} catch {
			return { description: trimmed };
		}
	}
	if (trimmed.endsWith('[]')) {
		return { type: 'array', items: schemaToOpenApi(trimmed.slice(0, -2), components) };
	}
	const componentName = componentSchemaName(trimmed);
	if (componentName && !components[componentName]) {
		components[componentName] = { type: 'object', description: `Discovered named schema: ${trimmed}` };
	}
	return componentName ? { $ref: `#/components/schemas/${componentName}` } : { description: trimmed };
}

function objectSchemaToOpenApi(fields: Record<string, unknown>): unknown {
	return {
		type: 'object',
		properties: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeToSchema(String(value))])),
		required: Object.keys(fields)
	};
}

function componentSchemaName(schema: string): string | undefined {
	const names = Array.from(schema.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)).map((match) => match[0]);
	return names.length > 0 ? names.join('_') : undefined;
}

function schemaExample(schema: string): unknown {
	const trimmed = schema.trim();
	if (trimmed.startsWith('{')) {
		try {
			const fields = JSON.parse(trimmed) as Record<string, unknown>;
			return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, exampleForType(String(value))]));
		} catch {
			return undefined;
		}
	}
	if (trimmed.endsWith('[]')) {
		return [schemaExample(trimmed.slice(0, -2)) ?? {}];
	}
	return {};
}

function typeToSchema(type: string): unknown {
	const normalized = type.toLowerCase();
	if (normalized.endsWith('[]')) {
		return { type: 'array', items: typeToSchema(type.slice(0, -2)) };
	}
	if (normalized.includes('number') || normalized.includes('int') || normalized.includes('float') || normalized.includes('double')) {
		return { type: 'number' };
	}
	if (normalized.includes('bool')) {
		return { type: 'boolean' };
	}
	if (normalized.includes('object')) {
		return { type: 'object' };
	}
	return { type: 'string' };
}

function exampleForType(type: string): unknown {
	const normalized = type.toLowerCase();
	if (normalized.endsWith('[]')) {
		return [exampleForType(type.slice(0, -2))];
	}
	if (normalized.includes('number') || normalized.includes('int') || normalized.includes('float') || normalized.includes('double')) {
		return 1;
	}
	if (normalized.includes('bool')) {
		return true;
	}
	if (normalized.includes('object')) {
		return {};
	}
	if (normalized.includes('null')) {
		return null;
	}
	return 'string';
}

function removeUndefined(value: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
