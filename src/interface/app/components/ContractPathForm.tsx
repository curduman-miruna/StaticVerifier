import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, Link2 } from 'lucide-react';
import { ContractInput, ContractSourceEntry } from '../types/messages';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Badge, Button, Input } from './ui';

type ContractSide = 'frontend' | 'backend';

type SourceTypeOption = {
	value: ContractSourceEntry['type'];
	label: string;
	icon: typeof FolderOpen;
};

const SOURCE_TYPE_OPTIONS: SourceTypeOption[] = [
	{ value: 'local', label: 'Directory', icon: FolderOpen },
	{ value: 'github', label: 'URL', icon: Link2 }
];

function SourceTypeDropdown({
	value,
	disabled,
	onChange,
	ariaLabel
}: {
	value: ContractSourceEntry['type'];
	disabled: boolean;
	onChange: (next: ContractSourceEntry['type']) => void;
	ariaLabel: string;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const selected = SOURCE_TYPE_OPTIONS.find((item) => item.value === value) ?? SOURCE_TYPE_OPTIONS[0];
	const SelectedIcon = selected.icon;

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const handlePointerDown = (event: PointerEvent) => {
			if (!rootRef.current) {
				return;
			}
			if (!rootRef.current.contains(event.target as Node)) {
				setIsOpen(false);
			}
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setIsOpen(false);
			}
		};
		window.addEventListener('pointerdown', handlePointerDown);
		window.addEventListener('keydown', handleEscape);
		return () => {
			window.removeEventListener('pointerdown', handlePointerDown);
			window.removeEventListener('keydown', handleEscape);
		};
	}, [isOpen]);

	return (
		<div className="source-type-dropdown" ref={rootRef}>
			<button
				type="button"
				className="source-type-trigger"
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={isOpen}
				onClick={() => setIsOpen((current) => !current)}
				disabled={disabled}
			>
				<SelectedIcon size={13} />
				<span>{selected.label}</span>
				<ChevronDown size={11} className={isOpen ? 'is-open' : undefined} />
			</button>
			{isOpen ? (
				<div className="source-type-menu" role="listbox" aria-label="Source type options">
					{SOURCE_TYPE_OPTIONS.map((option) => {
						const OptionIcon = option.icon;
						return (
							<button
								key={option.value}
								type="button"
								role="option"
								aria-selected={value === option.value}
								className={`source-type-option ${value === option.value ? 'is-selected' : ''}`}
								onClick={() => {
									onChange(option.value);
									setIsOpen(false);
								}}
							>
								<OptionIcon size={13} />
								<span>{option.label}</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

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
	const unsavedChanges = !isPrimaryDoneAction;
	const saveState: 'idle' | 'counting' | 'validating' | 'done' =
		isSaving ? 'validating' : countStatus === 'loading' ? 'counting' : countStatus === 'done' && !unsavedChanges ? 'done' : 'idle';
	const saveLabel = {
		idle: 'Save & Validate',
		counting: 'Counting files...',
		validating: 'Validating sources...',
		done: 'Saved!'
	}[saveState];

	return (
		<section className="source-config">
			<div className="source-config-tabs" aria-label="Contract side">
				{(['frontend', 'backend'] as const).map((side) => {
					const isCurrent = activeTab === side;
					const label = side === 'frontend' ? 'Frontend Sources' : 'Backend Sources';
					const count = side === 'frontend' ? frontend.entries.length : backend.entries.length;
					return (
						<Button
							key={side}
							className={`source-config-tab ${isCurrent ? 'is-active' : ''}`}
							onClick={() => onActiveTabChange(side)}
							disabled={isSaving}
							variant="ghost"
							size="sm"
						>
							<span>{label}</span>
							<Badge className="source-config-tab-count">{count}</Badge>
						</Button>
					);
				})}
			</div>

			<div className="source-config-body">
				<div className="source-config-header">
					<div>
						<p className="editor-title">{activeTab === 'frontend' ? 'Frontend Sources' : 'Backend Sources'}</p>
						<p className="editor-subtitle">Add local paths or GitHub URLs for discovery and verification.</p>
					</div>
					<Button
						className="source-config-add"
						onClick={() => onAddEntry(activeTab)}
						disabled={isSaving}
						variant="outline"
						size="sm"
					>
						+ Add source
					</Button>
				</div>

				<div className="source-grid-header" aria-hidden="true">
					<span>Type</span>
					<span>Path / URL</span>
					<span>Files</span>
					<span>Actions</span>
				</div>

				{activeConfig.entries.length === 0 ? (
					<p className="source-config-empty">No sources configured yet.</p>
				) : (
					activeConfig.entries.map((entry, index) => (
						<div className="source-grid-row" key={`${entry.type}-${index}`}>
							<SourceTypeDropdown
								value={entry.type}
								ariaLabel={`${activeTab === 'frontend' ? 'Frontend' : 'Backend'} source type ${index + 1}`}
								onChange={(nextType) => onEntryTypeChange(activeTab, index, nextType)}
								disabled={isSaving}
							/>
							<Input
								placeholder={entry.type === 'local'
									? 'e.g. src/**/api/**/*.ts'
									: 'e.g. https://github.com/org/repo/blob/main/file.ts'}
								value={entry.value}
								onChange={(event) => onEntryValueChange(activeTab, index, event.target.value)}
								disabled={isSaving}
							/>
							<Badge className="count-pill">
								{(() => {
									if (isCounting) {
										return 'Counting...';
									}
									const count = getEntryCount(activeTab, entry);
									return typeof count === 'number' ? `${count} files` : 'Pending';
								})()}
							</Badge>
							<div className="row-actions">
								{entry.type === 'local' ? (
									<Button
										className="icon-button"
										onClick={() => onBrowseLocal(activeTab, index)}
										disabled={isSaving}
										variant="outline"
										size="sm"
									>
										Browse
									</Button>
								) : (
									<span />
								)}
								<Button
									className="icon-button"
									onClick={() => onRemoveEntry(activeTab, index)}
									disabled={isSaving || activeConfig.entries.length <= 1}
									variant="outline"
									size="sm"
								>
									Remove
								</Button>
							</div>
						</div>
					))
				)}

				<Button
					className="source-config-add source-config-add-secondary"
					onClick={() => onAddEntry(activeTab)}
					disabled={isSaving}
					variant="outline"
					size="sm"
				>
					+ Add source
				</Button>

				<div className="source-config-footer">
					<div className="source-config-save-state">
						{saveState === 'done' ? (
							<>
								<CheckCircle2 size={13} />
								<span>Sources saved and indexed.</span>
							</>
						) : saveState === 'counting' || saveState === 'validating' ? (
							<>
								<Loader2 size={13} className="sv-spin" />
								<span>{saveState === 'counting' ? 'Counting files across sources...' : 'Validating paths and connectivity...'}</span>
							</>
						) : unsavedChanges ? (
							<>
								<span className="status-dot status-dot-warn" aria-hidden="true" />
								<span>Unsaved changes.</span>
							</>
						) : (
							<span>Ready.</span>
						)}
					</div>

					<div className="source-config-actions">
							<Button
								onClick={onPrimaryAction}
								disabled={isSaving}
								className={saveState === 'done' ? 'success-button' : undefined}
								variant="default"
								size="md"
							>
								{saveState === 'done' ? <CheckCircle2 size={13} /> : null}
								{saveState === 'validating' ? <Loader2 size={13} className="sv-spin" /> : null}
								{saveLabel}
							</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
