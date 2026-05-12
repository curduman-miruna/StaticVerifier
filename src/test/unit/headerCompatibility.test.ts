import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBackendEndpointsFromCode } from '../../host/contracts/backendApiExtractor';
import { extractFrontendEndpointsFromCode } from '../../host/contracts/frontendApiExtractor';
import { findMissingRequiredHeaders } from '../../host/verification/headerCompatibility';

test('findMissingRequiredHeaders reports backend headers absent from frontend request', () => {
	assert.deepEqual(findMissingRequiredHeaders(undefined, ['Authorization']), ['Authorization']);
	assert.deepEqual(findMissingRequiredHeaders([], ['Authorization']), ['Authorization']);
});

test('findMissingRequiredHeaders compares header names case-insensitively', () => {
	assert.deepEqual(findMissingRequiredHeaders(['authorization'], ['Authorization']), []);
	assert.deepEqual(findMissingRequiredHeaders(['X-API-Key'], ['x-api-key']), []);
});

test('findMissingRequiredHeaders does not treat unrelated request metadata as authorization', () => {
	assert.deepEqual(findMissingRequiredHeaders(['Cookie'], ['Authorization']), ['Authorization']);
	assert.deepEqual(findMissingRequiredHeaders(['Content-Type'], ['Authorization']), ['Authorization']);
});

test('demo-style FastAPI Authorization header is missing when frontend sends no headers', () => {
	const frontend = extractFrontendEndpointsFromCode([
		'const API_URL = import.meta.env.VITE_API_URL;',
		'type AdminReport = { id: string; total: number };',
		'export async function headerMismatch(): Promise<AdminReport[]> {',
		"  const res = await fetch(`${API_URL}/api/v1/demo/header-mismatch`, { method: 'GET' });",
		'  return res.json();',
		'}'
	].join('\n'));
	const backend = extractBackendEndpointsFromCode([
		'from fastapi import APIRouter, Header',
		'from pydantic import BaseModel',
		'router = APIRouter(prefix="/api/v1")',
		'class AdminReport(BaseModel):',
		'    id: str',
		'    total: float',
		'@router.get("/demo/header-mismatch", response_model=list[AdminReport])',
		'def header_mismatch(authorization: str = Header(...)):',
		'    return [{"id": "r-1", "total": 42.0}]'
	].join('\n'));

	assert.deepEqual(frontend[0].requestHeaders, undefined);
	assert.deepEqual(backend[0].requestHeaders, ['Authorization']);
	assert.deepEqual(findMissingRequiredHeaders(frontend[0].requestHeaders, backend[0].requestHeaders), ['Authorization']);
});
