import { useMemo, useState } from 'react';
import { ExternalLink, Filter, Loader2, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { Badge } from './ui';
import { SchemaDiffView } from './SchemaDiffView';
import type { SchemaDiff, SourceRevealTarget, VerificationIssue, VerificationIssueKind } from '../../../shared/messages';

type Issue = VerificationIssue;

type MismatchType = 'missing-in-be' | 'missing-in-fe' | 'schema-mismatch' | 'header-mismatch';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'WS';
type FilterType = 'all' | MismatchType;

type ParsedMismatch = {
	id: string;
	uri?: string;
	type: MismatchType;
	method: HttpMethod;
	path: string;
	line: number;
	column: number;
	sourceSide: Issue['sourceSide'];
	description: string;
	severity: 'high' | 'medium' | 'low';
	feSource?: string;
	beSource?: string;
	schemaDiffs?: SchemaDiff[];
	headerDiffs?: string[];
};

type AiExplanationState = {
	status: 'loading' | 'done' | 'error';
	text?: string;
	error?: string;
};

const mismatchTypeConfig: Record<MismatchType, { label: string; badge: string }> = {
	'missing-in-be': { label: 'Missing in BE', badge: 'sv-mm-type-error' },
	'missing-in-fe': { label: 'Extra in BE', badge: 'sv-mm-type-neutral' },
	'schema-mismatch': { label: 'Schema Mismatch', badge: 'sv-mm-type-warn' },
	'header-mismatch': { label: 'Header Mismatch', badge: 'sv-mm-type-error' }
};

const severityConfig = {
	high: { label: 'High', dot: 'sv-mm-dot-high' },
	medium: { label: 'Medium', dot: 'sv-mm-dot-medium' },
	low: { label: 'Low', dot: 'sv-mm-dot-low' }
} as const;

const methodClass: Record<HttpMethod, string> = {
	GET: 'sv-mm-method-get',
	POST: 'sv-mm-method-post',
	PUT: 'sv-mm-method-put',
	DELETE: 'sv-mm-method-delete',
	PATCH: 'sv-mm-method-patch',
	HEAD: 'sv-mm-method-head',
	OPTIONS: 'sv-mm-method-options',
	WS: 'sv-mm-method-options'
};

export function inferType(message: string): MismatchType {
	const lower = message.toLowerCase();
	if (lower.includes('missing backend endpoint')) {
		return 'missing-in-be';
	}
	if (lower.includes('not declared in frontend')) {
		return 'missing-in-fe';
	}
	if (lower.includes('header mismatch')) {
		return 'header-mismatch';
	}
	return 'schema-mismatch';
}

function kindToMismatchType(kind: VerificationIssueKind): MismatchType {
	if (kind === 'missing-backend') {
		return 'missing-in-be';
	}
	if (kind === 'backend-only') {
		return 'missing-in-fe';
	}
	if (kind === 'header-mismatch') {
		return 'header-mismatch';
	}
	return 'schema-mismatch';
}

export function inferSeverity(issue: Pick<Issue, 'severity'>): 'high' | 'medium' | 'low' {
	if (issue.severity === 'error') {
		return 'high';
	}
	if (issue.severity === 'warning') {
		return 'medium';
	}
	return 'low';
}

export function parseMethodPath(message: string): { method: HttpMethod; path: string } {
	const match = message.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|WS)\s+([^\s,.:"]+)/i);
	if (!match) {
		return { method: 'GET', path: '/unknown' };
	}
	return {
		method: match[1].toUpperCase() as HttpMethod,
		path: match[2]
	};
}

export function extractSchemaDiffs(message: string): SchemaDiff[] | undefined {
	const start = message.indexOf('schemaDiff=');
	if (start < 0) {
		return undefined;
	}

	const jsonStart = message.indexOf('[', start);
	if (jsonStart < 0) {
		return undefined;
	}

	const candidate = message.slice(jsonStart).trim();
	try {
		const parsed = JSON.parse(candidate);
		if (Array.isArray(parsed)) {
			return parsed as SchemaDiff[];
		}
	} catch {
		return undefined;
	}

	return undefined;
}

export function toMismatch(issue: Issue, index: number): ParsedMismatch {
	const parsed = issue.method && issue.path ? { method: issue.method as HttpMethod, path: issue.path } : parseMethodPath(issue.message);
	const schemaDiffs = issue.schemaDiffs ?? extractSchemaDiffs(issue.message);
	return {
		id: `${issue.file}:${issue.line}:${issue.column}:${index}`,
		uri: issue.uri,
		type: kindToMismatchType(issue.kind),
		method: parsed.method,
		path: parsed.path,
		line: issue.line,
		column: issue.column,
		sourceSide: issue.sourceSide,
		description: issue.message,
		severity: inferSeverity(issue),
		feSource: issue.sourceSide === 'frontend' ? `${issue.file}:${issue.line}:${issue.column}` : undefined,
		beSource: issue.sourceSide === 'backend' ? `${issue.file}:${issue.line}:${issue.column}` : undefined,
		schemaDiffs,
		headerDiffs: issue.headerDiffs
	};
}

export function explainMismatch(mismatch: ParsedMismatch): { summary: string; impact: string; nextStep: string } {
	if (mismatch.type === 'missing-in-be') {
		return {
			summary: 'The frontend calls this endpoint, but the verifier did not find a matching backend route with the same method and normalized path.',
			impact: 'At runtime this can become a 404, a proxy miss, or a call to a route that is named differently than the frontend expects.',
			nextStep: 'Check whether the backend route is missing, has a different prefix, uses a different HTTP method, or uses a path parameter format that should be normalized.'
		};
	}
	if (mismatch.type === 'missing-in-fe') {
		return {
			summary: 'The backend exposes this endpoint, but no frontend call was discovered for it.',
			impact: 'This is usually informational: the route can be intentionally unused, only used by another client, or still waiting for FE integration.',
			nextStep: 'If the route should be used by this frontend, add or verify the FE call. Otherwise treat it as a backend extra, not necessarily a breaking issue.'
		};
	}
	if (mismatch.type === 'header-mismatch') {
		return {
			summary: 'The backend expects one or more request headers that the matching frontend call does not appear to send.',
			impact: 'The request may be rejected by authentication, authorization, CSRF, tenant, or API-key middleware even if the path and body are correct.',
			nextStep: 'Compare the required backend dependency/header declaration with the frontend fetch/axios header object and credentials settings.'
		};
	}
	return {
		summary: 'The frontend and backend agree on the endpoint, but the request or response schema does not line up.',
		impact: 'The call may still reach the backend, but data can be sent under the wrong field name, parsed with the wrong type, or read from a response field that is not returned.',
		nextStep: 'Use the field comparison below: red rows are blocking mismatches, yellow rows are compatible warnings or mapped names, and green rows are fields that line up.'
	};
}

function schemaDiffSummary(diffs: SchemaDiff[] | undefined): Array<{ label: string; value: number }> {
	const fields = diffs?.flatMap((diff) => diff.fields) ?? [];
	return [
		{ label: 'matches', value: fields.filter((field) => field.status === 'match').length },
		{ label: 'mapped names', value: fields.filter((field) => field.status === 'renamed').length },
		{ label: 'type mismatches', value: fields.filter((field) => field.status === 'type-changed').length },
		{ label: 'FE only', value: fields.filter((field) => field.status === 'fe-only').length },
		{ label: 'BE only', value: fields.filter((field) => field.status === 'be-only').length }
	].filter((item) => item.value > 0);
}

function parseSchemaShape(schema: string | undefined): Record<string, string> | undefined {
	if (!schema) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(schema) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return undefined;
		}
		return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [
			key,
			typeof value === 'string' ? value : JSON.stringify(value)
		]));
	} catch {
		return undefined;
	}
}

