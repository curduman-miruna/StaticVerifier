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
	onSavePaths: () => void;
	isSaving: boolean;
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
		onSavePaths,
		isSaving
	} = props;

	const activeConfig = activeTab === 'frontend' ? frontend : backend;

	return (
		<section className="input-section">
			<div className="tab-row" role="tablist" aria-label="Contract side">
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

			<label>Sources</label>
			<div className="source-grid-header" aria-hidden="true">
				<span>Source Type</span>
				<span>Project Link / Path</span>
				<span>Files</span>
				<span>Action</span>
			</div>

			{activeConfig.entries.map((entry, index) => (
				<div className="source-grid-row" key={`${entry.type}-${index}`}>
					<select
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
							const count = getEntryCount(activeTab, entry);
							return typeof count === 'number' ? `${count} files` : '-';
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

			<button type="button" className="secondary-button" onClick={() => onAddEntry(activeTab)} disabled={isSaving}>
				Add Source
			</button>

			<div className="button-row">
				<button type="button" onClick={onSavePaths} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save Settings'}</button>
				<span />
			</div>
		</section>
	);
}
