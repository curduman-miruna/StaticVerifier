import * as vscode from 'vscode';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import { createSilentDiagnostics } from '../contracts/silentDiagnostics';
import { normalizeEndpoint, normalizeEndpointPath } from '../verification/endpointNormalization';
import { parseSelectedEndpointText } from './endpointSelection';

export async function describeEndpointSchema(selectionText: string, documentText = ''): Promise<string | undefined> {
	const selected = parseSelectedEndpointText(selectionText, documentText);
	const diagnostics = createSilentDiagnostics('staticverifier-schema-lookup-silent');
	const [frontendFiles, backendFiles] = await Promise.all([
		loadConfiguredContracts('frontend', diagnostics),
		loadConfiguredContracts('backend', diagnostics)
	]);
	const selectedPath = normalizePathOnly(selected.pathText);
	if (!selectedPath) {
		return undefined;
	}

	const lines: string[] = [];
	for (const [side, files] of [
		['frontend', frontendFiles],
		['backend', backendFiles]
	] as const) {
		for (const file of files) {
			for (const endpoint of file.endpoints) {
				const normalized = normalizeEndpoint(endpoint);
				if (!normalized || normalized.path !== selectedPath || (selected.methodHint && normalized.method !== selected.methodHint)) {
					continue;
				}
				lines.push([
					`${side.toUpperCase()} ${normalized.method} ${normalized.path}`,
					`Source: ${file.uri.scheme === 'file' ? vscode.workspace.asRelativePath(file.uri, false) : file.uri.toString()}`,
					`Request: ${endpoint.requestSchema ?? '-'}`,
					`Response: ${endpoint.responseSchema ?? '-'}`,
					`Headers: ${(endpoint.requestHeaders ?? []).join(', ') || '-'}`
				].join('\n'));
			}
		}
	}

	return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function normalizePathOnly(value: string): string | undefined {
	return normalizeEndpointPath(value);
}
