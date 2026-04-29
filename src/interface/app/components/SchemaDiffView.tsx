import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Minus, Plus, RefreshCw } from 'lucide-react';
import type { SchemaDiff, SchemaField, SchemaFieldDiff, SchemaFieldStatus, SourceRevealTarget } from '../../../shared/messages';

const statusConfig: Record<
	SchemaFieldStatus,
	{
		label: string;
		feStyle: string;
		beStyle: string;
		icon: ReactNode;
		iconClass: string;
		badgeStyle: string;
		showConnector: boolean;
	}
> = {
	match: {
		label: 'Match',
		feStyle: 'sv-schema-cell-match',
		beStyle: 'sv-schema-cell-match',
		icon: <CheckCircle2 size={11} />,
		iconClass: 'sv-schema-icon-match',
		badgeStyle: 'sv-schema-status-match',
		showConnector: true
	},
	renamed: {
		label: 'Renamed',
		feStyle: 'sv-schema-cell-renamed',
		beStyle: 'sv-schema-cell-renamed',
		icon: <RefreshCw size={11} />,
		iconClass: 'sv-schema-icon-renamed',
		badgeStyle: 'sv-schema-status-renamed',
		showConnector: true
	},
	'type-changed': {
		label: 'Type changed',
		feStyle: 'sv-schema-cell-type',
		beStyle: 'sv-schema-cell-type',
		icon: <AlertTriangle size={11} />,
		iconClass: 'sv-schema-icon-type',
		badgeStyle: 'sv-schema-status-type',
		showConnector: true
	},
	'fe-only': {
		label: 'FE only',
		feStyle: 'sv-schema-cell-missing',
		beStyle: '',
		icon: <Minus size={11} />,
		iconClass: 'sv-schema-icon-missing',
		badgeStyle: 'sv-schema-status-missing',
		showConnector: false
	},
	'be-only': {
		label: 'BE only',
		feStyle: '',
		beStyle: 'sv-schema-cell-missing',
		icon: <Plus size={11} />,
		iconClass: 'sv-schema-icon-missing',
		badgeStyle: 'sv-schema-status-missing',
		showConnector: false
	},
	'optional-mismatch': {
		label: 'Optional != Required',
		feStyle: 'sv-schema-cell-optional',
		beStyle: 'sv-schema-cell-optional',
		icon: <Info size={11} />,
		iconClass: 'sv-schema-icon-optional',
		badgeStyle: 'sv-schema-status-optional',
		showConnector: true
	}
};

const scopeConfig = {
	request: { label: 'Request Body', icon: '->', style: 'sv-schema-scope-request' },
	response: { label: 'Response Body', icon: '<-', style: 'sv-schema-scope-response' }
} as const;

const sideLabels = {
	request: {
		fe: 'Frontend sends',
		be: 'Backend expects'
	},
	response: {
		fe: 'Frontend expects',
		be: 'Backend returns'
	},
	combined: {
		fe: 'Frontend schema',
		be: 'Backend schema'
	}
} as const;

const scopedStatusLabels: Record<SchemaDiff['scope'], Partial<Record<SchemaFieldStatus, string>>> = {
	request: {
		match: 'Send OK',
		renamed: 'Mapped',
		'type-changed': 'Type mismatch',
		'fe-only': 'FE extra',
		'be-only': 'Missing in FE',
		'optional-mismatch': 'Req mismatch'
	},
	response: {
		match: 'Return OK',
		renamed: 'Mapped',
		'type-changed': 'Type mismatch',
		'fe-only': 'Missing in BE',
		'be-only': 'BE extra',
		'optional-mismatch': 'Req mismatch'
	}
};

function statusLabel(status: SchemaFieldStatus, scope?: SchemaDiff['scope']): string {
	return (scope ? scopedStatusLabels[scope][status] : undefined) ?? statusConfig[status].label;
}

function statusVisualConfig(status: SchemaFieldStatus, scope?: SchemaDiff['scope']) {
	if (scope === 'response' && status === 'be-only') {
		return {
			...statusConfig[status],
			beStyle: 'sv-schema-cell-warning',
			iconClass: 'sv-schema-icon-warning',
			badgeStyle: 'sv-schema-status-warning'
		};
	}
	return statusConfig[status];
}

