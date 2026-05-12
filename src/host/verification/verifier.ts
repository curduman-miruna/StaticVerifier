import * as vscode from 'vscode';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import type {
	EndpointContract,
	EndpointRecord,
	ParsedContractFile,
	VerificationSummary
} from '../contracts/internalTypes';
import type { SchemaDiff, SourceRevealTarget, VerificationIssue, VerificationIssueKind } from '../../shared/messages';
import { compareSchemaStrings } from './schemaCompare';
import { normalizeEndpoint, normalizeEndpointMethod } from './endpointNormalization';
import { findMissingRequiredHeaders } from './headerCompatibility';

type NormalizedEndpointRecord = EndpointRecord & {
	normalizedMethod: string;
	normalizedPath: string;
	sourceSide: 'frontend' | 'backend';
};

type IssueSeveritySetting = 'error' | 'warning' | 'info' | 'ignore';

const ISSUE_SEVERITY_SETTINGS: Record<VerificationIssueKind, { key: string; defaultValue: IssueSeveritySetting }> = {
	'missing-backend': { key: 'issueSeverity.missingBackend', defaultValue: 'error' },
	'backend-only': { key: 'issueSeverity.backendOnly', defaultValue: 'warning' },
	'request-schema-mismatch': { key: 'issueSeverity.requestSchemaMismatch', defaultValue: 'error' },
	'response-schema-mismatch': { key: 'issueSeverity.responseSchemaMismatch', defaultValue: 'error' },
	'header-mismatch': { key: 'issueSeverity.headerMismatch', defaultValue: 'error' },
	'invalid-endpoint': { key: 'issueSeverity.invalidEndpoint', defaultValue: 'error' },
	'duplicate-endpoint': { key: 'issueSeverity.duplicateEndpoint', defaultValue: 'warning' }
};

export function formatVerificationSummary(summary: VerificationSummary): string {
	return [
		`Compared FE endpoints: ${summary.comparedFrontend}`,
		`Matches: ${summary.matchedEndpoints}`,
		`Mismatches: ${summary.totalIssues}`,
		`- Missing in BE: ${summary.missingBackend}`,
		`- Request schema mismatches: ${summary.requestMismatches}`,
		`- Response schema mismatches: ${summary.responseMismatches}`,
		`- Header mismatches: ${summary.headerMismatches}`,
		`- BE-only endpoints: ${summary.backendOnly}`,
		summary.totalIssues > 0 ? 'Check the Problems panel for file-level details.' : 'No mismatches found.'
	].join('\n');
}

