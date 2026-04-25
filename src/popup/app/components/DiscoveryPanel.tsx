import { useMemo, useState } from 'react';
import { Badge, Button, Card, Input } from './ui';

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
	label: string;
	className: string;
};

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
	GET: { label: 'GET', className: 'tw-bg-emerald-100 tw-text-emerald-700 tw-border-emerald-300' },
	POST: { label: 'POST', className: 'tw-bg-blue-100 tw-text-blue-700 tw-border-blue-300' },
	PUT: { label: 'PUT', className: 'tw-bg-amber-100 tw-text-amber-700 tw-border-amber-300' },
	DELETE: { label: 'DEL', className: 'tw-bg-red-100 tw-text-red-700 tw-border-red-300' },
	PATCH: { label: 'PATCH', className: 'tw-bg-violet-100 tw-text-violet-700 tw-border-violet-300' },
	HEAD: { label: 'HEAD', className: 'tw-bg-slate-100 tw-text-slate-700 tw-border-slate-300' },
	OPTIONS: { label: 'OPT', className: 'tw-bg-slate-100 tw-text-slate-700 tw-border-slate-300' }
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
				return item.path.toLowerCase().includes(query) || item.method.toLowerCase().includes(query) || group.source.toLowerCase().includes(query);
			})
		}))
		.filter((group) => group.items.length > 0);
}

function SchemaChip({ label, value }: { label: 'REQ' | 'RES'; value?: string }) {
	const [isOpen, setIsOpen] = useState(false);
	if (!value) {
		return <span className="tw-text-[10px] tw-text-slate-400">{label}: -</span>;
	}

	return (
		<div className="tw-relative">
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					setIsOpen((current) => !current);
				}}
				className="tw-rounded tw-border tw-border-slate-300 tw-bg-slate-100 tw-px-1.5 tw-py-0.5 tw-text-[10px] tw-font-semibold tw-text-slate-600 hover:tw-bg-slate-200"
			>
				{label}
			</button>
			{isOpen ? (
				<div className="tw-absolute tw-bottom-full tw-left-0 tw-z-20 tw-mb-1 tw-max-w-[360px] tw-rounded-md tw-border tw-border-slate-300 tw-bg-white tw-p-2 tw-text-[10px] tw-text-slate-700 tw-shadow-lg">
					<pre className="tw-m-0 tw-whitespace-pre-wrap tw-font-mono">{value}</pre>
				</div>
			) : null}
		</div>
	);
}

function EndpointRow({ item, onReveal }: { item: DiscoveredApi; onReveal: (item: DiscoveredApi) => void }) {
	const method = normalizeMethod(item.method);
	const methodStyle = METHOD_STYLES[method];

	return (
		<div className="tw-group tw-grid tw-grid-cols-[56px_1fr_auto] tw-gap-2 tw-rounded-md tw-border tw-border-transparent tw-p-2 hover:tw-border-slate-300 hover:tw-bg-slate-50">
			<Badge className={`tw-inline-flex tw-h-6 tw-items-center tw-justify-center tw-font-bold tw-font-mono tw-text-[10px] ${methodStyle.className}`}>
				{methodStyle.label}
			</Badge>
			<div className="tw-min-w-0">
				<p className="tw-m-0 tw-truncate tw-font-mono tw-text-[12px] tw-text-slate-800">{item.path}</p>
				<div className="tw-mt-1 tw-flex tw-flex-wrap tw-items-center tw-gap-2">
					<span className="tw-text-[10px] tw-text-slate-500">L{item.line}:{item.column}</span>
					<SchemaChip label="REQ" value={item.requestSchema} />
					<SchemaChip label="RES" value={item.responseSchema} />
				</div>
			</div>
			<Button
				size="sm"
				variant="outline"
				className="tw-h-7 tw-px-2 tw-text-[11px] tw-font-medium"
				onClick={() => onReveal(item)}
				title={`Open ${item.source}:${item.line}:${item.column}`}
			>
				Open
			</Button>
		</div>
	);
}