function formatFieldPath(key: string): ReactNode {
	const segments = key.split('.');
	return segments.map((segment, index) => {
		const isArrayScope = segment.endsWith('[]');
		const text = isArrayScope ? segment.slice(0, -2) : segment;
		return (
			<span key={`${segment}-${index}`} className={index > 0 ? 'sv-schema-path-nested' : undefined}>
				{index > 0 ? <span className="sv-schema-path-separator">.</span> : null}
				<span>{text}</span>
				{isArrayScope ? <span className="sv-schema-array-scope">[]</span> : null}
			</span>
		);
	});
}

function FieldCell({
	field,
	style,
	status,
	peer,
	onRevealField
}: {
	field?: SchemaField;
	style: string;
	status: SchemaFieldStatus;
	peer?: SchemaField;
	onRevealField?: (location: SourceRevealTarget) => void;
}) {
	if (!field) {
		return (
			<div className="sv-schema-field-cell sv-schema-field-empty">
				<span>-</span>
			</div>
		);
	}

	const keyChanged = status === 'renamed' && peer && field.key !== peer.key;
	const typeChanged = status === 'type-changed' && peer && field.type !== peer.type;
	const optionalityMismatch = status === 'optional-mismatch' && peer && field.required !== peer.required;

	const content = (
		<>
			<div className="sv-schema-field-main">
				<code className={`sv-schema-field-key ${keyChanged ? 'sv-schema-mark-renamed' : ''}`}>
					{formatFieldPath(field.key)}
				</code>
				{field.required ? (
					<span className="sv-schema-required" title="Required">*</span>
				) : (
					<span className="sv-schema-optional" title="Optional">?</span>
				)}
				{optionalityMismatch ? (
					<span className={`sv-schema-required-pill ${field.required ? 'is-required' : 'is-optional'}`}>
						{field.required ? 'required' : 'optional'}
					</span>
				) : null}
			</div>
			<code className={`sv-schema-field-type ${typeChanged ? 'sv-schema-mark-type' : ''}`}>
				{field.type}
			</code>
			{field.description ? (
				<span className="sv-schema-field-description">{field.description}</span>
			) : null}
		</>
	);

	return (
		field.location && onRevealField ? (
			<button
				type="button"
				className={`sv-schema-field-cell sv-schema-field-button ${style}`}
				title={`Open ${field.key} usage at line ${field.location.line}`}
				onClick={() => onRevealField(field.location!)}
			>
				{content}
			</button>
		) : (
			<div className={`sv-schema-field-cell ${style}`}>
				{content}
			</div>
		)
	);
}

function Connector({ status }: { status: SchemaFieldStatus }) {
	if (!statusConfig[status].showConnector) {
		return (
			<div className="sv-schema-connector">
				<span>-</span>
			</div>
		);
	}

	const arrowColor =
		status === 'match'
			? 'sv-schema-arrow-match'
			: status === 'renamed'
				? 'sv-schema-arrow-renamed'
				: status === 'type-changed'
					? 'sv-schema-arrow-type'
					: status === 'optional-mismatch'
						? 'sv-schema-arrow-optional'
						: 'sv-schema-arrow-muted';

	return (
		<div className="sv-schema-connector">
			<ArrowRight size={13} className={arrowColor} />
		</div>
	);
}

function FieldRow({
	diff,
	scope,
	onRevealField
}: {
	diff: SchemaFieldDiff;
	scope?: SchemaDiff['scope'];
	onRevealField?: (location: SourceRevealTarget) => void;
}) {
	const cfg = statusVisualConfig(diff.status, scope);
	const label = statusLabel(diff.status, scope);
	return (
		<div className="sv-schema-field-row">
			<FieldCell field={diff.fe} style={diff.fe ? cfg.feStyle : ''} status={diff.status} peer={diff.be} onRevealField={onRevealField} />
			<div className="sv-schema-connector-wrap">
				<Connector status={diff.status} />
			</div>
			<FieldCell field={diff.be} style={diff.be ? cfg.beStyle : ''} status={diff.status} peer={diff.fe} onRevealField={onRevealField} />
			<div className="sv-schema-status-wrap">
				{scope ? (
					<span className={`sv-schema-row-scope ${scopeConfig[scope].style}`}>
						{scope === 'request' ? 'REQ' : 'RES'}
					</span>
				) : null}
				<span className={`sv-schema-status ${cfg.badgeStyle}`}>
					<span className={cfg.iconClass}>{cfg.icon}</span>
					{label}
				</span>
			</div>
		</div>
	);
}

