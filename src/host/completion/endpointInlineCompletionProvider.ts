import * as vscode from 'vscode';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import { shouldSkipDiscoveryPath } from '../contracts/discoveryPathFilters';
import { createSilentDiagnostics } from '../contracts/silentDiagnostics';
import { buildEndpointInlineCompletions } from './endpointInlineCompletionModel';

const CACHE_TTL_MS = 15_000;
const AUTOMATIC_LIMIT = 1;
const INVOKE_LIMIT = 20;

export class EndpointInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
	private cachedPaths: string[] = [];
	private cacheExpiresAt = 0;
	private loadingPaths: Promise<string[]> | undefined;

	dispose(): void {
		// No owned VS Code resources.
	}

	invalidate(): void {
		this.cacheExpiresAt = 0;
		this.loadingPaths = undefined;
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[]> {
		if (token.isCancellationRequested || !isCompletionEnabled()) {
			return [];
		}
		if (document.uri.scheme === 'file' && shouldSkipDiscoveryPath('frontend', document.uri.fsPath)) {
			return [];
		}

		const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
		const limit = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? INVOKE_LIMIT : AUTOMATIC_LIMIT;
		const endpointPaths = await this.getEndpointPaths();
		if (token.isCancellationRequested) {
			return [];
		}

		return buildEndpointInlineCompletions(linePrefix, endpointPaths, limit)
			.map((completion) => new vscode.InlineCompletionItem(
				completion.insertText,
				new vscode.Range(
					position.line,
					completion.replacementStart,
					position.line,
					position.character
				)
			));
	}

	private async getEndpointPaths(): Promise<string[]> {
		const now = Date.now();
		if (now < this.cacheExpiresAt) {
			return this.cachedPaths;
		}

		if (!this.loadingPaths) {
			this.loadingPaths = this.loadEndpointPaths();
		}

		this.cachedPaths = await this.loadingPaths;
		this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
		this.loadingPaths = undefined;
		return this.cachedPaths;
	}

	private async loadEndpointPaths(): Promise<string[]> {
		const diagnostics = createSilentDiagnostics('staticverifier-inline-completion-silent');
		const [frontendFiles, backendFiles] = await Promise.all([
			loadConfiguredContracts('frontend', diagnostics),
			loadConfiguredContracts('backend', diagnostics)
		]);
		const paths = [...frontendFiles, ...backendFiles]
			.flatMap((file) => file.endpoints.map((endpoint) => endpoint.path.trim()))
			.filter((path) => path.startsWith('/'));
		return Array.from(new Set(paths)).sort((a, b) => a.length - b.length || a.localeCompare(b));
	}
}

function isCompletionEnabled(): boolean {
	return vscode.workspace.getConfiguration('staticverifier').get<boolean>('enable', true);
}
