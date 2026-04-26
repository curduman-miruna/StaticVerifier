import type { ContractInput, ContractSide, ContractSourceType } from './contracts';

export type InitialState = {
	frontend: ContractInput;
	backend: ContractInput;
	hasConfiguredPaths: boolean;
};

export type VerificationIssueKind =
	| 'missing-backend'
	| 'backend-only'
	| 'request-schema-mismatch'
	| 'response-schema-mismatch'
	| 'invalid-endpoint'
	| 'duplicate-endpoint';

export type SchemaFieldStatus =
	| 'match'
	| 'renamed'
	| 'type-changed'
	| 'fe-only'
	| 'be-only'
	| 'optional-mismatch';

export type SchemaField = {
	key: string;
	type: string;
	required: boolean;
	description?: string;
};

export type SchemaFieldDiff = {
	id: string;
	status: SchemaFieldStatus;
	fe?: SchemaField;
	be?: SchemaField;
};

export type SchemaDiff = {
	scope: 'request' | 'response';
	feLabel?: string;
	beLabel?: string;
	fields: SchemaFieldDiff[];
};

export type VerificationIssue = {
	file: string;
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'info';
	message: string;
	kind: VerificationIssueKind;
	sourceSide: ContractSide;
	method?: string;
	path?: string;
	schemaDiffs?: SchemaDiff[];
};

export type HostMessage = {
	type: 'actionResult';
	text: string;
} | {
	type: 'verificationReport';
	summaryText: string;
	issues: VerificationIssue[];
} | {
	type: 'discoveredApis';
	items: Array<{
		uri: string;
		method: string;
		path: string;
		requestSchema?: string;
		responseSchema?: string;
		side: ContractSide;
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
