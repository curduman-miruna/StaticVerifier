import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFrontendEndpointsFromCode } from '../../host/contracts/frontendApiExtractor';

function stripLocation<T extends { sourceLine?: number; sourceColumn?: number }>(item: T): Omit<T, 'sourceLine' | 'sourceColumn'> {
	const { sourceLine: _line, sourceColumn: _column, ...rest } = item;
	return rest;
}

function assertHasLocation(item: { sourceLine?: number; sourceColumn?: number }): void {
	assert.equal(typeof item.sourceLine, 'number');
	assert.equal(typeof item.sourceColumn, 'number');
	assert.ok((item.sourceLine ?? 0) > 0);
	assert.ok((item.sourceColumn ?? 0) > 0);
}

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
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
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
	endpoints.forEach(assertHasLocation);

	assert.equal(endpoints.length, 1);
	assert.deepEqual(stripLocation(endpoints[0]), {
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
	endpoints.forEach(assertHasLocation);

	assert.equal(endpoints.length, 1);
	assert.deepEqual(stripLocation(endpoints[0]), {
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
	endpoints.forEach(assertHasLocation);

	assert.equal(endpoints.length, 2);
	assert.deepEqual(stripLocation(endpoints[0]), { method: 'GET', path: '/api/unknown', responseSchema: undefined });
	assert.deepEqual(stripLocation(endpoints[1]), { method: 'GET', path: '/api/any', responseSchema: undefined });
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
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
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
	endpoints.forEach(assertHasLocation);

	assert.equal(endpoints.length, 2);
	assert.deepEqual(stripLocation(endpoints[0]), { method: 'GET', path: '/api/user', responseSchema: 'UserA' });
	assert.deepEqual(stripLocation(endpoints[1]), { method: 'GET', path: '/api/user', responseSchema: 'UserB' });
});

test('supports configurable fetch function names', () => {
	const source = `
		async function load(): Promise<CustomResponse> {
			await request('/api/custom', { method: 'POST' });
			await fetch('/api/default');
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source, {
		fetchFunctions: ['request']
	});
	endpoints.forEach(assertHasLocation);

	assert.equal(endpoints.length, 1);
	assert.deepEqual(stripLocation(endpoints[0]), {
		method: 'POST',
		path: '/api/custom',
		responseSchema: 'CustomResponse'
	});
});

test('supports configurable method-client signatures', () => {
	const source = `
		async function run(): Promise<ResultDto> {
			await sdk.send('/api/submit');
			await sdk.query('/api/list');
			await sdk.delete('/api/remove');
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source, {
		methodClients: [
			{ client: 'sdk', methods: ['send', 'query'] }
		]
	});
	endpoints.forEach(assertHasLocation);

	assert.equal(endpoints.length, 2);
	assert.deepEqual(stripLocation(endpoints[0]), { method: 'SEND', path: '/api/submit', responseSchema: 'ResultDto' });
	assert.deepEqual(stripLocation(endpoints[1]), { method: 'QUERY', path: '/api/list', responseSchema: 'ResultDto' });
});

test('extracts constant, concatenated, and template literal paths', () => {
	const source = `
		const root = '/api';
		const users = root + '/users';
		const id = '42';

		async function load(): Promise<UserDto> {
			await fetch(users);
			await fetch(\`\${root}/users/\${id}\`);
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/users', responseSchema: 'UserDto' },
		{ method: 'GET', path: '/api/users/42', responseSchema: 'UserDto' }
	]);
});

test('extracts fetch Request objects and generic response schemas', () => {
	const source = `
		async function load() {
			await fetch(new Request('/api/users', { method: 'DELETE' })) as DeleteResult;
			await fetchJson<UserDto>('/api/users/1');
			await axios.get<UserDto[]>('/api/users');
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'DELETE', path: '/api/users', responseSchema: 'DeleteResult' },
		{ method: 'GET', path: '/api/users/1', responseSchema: 'UserDto' },
		{ method: 'GET', path: '/api/users', responseSchema: 'UserDto[]' }
	]);
});

test('infers request schemas from fetch and client bodies', () => {
	const source = `
		const payload = {} as CreateUserRequest;

		async function save(): Promise<UserDto> {
			await fetch('/api/users', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			await axios.patch<UserDto, UpdateUserRequest>('/api/users/1', {} as UpdateUserRequest);
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'POST', path: '/api/users', requestSchema: 'CreateUserRequest', responseSchema: 'UserDto' },
		{ method: 'PATCH', path: '/api/users/1', requestSchema: 'UpdateUserRequest', responseSchema: 'UserDto' }
	]);
});

test('extracts env-prefixed fetch URLs and strips query strings', () => {
	const source = `
		const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

		export interface AuthUser {
			id: string;
			email: string;
		}

		export async function fetchCurrentUser(): Promise<AuthUser | null> {
			const res = await fetch(\`\${API_URL}/api/v1/auth/me\`, {
				method: 'GET',
				credentials: 'include'
			});
			return (await res.json()) as AuthUser;
		}

		export async function updateUsername(newUsername: string): Promise<{ username: string }> {
			const res = await fetch(
				\`\${API_URL}/api/v1/users/me/username?new_username=\${encodeURIComponent(newUsername)}\`,
				{ method: 'PUT', credentials: 'include' }
			);
			return res.json();
		}

		export async function logout(): Promise<void> {
			await fetch(\`\${API_URL}/api/v1/auth/logout\`, {
				method: 'POST',
				credentials: 'include'
			});
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/v1/auth/me', responseSchema: 'AuthUser | null' },
		{ method: 'PUT', path: '/api/v1/users/me/username', responseSchema: '{ username: string }' },
		{ method: 'POST', path: '/api/v1/auth/logout', responseSchema: undefined }
	]);
});

test('keeps unresolved template path segments as route parameters', () => {
	const source = `
		const API_BASE = import.meta.env.VITE_API_URL;

		async function loadHistory(conversationId: string): Promise<MessagePage> {
			await fetch(\`\${API_BASE}/api/v1/conversations/\${conversationId}/messages?limit=50\`);
		}

		async function openFriend(contact: Contact): Promise<Conversation> {
			await fetch(\`\${API_BASE}/api/v1/friends/\${contact.otherUserId}/conversation\`);
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/v1/conversations/{conversationId}/messages', responseSchema: 'MessagePage' },
		{ method: 'GET', path: '/api/v1/friends/{otherUserId}/conversation', responseSchema: 'Conversation' }
	]);
});

test('extracts websocket endpoints from class URL wrappers', () => {
	const source = `
		class WsClient {
			private ws: WebSocket | null = null;
			private url: string;

			constructor() {
				const apiBase = import.meta.env.VITE_API_URL as string | undefined;
				if (apiBase) {
					const api = new URL(apiBase);
					const protocol = api.protocol === 'https:' ? 'wss' : 'ws';
					this.url = \`\${protocol}://\${api.host}/ws\`;
					return;
				}
				const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
				this.url = \`\${protocol}://\${window.location.host}/ws\`;
			}

			connect(token?: string): Promise<void> {
				let url = this.url;
				if (token) {
					url = \`\${url}?token=\${encodeURIComponent(token)}\`;
				}
				this.ws = new WebSocket(url);
				return Promise.resolve();
			}
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'WS', path: '/ws', responseSchema: undefined }
	]);
});
