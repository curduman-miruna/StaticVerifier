import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEndpointInlineCompletions } from '../../host/completion/endpointInlineCompletionModel';

const endpoints = [
	'/api/users',
	'/api/users/:id',
	'/api/orders',
	'/internal/health'
];

test('suggests endpoint paths inside fetch string arguments', () => {
	const completions = buildEndpointInlineCompletions("await fetch('/api/u", endpoints, 5);

	assert.deepEqual(completions, [
		{ insertText: '/api/users', replacementStart: 13 },
		{ insertText: '/api/users/:id', replacementStart: 13 }
	]);
});

test('suggests endpoint paths inside method client string arguments', () => {
	const completions = buildEndpointInlineCompletions("return api.post('/api/o", endpoints, 5);

	assert.deepEqual(completions, [
		{ insertText: '/api/orders', replacementStart: 17 }
	]);
});

test('does not suggest in unrelated strings or non-path fragments', () => {
	assert.deepEqual(buildEndpointInlineCompletions("const label = '/api/u", endpoints, 5), []);
	assert.deepEqual(buildEndpointInlineCompletions("await fetch('api/u", endpoints, 5), []);
});

test('limits automatic suggestions and excludes exact matches', () => {
	assert.deepEqual(buildEndpointInlineCompletions("await fetch('/api/users", endpoints, 1), [
		{ insertText: '/api/users/:id', replacementStart: 13 }
	]);
});
