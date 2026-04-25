import { ContractInput, ContractSourceEntry } from '../types/messages';

type ContractSide = 'frontend' | 'backend';

type ContractPathFormProps = {
	activeTab: ContractSide;
	frontend: ContractInput;
	backend: ContractInput;
	onActiveTabChange: (side: ContractSide) => void;
	onEntryTypeChange: (side: ContractSide, index: number, type: ContractSourceEntry['type']) => void;
	onEntryValueChange: (side: ContractSide, index: number, value: string) => void;
	onAddEntry: (side: ContractSide) => void;
	onRemoveEntry: (side: ContractSide, index: number) => void;
	onBrowseLocal: (side: ContractSide, index: number) => void;
	getEntryCount: (side: ContractSide, entry: ContractSourceEntry) => number | undefined;
	onPrimaryAction: () => void;
	primaryActionLabel: string;
	isPrimaryDoneAction: boolean;
	isSaving: boolean;
	isCounting: boolean;
	countStatus: 'idle' | 'loading' | 'done';
};

export function ContractPathForm(props: ContractPathFormProps) {
	const {
		activeTab,
		frontend,
		backend,
		onActiveTabChange,
		onEntryTypeChange,
		onEntryValueChange,
		onAddEntry,
		onRemoveEntry,
		onBrowseLocal,
		getEntryCount,
		onPrimaryAction,
		primaryActionLabel,
		isPrimaryDoneAction,
		isSaving,
		isCounting,
		countStatus
	} = props;

	const activeConfig = activeTab === 'frontend' ? frontend : backend;

	return (
		<section className="input-section source-editor">
			<div className="tab-row" aria-label="Contract side">
				<button
					type="button"
					className={`tab-button ${activeTab === 'frontend' ? 'is-active' : ''}`}
					onClick={() => onActiveTabChange('frontend')}
					disabled={isSaving}
				>
					FE Sources
				</button>
				<button
					type="button"
					className={`tab-button ${activeTab === 'backend' ? 'is-active' : ''}`}
					onClick={() => onActiveTabChange('backend')}
					disabled={isSaving}
				>
					BE Sources
				</button>
			</div>

			<div className="tab-panel">
				<div className="editor-header">
					<div>
						<p className="editor-title">{activeTab === 'frontend' ? 'Frontend Sources' : 'Backend Sources'}</p>
						<p className="editor-subtitle">Mix local paths and GitHub links for source loading.</p>
					</div>
					<button type="button" className="secondary-button" onClick={() => onAddEntry(activeTab)} disabled={isSaving}>
						Add Source
					</button>
				</div>
				<div className="source-grid-header" aria-hidden="true">
					<span>Source Type</span>
					<span>Project Link / Path</span>
					<span>Files</span>
					<span>Actions</span>
				</div>

				{activeConfig.entries.map((entry, index) => (
					<div className="source-grid-row" key={`${entry.type}-${index}`}>
					<select
						aria-label={`${activeTab === 'frontend' ? 'Frontend' : 'Backend'} source type ${index + 1}`}
						title="Source type"
						value={entry.type}
						onChange={(event) => onEntryTypeChange(activeTab, index, event.target.value as ContractSourceEntry['type'])}
						disabled={isSaving}
					>
							<option value="local">Local</option>
							<option value="github">GitHub</option>
						</select>
						<input
							type="text"
							placeholder={entry.type === 'local'
								? 'e.g. src/**/api/**/*.ts'
								: 'e.g. https://github.com/org/repo/blob/main/file.ts'}
							value={entry.value}
							onChange={(event) => onEntryValueChange(activeTab, index, event.target.value)}
							disabled={isSaving}
						/>
						<span className="count-pill">
							{(() => {
								if (isCounting) {
									return 'Calculating...';
								}
								const count = getEntryCount(activeTab, entry);
								return typeof count === 'number' ? `${count} files` : 'Pending';
							})()}
						</span>
						<div className="row-actions">
							{entry.type === 'local' ? (
								<button
									type="button"
									className="icon-button"
									onClick={() => onBrowseLocal(activeTab, index)}
									disabled={isSaving}
								>
									Browse
								</button>
							) : (
								<span />
							)}
							<button
								type="button"
								className="icon-button"
								onClick={() => onRemoveEntry(activeTab, index)}
								disabled={isSaving || activeConfig.entries.length <= 1}
							>
								Remove
							</button>
						</div>
					</div>
				))}

				<div className="button-row">
					<span className="editor-hint">Save to validate and persist workspace settings.</span>
					<button
						type="button"
						onClick={onPrimaryAction}
						disabled={isSaving}
						className={isPrimaryDoneAction ? 'success-button' : undefined}
					>
						{isSaving ? 'Saving...' : primaryActionLabel}
					</button>
				</div>
				{countStatus !== 'idle' ? (
					<div className={`inline-status ${countStatus === 'loading' ? 'is-loading' : 'is-done'}`}>
						{countStatus === 'loading' ? (
							<>
								<span className="spinner" aria-hidden="true" />
								<span>Calculating source file counts...</span>
							</>
						) : (
							<>
								<span className="status-dot" aria-hidden="true" />
								<span>File counts are up to date.</span>
							</>
						)}
					</div>
				) : null}
			</div>
		</section>
	);
}
