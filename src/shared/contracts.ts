export type ContractSourceType = 'local' | 'github';

export type ContractSide = 'frontend' | 'backend';

export type ContractSourceEntry = {
	type: ContractSourceType;
	value: string;
};

export type ContractInput = {
	entries: ContractSourceEntry[];
};

export type SourceCountItem = {
	side: ContractSide;
	type: ContractSourceType;
	value: string;
	fileCount: number;
};
