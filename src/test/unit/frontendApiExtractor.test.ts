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

test('ignores unknown and any return types as response schema', () => {
	const source = `
		async function loadUnknown(): Promise<unknown> {
			await fetch('/api/unknown');
		}

		const loadAny = async (): Promise<any> => {
			await fetch('/api/any');
		};
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);

	assert.equal(endpoints.length, 2);
	assert.deepEqual(endpoints[0], { method: 'GET', path: '/api/unknown', responseSchema: undefined });
	assert.deepEqual(endpoints[1], { method: 'GET', path: '/api/any', responseSchema: undefined });
});

test('extracts multiple client methods and normalizes method casing', () => {
	const source = `
		async function run(): Promise<ResultModel> {
			await http.delete('/api/items/1');
			await ky.options('/api/items');
			await client.patch('/api/items/2');
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);

	assert.deepEqual(endpoints, [
		{ method: 'DELETE', path: '/api/items/1', responseSchema: 'ResultModel' },
		{ method: 'OPTIONS', path: '/api/items', responseSchema: 'ResultModel' },
		{ method: 'PATCH', path: '/api/items/2', responseSchema: 'ResultModel' }
	]);
});

test('keeps endpoints when method/path match but response schema differs', () => {
	const source = `
		async function a(): Promise<UserA> {
			await fetch('/api/user');
		}
		async function b(): Promise<UserB> {
			await fetch('/api/user');
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);

	assert.equal(endpoints.length, 2);
	assert.deepEqual(endpoints[0], { method: 'GET', path: '/api/user', responseSchema: 'UserA' });
	assert.deepEqual(endpoints[1], { method: 'GET', path: '/api/user', responseSchema: 'UserB' });
});
