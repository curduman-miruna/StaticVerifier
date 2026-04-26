import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ContractSide } from '../../shared/contracts';
import { getContractInputFromConfig, getEntryValues, getFrontendDiscoveryOptions } from '../config/contractsConfig';
import { buildVirtualContractUri } from './buildVirtualContractUri';
import { parseContractText } from './contractParser';
import type { FrontendDiscoveryOptions } from './frontendApiExtractor';
import { isSupportedGitHubContractUrl, normalizeGitHubRawUrl } from './githubSource';
import { findLocalMatches } from './localSource';
import type { ParsedContractFile } from './internalTypes';

const FRONTEND_DISCOVERY_ALLOWED_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json'
]);
const FRONTEND_DISCOVERY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const BACKEND_DISCOVERY_ALLOWED_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.py',
	'.java',
	'.kt',
	'.cs',
	'.json'
]);
const BACKEND_DISCOVERY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.cs', '.json'];

const FRONTEND_DISCOVERY_EXCLUDED_SEGMENTS = [
	`${path.sep}node_modules${path.sep}`,
	`${path.sep}dist${path.sep}`,
	`${path.sep}build${path.sep}`,
	`${path.sep}out${path.sep}`,
	`${path.sep}coverage${path.sep}`,
	`${path.sep}.next${path.sep}`,
	`${path.sep}.nuxt${path.sep}`,
	`${path.sep}.svelte-kit${path.sep}`
];
const BACKEND_DISCOVERY_EXCLUDED_SEGMENTS = FRONTEND_DISCOVERY_EXCLUDED_SEGMENTS;

export async function loadConfiguredContracts(
	side: ContractSide,
	collection: vscode.DiagnosticCollection
): Promise<ParsedContractFile[]> {
	const config = vscode.workspace.getConfiguration('staticverifier');
	const input = getContractInputFromConfig(config, side);
	const frontendDiscovery = side === 'frontend' ? getFrontendDiscoveryOptions(config) : undefined;
	const [localContracts, githubContracts] = await Promise.all([
		loadLocalContracts(side, getEntryValues(input, 'local'), collection, frontendDiscovery),
		loadGithubContracts(side, getEntryValues(input, 'github'), collection, frontendDiscovery)
	]);
	return [...localContracts, ...githubContracts];
}

async function loadLocalContracts(
	side: ContractSide,
	globs: string[],
	collection: vscode.DiagnosticCollection,
	frontendDiscovery?: FrontendDiscoveryOptions
): Promise<ParsedContractFile[]> {
	const files: ParsedContractFile[] = [];
	const uniqueUris = new Set<string>();
	if (globs.length === 0) {
		return files;
	}

	for (const glob of globs) {
		const matches = await findLocalMatches(glob, {
			allowedExtensions: side === 'frontend' ? FRONTEND_DISCOVERY_EXTENSIONS : BACKEND_DISCOVERY_EXTENSIONS
		});
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
			if (shouldSkipDiscoveryUri(side, uri)) {
				continue;
			}

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

			const parsed = parseContractText(text, uri, side, collection, frontendDiscovery);
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
	collection: vscode.DiagnosticCollection,
	frontendDiscovery?: FrontendDiscoveryOptions
): Promise<ParsedContractFile[]> {
	const files: ParsedContractFile[] = [];
	for (let index = 0; index < urls.length; index += 1) {
		const url = urls[index];
		if (!isSupportedGitHubContractUrl(url)) {
			const virtualUri = buildVirtualContractUri(side, 'github', index);
			collection.set(virtualUri, [
				new vscode.Diagnostic(
					new vscode.Range(0, 0, 0, 1),
					`Unsupported ${side.toUpperCase()} GitHub URL: ${url}. Use a file URL (github.com/.../blob/... or raw.githubusercontent.com/...).`,
					vscode.DiagnosticSeverity.Error
				)
			]);
			continue;
		}
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
		const parsed = parseContractText(text, virtualUri, side, collection, frontendDiscovery);
		if (parsed) {
			files.push(parsed);
		}
	}
	return files;
}

function shouldSkipDiscoveryUri(side: ContractSide, uri: vscode.Uri): boolean {
	if (uri.scheme !== 'file') {
		return false;
	}

	const filePath = uri.fsPath;
	const lowerPath = filePath.toLowerCase();
	const excludedSegments = side === 'frontend' ? FRONTEND_DISCOVERY_EXCLUDED_SEGMENTS : BACKEND_DISCOVERY_EXCLUDED_SEGMENTS;
	for (const segment of excludedSegments) {
		if (lowerPath.includes(segment.toLowerCase())) {
			return true;
		}
	}

	if (lowerPath.endsWith('.d.ts') || lowerPath.endsWith('.map') || lowerPath.endsWith('.min.js')) {
		return true;
	}

	const extension = path.extname(lowerPath);
	const allowedExtensions = side === 'frontend' ? FRONTEND_DISCOVERY_ALLOWED_EXTENSIONS : BACKEND_DISCOVERY_ALLOWED_EXTENSIONS;
	return !allowedExtensions.has(extension);
}
