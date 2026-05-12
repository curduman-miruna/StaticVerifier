import * as vscode from 'vscode';

export class StaticVerifierCodeActionProvider implements vscode.CodeActionProvider {
	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const diagnostics = context.diagnostics.filter((diagnostic) => diagnostic.source === 'StaticVerifier');
		if (diagnostics.length === 0) {
			return [];
		}

		return diagnostics.flatMap((diagnostic) => {
			const selectedText = document.getText(diagnostic.range) || document.getText(range);
			const endpointText = readEndpointText(diagnostic.message) ?? selectedText;
			const actions = [
				createCommandAction(
				'StaticVerifier: Find endpoint in other source',
				'staticverifier.findEndpointInOtherSourceAt',
					[document.uri.toString(), endpointText, range.start.line, range.start.character],
				diagnostic
				),
				createCommandAction(
					'StaticVerifier: Copy mismatch summary',
					'staticverifier.copyText',
					[diagnostic.message],
					diagnostic
				)
			];
			if (/schema mismatch/i.test(diagnostic.message)) {
				actions.push(createCommandAction(
					'StaticVerifier: Copy schema fix prompt',
					'staticverifier.copySchemaFixPrompt',
					[diagnostic.message],
					diagnostic
				));
				actions.push(createCommandAction(
					'StaticVerifier: Open request model',
					'staticverifier.goToEndpointModelAt',
					[document.uri.toString(), endpointText, 'request', range.start.line, range.start.character],
					diagnostic
				));
				actions.push(createCommandAction(
					'StaticVerifier: Open response model',
					'staticverifier.goToEndpointModelAt',
					[document.uri.toString(), endpointText, 'response', range.start.line, range.start.character],
					diagnostic
				));
			}
			if (/missing backend endpoint/i.test(diagnostic.message)) {
				actions.push(createCommandAction(
					'StaticVerifier: Copy backend route stub',
					'staticverifier.copyEndpointStub',
					[diagnostic.message],
					diagnostic
				));
			}
			if (/not declared in frontend contract/i.test(diagnostic.message)) {
				actions.push(createCommandAction(
					'StaticVerifier: Copy frontend call stub',
					'staticverifier.copyFrontendCallStub',
					[diagnostic.message],
					diagnostic
				));
			}
			if (/header mismatch/i.test(diagnostic.message)) {
				actions.push(createCommandAction(
					'StaticVerifier: Copy header fix prompt',
					'staticverifier.copyHeaderFixPrompt',
					[diagnostic.message],
					diagnostic
				));
			}
			return actions;
		});
	}
}

function readEndpointText(message: string): string | undefined {
	const match = message.match(/\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|WS)\s+(\/[^\s."]+)/i);
	return match?.[0];
}

function createCommandAction(
	title: string,
	command: string,
	args: unknown[],
	diagnostic: vscode.Diagnostic
): vscode.CodeAction {
	const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	action.command = { title, command, arguments: args };
	action.diagnostics = [diagnostic];
	action.isPreferred = title.includes('Find endpoint');
	return action;
}
