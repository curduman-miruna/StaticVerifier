import * as vscode from 'vscode';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import { createSilentDiagnostics } from '../contracts/silentDiagnostics';
import { normalizeEndpoint } from '../verification/endpointNormalization';
import {
	buildApiCompletions,
	fieldsFromSchema,
	type ApiCompletionIndex,
	type ResponseField,
	type ResponseSchemaIndex
} from './responseFieldCompletionModel';

const CACHE_TTL_MS = 15_000;

export class ResponseFieldCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
	private cachedSchemas: ApiCompletionIndex = emptyCompletionIndex();
	private cacheExpiresAt = 0;
	private loadingSchemas: Promise<ApiCompletionIndex> | undefined;

	dispose(): void {
		// No owned VS Code resources.
	}

	invalidate(): void {
		this.cacheExpiresAt = 0;
		this.loadingSchemas = undefined;
	}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.CompletionItem[]> {
		if (!isCompletionEnabled()) {
			return [];
		}

		const schemas = await this.getResponseSchemas();
		const textBeforePosition = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		const lineText = document.lineAt(position.line).text;
		return buildApiCompletions(textBeforePosition, lineText, position.character, schemas)
			.map((field) => {
				const item = new vscode.CompletionItem(field.name, field.kind === 'header' ? vscode.CompletionItemKind.Value : vscode.CompletionItemKind.Field);
				item.detail = field.type;
				if (field.kind === 'header') {
					item.insertText = field.name;
				}
				item.range = new vscode.Range(
					position.line,
					field.replacementStart,
					position.line,
					field.replacementEnd
				);
				return item;
			});
	}

	private async getResponseSchemas(): Promise<ApiCompletionIndex> {
		const now = Date.now();
		if (now < this.cacheExpiresAt) {
			return this.cachedSchemas;
		}
		if (!this.loadingSchemas) {
			this.loadingSchemas = this.loadResponseSchemas();
		}

		this.cachedSchemas = await this.loadingSchemas;
		this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
		this.loadingSchemas = undefined;
		return this.cachedSchemas;
	}

	private async loadResponseSchemas(): Promise<ApiCompletionIndex> {
		const diagnostics = createSilentDiagnostics('staticverifier-response-field-completion-silent');
		const [frontendFiles, backendFiles] = await Promise.all([
			loadConfiguredContracts('frontend', diagnostics),
			loadConfiguredContracts('backend', diagnostics)
		]);
		const responseSchemas: ResponseSchemaIndex = new Map();
		const requestSchemas: ResponseSchemaIndex = new Map();
		const requestHeaders = new Map<string, string[]>();

		for (const file of [...backendFiles, ...frontendFiles]) {
			for (const endpoint of file.endpoints) {
				const normalized = normalizeEndpoint(endpoint);
				if (!normalized) {
					continue;
				}
				const responseFields = fieldsFromSchema(endpoint.responseSchema);
				if (responseFields.length > 0) {
					responseSchemas.set(normalized.path, mergeFields(responseSchemas.get(normalized.path), responseFields));
				}
				const requestFields = fieldsFromSchema(endpoint.requestSchema);
				if (requestFields.length > 0) {
					requestSchemas.set(normalized.path, mergeFields(requestSchemas.get(normalized.path), requestFields));
				}
				if (endpoint.requestHeaders?.length) {
					requestHeaders.set(normalized.path, mergeHeaders(requestHeaders.get(normalized.path), endpoint.requestHeaders));
				}
			}
		}

		return { responseSchemas, requestSchemas, requestHeaders };
	}
}

function mergeFields(existing: ResponseField[] | undefined, incoming: ResponseField[]): ResponseField[] {
	const byName = new Map<string, ResponseField>();
	for (const field of [...(existing ?? []), ...incoming]) {
		byName.set(field.name, field);
	}
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeHeaders(existing: string[] | undefined, incoming: string[]): string[] {
	const byName = new Map<string, string>();
	for (const header of [...(existing ?? []), ...incoming]) {
		byName.set(header.toLowerCase(), header);
	}
	return Array.from(byName.values()).sort((a, b) => a.localeCompare(b));
}

function emptyCompletionIndex(): ApiCompletionIndex {
	return {
		responseSchemas: new Map(),
		requestSchemas: new Map(),
		requestHeaders: new Map()
	};
}

function isCompletionEnabled(): boolean {
	return vscode.workspace.getConfiguration('staticverifier').get<boolean>('enable', true);
}
