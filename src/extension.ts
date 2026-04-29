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
import type { PopupMessage, SourceRevealTarget, VerificationIssue } from './shared/messages';

const DIAGNOSTIC_COLLECTION = 'staticverifier';
const VERIFICATION_MODE_SETTING = 'verificationMode';
const GROQ_API_KEY_ENV = 'STATICVERIFIER_GROQ_API_KEY';
const GROQ_LIMIT_REACHED_MESSAGE = 'StaticVerifier AI limit reached. This extension uses a shared Groq quota, so no more AI explanations can be generated right now. Please try again later.';
type VerificationMode = 'auto' | 'manual';

function getVerificationMode(): VerificationMode {
	const mode = vscode.workspace
		.getConfiguration('staticverifier')
		.get<VerificationMode>(VERIFICATION_MODE_SETTING, 'auto');
	return mode === 'manual' ? 'manual' : 'auto';
}

function isExtensionEnabled(): boolean {
	return vscode.workspace.getConfiguration('staticverifier').get<boolean>('enable', true);
}

function sortVerificationIssues(issues: VerificationIssue[]): VerificationIssue[] {
	return [...issues].sort((a, b) => {
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
	const revealDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
		border: '1px solid',
		borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
		isWholeLine: true,
		overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
		overviewRulerLane: vscode.OverviewRulerLane.Center
	});
	let revealEditors: vscode.TextEditor[] = [];
	const revealProblemsIfNeeded = async (issueCount: number) => {
		if (issueCount > 0) {
			await vscode.commands.executeCommand('workbench.actions.view.problems');
		}
	};
	const clearRevealHighlights = () => {
		for (const editor of revealEditors) {
			editor.setDecorations(revealDecoration, []);
		}
		revealEditors = [];
	};
	const buildRevealRange = (document: vscode.TextDocument, target: SourceRevealTarget): vscode.Range => {
		const line = Math.min(Math.max(0, target.line - 1), Math.max(0, document.lineCount - 1));
		const textLine = document.lineAt(line);
		const column = Math.min(Math.max(0, target.column - 1), textLine.text.length);
		const tokenLength = Math.max(1, target.highlightText?.length ?? target.path?.length ?? 1);
		const endColumn = Math.min(textLine.text.length, column + tokenLength);
		if (endColumn > column) {
			return new vscode.Range(line, column, line, endColumn);
		}
		return textLine.range;
	};
	const revealSourceLocations = async (locations: SourceRevealTarget[]) => {
		clearRevealHighlights();
		for (const [index, location] of locations.entries()) {
			const uri = vscode.Uri.parse(location.uri);
			const document = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(document, {
				preview: false,
				preserveFocus: true,
				viewColumn: locations.length > 1
					? (index === 0 ? vscode.ViewColumn.Two : vscode.ViewColumn.Three)
					: vscode.ViewColumn.Beside
			});
			const range = buildRevealRange(document, location);
			const position = range.start;
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
			editor.setDecorations(revealDecoration, [range]);
			revealEditors.push(editor);
		}
	};

	const verifyContracts = vscode.commands.registerCommand('staticverifier.verifyContracts', async () => {
		if (!isExtensionEnabled()) {
			vscode.window.showInformationMessage('StaticVerifier is disabled via staticverifier.enable.');
			return;
		}
		const summary = await runContractVerification(diagnostics, true);
		await revealProblemsIfNeeded(summary.totalIssues);
	});

	const openInterface = vscode.commands.registerCommand('staticverifier.openInterface', () => {
		if (!isExtensionEnabled()) {
			vscode.window.showInformationMessage('StaticVerifier is disabled via staticverifier.enable.');
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'staticVerifierPopupMockup',
			'StaticVerifier Interface',
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
			if (!isExtensionEnabled() && message.type !== 'browseLocal') {
				await panel.webview.postMessage({
					type: 'actionResult',
					text: 'StaticVerifier is disabled via staticverifier.enable.'
				});
				return;
			}

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
				await revealProblemsIfNeeded(summary.totalIssues);
				await panel.webview.postMessage({
					type: 'actionResult',
					text: summaryText
				});
				await panel.webview.postMessage({
					type: 'verificationReport',
					summaryText,
					issues: sortVerificationIssues(summary.issues)
				});
				return;
			}

			if (message.type === 'discoverApis') {
				const tempDiagnostics = vscode.languages.createDiagnosticCollection(`${DIAGNOSTIC_COLLECTION}-discovery-temp`);
				try {
					const [frontendFiles, backendFiles] = await Promise.all([
						loadConfiguredContracts('frontend', tempDiagnostics),
						loadConfiguredContracts('backend', tempDiagnostics)
					]);
					const toItems = (side: 'frontend' | 'backend', files: Awaited<ReturnType<typeof loadConfiguredContracts>>) =>
						files.flatMap((file) => file.endpoints.map((endpoint) => ({
							uri: file.uri.toString(),
							method: endpoint.method.toUpperCase(),
							path: endpoint.path,
							requestSchema: endpoint.requestSchema,
							responseSchema: endpoint.responseSchema,
							requestHeaders: endpoint.requestHeaders,
							fieldLocations: endpoint.fieldLocations?.map((location) => ({
								...location,
								uri: location.uri || file.uri.toString(),
								method: endpoint.method.toUpperCase(),
								path: endpoint.path,
								side
							})),
							side,
							source: file.uri.scheme === 'file'
								? (vscode.workspace.asRelativePath(file.uri, false) || file.uri.fsPath)
								: file.uri.toString(),
							line: endpoint.sourceLine ?? 1,
							column: endpoint.sourceColumn ?? 1
						})));
					await panel.webview.postMessage({
						type: 'discoveredApis',
						items: [...toItems('frontend', frontendFiles), ...toItems('backend', backendFiles)]
					});
				} finally {
					tempDiagnostics.dispose();
				}
				return;
			}

			if (message.type === 'revealDiscoveredApi') {
				try {
					await revealSourceLocations(message.locations?.length
						? message.locations
						: [{
							uri: message.uri,
							line: message.line,
							column: message.column,
							method: message.method,
							path: message.path,
							side: message.side,
							highlightText: message.highlightText
						}]);
				} catch {
					vscode.window.showWarningMessage('StaticVerifier could not open the source location for this discovered API.');
				}
			}

			if (message.type === 'revealVerificationIssue') {
				try {
					await revealSourceLocations([{
						uri: message.uri,
						line: message.line,
						column: message.column,
						method: message.method,
						path: message.path,
						side: message.side,
						highlightText: message.highlightText
					}]);
				} catch {
					vscode.window.showWarningMessage('StaticVerifier could not open the source location for this verification issue.');
				}
			}

			if (message.type === 'explainVerificationIssue') {
				try {
					const text = await explainIssueWithGroq(context, message.issue);
					await panel.webview.postMessage({
						type: 'aiExplanationResult',
						requestId: message.requestId,
						text
					});
				} catch (error) {
					await panel.webview.postMessage({
						type: 'aiExplanationResult',
						requestId: message.requestId,
						error: error instanceof Error ? error.message : 'Unable to generate AI explanation.'
					});
				}
			}
		});

		context.subscriptions.push(onMessage);
	});

	const statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
	const statusBarMode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	const updateStatusBar = () => {
		if (!isExtensionEnabled()) {
			statusBarMode.text = 'StaticVerifier: Disabled';
			statusBarMode.tooltip = 'StaticVerifier is disabled by staticverifier.enable.';
			return;
		}
		const mode = getVerificationMode();
		statusBarMode.text = mode === 'auto' ? 'StaticVerifier: Auto' : 'StaticVerifier: Manual';
		statusBarMode.tooltip = mode === 'auto'
			? 'Auto-verify on save is enabled. Click to change verification mode.'
			: 'Manual verification mode is enabled. Click to change verification mode.';
	};
	updateStatusBar();
	statusBarIcon.text = '$(list-unordered)';
	statusBarIcon.tooltip = 'Open StaticVerifier interface';
	statusBarIcon.command = 'staticverifier.openInterface';
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
		if (event.affectsConfiguration('staticverifier.enable') || event.affectsConfiguration(`staticverifier.${VERIFICATION_MODE_SETTING}`)) {
			updateStatusBar();
		}
	});

	const onSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
		if (!isExtensionEnabled()) {
			return;
		}
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

	const runStartupVerificationIfNeeded = async () => {
		if (!isExtensionEnabled() || getVerificationMode() === 'manual') {
			return;
		}
		const config = vscode.workspace.getConfiguration('staticverifier');
		const frontend = getContractInputFromConfig(config, 'frontend');
		const backend = getContractInputFromConfig(config, 'backend');
		if (!isContractSourceConfigured(config, 'frontend', frontend) || !isContractSourceConfigured(config, 'backend', backend)) {
			return;
		}
		await runContractVerification(diagnostics, false);
	};

	context.subscriptions.push(
		verifyContracts,
		openInterface,
		configureVerificationMode,
		statusBarIcon,
		statusBarMode,
		onConfigChange,
		onSave,
		revealDecoration,
		diagnostics
	);

	void runStartupVerificationIfNeeded();
}

