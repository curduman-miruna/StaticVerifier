export type ModelDefinitionMatch = {
	name: string;
	line: number;
	column: number;
	highlightText: string;
};

const PRIMITIVE_TYPES = new Set([
	'string',
	'number',
	'boolean',
	'bool',
	'int',
	'integer',
	'float',
	'double',
	'long',
	'unknown',
	'any',
	'object',
	'null',
	'undefined',
	'void',
	'list',
	'array',
	'record',
	'dict',
	'map',
	'optional',
	'promise',
	'response'
]);

export function extractModelNamesFromSchema(schema: string | undefined): string[] {
	if (!schema || schema.trim().startsWith('{') || schema.trim().startsWith('[')) {
		return [];
	}
	const names = new Set<string>();
	for (const match of schema.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
		const name = match[0];
		if (!PRIMITIVE_TYPES.has(name.toLowerCase())) {
			names.add(name);
		}
	}
	return Array.from(names);
}

export function findModelDefinitionsInText(text: string, modelNames: string[]): ModelDefinitionMatch[] {
	const matches: ModelDefinitionMatch[] = [];
	for (const name of modelNames) {
		const escaped = escapeRegExp(name);
		const patterns = [
			new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:interface|type|class|enum)\\s+(${escaped})\\b`, 'g'),
			new RegExp(`\\bclass\\s+(${escaped})\\s*(?:\\(|:)`, 'g'),
			new RegExp(`\\b(?:public\\s+|internal\\s+|private\\s+|protected\\s+|sealed\\s+|abstract\\s+)*?(?:data\\s+)?(?:class|record|interface|enum)\\s+(${escaped})\\b`, 'g'),
			new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+(${escaped})\\s*=\\s*(?:z\\.|yup\\.|object\\(|{)`, 'g'),
			new RegExp(`\\b(?:typealias|typealias\\s+class)\\s+(${escaped})\\b`, 'g')
		];
		for (const pattern of patterns) {
			for (const match of text.matchAll(pattern)) {
				const nameIndex = (match.index ?? 0) + match[0].lastIndexOf(name);
				const location = offsetToLineColumn(text, nameIndex);
				matches.push({
					name,
					line: location.line,
					column: location.column,
					highlightText: name
				});
			}
		}
	}
	return dedupeMatches(matches);
}

function dedupeMatches(matches: ModelDefinitionMatch[]): ModelDefinitionMatch[] {
	const seen = new Set<string>();
	const result: ModelDefinitionMatch[] = [];
	for (const match of matches) {
		const key = `${match.name}:${match.line}:${match.column}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(match);
	}
	return result;
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
	const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
	const lines = before.split(/\r?\n/);
	return {
		line: lines.length,
		column: (lines[lines.length - 1]?.length ?? 0) + 1
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
