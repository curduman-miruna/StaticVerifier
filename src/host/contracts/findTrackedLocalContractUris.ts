import * as vscode from 'vscode';
import { getContractInputFromConfig, getEntryValues } from '../config/contractsConfig';
import { findLocalMatches } from './localSource';

export async function findTrackedLocalContractUris(): Promise<vscode.Uri[]> {
	const config = vscode.workspace.getConfiguration('staticverifier');
	const frontend = getContractInputFromConfig(config, 'frontend');
	const backend = getContractInputFromConfig(config, 'backend');
	const uriMap = new Map<string, vscode.Uri>();

	for (const sideInput of [frontend, backend]) {
		for (const localValue of getEntryValues(sideInput, 'local')) {
			const matches = await findLocalMatches(localValue);
			for (const uri of matches) {
				uriMap.set(uri.toString(), uri);
			}
		}
	}

	return Array.from(uriMap.values());
}