export async function runContractVerification(
	collection: vscode.DiagnosticCollection,
	showNotifications: boolean
): Promise<VerificationSummary> {
	collection.clear();

	const frontendFiles = await loadConfiguredContracts('frontend', collection);
	const backendFiles = await loadConfiguredContracts('backend', collection);

	if (frontendFiles.length === 0 && backendFiles.length === 0) {
		if (showNotifications) {
			vscode.window.showWarningMessage(
				'StaticVerifier could not load FE/BE contract sources. Check local paths or GitHub links in the StaticVerifier panel.'
			);
		}
	}

	const frontendRecords = normalizeEndpointRecords(flattenEndpointRecords(frontendFiles), 'frontend');
	const backendRecords = normalizeEndpointRecords(flattenEndpointRecords(backendFiles), 'backend');
	const frontendByKey = aggregateEndpointRecordsByKey(frontendRecords.valid);
	const backendByKey = aggregateEndpointRecordsByKey(backendRecords.valid);
	const severityPolicy = getIssueSeverityPolicy();
	const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
	const issues: VerificationIssue[] = [];
	let matchedEndpoints = 0;
	let missingBackend = 0;
	let requestMismatches = 0;
	let responseMismatches = 0;
	let headerMismatches = 0;
	let backendOnly = 0;

	collectInvalidEndpointIssues(frontendRecords.invalid, 'frontend', diagnosticsByFile, issues, severityPolicy);
	collectInvalidEndpointIssues(backendRecords.invalid, 'backend', diagnosticsByFile, issues, severityPolicy);

	collectDuplicateEndpointIssues(frontendRecords.valid, diagnosticsByFile, issues, severityPolicy);
	collectDuplicateEndpointIssues(backendRecords.valid, diagnosticsByFile, issues, severityPolicy);

	for (const [key, record] of frontendByKey) {
		const backendRecord = backendByKey.get(key);
		if (!backendRecord) {
			missingBackend += 1;
			pushConfiguredDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				severityPolicy,
				'missing-backend',
				record.uri,
				record,
				`Missing backend endpoint for ${key}.`
			);
			continue;
		}

		let hasMismatch = false;
		const requestComparison = compareSchemaStrings(
			record.endpoint.requestSchema,
			backendRecord.endpoint.requestSchema,
			'request'
		);
		if (!requestComparison.equal) {
			requestMismatches += 1;
			hasMismatch = true;
			const message = `Request schema mismatch for ${key}: frontend sends "${record.endpoint.requestSchema ?? '-'}", backend expects "${backendRecord.endpoint.requestSchema ?? '-'}".`;
			const schemaDiffs = attachSchemaDiffLocations(requestComparison.schemaDiffs, record, backendRecord);
			pushConfiguredDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				severityPolicy,
				'request-schema-mismatch',
				record.uri,
				record,
				message,
				schemaDiffs
			);
			pushConfiguredDiagnostic(
				diagnosticsByFile,
				severityPolicy,
				'request-schema-mismatch',
				backendRecord.uri,
				backendRecord,
				message
			);
		}

		const responseComparison = compareSchemaStrings(
			record.endpoint.responseSchema,
			backendRecord.endpoint.responseSchema,
			'response'
		);
		if (!responseComparison.equal) {
			responseMismatches += 1;
			hasMismatch = true;
			const message = `Response schema mismatch for ${key}: backend returns "${backendRecord.endpoint.responseSchema ?? '-'}", frontend expects "${record.endpoint.responseSchema ?? '-'}".`;
			const schemaDiffs = attachSchemaDiffLocations(responseComparison.schemaDiffs, record, backendRecord);
			pushConfiguredDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				severityPolicy,
				'response-schema-mismatch',
				record.uri,
				record,
				message,
				schemaDiffs
			);
			pushConfiguredDiagnostic(
				diagnosticsByFile,
				severityPolicy,
				'response-schema-mismatch',
				backendRecord.uri,
				backendRecord,
				message
			);
		}

		const missingHeaders = findMissingRequiredHeaders(record.endpoint.requestHeaders, backendRecord.endpoint.requestHeaders);
		if (missingHeaders.length > 0) {
			headerMismatches += 1;
			hasMismatch = true;
			const message = `Header mismatch for ${key}: frontend does not send required backend header(s): ${missingHeaders.join(', ')}.`;
			pushConfiguredDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				severityPolicy,
				'header-mismatch',
				record.uri,
				record,
				message,
				undefined,
				missingHeaders
			);
			pushConfiguredDiagnostic(
				diagnosticsByFile,
				severityPolicy,
				'header-mismatch',
				backendRecord.uri,
				backendRecord,
				message
			);
		}

		if (!hasMismatch) {
			matchedEndpoints += 1;
		}
	}

	const frontendKeySet = new Set(frontendByKey.keys());
	for (const [key, record] of backendByKey) {
		if (frontendKeySet.has(key)) {
			continue;
		}
		backendOnly += 1;
		const message = `Backend endpoint ${key} is not declared in frontend contract.`;
		pushConfiguredDiagnosticAndIssue(
			diagnosticsByFile,
			issues,
			severityPolicy,
			'backend-only',
			record.uri,
			record,
			message
		);
	}

	let diagnosticTotal = 0;
	for (const [uriString, fileDiagnostics] of diagnosticsByFile) {
		diagnosticTotal += fileDiagnostics.length;
		collection.set(vscode.Uri.parse(uriString), fileDiagnostics);
	}
	const totalIssues = issues.length;

	if (showNotifications) {
		if (totalIssues === 0) {
			vscode.window.showInformationMessage('StaticVerifier: no contract mismatches found.');
		} else {
			vscode.window.showWarningMessage(
				`StaticVerifier found ${totalIssues} contract issue(s) across ${diagnosticTotal} marker(s). Check the Problems panel.`
			);
		}
	}

	return {
		matchedEndpoints,
		missingBackend,
		requestMismatches,
		responseMismatches,
		headerMismatches,
		backendOnly,
		totalIssues,
		comparedFrontend: frontendByKey.size,
		issues
	};
}

