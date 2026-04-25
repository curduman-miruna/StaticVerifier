import * as vscode from 'vscode';
import type { InitialState } from '../shared/messages';

export function getPopupWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	initialState: InitialState
): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'interface.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'interface.css'));
	const nonce = createNonce();
	const encodedState = JSON.stringify(initialState).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width,initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>StaticVerifier</title>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">window.__STATIC_VERIFIER_INITIAL_STATE__ = ${encodedState};</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let index = 0; index < 32; index += 1) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}
