import * as vscode from 'vscode';
import type { ContractSide } from '../../shared/contracts';
import type { SourceRevealTarget } from '../../shared/messages';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import type { EndpointContract, ParsedContractFile } from '../contracts/internalTypes';
import { createSilentDiagnostics } from '../contracts/silentDiagnostics';
import { normalizeEndpoint, normalizeEndpointPath } from '../verification/endpointNormalization';
import { parseSelectedEndpointText } from './endpointSelection';
import { extractModelNamesFromSchema, findModelDefinitionsInText } from './modelDefinitionModel';

export type EndpointModelScope = 'request' | 'response';
export type EndpointModelSide = ContractSide;

type EndpointModelHit = {
	side: ContractSide;
	file: ParsedContractFile;
	endpoint: EndpointContract;
};

export type EndpointModelLookupResult =
	| { kind: 'invalid-selection'; selection: string }
	| { kind: 'no-sources' }
	| { kind: 'no-endpoint'; path: string }
	| { kind: 'no-model'; path: string; scope: EndpointModelScope }
	| { kind: 'matches'; path: string; scope: EndpointModelScope; targets: SourceRevealTarget[] };

export async function findEndpointModelDefinitions(
	document: vscode.TextDocument,
	selectionText: string,
	scope: EndpointModelScope,
	side?: EndpointModelSide,
	position?: vscode.Position
): Promise<EndpointModelLookupResult> {
	const selected = parseSelectedEndpointText(selectionText, document.getText());
	const selectedPath = normalizeEndpointPath(selected.pathText);
	if (!selectedPath) {
		return { kind: 'invalid-selection', selection: selectionText };
	}

	const diagnostics = createSilentDiagnostics('staticverifier-model-lookup-silent');
	const [frontendFiles, backendFiles] = await Promise.all([
		loadConfiguredContracts('frontend', diagnostics),
		loadConfiguredContracts('backend', diagnostics)
	]);
	if (frontendFiles.length === 0 && backendFiles.length === 0) {
		return { kind: 'no-sources' };
	}

	const hits = [
		...collectEndpointModelHits('frontend', frontendFiles, selectedPath, selected.methodHint),
		...collectEndpointModelHits('backend', backendFiles, selectedPath, selected.methodHint)
	];
	if (hits.length === 0) {
		return { kind: 'no-endpoint', path: selectedPath };
	}

	const sideHits = side ? hits.filter((hit) => hit.side === side) : hits;
	if (sideHits.length === 0) {
		return { kind: 'no-endpoint', path: selectedPath };
	}
	const current = inferCurrentEndpointModelHit(document, sideHits, position) ?? sideHits[0];
	const schema = scope === 'request' ? current.endpoint.requestSchema : current.endpoint.responseSchema;
	const names = extractModelNamesFromSchema(schema);
	const targetFiles = [...frontendFiles, ...backendFiles];
	const targets = names.flatMap((name) => findModelNameTargets(name, targetFiles));
	if (targets.length > 0) {
		return { kind: 'matches', path: selectedPath, scope, targets };
	}

	const fieldTargets = (current.endpoint.fieldLocations ?? [])
		.filter((location) => location.scope === scope)
		.map((location) => ({
			...location,
			uri: location.uri || current.file.uri.toString(),
			side: current.side
		}));
	if (fieldTargets.length > 0) {
		return { kind: 'matches', path: selectedPath, scope, targets: fieldTargets };
	}

	return { kind: 'no-model', path: selectedPath, scope };
}

function collectEndpointModelHits(side: ContractSide, files: ParsedContractFile[], selectedPath: string, methodHint?: string): EndpointModelHit[] {
	const hits: EndpointModelHit[] = [];
	for (const file of files) {
		for (const endpoint of file.endpoints) {
			const normalized = normalizeEndpoint(endpoint);
			if (!normalized || normalized.path !== selectedPath || (methodHint && normalized.method !== methodHint)) {
				continue;
			}
			hits.push({ side, file, endpoint });
		}
	}
	return hits;
}

function inferCurrentEndpointModelHit(
	document: vscode.TextDocument,
	hits: EndpointModelHit[],
	position?: vscode.Position
): EndpointModelHit | undefined {
	const currentUri = document.uri.toString();
	const currentFileHits = hits.filter((hit) => hit.file.uri.toString() === currentUri);
	if (currentFileHits.length === 0) {
		return undefined;
	}
	const selectedLine = (position?.line ?? 0) + 1;
	return currentFileHits.sort((a, b) =>
		Math.abs((a.endpoint.sourceLine ?? 1) - selectedLine)
		- Math.abs((b.endpoint.sourceLine ?? 1) - selectedLine)
	)[0];
}

function findModelNameTargets(name: string, files: ParsedContractFile[]): SourceRevealTarget[] {
	const targets: SourceRevealTarget[] = [];
	for (const file of files) {
		for (const match of findModelDefinitionsInText(file.text, [name])) {
			targets.push({
				uri: file.uri.toString(),
				line: match.line,
				column: match.column,
				highlightText: match.highlightText
			});
		}
	}
	return targets;
}
