import type { ContractInput, ContractSide, ContractSourceType } from './contracts';

export type InitialState = {
	frontend: ContractInput;
	backend: ContractInput;
	hasConfiguredPaths: boolean;
};

export type HostMessage = {
	type: 'actionResult';
	text: string;
} | {
	type: 'verificationReport';
	summaryText: string;
	issues: Array<{
		file: string;
		line: number;
		column: number;
		severity: 'error' | 'warning' | 'info';
		message: string;
	}>;
} | {
	type: 'discoveredApis';
	items: Array<{
		uri: string;
		method: string;
		path: string;
		requestSchema?: string;
		responseSchema?: string;
		source: string;
		line: number;
		column: number;
	}>;
} | {
	type: 'browseResult';
	side: ContractSide;
	index: number;
	value?: string;
	error?: string;
} | {
	type: 'sourceCounts';
	items: Array<{
		side: ContractSide;
		type: ContractSourceType;
		value: string;
		fileCount: number;
	}>;
};

export type PopupMessage =
	| {
		type: 'savePaths';
		frontend?: ContractInput;
		backend?: ContractInput;
	}
	| {
		type: 'browseLocal';
		side: ContractSide;
		index: number;
	}
	| {
		type: 'refreshSourceCounts';
	}
	| {
		type: 'verifyContracts';
	}
	| {
		type: 'discoverApis';
	}
	| {
		type: 'revealDiscoveredApi';
		uri: string;
		line: number;
		column: number;
	};
