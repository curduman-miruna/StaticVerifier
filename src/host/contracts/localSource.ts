import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { countFilesystemFiles, findFilesystemFiles } from '../utils/filesystem';

export type FindLocalMatchOptions = {
	allowedExtensions?: string[];
};

export async function findLocalMatches(
	rawInput: string,
	options?: FindLocalMatchOptions
): Promise<vscode.Uri[]> {
	const input = rawInput.trim();
	if (!input) {
		return [];
	}

	const allowedExtensions = normalizeAllowedExtensions(options?.allowedExtensions);
	const uriMap = new Map<string, vscode.Uri>();
	const hasGlobSyntax = /[*?[\]{}]/.test(input);

	if (path.isAbsolute(input)) {
		for (const uri of await findAllowedInFilesystemPath(input, 200, allowedExtensions)) {
			uriMap.set(uri.toString(), uri);
		}
		return Array.from(uriMap.values());
	}

	if (hasGlobSyntax) {
		for (const uri of await vscode.workspace.findFiles(input, '**/node_modules/**', 200)) {
			if (isAllowedExtension(uri, allowedExtensions)) {
				uriMap.set(uri.toString(), uri);
			}
		}
		return Array.from(uriMap.values());
	}

	for (const candidate of [input, ...allowedExtensions.map((ext) => `${input}/**/*${ext}`)]) {
		for (const uri of await vscode.workspace.findFiles(candidate, '**/node_modules/**', 200)) {
			if (isAllowedExtension(uri, allowedExtensions)) {
				uriMap.set(uri.toString(), uri);
			}
		}
	}

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const resolved = path.resolve(folder.uri.fsPath, input);
		for (const uri of await findAllowedInFilesystemPath(resolved, 200, allowedExtensions)) {
			uriMap.set(uri.toString(), uri);
		}
	}

	return Array.from(uriMap.values());
}

export async function localEntryExists(rawInput: string): Promise<boolean> {
	const input = rawInput.trim();
	if (!input) {
		return false;
	}

	if (path.isAbsolute(input)) {
		try {
			await fs.stat(input);
			return true;
		} catch {
			return false;
		}
	}

	const hasGlobSyntax = /[*?[\]{}]/.test(input);
	if (hasGlobSyntax) {
		return (await vscode.workspace.findFiles(input, '**/node_modules/**', 1)).length > 0;
	}

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const resolved = path.resolve(folder.uri.fsPath, input);
		try {
			await fs.stat(resolved);
			return true;
		} catch {
			// no-op
		}
	}

	return (await vscode.workspace.findFiles(input, '**/node_modules/**', 1)).length > 0;
}

export async function countLocalFiles(rawInput: string): Promise<number> {
	const input = rawInput.trim();
	if (!input) {
		return 0;
	}
	if (path.isAbsolute(input)) {
		return countFilesystemFiles(input, 200000);
	}

	const hasGlobSyntax = /[*?[\]{}]/.test(input);
	if (hasGlobSyntax) {
		return (await vscode.workspace.findFiles(input, '**/node_modules/**', 200000)).length;
	}

	const workspaceMatches = await vscode.workspace.findFiles(input, '**/node_modules/**', 200000);
	if (workspaceMatches.length > 0) {
		return workspaceMatches.length;
	}

	let total = 0;
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		total += await countFilesystemFiles(path.resolve(folder.uri.fsPath, input), 200000);
	}
	return total;
}

async function findAllowedInFilesystemPath(
	targetPath: string,
	limit: number,
	allowedExtensions: string[]
): Promise<vscode.Uri[]> {
	const paths = await findFilesystemFiles(
		targetPath,
		limit,
		(filePath) => isAllowedPath(filePath, allowedExtensions)
	);
	return paths.map((filePath) => vscode.Uri.file(filePath));
}

function normalizeAllowedExtensions(allowedExtensions: string[] | undefined): string[] {
	if (!allowedExtensions || allowedExtensions.length === 0) {
		return ['.json'];
	}
	const normalized = allowedExtensions
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => ext.length > 0)
		.map((ext) => ext.startsWith('.') ? ext : `.${ext}`);
	return normalized.length > 0 ? normalized : ['.json'];
}

function isAllowedPath(filePath: string, allowedExtensions: string[]): boolean {
	const lower = filePath.toLowerCase();
	return allowedExtensions.some((ext) => lower.endsWith(ext));
}

function isAllowedExtension(uri: vscode.Uri, allowedExtensions: string[]): boolean {
	if (uri.scheme !== 'file') {
		return false;
	}
	return isAllowedPath(uri.fsPath, allowedExtensions);
}
