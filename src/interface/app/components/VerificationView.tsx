import { useMemo, useState } from 'react';
import { Filter, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge } from './ui';
import { SchemaDiffView } from './SchemaDiffView';
import type { SchemaDiff, VerificationIssue, VerificationIssueKind } from '../../../shared/messages';

type Issue = VerificationIssue;

type MismatchType = 'missing-in-be' | 'missing-in-fe' | 'schema-mismatch';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
type FilterType = 'all' | MismatchType;

type ParsedMismatch = {
	id: string;
	type: MismatchType;
	method: HttpMethod;
	path: string;
	description: string;
	severity: 'high' | 'medium' | 'low';
	feSource?: string;
	beSource?: string;
	schemaDiffs?: SchemaDiff[];
};

const mismatchTypeConfig: Record<MismatchType, { label: string; badge: string }> = {
	'missing-in-be': { label: 'Missing in BE', badge: 'sv-mm-type-error' },
	'missing-in-fe': { label: 'Extra in BE', badge: 'sv-mm-type-neutral' },
	'schema-mismatch': { label: 'Schema Mismatch', badge: 'sv-mm-type-warn' }
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
	OPTIONS: 'sv-mm-method-options'
};

export function inferType(message: string): MismatchType {
	const lower = message.toLowerCase();
	if (lower.includes('missing backend endpoint')) {
		return 'missing-in-be';
	}
	if (lower.includes('not declared in frontend')) {
		return 'missing-in-fe';
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
	const match = message.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^\s,.:"]+)/i);
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
		type: kindToMismatchType(issue.kind),
		method: parsed.method,
		path: parsed.path,
		description: issue.message,
		severity: inferSeverity(issue),
		feSource: issue.sourceSide === 'frontend' ? `${issue.file}:${issue.line}:${issue.column}` : undefined,
		beSource: issue.sourceSide === 'backend' ? `${issue.file}:${issue.line}:${issue.column}` : undefined,
		schemaDiffs
	};
}

function MismatchCard({ mismatch }: { mismatch: ParsedMismatch }) {
	const [expanded, setExpanded] = useState(false);
	const typeCfg = mismatchTypeConfig[mismatch.type];
	const sevCfg = severityConfig[mismatch.severity];
	const severityDot = mismatch.severity === 'high' ? 'sv-mm-dot-high' : mismatch.severity === 'medium' ? 'sv-mm-dot-medium' : 'sv-mm-dot-low';
	const typeClass = mismatch.type === 'missing-in-be'
		? 'sv-mm-type-error'
		: mismatch.type === 'schema-mismatch'
			? 'sv-mm-type-warn'
			: 'sv-mm-type-neutral';

	return (
		<div className="sv-ui-card sv-mm-card">
			<div className="sv-mm-head" onClick={() => setExpanded((value) => !value)}>
				<span className={`sv-mm-dot ${severityDot}`} />
				<div className="sv-mm-main">
					<div className="sv-mm-row">
						<Badge className={`sv-mm-type ${typeClass}`}>
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
						<span className="sv-mm-severity">
							{sevCfg.label}
						</span>
					</div>
					<p className="sv-mm-desc">{mismatch.description}</p>
				</div>
			</div>
			{expanded ? (
				<div className="sv-mm-expanded">
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
						<SchemaDiffView diffs={mismatch.schemaDiffs} />
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function VerificationView({ mismatches }: { mismatches: Issue[] }) {
	const [filter, setFilter] = useState<FilterType>('all');
	const parsed = useMemo(() => mismatches.map(toMismatch), [mismatches]);
	const filtered = filter === 'all' ? parsed : parsed.filter((item) => item.type === filter);
	const counts: Record<FilterType, number> = {
		all: parsed.length,
		'missing-in-be': parsed.filter((item) => item.type === 'missing-in-be').length,
		'missing-in-fe': parsed.filter((item) => item.type === 'missing-in-fe').length,
		'schema-mismatch': parsed.filter((item) => item.type === 'schema-mismatch').length
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
							{counts['missing-in-be']} missing in BE &middot; {counts['schema-mismatch']} schema issues &middot; {counts['missing-in-fe']} extra in BE
						</span>
					</div>
				)}

				<div className="sv-verify-filters">
					<Filter size={11} />
					{(['all', 'missing-in-be', 'schema-mismatch', 'missing-in-fe'] as FilterType[]).map((value) => (
						<button
							key={value}
							type="button"
							className={`sv-ui-button sv-ui-button-sm sv-ui-button-ghost sv-verify-filter ${filter === value ? 'is-active' : ''}`}
							onClick={() => setFilter(value)}
						>
							{value === 'all' ? 'All' : value === 'missing-in-be' ? 'Missing in BE' : value === 'missing-in-fe' ? 'Extra in BE' : 'Schema'}
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
					filtered.map((mismatch) => <MismatchCard key={mismatch.id} mismatch={mismatch} />)
				)}
			</div>
		</div>
	);
}