function endpointKey(endpoint: EndpointContract): string {
	return `${endpoint.method.toUpperCase()} ${endpoint.path}`;
}

function aggregateEndpointRecordsByKey(records: NormalizedEndpointRecord[]): Map<string, NormalizedEndpointRecord> {
	const byKey = new Map<string, NormalizedEndpointRecord>();
	for (const record of records) {
		const key = endpointKey(record.endpoint);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, {
				...record,
				endpoint: {
					...record.endpoint,
					requestHeaders: mergeHeaderLists(record.endpoint.requestHeaders)
				}
			});
			continue;
		}

		existing.endpoint.requestHeaders = mergeHeaderLists(existing.endpoint.requestHeaders, record.endpoint.requestHeaders);
		if (!existing.endpoint.requestSchema && record.endpoint.requestSchema) {
			existing.endpoint.requestSchema = record.endpoint.requestSchema;
		}
		if (!existing.endpoint.responseSchema && record.endpoint.responseSchema) {
			existing.endpoint.responseSchema = record.endpoint.responseSchema;
		}
	}
	return byKey;
}

function mergeHeaderLists(...headers: Array<string[] | undefined>): string[] | undefined {
	const merged = new Map<string, string>();
	for (const header of headers.flatMap((item) => item ?? [])) {
		const value = header.trim();
		if (value) {
			merged.set(value.toLowerCase(), value);
		}
	}
	const values = Array.from(merged.values()).sort((a, b) => a.localeCompare(b));
	return values.length > 0 ? values : undefined;
}

function attachSchemaDiffLocations(
	diffs: SchemaDiff[] | undefined,
	frontendRecord: NormalizedEndpointRecord,
	backendRecord: NormalizedEndpointRecord
): SchemaDiff[] | undefined {
	if (!diffs) {
		return undefined;
	}
	return diffs.map((diff) => ({
		...diff,
		fields: diff.fields.map((field) => ({
			...field,
			fe: field.fe ? { ...field.fe, location: resolveFieldLocation(frontendRecord, diff.scope, field.fe.key) } : undefined,
			be: field.be ? { ...field.be, location: resolveFieldLocation(backendRecord, diff.scope, field.be.key) } : undefined
		}))
	}));
}

function resolveFieldLocation(
	record: NormalizedEndpointRecord,
	scope: SchemaDiff['scope'],
	field: string
): SourceRevealTarget {
	const exact = record.endpoint.fieldLocations?.find((location) => location.scope === scope && location.field === field);
	if (exact) {
		return enrichFieldLocation(record, exact);
	}
	const normalizedField = normalizeFieldKey(field);
	const normalized = record.endpoint.fieldLocations?.find((location) =>
		location.scope === scope && normalizeFieldKey(location.field) === normalizedField
	);
	if (normalized) {
		return enrichFieldLocation(record, normalized);
	}
	return {
		uri: record.uri.toString(),
		line: record.endpoint.sourceLine ?? 1,
		column: record.endpoint.sourceColumn ?? 1,
		method: record.endpoint.method,
		path: record.endpoint.path,
		side: record.sourceSide,
		highlightText: field.split('.').pop()?.replace(/\[]$/, '') ?? field
	};
}

function enrichFieldLocation(
	record: NormalizedEndpointRecord,
	location: SourceRevealTarget
): SourceRevealTarget {
	return {
		...location,
		uri: location.uri || record.uri.toString(),
		method: location.method ?? record.endpoint.method,
		path: location.path ?? record.endpoint.path,
		side: location.side ?? record.sourceSide
	};
}

function normalizeFieldKey(key: string): string {
	return key.replace(/[_\-\s]/g, '').toLowerCase();
}

function flattenEndpointRecords(files: ParsedContractFile[]): EndpointRecord[] {
	const records: EndpointRecord[] = [];
	for (const file of files) {
		for (const endpoint of file.endpoints) {
			records.push({ endpoint, uri: file.uri, text: file.text });
		}
	}
	return records;
}

