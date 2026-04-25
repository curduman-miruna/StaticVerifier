import assert from 'node:assert/strict';
import test from 'node:test';
import { filterGroups, getFileName, groupBySource, METHOD_STYLES, normalizeMethod } from '../../interface/app/components/DiscoveryPanel';

type ApiItem = {
	uri: string;
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	side: 'frontend' | 'backend';
	source: string;
	line: number;
	column: number;
};

const items: ApiItem[] = [
	{
		uri: 'file:///a.ts',
		method: 'get',
		path: '/api/users',
		side: 'frontend',
		source: 'src/api/a.ts',
		line: 10,
		column: 2
	},
	{
		uri: 'file:///b.ts',
		method: 'POST',
		path: '/api/users',
		side: 'backend',
		source: 'src/api/b.ts',
		line: 20,
		column: 4
	},
	{
		uri: 'file:///a2.ts',
		method: 'patch',
		path: '/api/users/1',
		side: 'frontend',
		source: 'src/api/a.ts',
		line: 30,
		column: 6
	}
];

test('groupBySource groups and sorts by source', () => {
	const grouped = groupBySource(items);
	assert.equal(grouped.length, 2);
	assert.equal(grouped[0].source, 'src/api/a.ts');
	assert.equal(grouped[0].items.length, 2);
	assert.equal(grouped[1].source, 'src/api/b.ts');
});

test('normalizeMethod handles known and unknown methods', () => {
	assert.equal(normalizeMethod('post'), 'POST');
	assert.equal(normalizeMethod('PATCH'), 'PATCH');
	assert.equal(normalizeMethod('custom'), 'GET');
});

test('filterGroups filters by path, method, and source', () => {
	const grouped = groupBySource(items);

	const byPath = filterGroups(grouped, 'users/1');
	assert.equal(byPath.length, 1);
	assert.equal(byPath[0].items.length, 1);

	const byMethod = filterGroups(grouped, 'post');
	assert.equal(byMethod.length, 1);
	assert.equal(byMethod[0].source, 'src/api/b.ts');

	const bySource = filterGroups(grouped, 'a.ts');
	assert.equal(bySource.length, 1);
	assert.equal(bySource[0].items.length, 2);

	const bySide = filterGroups(grouped, 'backend');
	assert.equal(bySide.length, 1);
	assert.equal(bySide[0].source, 'src/api/b.ts');
});

test('getFileName returns last path segment', () => {
	assert.equal(getFileName('src/api/users.ts'), 'users.ts');
	assert.equal(getFileName('src\\api\\users.ts'), 'users.ts');
});

test('METHOD_STYLES keep expected short labels', () => {
	assert.equal(METHOD_STYLES.GET.label, 'GET');
	assert.equal(METHOD_STYLES.DELETE.label, 'DEL');
	assert.equal(METHOD_STYLES.OPTIONS.label, 'OPT');
});
