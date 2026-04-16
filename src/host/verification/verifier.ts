import * as vscode from 'vscode';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import type {
	EndpointContract,
	EndpointRecord,
	ParsedContractFile,
	VerificationSummary
} from '../contracts/internalTypes';

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

	const emptySummary: VerificationSummary = {
		matchedEndpoints: 0,
		missingBackend: 0,
		requestMismatches: 0,
		responseMismatches: 0,
		backendOnly: 0,
		totalIssues: 0,
		comparedFrontend: 0
	};

	if (frontendFiles.length === 0 || backendFiles.length === 0) {
		if (showNotifications) {
			vscode.window.showWarningMessage(
				'StaticVerifier could not load FE/BE contract sources. Check local paths or GitHub links in the StaticVerifier panel.'
			);
		}
		return emptySummary;
	}

	const frontendRecords = flattenEndpointRecords(frontendFiles);
	const backendRecords = flattenEndpointRecords(backendFiles);
	const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
	const backendByKey = new Map<string, EndpointRecord>();
	let matchedEndpoints = 0;
	let missingBackend = 0;
	let requestMismatches = 0;
	let responseMismatches = 0;
	let backendOnly = 0;

	for (const record of backendRecords) {
		const key = endpointKey(record.endpoint);
		if (!backendByKey.has(key)) {
			backendByKey.set(key, record);
		}
	}

	for (const record of frontendRecords) {
		const key = endpointKey(record.endpoint);
		const backendRecord = backendByKey.get(key);
		if (!backendRecord) {
			missingBackend += 1;
			pushDiagnostic(
				diagnosticsByFile,
				record.uri,
				buildDiagnostic(
					record.text,
					record.endpoint,
					`Missing backend endpoint for ${key}.`,
					vscode.DiagnosticSeverity.Error
				)
			);
			continue;
		}

		let hasMismatch = false;
		if ((record.endpoint.requestSchema ?? '') !== (backendRecord.endpoint.requestSchema ?? '')) {
			requestMismatches += 1;
			hasMismatch = true;
			pushDiagnostic(
				diagnosticsByFile,
				record.uri,
				buildDiagnostic(
					record.text,
					record.endpoint,
					`Request schema mismatch for ${key}: FE="${record.endpoint.requestSchema ?? '-'}", BE="${backendRecord.endpoint.requestSchema ?? '-'}".`,
					vscode.DiagnosticSeverity.Error
				)
			);
		}

		if ((record.endpoint.responseSchema ?? '') !== (backendRecord.endpoint.responseSchema ?? '')) {
			responseMismatches += 1;
			hasMismatch = true;
			pushDiagnostic(
				diagnosticsByFile,
				record.uri,
				buildDiagnostic(
					record.text,
					record.endpoint,
					`Response schema mismatch for ${key}: FE="${record.endpoint.responseSchema ?? '-'}", BE="${backendRecord.endpoint.responseSchema ?? '-'}".`,
					vscode.DiagnosticSeverity.Error
				)
			);
		}

		if (!hasMismatch) {
			matchedEndpoints += 1;
		}
	}

	const frontendKeySet = new Set(frontendRecords.map((record) => endpointKey(record.endpoint)));
	for (const record of backendRecords) {
		const key = endpointKey(record.endpoint);
		if (frontendKeySet.has(key)) {
			continue;
		}
		backendOnly += 1;
		pushDiagnostic(
			diagnosticsByFile,
			record.uri,
			buildDiagnostic(
				record.text,
				record.endpoint,
				`Backend endpoint ${key} is not declared in frontend contract.`,
				vscode.DiagnosticSeverity.Warning
			)
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
		comparedFrontend: frontendRecords.length
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
	return new vscode.Diagnostic(findEndpointRange(fileText, endpoint), message, severity);
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
		if (!nearbyText.includes(endpoint.method) && endpoint.method !== 'GET') {
			continue;
		}
		return new vscode.Range(index, pathStart, index, pathStart + pathToken.length);
	}
	return new vscode.Range(0, 0, 0, 1);
}
