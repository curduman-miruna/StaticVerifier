import { useEffect, useMemo, useState } from 'react';
import { ContractPathForm } from './components/ContractPathForm';
import { OutputPanel } from './components/OutputPanel';
import { useHostMessage } from './hooks/useHostMessage';
import { postToHost } from './hooks/useVsCodeApi';
import { ContractInput, ContractSourceEntry, InitialState } from './types/messages';

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

	useHostMessage((message) => {
		if (message.type === 'actionResult') {
			setIsSaving(false);
			setOutput(message.text);
			if (message.text.includes('saved')) {
				setHasConfiguredPaths(true);
				setIsEditMode(false);
			}
			return;
		}

		if (message.type === 'sourceCounts') {
			const next: Record<string, number> = {};
			for (const item of message.items) {
				next[`${item.side}|${item.type}|${item.value}`] = item.fileCount;
			}
			setSourceCounts(next);
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
		updater: (current: ContractInput) => ContractInput
	) => {
		if (side === 'frontend') {
			setFrontend((current) => updater(current));
			return;
		}

		setBackend((current) => updater(current));
	};

	const savePaths = () => {
		setIsSaving(true);
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

	useEffect(() => {
		if (hasConfiguredPaths && !isEditMode) {
			verifyContracts();
			postToHost({ type: 'refreshSourceCounts' });
		}
	}, [hasConfiguredPaths, isEditMode]);

	const getEntryCount = (side: 'frontend' | 'backend', entry: ContractSourceEntry): number | undefined => {
		return sourceCounts[`${side}|${entry.type}|${entry.value.trim()}`];
	};

	const sourceLabel = (side: 'frontend' | 'backend', input: ContractInput): string => {
		return input.entries
			.map((entry) => {
				const count = getEntryCount(side, entry);
				const suffix = typeof count === 'number' ? ` (${count} files)` : '';
				return `${entry.type.toUpperCase()} | ${entry.value}${suffix}`;
			})
			.join('\n');
	};

	return (
		<main className="panel">
			<header className="panel-header">
				<div className="panel-header-row">
					<h1>StaticVerifier</h1>
					{hasConfiguredPaths && !isEditMode ? (
						<button
							type="button"
							className="corner-button"
							onClick={() => setIsEditMode(true)}
						>
							Edit Sources
						</button>
					) : null}
				</div>
				<p>
					{hasConfiguredPaths && !isEditMode
						? 'Current FE/BE sources are configured. Edit or run verification.'
						: 'First-time setup: configure FE and BE sources before verification.'}
				</p>
			</header>

			{hasConfiguredPaths && !isEditMode ? (
				<section className="input-section">
					<label>Frontend sources</label>
					<pre className="path-preview">{sourceLabel('frontend', frontend)}</pre>
					<label>Backend sources</label>
					<pre className="path-preview">{sourceLabel('backend', backend)}</pre>
					<div className="button-row">
						<span />
						<button type="button" onClick={verifyContracts}>Refresh Verification</button>
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
						setIsSaving(true);
						setOutput('Opening folder picker...');
						postToHost({ type: 'browseLocal', side, index });
					}}
					getEntryCount={getEntryCount}
					onSavePaths={savePaths}
					isSaving={isSaving}
				/>
			)}

			<OutputPanel text={output} />
		</main>
	);
}
