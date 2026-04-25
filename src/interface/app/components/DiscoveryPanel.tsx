import { useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, ExternalLink, FileCode2, Search } from 'lucide-react';
import { Button, Input } from './ui';
import type { VerificationIssue } from '../../../shared/messages';

type DiscoveredApi = {
	uri: string;
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	side: 'frontend' | 'backend';
	source: string;
	line: number;
	column: number;
};

type DiscoveryPanelProps = {
	items: DiscoveredApi[];
	mismatches?: VerificationIssue[];
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
	className: string;
	label: string;
};

type SchemaShape = Record<string, string>;
type DiscoverySummary = {
	totalEndpoints: number;
	totalFiles: number;
	mismatchEndpoints: number;
};
type MismatchLookup = Map<string, VerificationIssue[]>;
type IssueBadge = {
	label: string;
	className: string;
	title: string;
	searchText: string;
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
	GET: { className: 'discovery-method-get', label: 'GET' },
	POST: { className: 'discovery-method-post', label: 'POST' },
	PUT: { className: 'discovery-method-put', label: 'PUT' },
	DELETE: { className: 'discovery-method-delete', label: 'DEL' },
	PATCH: { className: 'discovery-method-patch', label: 'PATCH' },
	HEAD: { className: 'discovery-method-head', label: 'HEAD' },
	OPTIONS: { className: 'discovery-method-options', label: 'OPT' }
};