function buildDiagnostic(
	fileText: string,
	endpoint: EndpointContract,
	message: string,
	severity: vscode.DiagnosticSeverity
): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(resolveEndpointRange(fileText, endpoint), message, severity);
	diagnostic.source = 'StaticVerifier';
	return diagnostic;
}

function getIssueSeverityPolicy(): Record<VerificationIssueKind, vscode.DiagnosticSeverity | undefined> {
	const config = vscode.workspace.getConfiguration('staticverifier');
	const policy = {} as Record<VerificationIssueKind, vscode.DiagnosticSeverity | undefined>;
	for (const [kind, setting] of Object.entries(ISSUE_SEVERITY_SETTINGS) as Array<[VerificationIssueKind, typeof ISSUE_SEVERITY_SETTINGS[VerificationIssueKind]]>) {
		const value = config.get<IssueSeveritySetting>(setting.key, setting.defaultValue);
		policy[kind] = severitySettingToDiagnostic(value);
	}
	return policy;
}

function severitySettingToDiagnostic(value: IssueSeveritySetting): vscode.DiagnosticSeverity | undefined {
	if (value === 'ignore') {
		return undefined;
	}
	if (value === 'info') {
		return vscode.DiagnosticSeverity.Information;
	}
	if (value === 'warning') {
		return vscode.DiagnosticSeverity.Warning;
	}
	return vscode.DiagnosticSeverity.Error;
}

function pushConfiguredDiagnosticAndIssue(
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	issues: VerificationIssue[],
	severityPolicy: Record<VerificationIssueKind, vscode.DiagnosticSeverity | undefined>,
	kind: VerificationIssueKind,
	uri: vscode.Uri,
	record: NormalizedEndpointRecord,
	message: string,
	schemaDiffs?: SchemaDiff[],
	headerDiffs?: string[]
): void {
	const severity = severityPolicy[kind];
	if (severity === undefined) {
		return;
	}
	pushDiagnosticAndIssue(
		diagnosticsByFile,
		issues,
		uri,
		buildDiagnostic(record.text, record.endpoint, message, severity),
		buildIssue(record, kind, severity, message, schemaDiffs, headerDiffs)
	);
}

function pushConfiguredDiagnostic(
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	severityPolicy: Record<VerificationIssueKind, vscode.DiagnosticSeverity | undefined>,
	kind: VerificationIssueKind,
	uri: vscode.Uri,
	record: NormalizedEndpointRecord,
	message: string
): void {
	const severity = severityPolicy[kind];
	if (severity === undefined) {
		return;
	}
	pushDiagnostic(diagnosticsByFile, uri, buildDiagnostic(record.text, record.endpoint, message, severity));
}

function pushDiagnosticAndIssue(
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	issues: VerificationIssue[],
	uri: vscode.Uri,
	diagnostic: vscode.Diagnostic,
	issue: VerificationIssue
): void {
	issues.push(issue);
	pushDiagnostic(diagnosticsByFile, uri, diagnostic);
}

function pushDiagnostic(
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	uri: vscode.Uri,
	diagnostic: vscode.Diagnostic
): void {
	const key = uri.toString();
	const list = diagnosticsByFile.get(key);
	if (list) {
		list.push(diagnostic);
		return;
	}
	diagnosticsByFile.set(key, [diagnostic]);
}

function resolveEndpointRange(text: string, endpoint: EndpointContract): vscode.Range {
	if (typeof endpoint.sourceLine === 'number' && typeof endpoint.sourceColumn === 'number') {
		const line = Math.max(0, endpoint.sourceLine - 1);
		const column = Math.max(0, endpoint.sourceColumn - 1);
		const length = Math.max(1, endpoint.path.length);
		return new vscode.Range(line, column, line, column + length);
	}

	return findEndpointRange(text, endpoint);
}

