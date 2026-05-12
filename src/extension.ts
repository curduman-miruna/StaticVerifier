import * as vscode from 'vscode';
import { StaticVerifierCodeActionProvider } from './host/actions/contractCodeActions';
import {
	getContractInputFromConfig,
	isContractSourceConfigured,
	sanitizeContractInput,
	saveContractInput
} from './host/config/contractsConfig';
import { EndpointInlineCompletionProvider } from './host/completion/endpointInlineCompletionProvider';
import { ResponseFieldCompletionProvider } from './host/completion/responseFieldCompletionProvider';
import { browseLocalEntry } from './host/contracts/browseLocalEntry';
import { loadConfiguredContracts } from './host/contracts/loadContracts';
import { computeSourceCounts, validateBeforeSave } from './host/contracts/sourceValidation';
import { findTrackedLocalContractUris } from './host/contracts/findTrackedLocalContractUris';
import { buildOpenApiDocument } from './host/export/openApiExport';
import { findSelectedEndpointInOtherSource } from './host/navigation/findEndpointInOtherSource';
import { describeEndpointSchema } from './host/navigation/endpointSchemaLookup';
import { EndpointHoverProvider } from './host/navigation/endpointHoverProvider';
import { loadEndpointIndex, type IndexedEndpoint } from './host/navigation/endpointIndex';
import { EndpointCodeLensProvider, EndpointDefinitionProvider, EndpointReferenceProvider } from './host/navigation/endpointProviders';
import { findEndpointModelDefinitions, type EndpointModelScope, type EndpointModelSide } from './host/navigation/modelDefinitionLookup';
import { formatVerificationSummary, runContractVerification } from './host/verification/verifier';
import { EndpointTreeProvider } from './host/views/endpointTreeProvider';
import { getPopupWebviewHtml } from './host/webviewHtml';
import type { PopupMessage, SourceRevealTarget, VerificationIssue } from './shared/messages';
import type { ContractInput } from './shared/contracts';

const DIAGNOSTIC_COLLECTION = 'staticverifier';
const VERIFICATION_MODE_SETTING = 'verificationMode';
const GROQ_API_KEY_ENV = 'STATICVERIFIER_GROQ_API_KEY';
const GROQ_LIMIT_REACHED_MESSAGE = 'StaticVerifier AI limit reached. This extension uses a shared Groq quota, so no more AI explanations can be generated right now. Please try again later.';
const DEMO_BACKUP_KEY = 'staticverifier.demo.previousSources';
const DEMO_FRONTEND_INPUT: ContractInput = { entries: [{ type: 'local', value: '.staticverifier-demo/frontend/demoClient.ts' }] };
const DEMO_BACKEND_INPUT: ContractInput = { entries: [{ type: 'local', value: '.staticverifier-demo/backend/demoApi.py' }] };
const DEFAULT_FRONTEND_INPUT: ContractInput = { entries: [{ type: 'local', value: '**/contracts/frontend.contract.json' }] };
const DEFAULT_BACKEND_INPUT: ContractInput = { entries: [{ type: 'local', value: '**/contracts/backend.contract.json' }] };
type VerificationMode = 'auto' | 'manual';
type DemoToggleResult = {
	frontend: ContractInput;
	backend: ContractInput;
	demoActive: boolean;
	message: string;
};

const ENDPOINT_COMPLETION_SELECTOR: vscode.DocumentSelector = [
	{ scheme: 'file', language: 'typescript' },
	{ scheme: 'file', language: 'typescriptreact' },
	{ scheme: 'file', language: 'javascript' },
	{ scheme: 'file', language: 'javascriptreact' }
];
const ENDPOINT_NAVIGATION_SELECTOR: vscode.DocumentSelector = [{ scheme: 'file' }];

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

