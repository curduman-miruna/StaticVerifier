import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildApiCompletions,
	buildResponseFieldCompletions,
	fieldsFromSchema,
	type ApiCompletionIndex,
	type ResponseSchemaIndex
} from '../../host/completion/responseFieldCompletionModel';

const schemas: ResponseSchemaIndex = new Map([
	['/api/users/me', [
		{ name: 'id', type: 'string' },
		{ name: 'email', type: 'string' },
		{ name: 'profile', type: 'unknown' },
		{ name: 'profile.avatarUrl', type: 'string' }
	]]
]);
const apiIndex: ApiCompletionIndex = {
	responseSchemas: schemas,
	requestSchemas: new Map([
		['/api/users/me', [
			{ name: 'email', type: 'string' },
			{ name: 'username', type: 'string' },
			{ name: 'profile.avatarUrl', type: 'string' }
		]]
	]),
	requestHeaders: new Map([
		['/api/users/me', ['Authorization', 'X-Request-ID']]
	])
};

test('suggests response fields after direct client response variable access', () => {
	const before = "const user = await api.get('/api/users/me');\nuser.";
	const completions = buildResponseFieldCompletions(before, 'user.', 5, schemas);

	assert.deepEqual(completions.map(({ name, type }) => ({ name, type })), [
		{ name: 'email', type: 'string' },
		{ name: 'id', type: 'string' },
		{ name: 'profile', type: 'unknown' }
	]);
});

test('suggests nested response fields after member access', () => {
	const before = "const user = await api.get('/api/users/me');\nuser.profile.";
	const completions = buildResponseFieldCompletions(before, 'user.profile.', 13, schemas);

	assert.deepEqual(completions.map(({ name, type }) => ({ name, type })), [
		{ name: 'avatarUrl', type: 'string' }
	]);
});

test('suggests response fields from fetch json variables', () => {
	const before = [
		"const response = await fetch('/api/users/me');",
		'const user = await response.json();',
		'user.'
	].join('\n');
	const completions = buildResponseFieldCompletions(before, 'user.', 5, schemas);

	assert.deepEqual(completions.map(({ name }) => name), ['email', 'id', 'profile']);
});

test('suggests top-level response fields inside destructuring', () => {
	const before = "const user = await api.get('/api/users/me');\nconst { ";
	const completions = buildResponseFieldCompletions(before, 'const {  } = user;', 8, schemas);

	assert.deepEqual(completions.map(({ name }) => name), ['email', 'id', 'profile']);
});

test('extracts response fields from json object schema strings', () => {
	assert.deepEqual(fieldsFromSchema('{"id":"string","active":"boolean","roles":"string[]"}'), [
		{ name: 'active', type: 'boolean' },
		{ name: 'id', type: 'string' },
		{ name: 'roles', type: 'string[]' }
	]);
});

test('follows simple response aliases', () => {
	const before = "const user = await api.get('/api/users/me');\nconst currentUser = user;\ncurrentUser.";
	const completions = buildResponseFieldCompletions(before, 'currentUser.', 12, schemas);

	assert.deepEqual(completions.map(({ name }) => name), ['email', 'id', 'profile']);
});

test('follows wrapper function responses', () => {
	const before = [
		"async function loadMe() {",
		"  return api.get('/api/users/me');",
		'}',
		'const user = await loadMe();',
		'user.'
	].join('\n');
	const completions = buildResponseFieldCompletions(before, 'user.', 5, schemas);

	assert.deepEqual(completions.map(({ name }) => name), ['email', 'id', 'profile']);
});

test('follows react query data aliases', () => {
	const before = "const { data: user } = useQuery({ queryFn: () => api.get('/api/users/me') });\nuser.";
	const completions = buildResponseFieldCompletions(before, 'user.', 5, schemas);

	assert.deepEqual(completions.map(({ name }) => name), ['email', 'id', 'profile']);
});

test('suggests request body fields inside method client payload objects', () => {
	const before = "await api.post('/api/users/me', {\n  ";
	const completions = buildApiCompletions(before, '  ', 2, apiIndex);

	assert.deepEqual(completions.map(({ name, type }) => ({ name, type })), [
		{ name: 'email', type: 'string' },
		{ name: 'username', type: 'string' }
	]);
});

test('suggests request body fields inside fetch JSON body objects', () => {
	const before = "await fetch('/api/users/me', { method: 'POST', body: JSON.stringify({\n  ";
	const completions = buildApiCompletions(before, '  ', 2, apiIndex);

	assert.deepEqual(completions.map(({ name }) => name), ['email', 'username']);
});

test('suggests required request headers inside headers objects', () => {
	const before = "await fetch('/api/users/me', { method: 'POST', headers: {\n  '";
	const completions = buildApiCompletions(before, "  '", 3, apiIndex);

	assert.deepEqual(completions.map(({ name, kind }) => ({ name, kind })), [
		{ name: 'Authorization', kind: 'header' },
		{ name: 'X-Request-ID', kind: 'header' }
	]);
});
