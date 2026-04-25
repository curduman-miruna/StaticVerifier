import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeaderBar } from '../../interface/app/components/HeaderBar';
import { DiscoveryPanel } from '../../interface/app/components/DiscoveryPanel';
import { SchemaDiffView } from '../../interface/app/components/SchemaDiffView';
import { VerificationView, toMismatch } from '../../interface/app/components/VerificationView';
import { Badge, Button, Card, Input } from '../../interface/app/components/ui';
import { cx } from '../../interface/app/components/ui/cx';

test('ui primitives render expected base classes', () => {
	const button = renderToStaticMarkup(createElement(Button, { variant: 'outline', size: 'sm' }, 'Run'));
	const badge = renderToStaticMarkup(createElement(Badge, { variant: 'success' }, 'OK'));
	const card = renderToStaticMarkup(createElement(Card, null, 'Body'));
	const input = renderToStaticMarkup(createElement(Input, { value: 'abc', readOnly: true }));

	assert.match(button, /sv-ui-button/);
	assert.match(button, /sv-ui-button-outline/);
	assert.match(badge, /sv-ui-badge-success/);
	assert.match(card, /sv-ui-card/);
	assert.match(input, /sv-ui-input/);
	assert.equal(cx('a', undefined, false, 'b', null, 'c'), 'a b c');
});

test('HeaderBar renders status, metrics and toggle labels', () => {
	const html = renderToStaticMarkup(
		createElement(HeaderBar, {
			metrics: {
				feSources: 1,
				feIndexed: 12,
				beSources: 2,
				beIndexed: 8,
				lastScanned: new Date(Date.now() - 30_000),
				status: 'ready'
			},
			mode: 'monitor',
			onModeChange: () => undefined,
			isScanning: false
		})
	);

	assert.match(html, /StaticVerifier/);
	assert.match(html, /Monitor/);
	assert.match(html, /Configure/);
	assert.match(html, /files indexed/);
});

test('DiscoveryPanel renders grouped endpoints and empty state', () => {
	const items = [
		{
			uri: 'file:///src/a.ts',
			method: 'GET',
			path: '/api/users',
			side: 'frontend' as const,
			source: 'src/a.ts',
			line: 10,
			column: 2
		},
		{
			uri: 'file:///src/b.ts',
			method: 'POST',
			path: '/api/users',
			side: 'backend' as const,
			source: 'src/b.ts',
			line: 20,
			column: 4
		}
	];

	const html = renderToStaticMarkup(
		createElement(DiscoveryPanel, {
			items,
			mismatches: [
				{
					file: 'src/a.ts',
					line: 10,
					column: 2,
					severity: 'error' as const,
					message: 'Missing backend endpoint for GET /api/users.',
					kind: 'missing-backend' as const,
					sourceSide: 'frontend' as const,
					method: 'GET',
					path: '/api/users'
				},
				{
					file: 'src/b.ts',
					line: 20,
					column: 4,
					severity: 'warning' as const,
					message: 'Backend endpoint POST /api/users is not declared in frontend contract.',
					kind: 'backend-only' as const,
					sourceSide: 'backend' as const,
					method: 'POST',
					path: '/api/users'
				}
			],
			isLoading: false,
			onRefresh: () => undefined,
			onReveal: () => undefined
		})
	);
	const emptyHtml = renderToStaticMarkup(
		createElement(DiscoveryPanel, {
			items: [],
			isLoading: false,
			onRefresh: () => undefined,
			onReveal: () => undefined
		})
	);

	assert.match(html, /Discovered APIs/);
	assert.match(html, /Open/);
	assert.match(html, /endpoint/);
	assert.match(html, /FE only/);
	assert.match(html, /BE only/);
	assert.match(emptyHtml, /No APIs discovered yet/);
});

test('SchemaDiffView renders request/response scopes and field labels', () => {
	const html = renderToStaticMarkup(
		createElement(SchemaDiffView, {
			diffs: [
				{
					scope: 'request',
					feLabel: 'fe.ts',
					beLabel: 'be.ts',
					fields: [
						{
							id: '1',
							status: 'match',
							fe: { key: 'id', type: 'string', required: true },
							be: { key: 'id', type: 'string', required: true }
						},
						{
							id: '2',
							status: 'type-changed',
							fe: { key: 'age', type: 'number', required: false },
							be: { key: 'age', type: 'string', required: false }
						}
					]
				},
				{
					scope: 'response',
					fields: [
						{
							id: '3',
							status: 'fe-only',
							fe: { key: 'debug', type: 'boolean', required: false }
						}
					]
				}
			]
		})
	);

	assert.match(html, /Request Body/);
	assert.match(html, /Response Body/);
	assert.match(html, /Frontend expects/);
	assert.match(html, /Backend provides/);
	assert.match(html, /Type changed/);
});

test('VerificationView renders mismatch state and toMismatch keeps schema diffs', () => {
	const issue = {
		file: 'src/api/users.ts',
		line: 4,
		column: 2,
		severity: 'warning' as const,
		message: 'Schema mismatch for GET /api/users',
		kind: 'request-schema-mismatch' as const,
		sourceSide: 'frontend' as const,
		method: 'GET',
		path: '/api/users',
		schemaDiffs: [
			{
				scope: 'request' as const,
				fields: [
					{
						id: '1',
						status: 'optional-mismatch' as const,
						fe: { key: 'name', type: 'string', required: true },
						be: { key: 'name', type: 'string', required: false }
					}
				]
			}
		]
	};

	const html = renderToStaticMarkup(createElement(VerificationView, { mismatches: [issue] }));
	const emptyHtml = renderToStaticMarkup(createElement(VerificationView, { mismatches: [] }));
	const mapped = toMismatch(issue, 0);

	assert.match(html, /mismatch detected/);
	assert.match(html, /Schema Mismatch/);
	assert.match(emptyHtml, /no mismatches found/i);
	assert.ok(mapped.schemaDiffs);
	assert.equal(mapped.schemaDiffs?.length, 1);
});