function parseEndpointFromMessage(message: string): { method: string; path: string } | undefined {
	const match = message.match(/\b([A-Z][A-Z0-9_-]*)\s+(\/[^\s."]+)/);
	if (!match) {
		return undefined;
	}
	return { method: match[1], path: match[2] };
}

function formatRevealTargetSource(target: SourceRevealTarget): string {
	try {
		const uri = vscode.Uri.parse(target.uri);
		const source = uri.scheme === 'file'
			? (vscode.workspace.asRelativePath(uri, false) || uri.fsPath)
			: uri.toString();
		return `${source}:${target.line}`;
	} catch {
		return `${target.uri}:${target.line}`;
	}
}

function indexedEndpointToRevealTarget(endpoint: IndexedEndpoint): SourceRevealTarget {
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

function isDemoInput(input: ContractInput, demoInput: ContractInput): boolean {
	const values = new Set(input.entries.map((entry) => `${entry.type}:${entry.value}`));
	return demoInput.entries.every((entry) => values.has(`${entry.type}:${entry.value}`));
}

function isDemoConfigured(frontend: ContractInput, backend: ContractInput): boolean {
	return isDemoInput(frontend, DEMO_FRONTEND_INPUT) && isDemoInput(backend, DEMO_BACKEND_INPUT);
}

export function activate(context: vscode.ExtensionContext) {
	const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION);
	const endpointCompletionProvider = new EndpointInlineCompletionProvider();
	const responseFieldCompletionProvider = new ResponseFieldCompletionProvider();
	const endpointTreeProvider = new EndpointTreeProvider();
	const endpointInlineCompletions = vscode.languages.registerInlineCompletionItemProvider(
		ENDPOINT_COMPLETION_SELECTOR,
		endpointCompletionProvider
	);
	const responseFieldCompletions = vscode.languages.registerCompletionItemProvider(
		ENDPOINT_COMPLETION_SELECTOR,
		responseFieldCompletionProvider,
		'.',
		'{',
		',',
		' '
	);
	const endpointDefinitions = vscode.languages.registerDefinitionProvider(
		ENDPOINT_NAVIGATION_SELECTOR,
		new EndpointDefinitionProvider()
	);
	const endpointReferences = vscode.languages.registerReferenceProvider(
		ENDPOINT_NAVIGATION_SELECTOR,
		new EndpointReferenceProvider()
	);
	const endpointHovers = vscode.languages.registerHoverProvider(
		ENDPOINT_NAVIGATION_SELECTOR,
		new EndpointHoverProvider()
	);
	const endpointCodeLenses = vscode.languages.registerCodeLensProvider(
		ENDPOINT_NAVIGATION_SELECTOR,
		new EndpointCodeLensProvider()
	);
	const staticVerifierCodeActions = vscode.languages.registerCodeActionsProvider(
		ENDPOINT_NAVIGATION_SELECTOR,
		new StaticVerifierCodeActionProvider(),
		{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
	);
	const endpointTree = vscode.window.createTreeView('staticverifier.endpoints', {
		treeDataProvider: endpointTreeProvider,
		showCollapseAll: true
	});
	const revealDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
		border: '1px solid',
		borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
		isWholeLine: true,
		overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
		overviewRulerLane: vscode.OverviewRulerLane.Center
	});
	const matchedEndpointDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
		isWholeLine: true,
		overviewRulerColor: new vscode.ThemeColor('testing.iconPassed'),
		overviewRulerLane: vscode.OverviewRulerLane.Right
	});
	const warningEndpointDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
		isWholeLine: true,
		overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
		overviewRulerLane: vscode.OverviewRulerLane.Right
	});
	const missingEndpointDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editorError.background'),
		isWholeLine: true,
		overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
		overviewRulerLane: vscode.OverviewRulerLane.Right
	});
	let revealEditors: vscode.TextEditor[] = [];
	let lastIssues: VerificationIssue[] = [];
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
	const revealChosenSourceLocations = async (locations: SourceRevealTarget[], placeHolder: string) => {
		if (locations.length <= 1) {
			await revealSourceLocations(locations);
			return;
		}
		const selection = await vscode.window.showQuickPick(
			locations.map((location, index) => ({
				label: `${location.side?.toUpperCase() ?? 'SRC'} ${location.method ?? ''} ${location.path ?? ''}`.trim(),
				description: formatRevealTargetSource(location),
				detail: location.highlightText,
				location,
				index
			})),
			{ placeHolder }
		);
		if (!selection) {
			return;
		}
		await revealSourceLocations([selection.location]);
	};
	const updateEndpointDecorations = async (issues: VerificationIssue[] = lastIssues) => {
		lastIssues = issues;
		const endpoints = await loadEndpointIndex().catch(() => []);
		const issueByKey = new Map<string, VerificationIssue[]>();
		for (const issue of issues) {
			if (!issue.method || !issue.path) {
				continue;
			}
			const key = `${issue.sourceSide}:${issue.method.toUpperCase()} ${issue.path}`;
			const list = issueByKey.get(key) ?? [];
			list.push(issue);
			issueByKey.set(key, list);
		}
		const sidesByKey = new Map<string, Set<string>>();
		for (const endpoint of endpoints) {
			const sides = sidesByKey.get(endpoint.key) ?? new Set<string>();
			sides.add(endpoint.side);
			sidesByKey.set(endpoint.key, sides);
		}
		for (const editor of vscode.window.visibleTextEditors) {
			const matched: vscode.Range[] = [];
			const warnings: vscode.Range[] = [];
			const missing: vscode.Range[] = [];
			const uri = editor.document.uri.toString();
			for (const endpoint of endpoints.filter((item) => item.file.uri.toString() === uri)) {
				const line = Math.min(Math.max(0, (endpoint.endpoint.sourceLine ?? 1) - 1), editor.document.lineCount - 1);
				const range = editor.document.lineAt(line).range;
				const endpointIssues = issueByKey.get(`${endpoint.side}:${endpoint.method} ${endpoint.path}`) ?? [];
				if (endpointIssues.some((issue) => issue.kind === 'missing-backend' || issue.kind === 'backend-only')) {
					missing.push(range);
				} else if (endpointIssues.length > 0) {
					warnings.push(range);
				} else if (sidesByKey.get(endpoint.key)?.size === 2) {
					matched.push(range);
				}
			}
			editor.setDecorations(matchedEndpointDecoration, matched);
			editor.setDecorations(warningEndpointDecoration, warnings);
			editor.setDecorations(missingEndpointDecoration, missing);
		}
	};

	const verifyContracts = vscode.commands.registerCommand('staticverifier.verifyContracts', async () => {
		if (!isExtensionEnabled()) {
			vscode.window.showInformationMessage('StaticVerifier is disabled via staticverifier.enable.');
			return;
		}
		const summary = await runContractVerification(diagnostics, true);
		await updateEndpointDecorations(summary.issues);
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
				retainContextWhenHidden: true,
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
				const summary = await runContractVerification(diagnostics, false);
				await updateEndpointDecorations(summary.issues);
				const summaryText = formatVerificationSummary(summary);
				await panel.webview.postMessage({
					type: 'verificationReport',
					summaryText,
					issues: sortVerificationIssues(summary.issues)
				});
				const tempDiagnostics = vscode.languages.createDiagnosticCollection(`${DIAGNOSTIC_COLLECTION}-demo-discovery-temp`);
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
				await updateEndpointDecorations(summary.issues);
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

			if (message.type === 'exportOpenApi') {
				await vscode.commands.executeCommand('staticverifier.exportOpenApi');
				return;
			}

			if (message.type === 'loadDemoSources') {
				const result = await vscode.commands.executeCommand<DemoToggleResult>('staticverifier.loadDemoSources');
				if (!result) {
					return;
				}
				await panel.webview.postMessage({
					type: 'actionResult',
					text: result.message
				});
				await panel.webview.postMessage({
					type: 'contractSourcesChanged',
					frontend: result.frontend,
					backend: result.backend,
					demoActive: result.demoActive
				});
				const refreshed = await computeSourceCounts(result.frontend, result.backend);
				await panel.webview.postMessage({
					type: 'sourceCounts',
					items: [...refreshed.frontendCounts, ...refreshed.backendCounts]
				});
				return;
			}

			if (message.type === 'copyIssueFix') {
				if (message.issue.kind === 'missing-backend') {
					await vscode.commands.executeCommand('staticverifier.copyEndpointStub', message.issue.message);
				} else if (message.issue.kind === 'backend-only') {
					await vscode.commands.executeCommand('staticverifier.copyFrontendCallStub', message.issue.message);
				} else if (message.issue.kind === 'header-mismatch') {
					await vscode.commands.executeCommand('staticverifier.copyHeaderFixPrompt', message.issue.message);
				} else {
					await vscode.commands.executeCommand('staticverifier.copySchemaFixPrompt', message.issue.message);
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

	const findEndpointInOtherSource = vscode.commands.registerCommand('staticverifier.findEndpointInOtherSource', async () => {
		if (!isExtensionEnabled()) {
			vscode.window.showInformationMessage('StaticVerifier is disabled via staticverifier.enable.');
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('StaticVerifier: open a FE or BE source file and select an endpoint path first.');
			return;
		}

		const selectedText = editor.document.getText(editor.selection).trim();
		if (!selectedText) {
			vscode.window.showWarningMessage('StaticVerifier: select an endpoint path first, for example /api/users.');
			return;
		}

		const result = await findSelectedEndpointInOtherSource(editor.document, selectedText, editor.selection.active);
		if (result.kind === 'matches') {
			await revealChosenSourceLocations(result.targets, `Select ${result.otherSide.toUpperCase()} match for ${result.method ? `${result.method} ` : ''}${result.path}`);
			return;
		}

		if (result.kind === 'invalid-selection') {
			vscode.window.showWarningMessage(`StaticVerifier: "${result.selection}" is not a valid endpoint path.`);
			return;
		}
		if (result.kind === 'no-sources') {
			vscode.window.showWarningMessage('StaticVerifier could not load FE/BE sources. Check the StaticVerifier source settings.');
			return;
		}
		if (result.kind === 'ambiguous-side') {
			await revealChosenSourceLocations(result.targets, `Select endpoint match for ${result.method ? `${result.method} ` : ''}${result.path}`);
			return;
		}
		const method = result.method ? `${result.method} ` : '';
		vscode.window.showInformationMessage(`StaticVerifier: no ${result.otherSide.toUpperCase()} match found for ${method}${result.path}.`);
	});

	const findEndpointInOtherSourceAt = vscode.commands.registerCommand(
		'staticverifier.findEndpointInOtherSourceAt',
		async (uriString?: string, endpointText?: string, line?: number, character?: number) => {
			const editor = vscode.window.activeTextEditor;
			const document = uriString
				? await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString))
				: editor?.document;
			if (!document || !endpointText) {
				await vscode.commands.executeCommand('staticverifier.findEndpointInOtherSource');
				return;
			}
			const position = new vscode.Position(line ?? 0, character ?? 0);
			const result = await findSelectedEndpointInOtherSource(document, endpointText, position);
			if (result.kind === 'matches') {
				await revealChosenSourceLocations(result.targets, `Select ${result.otherSide.toUpperCase()} match for ${result.method ? `${result.method} ` : ''}${result.path}`);
				return;
			}
			if (result.kind === 'ambiguous-side') {
				await revealChosenSourceLocations(result.targets, `Select endpoint match for ${result.method ? `${result.method} ` : ''}${result.path}`);
				return;
			}
			if (result.kind === 'no-matches') {
				const method = result.method ? `${result.method} ` : '';
				vscode.window.showInformationMessage(`StaticVerifier: no ${result.otherSide.toUpperCase()} match found for ${method}${result.path}.`);
				return;
			}
			vscode.window.showWarningMessage('StaticVerifier could not find a counterpart for this endpoint.');
		}
	);

	const showEndpointSchemaAt = vscode.commands.registerCommand(
		'staticverifier.showEndpointSchemaAt',
		async (uriString?: string, endpointText?: string) => {
			const editor = vscode.window.activeTextEditor;
			const document = uriString
				? await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString))
				: editor?.document;
			if (!document || !endpointText) {
				vscode.window.showWarningMessage('StaticVerifier: select an endpoint path first.');
				return;
			}
			const schema = await describeEndpointSchema(endpointText, document.getText());
			if (!schema) {
				vscode.window.showInformationMessage('StaticVerifier: no schema found for this endpoint.');
				return;
			}
			const output = vscode.window.createOutputChannel('StaticVerifier Schema');
			output.clear();
			output.appendLine(schema);
			output.show(true);
		}
	);

	const showEndpointSchema = vscode.commands.registerCommand('staticverifier.showEndpointSchema', async () => {
		const editor = vscode.window.activeTextEditor;
		const selectedText = editor?.document.getText(editor.selection).trim();
		if (!editor || !selectedText) {
			vscode.window.showWarningMessage('StaticVerifier: select an endpoint path first.');
			return;
		}
		await vscode.commands.executeCommand(
			'staticverifier.showEndpointSchemaAt',
			editor.document.uri.toString(),
			selectedText,
			editor.selection.active.line,
			editor.selection.active.character
		);
	});

	const goToEndpointModelAt = vscode.commands.registerCommand(
		'staticverifier.goToEndpointModelAt',
		async (
			uriString?: string,
			endpointText?: string,
			scope?: EndpointModelScope,
			sideOrLine?: EndpointModelSide | number,
			lineOrCharacter?: number,
			character?: number
		) => {
			const editor = vscode.window.activeTextEditor;
			const document = uriString
				? await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString))
				: editor?.document;
			if (!document || !endpointText || (scope !== 'request' && scope !== 'response')) {
				vscode.window.showWarningMessage('StaticVerifier: endpoint model navigation needs an endpoint and model scope.');
				return;
			}
			const side = sideOrLine === 'frontend' || sideOrLine === 'backend' ? sideOrLine : undefined;
			const line = typeof sideOrLine === 'number' ? sideOrLine : lineOrCharacter;
			const resolvedCharacter = typeof sideOrLine === 'number' ? lineOrCharacter : character;
			const result = await findEndpointModelDefinitions(
				document,
				endpointText,
				scope,
				side,
				new vscode.Position(line ?? 0, resolvedCharacter ?? 0)
			);
			if (result.kind === 'matches') {
				await revealSourceLocations(result.targets);
				return;
			}
			if (result.kind === 'no-model') {
				const sideLabel = side ? `${side.toUpperCase()} ` : '';
				vscode.window.showInformationMessage(`StaticVerifier: no ${sideLabel}${scope} model found for ${result.path}.`);
				return;
			}
			if (result.kind === 'no-endpoint') {
				const sideLabel = side ? `${side.toUpperCase()} ` : '';
				vscode.window.showInformationMessage(`StaticVerifier: no ${sideLabel}endpoint found for ${result.path}.`);
				return;
			}
			vscode.window.showWarningMessage('StaticVerifier could not resolve this endpoint model.');
		}
	);

	const goToSelectedEndpointModel = async (scope: EndpointModelScope, side: EndpointModelSide) => {
		const editor = vscode.window.activeTextEditor;
		const selectedText = editor?.document.getText(editor.selection).trim();
		if (!editor || !selectedText) {
			vscode.window.showWarningMessage('StaticVerifier: select an endpoint path first.');
			return;
		}
		await vscode.commands.executeCommand(
			'staticverifier.goToEndpointModelAt',
			editor.document.uri.toString(),
			selectedText,
			scope,
			side,
			editor.selection.active.line,
			editor.selection.active.character
		);
	};
	const goToFrontendRequestModel = vscode.commands.registerCommand('staticverifier.goToFrontendRequestModel', () => goToSelectedEndpointModel('request', 'frontend'));
	const goToFrontendResponseModel = vscode.commands.registerCommand('staticverifier.goToFrontendResponseModel', () => goToSelectedEndpointModel('response', 'frontend'));
	const goToBackendRequestModel = vscode.commands.registerCommand('staticverifier.goToBackendRequestModel', () => goToSelectedEndpointModel('request', 'backend'));
	const goToBackendResponseModel = vscode.commands.registerCommand('staticverifier.goToBackendResponseModel', () => goToSelectedEndpointModel('response', 'backend'));

	const searchEndpoint = vscode.commands.registerCommand('staticverifier.searchEndpoint', async () => {
		const endpoints = await loadEndpointIndex();
		const selection = await vscode.window.showQuickPick(
			endpoints.map((endpoint) => ({
				label: `${endpoint.method} ${endpoint.path}`,
				description: `${endpoint.side.toUpperCase()} ${endpoint.source}:${endpoint.endpoint.sourceLine ?? 1}`,
				detail: [
					`Request: ${endpoint.endpoint.requestSchema ?? '-'}`,
					`Response: ${endpoint.endpoint.responseSchema ?? '-'}`,
					`Headers: ${(endpoint.endpoint.requestHeaders ?? []).join(', ') || '-'}`
				].join(' | '),
				endpoint
			})),
			{ placeHolder: 'Search StaticVerifier endpoints by path, method, side, source, schema, or header', matchOnDescription: true, matchOnDetail: true }
		);
		if (!selection) {
			return;
		}
		await revealSourceLocations([indexedEndpointToRevealTarget(selection.endpoint)]);
	});

	const explainSelectedEndpoint = vscode.commands.registerCommand(
		'staticverifier.explainSelectedEndpoint',
		async (uriString?: string, endpointText?: string, line?: number, character?: number) => {
			const editor = vscode.window.activeTextEditor;
			const document = uriString
				? await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString))
				: editor?.document;
			const text = endpointText ?? editor?.document.getText(editor.selection).trim();
			if (!document || !text) {
				vscode.window.showWarningMessage('StaticVerifier: select an endpoint with a verification issue first.');
				return;
			}
			const lookup = await findSelectedEndpointInOtherSource(document, text, new vscode.Position(line ?? 0, character ?? 0));
			const path = lookup.kind === 'matches' || lookup.kind === 'no-matches' || lookup.kind === 'ambiguous-side' ? lookup.path : undefined;
			const method = lookup.kind === 'matches' || lookup.kind === 'no-matches' || lookup.kind === 'ambiguous-side' ? lookup.method : undefined;
			const summary = await runContractVerification(diagnostics, false);
			await updateEndpointDecorations(summary.issues);
			const issue = summary.issues.find((item) =>
				item.path === path && (!method || item.method === method)
			);
			if (!issue) {
				vscode.window.showInformationMessage(`StaticVerifier: no verification issue found for ${method ? `${method} ` : ''}${path ?? 'selection'}.`);
				return;
			}
			const output = vscode.window.createOutputChannel('StaticVerifier Explain');
			output.clear();
			output.appendLine(`StaticVerifier issue explanation for ${issue.method ?? ''} ${issue.path ?? ''}`);
			output.appendLine('');
			output.appendLine(await explainIssueWithGroq(context, issue));
			output.show(true);
		}
	);

	const verifyEndpointAt = vscode.commands.registerCommand('staticverifier.verifyEndpointAt', async () => {
		const summary = await runContractVerification(diagnostics, true);
		await updateEndpointDecorations(summary.issues);
		await revealProblemsIfNeeded(summary.totalIssues);
	});

	const copyText = vscode.commands.registerCommand('staticverifier.copyText', async (text?: string) => {
		await vscode.env.clipboard.writeText(text ?? '');
		vscode.window.showInformationMessage('StaticVerifier: copied to clipboard.');
	});

	const copyEndpointStub = vscode.commands.registerCommand('staticverifier.copyEndpointStub', async (message?: string) => {
		const endpoint = parseEndpointFromMessage(message ?? '');
		const routePath = endpoint?.path.replace(/^\/api\/v\d+/, '') ?? '/TODO';
		const method = endpoint?.method.toLowerCase() ?? 'get';
		const functionName = routePath
			.split('/')
			.filter(Boolean)
			.map((part) => part.replace(/[{}:-]/g, '_'))
			.join('_') || 'missing_endpoint';
		const stub = [
			`@router.${method}("${routePath}")`,
			`def ${functionName}():`,
			'    # TODO: implement backend route for the frontend contract',
			'    return {"ok": True}'
		].join('\n');
		await vscode.env.clipboard.writeText(stub);
		vscode.window.showInformationMessage('StaticVerifier: backend route stub copied to clipboard.');
	});

	const copySchemaFixPrompt = vscode.commands.registerCommand('staticverifier.copySchemaFixPrompt', async (message?: string) => {
		await vscode.env.clipboard.writeText([
			'Fix this StaticVerifier schema mismatch.',
			'Preserve existing behavior and update the smallest appropriate request/response model or mapper.',
			'',
			message ?? ''
		].join('\n'));
		vscode.window.showInformationMessage('StaticVerifier: schema fix prompt copied to clipboard.');
	});

	const copyHeaderFixPrompt = vscode.commands.registerCommand('staticverifier.copyHeaderFixPrompt', async (message?: string) => {
		await vscode.env.clipboard.writeText([
			'Fix this StaticVerifier header mismatch.',
			'Preserve endpoint behavior and update the frontend request/client configuration to send the required backend header(s).',
			'Check shared API clients, auth interceptors, fetch credentials, and per-request headers before adding duplicate header logic.',
			'',
			message ?? ''
		].join('\n'));
		vscode.window.showInformationMessage('StaticVerifier: header fix prompt copied to clipboard.');
	});

	const copyFrontendCallStub = vscode.commands.registerCommand('staticverifier.copyFrontendCallStub', async (message?: string) => {
		const endpoint = parseEndpointFromMessage(message ?? '');
		const method = endpoint?.method ?? 'GET';
		const path = endpoint?.path ?? '/TODO';
		const functionName = path
			.split('/')
			.filter(Boolean)
			.map((part, index) => {
				const cleaned = part.replace(/[{}:-]/g, ' ');
				const words = cleaned.split(/\s+/).filter(Boolean);
				const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
				return index === 0 ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : pascal;
			})
			.join('') || 'backendEndpoint';
		const stub = [
			`export async function ${functionName}() {`,
			`  const res = await fetch(\`\${API_URL}${path}\`, { method: '${method}' });`,
			'  return res.json();',
			'}'
		].join('\n');
		await vscode.env.clipboard.writeText(stub);
		vscode.window.showInformationMessage('StaticVerifier: frontend call stub copied to clipboard.');
	});

	const loadDemoSources = vscode.commands.registerCommand('staticverifier.loadDemoSources', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showWarningMessage('StaticVerifier: open a workspace folder before loading demo sources.');
			return;
		}
		const config = vscode.workspace.getConfiguration('staticverifier');
		const currentFrontend = getContractInputFromConfig(config, 'frontend');
		const currentBackend = getContractInputFromConfig(config, 'backend');
		if (isDemoConfigured(currentFrontend, currentBackend)) {
			const backup = context.workspaceState.get<{ frontend?: ContractInput; backend?: ContractInput }>(DEMO_BACKUP_KEY);
			const restoredFrontend = backup?.frontend ?? DEFAULT_FRONTEND_INPUT;
			const restoredBackend = backup?.backend ?? DEFAULT_BACKEND_INPUT;
			await saveContractInput(config, 'frontend', restoredFrontend);
			await saveContractInput(config, 'backend', restoredBackend);
			await context.workspaceState.update(DEMO_BACKUP_KEY, undefined);
			endpointCompletionProvider.invalidate();
			responseFieldCompletionProvider.invalidate();
			endpointTreeProvider.refresh();
			const summary = await runContractVerification(diagnostics, false);
			await updateEndpointDecorations(summary.issues);
			vscode.window.showInformationMessage('StaticVerifier demo sources restored to previous configuration.');
			return {
				frontend: restoredFrontend,
				backend: restoredBackend,
				demoActive: false,
				message: 'Demo sources restored to the previous StaticVerifier configuration.'
			} satisfies DemoToggleResult;
		}

		await context.workspaceState.update(DEMO_BACKUP_KEY, {
			frontend: currentFrontend,
			backend: currentBackend
		});
		const demoRoot = vscode.Uri.joinPath(workspaceFolder.uri, '.staticverifier-demo');
		const frontendUri = vscode.Uri.joinPath(demoRoot, 'frontend', 'demoClient.ts');
		const backendUri = vscode.Uri.joinPath(demoRoot, 'backend', 'demoApi.py');
		const encoder = new TextEncoder();
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(demoRoot, 'frontend'));
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(demoRoot, 'backend'));
		await vscode.workspace.fs.writeFile(frontendUri, encoder.encode([
			'const API_URL = import.meta.env.VITE_API_URL;',
			'',
			'type ProfileDto = { id: string; email: string; displayName: string };',
			'type CreateUserRequest = { email: string; displayName: string; role: string };',
			'type UserDto = { id: string; email: string; username: string };',
			'type BillingSummary = { plan: string; nextInvoiceDate: string; totalDue: number };',
			'type AdminReport = { id: string; total: number };',
			'type PrimitiveMatchDto = { id: string; active: boolean };',
			'type NumericCompatibilityDto = { count: number; total: number };',
			'type PrimitiveTypeMismatchDto = { score: string };',
			'type MissingRequestFieldPayload = { email: string };',
			'type MissingRequestFieldResponse = { ok: boolean };',
			'type MissingResponseFieldDto = { id: string; totalDue: number };',
			'type RenamedFieldDto = { displayName: string; createdAt: string };',
			'type ExtraBackendFieldDto = { id: string; email: string };',
			'type NullableCompatibilityDto = { note: string | null };',
			'type ArrayCompatibilityDto = { tags: string[] };',
			'',
			'export async function matchedProfile(): Promise<ProfileDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/matched-profile`, {",
			"    method: 'GET',",
			"    headers: { Authorization: 'Bearer demo-token' }",
			'  });',
			'  return res.json();',
			'}',
			'',
			'export async function requestSchemaMismatch(payload: CreateUserRequest): Promise<UserDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/request-schema-mismatch`, {",
			"    method: 'POST',",
			'    body: JSON.stringify(payload)',
			'  });',
			'  return res.json();',
			'}',
			'',
			'export async function responseSchemaMismatch(): Promise<BillingSummary> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/response-schema-mismatch`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function headerMismatch(): Promise<AdminReport[]> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/header-mismatch`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function missingBackend(): Promise<void> {',
			"  await fetch(`${API_URL}/api/v1/demo/missing-backend`, { method: 'DELETE' });",
			'}',
			'',
			'export async function rulePrimitiveMatch(): Promise<PrimitiveMatchDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/primitive-match`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function ruleNumericCompatibility(): Promise<NumericCompatibilityDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/numeric-compatibility`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function rulePrimitiveTypeMismatch(): Promise<PrimitiveTypeMismatchDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/primitive-type-mismatch`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function ruleMissingRequestField(payload: MissingRequestFieldPayload): Promise<MissingRequestFieldResponse> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/missing-request-field`, {",
			"    method: 'POST',",
			'    body: JSON.stringify(payload)',
			'  });',
			'  return res.json();',
			'}',
			'',
			'export async function ruleMissingResponseField(): Promise<MissingResponseFieldDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/missing-response-field`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function ruleRenamedFieldCompatible(): Promise<RenamedFieldDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/renamed-field-compatible`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function ruleExtraBackendFieldCompatible(): Promise<ExtraBackendFieldDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/extra-backend-field-compatible`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function ruleNullableCompatible(): Promise<NullableCompatibilityDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/nullable-compatible`, { method: 'GET' });",
			'  return res.json();',
			'}',
			'',
			'export async function ruleArrayCompatible(): Promise<ArrayCompatibilityDto> {',
			"  const res = await fetch(`${API_URL}/api/v1/demo/rules/array-compatible`, { method: 'GET' });",
			'  return res.json();',
			'}'
		].join('\n')));
		await vscode.workspace.fs.writeFile(backendUri, encoder.encode([
			'from fastapi import APIRouter, Header',
			'from pydantic import BaseModel',
			'',
			'router = APIRouter(prefix="/api/v1")',
			'',
			'class ProfileDto(BaseModel):',
			'    id: str',
			'    email: str',
			'    displayName: str',
			'',
			'class CreateUserRequest(BaseModel):',
			'    email: str',
			'    username: str',
			'    role: str',
			'',
			'class UserDto(BaseModel):',
			'    id: str',
			'    email: str',
			'    username: str',
			'',
			'class BillingSummary(BaseModel):',
			'    plan: str',
			'    renewalDate: str',
			'    balanceDue: float',
			'',
			'class AdminReport(BaseModel):',
			'    id: str',
			'    total: float',
			'',
			'class PrimitiveMatchDto(BaseModel):',
			'    id: str',
			'    active: bool',
			'',
			'class NumericCompatibilityDto(BaseModel):',
			'    count: int',
			'    total: float',
			'',
			'class PrimitiveTypeMismatchDto(BaseModel):',
			'    score: int',
			'',
			'class MissingRequestFieldPayload(BaseModel):',
			'    email: str',
			'    username: str',
			'',
			'class MissingRequestFieldResponse(BaseModel):',
			'    ok: bool',
			'',
			'class MissingResponseFieldDto(BaseModel):',
			'    id: str',
			'',
			'class RenamedFieldDto(BaseModel):',
			'    display_name: str',
			'    created_at: str',
			'',
			'class ExtraBackendFieldDto(BaseModel):',
			'    id: str',
			'    email: str',
			'    created_at: str',
			'',
			'class NullableCompatibilityDto(BaseModel):',
			'    note: str',
			'',
			'class ArrayCompatibilityDto(BaseModel):',
			'    tags: list[str]',
			'',
			'@router.get("/demo/matched-profile", response_model=ProfileDto)',
			'def matched_profile(authorization: str = Header(...)):',
			'    return {"id": "1", "email": "demo@example.com", "displayName": "Demo User"}',
			'',
			'@router.post("/demo/request-schema-mismatch", response_model=UserDto)',
			'def request_schema_mismatch(payload: CreateUserRequest):',
			'    return {"id": "1", "email": payload.email, "username": payload.username}',
			'',
			'@router.get("/demo/response-schema-mismatch", response_model=BillingSummary)',
			'def response_schema_mismatch():',
			'    return {"plan": "Team", "renewalDate": "2026-06-01", "balanceDue": 42.0}',
			'',
			'@router.get("/demo/header-mismatch", response_model=list[AdminReport])',
			'def header_mismatch(authorization: str = Header(...)):',
			'    return [{"id": "r-1", "total": 42.0}]',
			'',
			'@router.get("/demo/backend-only")',
			'def backend_only():',
			'    return {"ok": True}',
			'',
			'@router.get("/demo/rules/primitive-match", response_model=PrimitiveMatchDto)',
			'def rule_primitive_match():',
			'    return {"id": "1", "active": True}',
			'',
			'@router.get("/demo/rules/numeric-compatibility", response_model=NumericCompatibilityDto)',
			'def rule_numeric_compatibility():',
			'    return {"count": 3, "total": 42.5}',
			'',
			'@router.get("/demo/rules/primitive-type-mismatch", response_model=PrimitiveTypeMismatchDto)',
			'def rule_primitive_type_mismatch():',
			'    return {"score": 10}',
			'',
			'@router.post("/demo/rules/missing-request-field", response_model=MissingRequestFieldResponse)',
			'def rule_missing_request_field(payload: MissingRequestFieldPayload):',
			'    return {"ok": True}',
			'',
			'@router.get("/demo/rules/missing-response-field", response_model=MissingResponseFieldDto)',
			'def rule_missing_response_field():',
			'    return {"id": "invoice-1"}',
			'',
			'@router.get("/demo/rules/renamed-field-compatible", response_model=RenamedFieldDto)',
			'def rule_renamed_field_compatible():',
			'    return {"display_name": "Demo User", "created_at": "2026-05-12"}',
			'',
			'@router.get("/demo/rules/extra-backend-field-compatible", response_model=ExtraBackendFieldDto)',
			'def rule_extra_backend_field_compatible():',
			'    return {"id": "1", "email": "demo@example.com", "created_at": "2026-05-12"}',
			'',
			'@router.get("/demo/rules/nullable-compatible", response_model=NullableCompatibilityDto)',
			'def rule_nullable_compatible():',
			'    return {"note": "available"}',
			'',
			'@router.get("/demo/rules/array-compatible", response_model=ArrayCompatibilityDto)',
			'def rule_array_compatible():',
			'    return {"tags": ["alpha", "beta"]}'
		].join('\n')));
		await saveContractInput(config, 'frontend', DEMO_FRONTEND_INPUT);
		await saveContractInput(config, 'backend', DEMO_BACKEND_INPUT);
		endpointCompletionProvider.invalidate();
		responseFieldCompletionProvider.invalidate();
		endpointTreeProvider.refresh();
		const summary = await runContractVerification(diagnostics, false);
		await updateEndpointDecorations(summary.issues);
		vscode.window.showInformationMessage('StaticVerifier demo sources loaded.');
		return {
			frontend: DEMO_FRONTEND_INPUT,
			backend: DEMO_BACKEND_INPUT,
			demoActive: true,
			message: 'Demo sources saved. Click Undo Demo to restore the previous StaticVerifier configuration.'
		} satisfies DemoToggleResult;
	});

	const exportOpenApi = vscode.commands.registerCommand('staticverifier.exportOpenApi', async () => {
		const document = await buildOpenApiDocument();
		const opened = await vscode.workspace.openTextDocument({
			language: 'json',
			content: JSON.stringify(document, null, 2)
		});
		await vscode.window.showTextDocument(opened, { preview: false });
	});

	const refreshEndpointTree = vscode.commands.registerCommand('staticverifier.refreshEndpointTree', () => {
		endpointTreeProvider.refresh();
	});

	const revealEndpointTarget = vscode.commands.registerCommand('staticverifier.revealEndpointTarget', async (target: SourceRevealTarget) => {
		await revealSourceLocations([target]);
	});
	const onVisibleEditorsChange = vscode.window.onDidChangeVisibleTextEditors(() => {
		void updateEndpointDecorations();
	});

	const onConfigChange = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('staticverifier.enable') || event.affectsConfiguration(`staticverifier.${VERIFICATION_MODE_SETTING}`)) {
			updateStatusBar();
		}
		if (event.affectsConfiguration('staticverifier')) {
			endpointCompletionProvider.invalidate();
			responseFieldCompletionProvider.invalidate();
			endpointTreeProvider.refresh();
		}
	});

	const onSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
		endpointCompletionProvider.invalidate();
		responseFieldCompletionProvider.invalidate();
		endpointTreeProvider.refresh();
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

		const summary = await runContractVerification(diagnostics, false);
		await updateEndpointDecorations(summary.issues);
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
		const summary = await runContractVerification(diagnostics, false);
		await updateEndpointDecorations(summary.issues);
	};

	context.subscriptions.push(
		verifyContracts,
		openInterface,
		configureVerificationMode,
		findEndpointInOtherSource,
		findEndpointInOtherSourceAt,
		showEndpointSchemaAt,
		showEndpointSchema,
		goToEndpointModelAt,
		goToFrontendRequestModel,
		goToFrontendResponseModel,
		goToBackendRequestModel,
		goToBackendResponseModel,
		searchEndpoint,
		explainSelectedEndpoint,
		verifyEndpointAt,
		copyText,
		copyEndpointStub,
		copySchemaFixPrompt,
		copyHeaderFixPrompt,
		copyFrontendCallStub,
		loadDemoSources,
		exportOpenApi,
		refreshEndpointTree,
		revealEndpointTarget,
		endpointInlineCompletions,
		endpointCompletionProvider,
		responseFieldCompletions,
		responseFieldCompletionProvider,
		endpointDefinitions,
		endpointReferences,
		endpointHovers,
		endpointCodeLenses,
		staticVerifierCodeActions,
		endpointTree,
		endpointTreeProvider,
		statusBarIcon,
		statusBarMode,
		onConfigChange,
		onSave,
		onVisibleEditorsChange,
		revealDecoration,
		matchedEndpointDecoration,
		warningEndpointDecoration,
		missingEndpointDecoration,
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
