import assert from 'node:assert/strict';
import test from 'node:test';
import { baseHintTokens, cleanSelectedEndpointText, parseSelectedEndpointText } from '../../host/navigation/endpointSelection';
import { normalizeEndpointMethod, normalizeEndpointPath } from '../../host/verification/endpointNormalization';

test('normalizeEndpointPath matches verifier path comparison rules', () => {
	assert.equal(normalizeEndpointPath('/api/users/:id?expand=true'), '/api/users/{param}');
	assert.equal(normalizeEndpointPath('/api/users/{userId}/'), '/api/users/{param}');
	assert.equal(normalizeEndpointPath('https://example.test/api/users/42'), '/api/users/42');
	assert.equal(normalizeEndpointPath('relative/path'), undefined);
});

test('normalizeEndpointMethod uppercases valid methods', () => {
	assert.equal(normalizeEndpointMethod('get'), 'GET');
	assert.equal(normalizeEndpointMethod('POST'), 'POST');
	assert.equal(normalizeEndpointMethod('bad method'), undefined);
});

test('cleanSelectedEndpointText strips template base url expressions', () => {
	assert.equal(cleanSelectedEndpointText('`${API_URL}/api/v1/auth/me`'), '/api/v1/auth/me');
	assert.equal(cleanSelectedEndpointText('"${baseUrl}/api/users";'), '/api/users');
});

test('cleanSelectedEndpointText extracts endpoint paths from selected code lines', () => {
	assert.equal(
		cleanSelectedEndpointText('const res = await fetch(`${API_URL}/api/v1/auth/me`, {'),
		'/api/v1/auth/me'
	);
	assert.equal(
		cleanSelectedEndpointText("return apiClient.get('/api/users/:id', config);"),
		'/api/users/:id'
	);
});

test('parseSelectedEndpointText extracts paths and methods from selected call blocks', () => {
	assert.deepEqual(
		parseSelectedEndpointText([
			'const res = await fetch(`${API_URL}/api/v1/auth/me`, {',
			"  method: 'POST',",
			'  body: JSON.stringify(payload)',
			'});'
		].join('\n')),
		{
			pathText: '/api/v1/auth/me',
			baseHint: 'API_URL',
			methodHint: 'POST'
		}
	);
	assert.deepEqual(
		parseSelectedEndpointText([
			'const res = await fetch(`${API_URL}/',
			'      api/v1/auth/me`, {',
			"  method: 'GET',",
			"  credentials: 'include',",
			'});'
		].join('\n')),
		{
			pathText: '/api/v1/auth/me',
			baseHint: 'API_URL',
			methodHint: 'GET'
		}
	);
	assert.deepEqual(parseSelectedEndpointText("return apiClient.patch('/api/users/:id', payload);"), {
		pathText: '/api/users/:id',
		methodHint: 'PATCH'
	});
});

test('parseSelectedEndpointText resolves same-file base url constants', () => {
	const documentText = "const AUTH_API_URL = '/auth-service';";

	assert.deepEqual(parseSelectedEndpointText('`${AUTH_API_URL}/api/v1/auth/me`', documentText), {
		pathText: '/auth-service/api/v1/auth/me',
		baseHint: 'AUTH_API_URL',
		methodHint: undefined
	});
});

test('baseHintTokens extracts service words from base url expressions', () => {
	assert.deepEqual(baseHintTokens('AUTH_API_URL'), ['auth']);
	assert.deepEqual(baseHintTokens('import.meta.env.VITE_BILLING_SERVICE_URL'), ['billing', 'service']);
});
