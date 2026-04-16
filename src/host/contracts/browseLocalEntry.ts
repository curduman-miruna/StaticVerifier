import * as vscode from 'vscode';

export async function browseLocalEntry(): Promise<{ value?: string; error?: string }> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Select Folder'
	});
	if (!picked || picked.length === 0) {
		return {};
	}
	const selectedUri = picked[0];
	const normalizedPath = selectedUri.fsPath.replace(/\\/g, '/');
	return { value: normalizedPath };
}
