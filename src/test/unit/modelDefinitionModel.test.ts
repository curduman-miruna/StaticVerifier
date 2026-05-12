import assert from 'node:assert/strict';
import test from 'node:test';
import { extractModelNamesFromSchema, findModelDefinitionsInText } from '../../host/navigation/modelDefinitionModel';

test('extractModelNamesFromSchema handles named and generic schemas', () => {
	assert.deepEqual(extractModelNamesFromSchema('UserResponse'), ['UserResponse']);
	assert.deepEqual(extractModelNamesFromSchema('ApiResult<OrderDto>'), ['ApiResult', 'OrderDto']);
	assert.deepEqual(extractModelNamesFromSchema('UserDto[]'), ['UserDto']);
	assert.deepEqual(extractModelNamesFromSchema('{"id":"string"}'), []);
});

test('findModelDefinitionsInText finds TypeScript model declarations', () => {
	const text = [
		'export interface UserResponse {',
		'  id: string;',
		'}',
		'type OrderDto = { id: string };',
		'class ApiResult<T> {}'
	].join('\n');

	assert.deepEqual(findModelDefinitionsInText(text, ['UserResponse', 'OrderDto', 'ApiResult']), [
		{ name: 'UserResponse', line: 1, column: 18, highlightText: 'UserResponse' },
		{ name: 'OrderDto', line: 4, column: 6, highlightText: 'OrderDto' },
		{ name: 'ApiResult', line: 5, column: 7, highlightText: 'ApiResult' }
	]);
});

test('findModelDefinitionsInText finds backend class declarations', () => {
	const text = [
		'class UserResponse(BaseModel):',
		'    id: str',
		'public record OrderDto(string Id);',
		'data class ApiResult<T>(val data: T)'
	].join('\n');

	assert.deepEqual(findModelDefinitionsInText(text, ['UserResponse', 'OrderDto', 'ApiResult']), [
		{ name: 'UserResponse', line: 1, column: 7, highlightText: 'UserResponse' },
		{ name: 'OrderDto', line: 3, column: 15, highlightText: 'OrderDto' },
		{ name: 'ApiResult', line: 4, column: 12, highlightText: 'ApiResult' }
	]);
});

test('findModelDefinitionsInText finds enum and schema object declarations', () => {
	const text = [
		'export enum UserRole { Admin = "admin" }',
		'export const UserResponse = z.object({ id: z.string() });'
	].join('\n');

	assert.deepEqual(findModelDefinitionsInText(text, ['UserRole', 'UserResponse']), [
		{ name: 'UserRole', line: 1, column: 13, highlightText: 'UserRole' },
		{ name: 'UserResponse', line: 2, column: 14, highlightText: 'UserResponse' }
	]);
});
