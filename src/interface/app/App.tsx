import { useEffect, useMemo, useState } from 'react';
import { ContractPathForm } from './components/ContractPathForm';
import { HeaderBar } from './components/HeaderBar';
import { MonitorPanel } from './components/MonitorPanel';
import { Badge, Button, Card } from './components/ui';
import { useHostMessage } from './hooks/useHostMessage';
import { postToHost } from './hooks/useVsCodeApi';
import { ContractInput, ContractSourceEntry, InitialState } from './types/messages';
import type { VerificationIssue } from '../../shared/messages';

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
	const [discoveredApis, setDiscoveredApis] = useState<Array<{
		uri: string;
		method: string;
		path: string;
		requestSchema?: string;
		responseSchema?: string;
		side: 'frontend' | 'backend';
		source: string;
		line: number;
		column: number;
	}>>([]);
	const [isDiscoveringApis, setIsDiscoveringApis] = useState(false);
	const [lastScannedAt, setLastScannedAt] = useState<Date | undefined>(undefined);

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

	const revealDiscoveredApi = (item: {
		uri: string;
		line: number;
		column: number;
	}) => {
		postToHost({
			type: 'revealDiscoveredApi',
			uri: item.uri,
			line: item.line,
			column: item.column
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
	const hasVerificationErrors =
		output.toLowerCase().includes('failed') || verificationIssues.some((issue) => issue.severity === 'error');
	const headerStatus: 'ready' | 'scanning' | 'error' | 'unconfigured' = !hasConfiguredPaths
		? 'unconfigured'
		: hasVerificationErrors
			? 'error'
			: 'ready';
	const isHeaderScanning = isSaving || countStatus === 'loading' || isDiscoveringApis;
	const totalEndpoints = discoveredApis.length;

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
						onRevealDiscoveredApi={revealDiscoveredApi}
						onRefreshDiscovery={discoverApis}
					/>
				) : null}
			</main>
		</>
	);
}
