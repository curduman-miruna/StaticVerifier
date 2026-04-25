import * as vscode from 'vscode';
import {
	getContractInputFromConfig,
	isContractSourceConfigured,
	sanitizeContractInput,
	saveContractInput
} from './host/config/contractsConfig';
import { browseLocalEntry } from './host/contracts/browseLocalEntry';
import { loadConfiguredContracts } from './host/contracts/loadContracts';
import { computeSourceCounts, validateBeforeSave } from './host/contracts/sourceValidation';
import { findTrackedLocalContractUris } from './host/contracts/findTrackedLocalContractUris';
import { formatVerificationSummary, runContractVerification } from './host/verification/verifier';
import { getPopupWebviewHtml } from './host/webviewHtml';
import type { PopupMessage } from './shared/messages';

const DIAGNOSTIC_COLLECTION = 'staticverifier';
const VERIFICATION_MODE_SETTING = 'verificationMode';
type VerificationMode = 'auto' | 'manual';
type VerificationIssue = {
	file: string;
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'info';
	message: string;
};

function getVerificationMode(): VerificationMode {
	const mode = vscode.workspace
		.getConfiguration('staticverifier')
		.get<VerificationMode>(VERIFICATION_MODE_SETTING, 'auto');
	return mode === 'manual' ? 'manual' : 'auto';
}

function getSeverityLabel(severity: vscode.DiagnosticSeverity): 'error' | 'warning' | 'info' {
	if (severity === vscode.DiagnosticSeverity.Error) {
		return 'error';
	}
	if (severity === vscode.DiagnosticSeverity.Warning) {
		return 'warning';
	}
	return 'info';
}

function buildVerificationIssues(collection: vscode.DiagnosticCollection): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	collection.forEach((uri, diagnostics) => {
		const file = uri.scheme === 'file' ? (vscode.workspace.asRelativePath(uri, false) || uri.fsPath) : uri.toString();
		for (const diagnostic of diagnostics) {
			issues.push({
				file,
				line: diagnostic.range.start.line + 1,
				column: diagnostic.range.start.character + 1,
				severity: getSeverityLabel(diagnostic.severity),
				message: diagnostic.message
			});
		}
	});
	return issues.sort((a, b) => {
		const fileOrder = a.file.localeCompare(b.file);
		if (fileOrder !== 0) {
			return fileOrder;
		}
		if (a.line !== b.line) {
			return a.line - b.line;
		}
		return a.column - b.column;
	});
}

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
				const summaryText = formatVerificationSummary(summary);
				await panel.webview.postMessage({
					type: 'actionResult',
					text: summaryText
				});
				await panel.webview.postMessage({
					type: 'verificationReport',
					summaryText,
					issues: buildVerificationIssues(diagnostics)
				});
				return;
			}

			if (message.type === 'discoverApis') {
				const tempDiagnostics = vscode.languages.createDiagnosticCollection(`${DIAGNOSTIC_COLLECTION}-discovery-temp`);
				try {
					const frontendFiles = await loadConfiguredContracts('frontend', tempDiagnostics);
					const items = frontendFiles.flatMap((file) =>
						file.endpoints.map((endpoint) => ({
							uri: file.uri.toString(),
							method: endpoint.method.toUpperCase(),
							path: endpoint.path,
							requestSchema: endpoint.requestSchema,
							responseSchema: endpoint.responseSchema,
							source: file.uri.scheme === 'file'
								? (vscode.workspace.asRelativePath(file.uri, false) || file.uri.fsPath)
								: file.uri.toString(),
							line: endpoint.sourceLine ?? 1,
							column: endpoint.sourceColumn ?? 1
						}))
					);
					await panel.webview.postMessage({
						type: 'discoveredApis',
						items
					});
				} finally {
					tempDiagnostics.dispose();
				}
				return;
			}

			if (message.type === 'revealDiscoveredApi') {
				try {
					const uri = vscode.Uri.parse(message.uri);
					const document = await vscode.workspace.openTextDocument(uri);
					const editor = await vscode.window.showTextDocument(document, {
						preview: false,
						preserveFocus: false
					});
					const line = Math.max(0, message.line - 1);
					const column = Math.max(0, message.column - 1);
					const position = new vscode.Position(line, column);
					editor.selection = new vscode.Selection(position, position);
					editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
				} catch {
					vscode.window.showWarningMessage('StaticVerifier could not open the source location for this discovered API.');
				}
			}
		});

		context.subscriptions.push(onMessage);
	});

	const statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
	const statusBarMode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	const updateStatusBar = () => {
		const mode = getVerificationMode();
		statusBarMode.text = mode === 'auto' ? 'StaticVerifier: Auto' : 'StaticVerifier: Manual';
		statusBarMode.tooltip = mode === 'auto'
			? 'Auto-verify on save is enabled. Click to change verification mode.'
			: 'Manual verification mode is enabled. Click to change verification mode.';
	};
	updateStatusBar();
	statusBarIcon.text = '$(list-unordered)';
	statusBarIcon.tooltip = 'Open StaticVerifier panel';
	statusBarIcon.command = 'staticverifier.openPopupMockup';
	statusBarMode.command = 'staticverifier.configureVerificationMode';
	statusBarIcon.show();
	statusBarMode.show();

	const configureVerificationMode = vscode.commands.registerCommand('staticverifier.configureVerificationMode', async () => {
		const currentMode = getVerificationMode();
		const selection = await vscode.window.showQuickPick([
			{
				label: 'Auto Verify on Save',
				description: 'Run contract verification automatically when tracked files are saved.',
				mode: 'auto' as const
			},
			{
				label: 'Manual Verification',
				description: 'Run verification only from command/panel actions.',
				mode: 'manual' as const
			}
		], {
			placeHolder: currentMode === 'auto'
				? 'Current mode: Auto Verify on Save'
				: 'Current mode: Manual Verification'
		});
		if (!selection || selection.mode === currentMode) {
			return;
		}

		await vscode.workspace
			.getConfiguration('staticverifier')
			.update(VERIFICATION_MODE_SETTING, selection.mode, vscode.ConfigurationTarget.Workspace);
		updateStatusBar();
		vscode.window.showInformationMessage(
			selection.mode === 'auto'
				? 'StaticVerifier mode set to Auto Verify on Save.'
				: 'StaticVerifier mode set to Manual Verification.'
		);
	});

	const onConfigChange = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(`staticverifier.${VERIFICATION_MODE_SETTING}`)) {
			updateStatusBar();
		}
	});

	const onSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
		if (getVerificationMode() === 'manual') {
			return;
		}

		const trackedUris = await findTrackedLocalContractUris();
		const trackedUriSet = new Set(trackedUris.map((uri) => uri.toString()));
		if (!trackedUriSet.has(document.uri.toString())) {
			return;
		}

		await runContractVerification(diagnostics, false);
	});

	context.subscriptions.push(
		helloWorld,
		verifyContracts,
		openPopupMockup,
		configureVerificationMode,
		statusBarIcon,
		statusBarMode,
		onConfigChange,
		onSave,
		diagnostics
	);
}

export function deactivate() {}
