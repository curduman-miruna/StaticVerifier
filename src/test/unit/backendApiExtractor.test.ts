import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBackendEndpointsFromCode } from '../../host/contracts/backendApiExtractor';

function stripLocation<T extends { sourceLine?: number; sourceColumn?: number }>(item: T): Omit<T, 'sourceLine' | 'sourceColumn'> {
	const { sourceLine: _line, sourceColumn: _column, ...rest } = item;
	return rest;
}

test('extracts express-style backend routes', () => {
	const source = `
		app.get('/api/users', async (): Promise<UserList> => []);
		router.post('/api/users', createUser);
		fastify.delete('/api/users/:id', deleteUser);
	`;

	const endpoints = extractBackendEndpointsFromCode(source);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/users', responseSchema: 'UserList' },
		{ method: 'POST', path: '/api/users', responseSchema: undefined },
		{ method: 'DELETE', path: '/api/users/:id', responseSchema: undefined }
	]);
	assert.ok(endpoints.every((item) => item.sourceLine && item.sourceColumn));
});

test('extracts fastify route-object declarations', () => {
	const source = `
		server.route({
			method: 'PATCH',
			url: '/api/orders/:id',
			handler: updateOrder
		});
	`;

	const endpoints = extractBackendEndpointsFromCode(source);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'PATCH', path: '/api/orders/:id', responseSchema: undefined }
	]);
});

test('extracts controller decorator routes with prefixes', () => {
	const source = `
		@Controller('/api/users')
		class UsersController {
			@Get(':id')
			findOne(): Promise<UserDto> {
				return this.service.findOne();
			}

			@Post()
			create() {}
		}

		@RequestMapping("/api/orders")
		class OrdersController {
			@DeleteMapping("/{id}")
			remove() {}
		}
	`;

	const endpoints = extractBackendEndpointsFromCode(source);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/users/:id', responseSchema: 'UserDto' },
		{ method: 'POST', path: '/api/users', responseSchema: undefined },
		{ method: 'DELETE', path: '/api/orders/{id}', responseSchema: undefined }
	]);
});

test('extracts FastAPI APIRouter prefixes and websocket routes', () => {
	const source = `
		from fastapi import APIRouter, Depends, WebSocket
		from app.api.v1.deps import get_current_user

		router = APIRouter(prefix="/conversations", tags=["conversations"])

		@router.get("/", response_model=list[ConversationPreview])
		async def list_my_conversations():
			return []

		@router.post("/group", response_model=ConversationRead)
		async def create_group_conversation():
			return {}

		@router.get("/{conversation_id}/messages", response_model=MessagePage)
		async def list_conversation_messages():
			return {}

		@router.websocket("/ws")
		async def websocket_endpoint(websocket: WebSocket):
			return None
	`;

	const endpoints = extractBackendEndpointsFromCode(source);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/api/v1/conversations', responseSchema: 'list[ConversationPreview]' },
		{ method: 'POST', path: '/api/v1/conversations/group', responseSchema: 'ConversationRead' },
		{ method: 'GET', path: '/api/v1/conversations/{conversation_id}/messages', responseSchema: 'MessagePage' },
		{ method: 'WS', path: '/api/v1/conversations/ws', responseSchema: undefined }
	]);
});
