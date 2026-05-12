import * as vscode from 'vscode';

export function createSilentDiagnostics(name = 'staticverifier-silent'): vscode.DiagnosticCollection {
	return {
		name,
		set: (): void => undefined,
		delete: (): void => undefined,
		clear: (): void => undefined,
		forEach: (): void => undefined,
		get: (): readonly vscode.Diagnostic[] | undefined => undefined,
		has: (): boolean => false,
		dispose: (): void => undefined,
		[Symbol.iterator]: function* (): IterableIterator<[vscode.Uri, readonly vscode.Diagnostic[]]> {
			return;
		}
	};
}