function RawSchemaFields({
	diff,
	onRevealField
}: {
	diff: SchemaDiff;
	onRevealField?: (location: SourceRevealTarget) => void;
}) {
	const frontend = parseSchemaShape(diff.feLabel);
	const backend = parseSchemaShape(diff.beLabel);
	if (!frontend && !backend) {
		return null;
	}
	const locationFor = (side: 'fe' | 'be', key: string) =>
		diff.fields.find((field) => field[side]?.key === key)?.[side]?.location;

	const renderPanel = (side: 'fe' | 'be', label: string, schema: Record<string, string> | undefined) => schema ? (
		<div className={`sv-mm-raw-schema sv-mm-raw-schema-${side}`}>
			<span className="sv-mm-explain-label">{label}</span>
			<div className="sv-mm-raw-fields">
				{Object.entries(schema).map(([key, type]) => {
					const location = locationFor(side, key);
					const content = (
						<>
							<code>{key}</code>
							<span>{type}</span>
						</>
					);
					return location && onRevealField ? (
						<button
							key={key}
							type="button"
							className="sv-mm-raw-field"
							title={`Open ${key} usage at line ${location.line}`}
							onClick={() => onRevealField(location)}
						>
							{content}
						</button>
					) : (
						<div key={key} className="sv-mm-raw-field">
							{content}
						</div>
					);
				})}
			</div>
		</div>
	) : null;

	return (
		<div className="sv-mm-raw-schema-grid">
			{renderPanel('fe', diff.scope === 'request' ? 'Frontend request fields' : 'Frontend response fields', frontend)}
			{renderPanel('be', diff.scope === 'request' ? 'Backend request fields' : 'Backend response fields', backend)}
		</div>
	);
}

