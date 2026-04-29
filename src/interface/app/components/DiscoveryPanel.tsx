import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
	AlertCircle,
	ArrowDownToLine,
	ArrowUpFromLine,
	Braces,
	Check,
	ChevronDown,
	ChevronRight,
	Code2,
	Copy,
	ExternalLink,
	FileCode2,
	Search
} from 'lucide-react';
import { Button, Input } from './ui';
import { SchemaDiffView } from './SchemaDiffView';
import { describeSchemaStrings } from '../../../host/verification/schemaCompare';
import type { SchemaDiff, SchemaFieldSourceLocation, SourceRevealTarget, VerificationIssue } from '../../../shared/messages';

type DiscoveredApi = {
	uri: string;
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	requestHeaders?: string[];
	fieldLocations?: SchemaFieldSourceLocation[];
	side: 'frontend' | 'backend';
	source: string;
	line: number;
	column: number;
	highlightText?: string;
	skipCounterpartReveal?: boolean;
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

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'WS';

type MethodStyle = {
	className: string;
	label: string;
};

type SchemaShape = Record<string, string>;
type SchemaView = 'fields' | 'ts' | 'json';
type DiscoverySummary = {
	totalEndpoints: number;
	totalFiles: number;
	mismatchEndpoints: number;
};
type MismatchLookup = Map<string, VerificationIssue[]>;
type EndpointLookup = Map<string, DiscoveredApi[]>;
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
	if (value === 'GET' || value === 'POST' || value === 'PUT' || value === 'DELETE' || value === 'PATCH' || value === 'HEAD' || value === 'OPTIONS' || value === 'WS') {
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
	OPTIONS: { className: 'discovery-method-options', label: 'OPT' },
	WS: { className: 'discovery-method-ws', label: 'WS' }
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

function endpointMatchKey(method?: string, path?: string): string | undefined {
	if (!method || !path) {
		return undefined;
	}
	return `${method.toUpperCase()} ${normalizeEndpointPathForMatch(path)}`;
}

function normalizeEndpointPathForMatch(path: string): string {
	const normalizedParams = path
		.trim()
		.split(/[?#]/)[0]
		.replace(/\/\{[^/}]+\}/g, '/{param}')
		.replace(/\/:[^/]+/g, '/{param}')
		.replace(/\/+/g, '/');
	return normalizedParams.length > 1 && normalizedParams.endsWith('/') ? normalizedParams.slice(0, -1) : normalizedParams;
}

function buildEndpointLookup(items: DiscoveredApi[]): EndpointLookup {
	const lookup: EndpointLookup = new Map();
	for (const item of items) {
		const key = endpointMatchKey(item.method, item.path);
		if (!key) {
			continue;
		}
		const existing = lookup.get(key);
		if (existing) {
			existing.push(item);
		} else {
			lookup.set(key, [item]);
		}
	}
	return lookup;
}

function getCounterpartEndpoint(item: DiscoveredApi, lookup: EndpointLookup): DiscoveredApi | undefined {
	const key = endpointMatchKey(item.method, item.path);
	return key ? lookup.get(key)?.find((candidate) => candidate.side !== item.side) : undefined;
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
	if (issue.kind === 'header-mismatch') {
		return {
			label: 'Headers',
			className: 'discovery-issue-invalid',
			title: 'Frontend request headers do not satisfy backend requirements.',
			searchText: 'header headers authorization token api key missing'
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
		const existing = byLabel.get(badge.label);
		if (existing) {
			if (!existing.title.includes(issue.message)) {
				existing.title = `${existing.title}\n\n${issue.message}`;
			}
			continue;
		}
		byLabel.set(badge.label, {
			...badge,
			title: `${badge.title}\n\n${issue.message}`
		});
	}
	return Array.from(byLabel.values());
}

function collectSchemaDiffs(issues: VerificationIssue[]): SchemaDiff[] {
	const byKey = new Map<string, SchemaDiff>();
	for (const issue of issues) {
		for (const diff of issue.schemaDiffs ?? []) {
			byKey.set(`${diff.scope}:${JSON.stringify(diff.fields)}`, diff);
		}
	}
	return Array.from(byKey.values());
}

function collectComparableSchemaDiffs(endpoint: DiscoveredApi, counterpart: DiscoveredApi | undefined): SchemaDiff[] {
	if (!counterpart) {
		return [];
	}
	const frontend = endpoint.side === 'frontend' ? endpoint : counterpart;
	const backend = endpoint.side === 'backend' ? endpoint : counterpart;
	return [
		describeSchemaStrings(frontend.requestSchema, backend.requestSchema, 'request'),
		describeSchemaStrings(frontend.responseSchema, backend.responseSchema, 'response')
	].filter((diff): diff is SchemaDiff => Boolean(diff)).map((diff) => attachFieldLocations(diff, frontend, backend));
}

function attachFieldLocations(diff: SchemaDiff, frontend: DiscoveredApi, backend: DiscoveredApi): SchemaDiff {
	return {
		...diff,
		fields: diff.fields.map((field) => ({
			...field,
			fe: field.fe ? { ...field.fe, location: resolveFieldLocation(frontend, diff.scope, field.fe.key) } : undefined,
			be: field.be ? { ...field.be, location: resolveFieldLocation(backend, diff.scope, field.be.key) } : undefined
		}))
	};
}

export function resolveFieldLocation(endpoint: DiscoveredApi, scope: SchemaDiff['scope'], key: string): SourceRevealTarget {
	const exact = endpoint.fieldLocations?.find((location) => location.scope === scope && location.field === key);
	if (exact) {
		return exact;
	}
	const normalizedKey = normalizeFieldKey(key);
	const normalized = endpoint.fieldLocations?.find((location) => location.scope === scope && normalizeFieldKey(location.field) === normalizedKey);
	if (normalized) {
		return normalized;
	}
	return {
		uri: endpoint.uri,
		line: endpoint.line,
		column: endpoint.column,
		method: endpoint.method,
		path: endpoint.path,
		side: endpoint.side,
		highlightText: key.split('.').pop()?.replace(/\[]$/, '') ?? key
	};
}

function normalizeFieldKey(key: string): string {
	return key.replace(/[_\-\s]/g, '').toLowerCase();
}

function itemIssuesSearchText(item: DiscoveredApi, mismatchLookup?: MismatchLookup): string {
	const issues = mismatchLookup ? getEndpointIssues(item, mismatchLookup) : [];
	const issueText = uniqueIssueBadges(issues).map((badge) => `${badge.label} ${badge.searchText}`).join(' ');
	const schema = `${item.requestSchema ?? ''} ${item.responseSchema ?? ''} ${(item.requestHeaders ?? []).join(' ')}`.toLowerCase();
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

function typeClass(type: string): string {
	const value = type.toLowerCase();
	if (value === 'string') {
		return 'discovery-type-string';
	}
	if (value === 'number' || value === 'integer') {
		return 'discovery-type-number';
	}
	if (value === 'boolean') {
		return 'discovery-type-boolean';
	}
	if (value.includes('[]') || value.startsWith('array')) {
		return 'discovery-type-array';
	}
	if (value.includes('|')) {
		return 'discovery-type-union';
	}
	if (value.includes('date') || value.includes('time')) {
		return 'discovery-type-date';
	}
	return 'discovery-type-object';
}

function mockValue(type: string): string {
	const value = type.toLowerCase();
	if (value === 'string') {
		return '"example"';
	}
	if (value === 'number' || value === 'integer') {
		return '42';
	}
	if (value === 'boolean') {
		return 'true';
	}
	if (value.includes('[]') || value.startsWith('array')) {
		return '[]';
	}
	if (value === 'object' || value.startsWith('{')) {
		return '{}';
	}
	if (value.includes('date') || value.includes('time')) {
		return '"2026-04-25T00:00:00Z"';
	}
	if (value.includes('|')) {
		return type.split('|')[0]?.trim().replace(/'/g, '"') ?? '"..."';
	}
	return '"..."';
}

function buildTsInterface(name: string, schema: SchemaShape): string {
	const fields = Object.entries(schema).map(([key, type]) => `  ${key}: ${type};`).join('\n');
	return `interface ${name} {\n${fields}\n}`;
}

function buildJsonExample(schema: SchemaShape): string {
	const fields = Object.entries(schema).map(([key, type]) => `  "${key}": ${mockValue(type)}`).join(',\n');
	return `{\n${fields}\n}`;
}

function buildInterfaceName(endpoint: DiscoveredApi, suffix: 'Request' | 'Response'): string {
	const method = endpoint.method.charAt(0).toUpperCase() + endpoint.method.slice(1).toLowerCase();
	const pathName = endpoint.path
		.split('/')
		.filter(Boolean)
		.map((segment) =>
			segment
				.replace(/[:{}]/g, ' ')
				.split(/[^A-Za-z0-9]+/)
				.filter(Boolean)
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join('')
		)
		.join('');
	return `${method}${pathName || 'Endpoint'}${suffix}`;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="discovery-schema-copy"
			onClick={async (event) => {
				event.stopPropagation();
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1800);
				} catch {
					setCopied(false);
				}
			}}
		>
			{copied ? <Check size={10} /> : <Copy size={10} />}
			{copied ? 'Copied' : 'Copy'}
		</button>
	);
}

function SchemaPanel({
	schema,
	label,
	icon,
	kind,
	interfaceName,
	fieldLocations,
	fallbackEndpoint,
	onRevealField
}: {
	schema: SchemaShape;
	label: string;
	icon: ReactNode;
	kind: 'request' | 'response';
	interfaceName: string;
	fieldLocations?: SchemaFieldSourceLocation[];
	fallbackEndpoint?: DiscoveredApi;
	onRevealField?: (location: SourceRevealTarget) => void;
}) {
	const [view, setView] = useState<SchemaView>('fields');
	const entries = Object.entries(schema);
	const tsText = buildTsInterface(interfaceName, schema);
	const jsonText = buildJsonExample(schema);
	const copyText = view === 'ts' ? tsText : view === 'json' ? jsonText : entries.map(([key, type]) => `${key}: ${type}`).join('\n');

	return (
		<div className={`discovery-schema-panel discovery-schema-panel-${kind}`}>
			<div className="discovery-schema-panel-head">
				<span className="discovery-schema-panel-title">
					{icon}
					{label}
				</span>
				<span className="discovery-schema-field-count">
					{entries.length} field{entries.length !== 1 ? 's' : ''}
				</span>
				<div className="discovery-schema-view-toggle">
					{(['fields', 'ts', 'json'] as SchemaView[]).map((value) => (
						<button
							key={value}
							type="button"
							className={`discovery-schema-view ${view === value ? 'is-active' : ''}`}
							onClick={(event) => {
								event.stopPropagation();
								setView(value);
							}}
						>
							{value === 'fields' ? <Braces size={9} /> : <Code2 size={9} />}
							{value === 'fields' ? 'Fields' : value.toUpperCase()}
						</button>
					))}
				</div>
				<CopyButton text={copyText} />
			</div>
			{view === 'fields' ? (
				<div className="discovery-schema-fields">
					{entries.map(([key, type]) => {
						const location = fieldLocations?.find((item) => item.scope === kind && item.field === key)
							?? fieldLocations?.find((item) => item.scope === kind && normalizeFieldKey(item.field) === normalizeFieldKey(key))
							?? (fallbackEndpoint ? resolveFieldLocation(fallbackEndpoint, kind, key) : undefined);
						const content = (
							<>
								<code className="discovery-schema-key">{key}</code>
								<span className="discovery-schema-optional" title="Optional">?</span>
								<span className={`discovery-schema-type-chip ${typeClass(type)}`}>
									{type}
								</span>
							</>
						);
						return location && onRevealField ? (
							<button
								key={key}
								type="button"
								className="discovery-schema-field-row discovery-schema-field-button"
								title={`Open ${key} usage at line ${location.line}`}
								onClick={() => onRevealField(location)}
							>
								{content}
							</button>
						) : (
							<div key={key} className="discovery-schema-field-row">
								{content}
							</div>
						);
					})}
				</div>
			) : (
				<pre className="discovery-schema-code">
					{view === 'ts' ? tsText : jsonText}
				</pre>
			)}
		</div>
	);
}

function EndpointRow({
	endpoint,
	mismatchLookup,
	endpointLookup,
	onReveal
}: {
	endpoint: DiscoveredApi;
	mismatchLookup: MismatchLookup;
	endpointLookup: EndpointLookup;
	onReveal: (item: DiscoveredApi) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const method = normalizeMethod(endpoint.method);
	const mc = METHOD_STYLES[method];
	const issues = getEndpointIssues(endpoint, mismatchLookup);
	const mismatch = issues.length > 0;
	const issueBadges = uniqueIssueBadges(issues);
	const counterpart = getCounterpartEndpoint(endpoint, endpointLookup);
	const frontendEndpoint = counterpart ? (endpoint.side === 'frontend' ? endpoint : counterpart) : undefined;
	const backendEndpoint = counterpart ? (endpoint.side === 'backend' ? endpoint : counterpart) : undefined;
	const issueSchemaDiffs = collectSchemaDiffs(issues).map((diff) =>
		frontendEndpoint && backendEndpoint ? attachFieldLocations(diff, frontendEndpoint, backendEndpoint) : diff
	);
	const comparableSchemaDiffs = collectComparableSchemaDiffs(endpoint, counterpart)
		.filter((diff) => !issueSchemaDiffs.some((issueDiff) => issueDiff.scope === diff.scope));
	const schemaDiffs = [...issueSchemaDiffs, ...comparableSchemaDiffs];
	const requestSchema = parseSchema(endpoint.requestSchema);
	const responseSchema = parseSchema(endpoint.responseSchema);
	const hasSchema = Boolean(requestSchema || responseSchema || schemaDiffs.length > 0);
	const mappedScopes = new Set(schemaDiffs.map((diff) => diff.scope));
	const hasUnmappedRequestSchema = Boolean(requestSchema && !mappedScopes.has('request'));
	const hasUnmappedResponseSchema = Boolean(responseSchema && !mappedScopes.has('response'));
	const hasUnmappedSchema = hasUnmappedRequestSchema || hasUnmappedResponseSchema;
	const methodOutlineClass = `discovery-item-method-${method.toLowerCase()}`;
	const stateClass = `${mismatch ? 'is-mismatch' : ''} ${expanded ? 'is-expanded' : ''}`;
	const revealField = (location: SourceRevealTarget) => {
		const candidates = counterpart ? [endpoint, counterpart] : [endpoint];
		const sourceEndpoint = candidates.find((item) => item.uri === location.uri) ?? endpoint;
		const fieldSourceIsDifferentFile = Boolean(location.uri && location.uri !== endpoint.uri && location.uri !== counterpart?.uri);
		onReveal({
			...sourceEndpoint,
			uri: location.uri || sourceEndpoint.uri,
			line: location.line,
			column: location.column,
			method: location.method ?? sourceEndpoint.method,
			path: location.path ?? sourceEndpoint.path,
			side: (location.side ?? sourceEndpoint.side) as DiscoveredApi['side'],
			highlightText: location.highlightText ?? ('field' in location && typeof location.field === 'string' ? location.field : undefined),
			skipCounterpartReveal: fieldSourceIsDifferentFile
		});
	};

	return (
		<>
			<div className="discovery-item">
				<div
					className={`discovery-item-row ${methodOutlineClass} ${stateClass} ${hasSchema ? 'has-schema' : ''}`}
					onClick={() => {
						if (hasSchema) {
							setExpanded((value) => !value);
						}
					}}
				>
					<div className="discovery-main">
						<span className={`discovery-chevron ${hasSchema ? '' : 'is-hidden'}`}>
							{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
						</span>
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
						{requestSchema ? (
							<span className="discovery-schema-pill discovery-schema-pill-request">
								<ArrowUpFromLine size={9} />
								req &middot; {Object.keys(requestSchema).length}
							</span>
						) : null}
		{responseSchema ? (
							<span className="discovery-schema-pill discovery-schema-pill-response">
								<ArrowDownToLine size={9} />
								res &middot; {Object.keys(responseSchema).length}
							</span>
						) : null}
						{endpoint.requestHeaders && endpoint.requestHeaders.length > 0 ? (
							<span className="discovery-schema-pill discovery-schema-pill-headers" title={endpoint.requestHeaders.join(', ')}>
								headers &middot; {endpoint.requestHeaders.length}
							</span>
						) : null}
						<span className="discovery-location">
							:{endpoint.line}
						</span>
						<button
							type="button"
							className="sv-ui-button sv-ui-button-sm sv-ui-button-outline discovery-open"
							title={`Open ${endpoint.source}:${endpoint.line}`}
							onClick={(event) => {
								event.stopPropagation();
								onReveal(endpoint);
							}}
						>
							<ExternalLink size={10} />
							Open
						</button>
					</div>
				</div>
			</div>
			{expanded && hasSchema ? (
				<div className="discovery-schema-under">
					{schemaDiffs.length > 0 ? (
						<>
							<div className="discovery-schema-mapping">
								<SchemaDiffView diffs={schemaDiffs} onRevealField={revealField} />
							</div>
							{hasUnmappedSchema ? (
								<div className={hasUnmappedRequestSchema && hasUnmappedResponseSchema ? 'discovery-schema-compare' : 'discovery-schema-single'}>
									{hasUnmappedRequestSchema && requestSchema ? (
										<SchemaPanel
											schema={requestSchema}
											label="Request Body"
											icon={<ArrowUpFromLine size={11} />}
											kind="request"
											interfaceName={buildInterfaceName(endpoint, 'Request')}
											fieldLocations={endpoint.fieldLocations}
											fallbackEndpoint={endpoint}
											onRevealField={revealField}
										/>
									) : null}
									{hasUnmappedResponseSchema && responseSchema ? (
										<SchemaPanel
											schema={responseSchema}
											label="Response Body"
											icon={<ArrowDownToLine size={11} />}
											kind="response"
											interfaceName={buildInterfaceName(endpoint, 'Response')}
											fieldLocations={endpoint.fieldLocations}
											fallbackEndpoint={endpoint}
											onRevealField={revealField}
										/>
									) : null}
								</div>
							) : null}
						</>
					) : (
						<div className={requestSchema && responseSchema ? 'discovery-schema-compare' : 'discovery-schema-single'}>
							{requestSchema ? (
								<SchemaPanel
									schema={requestSchema}
									label="Request Body"
									icon={<ArrowUpFromLine size={11} />}
									kind="request"
									interfaceName={buildInterfaceName(endpoint, 'Request')}
									fieldLocations={endpoint.fieldLocations}
									fallbackEndpoint={endpoint}
									onRevealField={revealField}
								/>
							) : null}
							{responseSchema ? (
								<SchemaPanel
									schema={responseSchema}
									label="Response Body"
									icon={<ArrowDownToLine size={11} />}
									kind="response"
									interfaceName={buildInterfaceName(endpoint, 'Response')}
									fieldLocations={endpoint.fieldLocations}
									fallbackEndpoint={endpoint}
									onRevealField={revealField}
								/>
							) : null}
						</div>
					)}
				</div>
			) : null}
		</>
	);
}

function SourceGroupCard({
	group,
	mismatchLookup,
	endpointLookup,
	onReveal
}: {
	group: GroupedSource;
	mismatchLookup: MismatchLookup;
	endpointLookup: EndpointLookup;
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
							endpointLookup={endpointLookup}
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
	const endpointLookup = useMemo(() => buildEndpointLookup(items), [items]);
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
						<SourceGroupCard key={group.source} group={group} mismatchLookup={mismatchLookup} endpointLookup={endpointLookup} onReveal={onReveal} />
					))
				)}
			</div>
		</section>
	);
}
