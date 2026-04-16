import * as vscode from 'vscode';
import type {
	ContractInput,
	ContractSide,
	ContractSourceEntry,
	ContractSourceType
} from '../../shared/contracts';

type ContractSettingKeys = {
	sources: 'frontendSources' | 'backendSources';
	source: 'frontendContractSource' | 'backendContractSource';
	paths: 'frontendContractPaths' | 'backendContractPaths';
	github: 'frontendContractGitHubUrls' | 'backendContractGitHubUrls';
	legacyPath: 'frontendContractPath' | 'backendContractPath';
	legacyGithub: 'frontendContractGitHubUrl' | 'backendContractGitHubUrl';
	defaultPath: string;
};

export function getContractInputFromConfig(
	config: vscode.WorkspaceConfiguration,
	side: ContractSide
): ContractInput {
	const keys = getContractSettingKeys(side);

	const configuredEntries = (config.get<ContractSourceEntry[]>(keys.sources, []) ?? [])
		.filter(
			(entry): entry is ContractSourceEntry =>
				Boolean(entry && (entry.type === 'local' || entry.type === 'github'))
				&& typeof entry.value === 'string'
		)
		.map((entry) => ({ type: entry.type, value: entry.value.trim() }))
		.filter((entry) => entry.value.length > 0);
	if (configuredEntries.length > 0) {
		return { entries: configuredEntries };
	}

	const configuredPaths = (config.get<string[]>(keys.paths, []) ?? [])
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	const legacyPath = config.get<string>(keys.legacyPath, keys.defaultPath).trim();
	const localPaths = configuredPaths.length > 0 ? configuredPaths : (legacyPath ? [legacyPath] : []);
	const configuredGithubUrls = (config.get<string[]>(keys.github, []) ?? [])
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	const legacyGithubUrl = config.get<string>(keys.legacyGithub, '').trim();
	const githubUrls = configuredGithubUrls.length > 0 ? configuredGithubUrls : (legacyGithubUrl ? [legacyGithubUrl] : []);

	const entries: ContractSourceEntry[] = [];
	const sourceType: ContractSourceType = config.get<string>(keys.source, 'local') === 'github' ? 'github' : 'local';
	const primaryLocal = localPaths.length > 0 ? localPaths : [keys.defaultPath];

	if (sourceType === 'local') {
		entries.push(...primaryLocal.map((value) => ({ type: 'local' as const, value })));
		entries.push(...githubUrls.map((value) => ({ type: 'github' as const, value })));
	} else {
		entries.push(...githubUrls.map((value) => ({ type: 'github' as const, value })));
		entries.push(...primaryLocal.map((value) => ({ type: 'local' as const, value })));
	}

	return { entries: entries.filter((entry) => entry.value.length > 0) };
}

export function getEntryValues(input: ContractInput, type: ContractSourceType): string[] {
	return input.entries
		.filter((entry) => entry.type === type)
		.map((entry) => entry.value.trim())
		.filter((value) => value.length > 0);
}

export function isContractSourceConfigured(
	config: vscode.WorkspaceConfiguration,
	side: ContractSide,
	input: ContractInput
): boolean {
	const keys = getContractSettingKeys(side);
	const sourcesInspection = config.inspect<ContractSourceEntry[]>(keys.sources);
	const sourceInspection = config.inspect<string>(keys.source);
	const pathsInspection = config.inspect<string[]>(keys.paths);
	const githubInspection = config.inspect<string[]>(keys.github);

	const sourcesExplicit = sourcesInspection?.workspaceValue !== undefined
		|| sourcesInspection?.workspaceFolderValue !== undefined
		|| sourcesInspection?.globalValue !== undefined;
	const sourceExplicit = sourceInspection?.workspaceValue !== undefined
		|| sourceInspection?.workspaceFolderValue !== undefined
		|| sourceInspection?.globalValue !== undefined;
	const pathsExplicit = pathsInspection?.workspaceValue !== undefined
		|| pathsInspection?.workspaceFolderValue !== undefined
		|| pathsInspection?.globalValue !== undefined;
	const githubExplicit = githubInspection?.workspaceValue !== undefined
		|| githubInspection?.workspaceFolderValue !== undefined
		|| githubInspection?.globalValue !== undefined;

	return sourcesExplicit
		|| sourceExplicit
		|| pathsExplicit
		|| githubExplicit
		|| input.entries.some((entry) => entry.value.trim().length > 0);
}

export function sanitizeContractInput(input: ContractInput | undefined): ContractInput | undefined {
	const entries = (input?.entries ?? [])
		.filter(
			(entry): entry is ContractSourceEntry =>
				Boolean(entry && (entry.type === 'local' || entry.type === 'github'))
				&& typeof entry.value === 'string'
		)
		.map((entry) => ({ type: entry.type, value: entry.value.trim() }))
		.filter((entry) => entry.value.length > 0);

	return entries.length > 0 ? { entries } : undefined;
}

export async function saveContractInput(
	config: vscode.WorkspaceConfiguration,
	side: ContractSide,
	input: ContractInput
): Promise<void> {
	const keys = getContractSettingKeys(side);
	const localPaths = getEntryValues(input, 'local');
	const githubUrls = getEntryValues(input, 'github');
	await config.update(keys.sources, input.entries, vscode.ConfigurationTarget.Workspace);
	await config.update(keys.source, input.entries[0]?.type ?? 'local', vscode.ConfigurationTarget.Workspace);
	await config.update(keys.paths, localPaths, vscode.ConfigurationTarget.Workspace);
	await config.update(keys.github, githubUrls, vscode.ConfigurationTarget.Workspace);
	await config.update(keys.legacyPath, localPaths[0] ?? '', vscode.ConfigurationTarget.Workspace);
	await config.update(keys.legacyGithub, githubUrls[0] ?? '', vscode.ConfigurationTarget.Workspace);
}

function getContractSettingKeys(side: ContractSide): ContractSettingKeys {
	if (side === 'frontend') {
		return {
			sources: 'frontendSources',
			source: 'frontendContractSource',
			paths: 'frontendContractPaths',
			github: 'frontendContractGitHubUrls',
			legacyPath: 'frontendContractPath',
			legacyGithub: 'frontendContractGitHubUrl',
			defaultPath: '**/contracts/frontend.contract.json'
		};
	}

	return {
		sources: 'backendSources',
		source: 'backendContractSource',
		paths: 'backendContractPaths',
		github: 'backendContractGitHubUrls',
		legacyPath: 'backendContractPath',
		legacyGithub: 'backendContractGitHubUrl',
		defaultPath: '**/contracts/backend.contract.json'
	};
}