function SourceGroupCard({ group, onReveal }: { group: GroupedSource; onReveal: (item: DiscoveredApi) => void }) {
	const [collapsed, setCollapsed] = useState(false);
	const methods = Array.from(new Set(group.items.map((item) => normalizeMethod(item.method))));

	return (
		<Card className="tw-overflow-hidden tw-rounded-lg tw-border-slate-300 tw-bg-white">
			<button
				type="button"
				onClick={() => setCollapsed((current) => !current)}
				className="tw-flex tw-w-full tw-items-center tw-gap-2 tw-border-0 tw-bg-slate-50 tw-px-3 tw-py-2 tw-text-left hover:tw-bg-slate-100"
			>
				<span className="tw-font-mono tw-text-[12px] tw-font-semibold tw-text-slate-800">{collapsed ? '>' : 'v'}</span>
				<div className="tw-min-w-0 tw-flex-1">
					<p className="tw-m-0 tw-truncate tw-font-mono tw-text-[12px] tw-font-semibold tw-text-slate-800">{getFileName(group.source)}</p>
					<p className="tw-m-0 tw-truncate tw-font-mono tw-text-[10px] tw-text-slate-500">{group.source}</p>
				</div>
				<div className="tw-flex tw-items-center tw-gap-1">
					{methods.map((method) => (
						<span key={method} className={`tw-rounded tw-border tw-px-1 tw-py-0.5 tw-font-mono tw-text-[9px] tw-font-bold ${METHOD_STYLES[method].className}`}>
							{METHOD_STYLES[method].label}
						</span>
					))}
				</div>
				<span className="tw-ml-2 tw-rounded-full tw-border tw-border-slate-300 tw-px-2 tw-py-0.5 tw-text-[10px] tw-text-slate-600">
					{group.items.length}
				</span>
			</button>
			{collapsed ? null : (
				<div className="tw-space-y-1 tw-p-2">
					{group.items.map((item, index) => (
						<EndpointRow key={`${item.uri}-${item.method}-${item.path}-${index}`} item={item} onReveal={onReveal} />
					))}
				</div>
			)}
		</Card>
	);
}

export function DiscoveryPanel({ items, isLoading, onRefresh, onReveal }: DiscoveryPanelProps) {
	const grouped = useMemo(() => groupBySource(items), [items]);
	const [search, setSearch] = useState('');
	const filteredGroups = useMemo(() => filterGroups(grouped, search), [grouped, search]);
	const filteredCount = filteredGroups.reduce((total, group) => total + group.items.length, 0);

	return (
		<section className="results tw-p-0">
			<div className="tw-flex tw-items-center tw-gap-2 tw-border-b tw-border-slate-300 tw-p-3">
				<div>
					<h2 className="tw-m-0 tw-text-[14px] tw-font-semibold tw-text-slate-900">Discovered APIs</h2>
					<p className="tw-m-0 tw-text-[11px] tw-text-slate-500">
						{filteredCount} endpoint{filteredCount === 1 ? '' : 's'} across {filteredGroups.length} file{filteredGroups.length === 1 ? '' : 's'}
					</p>
				</div>
				<div className="tw-ml-auto tw-flex tw-items-center tw-gap-2">
					<Input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Filter endpoints..."
						className="tw-h-8 tw-rounded-md tw-border tw-border-slate-300 tw-bg-white tw-px-2 tw-text-[12px] tw-text-slate-700 tw-outline-none focus:tw-border-slate-500"
					/>
					<Button className="corner-button" onClick={onRefresh} disabled={isLoading} variant="default" size="sm">
						{isLoading ? 'Loading...' : 'Refresh'}
					</Button>
				</div>
			</div>
			{items.length === 0 ? (
				<p className="results-footer tw-p-3">{isLoading ? 'Discovering endpoints...' : 'No APIs discovered yet.'}</p>
			) : filteredGroups.length === 0 ? (
				<p className="results-footer tw-p-3">No endpoints match your search.</p>
			) : (
				<div className="tw-grid tw-gap-2 tw-p-3">
					{filteredGroups.map((group) => (
						<SourceGroupCard key={group.source} group={group} onReveal={onReveal} />
					))}
				</div>
			)}
		</section>
	);
}
