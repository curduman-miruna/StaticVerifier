import * as vscode from 'vscode';
import type { ContractSide } from '../../shared/contracts';
import { loadConfiguredContracts } from '../contracts/loadContracts';
import type { EndpointContract, ParsedContractFile } from '../contracts/internalTypes';
import { createSilentDiagnostics } from '../contracts/silentDiagnostics';
import { normalizeEndpoint } from '../verification/endpointNormalization';

export type IndexedEndpoint = {
	side: ContractSide;
	file: ParsedContractFile;
	endpoint: EndpointContract;
	method: string;
	path: string;
	key: string;
	source: string;
};

export async function loadEndpointIndex(): Promise<IndexedEndpoint[]> {
	const diagnostics = createSilentDiagnostics('staticverifier-endpoint-index-silent');
	const [frontendFiles, backendFiles] = await Promise.all([
		loadConfiguredContracts('frontend', diagnostics),
		loadConfiguredContracts('backend', diagnostics)
	]);
	return [
		...indexFiles('frontend', frontendFiles),
		...indexFiles('backend', backendFiles)
	];
}

function indexFiles(side: ContractSide, files: ParsedContractFile[]): IndexedEndpoint[] {
	const endpoints: IndexedEndpoint[] = [];
	for (const file of files) {
		for (const endpoint of file.endpoints) {
			const normalized = normalizeEndpoint(endpoint);
			if (!normalized) {
				continue;
			}
			endpoints.push({
				side,
				file,
				endpoint,
				method: normalized.method,
				path: normalized.path,
				key: `${normalized.method} ${normalized.path}`,
				source: file.uri.scheme === 'file'
					? (vscode.workspace.asRelativePath(file.uri, false) || file.uri.fsPath)
					: file.uri.toString()
			});
		}
	}
	return endpoints;
}
