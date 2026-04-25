import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelativeTime, resolveHeaderStatus } from '../../popup/app/components/HeaderBar';

test('resolveHeaderStatus returns scanning when active scan is running', () => {
	assert.equal(resolveHeaderStatus('ready', true), 'scanning');
	assert.equal(resolveHeaderStatus('error', true), 'scanning');
});

test('resolveHeaderStatus returns provided status when not scanning', () => {
	assert.equal(resolveHeaderStatus('ready', false), 'ready');
	assert.equal(resolveHeaderStatus('unconfigured', false), 'unconfigured');
});

test('formatRelativeTime renders seconds, minutes, and hours', () => {
	const now = new Date('2026-04-25T12:00:00.000Z').getTime();
	const originalNow = Date.now;
	Date.now = () => now;

	try {
		assert.equal(formatRelativeTime(new Date(now - 15_000)), '15s ago');
		assert.equal(formatRelativeTime(new Date(now - 3 * 60_000)), '3m ago');
		assert.equal(formatRelativeTime(new Date(now - 2 * 60 * 60_000)), '2h ago');
	} finally {
		Date.now = originalNow;
	}
});