export function filterGroups(groups: GroupedSource[], search: string, mismatchLookup?: MismatchLookup): GroupedSource[] {
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
					|| item.side.toLowerCase().includes(query)
					|| itemIssuesSearchText(item, mismatchLookup).includes(query)
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

function endpointIssueKey(side: 'frontend' | 'backend', method?: string, path?: string): string | undefined {
	if (!method || !path) {
		return undefined;
	}
	return `${side}:${method.toUpperCase()} ${path}`;
}

function getEndpointIssues(item: DiscoveredApi, lookup: MismatchLookup): VerificationIssue[] {
	return lookup.get(endpointIssueKey(item.side, item.method, item.path) ?? '') ?? [];
}

function pushIssue(lookup: MismatchLookup, key: string | undefined, issue: VerificationIssue): void {
	if (!key) {
		return;
	}
	const existing = lookup.get(key);
	if (existing) {
		existing.push(issue);
	} else {
		lookup.set(key, [issue]);
	}
}

function buildMismatchLookup(mismatches: VerificationIssue[] | undefined): MismatchLookup {
	const lookup: MismatchLookup = new Map();
	for (const issue of mismatches ?? []) {
		pushIssue(lookup, endpointIssueKey(issue.sourceSide, issue.method, issue.path), issue);
		if (issue.kind === 'request-schema-mismatch' || issue.kind === 'response-schema-mismatch') {
			const otherSide = issue.sourceSide === 'frontend' ? 'backend' : 'frontend';
			pushIssue(lookup, endpointIssueKey(otherSide, issue.method, issue.path), issue);
		}
	}
	return lookup;
}

function issueBadgeFor(issue: VerificationIssue): IssueBadge {
	if (issue.kind === 'missing-backend') {
		return {
			label: 'FE only',
			className: 'discovery-issue-fe-only',
			title: 'Frontend calls this endpoint, but no matching backend route was found.',
			searchText: 'fe only frontend only missing backend missing in be'
		};
	}
	if (issue.kind === 'backend-only') {
		return {
			label: 'BE only',
			className: 'discovery-issue-be-only',
			title: 'Backend exposes this endpoint, but no matching frontend call was found.',
			searchText: 'be only backend only missing frontend missing in fe'
		};
	}
	if (issue.kind === 'request-schema-mismatch') {
		return {
			label: 'Req schema',
			className: 'discovery-issue-schema',
			title: 'Frontend and backend request schemas do not match.',
			searchText: 'request schema mismatch req schema'
		};
	}
	if (issue.kind === 'response-schema-mismatch') {
		return {
			label: 'Res schema',
			className: 'discovery-issue-schema',
			title: 'Frontend and backend response schemas do not match.',
			searchText: 'response schema mismatch res schema'
		};
	}
	if (issue.kind === 'duplicate-endpoint') {
		return {
			label: 'Duplicate',
			className: 'discovery-issue-duplicate',
			title: 'This endpoint is declared more than once on the same side.',
			searchText: 'duplicate endpoint'
		};
	}
	return {
		label: 'Invalid',
		className: 'discovery-issue-invalid',
		title: 'This endpoint declaration could not be normalized for comparison.',
		searchText: 'invalid endpoint'
	};
}

function uniqueIssueBadges(issues: VerificationIssue[]): IssueBadge[] {
	const byLabel = new Map<string, IssueBadge>();
	for (const issue of issues) {
		const badge = issueBadgeFor(issue);
		byLabel.set(badge.label, badge);
	}
	return Array.from(byLabel.values());
}

function itemIssuesSearchText(item: DiscoveredApi, mismatchLookup?: MismatchLookup): string {
	const issues = mismatchLookup ? getEndpointIssues(item, mismatchLookup) : [];
	const issueText = uniqueIssueBadges(issues).map((badge) => `${badge.label} ${badge.searchText}`).join(' ');
	const schema = `${item.requestSchema ?? ''} ${item.responseSchema ?? ''}`.toLowerCase();
	return `${schema} ${issueText}`.toLowerCase();
}

function summarizeDiscovery(groups: GroupedSource[], mismatchLookup: MismatchLookup): DiscoverySummary {
	let mismatchEndpoints = 0;
	let totalEndpoints = 0;
	for (const group of groups) {
		totalEndpoints += group.items.length;
		mismatchEndpoints += group.items.filter((item) => getEndpointIssues(item, mismatchLookup).length > 0).length;
	}
	return {
		totalEndpoints,
		totalFiles: groups.length,
		mismatchEndpoints
	};
}

function SchemaChip({ label, schema }: { label: string; schema: SchemaShape }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="discovery-schema">
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					setOpen((value) => !value);
				}}
				className="discovery-schema-chip"
			>
				{label}
				<ChevronDown size={9} className={open ? 'discovery-chevron-open' : ''} />
			</button>
			{open ? (
				<div className="discovery-schema-popover">
					<div className="discovery-schema-grid">
						{Object.entries(schema).map(([key, type]) => (
							<div key={key} className="discovery-schema-row">
								<span className="discovery-schema-key">{key}</span>
								<span className="discovery-schema-type">{type}</span>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

function EndpointRow({
	endpoint,
	mismatchLookup,
	onReveal
}: {
	endpoint: DiscoveredApi;
	mismatchLookup: MismatchLookup;
	onReveal: (item: DiscoveredApi) => void;
}) {
	const method = normalizeMethod(endpoint.method);
	const mc = METHOD_STYLES[method];
	const issues = getEndpointIssues(endpoint, mismatchLookup);
	const mismatch = issues.length > 0;
	const issueBadges = uniqueIssueBadges(issues);
	const requestSchema = parseSchema(endpoint.requestSchema);
	const responseSchema = parseSchema(endpoint.responseSchema);

	return (
		<div className={`discovery-item ${mismatch ? 'is-mismatch' : ''}`}>
			<div className="discovery-main">
				<span className={`discovery-method ${mc.className}`}>
					{mc.label}
				</span>
				<code className="discovery-path">{endpoint.path}</code>
				<span className="discovery-location">{endpoint.side === 'frontend' ? 'FE' : 'BE'}</span>
				{issueBadges.map((issue) => (
					<span key={issue.label} className={`discovery-issue-tag ${issue.className}`} title={issue.title}>
						<AlertCircle size={11} />
						{issue.label}
					</span>
				))}
			</div>
			<div className="discovery-actions">
				{requestSchema ? <SchemaChip label="req{}" schema={requestSchema} /> : null}
				{responseSchema ? <SchemaChip label="res{}" schema={responseSchema} /> : null}
				<span className="discovery-location">
					:{endpoint.line}
				</span>
				<button
					type="button"
					className="sv-ui-button sv-ui-button-sm sv-ui-button-outline discovery-open"
					title={`Open ${endpoint.source}:${endpoint.line}`}
					onClick={() => onReveal(endpoint)}
				>
					<ExternalLink size={10} />
					Open
				</button>
			</div>
		</div>
	);
}

function SourceGroupCard({
	group,
	mismatchLookup,
	onReveal
}: {
	group: GroupedSource;
	mismatchLookup: MismatchLookup;
	onReveal: (item: DiscoveredApi) => void;
}) {
	const [collapsed, setCollapsed] = useState(false);
	const mismatchCount = group.items.filter((item) => getEndpointIssues(item, mismatchLookup).length > 0).length;
	const methods = Array.from(new Set(group.items.map((item) => normalizeMethod(item.method))));

	return (
		<div className="sv-ui-card discovery-group">
			<button
				type="button"
				onClick={() => setCollapsed((value) => !value)}
				className="discovery-group-toggle"
			>
				{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
				<FileCode2 size={14} />
				<div className="discovery-group-main">
					<div className="discovery-group-title-row">
						<span className="discovery-group-title">
							{getFileName(group.source)}
						</span>
						{mismatchCount > 0 ? (
							<span className="discovery-mismatch-tag">
								<AlertCircle size={10} />
								{mismatchCount} mismatch{mismatchCount !== 1 ? 'es' : ''}
							</span>
						) : null}
					</div>
					<span className="discovery-group-source">
						{group.source}
					</span>
				</div>
				<div className="discovery-group-meta">
					<span>
						{group.items.length} endpoint{group.items.length !== 1 ? 's' : ''}
					</span>
					<div className="discovery-method-badges">
						{methods.map((method) => {
							const mc = METHOD_STYLES[method];
							return (
								<span
									key={method}
									className={`discovery-method ${mc.className}`}
								>
									{mc.label}
								</span>
							);
						})}
					</div>
				</div>
			</button>
			{!collapsed ? (
				<div className="discovery-group-list">
					{group.items.map((endpoint, index) => (
						<EndpointRow
							key={`${endpoint.uri}-${endpoint.method}-${endpoint.path}-${index}`}
							endpoint={endpoint}
							mismatchLookup={mismatchLookup}
							onReveal={onReveal}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

export function DiscoveryPanel({ items, mismatches, isLoading, onRefresh, onReveal }: DiscoveryPanelProps) {
	const [search, setSearch] = useState('');
	const groups = useMemo(() => groupBySource(items), [items]);
	const mismatchLookup = useMemo(() => buildMismatchLookup(mismatches), [mismatches]);
	const filteredGroups = useMemo(() => filterGroups(groups, search, mismatchLookup), [groups, search, mismatchLookup]);
	const summary = useMemo(() => summarizeDiscovery(groups, mismatchLookup), [groups, mismatchLookup]);

	return (
		<section className="discovery-panel">
			<div className="discovery-toolbar">
				<span className="discovery-title">Discovered APIs</span>
				<span className="discovery-summary">
					<span>{summary.totalEndpoints}</span> endpoints across <span>{summary.totalFiles}</span> files
				</span>
				{summary.mismatchEndpoints > 0 ? (
					<span className="discovery-mismatch-pill">
						{summary.mismatchEndpoints} potential mismatches
					</span>
				) : null}
				<div className="discovery-toolbar-actions">
					<div className="discovery-search-wrap">
						<Search size={12} className="discovery-search-icon" />
						<Input
							type="text"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Filter endpoints..."
							className="discovery-search-input"
						/>
					</div>
					<Button className="corner-button" onClick={onRefresh} disabled={isLoading} size="sm">
						{isLoading ? 'Loading...' : 'Refresh'}
					</Button>
				</div>
			</div>
			<div className="discovery-scroll">
				{items.length === 0 ? (
					<div className="discovery-empty">
						<Search size={24} />
						<p>
							{isLoading ? 'Discovering endpoints...' : 'No APIs discovered yet.'}
						</p>
					</div>
				) : filteredGroups.length === 0 ? (
					<div className="discovery-empty">
						<Search size={24} />
						<p>No endpoints match your search</p>
					</div>
				) : (
					filteredGroups.map((group) => (
						<SourceGroupCard key={group.source} group={group} mismatchLookup={mismatchLookup} onReveal={onReveal} />
					))
				)}
			</div>
		</section>
	);
}
