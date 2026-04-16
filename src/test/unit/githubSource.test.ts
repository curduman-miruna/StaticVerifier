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

test('returns 0 for invalid github URL input', async () => {
	const count = await countGitHubFiles('not-a-valid-url');
	assert.equal(count, 0);
});

test('counts files for repository URL using default branch + recursive tree', async () => {
	const originalFetch = globalThis.fetch;
	const queue = [
		{
			ok: true,
			json: async () => ({ default_branch: 'main' })
		},
		{
			ok: true,
			json: async () => ({
				tree: [
					{ path: 'contracts/a.json', type: 'blob' },
					{ path: 'contracts', type: 'tree' },
					{ path: 'src/index.ts', type: 'blob' }
				]
			})
		}
	];
	globalThis.fetch = (async () => queue.shift() as Response) as typeof fetch;

	try {
		const count = await countGitHubFiles('https://github.com/acme/platform');
		assert.equal(count, 2);
		assert.equal(queue.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('counts only files under tree subpath', async () => {
	const originalFetch = globalThis.fetch;
	const queue = [
		{
			ok: true,
			json: async () => ({
				tree: [
					{ path: 'contracts', type: 'tree' },
					{ path: 'contracts/a.json', type: 'blob' },
					{ path: 'contracts/nested/b.json', type: 'blob' },
					{ path: 'src/index.ts', type: 'blob' }
				]
			})
		}
	];
	globalThis.fetch = (async () => queue.shift() as Response) as typeof fetch;

	try {
		const count = await countGitHubFiles('https://github.com/acme/platform/tree/main/contracts');
		assert.equal(count, 2);
		assert.equal(queue.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('returns 0 when github API fails for default branch/tree fetch', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({ ok: false }) as Response) as typeof fetch;

	try {
		const count = await countGitHubFiles('https://github.com/acme/platform');
		assert.equal(count, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('returns 0 when tree response has no files', async () => {
	const originalFetch = globalThis.fetch;
	const queue = [
		{
			ok: true,
			json: async () => ({ default_branch: 'main' })
		},
		{
			ok: true,
			json: async () => ({ tree: [] })
		}
	];
	globalThis.fetch = (async () => queue.shift() as Response) as typeof fetch;

	try {
		const count = await countGitHubFiles('https://github.com/acme/platform');
		assert.equal(count, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
