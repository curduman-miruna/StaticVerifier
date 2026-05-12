import type { EndpointContract } from '../contracts/internalTypes';

const HTTP_METHOD_TOKEN = /^[A-Z][A-Z0-9_-]*$/;

export type NormalizedEndpoint = {
	method: string;
	path: string;
};

export function normalizeEndpoint(endpoint: EndpointContract): NormalizedEndpoint | undefined {
	const method = normalizeEndpointMethod(endpoint.method);
	const path = normalizeEndpointPath(endpoint.path);
	if (!method || !path) {
		return undefined;
	}
	return { method, path };
}

export function normalizeEndpointMethod(rawMethod: string): string | undefined {
	const method = rawMethod.trim().toUpperCase();
	return HTTP_METHOD_TOKEN.test(method) ? method : undefined;
}

export function normalizeEndpointPath(rawPath: string): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return undefined;
	}

	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		try {
			const parsed = new URL(trimmed);
			return normalizePathToken(parsed.pathname);
		} catch {
			return undefined;
		}
	}

	if (!trimmed.startsWith('/')) {
		return undefined;
	}

	return normalizePathToken(trimmed);
}

function normalizePathToken(path: string): string | undefined {
	const noQuery = path.split(/[?#]/)[0];
	const normalizedParams = noQuery
		.replace(/\/\{[^/}]+\}/g, '/{param}')
		.replace(/\/:[^/]+/g, '/{param}');
	const collapsed = normalizedParams.replace(/\/+/g, '/').trim();
	if (!collapsed.startsWith('/')) {
		return undefined;
	}
	if (collapsed.length > 1 && collapsed.endsWith('/')) {
		return collapsed.slice(0, -1);
	}
	return collapsed;
}
