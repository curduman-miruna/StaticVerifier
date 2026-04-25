import * as vscode from 'vscode';
import type { ContractSide } from '../../shared/contracts';
import { extractFrontendEndpointsFromCode, type FrontendDiscoveryOptions } from './frontendApiExtractor';
import type { EndpointContract, ParsedContractFile } from './internalTypes';

export function parseContractText(
	text: string,
	uri: vscode.Uri,
	side: ContractSide,
	collection: vscode.DiagnosticCollection,
	frontendDiscovery?: FrontendDiscoveryOptions
): ParsedContractFile | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		if (side === 'frontend') {
			const extractedEndpoints = extractFrontendEndpointsFromCode(text, frontendDiscovery);
			if (extractedEndpoints.length > 0) {
				return { uri, text, endpoints: extractedEndpoints };
			}
			collection.set(uri, [
				new vscode.Diagnostic(
					new vscode.Range(0, 0, 0, 1),
					'Frontend source must be a contract JSON file or code containing discoverable HTTP API calls.',
					vscode.DiagnosticSeverity.Error
				)
			]);
			return undefined;
		}
		collection.set(uri, [parseJsonErrorToDiagnostic(text, error)]);
		return undefined;
	}

	const rawEndpoints = (parsed as { endpoints?: unknown }).endpoints;
	if (!Array.isArray(rawEndpoints)) {
		collection.set(uri, [
			new vscode.Diagnostic(
				new vscode.Range(0, 0, 0, 1),
				'Contract JSON must include an "endpoints" array.',
				vscode.DiagnosticSeverity.Error
			)
		]);
		return undefined;
	}

	const endpoints: EndpointContract[] = [];
	for (const item of rawEndpoints) {
		const endpoint = item as Record<string, unknown>;
		if (typeof endpoint.method !== 'string' || typeof endpoint.path !== 'string') {
			continue;
		}
		endpoints.push({
			method: endpoint.method,
			path: endpoint.path,
			requestSchema: typeof endpoint.requestSchema === 'string' ? endpoint.requestSchema : undefined,
			responseSchema: typeof endpoint.responseSchema === 'string' ? endpoint.responseSchema : undefined
		});
	}

	return { uri, text, endpoints };
}

function parseJsonErrorToDiagnostic(text: string, error: unknown): vscode.Diagnostic {
	const message = error instanceof Error ? error.message : 'Invalid JSON.';
	const positionMatch = message.match(/position (\d+)/);
	if (!positionMatch) {
		return new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, vscode.DiagnosticSeverity.Error);
	}
	const offset = Number(positionMatch[1]);
	return new vscode.Diagnostic(
		offsetToRange(text, Number.isFinite(offset) ? offset : 0),
		message,
		vscode.DiagnosticSeverity.Error
	);
}

function offsetToRange(text: string, offset: number): vscode.Range {
	const safeOffset = Math.max(0, Math.min(offset, text.length));
	const before = text.slice(0, safeOffset);
	const lines = before.split(/\r?\n/);
	const line = Math.max(0, lines.length - 1);
	const character = lines[lines.length - 1]?.length ?? 0;
	return new vscode.Range(line, character, line, character + 1);
}
