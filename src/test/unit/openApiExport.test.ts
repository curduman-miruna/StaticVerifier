import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenApiDocumentFromEndpoints, type OpenApiEndpoint } from '../../host/export/openApiModel';

function endpoint(partial: Partial<OpenApiEndpoint>): OpenApiEndpoint {
	return {
		side: partial.side ?? 'backend',
		method: partial.method ?? 'GET',
		path: partial.path ?? '/api/users/{param}',
		source: partial.source ?? `${partial.side ?? 'backend'}/src/routes.ts`,
		requestSchema: partial.requestSchema,
		responseSchema: partial.responseSchema,
		requestHeaders: partial.requestHeaders
	};
}

test('buildOpenApiDocumentFromEndpoints emits components, examples, path params, tags, and security', () => {
	const document = buildOpenApiDocumentFromEndpoints([
		endpoint({
			side: 'backend',
			method: 'POST',
			path: '/api/users/{param}',
			source: 'services/auth/routes.ts',
			requestSchema: '{"email":"string","age":"number"}',
			responseSchema: 'ApiResult<UserDto>',
			requestHeaders: ['Authorization', 'X-Request-ID']
		})
	]);

	const operation = document.paths['/api/users/{param1}'].post as Record<string, unknown>;
	assert.deepEqual(document.tags, [{
		name: 'backend:auth',
		description: 'Discovered backend endpoints from services/auth/routes.ts'
	}]);
	assert.deepEqual(operation.tags, ['backend:auth']);
	assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
	assert.deepEqual(document.components.securitySchemes.bearerAuth, { type: 'http', scheme: 'bearer' });
	assert.deepEqual(operation.parameters, [
		{ name: 'param1', in: 'path', required: true, schema: { type: 'string' } },
		{ name: 'X-Request-ID', in: 'header', required: true, schema: { type: 'string' } }
	]);
	assert.deepEqual(document.components.schemas.ApiResult_UserDto, {
		type: 'object',
		description: 'Discovered named schema: ApiResult<UserDto>'
	});
});

test('buildOpenApiDocumentFromEndpoints emits object schema examples', () => {
	const document = buildOpenApiDocumentFromEndpoints([
		endpoint({
			side: 'frontend',
			method: 'GET',
			path: '/api/me',
			source: 'apps/web/api.ts',
			responseSchema: '{"id":"string","active":"boolean","roles":"string[]"}'
		})
	]);

	const operation = document.paths['/api/me'].get as {
		responses: Record<string, { content: Record<string, { example: unknown }> }>;
	};
	assert.deepEqual(operation.responses['200'].content['application/json'].example, {
		id: 'string',
		active: true,
		roles: ['string']
	});
});
