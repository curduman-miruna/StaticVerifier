import * as vscode from 'vscode';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import type {
	EndpointContract,
	EndpointRecord,
	ParsedContractFile,
	VerificationSummary
} from '../contracts/internalTypes';
import type { SchemaDiff, SchemaFieldDiff, VerificationIssue, VerificationIssueKind } from '../../shared/messages';

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
	const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
	const issues: VerificationIssue[] = [];
	const backendByKey = new Map<string, NormalizedEndpointRecord>();
	let matchedEndpoints = 0;
	let missingBackend = 0;
	let requestMismatches = 0;
	let responseMismatches = 0;
	let backendOnly = 0;

	collectInvalidEndpointIssues(frontendRecords.invalid, 'frontend', diagnosticsByFile, issues);
	collectInvalidEndpointIssues(backendRecords.invalid, 'backend', diagnosticsByFile, issues);

	collectDuplicateEndpointIssues(frontendRecords.valid, diagnosticsByFile, issues);
	collectDuplicateEndpointIssues(backendRecords.valid, diagnosticsByFile, issues);

	for (const record of backendRecords.valid) {
		const key = endpointKey(record.endpoint);
		if (!backendByKey.has(key)) {
			backendByKey.set(key, record);
		}
	}

	for (const record of frontendRecords.valid) {
		const key = endpointKey(record.endpoint);
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
			const message = `Request schema mismatch for ${key}: FE="${record.endpoint.requestSchema ?? '-'}", BE="${backendRecord.endpoint.requestSchema ?? '-'}".`;
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
			const message = `Response schema mismatch for ${key}: FE="${record.endpoint.responseSchema ?? '-'}", BE="${backendRecord.endpoint.responseSchema ?? '-'}".`;
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

		if (!hasMismatch) {
			matchedEndpoints += 1;
		}
	}

	const frontendKeySet = new Set(frontendRecords.valid.map((record) => endpointKey(record.endpoint)));
	for (const record of backendRecords.valid) {
		const key = endpointKey(record.endpoint);
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
		backendOnly,
		totalIssues: total,
		comparedFrontend: frontendRecords.valid.length,
		issues
	};
}

function endpointKey(endpoint: EndpointContract): string {
	return `${endpoint.method.toUpperCase()} ${endpoint.path}`;
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
	const collapsed = noQuery.replace(/\/+/g, '/').trim();
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
	schemaDiffs?: SchemaDiff[]
): VerificationIssue {
	const file = record.uri.scheme === 'file'
		? (vscode.workspace.asRelativePath(record.uri, false) || record.uri.fsPath)
		: record.uri.toString();
	return {
		file,
		line: record.endpoint.sourceLine ?? 1,
		column: record.endpoint.sourceColumn ?? 1,
		severity: getSeverityLabel(severity),
		message,
		kind,
		sourceSide: record.sourceSide,
		method: record.endpoint.method,
		path: record.endpoint.path,
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

function compareSchemaStrings(
	frontendSchema: string | undefined,
	backendSchema: string | undefined,
	scope: 'request' | 'response'
): { equal: boolean; schemaDiffs?: SchemaDiff[] } {
	const fe = (frontendSchema ?? '').trim();
	const be = (backendSchema ?? '').trim();
	if (fe === be) {
		return { equal: true };
	}

	const feJson = tryParseSchemaJson(fe);
	const beJson = tryParseSchemaJson(be);
	if (!feJson || !beJson || feJson.kind !== 'object' || beJson.kind !== 'object') {
		return { equal: false };
	}

	const fields = buildObjectFieldDiffs(feJson.value, beJson.value);
	const hasRealDifference = fields.some((item) => item.status !== 'match');
	if (!hasRealDifference) {
		return { equal: true };
	}

	return {
		equal: false,
		schemaDiffs: [{
			scope,
			feLabel: frontendSchema,
			beLabel: backendSchema,
			fields
		}]
	};
}

function tryParseSchemaJson(schema: string): { kind: 'object' | 'array' | 'primitive'; value: unknown } | undefined {
	if (!schema || (!schema.startsWith('{') && !schema.startsWith('['))) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(schema) as unknown;
		if (Array.isArray(parsed)) {
			return { kind: 'array', value: parsed };
		}
		if (typeof parsed === 'object' && parsed !== null) {
			return { kind: 'object', value: parsed };
		}
		return { kind: 'primitive', value: parsed };
	} catch {
		return undefined;
	}
}

function buildObjectFieldDiffs(frontend: unknown, backend: unknown): SchemaFieldDiff[] {
	const feObj = asObject(frontend);
	const beObj = asObject(backend);
	if (!feObj || !beObj) {
		return [];
	}

	const keys = Array.from(new Set([...Object.keys(feObj), ...Object.keys(beObj)])).sort((a, b) => a.localeCompare(b));
	return keys.map((key, index) => {
		const feHas = Object.prototype.hasOwnProperty.call(feObj, key);
		const beHas = Object.prototype.hasOwnProperty.call(beObj, key);
		const feValue = feHas ? feObj[key] : undefined;
		const beValue = beHas ? beObj[key] : undefined;

		if (feHas && !beHas) {
			return {
				id: `${index}:${key}`,
				status: 'fe-only',
				fe: { key, type: inferJsonType(feValue), required: true }
			};
		}
		if (!feHas && beHas) {
			return {
				id: `${index}:${key}`,
				status: 'be-only',
				be: { key, type: inferJsonType(beValue), required: true }
			};
		}

		const feType = inferJsonType(feValue);
		const beType = inferJsonType(beValue);
		return {
			id: `${index}:${key}`,
			status: feType === beType ? 'match' : 'type-changed',
			fe: { key, type: feType, required: true },
			be: { key, type: beType, required: true }
		};
	});
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function inferJsonType(value: unknown): string {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return 'array<unknown>';
		}
		return `array<${inferJsonType(value[0])}>`;
	}
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'object') {
		return 'object';
	}
	return typeof value;
}
