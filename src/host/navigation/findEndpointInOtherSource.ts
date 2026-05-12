import * as vscode from 'vscode';
import type { ContractSide } from '../../shared/contracts';
import type { SourceRevealTarget } from '../../shared/messages';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import type { EndpointContract, ParsedContractFile } from '../contracts/internalTypes';
import { createSilentDiagnostics } from '../contracts/silentDiagnostics';
import { normalizeEndpoint, normalizeEndpointPath } from '../verification/endpointNormalization';
import { baseHintTokens, parseSelectedEndpointText } from './endpointSelection';

type EndpointHit = {
	side: ContractSide;
	file: ParsedContractFile;
	endpoint: EndpointContract;
	method: string;
	path: string;
};

export type EndpointLookupResult =
	| { kind: 'invalid-selection'; selection: string }
	| { kind: 'no-sources' }
	| {
		kind: 'found';
		path: string;
		method?: string;
		current?: SourceRevealTarget;
		otherSide?: ContractSide;
		otherTargets: SourceRevealTarget[];
		allTargets: SourceRevealTarget[];
	};

type FindOtherSourceResult =
	| { kind: 'invalid-selection'; selection: string }
	| { kind: 'no-sources' }
	| { kind: 'ambiguous-side'; sides: ContractSide[]; targets: SourceRevealTarget[]; path: string; method?: string }
	| { kind: 'no-matches'; path: string; otherSide: ContractSide; method?: string }
	| { kind: 'matches'; path: string; otherSide: ContractSide; method?: string; targets: SourceRevealTarget[] };

export async function findSelectedEndpointInOtherSource(
	document: vscode.TextDocument,
	selectionText: string,
	position?: vscode.Position
): Promise<FindOtherSourceResult> {
	const lookup = await lookupSelectedEndpoint(document, selectionText, position);
	if (lookup.kind === 'invalid-selection' || lookup.kind === 'no-sources') {
		return lookup;
	}
	if (!lookup.current || !lookup.otherSide) {
		const sides = Array.from(new Set(lookup.allTargets.map((target) => target.side).filter((side): side is ContractSide => Boolean(side))));
		return { kind: 'ambiguous-side', sides, targets: lookup.allTargets, path: lookup.path, method: lookup.method };
	}
	if (lookup.otherTargets.length === 0) {
		return { kind: 'no-matches', path: lookup.path, otherSide: lookup.otherSide, method: lookup.method };
	}
	return {
		kind: 'matches',
		path: lookup.path,
		otherSide: lookup.otherSide,
		method: lookup.method,
		targets: lookup.otherTargets
	};
}

export async function lookupSelectedEndpoint(
	document: vscode.TextDocument,
	selectionText: string,
	position?: vscode.Position
): Promise<EndpointLookupResult> {
	const selected = parseSelectedEndpointText(selectionText, document.getText());
	const selectedPath = normalizeEndpointPath(selected.pathText);
	if (!selectedPath) {
		return { kind: 'invalid-selection', selection: selectionText };
	}
	const serviceTokens = baseHintTokens(selected.baseHint);
	const methodHint = selected.methodHint;

	const diagnostics = createSilentDiagnostics('staticverifier-find-endpoint-silent');
	const [frontendFiles, backendFiles] = await Promise.all([
		loadConfiguredContracts('frontend', diagnostics),
		loadConfiguredContracts('backend', diagnostics)
	]);
	if (frontendFiles.length === 0 && backendFiles.length === 0) {
		return { kind: 'no-sources' };
	}

	const frontendHits = collectHits('frontend', frontendFiles, selectedPath, methodHint);
	const backendHits = collectHits('backend', backendFiles, selectedPath, methodHint);
	const current = inferCurrentEndpoint(document, frontendHits, backendHits, position);
	if (!current) {
		return {
			kind: 'found',
			path: selectedPath,
			method: methodHint,
			allTargets: [...frontendHits, ...backendHits].map((hit) => toRevealTarget(hit)),
			otherTargets: []
		};
	}

	const otherSide: ContractSide = current.side === 'frontend' ? 'backend' : 'frontend';
	const otherHits = otherSide === 'frontend' ? frontendHits : backendHits;
	const matchingHits = current.method
		? otherHits.filter((hit) => hit.method === current.method)
		: otherHits;
	const rankedMatches = rankHitsByServiceHint(matchingHits, serviceTokens);

	return {
		kind: 'found',
		path: selectedPath,
		current: toRevealTarget(current),
		otherSide,
		method: current.method,
		otherTargets: rankedMatches.map((hit) => toRevealTarget(hit)),
		allTargets: rankHitsByServiceHint([...frontendHits, ...backendHits], serviceTokens).map((hit) => toRevealTarget(hit))
	};
}

function collectHits(side: ContractSide, files: ParsedContractFile[], selectedPath: string, methodHint?: string): EndpointHit[] {
	const hits: EndpointHit[] = [];
	for (const file of files) {
		for (const endpoint of file.endpoints) {
			const normalized = normalizeEndpoint(endpoint);
			if (!normalized || normalized.path !== selectedPath || (methodHint && normalized.method !== methodHint)) {
				continue;
			}
			hits.push({
				side,
				file,
				endpoint,
				method: normalized.method,
				path: normalized.path
			});
		}
	}
	return hits;
}

function inferCurrentEndpoint(
	document: vscode.TextDocument,
	frontendHits: EndpointHit[],
	backendHits: EndpointHit[],
	position?: vscode.Position
): EndpointHit | undefined {
	const currentUri = document.uri.toString();
	const currentFileHits = [...frontendHits, ...backendHits].filter((hit) => hit.file.uri.toString() === currentUri);
	if (currentFileHits.length > 0) {
		const selectedLine = (position?.line ?? 0) + 1;
		return currentFileHits.sort((a, b) =>
			Math.abs((a.endpoint.sourceLine ?? 1) - selectedLine)
			- Math.abs((b.endpoint.sourceLine ?? 1) - selectedLine)
		)[0];
	}

	if (frontendHits.length > 0 && backendHits.length === 0) {
		return frontendHits[0];
	}
	if (backendHits.length > 0 && frontendHits.length === 0) {
		return backendHits[0];
	}
	return undefined;
}

function toRevealTarget(hit: EndpointHit): SourceRevealTarget {
	return {
		uri: hit.file.uri.toString(),
		line: hit.endpoint.sourceLine ?? 1,
		column: hit.endpoint.sourceColumn ?? 1,
		method: hit.method,
		path: hit.path,
		side: hit.side,
		highlightText: hit.endpoint.path
	};
}

function rankHitsByServiceHint(hits: EndpointHit[], serviceTokens: string[]): EndpointHit[] {
	if (hits.length <= 1 || serviceTokens.length === 0) {
		return hits;
	}

	return hits
		.map((hit, index) => ({ hit, index, score: scoreHit(hit, serviceTokens) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ hit }) => hit);
}

function scoreHit(hit: EndpointHit, serviceTokens: string[]): number {
	const haystack = [
		hit.file.uri.toString(),
		hit.file.uri.scheme === 'file' ? hit.file.uri.fsPath : '',
		hit.file.text.slice(0, 2000)
	].join('\n').toLowerCase();
	return serviceTokens.reduce((score, token) => haystack.includes(token) ? score + 1 : score, 0);
}