function MismatchCard({
	mismatch,
	onReveal,
	onRevealField,
	onExplain,
	onCopyFix,
	aiExplanation
}: {
	mismatch: ParsedMismatch;
	onReveal?: (mismatch: ParsedMismatch) => void;
	onRevealField?: (location: SourceRevealTarget) => void;
	onExplain?: (mismatch: ParsedMismatch) => void;
	onCopyFix?: (mismatch: ParsedMismatch) => void;
	aiExplanation?: AiExplanationState;
}) {
	const [expanded, setExpanded] = useState(false);
	const typeCfg = mismatchTypeConfig[mismatch.type];
	const sevCfg = severityConfig[mismatch.severity];
	const explanation = explainMismatch(mismatch);
	const diffSummary = schemaDiffSummary(mismatch.schemaDiffs);
	const severityDot = mismatch.severity === 'high' ? 'sv-mm-dot-high' : mismatch.severity === 'medium' ? 'sv-mm-dot-medium' : 'sv-mm-dot-low';
	const typeClass = mismatch.type === 'missing-in-be'
		? 'sv-mm-type-error'
		: mismatch.type === 'schema-mismatch'
			? 'sv-mm-type-warn'
			: mismatch.type === 'header-mismatch'
				? 'sv-mm-type-error'
				: 'sv-mm-type-neutral';

	return (
		<div className="sv-ui-card sv-mm-card">
			<div className="sv-mm-head" onClick={() => setExpanded((value) => !value)} title={mismatch.description}>
				<span className={`sv-mm-dot ${severityDot}`} />
				<div className="sv-mm-main">
					<div className="sv-mm-row">
						<Badge className={`sv-mm-type ${typeClass}`} title={mismatch.description}>
							{typeCfg.label}
						</Badge>
						<Badge className={`sv-mm-method ${methodClass[mismatch.method]}`}>
							{mismatch.method}
						</Badge>
						<code className="sv-mm-path">{mismatch.path}</code>
						{mismatch.schemaDiffs && mismatch.schemaDiffs.length > 0 ? (
							<span className="sv-ui-badge sv-ui-badge-neutral">
								{mismatch.schemaDiffs.reduce((sum, diff) => sum + diff.fields.length, 0)} fields diffed
							</span>
						) : null}
						<span className="sv-mm-severity" title={mismatch.description}>
							{sevCfg.label}
						</span>
						{onCopyFix ? (
							<button
								type="button"
								className="sv-ui-button sv-ui-button-sm sv-ui-button-outline sv-mm-open"
								title="Copy a targeted fix stub or prompt"
								onClick={(event) => {
									event.stopPropagation();
									onCopyFix(mismatch);
								}}
							>
								<Sparkles size={10} />
								Fix
							</button>
						) : null}
						{mismatch.uri && onReveal ? (
							<button
								type="button"
								className="sv-ui-button sv-ui-button-sm sv-ui-button-outline sv-mm-open"
								title={`Open ${mismatch.method} ${mismatch.path}`}
								onClick={(event) => {
									event.stopPropagation();
									onReveal(mismatch);
								}}
							>
								<ExternalLink size={10} />
								Open
							</button>
						) : null}
					</div>
					<p className="sv-mm-desc">{mismatch.description}</p>
				</div>
			</div>
			{expanded ? (
				<div className="sv-mm-expanded">
					<div className="sv-mm-explanation">
						<div className="sv-mm-explain-block">
							<span className="sv-mm-explain-label">What this means</span>
							<p>{explanation.summary}</p>
						</div>
						<div className="sv-mm-explain-block">
							<span className="sv-mm-explain-label">Why it matters</span>
							<p>{explanation.impact}</p>
						</div>
						<div className="sv-mm-explain-block">
							<span className="sv-mm-explain-label">What to check</span>
							<p>{explanation.nextStep}</p>
						</div>
					</div>
					{diffSummary.length > 0 ? (
						<div className="sv-mm-detail-chips" aria-label="Schema diff summary">
							{diffSummary.map((item) => (
								<span key={item.label} className="sv-mm-detail-chip">
									<strong>{item.value}</strong> {item.label}
								</span>
							))}
						</div>
					) : null}
					{mismatch.headerDiffs && mismatch.headerDiffs.length > 0 ? (
						<div className="sv-mm-header-details">
							<span className="sv-mm-explain-label">Header checks</span>
							<ul>
								{mismatch.headerDiffs.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</div>
					) : null}
					{onExplain ? (
						<div className="sv-mm-ai-panel">
							<div className="sv-mm-ai-head">
								<span className="sv-mm-explain-label">AI explainer</span>
								<button
									type="button"
									className="sv-ui-button sv-ui-button-sm sv-ui-button-outline sv-mm-ai-button"
									disabled={aiExplanation?.status === 'loading'}
									onClick={() => onExplain(mismatch)}
								>
									{aiExplanation?.status === 'loading' ? <Loader2 size={11} className="sv-spin" /> : <Sparkles size={11} />}
									{aiExplanation?.status === 'loading' ? 'Explaining...' : aiExplanation?.status === 'done' ? 'Regenerate' : 'AI Explain'}
								</button>
							</div>
							<p className="sv-mm-ai-note">Uses an extension-managed shared quota. Calls are temporarily unavailable when the limit is reached.</p>
							{aiExplanation?.status === 'done' ? (
								<p className="sv-mm-ai-text">{aiExplanation.text}</p>
							) : null}
							{aiExplanation?.status === 'error' ? (
								<p className="sv-mm-ai-error">{aiExplanation.error}</p>
							) : null}
						</div>
					) : null}
					{mismatch.feSource ? (
						<div className="sv-mm-source">
							<Badge className="sv-mm-source-tag sv-mm-source-fe">FE</Badge>
							<code className="sv-mm-source-path">{mismatch.feSource}</code>
						</div>
					) : null}
					{mismatch.beSource ? (
						<div className="sv-mm-source">
							<Badge className="sv-mm-source-tag sv-mm-source-be">BE</Badge>
							<code className="sv-mm-source-path">{mismatch.beSource}</code>
						</div>
					) : null}
					{mismatch.schemaDiffs && mismatch.schemaDiffs.length > 0 ? (
						<>
							<SchemaDiffView diffs={mismatch.schemaDiffs} onRevealField={onRevealField} />
							{mismatch.schemaDiffs.map((diff, index) => (
								<RawSchemaFields key={`${diff.scope}-${index}`} diff={diff} onRevealField={onRevealField} />
							))}
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function VerificationView({
	mismatches,
	onRevealIssue,
	onRevealField,
	onExplainIssue,
	onCopyIssueFix,
	aiExplanations
}: {
	mismatches: Issue[];
	onRevealIssue?: (issue: Issue) => void;
	onRevealField?: (location: SourceRevealTarget) => void;
	onExplainIssue?: (requestId: string, issue: Issue) => void;
	onCopyIssueFix?: (issue: Issue) => void;
	aiExplanations?: Record<string, AiExplanationState>;
}) {
	const [filter, setFilter] = useState<FilterType>('all');
	const parsed = useMemo(() => mismatches.map(toMismatch), [mismatches]);
	const issueById = useMemo(() => new Map(parsed.map((item, index) => [item.id, mismatches[index]])), [mismatches, parsed]);
	const filtered = filter === 'all' ? parsed : parsed.filter((item) => item.type === filter);
	const counts: Record<FilterType, number> = {
		all: parsed.length,
		'missing-in-be': parsed.filter((item) => item.type === 'missing-in-be').length,
		'missing-in-fe': parsed.filter((item) => item.type === 'missing-in-fe').length,
		'schema-mismatch': parsed.filter((item) => item.type === 'schema-mismatch').length,
		'header-mismatch': parsed.filter((item) => item.type === 'header-mismatch').length
	};

	return (
		<div className="sv-verify">
			<div className="sv-verify-summary">
				{parsed.length === 0 ? (
					<div className="sv-verify-ok">
						<ShieldCheck size={16} />
						<span>All endpoints verified - no mismatches found</span>
					</div>
				) : (
					<div className="sv-verify-warn">
						<ShieldAlert size={15} />
						<span>
							<strong>{parsed.length}</strong> mismatch{parsed.length !== 1 ? 'es' : ''} detected
						</span>
						<span>
							{counts['missing-in-be']} missing in BE &middot; {counts['schema-mismatch']} schema issues &middot; {counts['header-mismatch']} header issues &middot; {counts['missing-in-fe']} extra in BE
						</span>
					</div>
				)}

				<div className="sv-verify-filters">
					<Filter size={11} />
					{(['all', 'missing-in-be', 'schema-mismatch', 'header-mismatch', 'missing-in-fe'] as FilterType[]).map((value) => (
						<button
							key={value}
							type="button"
							className={`sv-ui-button sv-ui-button-sm sv-ui-button-ghost sv-verify-filter ${filter === value ? 'is-active' : ''}`}
							onClick={() => setFilter(value)}
						>
							{value === 'all' ? 'All' : value === 'missing-in-be' ? 'Missing in BE' : value === 'missing-in-fe' ? 'Extra in BE' : value === 'header-mismatch' ? 'Headers' : 'Schema'}
							<Badge>
								{counts[value]}
							</Badge>
						</button>
					))}
				</div>
			</div>

			<div className="sv-verify-list">
				{filtered.length === 0 ? (
					<div className="sv-verify-empty">
						<ShieldCheck size={24} />
						<p>No mismatches for this filter.</p>
					</div>
				) : (
					filtered.map((mismatch) => (
						<MismatchCard
							key={mismatch.id}
							mismatch={mismatch}
							onReveal={onRevealIssue
								? (item) => {
									const issue = issueById.get(item.id);
									if (issue) {
										onRevealIssue(issue);
									}
								}
								: undefined}
							onExplain={onExplainIssue
								? (item) => {
									const issue = issueById.get(item.id);
									if (issue) {
										onExplainIssue(item.id, issue);
									}
								}
								: undefined}
							onCopyFix={onCopyIssueFix
								? (item) => {
									const issue = issueById.get(item.id);
									if (issue) {
										onCopyIssueFix(issue);
									}
								}
								: undefined}
							onRevealField={onRevealField}
							aiExplanation={aiExplanations?.[mismatch.id]}
						/>
					))
				)}
			</div>
		</div>
	);
}
