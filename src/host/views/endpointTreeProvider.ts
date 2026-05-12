import * as vscode from 'vscode';
import { loadEndpointIndex, type IndexedEndpoint } from '../navigation/endpointIndex';

type TreeNode =
	| { kind: 'group'; label: string; endpoints: IndexedEndpoint[] }
	| { kind: 'endpoint'; endpoint: IndexedEndpoint };

export class EndpointTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	dispose(): void {
		this.onDidChangeTreeDataEmitter.dispose();
	}

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (element?.kind === 'group') {
			return element.endpoints
				.sort((a, b) => a.key.localeCompare(b.key) || a.side.localeCompare(b.side))
				.map((endpoint) => ({ kind: 'endpoint', endpoint }));
		}
		if (element) {
			return [];
		}

		const endpoints = await loadEndpointIndex();
		const groups = groupEndpoints(endpoints);
		return [
			{ kind: 'group', label: `Matched (${groups.matched.length})`, endpoints: groups.matched },
			{ kind: 'group', label: `FE only (${groups.frontendOnly.length})`, endpoints: groups.frontendOnly },
			{ kind: 'group', label: `BE only (${groups.backendOnly.length})`, endpoints: groups.backendOnly },
			{ kind: 'group', label: `All (${endpoints.length})`, endpoints }
		];
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		if (element.kind === 'group') {
			const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.contextValue = 'staticverifierEndpointGroup';
			return item;
		}

		const endpoint = element.endpoint;
		const item = new vscode.TreeItem(
			`${endpoint.side === 'frontend' ? 'FE' : 'BE'} ${endpoint.method} ${endpoint.path}`,
			vscode.TreeItemCollapsibleState.None
		);
		item.description = endpoint.source;
		item.tooltip = [
			`${endpoint.side.toUpperCase()} ${endpoint.method} ${endpoint.path}`,
			`Request: ${endpoint.endpoint.requestSchema ?? '-'}`,
			`Response: ${endpoint.endpoint.responseSchema ?? '-'}`,
			`Headers: ${(endpoint.endpoint.requestHeaders ?? []).join(', ') || '-'}`
		].join('\n');
		item.command = {
			title: 'Open Endpoint',
			command: 'staticverifier.revealEndpointTarget',
			arguments: [{
				uri: endpoint.file.uri.toString(),
				line: endpoint.endpoint.sourceLine ?? 1,
				column: endpoint.endpoint.sourceColumn ?? 1,
				method: endpoint.method,
				path: endpoint.path,
				side: endpoint.side,
				highlightText: endpoint.endpoint.path
			}]
		};
		return item;
	}
}

function groupEndpoints(endpoints: IndexedEndpoint[]): {
	matched: IndexedEndpoint[];
	frontendOnly: IndexedEndpoint[];
	backendOnly: IndexedEndpoint[];
} {
	const sidesByKey = new Map<string, Set<string>>();
	for (const endpoint of endpoints) {
		const sides = sidesByKey.get(endpoint.key) ?? new Set<string>();
		sides.add(endpoint.side);
		sidesByKey.set(endpoint.key, sides);
	}
	return {
		matched: endpoints.filter((endpoint) => sidesByKey.get(endpoint.key)?.size === 2),
		frontendOnly: endpoints.filter((endpoint) => endpoint.side === 'frontend' && sidesByKey.get(endpoint.key)?.size === 1),
		backendOnly: endpoints.filter((endpoint) => endpoint.side === 'backend' && sidesByKey.get(endpoint.key)?.size === 1)
	};
}
