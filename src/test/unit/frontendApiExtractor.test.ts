import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFrontendEndpointsFromCode } from '../../host/contracts/frontendApiExtractor';

function stripLocation<T extends { sourceLine?: number; sourceColumn?: number; fieldLocations?: unknown }>(
	item: T
): Omit<T, 'sourceLine' | 'sourceColumn' | 'fieldLocations'> {
	const { sourceLine: _line, sourceColumn: _column, fieldLocations: _fieldLocations, ...rest } = item;
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
		{ method: 'GET', path: '/api/v1/auth/me', responseSchema: '{"id":"string","email":"string"}', requestHeaders: ['Authorization'] },
		{ method: 'PUT', path: '/api/v1/users/me/username', responseSchema: '{"username":"string"}', requestHeaders: ['Authorization'] },
		{ method: 'POST', path: '/api/v1/auth/logout', responseSchema: undefined, requestHeaders: ['Authorization'] }
	]);
	assert.deepEqual(endpoints.map((endpoint) => endpoint.requestHeaders), [
		['Authorization'],
		['Authorization'],
		['Authorization']
	]);
});

test('discovers request headers from fetch and axios config', () => {
	const source = `
		const authHeaders = {
			Authorization: \`Bearer \${token}\`,
			'X-API-Key': apiKey
		};

		async function run(): Promise<void> {
			await fetch('/api/private', { headers: authHeaders });
			await axios.post('/api/items', { name: 'item' }, { headers: { Authorization: token } });
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/private', responseSchema: undefined, requestHeaders: ['Authorization', 'X-API-Key'] },
		{ method: 'POST', path: '/api/items', requestSchema: '{"name":"string"}', responseSchema: undefined, requestHeaders: ['Authorization'] }
	]);
});

test('discovers authorization handled by shared frontend clients', () => {
	const source = `
		const api = axios.create({ baseURL: '/api', withCredentials: true });
		api.interceptors.request.use((config) => {
			config.headers.Authorization = \`Bearer \${token}\`;
			return config;
		});

		async function run(): Promise<void> {
			await api.get('/api/me');
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/me', responseSchema: undefined, requestHeaders: ['Authorization'] }
	]);
});

test('resolves TypeScript type declarations and inline request bodies to field schemas', () => {
	const source = `
		type CreateUserRequest = {
			email: string;
			username?: string;
			age: number;
		};

		interface UserResponse {
			id: string;
			email: string;
			active: boolean;
			roles: string[];
		}

		async function createUser(payload: CreateUserRequest): Promise<UserResponse> {
			await fetch('/api/users', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			await fetch('/api/users/preview', {
				method: 'POST',
				body: JSON.stringify({ email: payload.email, active: true, attempts: 1 })
			});
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'POST',
			path: '/api/users',
			requestSchema: '{"email":"string","username":"string","age":"number"}',
			responseSchema: '{"id":"string","email":"string","active":"boolean","roles":"string[]"}'
		},
		{
			method: 'POST',
			path: '/api/users/preview',
			requestSchema: '{"email":"unknown","active":"boolean","attempts":"number"}',
			responseSchema: '{"id":"string","email":"string","active":"boolean","roles":"string[]"}'
		}
	]);
	assert.deepEqual(
		endpoints[0].fieldLocations?.filter(({ scope }) => scope === 'response').map(({ scope, field, line, highlightText }) => ({ scope, field, line, highlightText })),
		[
			{ scope: 'response', field: 'id', line: 9, highlightText: 'id' },
			{ scope: 'response', field: 'email', line: 10, highlightText: 'email' },
			{ scope: 'response', field: 'active', line: 11, highlightText: 'active' },
			{ scope: 'response', field: 'roles', line: 12, highlightText: 'roles' }
		]
	);
});

test('infers schemas from unannotated object payload variables and inline response types', () => {
	const source = `
		async function createGroup(participantIds: string[], groupName: string): Promise<{ id: string; members: string[] }> {
			const payload = {
				participantIds,
				groupName,
				created: new Date().toISOString(),
				private: false
			};

			await fetch('/api/v1/conversations/group', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
		}
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'POST',
			path: '/api/v1/conversations/group',
			requestSchema: '{"participantIds":"string[]","groupName":"string","created":"string","private":"boolean"}',
			responseSchema: '{"id":"string","members":"string[]"}'
		}
	]);
});

test('infers inline JSON body fields from useCallback handlers', () => {
	const source = `
		const API_BASE = import.meta.env.VITE_API_URL;
		const handleCreateGroup = useCallback(
			async (groupName: string, memberIds: string[]) => {
				const res = await fetch(\`\${API_BASE}/api/v1/conversations/group\`, {
					method: 'POST',
					credentials: 'include',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						groupName,
						participantIds: memberIds,
					}),
				});
				const data = await res.json();
				return data;
			},
			[]
		);
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'POST',
			path: '/api/v1/conversations/group',
			requestSchema: '{"groupName":"string","participantIds":"string[]"}',
			responseSchema: undefined,
			requestHeaders: ['Authorization', 'Content-Type']
		}
	]);
});

test('infers response fields from json unpacking after the fetch call', () => {
	const source = `
		const API_BASE = import.meta.env.VITE_API_URL;
		const handleCreateGroup = useCallback(
			async (groupName: string, memberIds: string[]) => {
				const res = await fetch(\`\${API_BASE}/api/v1/conversations/group\`, {
					method: 'POST',
					body: JSON.stringify({
						groupName,
						participantIds: memberIds,
					}),
				});
				const data = await res.json();
				const convId = String(data.id);
				const createdAt = data.created_at ? new Date(data.created_at) : new Date();
				setFriendsList((prev) => [
					{
						id: convId,
						name: data.name || groupName,
						isGroup: Boolean(data.is_group),
					},
					...prev,
				]);
				return createdAt;
			},
			[]
		);
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'POST',
			path: '/api/v1/conversations/group',
			requestSchema: '{"groupName":"string","participantIds":"string[]"}',
			responseSchema: '{"id":"string","created_at":"datetime","name":"string","is_group":"boolean"}'
		}
	]);
});

test('infers response fields from json array map item unpacking', () => {
	const source = `
		const API_BASE = import.meta.env.VITE_API_URL;
		const refreshFriendRequests = useCallback(async () => {
			const [incomingRes, outgoingRes] = await Promise.all([
				fetch(\`\${API_BASE}/api/v1/friend-requests/incoming\`, { method: 'GET', credentials: 'include' }),
				fetch(\`\${API_BASE}/api/v1/friend-requests/outgoing\`, { method: 'GET', credentials: 'include' }),
			]);

			if (incomingRes.ok) {
				const incoming = await incomingRes.json();
				setIncomingRequests(
					incoming.map((fr: any) => {
						const user = fr.fromUser || {};
						return {
							requestId: fr.id,
							fromUserId: user.id ? String(user.id) : undefined,
							fromName: user.username || user.email || 'User',
							timestamp: formatTimeLabel(fr.createdAt),
							status: 'pending',
						};
					})
				);
			}

			if (outgoingRes.ok) {
				const outgoing = await outgoingRes.json();
				setSentRequests(
					outgoing.map((fr: any) => {
						const user = fr.toUser || {};
						return {
							requestId: fr.id,
							toUserId: user.id ? String(user.id) : undefined,
							toName: user.username || user.email || 'User',
							timestamp: formatTimeLabel(fr.createdAt),
							status: 'pending',
						};
					})
				);
			}
		}, []);
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'GET',
			path: '/api/v1/friend-requests/incoming',
			responseSchema: '{"fromUser":"unknown","id":"unknown","fromUser.id":"string","fromUser.username":"string","fromUser.email":"string","createdAt":"unknown"}',
			requestHeaders: ['Authorization']
		},
		{
			method: 'GET',
			path: '/api/v1/friend-requests/outgoing',
			responseSchema: '{"toUser":"unknown","id":"unknown","toUser.id":"string","toUser.username":"string","toUser.email":"string","createdAt":"unknown"}',
			requestHeaders: ['Authorization']
		}
	]);
});

test('infers search response aliases from mapped json results', () => {
	const source = `
		const API_BASE = import.meta.env.VITE_API_URL;
		const handleSearchUsers = useCallback(
			async (query: string): Promise<UserSearchResult[]> => {
				const res = await fetch(\`\${API_BASE}/api/v1/users/search?query=\${encodeURIComponent(query)}\`, {
					method: 'GET',
					credentials: 'include',
				});
				const data = await res.json();
				return data.map((u: any) => {
					const avatarUrl = u.avatarUrl || u.avatar_url || null;
					return {
						id: String(u.id),
						name: u.username || u.email,
						username: u.username || '',
						email: u.email || '',
						avatarUrl,
					};
				});
			},
			[]
		);
	`;

	const endpoints = extractFrontendEndpointsFromCode(source);
	endpoints.forEach(assertHasLocation);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'GET',
			path: '/api/v1/users/search',
			responseSchema: '{"avatarUrl":"unknown | null","avatar_url":"unknown | null","id":"string","username":"string","email":"string"}',
			requestHeaders: ['Authorization']
		}
	]);
	assert.deepEqual(
		endpoints[0].fieldLocations?.map(({ scope, field, line }) => ({ scope, field, line })),
		[
			{ scope: 'response', field: 'avatarUrl', line: 11 },
			{ scope: 'response', field: 'avatar_url', line: 11 },
			{ scope: 'response', field: 'id', line: 13 },
			{ scope: 'response', field: 'username', line: 14 },
			{ scope: 'response', field: 'email', line: 14 }
		]
	);
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
		{ method: 'WS', path: '/ws', responseSchema: undefined, requestHeaders: ['Authorization'] }
	]);
});
