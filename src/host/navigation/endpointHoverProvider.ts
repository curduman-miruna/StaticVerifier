import * as vscode from 'vscode';
import { compareSchemaStrings } from '../verification/schemaCompare';
import { findEndpointTextAtOffset, parseSelectedEndpointText } from './endpointSelection';
import { loadEndpointIndex, type IndexedEndpoint } from './endpointIndex';
import { normalizeEndpointPath } from '../verification/endpointNormalization';

export class EndpointHoverProvider implements vscode.HoverProvider {
	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.Hover | undefined> {
		const selected = findEndpointTextAtOffset(document.lineAt(position.line).text, position.character);
		if (!selected) {
			return undefined;
		}
		const parsed = parseSelectedEndpointText(selected.text, document.getText());
		const path = normalizeEndpointPath(parsed.pathText);
		if (!path) {
			return undefined;
		}

		const endpoints = (await loadEndpointIndex()).filter((endpoint) =>
			endpoint.path === path && (!parsed.methodHint || endpoint.method === parsed.methodHint)
		);
		if (endpoints.length === 0) {
			return undefined;
		}

		const markdown = buildHoverMarkdown(path, endpoints, document, selected.text, position);
		return new vscode.Hover(markdown, new vscode.Range(position.line, selected.start, position.line, selected.end));
	}
}

function buildHoverMarkdown(
	path: string,
	endpoints: IndexedEndpoint[],
	document: vscode.TextDocument,
	endpointText: string,
	position: vscode.Position
): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	markdown.isTrusted = true;
	const frontend = endpoints.filter((endpoint) => endpoint.side === 'frontend');
	const backend = endpoints.filter((endpoint) => endpoint.side === 'backend');
	markdown.appendMarkdown(`**StaticVerifier** \`${path}\`\n\n`);
	markdown.appendMarkdown(`FE endpoints: **${frontend.length}**  \nBE endpoints: **${backend.length}**\n\n`);

	for (const endpoint of endpoints.slice(0, 8)) {
		markdown.appendMarkdown(`- **${endpoint.side.toUpperCase()}** \`${endpoint.method} ${endpoint.path}\`  \n`);
		markdown.appendMarkdown(`  Source: \`${endpoint.source}:${endpoint.endpoint.sourceLine ?? 1}\`  \n`);
		markdown.appendMarkdown(`  Request: \`${endpoint.endpoint.requestSchema ?? '-'}\`  \n`);
		markdown.appendMarkdown(`  Response: \`${endpoint.endpoint.responseSchema ?? '-'}\`  \n`);
		if (endpoint.endpoint.requestHeaders?.length) {
			markdown.appendMarkdown(`  Headers: \`${endpoint.endpoint.requestHeaders.join(', ')}\`  \n`);
		}
		markdown.appendMarkdown(`  ${commandLink('Open', 'staticverifier.revealEndpointTarget', [toRevealTarget(endpoint)])}  \n`);
	}

	const status = summarizeStatus(frontend, backend);
	markdown.appendMarkdown(`\nStatus: **${status}**\n\n`);
	const commonArgs = [document.uri.toString(), endpointText, position.line, position.character];
	markdown.appendMarkdown([
		commandLink('Open counterpart', 'staticverifier.findEndpointInOtherSourceAt', commonArgs),
		commandLink('Show schema', 'staticverifier.showEndpointSchemaAt', commonArgs),
		commandLink('Explain issue', 'staticverifier.explainSelectedEndpoint', commonArgs),
		commandLink('FE request model', 'staticverifier.goToEndpointModelAt', [document.uri.toString(), endpointText, 'request', 'frontend', position.line, position.character]),
		commandLink('BE response model', 'staticverifier.goToEndpointModelAt', [document.uri.toString(), endpointText, 'response', 'backend', position.line, position.character])
	].join(' | '));
	return markdown;
}

function toRevealTarget(endpoint: IndexedEndpoint) {
	return {
		uri: endpoint.file.uri.toString(),
		line: endpoint.endpoint.sourceLine ?? 1,
		column: endpoint.endpoint.sourceColumn ?? 1,
		method: endpoint.method,
		path: endpoint.path,
		side: endpoint.side,
		highlightText: endpoint.endpoint.path
	};
}

function commandLink(label: string, command: string, args: unknown[]): string {
	return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

function summarizeStatus(frontend: IndexedEndpoint[], backend: IndexedEndpoint[]): string {
	if (frontend.length === 0) {
		return 'BE only';
	}
	if (backend.length === 0) {
		return 'Missing backend';
	}
	const frontendEndpoint = frontend[0].endpoint;
	const backendEndpoint = backend[0].endpoint;
	const request = compareSchemaStrings(frontendEndpoint.requestSchema, backendEndpoint.requestSchema, 'request');
	const response = compareSchemaStrings(frontendEndpoint.responseSchema, backendEndpoint.responseSchema, 'response');
	if (request.equal && response.equal) {
		return 'Matched';
	}
	return 'Schema mismatch';
}