function findEndpointRange(text: string, endpoint: EndpointContract): vscode.Range {
	const lines = text.split(/\r?\n/);
	const pathToken = endpoint.path;
	for (let index = 0; index < lines.length; index += 1) {
		const pathStart = lines[index].indexOf(pathToken);
		if (pathStart === -1) {
			continue;
		}
		const nearbyText = lines
			.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
			.join('\n');
		if (!nearbyText.toUpperCase().includes(endpoint.method.toUpperCase()) && endpoint.method.toUpperCase() !== 'GET') {
			continue;
		}
		return new vscode.Range(index, pathStart, index, pathStart + pathToken.length);
	}
	return new vscode.Range(0, 0, 0, 1);
}

function normalizeEndpointRecords(
	records: EndpointRecord[],
	sourceSide: 'frontend' | 'backend'
): { valid: NormalizedEndpointRecord[]; invalid: Array<{ record: EndpointRecord; reason: string }> } {
	const valid: NormalizedEndpointRecord[] = [];
	const invalid: Array<{ record: EndpointRecord; reason: string }> = [];

	for (const record of records) {
		const method = normalizeEndpointMethod(record.endpoint.method);
		if (!method) {
			invalid.push({
				record,
				reason: `Invalid HTTP method "${record.endpoint.method}" for endpoint path "${record.endpoint.path}".`
			});
			continue;
		}

		const normalized = normalizeEndpoint(record.endpoint);
		if (!normalized) {
			invalid.push({
				record,
				reason: `Invalid endpoint path "${record.endpoint.path}" for method ${method}.`
			});
			continue;
		}

		valid.push({
			...record,
			sourceSide,
			normalizedMethod: normalized.method,
			normalizedPath: normalized.path,
			endpoint: {
				...record.endpoint,
				method: normalized.method,
				path: normalized.path
			}
		});
	}

	return { valid, invalid };
}

function collectInvalidEndpointIssues(
	invalidRecords: Array<{ record: EndpointRecord; reason: string }>,
	sourceSide: 'frontend' | 'backend',
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	issues: VerificationIssue[],
	severityPolicy: Record<VerificationIssueKind, vscode.DiagnosticSeverity | undefined>
): void {
	for (const { record, reason } of invalidRecords) {
		pushConfiguredDiagnosticAndIssue(
			diagnosticsByFile,
			issues,
			severityPolicy,
			'invalid-endpoint',
			record.uri,
			{ ...record, normalizedMethod: record.endpoint.method, normalizedPath: record.endpoint.path, sourceSide },
			reason
		);
	}
}

function collectDuplicateEndpointIssues(
	records: NormalizedEndpointRecord[],
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	issues: VerificationIssue[],
	severityPolicy: Record<VerificationIssueKind, vscode.DiagnosticSeverity | undefined>
): void {
	const buckets = new Map<string, NormalizedEndpointRecord[]>();
	for (const record of records) {
		const key = endpointKey(record.endpoint);
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.push(record);
		} else {
			buckets.set(key, [record]);
		}
	}

	for (const [key, bucket] of buckets) {
		if (bucket.length < 2) {
			continue;
		}
		for (const record of bucket) {
			const message = `Duplicate endpoint declaration for ${key}.`;
			pushConfiguredDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				severityPolicy,
				'duplicate-endpoint',
				record.uri,
				record,
				message
			);
		}
	}
}

function buildIssue(
	record: NormalizedEndpointRecord,
	kind: VerificationIssueKind,
	severity: vscode.DiagnosticSeverity,
	message: string,
	schemaDiffs?: SchemaDiff[],
	headerDiffs?: string[]
): VerificationIssue {
	const file = record.uri.scheme === 'file'
		? (vscode.workspace.asRelativePath(record.uri, false) || record.uri.fsPath)
		: record.uri.toString();
	return {
		uri: record.uri.toString(),
		file,
		line: record.endpoint.sourceLine ?? 1,
		column: record.endpoint.sourceColumn ?? 1,
		severity: getSeverityLabel(severity),
		message,
		kind,
		sourceSide: record.sourceSide,
		method: record.endpoint.method,
		path: record.endpoint.path,
		headerDiffs,
		schemaDiffs
	};
}

function getSeverityLabel(severity: vscode.DiagnosticSeverity): 'error' | 'warning' | 'info' {
	if (severity === vscode.DiagnosticSeverity.Error) {
		return 'error';
	}
	if (severity === vscode.DiagnosticSeverity.Warning) {
		return 'warning';
	}
	return 'info';
}

