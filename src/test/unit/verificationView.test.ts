import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSchemaDiffs, inferSeverity, inferType, parseMethodPath } from '../../interface/app/components/VerificationView';

test('inferType detects known mismatch categories', () => {
	assert.equal(inferType('Missing backend endpoint for GET /users'), 'missing-in-be');
	assert.equal(inferType('Route is not declared in frontend: POST /users'), 'missing-in-fe');
	assert.equal(inferType('Request schema mismatch for GET /users'), 'schema-mismatch');
});

test('inferSeverity maps issue severities to ui severity levels', () => {
	assert.equal(inferSeverity({ severity: 'error' }), 'high');
	assert.equal(inferSeverity({ severity: 'warning' }), 'medium');
	assert.equal(inferSeverity({ severity: 'info' }), 'low');
});

test('parseMethodPath extracts http method and route', () => {
	assert.deepEqual(parseMethodPath('Mismatch found for POST /api/users/details'), {
		method: 'POST',
		path: '/api/users/details'
	});
	assert.deepEqual(parseMethodPath('No endpoint marker in text'), {
		method: 'GET',
		path: '/unknown'
	});
});

test('extractSchemaDiffs parses schemaDiff payload from message', () => {
	const message =
		'Schema mismatch for GET /api/users schemaDiff=[{"scope":"request","fields":[{"id":"1","status":"match","fe":{"key":"id","type":"string","required":true},"be":{"key":"id","type":"string","required":true}}]}]';
	const parsed = extractSchemaDiffs(message);
	assert.ok(parsed);
	assert.equal(parsed?.length, 1);
	assert.equal(parsed?.[0].scope, 'request');
	assert.equal(parsed?.[0].fields.length, 1);
});

test('extractSchemaDiffs returns undefined for invalid payloads', () => {
	assert.equal(extractSchemaDiffs('No schema diff here'), undefined);
	assert.equal(extractSchemaDiffs('schemaDiff=[invalid-json]'), undefined);
});
