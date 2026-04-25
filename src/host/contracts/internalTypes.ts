import * as vscode from 'vscode';
import type { VerificationIssue } from '../../shared/messages';

export type EndpointContract = {
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	sourceLine?: number;
	sourceColumn?: number;
};

export type ParsedContractFile = {
	uri: vscode.Uri;
	text: string;
	endpoints: EndpointContract[];
};

export type EndpointRecord = {
	endpoint: EndpointContract;
	uri: vscode.Uri;
	text: string;
};

export type VerificationSummary = {
	matchedEndpoints: number;
	missingBackend: number;
	requestMismatches: number;
	responseMismatches: number;
	backendOnly: number;
	totalIssues: number;
	comparedFrontend: number;
	issues: VerificationIssue[];
};
