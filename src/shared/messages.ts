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
	};
