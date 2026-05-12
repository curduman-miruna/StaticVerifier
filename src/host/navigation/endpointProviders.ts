import * as vscode from 'vscode';
import { findEndpointTextAtOffset, parseSelectedEndpointText } from './endpointSelection';
import { lookupSelectedEndpoint } from './findEndpointInOtherSource';
import type { SourceRevealTarget } from '../../shared/messages';
import { normalizeEndpointPath } from '../verification/endpointNormalization';

const ENDPOINT_LINE_PATTERN = /(['"`])((?:\$\{[^}]+}\s*)?(?:https?:\/\/[^'"`)\]\s]+|\/[^'"`)\]\s]+))\1|(?:https?:\/\/[^\s'"`)\]}]+|\/[A-Za-z0-9_./:{}?&=%-]+)/g;

export class EndpointDefinitionProvider implements vscode.DefinitionProvider {
	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.Definition | undefined> {
		const selected = getEndpointAtPosition(document, position);
		if (!selected) {
			return undefined;
		}
		const lookup = await lookupSelectedEndpoint(document, selected.text, position);
		if (lookup.kind !== 'found' || lookup.otherTargets.length === 0) {
			return undefined;
		}
		return Promise.all(lookup.otherTargets.map(targetToLocation));
	}
}

export class EndpointReferenceProvider implements vscode.ReferenceProvider {
	async provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.ReferenceContext,
		_token: vscode.CancellationToken
	): Promise<vscode.Location[]> {
		const selected = getEndpointAtPosition(document, position);
		if (!selected) {
			return [];
		}
		const lookup = await lookupSelectedEndpoint(document, selected.text, position);
		if (lookup.kind !== 'found') {
			return [];
		}
		return Promise.all(lookup.allTargets.map(targetToLocation));
	}
}

export class EndpointCodeLensProvider implements vscode.CodeLensProvider {
	async provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken
	): Promise<vscode.CodeLens[]> {
		const lenses: vscode.CodeLens[] = [];
		for (const target of findEndpointCodeLensTargets(document)) {
			const range = new vscode.Range(target.line, target.character, target.line, target.character + Math.max(1, target.anchorLength));
			const position = new vscode.Position(target.line, target.character);
			lenses.push(
				new vscode.CodeLens(range, {
					title: 'StaticVerifier: find counterpart',
					command: 'staticverifier.findEndpointInOtherSourceAt',
					arguments: [document.uri.toString(), target.endpointText, position.line, position.character]
				}),
				new vscode.CodeLens(range, {
					title: 'verify endpoint',
					command: 'staticverifier.verifyEndpointAt',
					arguments: [document.uri.toString(), target.endpointText, position.line, position.character]
				}),
				new vscode.CodeLens(range, {
					title: 'show schema',
					command: 'staticverifier.showEndpointSchemaAt',
					arguments: [document.uri.toString(), target.endpointText, position.line, position.character]
				}),
				new vscode.CodeLens(range, {
					title: 'FE request model',
					command: 'staticverifier.goToEndpointModelAt',
					arguments: [document.uri.toString(), target.endpointText, 'request', 'frontend', position.line, position.character]
				}),
				new vscode.CodeLens(range, {
					title: 'FE response model',
					command: 'staticverifier.goToEndpointModelAt',
					arguments: [document.uri.toString(), target.endpointText, 'response', 'frontend', position.line, position.character]
				}),
				new vscode.CodeLens(range, {
					title: 'BE request model',
					command: 'staticverifier.goToEndpointModelAt',
					arguments: [document.uri.toString(), target.endpointText, 'request', 'backend', position.line, position.character]
				}),
				new vscode.CodeLens(range, {
					title: 'BE response model',
					command: 'staticverifier.goToEndpointModelAt',
					arguments: [document.uri.toString(), target.endpointText, 'response', 'backend', position.line, position.character]
				})
			);
		}
		return lenses;
	}
}

export function getEndpointAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position
): { text: string; range: vscode.Range } | undefined {
	const lineText = document.lineAt(position.line).text;
	const selected = findEndpointTextAtOffset(lineText, position.character);
	if (!selected) {
		return undefined;
	}
	return {
		text: selected.text,
		range: new vscode.Range(position.line, selected.start, position.line, selected.end)
	};
}

