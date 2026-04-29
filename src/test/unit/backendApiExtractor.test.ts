import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { extractBackendEndpointsFromCode } from '../../host/contracts/backendApiExtractor';

function stripLocation<T extends { sourceLine?: number; sourceColumn?: number; fieldLocations?: unknown }>(
	item: T
): Omit<T, 'sourceLine' | 'sourceColumn' | 'fieldLocations'> {
	const { sourceLine: _line, sourceColumn: _column, fieldLocations: _fieldLocations, ...rest } = item;
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

test('resolves FastAPI request and response schemas from local Pydantic imports', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staticverifier-schema-'));
	const schemaDir = path.join(root, 'app', 'schemas', 'conversation');
	const routerDir = path.join(root, 'app', 'api', 'v1', 'routers');
	fs.mkdirSync(schemaDir, { recursive: true });
	fs.mkdirSync(routerDir, { recursive: true });
	fs.writeFileSync(path.join(schemaDir, 'conversation_create.py'), `
from pydantic import BaseModel
from typing import List, Optional
from uuid import UUID

class ConversationCreate(BaseModel):
    group_name: str
    participant_ids: List[UUID]
    topic: Optional[str] = None
`);
fs.writeFileSync(path.join(schemaDir, 'conversation_read.py'), `
from pydantic import BaseModel
from typing import List

class ConversationMemberRead(BaseModel):
    id: UUID
    username: str
    role: str

class ConversationRead(BaseModel):
    id: UUID
    name: str
    is_group: bool
    members: List[ConversationMemberRead]
`);
	const routerPath = path.join(routerDir, 'conversations_router.py');
	const source = `
from fastapi import APIRouter, Depends
from app.api.v1.deps import get_current_user
from app.schemas.conversation.conversation_create import ConversationCreate
from app.schemas.conversation.conversation_read import ConversationRead

router = APIRouter(prefix="/conversations")

@router.post("/group", response_model=ConversationRead)
async def create_group_conversation(
    body: ConversationCreate,
    current_user = Depends(get_current_user),
):
    return {}
`;

	const endpoints = extractBackendEndpointsFromCode(source, routerPath);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'POST',
			path: '/api/v1/conversations/group',
			requestHeaders: ['Authorization'],
			requestSchema: '{"group_name":"string","participant_ids":"string[]","topic":"string"}',
			responseSchema: '{"id":"string","name":"string","is_group":"boolean","members":"ConversationMemberRead[]","members[].id":"string","members[].username":"string","members[].role":"string"}'
		}
	]);
	assert.deepEqual(
		endpoints[0].fieldLocations?.map(({ scope, field }) => ({ scope, field })),
		[
			{ scope: 'request', field: 'group_name' },
			{ scope: 'request', field: 'participant_ids' },
			{ scope: 'request', field: 'topic' },
			{ scope: 'response', field: 'id' },
			{ scope: 'response', field: 'name' },
			{ scope: 'response', field: 'is_group' },
			{ scope: 'response', field: 'members' },
			{ scope: 'response', field: 'members[].id' },
			{ scope: 'response', field: 'members[].username' },
			{ scope: 'response', field: 'members[].role' }
		]
	);
});

test('unwraps FastAPI Annotated body schemas', () => {
	const source = `
from typing import Annotated
from fastapi import APIRouter, Body
from pydantic import BaseModel

router = APIRouter(prefix="/users")

class UserUpdate(BaseModel):
    username: str
    active: bool

class UserRead(BaseModel):
    id: str
    username: str

@router.put("/{user_id}", response_model=UserRead)
async def update_user(user_id: str, payload: Annotated[UserUpdate, Body(embed=True)]):
    return {}
`;

	const endpoints = extractBackendEndpointsFromCode(source);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'PUT',
			path: '/users/{user_id}',
			requestSchema: '{"username":"string","active":"boolean"}',
			responseSchema: '{"id":"string","username":"string"}'
		}
	]);
});

test('discovers required FastAPI request headers', () => {
	const source = `
from fastapi import APIRouter, Header, Depends
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer

router = APIRouter(prefix="/secure")
api_key_header = APIKeyHeader(name="X-API-Key")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

@router.get("/token")
async def read_token(authorization: str = Header(...)):
    return {}

@router.get("/key")
async def read_key(api_key: str = Depends(api_key_header)):
    return {}

@router.get("/me")
async def read_me(token: str = Depends(oauth2_scheme)):
    return {}
`;

	const endpoints = extractBackendEndpointsFromCode(source);

	assert.deepEqual(endpoints.map(stripLocation), [
		{ method: 'GET', path: '/secure/token', responseSchema: undefined, requestHeaders: ['Authorization'] },
		{ method: 'GET', path: '/secure/key', responseSchema: undefined, requestHeaders: ['X-API-Key'] },
		{ method: 'GET', path: '/secure/me', responseSchema: undefined, requestHeaders: ['Authorization'] }
	]);
});

test('infers FastAPI response schema from returned dict literals', () => {
	const source = `
from fastapi import APIRouter, Depends

router = APIRouter(prefix="/auth")

@router.get("/me")
async def get_me(current_user=Depends(get_current_user)):
    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "username": current_user.username,
        "avatar_url": current_user.avatar_url,
        "name": current_user.username,
    }
`;

	const endpoints = extractBackendEndpointsFromCode(source);

	assert.deepEqual(endpoints.map(stripLocation), [
		{
			method: 'GET',
			path: '/auth/me',
			requestHeaders: ['Authorization'],
			responseSchema: '{"id":"string","email":"string","username":"string","avatar_url":"string","name":"string"}'
		}
	]);
	assert.deepEqual(
		endpoints[0].fieldLocations?.map(({ scope, field, line }) => ({ scope, field, line })),
		[
			{ scope: 'response', field: 'id', line: 9 },
			{ scope: 'response', field: 'email', line: 10 },
			{ scope: 'response', field: 'username', line: 11 },
			{ scope: 'response', field: 'avatar_url', line: 12 },
			{ scope: 'response', field: 'name', line: 13 }
		]
	);
});
