import assert from 'node:assert/strict';
import test from 'node:test';
import { countGitHubFiles, normalizeGitHubRawUrl } from '../../host/contracts/githubSource';

test('normalizes github blob URL to raw URL', () => {
	const raw = normalizeGitHubRawUrl('https://github.com/acme/platform/blob/main/contracts/openapi.json');
	assert.equal(raw, 'https://raw.githubusercontent.com/acme/platform/main/contracts/openapi.json');
});

test('returns original URL when it is already raw or non-blob', () => {
	assert.equal(
		normalizeGitHubRawUrl('https://raw.githubusercontent.com/acme/platform/main/contracts/openapi.json'),
		'https://raw.githubusercontent.com/acme/platform/main/contracts/openapi.json'
	);
	assert.equal(
		normalizeGitHubRawUrl('https://github.com/acme/platform/tree/main/contracts'),
		'https://github.com/acme/platform/tree/main/contracts'
	);
});

test('counts blob and raw links as one file without network fetch', async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error('fetch should not be called for blob/raw links');
	}) as typeof fetch;

	try {
		const blobCount = await countGitHubFiles('https://github.com/acme/platform/blob/main/contracts/openapi.json');
		const rawCount = await countGitHubFiles('https://raw.githubusercontent.com/acme/platform/main/contracts/openapi.json');
		assert.equal(blobCount, 1);
		assert.equal(rawCount, 1);
		assert.equal(fetchCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
