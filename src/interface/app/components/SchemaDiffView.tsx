import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, AlertTriangle, CheckCircle2, Info, Minus, Plus, RefreshCw } from 'lucide-react';

export type SchemaFieldStatus =
	| 'match'
	| 'renamed'
	| 'type-changed'
	| 'fe-only'
	| 'be-only'
	| 'optional-mismatch';

export type SchemaField = {
	key: string;
	type: string;
	required: boolean;
	description?: string;
};

export type SchemaFieldDiff = {
	id: string;
	status: SchemaFieldStatus;
	fe?: SchemaField;
	be?: SchemaField;
};

export type SchemaDiff = {
	scope: 'request' | 'response';
	feLabel?: string;
	beLabel?: string;
	fields: SchemaFieldDiff[];
};

const statusConfig: Record<
	SchemaFieldStatus,
	{
		label: string;
		feStyle: string;
		beStyle: string;
		icon: ReactNode;
		badgeStyle: string;
		showConnector: boolean;
	}
> = {
	match: {
		label: 'Match',
		feStyle: 'bg-emerald-50 border-emerald-200 text-emerald-900',
		beStyle: 'bg-emerald-50 border-emerald-200 text-emerald-900',
		icon: <CheckCircle2 size={11} className="text-emerald-500 flex-shrink-0" />,
		badgeStyle: 'bg-emerald-100 text-emerald-700 border-emerald-200',
		showConnector: true
	},
	renamed: {
		label: 'Renamed',
		feStyle: 'bg-amber-50 border-amber-300 text-amber-900',
		beStyle: 'bg-amber-50 border-amber-300 text-amber-900',
		icon: <RefreshCw size={11} className="text-amber-500 flex-shrink-0" />,
		badgeStyle: 'bg-amber-100 text-amber-700 border-amber-200',
		showConnector: true
	},
	'type-changed': {
		label: 'Type changed',
		feStyle: 'bg-orange-50 border-orange-300 text-orange-900',
		beStyle: 'bg-orange-50 border-orange-300 text-orange-900',
		icon: <AlertTriangle size={11} className="text-orange-500 flex-shrink-0" />,
		badgeStyle: 'bg-orange-100 text-orange-700 border-orange-200',
		showConnector: true
	},
	'fe-only': {
		label: 'FE only',
		feStyle: 'bg-red-50 border-red-300 text-red-900',
		beStyle: '',
		icon: <Minus size={11} className="text-red-500 flex-shrink-0" />,
		badgeStyle: 'bg-red-100 text-red-700 border-red-200',
		showConnector: false
	},
	'be-only': {
		label: 'BE only',
		feStyle: '',
		beStyle: 'bg-red-50 border-red-300 text-red-900',
		icon: <Plus size={11} className="text-red-500 flex-shrink-0" />,
		badgeStyle: 'bg-red-100 text-red-700 border-red-200',
		showConnector: false
	},
	'optional-mismatch': {
		label: 'Optional != Required',
		feStyle: 'bg-violet-50 border-violet-300 text-violet-900',
		beStyle: 'bg-violet-50 border-violet-300 text-violet-900',
		icon: <Info size={11} className="text-violet-500 flex-shrink-0" />,
		badgeStyle: 'bg-violet-100 text-violet-700 border-violet-200',
		showConnector: true
	}
};

const scopeConfig = {
	request: { label: 'Request Body', icon: '->', style: 'bg-blue-50 border-blue-200 text-blue-700' },
	response: { label: 'Response Body', icon: '<-', style: 'bg-purple-50 border-purple-200 text-purple-700' }
} as const;