async function targetToLocation(target: SourceRevealTarget): Promise<vscode.Location> {
	const uri = vscode.Uri.parse(target.uri);
	const document = await vscode.workspace.openTextDocument(uri);
	const line = Math.min(Math.max(0, target.line - 1), Math.max(0, document.lineCount - 1));
	const textLine = document.lineAt(line);
	const column = Math.min(Math.max(0, target.column - 1), textLine.text.length);
	const length = Math.max(1, target.highlightText?.length ?? target.path?.length ?? 1);
	return new vscode.Location(uri, new vscode.Range(line, column, line, Math.min(textLine.text.length, column + length)));
}

type EndpointCodeLensTarget = {
	endpointText: string;
	line: number;
	character: number;
	anchorLength: number;
};

export function findEndpointCodeLensTargets(document: Pick<vscode.TextDocument, 'lineCount' | 'lineAt'>): EndpointCodeLensTarget[] {
	const targets: EndpointCodeLensTarget[] = [];
	const consumedLines = new Set<number>();
	for (let line = 0; line < document.lineCount; line += 1) {
		if (consumedLines.has(line)) {
			continue;
		}
		const text = document.lineAt(line).text;
		if (!looksLikeEndpointCallStart(text)) {
			continue;
		}

		const block = collectEndpointCallBlock(document, line);
		if (block && normalizeEndpointPath(parseSelectedEndpointText(block.text).pathText)) {
			for (let consumed = line; consumed <= block.endLine; consumed += 1) {
				consumedLines.add(consumed);
			}
			targets.push({
				endpointText: block.text,
				line,
				character: block.character,
				anchorLength: block.anchorLength
			});
			continue;
		}

		const token = Array.from(text.matchAll(ENDPOINT_LINE_PATTERN))[0];
		if (!token || token.index === undefined) {
			continue;
		}
		targets.push({
			endpointText: token[0],
			line,
			character: token.index,
			anchorLength: token[0].length
		});
	}
	return targets;
}

function collectEndpointCallBlock(
	document: Pick<vscode.TextDocument, 'lineCount' | 'lineAt'>,
	startLine: number
): { text: string; endLine: number; character: number; anchorLength: number } | undefined {
	const firstLine = document.lineAt(startLine).text;
	const startCharacter = findCallStartCharacter(firstLine);
	if (startCharacter < 0) {
		return undefined;
	}
	const lines: string[] = [];
	let openParens = 0;
	let sawOpenParen = false;
	for (let line = startLine; line < Math.min(document.lineCount, startLine + 20); line += 1) {
		const text = document.lineAt(line).text;
		lines.push(line === startLine ? text.slice(startCharacter) : text);
		for (const char of text) {
			if (char === '(') {
				openParens += 1;
				sawOpenParen = true;
			} else if (char === ')') {
				openParens -= 1;
			}
		}
		const blockText = lines.join('\n');
		if (sawOpenParen && openParens <= 0 && /[;)]\s*$/.test(text.trim())) {
			return {
				text: blockText,
				endLine: line,
				character: startCharacter,
				anchorLength: firstLine.slice(startCharacter).match(/[A-Za-z_$][\w$.]*/)?.[0].length ?? 1
			};
		}
		if (normalizeEndpointPath(parseSelectedEndpointText(blockText).pathText) && /,\s*\{?\s*$/.test(text.trim())) {
			return {
				text: blockText,
				endLine: line,
				character: startCharacter,
				anchorLength: firstLine.slice(startCharacter).match(/[A-Za-z_$][\w$.]*/)?.[0].length ?? 1
			};
		}
	}
	return undefined;
}

function findCallStartCharacter(text: string): number {
	const match = text.match(/\b(?:fetch|fetchJson|new\s+Request|[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete|head|options))\s*\(/i);
	return match?.index ?? -1;
}

function looksLikeEndpointCallStart(text: string): boolean {
	return findCallStartCharacter(text) >= 0;
}