function getGroqApiKeyFromExtensionRuntime(): string | undefined {
	const key = process.env[GROQ_API_KEY_ENV]?.trim();
	return key ? key : undefined;
}

function parseGroqErrorDetail(detail: string): string {
	if (!detail) {
		return '';
	}
	try {
		const payload = JSON.parse(detail) as {
			error?: {
				message?: string;
				type?: string;
				code?: string;
			};
		};
		const message = payload.error?.message?.trim();
		const type = payload.error?.type?.trim();
		const code = payload.error?.code?.trim();
		return [message, type, code].filter(Boolean).join(' | ').toLowerCase();
	} catch {
		return detail.toLowerCase();
	}
}

function isGroqLimitError(status: number, detail: string): boolean {
	if (status === 429) {
		return true;
	}
	const text = parseGroqErrorDetail(detail);
	return text.includes('rate_limit')
		|| text.includes('rate limit')
		|| text.includes('quota')
		|| text.includes('insufficient_quota')
		|| text.includes('limit reached');
}

function getContextSnippet(text: string, line: number, radius = 18): string {
	const lines = text.split(/\r?\n/);
	const start = Math.max(0, line - 1 - radius);
	const end = Math.min(lines.length, line - 1 + radius + 1);
	return lines
		.slice(start, end)
		.map((value, index) => `${start + index + 1}: ${value}`)
		.join('\n');
}