function FieldCell({
	field,
	style,
	status,
	peer
}: {
	field?: SchemaField;
	style: string;
	status: SchemaFieldStatus;
	peer?: SchemaField;
}) {
	if (!field) {
		return (
			<div className="flex-1 min-w-0 h-full flex items-center px-3 py-2 rounded-lg border border-dashed border-slate-200 bg-slate-50/50">
				<span className="text-slate-300 text-[11px]">-</span>
			</div>
		);
	}

	const keyChanged = status === 'renamed' && peer && field.key !== peer.key;
	const typeChanged = status === 'type-changed' && peer && field.type !== peer.type;
	const optionalityMismatch = status === 'optional-mismatch' && peer && field.required !== peer.required;

	return (
		<div className={`flex-1 min-w-0 flex flex-col justify-center px-3 py-2 rounded-lg border ${style} text-[12px]`}>
			<div className="flex items-center gap-1.5 min-w-0">
				<code
					className={`truncate ${keyChanged ? 'underline decoration-amber-400 decoration-wavy underline-offset-2' : ''}`}
					style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '12px' }}
				>
					{field.key}
				</code>
				{field.required ? (
					<span className="ml-1 text-red-400 text-[9px]" title="Required">*</span>
				) : (
					<span className="ml-1 text-slate-300 text-[9px]" title="Optional">?</span>
				)}
				{optionalityMismatch ? (
					<span
						className={`ml-auto text-[9px] px-1 py-0 rounded border ${
							field.required
								? 'bg-red-100 text-red-600 border-red-200'
								: 'bg-slate-100 text-slate-500 border-slate-200'
						}`}
						style={{ fontWeight: 600 }}
					>
						{field.required ? 'required' : 'optional'}
					</span>
				) : null}
			</div>
			<code
				className={`mt-0.5 truncate ${typeChanged ? 'text-orange-600 underline decoration-orange-400 decoration-wavy underline-offset-2' : 'text-slate-500'}`}
				style={{ fontFamily: 'monospace', fontSize: '10px' }}
			>
				{field.type}
			</code>
			{field.description ? (
				<span className="mt-0.5 text-slate-400 truncate text-[10px]">{field.description}</span>
			) : null}
		</div>
	);
}

function Connector({ status }: { status: SchemaFieldStatus }) {
	if (!statusConfig[status].showConnector) {
		return (
			<div className="w-8 flex-shrink-0 flex items-center justify-center">
				<span className="text-slate-200 text-[10px]">-</span>
			</div>
		);
	}

	const arrowColor =
		status === 'match'
			? 'text-emerald-300'
			: status === 'renamed'
				? 'text-amber-400'
				: status === 'type-changed'
					? 'text-orange-400'
					: status === 'optional-mismatch'
						? 'text-violet-400'
						: 'text-slate-300';

	return (
		<div className="w-8 flex-shrink-0 flex items-center justify-center">
			<ArrowRight size={13} className={arrowColor} />
		</div>
	);
}