function DiffSummary({ fields, scope }: { fields: SchemaFieldDiff[]; scope?: SchemaDiff['scope'] }) {
	const counts = {
		match: fields.filter((f) => f.status === 'match').length,
		renamed: fields.filter((f) => f.status === 'renamed').length,
		'type-changed': fields.filter((f) => f.status === 'type-changed').length,
		'fe-only': fields.filter((f) => f.status === 'fe-only').length,
		'be-only': fields.filter((f) => f.status === 'be-only').length,
		'optional-mismatch': fields.filter((f) => f.status === 'optional-mismatch').length
	};

	const items = [
		{ key: 'match', label: 'match', style: 'sv-schema-summary-match' },
		{ key: 'renamed', label: 'renamed', style: 'sv-schema-summary-renamed' },
		{ key: 'type-changed', label: 'type !=', style: 'sv-schema-summary-type' },
		{ key: 'fe-only', label: 'FE only', style: 'sv-schema-summary-missing' },
		{ key: 'be-only', label: scope === 'response' ? 'BE extra' : 'BE only', style: scope === 'response' ? 'sv-schema-summary-warning' : 'sv-schema-summary-missing' },
		{ key: 'optional-mismatch', label: 'opt != req', style: 'sv-schema-summary-optional' }
	] as const;

	return (
		<div className="sv-schema-summary">
			{items.map(({ key, label, style }) => (
				counts[key] > 0 ? (
					<span key={key} className={`sv-schema-summary-item ${style}`}>
						<span className="sv-schema-summary-dot" />
						<span className="sv-schema-summary-count">{counts[key]}</span> {label}
					</span>
				) : null
			))}
		</div>
	);
}

function SchemaColumns({ labels }: { labels: { fe: string; be: string } }) {
	return (
		<div className="sv-schema-columns">
			<div className="sv-schema-column">
				<span className="sv-schema-side sv-schema-side-fe">FE</span>
				<span>{labels.fe}</span>
			</div>
			<div className="sv-schema-connector-spacer" />
			<div className="sv-schema-column">
				<span className="sv-schema-side sv-schema-side-be">BE</span>
				<span>{labels.be}</span>
			</div>
			<div className="sv-schema-status-spacer" />
		</div>
	);
}

function ScopeDiffBlock({
	diff,
	defaultOpen,
	onRevealField
}: {
	diff: SchemaDiff;
	defaultOpen?: boolean;
	onRevealField?: (location: SourceRevealTarget) => void;
}) {
	const [open, setOpen] = useState(defaultOpen ?? true);
	const cfg = scopeConfig[diff.scope];
	const problemCount = diff.fields.filter((f) => f.status !== 'match').length;

	return (
		<div className="sv-schema-block">
			<button
				type="button"
				className="sv-schema-block-toggle"
				onClick={() => setOpen((value) => !value)}
			>
				<span className={`sv-schema-scope ${cfg.style}`}>
					<span>{cfg.icon}</span>
					{cfg.label}
				</span>
				{problemCount > 0 ? (
					<span className="sv-schema-problem-count">
						<AlertTriangle size={11} />
						{problemCount} issue{problemCount !== 1 ? 's' : ''}
					</span>
				) : null}
				{open ? <DiffSummary fields={diff.fields} scope={diff.scope} /> : null}
				<div className="sv-schema-labels">
					{diff.feLabel ? <code className="sv-schema-label">{diff.feLabel}</code> : null}
					{diff.beLabel ? (
						<>
							<span className="sv-schema-label-separator">&middot;</span>
							<code className="sv-schema-label">{diff.beLabel}</code>
						</>
					) : null}
					<svg
						width="12"
						height="12"
						viewBox="0 0 12 12"
						className={`sv-schema-chevron ${open ? 'is-open' : ''}`}
					>
						<path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
					</svg>
				</div>
			</button>
			{open ? (
				<div className="sv-schema-body">
					<SchemaColumns labels={sideLabels[diff.scope]} />
					<div className="sv-schema-fields">
						{diff.fields.map((field) => (
							<FieldRow key={field.id} diff={field} scope={diff.scope} onRevealField={onRevealField} />
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

export function SchemaDiffView({
	diffs,
	onRevealField
}: {
	diffs: SchemaDiff[];
	onRevealField?: (location: SourceRevealTarget) => void;
}) {
	return (
		<div className="sv-schema-diff">
			{diffs.map((diff, index) => (
				<ScopeDiffBlock key={`${diff.scope}-${index}`} diff={diff} defaultOpen onRevealField={onRevealField} />
			))}
		</div>
	);
}