async function readIssueContext(issue: VerificationIssue): Promise<string> {
	if (!issue.uri) {
		return 'No source URI was available for this issue.';
	}
	const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(issue.uri));
	return [
		`Source: ${issue.file}:${issue.line}:${issue.column}`,
		`Side: ${issue.sourceSide}`,
		`Endpoint: ${issue.method ?? '-'} ${issue.path ?? '-'}`,
		'Nearby source:',
		'```',
		getContextSnippet(document.getText(), issue.line),
		'```'
	].join('\n');
}

function buildGroqPrompt(issue: VerificationIssue, context: string): string {
	return [
		'You are explaining a static API contract verification issue to a developer.',
		'Use the provided source context and issue data. Be specific, concise, and actionable.',
		'Explain what is wrong, the likely root cause, whether it may be a false positive, and what exact code/config to inspect.',
		'Do not invent files or behavior that is not supported by the context.',
		'',
		'Issue:',
		JSON.stringify({
			kind: issue.kind,
			severity: issue.severity,
			message: issue.message,
			method: issue.method,
			path: issue.path,
			sourceSide: issue.sourceSide,
			headerDiffs: issue.headerDiffs,
			schemaDiffs: issue.schemaDiffs
		}, null, 2),
		'',
		context
	].join('\n');
}

async function explainIssueWithGroq(context: vscode.ExtensionContext, issue: VerificationIssue): Promise<string> {
	const key = getGroqApiKeyFromExtensionRuntime();
	if (!key) {
		throw new Error('StaticVerifier AI is not configured by this extension build. The Groq key must be provided by the extension runtime.');
	}
	const model = vscode.workspace.getConfiguration('staticverifier').get<string>('groqModel', 'llama-3.1-8b-instant');
	const sourceContext = await readIssueContext(issue);
	const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${key}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model,
			temperature: 0.2,
			max_tokens: 700,
			messages: [
				{
					role: 'system',
					content: 'You are a senior engineer helping debug frontend/backend API contract mismatches.'
				},
				{
					role: 'user',
					content: buildGroqPrompt(issue, sourceContext)
				}
			]
		})
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		if (isGroqLimitError(response.status, detail)) {
			throw new Error(GROQ_LIMIT_REACHED_MESSAGE);
		}
		throw new Error(`Groq request failed (${response.status}). ${detail.slice(0, 300)}`.trim());
	}
	const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
	const content = payload.choices?.[0]?.message?.content?.trim();
	if (!content) {
		throw new Error('Groq returned an empty explanation.');
	}
	return content;
}

export function deactivate() { }