function FieldRow({ diff }: { diff: SchemaFieldDiff }) {
	const cfg = statusConfig[diff.status];
	return (
		<div className="grid grid-cols-1 gap-1.5 md:grid-cols-[1fr_auto_1fr_auto]">
			<FieldCell field={diff.fe} style={diff.fe ? cfg.feStyle : ''} status={diff.status} peer={diff.be} />
			<div className="hidden md:flex">
				<Connector status={diff.status} />
			</div>
			<FieldCell field={diff.be} style={diff.be ? cfg.beStyle : ''} status={diff.status} peer={diff.fe} />
			<div className="flex items-center md:w-24 md:flex-shrink-0">
				<span
					className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-xs ${cfg.badgeStyle}`}
					style={{ fontSize: '10px', fontWeight: 500 }}
				>
					{cfg.icon}
					{cfg.label}
				</span>
			</div>
		</div>
	);
}

function DiffSummary({ fields }: { fields: SchemaFieldDiff[] }) {
	const counts = {
		match: fields.filter((f) => f.status === 'match').length,
		renamed: fields.filter((f) => f.status === 'renamed').length,
		'type-changed': fields.filter((f) => f.status === 'type-changed').length,
		'fe-only': fields.filter((f) => f.status === 'fe-only').length,
		'be-only': fields.filter((f) => f.status === 'be-only').length,
		'optional-mismatch': fields.filter((f) => f.status === 'optional-mismatch').length
	};

	const items = [
		{ key: 'match', label: 'match', style: 'text-emerald-600', dot: 'bg-emerald-500' },
		{ key: 'renamed', label: 'renamed', style: 'text-amber-600', dot: 'bg-amber-400' },
		{ key: 'type-changed', label: 'type !=', style: 'text-orange-600', dot: 'bg-orange-400' },
		{ key: 'fe-only', label: 'FE only', style: 'text-red-600', dot: 'bg-red-500' },
		{ key: 'be-only', label: 'BE only', style: 'text-red-600', dot: 'bg-red-500' },
		{ key: 'optional-mismatch', label: 'opt != req', style: 'text-violet-600', dot: 'bg-violet-400' }
	] as const;

	return (
		<div className="flex items-center gap-3 flex-wrap">
			{items.map(({ key, label, style, dot }) => (
				counts[key] > 0 ? (
					<span key={key} className={`flex items-center gap-1 ${style}`} style={{ fontSize: '11px' }}>
						<span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
						<span style={{ fontWeight: 600 }}>{counts[key]}</span> {label}
					</span>
				) : null
			))}
		</div>
	);
}

function ScopeDiffBlock({ diff, defaultOpen }: { diff: SchemaDiff; defaultOpen?: boolean }) {
	const [open, setOpen] = useState(defaultOpen ?? true);
	const cfg = scopeConfig[diff.scope];
	const problemCount = diff.fields.filter((f) => f.status !== 'match').length;

	return (
		<div className="rounded-xl border border-slate-200 overflow-hidden">
			<button
				type="button"
				className="w-full flex flex-wrap items-center gap-2.5 px-3 py-2.5 bg-white hover:bg-slate-50 transition-colors text-left"
				onClick={() => setOpen((v) => !v)}
			>
				<span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${cfg.style}`} style={{ fontWeight: 600 }}>
					<span>{cfg.icon}</span>
					{cfg.label}
				</span>
				{problemCount > 0 ? (
					<span className="flex items-center gap-1 text-amber-600 text-[11px]">
						<AlertTriangle size={11} />
						{problemCount} issue{problemCount !== 1 ? 's' : ''}
					</span>
				) : null}
				{open ? <DiffSummary fields={diff.fields} /> : null}
				<div className="ml-auto flex max-w-full items-center gap-2 flex-shrink-0">
					{diff.feLabel ? (
						<code className="truncate text-slate-400" style={{ fontFamily: 'monospace', fontSize: '10px' }}>
							{diff.feLabel}
						</code>
					) : null}
					{diff.beLabel ? (
						<>
							<span className="text-slate-200">·</span>
							<code className="truncate text-slate-400" style={{ fontFamily: 'monospace', fontSize: '10px' }}>
								{diff.beLabel}
							</code>
						</>
					) : null}
					<svg
						width="12"
						height="12"
						viewBox="0 0 12 12"
						className={`text-slate-400 transition-transform ml-1 ${open ? 'rotate-180' : ''}`}
					>
						<path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
					</svg>
				</div>
			</button>
			{open ? (
				<div className="border-t border-slate-100 bg-slate-50/40">
					<div className="hidden md:flex items-center gap-1.5 px-3 pt-2 pb-1">
						<div className="flex-1 flex items-center gap-1.5">
							<span className="px-1.5 py-0.5 rounded border bg-violet-50 text-violet-700 border-violet-200" style={{ fontFamily: 'monospace', fontSize: '10px', fontWeight: 700 }}>FE</span>
							<span className="text-slate-400 text-[10px]">Frontend expects</span>
						</div>
						<div className="w-8 flex-shrink-0" />
						<div className="flex-1 flex items-center gap-1.5">
							<span className="px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200" style={{ fontFamily: 'monospace', fontSize: '10px', fontWeight: 700 }}>BE</span>
							<span className="text-slate-400 text-[10px]">Backend provides</span>
						</div>
						<div className="w-24 flex-shrink-0" />
					</div>
					<div className="px-3 pb-3 space-y-1.5">
						{diff.fields.map((field) => (
							<FieldRow key={field.id} diff={field} />
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

export function SchemaDiffView({ diffs }: { diffs: SchemaDiff[] }) {
	return (
		<div className="space-y-2 mt-3">
			{diffs.map((diff, index) => (
				<ScopeDiffBlock key={`${diff.scope}-${index}`} diff={diff} defaultOpen={index === 0} />
			))}
		</div>
	);
}
