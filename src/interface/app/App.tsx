import { useEffect, useMemo, useState } from 'react';
import { ContractPathForm } from './components/ContractPathForm';
import { HeaderBar } from './components/HeaderBar';
import { MonitorPanel } from './components/MonitorPanel';
import { Badge, Button, Card } from './components/ui';
import { useHostMessage } from './hooks/useHostMessage';
import { postToHost } from './hooks/useVsCodeApi';
import { ContractInput, ContractSourceEntry, InitialState } from './types/messages';
import type { SchemaFieldSourceLocation, SourceRevealTarget, VerificationIssue } from '../../shared/messages';

type DiscoveredApi = {
	uri: string;
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	requestHeaders?: string[];
	fieldLocations?: SchemaFieldSourceLocation[];
	side: 'frontend' | 'backend';
	source: string;
	line: number;
	column: number;
	highlightText?: string;
	skipCounterpartReveal?: boolean;
};

type AiExplanationState = {
	status: 'loading' | 'done' | 'error';
	text?: string;
	error?: string;
};

function createEntry(type: ContractSourceEntry['type'], value: string): ContractSourceEntry {
	return { type, value };
}

function defaultContractInput(defaultPath: string): ContractInput {
	return {
		entries: [createEntry('local', defaultPath)]
	};
}

function cleanEntries(entries: ContractSourceEntry[]): ContractSourceEntry[] {
	const cleaned = entries
		.map((entry) => ({ ...entry, value: entry.value.trim() }))
		.filter((entry) => entry.value.length > 0);
	return cleaned.length > 0 ? cleaned : [createEntry('local', '')];
}

