import * as vscode from 'vscode';
import {
	getContractInputFromConfig,
	isContractSourceConfigured,
	sanitizeContractInput,
	saveContractInput
} from './host/config/contractsConfig';
import { browseLocalEntry } from './host/contracts/browseLocalEntry';
import { computeSourceCounts, validateBeforeSave } from './host/contracts/sourceValidation';
import { findTrackedLocalContractUris } from './host/contracts/findTrackedLocalContractUris';
import { formatVerificationSummary, runContractVerification } from './host/verification/verifier';
import { getPopupWebviewHtml } from './host/webviewHtml';
import type { PopupMessage } from './shared/messages';

const DIAGNOSTIC_COLLECTION = 'staticverifier';

export function activate(context: vscode.ExtensionContext) {
	const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION);

	const helloWorld = vscode.commands.registerCommand('staticverifier.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from StaticVerifier!');
	});

	const verifyContracts = vscode.commands.registerCommand('staticverifier.verifyContracts', async () => {
		await runContractVerification(diagnostics, true);
	});

	const openPopupMockup = vscode.commands.registerCommand('staticverifier.openPopupMockup', () => {
		const panel = vscode.window.createWebviewPanel(
			'staticVerifierPopupMockup',
			'StaticVerifier',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
			}
		);

		const config = vscode.workspace.getConfiguration('staticverifier');
		const frontend = getContractInputFromConfig(config, 'frontend');
		const backend = getContractInputFromConfig(config, 'backend');
		const hasConfiguredPaths = isContractSourceConfigured(config, 'frontend', frontend)
			&& isContractSourceConfigured(config, 'backend', backend);

		panel.webview.html = getPopupWebviewHtml(panel.webview, context.extensionUri, {
			frontend,
			backend,
			hasConfiguredPaths
		});

		const onMessage = panel.webview.onDidReceiveMessage(async (message: PopupMessage) => {
			if (!message || typeof message !== 'object') {
				return;
			}

			if (message.type === 'savePaths') {
				const frontendInput = sanitizeContractInput(message.frontend);
				const backendInput = sanitizeContractInput(message.backend);

				if (!frontendInput || !backendInput) {
					await panel.webview.postMessage({
						type: 'actionResult',
						text: 'Both FE and BE sources must include at least one entry before saving.'
					});
					return;
				}

				const validation = await validateBeforeSave(frontendInput, backendInput);
				if (!validation.valid) {
					await panel.webview.postMessage({
						type: 'actionResult',
						text: `Validation failed:\n${validation.errors.join('\n')}`
					});
					return;
				}

				const verifierConfig = vscode.workspace.getConfiguration('staticverifier');
				await saveContractInput(verifierConfig, 'frontend', frontendInput);
				await saveContractInput(verifierConfig, 'backend', backendInput);
				await panel.webview.postMessage({
					type: 'sourceCounts',
					items: [...validation.frontendCounts, ...validation.backendCounts]
				});

				await panel.webview.postMessage({
					type: 'actionResult',
					text: `Contract settings saved to workspace settings.\n${validation.summary}`
				});
				return;
			}

			if (message.type === 'refreshSourceCounts') {
				const currentConfig = vscode.workspace.getConfiguration('staticverifier');
				const currentFrontend = getContractInputFromConfig(currentConfig, 'frontend');
				const currentBackend = getContractInputFromConfig(currentConfig, 'backend');
				const refreshed = await computeSourceCounts(currentFrontend, currentBackend);
				await panel.webview.postMessage({
					type: 'sourceCounts',
					items: [...refreshed.frontendCounts, ...refreshed.backendCounts]
				});
				return;
			}

			if (message.type === 'browseLocal') {
				const browseResult = await browseLocalEntry();
				await panel.webview.postMessage({
					type: 'browseResult',
					side: message.side,
					index: message.index,
					value: browseResult.value,
					error: browseResult.error
				});
				return;
			}

			if (message.type === 'verifyContracts') {
				const summary = await runContractVerification(diagnostics, false);
				await panel.webview.postMessage({
					type: 'actionResult',
					text: formatVerificationSummary(summary)
				});
			}
		});

		context.subscriptions.push(onMessage);
	});

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.text = '$(list-unordered) StaticVerifier';
	statusBar.tooltip = 'Open StaticVerifier panel';
	statusBar.command = 'staticverifier.openPopupMockup';
	statusBar.show();

	const onSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
		const trackedUris = await findTrackedLocalContractUris();
		const trackedUriSet = new Set(trackedUris.map((uri) => uri.toString()));
		if (!trackedUriSet.has(document.uri.toString())) {
			return;
		}

		await runContractVerification(diagnostics, false);
	});

	context.subscriptions.push(helloWorld, verifyContracts, openPopupMockup, statusBar, onSave, diagnostics);
}

export function deactivate() {}
