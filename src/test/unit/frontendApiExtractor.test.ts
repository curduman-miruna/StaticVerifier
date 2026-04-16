import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFrontendEndpointsFromCode } from '../../host/contracts/frontendApiExtractor';

test('extracts fetch and axios endpoints with inferred methods', () => {
	const source = `
		async function loadUser(): Promise<UserResponse> {
			const result = await fetch('/api/user/42');
			const other = await fetch('/api/user', { method: 'POST' });
			const list = await axios.get('/api/users');
			return result as UserResponse;
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);

	assert.deepEqual(endpoints, [
		{ method: 'GET', path: '/api/user/42', responseSchema: 'UserResponse' },
		{ method: 'POST', path: '/api/user', responseSchema: 'UserResponse' },
		{ method: 'GET', path: '/api/users', responseSchema: 'UserResponse' }
	]);
});

test('prefers explicit cast response type and ignores invalid paths', () => {
	const source = `
		export async function save(): Promise<ServerFallback> {
			const response = await fetchJson('/api/orders', { method: 'PATCH' }) as ApiResult<Order>;
			const ignored = await fetch('relative/path');
			return response;
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);

	assert.equal(endpoints.length, 1);
	assert.deepEqual(endpoints[0], {
		method: 'PATCH',
		path: '/api/orders',
		responseSchema: 'ApiResult<Order>'
	});
});

test('deduplicates identical API calls', () => {
	const source = `
		async function fetchData(): Promise<User[]> {
			await fetch('/api/users');
			await fetch('/api/users');
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);

	assert.equal(endpoints.length, 1);
	assert.deepEqual(endpoints[0], {
		method: 'GET',
		path: '/api/users',
		responseSchema: 'User[]'
	});
});