function normalizeApiPath(rawPath: string): string {
	const noQuery = rawPath.trim().split(/[?#]/)[0];
	const normalizedParams = noQuery
		.replace(/\/\{[^/}]+\}/g, '/{param}')
		.replace(/\/:[^/]+/g, '/{param}');
	const collapsed = normalizedParams.replace(/\/+/g, '/');
	if (collapsed.length > 1 && collapsed.endsWith('/')) {
		return collapsed.slice(0, -1);
	}
	return collapsed;
}

function apiMatchKey(item: Pick<DiscoveredApi, 'method' | 'path'>): string {
	return `${item.method.toUpperCase()} ${normalizeApiPath(item.path)}`;
}

function getInitialState(): InitialState {
	const raw = window.__STATIC_VERIFIER_INITIAL_STATE__;
	if (!raw) {
		return {
			frontend: defaultContractInput('**/contracts/frontend.contract.json'),
			backend: defaultContractInput('**/contracts/backend.contract.json'),
			hasConfiguredPaths: false
		};
	}

	return {
		...raw,
		frontend: { entries: cleanEntries(raw.frontend.entries) },
		backend: { entries: cleanEntries(raw.backend.entries) }
	};
}

export default function App() {
	const initialState = useMemo(getInitialState, []);
	const [frontend, setFrontend] = useState(initialState.frontend);
	const [backend, setBackend] = useState(initialState.backend);
	const [activeTab, setActiveTab] = useState<'frontend' | 'backend'>('frontend');
	const [output, setOutput] = useState('Ready.');
	const [hasConfiguredPaths, setHasConfiguredPaths] = useState(initialState.hasConfiguredPaths);
	const [isEditMode, setIsEditMode] = useState(!initialState.hasConfiguredPaths);
	const [isSaving, setIsSaving] = useState(false);
	const [sourceCounts, setSourceCounts] = useState<Record<string, number>>({});
	const [countStatus, setCountStatus] = useState<'idle' | 'loading' | 'done'>('idle');
	const [isDirty, setIsDirty] = useState(false);
	const [verificationIssues, setVerificationIssues] = useState<VerificationIssue[]>([]);
	const [discoveredApis, setDiscoveredApis] = useState<DiscoveredApi[]>([]);
	const [isDiscoveringApis, setIsDiscoveringApis] = useState(false);
	const [lastScannedAt, setLastScannedAt] = useState<Date | undefined>(undefined);
	const [aiExplanations, setAiExplanations] = useState<Record<string, AiExplanationState>>({});

	useHostMessage((message) => {
		if (message.type === 'actionResult') {
			setIsSaving(false);
			setOutput(message.text);
			if (!message.text.includes('Compared FE endpoints:')) {
				setVerificationIssues([]);
			}
			if (message.text.includes('saved')) {
				setHasConfiguredPaths(true);
				setIsDirty(false);
				if (countStatus !== 'loading') {
					setCountStatus('done');
				}
			}
			if (message.text.toLowerCase().includes('failed')) {
				setCountStatus('idle');
			}
			return;
		}

		if (message.type === 'verificationReport') {
			setOutput(message.summaryText);
			setVerificationIssues(message.issues);
			setLastScannedAt(new Date());
			return;
		}

		if (message.type === 'discoveredApis') {
			setDiscoveredApis(message.items);
			setIsDiscoveringApis(false);
			setLastScannedAt(new Date());
			return;
		}

		if (message.type === 'sourceCounts') {
			const next: Record<string, number> = {};
			for (const item of message.items) {
				next[`${item.side}|${item.type}|${item.value}`] = item.fileCount;
			}
			setSourceCounts(next);
			setCountStatus('done');
			setLastScannedAt(new Date());
			return;
		}

		if (message.type === 'contractSourcesChanged') {
			setFrontend({ entries: cleanEntries(message.frontend.entries) });
			setBackend({ entries: cleanEntries(message.backend.entries) });
			setHasConfiguredPaths(true);
			setIsDirty(false);
			setIsEditMode(false);
			setLastScannedAt(new Date());
			return;
		}

		if (message.type === 'aiExplanationResult') {
			setAiExplanations((current) => ({
				...current,
				[message.requestId]: message.error
					? { status: 'error', error: message.error }
					: { status: 'done', text: message.text ?? '' }
			}));
			return;
		}

		if (message.type === 'browseResult') {
			setIsSaving(false);
			if (message.error) {
				setOutput(message.error);
				return;
			}

			if (!message.value) {
				return;
			}

			updateSide(message.side, (current) => ({
				...current,
				entries: current.entries.map((entry, entryIndex) =>
					entryIndex === message.index ? { ...entry, value: message.value ?? entry.value } : entry
				)
			}));
		}
	});

	const updateSide = (
		side: 'frontend' | 'backend',
		updater: (current: ContractInput) => ContractInput,
		options?: { markDirty?: boolean }
	) => {
		const markDirty = options?.markDirty ?? true;
		if (side === 'frontend') {
			setFrontend((current) => updater(current));
		} else {
			setBackend((current) => updater(current));
		}
		if (markDirty) {
			setIsDirty(true);
			setCountStatus('idle');
		}
	};

	const savePaths = () => {
		setIsSaving(true);
		setCountStatus('loading');
		setOutput('Saving settings and validating sources...');
		postToHost({
			type: 'savePaths',
			frontend: { entries: cleanEntries(frontend.entries) },
			backend: { entries: cleanEntries(backend.entries) }
		});
	};

	const verifyContracts = () => {
		postToHost({ type: 'verifyContracts' });
	};

	const discoverApis = () => {
		setIsDiscoveringApis(true);
		postToHost({ type: 'discoverApis' });
	};

	const exportOpenApi = () => {
		postToHost({ type: 'exportOpenApi' });
	};

	const loadDemoSources = () => {
		setIsSaving(true);
		setCountStatus('loading');
		postToHost({ type: 'loadDemoSources' });
	};

	const revealDiscoveredApi = (item: DiscoveredApi) => {
		const selectedKey = apiMatchKey(item);
		const counterpart = discoveredApis.find((candidate) =>
			candidate.side !== item.side
			&& apiMatchKey(candidate) === selectedKey
		);
		const ordered = [item, item.skipCounterpartReveal ? undefined : counterpart]
			.filter((location): location is DiscoveredApi => Boolean(location))
			.sort((a, b) => {
				if (a.side === b.side) {
					return 0;
				}
				return a.side === 'frontend' ? -1 : 1;
			});
		postToHost({
			type: 'revealDiscoveredApi',
			uri: item.uri,
			line: item.line,
			column: item.column,
			method: item.method,
			path: item.path,
			side: item.side,
			locations: ordered.map((location) => ({
				uri: location.uri,
				line: location.line,
				column: location.column,
				method: location.method,
				path: location.path,
				side: location.side,
				highlightText: location.highlightText
			}))
		});
	};

	const revealVerificationIssue = (issue: VerificationIssue) => {
		if (!issue.uri) {
			return;
		}
		postToHost({
			type: 'revealVerificationIssue',
			uri: issue.uri,
			line: issue.line,
			column: issue.column,
			method: issue.method,
			path: issue.path,
			side: issue.sourceSide,
			highlightText: issue.path
		});
	};

	const revealVerificationField = (location: SourceRevealTarget) => {
		postToHost({
			type: 'revealVerificationIssue',
			uri: location.uri,
			line: location.line,
			column: location.column,
			method: location.method,
			path: location.path,
			side: location.side,
			highlightText: location.highlightText
		});
	};

	const explainVerificationIssue = (requestId: string, issue: VerificationIssue) => {
		setAiExplanations((current) => ({
			...current,
			[requestId]: { status: 'loading' }
		}));
		postToHost({
			type: 'explainVerificationIssue',
			requestId,
			issue
		});
	};

	const copyIssueFix = (issue: VerificationIssue) => {
		postToHost({
			type: 'copyIssueFix',
			issue
		});
	};

	const handlePrimaryEditAction = () => {
		if (!isDirty && countStatus === 'done' && hasConfiguredPaths && !isSaving) {
			setIsEditMode(false);
			return;
		}
		savePaths();
	};

	useEffect(() => {
		if (hasConfiguredPaths && !isEditMode) {
			verifyContracts();
			discoverApis();
			setCountStatus('loading');
			postToHost({ type: 'refreshSourceCounts' });
		}
	}, [hasConfiguredPaths, isEditMode]);

	const getEntryCount = (side: 'frontend' | 'backend', entry: ContractSourceEntry): number | undefined => {
		return sourceCounts[`${side}|${entry.type}|${entry.value.trim()}`];
	};

	const getSideFileTotal = (side: 'frontend' | 'backend', input: ContractInput): number | undefined => {
		let hasAny = false;
		let total = 0;
		for (const entry of input.entries) {
			const count = getEntryCount(side, entry);
			if (typeof count === 'number') {
				hasAny = true;
				total += count;
			}
		}
		return hasAny ? total : undefined;
	};

	const frontendFiles = getSideFileTotal('frontend', frontend);
	const backendFiles = getSideFileTotal('backend', backend);
	const mode = isEditMode ? 'configure' : 'monitor';
	const hasRuntimeError = output.toLowerCase().includes('failed');
	const headerErrorDetail = hasRuntimeError ? output : undefined;
	const headerStatus: 'ready' | 'scanning' | 'error' | 'unconfigured' = !hasConfiguredPaths
		? 'unconfigured'
		: hasRuntimeError
			? 'error'
			: 'ready';
	const isHeaderScanning = isSaving || countStatus === 'loading' || isDiscoveringApis;
	const totalEndpoints = discoveredApis.length;
	const isDemoActive = frontend.entries.some((entry) => entry.value === '.staticverifier-demo/frontend/demoClient.ts')
		&& backend.entries.some((entry) => entry.value === '.staticverifier-demo/backend/demoApi.py');

	const handleMonitorRescan = async () => {
		verifyContracts();
		discoverApis();
		setCountStatus('loading');
		postToHost({ type: 'refreshSourceCounts' });
	};

	return (
		<>
			<HeaderBar
				metrics={{
					feSources: frontend.entries.length,
					feIndexed: frontendFiles,
					beSources: backend.entries.length,
					beIndexed: backendFiles,
					lastScanned: lastScannedAt,
					status: headerStatus
				}}
				mode={mode}
				onModeChange={(nextMode) => setIsEditMode(nextMode === 'configure')}
				isScanning={isHeaderScanning}
				statusDetail={headerErrorDetail}
			/>
			<main className="panel panel-after-header">

				{hasConfiguredPaths && !isEditMode ? (
					<section className="input-section summary-view">
						<Card className="summary-card">
							<div className="summary-card-header">
								<h3>Frontend Sources</h3>
								<Badge>{frontend.entries.length}</Badge>
							</div>
							<p className="summary-metric">
								{countStatus === 'loading' ? '...' : typeof frontendFiles === 'number' ? frontendFiles : '...'} files
							</p>
						</Card>
						<Card className="summary-card">
							<div className="summary-card-header">
								<h3>Backend Sources</h3>
								<Badge>{backend.entries.length}</Badge>
							</div>
							<p className="summary-metric">
								{countStatus === 'loading' ? '...' : typeof backendFiles === 'number' ? backendFiles : '...'} files
							</p>
						</Card>
						<div className="button-row summary-actions">
							<span className="editor-hint">Source paths are hidden here. Use Edit Sources to review or change them.</span>
							<Button onClick={verifyContracts}>Refresh Verification</Button>
						</div>
					</section>
				) : (
					<ContractPathForm
						activeTab={activeTab}
						frontend={frontend}
						backend={backend}
						onActiveTabChange={setActiveTab}
						onEntryTypeChange={(side, index, type) => {
							updateSide(side, (current) => ({
								...current,
								entries: current.entries.map((entry, entryIndex) =>
									entryIndex === index ? { ...entry, type } : entry
								)
							}));
						}}
						onEntryValueChange={(side, index, value) => {
							updateSide(side, (current) => ({
								...current,
								entries: current.entries.map((entry, entryIndex) =>
									entryIndex === index ? { ...entry, value } : entry
								)
							}));
						}}
						onAddEntry={(side) => {
							updateSide(side, (current) => ({
								...current,
								entries: [...current.entries, createEntry('local', '')]
							}));
						}}
						onRemoveEntry={(side, index) => {
							updateSide(side, (current) => {
								const next = current.entries.filter((_, entryIndex) => entryIndex !== index);
								return {
									...current,
									entries: next.length > 0 ? next : [createEntry('local', '')]
								};
							});
						}}
						onBrowseLocal={(side, index) => {
							setOutput('Opening folder picker...');
							postToHost({ type: 'browseLocal', side, index });
						}}
						getEntryCount={getEntryCount}
						onPrimaryAction={handlePrimaryEditAction}
						primaryActionLabel={!isDirty && countStatus === 'done' && hasConfiguredPaths ? 'Done, Head Back' : 'Save Sources'}
						isPrimaryDoneAction={!isDirty && countStatus === 'done' && hasConfiguredPaths}
						isSaving={isSaving}
						isCounting={countStatus === 'loading'}
						countStatus={countStatus}
					/>
				)}

				{!isEditMode ? (
					<MonitorPanel
						metrics={{
							totalEndpoints,
							mismatchCount: verificationIssues.length,
							feIndexed: frontendFiles ?? 0,
							beIndexed: backendFiles ?? 0
						}}
						mismatches={verificationIssues}
						discoveredApis={discoveredApis}
						isDiscovering={isDiscoveringApis}
						onRescan={handleMonitorRescan}
						onRevealIssue={revealVerificationIssue}
						onRevealField={revealVerificationField}
						onExplainIssue={explainVerificationIssue}
						onCopyIssueFix={copyIssueFix}
						aiExplanations={aiExplanations}
						onRevealDiscoveredApi={revealDiscoveredApi}
						onRefreshDiscovery={discoverApis}
						onExportOpenApi={exportOpenApi}
						onLoadDemoSources={loadDemoSources}
						demoActive={isDemoActive}
					/>
				) : null}
			</main>
		</>
	);
}
