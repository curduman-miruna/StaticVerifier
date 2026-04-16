import * as vscode from 'vscode';
import type { ContractSide } from '../../shared/contracts';
import { getContractInputFromConfig, getEntryValues } from '../config/contractsConfig';
import { buildVirtualContractUri } from './buildVirtualContractUri';
import { parseContractText } from './contractParser';
import { normalizeGitHubRawUrl } from './githubSource';
import { findLocalMatches } from './localSource';
import type { ParsedContractFile } from './internalTypes';

export async function loadConfiguredContracts(
	side: ContractSide,
	collection: vscode.DiagnosticCollection
): Promise<ParsedContractFile[]> {
	const config = vscode.workspace.getConfiguration('staticverifier');
	const input = getContractInputFromConfig(config, side);
	const [localContracts, githubContracts] = await Promise.all([
		loadLocalContracts(side, getEntryValues(input, 'local'), collection),
		loadGithubContracts(side, getEntryValues(input, 'github'), collection)
	]);
	return [...localContracts, ...githubContracts];
}

async function loadLocalContracts(
	side: ContractSide,
	globs: string[],
	collection: vscode.DiagnosticCollection
): Promise<ParsedContractFile[]> {
	const files: ParsedContractFile[] = [];
	const uniqueUris = new Set<string>();
	if (globs.length === 0) {
		return files;
	}

	for (const glob of globs) {
		const matches = await findLocalMatches(glob);
		if (matches.length === 0) {
			const virtualUri = buildVirtualContractUri(side, 'local');
			const existing = collection.get(virtualUri) ?? [];
			collection.set(virtualUri, [
				...existing,
				new vscode.Diagnostic(
					new vscode.Range(0, 0, 0, 1),
					`No local contract file matched: ${glob}`,
					vscode.DiagnosticSeverity.Warning
				)
			]);
			continue;
		}

		for (const uri of matches) {
			const key = uri.toString();
			if (uniqueUris.has(key)) {
				continue;
			}
			uniqueUris.add(key);

			let text = '';
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				text = Buffer.from(bytes).toString('utf8');
			} catch {
				collection.set(uri, [
					new vscode.Diagnostic(
						new vscode.Range(0, 0, 0, 1),
						`StaticVerifier could not read ${side.toUpperCase()} local contract file.`,
						vscode.DiagnosticSeverity.Error
					)
				]);
				continue;
			}

			const parsed = parseContractText(text, uri, side, collection);
			if (parsed) {
				files.push(parsed);
			}
		}
	}

	return files;
}

async function loadGithubContracts(
	side: ContractSide,
	urls: string[],
	collection: vscode.DiagnosticCollection
): Promise<ParsedContractFile[]> {
	const files: ParsedContractFile[] = [];
	for (let index = 0; index < urls.length; index += 1) {
		const url = urls[index];
		const normalizedUrl = normalizeGitHubRawUrl(url);
		const virtualUri = buildVirtualContractUri(side, 'github', index);

		let response: Response;
		try {
			response = await fetch(normalizedUrl);
		} catch {
			collection.set(virtualUri, [
				new vscode.Diagnostic(
					new vscode.Range(0, 0, 0, 1),
					`StaticVerifier could not fetch ${side.toUpperCase()} GitHub URL: ${url}`,
					vscode.DiagnosticSeverity.Error
				)
			]);
			continue;
		}
		if (!response.ok) {
			collection.set(virtualUri, [
				new vscode.Diagnostic(
					new vscode.Range(0, 0, 0, 1),
					`${side.toUpperCase()} GitHub request failed (${response.status}) for ${url}.`,
					vscode.DiagnosticSeverity.Error
				)
			]);
			continue;
		}

		const text = await response.text();
		const parsed = parseContractText(text, virtualUri, side, collection);
		if (parsed) {
			files.push(parsed);
		}
	}
	return files;
}
