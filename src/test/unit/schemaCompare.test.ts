import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSchemaStrings, describeSchemaStrings } from '../../host/verification/schemaCompare';

test('compareSchemaStrings reports declared array type changes', () => {
	const result = compareSchemaStrings(
		'{"conversations":"Conversation[]","name":"string"}',
		'{"conversations":"string[]","name":"string"}',
		'response'
	);

	assert.equal(result.equal, false);
	assert.equal(result.schemaDiffs?.[0].fields.length, 2);
	const changed = result.schemaDiffs?.[0].fields.find((field) => field.id.endsWith(':conversations'));
	assert.equal(changed?.status, 'type-changed');
	assert.equal(changed?.fe?.type, 'Conversation[]');
	assert.equal(changed?.be?.type, 'string[]');
});

test('compareSchemaStrings normalizes equivalent array notation', () => {
	const result = compareSchemaStrings(
		'{"ids":"Array<string>"}',
		'{"ids":"string[]"}',
		'request'
	);

	assert.equal(result.equal, true);
	assert.equal(result.schemaDiffs, undefined);
});

test('compareSchemaStrings treats numeric primitive aliases as compatible', () => {
	assert.equal(compareSchemaStrings('{"count":"number"}', '{"count":"integer"}', 'response').equal, true);
	assert.equal(compareSchemaStrings('{"total":"number"}', '{"total":"float"}', 'response').equal, true);
	assert.equal(compareSchemaStrings('{"rating":"integer"}', '{"rating":"number"}', 'request').equal, true);
});

test('compareSchemaStrings maps camelCase fields to snake_case fields', () => {
	const result = compareSchemaStrings(
		'{"participantIds":"string[]"}',
		'{"group_name":"string","participant_ids":"string[]"}',
		'request'
	);

	assert.equal(result.equal, false);
	const fields = result.schemaDiffs?.[0].fields ?? [];
	assert.equal(fields.length, 2);
	assert.equal(fields[0].status, 'renamed');
	assert.equal(fields[0].fe?.key, 'participantIds');
	assert.equal(fields[0].be?.key, 'participant_ids');
	assert.equal(fields[1].status, 'be-only');
	assert.equal(fields[1].be?.key, 'group_name');
});

test('compareSchemaStrings does not fail on casing-only field renames', () => {
	const result = compareSchemaStrings(
		'{"createdAt":"datetime"}',
		'{"created_at":"datetime"}',
		'response'
	);

	assert.equal(result.equal, true);
	assert.equal(result.schemaDiffs, undefined);
});

test('describeSchemaStrings returns compatible renamed field mappings', () => {
	const result = describeSchemaStrings(
		'{"groupName":"string","participantIds":"string[]"}',
		'{"group_name":"string","participant_ids":"string[]"}',
		'request'
	);

	assert.equal(result?.scope, 'request');
	assert.deepEqual(result?.fields.map((field) => field.status), ['renamed', 'renamed']);
	assert.deepEqual(result?.fields.map((field) => field.fe?.key), ['groupName', 'participantIds']);
	assert.deepEqual(result?.fields.map((field) => field.be?.key), ['group_name', 'participant_ids']);
});

test('compareSchemaStrings treats backend-only response fields as compatible extras', () => {
	const result = compareSchemaStrings(
		'{"id":"string"}',
		'{"id":"string","members":"ConversationMemberRead[]"}',
		'response'
	);

	assert.equal(result.equal, true);
	assert.equal(result.schemaDiffs, undefined);
});

test('compareSchemaStrings treats nullable frontend aliases as compatible', () => {
	const result = compareSchemaStrings(
		'{"avatarUrl":"unknown | null","avatar_url":"unknown | null","email":"string"}',
		'{"avatar_url":"string","email":"EmailStr"}',
		'response'
	);

	assert.equal(result.equal, true);
	assert.equal(result.schemaDiffs, undefined);
});

test('describeSchemaStrings shows backend-only response fields as extras', () => {
	const result = compareSchemaStrings(
		undefined,
		'{"id":"string","members":"ConversationMemberRead[]"}',
		'response'
	);

	assert.equal(result.equal, true);
	assert.equal(result.schemaDiffs, undefined);

	const described = describeSchemaStrings(
		undefined,
		'{"id":"string","members":"ConversationMemberRead[]"}',
		'response'
	);
	const fields = described?.fields ?? [];
	assert.equal(fields.length, 2);
	assert.deepEqual(fields.map((field) => field.status), ['be-only', 'be-only']);
	assert.deepEqual(fields.map((field) => field.be?.key), ['id', 'members']);
});

test('compareSchemaStrings shows frontend fields when backend request schema is missing', () => {
	const result = compareSchemaStrings(
		'{"toEmail":"string"}',
		undefined,
		'request'
	);

	assert.equal(result.equal, false);
	const fields = result.schemaDiffs?.[0].fields ?? [];
	assert.equal(fields.length, 1);
	assert.equal(fields[0].status, 'fe-only');
	assert.equal(fields[0].fe?.key, 'toEmail');
});

test('describeSchemaStrings maps nested object aliases by shared children', () => {
	const result = describeSchemaStrings(
		'{"createdAt":"unknown","id":"unknown","toUser":"unknown","toUser.id":"string","toUser.email":"string","toUser.username":"string"}',
		'{"created_at":"datetime","id":"string","receiver":"UserResponse","receiver.id":"string","receiver.email":"string","receiver.username":"string","sender":"UserResponse","sender.id":"string"}',
		'response'
	);

	const fields = result?.fields ?? [];
	const toUser = fields.find((field) => field.fe?.key === 'toUser');
	const toUserId = fields.find((field) => field.fe?.key === 'toUser.id');
	const toUserEmail = fields.find((field) => field.fe?.key === 'toUser.email');

	assert.equal(toUser?.status, 'renamed');
	assert.equal(toUser?.be?.key, 'receiver');
	assert.equal(toUserId?.status, 'renamed');
	assert.equal(toUserId?.be?.key, 'receiver.id');
	assert.equal(toUserEmail?.status, 'renamed');
	assert.equal(toUserEmail?.be?.key, 'receiver.email');
	assert.equal(fields.some((field) => field.be?.key === 'sender'), true);
});
