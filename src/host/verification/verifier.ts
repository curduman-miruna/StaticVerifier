import * as vscode from 'vscode';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import type {
	EndpointContract,
	EndpointRecord,
	ParsedContractFile,
	VerificationSummary
} from '../contracts/internalTypes';
import type { SchemaDiff, VerificationIssue, VerificationIssueKind } from '../../shared/messages';
import { compareSchemaStrings } from './schemaCompare';

type NormalizedEndpointRecord = EndpointRecord & {
	normalizedMethod: string;
	normalizedPath: string;
	sourceSide: 'frontend' | 'backend';
};

const HTTP_METHOD_TOKEN = /^[A-Z][A-Z0-9_-]*$/;

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
	const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
	const issues: VerificationIssue[] = [];
	let matchedEndpoints = 0;
	let missingBackend = 0;
	let requestMismatches = 0;
	let responseMismatches = 0;
	let headerMismatches = 0;
	let backendOnly = 0;

	collectInvalidEndpointIssues(frontendRecords.invalid, 'frontend', diagnosticsByFile, issues);
	collectInvalidEndpointIssues(backendRecords.invalid, 'backend', diagnosticsByFile, issues);

	collectDuplicateEndpointIssues(frontendRecords.valid, diagnosticsByFile, issues);
	collectDuplicateEndpointIssues(backendRecords.valid, diagnosticsByFile, issues);

	for (const [key, record] of frontendByKey) {
		const backendRecord = backendByKey.get(key);
		if (!backendRecord) {
			missingBackend += 1;
			pushDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				record.uri,
				buildDiagnostic(
					record.text,
					record.endpoint,
					`Missing backend endpoint for ${key}.`,
					vscode.DiagnosticSeverity.Error
				),
				buildIssue(record, 'missing-backend', vscode.DiagnosticSeverity.Error, `Missing backend endpoint for ${key}.`)
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
			pushDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				record.uri,
				buildDiagnostic(record.text, record.endpoint, message, vscode.DiagnosticSeverity.Error),
				buildIssue(
					record,
					'request-schema-mismatch',
					vscode.DiagnosticSeverity.Error,
					message,
					requestComparison.schemaDiffs
				)
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
			pushDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				record.uri,
				buildDiagnostic(record.text, record.endpoint, message, vscode.DiagnosticSeverity.Error),
				buildIssue(
					record,
					'response-schema-mismatch',
					vscode.DiagnosticSeverity.Error,
					message,
					responseComparison.schemaDiffs
				)
			);
		}

		const missingHeaders = findMissingHeaders(record.endpoint.requestHeaders, backendRecord.endpoint.requestHeaders);
		if (missingHeaders.length > 0) {
			headerMismatches += 1;
			hasMismatch = true;
			const message = `Header mismatch for ${key}: frontend does not send required backend header(s): ${missingHeaders.join(', ')}.`;
			pushDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				record.uri,
				buildDiagnostic(record.text, record.endpoint, message, vscode.DiagnosticSeverity.Error),
				buildIssue(
					record,
					'header-mismatch',
					vscode.DiagnosticSeverity.Error,
					message,
					undefined,
					missingHeaders
				)
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
		pushDiagnosticAndIssue(
			diagnosticsByFile,
			issues,
			record.uri,
			buildDiagnostic(record.text, record.endpoint, message, vscode.DiagnosticSeverity.Warning),
			buildIssue(record, 'backend-only', vscode.DiagnosticSeverity.Warning, message)
		);
	}

	let total = 0;
	for (const [uriString, fileDiagnostics] of diagnosticsByFile) {
		total += fileDiagnostics.length;
		collection.set(vscode.Uri.parse(uriString), fileDiagnostics);
	}

	if (showNotifications) {
		if (total === 0) {
			vscode.window.showInformationMessage('StaticVerifier: no contract mismatches found.');
		} else {
			vscode.window.showWarningMessage(
				`StaticVerifier found ${total} contract issue(s). Check the Problems panel.`
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
		totalIssues: total,
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

function findMissingHeaders(frontendHeaders: string[] | undefined, backendHeaders: string[] | undefined): string[] {
	const frontend = new Set((frontendHeaders ?? []).map(normalizeHeaderName));
	return (backendHeaders ?? [])
		.filter((header) => !frontend.has(normalizeHeaderName(header)))
		.sort((a, b) => a.localeCompare(b));
}

function normalizeHeaderName(header: string): string {
	return header.trim().toLowerCase();
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
		const method = record.endpoint.method.trim().toUpperCase();
		if (!HTTP_METHOD_TOKEN.test(method)) {
			invalid.push({
				record,
				reason: `Invalid HTTP method "${record.endpoint.method}" for endpoint path "${record.endpoint.path}".`
			});
			continue;
		}

		const path = normalizeEndpointPath(record.endpoint.path);
		if (!path) {
			invalid.push({
				record,
				reason: `Invalid endpoint path "${record.endpoint.path}" for method ${method}.`
			});
			continue;
		}

		valid.push({
			...record,
			sourceSide,
			normalizedMethod: method,
			normalizedPath: path,
			endpoint: {
				...record.endpoint,
				method,
				path
			}
		});
	}

	return { valid, invalid };
}

function normalizeEndpointPath(rawPath: string): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return undefined;
	}

	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		try {
			const parsed = new URL(trimmed);
			return normalizePathToken(parsed.pathname);
		} catch {
			return undefined;
		}
	}

	if (!trimmed.startsWith('/')) {
		return undefined;
	}

	return normalizePathToken(trimmed);
}

function normalizePathToken(path: string): string | undefined {
	const noQuery = path.split(/[?#]/)[0];
	const normalizedParams = noQuery
		.replace(/\/\{[^/}]+\}/g, '/{param}')
		.replace(/\/:[^/]+/g, '/{param}');
	const collapsed = normalizedParams.replace(/\/+/g, '/').trim();
	if (!collapsed.startsWith('/')) {
		return undefined;
	}
	if (collapsed.length > 1 && collapsed.endsWith('/')) {
		return collapsed.slice(0, -1);
	}
	return collapsed;
}

function collectInvalidEndpointIssues(
	invalidRecords: Array<{ record: EndpointRecord; reason: string }>,
	sourceSide: 'frontend' | 'backend',
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	issues: VerificationIssue[]
): void {
	for (const { record, reason } of invalidRecords) {
		pushDiagnosticAndIssue(
			diagnosticsByFile,
			issues,
			record.uri,
			buildDiagnostic(record.text, record.endpoint, reason, vscode.DiagnosticSeverity.Error),
			buildIssue(
				{ ...record, normalizedMethod: record.endpoint.method, normalizedPath: record.endpoint.path, sourceSide },
				'invalid-endpoint',
				vscode.DiagnosticSeverity.Error,
				reason
			)
		);
	}
}

function collectDuplicateEndpointIssues(
	records: NormalizedEndpointRecord[],
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
	issues: VerificationIssue[]
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
			pushDiagnosticAndIssue(
				diagnosticsByFile,
				issues,
				record.uri,
				buildDiagnostic(record.text, record.endpoint, message, vscode.DiagnosticSeverity.Warning),
				buildIssue(record, 'duplicate-endpoint', vscode.DiagnosticSeverity.Warning, message)
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

