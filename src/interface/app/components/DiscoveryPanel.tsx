import { useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, ExternalLink, FileCode2, Search } from 'lucide-react';
import { Button, Input } from './ui';

type DiscoveredApi = {
	uri: string;
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	source: string;
	line: number;
	column: number;
};

type DiscoveryPanelProps = {
	items: DiscoveredApi[];
	isLoading: boolean;
	onRefresh: () => void;
	onReveal: (item: DiscoveredApi) => void;
};

type GroupedSource = {
	source: string;
	items: DiscoveredApi[];
};

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

type MethodStyle = {
	bg: string;
	text: string;
	border: string;
	label: string;
};

type SchemaShape = Record<string, string>;

export function groupBySource(items: DiscoveredApi[]): GroupedSource[] {
	const groups = new Map<string, GroupedSource>();
	for (const item of items) {
		const existing = groups.get(item.source);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		groups.set(item.source, { source: item.source, items: [item] });
	}
	return Array.from(groups.values()).sort((a, b) => a.source.localeCompare(b.source));
}

export function getFileName(path: string): string {
	const chunks = path.split(/[\\/]/);
	return chunks[chunks.length - 1] || path;
}

export function normalizeMethod(method: string): HttpMethod {
	const value = method.toUpperCase();
	if (value === 'GET' || value === 'POST' || value === 'PUT' || value === 'DELETE' || value === 'PATCH' || value === 'HEAD' || value === 'OPTIONS') {
		return value;
	}
	return 'GET';
}

export const METHOD_STYLES: Record<HttpMethod, MethodStyle> = {
	GET: { bg: 'tw-bg-emerald-50', text: 'tw-text-emerald-700', border: 'tw-border-emerald-200', label: 'GET' },
	POST: { bg: 'tw-bg-blue-50', text: 'tw-text-blue-700', border: 'tw-border-blue-200', label: 'POST' },
	PUT: { bg: 'tw-bg-amber-50', text: 'tw-text-amber-700', border: 'tw-border-amber-200', label: 'PUT' },
	DELETE: { bg: 'tw-bg-red-50', text: 'tw-text-red-700', border: 'tw-border-red-200', label: 'DEL' },
	PATCH: { bg: 'tw-bg-violet-50', text: 'tw-text-violet-700', border: 'tw-border-violet-200', label: 'PATCH' },
	HEAD: { bg: 'tw-bg-slate-50', text: 'tw-text-slate-600', border: 'tw-border-slate-200', label: 'HEAD' },
	OPTIONS: { bg: 'tw-bg-slate-50', text: 'tw-text-slate-600', border: 'tw-border-slate-200', label: 'OPT' }
};

export function filterGroups(groups: GroupedSource[], search: string): GroupedSource[] {
	const query = search.trim().toLowerCase();
	if (!query) {
		return groups;
	}
	return groups
		.map((group) => ({
			...group,
			items: group.items.filter((item) => {
				return (
					item.path.toLowerCase().includes(query)
					|| item.method.toLowerCase().includes(query)
					|| group.source.toLowerCase().includes(query)
				);
			})
		}))
		.filter((group) => group.items.length > 0);
}

function parseSchema(schema?: string): SchemaShape | undefined {
	if (!schema) {
		return undefined;
	}
	const trimmed = schema.trim();
	if (!trimmed) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const next: SchemaShape = {};
			for (const [key, value] of Object.entries(parsed)) {
				next[key] = typeof value === 'string' ? value : JSON.stringify(value);
			}
			return Object.keys(next).length > 0 ? next : undefined;
		}
	} catch {
		return { schema: trimmed };
	}

	return { schema: trimmed };
}

function hasMismatch(item: DiscoveredApi): boolean {
	const req = item.requestSchema?.toLowerCase() ?? '';
	const res = item.responseSchema?.toLowerCase() ?? '';
	return req.includes('unknown') || res.includes('unknown') || req.includes('mismatch') || res.includes('mismatch');
}

