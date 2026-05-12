import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSkipDiscoveryPath } from '../../host/contracts/discoveryPathFilters';

test('skips frontend calls in test directories and test files', () => {
	const skipped = [
		'C:\\workspace\\app\\src\\__tests__\\userApi.ts',
		'C:\\workspace\\app\\src\\tests\\userApi.tsx',
		'/workspace/app/src/test/userApi.js',
		'/workspace/app/src/features/userApi.test.ts',
		'/workspace/app/src/features/userApi.spec.tsx',
		'/workspace/app/src/features/user-api-test.jsx'
	];

	for (const filePath of skipped) {
		assert.equal(shouldSkipDiscoveryPath('frontend', filePath), true, filePath);
	}
});

test('keeps non-test frontend source files discoverable', () => {
	const kept = [
		'C:\\workspace\\app\\src\\features\\userApi.ts',
		'/workspace/app/src/features/userApi.tsx',
		'/workspace/app/src/features/testSupportClient.ts'
	];

	for (const filePath of kept) {
		assert.equal(shouldSkipDiscoveryPath('frontend', filePath), false, filePath);
	}
});

test('skips backend calls in test directories and test files', () => {
	const skipped = [
		'/workspace/api/tests/routes.py',
		'/workspace/api/src/userController.spec.ts',
		'C:\\workspace\\api\\src\\UserControllerTest.java',
		'C:\\workspace\\api\\src\\UserController.test.cs'
	];

	for (const filePath of skipped) {
		assert.equal(shouldSkipDiscoveryPath('backend', filePath), true, filePath);
	}
});