function SchemaChip({ label, schema }: { label: string; schema: SchemaShape }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="tw-relative">
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					setOpen((value) => !value);
				}}
				className="tw-flex tw-items-center tw-gap-1 tw-rounded tw-bg-slate-100 tw-px-1.5 tw-py-0.5 tw-text-slate-500 transition-colors hover:tw-bg-slate-200 hover:tw-text-slate-700"
				style={{ fontSize: '10px', fontFamily: 'monospace' }}
			>
				{label}
				<ChevronDown size={9} className={`tw-transition-transform ${open ? 'tw-rotate-180' : ''}`} />
			</button>
			{open ? (
				<div className="tw-absolute tw-bottom-full tw-left-0 tw-z-50 tw-mb-1 tw-min-w-[160px] tw-rounded-lg tw-border tw-border-slate-200 tw-bg-white tw-p-2 tw-shadow-lg">
					<div className="tw-space-y-1">
						{Object.entries(schema).map(([key, type]) => (
							<div key={key} className="tw-flex tw-items-center tw-justify-between tw-gap-4">
								<span className="tw-text-slate-700" style={{ fontFamily: 'monospace', fontSize: '11px' }}>{key}</span>
								<span className="tw-text-slate-400" style={{ fontFamily: 'monospace', fontSize: '11px' }}>{type}</span>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

function EndpointRow({ endpoint, onReveal }: { endpoint: DiscoveredApi; onReveal: (item: DiscoveredApi) => void }) {
	const method = normalizeMethod(endpoint.method);
	const mc = METHOD_STYLES[method];
	const mismatch = hasMismatch(endpoint);
	const requestSchema = parseSchema(endpoint.requestSchema);
	const responseSchema = parseSchema(endpoint.responseSchema);

	return (
		<div className={`tw-group tw-grid tw-grid-cols-[auto_1fr] tw-gap-2 tw-rounded-lg tw-px-3 tw-py-2 tw-transition-colors hover:tw-bg-slate-50 ${mismatch ? 'tw-border tw-border-amber-100 tw-bg-amber-50/30' : ''}`}>
			<span
				className={`tw-flex-shrink-0 tw-rounded tw-border tw-px-1.5 tw-py-0.5 tw-text-xs ${mc.bg} ${mc.text} ${mc.border}`}
				style={{ fontFamily: 'monospace', fontWeight: 700, minWidth: 38, textAlign: 'center' }}
			>
				{mc.label}
			</span>
			<div className="tw-min-w-0 tw-space-y-1">
				<div className="tw-flex tw-items-center tw-gap-2">
					<code className="tw-min-w-0 tw-flex-1 tw-truncate tw-text-slate-700" style={{ fontFamily: 'monospace', fontSize: '12px' }}>
						{endpoint.path}
					</code>
					{mismatch ? (
						<span className="tw-flex tw-items-center tw-gap-1 tw-text-amber-600" style={{ fontSize: '10px' }}>
							<AlertCircle size={11} />
							mismatch
						</span>
					) : null}
				</div>
				<div className="tw-flex tw-flex-wrap tw-items-center tw-gap-1.5">
					{requestSchema ? <SchemaChip label="req{}" schema={requestSchema} /> : null}
					{responseSchema ? <SchemaChip label="res{}" schema={responseSchema} /> : null}
					<span className="tw-ml-auto tw-text-slate-400" style={{ fontFamily: 'monospace', fontSize: '10px' }}>
						:{endpoint.line}
					</span>
					<button
						type="button"
						className="tw-flex tw-items-center tw-gap-1 tw-rounded tw-border tw-border-transparent tw-px-2 tw-py-0.5 tw-text-slate-500 tw-transition-colors hover:tw-border-slate-200 hover:tw-bg-white hover:tw-text-slate-800"
						style={{ fontSize: '10px' }}
						title={`Open ${endpoint.source}:${endpoint.line}`}
						onClick={() => onReveal(endpoint)}
					>
						<ExternalLink size={10} />
						Open
					</button>
				</div>
			</div>
		</div>
	);
}

function SourceGroupCard({ group, onReveal }: { group: GroupedSource; onReveal: (item: DiscoveredApi) => void }) {
	const [collapsed, setCollapsed] = useState(false);
	const mismatchCount = group.items.filter(hasMismatch).length;
	const methods = Array.from(new Set(group.items.map((item) => normalizeMethod(item.method))));

	return (
		<div className="tw-overflow-hidden tw-rounded-xl tw-border tw-border-slate-200 tw-bg-white">
			<button
				type="button"
				onClick={() => setCollapsed((value) => !value)}
				className="tw-flex tw-w-full tw-flex-wrap tw-items-start tw-gap-2 tw-px-4 tw-py-2.5 tw-text-left tw-transition-colors hover:tw-bg-slate-50"
			>
				{collapsed ? <ChevronRight size={14} className="tw-flex-shrink-0 tw-text-slate-400" /> : <ChevronDown size={14} className="tw-flex-shrink-0 tw-text-slate-400" />}
				<FileCode2 size={14} className="tw-flex-shrink-0 tw-text-slate-400" />
				<div className="tw-flex tw-min-w-0 tw-flex-1 tw-flex-col">
					<div className="tw-flex tw-items-center tw-gap-2">
						<span className="tw-truncate tw-text-slate-900" style={{ fontSize: '13px', fontFamily: 'monospace', fontWeight: 600 }}>
							{getFileName(group.source)}
						</span>
						{mismatchCount > 0 ? (
							<span className="tw-flex tw-items-center tw-gap-1 tw-text-amber-600" style={{ fontSize: '10px' }}>
								<AlertCircle size={10} />
								{mismatchCount} mismatch{mismatchCount !== 1 ? 'es' : ''}
							</span>
						) : null}
					</div>
					<span className="tw-truncate tw-text-slate-400" style={{ fontSize: '11px', fontFamily: 'monospace' }}>
						{group.source}
					</span>
				</div>
				<div className="tw-flex tw-w-full tw-items-center tw-gap-2 tw-pl-5">
					<span className="tw-text-slate-500" style={{ fontSize: '12px', fontWeight: 500 }}>
						{group.items.length} endpoint{group.items.length !== 1 ? 's' : ''}
					</span>
					<div className="tw-flex tw-flex-wrap tw-items-center tw-gap-1">
						{methods.map((method) => {
							const mc = METHOD_STYLES[method];
							return (
								<span
									key={method}
									className={`tw-rounded tw-border tw-px-1 tw-py-0.5 tw-text-xs ${mc.bg} ${mc.text} ${mc.border}`}
									style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '9px' }}
								>
									{mc.label}
								</span>
							);
						})}
					</div>
				</div>
			</button>
			{!collapsed ? (
				<div className="tw-space-y-0.5 tw-border-t tw-border-slate-100 tw-px-2 tw-py-1.5">
					{group.items.map((endpoint, index) => (
						<EndpointRow key={`${endpoint.uri}-${endpoint.method}-${endpoint.path}-${index}`} endpoint={endpoint} onReveal={onReveal} />
					))}
				</div>
			) : null}
		</div>
	);
}

export function DiscoveryPanel({ items, isLoading, onRefresh, onReveal }: DiscoveryPanelProps) {
	const [search, setSearch] = useState('');
	const groups = useMemo(() => groupBySource(items), [items]);
	const filteredGroups = useMemo(() => filterGroups(groups, search), [groups, search]);
	const totalEndpoints = groups.reduce((sum, group) => sum + group.items.length, 0);

	return (
		<section className="tw-flex tw-h-full tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-slate-200 tw-bg-white">
			<div className="tw-flex tw-flex-col tw-gap-2 tw-border-b tw-border-slate-100 tw-px-4 tw-py-3">
				<div className="tw-flex tw-items-start tw-justify-between tw-gap-2">
					<div className="tw-min-w-0">
						<h2 className="tw-m-0 tw-text-[14px] tw-font-semibold tw-text-slate-900">Discovered APIs</h2>
						<p className="tw-m-0 tw-text-[12px] tw-text-slate-600">
							<span style={{ fontWeight: 600 }}>{totalEndpoints}</span> endpoints across{' '}
							<span style={{ fontWeight: 600 }}>{groups.length}</span> files
						</p>
					</div>
					<Button className="corner-button tw-shrink-0" onClick={onRefresh} disabled={isLoading} size="sm">
						{isLoading ? 'Loading...' : 'Refresh'}
					</Button>
				</div>
				<div className="tw-relative">
					<Search size={12} className="tw-pointer-events-none tw-absolute tw-left-2.5 tw-top-1/2 tw--translate-y-1/2 tw-text-slate-400" />
					<Input
						type="text"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Filter endpoints..."
						className="tw-w-full tw-rounded-lg tw-border tw-border-slate-200 tw-bg-white tw-py-1.5 tw-pl-7 tw-pr-3 tw-text-sm tw-text-slate-700 placeholder:tw-text-slate-400"
						style={{ fontSize: '12px' }}
					/>
				</div>
			</div>
			<div className="tw-flex-1 tw-space-y-3 tw-overflow-y-auto tw-p-4">
				{items.length === 0 ? (
					<div className="tw-flex tw-flex-col tw-items-center tw-justify-center tw-py-12 tw-text-center">
						<Search size={24} className="tw-mb-3 tw-text-slate-300" />
						<p className="tw-text-sm tw-text-slate-500">
							{isLoading ? 'Discovering endpoints...' : 'No APIs discovered yet.'}
						</p>
					</div>
				) : filteredGroups.length === 0 ? (
					<div className="tw-flex tw-flex-col tw-items-center tw-justify-center tw-py-12 tw-text-center">
						<Search size={24} className="tw-mb-3 tw-text-slate-300" />
						<p className="tw-text-sm tw-text-slate-500">No endpoints match your search</p>
					</div>
				) : (
					filteredGroups.map((group) => (
						<SourceGroupCard key={group.source} group={group} onReveal={onReveal} />
					))
				)}
			</div>
		</section>
	);
}
