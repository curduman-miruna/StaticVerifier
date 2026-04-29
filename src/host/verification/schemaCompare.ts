import type { SchemaDiff, SchemaFieldDiff } from '../../shared/messages';

export function compareSchemaStrings(
	frontendSchema: string | undefined,
	backendSchema: string | undefined,
	scope: 'request' | 'response'
): { equal: boolean; schemaDiffs?: SchemaDiff[] } {
	const fe = (frontendSchema ?? '').trim();
	const be = (backendSchema ?? '').trim();
	if (fe === be) {
		return { equal: true };
	}

	const feJson = tryParseSchemaJson(fe);
	const beJson = tryParseSchemaJson(be);
	if (feJson?.kind === 'object' && (!beJson || beJson.kind !== 'object')) {
		return buildSchemaDiffResult(frontendSchema, backendSchema, scope, buildObjectFieldDiffs(feJson.value, {}));
	}
	if (beJson?.kind === 'object' && (!feJson || feJson.kind !== 'object')) {
		if (scope === 'response' && !fe) {
			return { equal: true };
		}
		return buildSchemaDiffResult(frontendSchema, backendSchema, scope, buildObjectFieldDiffs({}, beJson.value));
	}
	if (!feJson || !beJson || feJson.kind !== 'object' || beJson.kind !== 'object') {
		return { equal: false };
	}

	const fields = buildObjectFieldDiffs(feJson.value, beJson.value);
	const hasRealDifference = fields.some((item) => !isCompatibleFieldDifference(item, scope));
	if (!hasRealDifference) {
		return { equal: true };
	}

	return buildSchemaDiffResult(frontendSchema, backendSchema, scope, fields);
}

function isCompatibleFieldDifference(field: SchemaFieldDiff, scope: 'request' | 'response'): boolean {
	if (field.status === 'match' || field.status === 'renamed') {
		return true;
	}
	return scope === 'response' && field.status === 'be-only';
}

export function describeSchemaStrings(
	frontendSchema: string | undefined,
	backendSchema: string | undefined,
	scope: 'request' | 'response'
): SchemaDiff | undefined {
	const fe = (frontendSchema ?? '').trim();
	const be = (backendSchema ?? '').trim();
	const feJson = tryParseSchemaJson(fe);
	const beJson = tryParseSchemaJson(be);
	if (feJson?.kind === 'object' && beJson?.kind === 'object') {
		return {
			scope,
			feLabel: frontendSchema,
			beLabel: backendSchema,
			fields: buildObjectFieldDiffs(feJson.value, beJson.value)
		};
	}
	if (feJson?.kind === 'object') {
		return {
			scope,
			feLabel: frontendSchema,
			beLabel: backendSchema,
			fields: buildObjectFieldDiffs(feJson.value, {})
		};
	}
	if (beJson?.kind === 'object') {
		return {
			scope,
			feLabel: frontendSchema,
			beLabel: backendSchema,
			fields: buildObjectFieldDiffs({}, beJson.value)
		};
	}
	return undefined;
}

function buildSchemaDiffResult(
	frontendSchema: string | undefined,
	backendSchema: string | undefined,
	scope: 'request' | 'response',
	fields: SchemaFieldDiff[]
): { equal: boolean; schemaDiffs?: SchemaDiff[] } {
	return {
		equal: false,
		schemaDiffs: [{
			scope,
			feLabel: frontendSchema,
			beLabel: backendSchema,
			fields
		}]
	};
}

function tryParseSchemaJson(schema: string): { kind: 'object' | 'array' | 'primitive'; value: unknown } | undefined {
	if (!schema || (!schema.startsWith('{') && !schema.startsWith('['))) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(schema) as unknown;
		if (Array.isArray(parsed)) {
			return { kind: 'array', value: parsed };
		}
		if (typeof parsed === 'object' && parsed !== null) {
			return { kind: 'object', value: parsed };
		}
		return { kind: 'primitive', value: parsed };
	} catch {
		return undefined;
	}
}

function buildObjectFieldDiffs(frontend: unknown, backend: unknown): SchemaFieldDiff[] {
	const feObj = asObject(frontend);
	const beObj = asObject(backend);
	if (!feObj || !beObj) {
		return [];
	}

	const beKeys = Object.keys(beObj).sort((a, b) => a.localeCompare(b));
	const usedBeKeys = new Set<string>();
	const fields: SchemaFieldDiff[] = [];
	const nestedAliases = inferNestedObjectAliases(feObj, beObj);

	for (const feKey of Object.keys(feObj).sort((a, b) => a.localeCompare(b))) {
		const aliasedFeKey = nestedAliases.get(feKey);
		const exactBeKey = Object.prototype.hasOwnProperty.call(beObj, feKey) ? feKey : aliasedFeKey;
		const normalizedBeKey = exactBeKey ?? beKeys.find((key) => !usedBeKeys.has(key) && normalizeFieldKey(key) === normalizeFieldKey(feKey));
		if (!normalizedBeKey) {
			const duplicateBeKey = beKeys.find((key) => normalizeFieldKey(key) === normalizeFieldKey(feKey));
			if (duplicateBeKey) {
				const feType = inferSchemaValueType(feObj[feKey]);
				const beType = inferSchemaValueType(beObj[duplicateBeKey]);
				fields.push({
					id: `${fields.length}:${feKey}:${duplicateBeKey}`,
					status: areSchemaTypesCompatible(feType, beType) ? 'renamed' : 'type-changed',
					fe: { key: feKey, type: feType, required: true },
					be: { key: duplicateBeKey, type: beType, required: true }
				});
				continue;
			}
			fields.push({
				id: `${fields.length}:${feKey}`,
				status: 'fe-only',
				fe: { key: feKey, type: inferSchemaValueType(feObj[feKey]), required: true }
			});
			continue;
		}

		usedBeKeys.add(normalizedBeKey);
		const feType = inferSchemaValueType(feObj[feKey]);
		const beType = inferSchemaValueType(beObj[normalizedBeKey]);
		const typeMatches = areSchemaTypesCompatible(feType, beType);
		fields.push({
			id: `${fields.length}:${feKey}:${normalizedBeKey}`,
			status: typeMatches ? (feKey === normalizedBeKey ? 'match' : 'renamed') : 'type-changed',
			fe: { key: feKey, type: feType, required: true },
			be: { key: normalizedBeKey, type: beType, required: true }
		});
	}

	for (const beKey of beKeys) {
		if (usedBeKeys.has(beKey)) {
			continue;
		}
		fields.push({
			id: `${fields.length}:${beKey}`,
			status: 'be-only',
			be: { key: beKey, type: inferSchemaValueType(beObj[beKey]), required: true }
		});
	}

	return fields;
}

function inferNestedObjectAliases(
	frontend: Record<string, unknown>,
	backend: Record<string, unknown>
): Map<string, string> {
	const aliases = new Map<string, string>();
	const feGroups = groupNestedFields(frontend);
	const beGroups = groupNestedFields(backend);
	const usedBeRoots = new Set<string>();

	for (const [feRoot, feChildren] of feGroups) {
		const best = Array.from(beGroups.entries())
			.filter(([beRoot]) => !usedBeRoots.has(beRoot) && normalizeFieldKey(feRoot) !== normalizeFieldKey(beRoot))
			.map(([beRoot, beChildren]) => ({
				beRoot,
				score: sharedChildScore(feChildren, beChildren)
			}))
			.filter(({ score }) => score >= Math.min(2, feChildren.size))
			.sort((a, b) => b.score - a.score || a.beRoot.localeCompare(b.beRoot))[0];
		if (!best) {
			continue;
		}
		usedBeRoots.add(best.beRoot);
		aliases.set(feRoot, best.beRoot);
		for (const child of feChildren) {
			aliases.set(`${feRoot}.${child}`, `${best.beRoot}.${child}`);
		}
	}

	return aliases;
}

function groupNestedFields(schema: Record<string, unknown>): Map<string, Set<string>> {
	const groups = new Map<string, Set<string>>();
	for (const key of Object.keys(schema)) {
		const dotIndex = key.indexOf('.');
		if (dotIndex <= 0 || dotIndex >= key.length - 1) {
			continue;
		}
		const root = key.slice(0, dotIndex);
		const child = key.slice(dotIndex + 1);
		const existing = groups.get(root) ?? new Set<string>();
		existing.add(child);
		groups.set(root, existing);
	}
	return groups;
}

function sharedChildScore(left: Set<string>, right: Set<string>): number {
	let score = 0;
	for (const child of left) {
		if (right.has(child)) {
			score += 1;
		}
	}
	return score;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function inferSchemaValueType(value: unknown): string {
	if (typeof value === 'string') {
		return normalizeDeclaredType(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return 'unknown[]';
		}
		return `${inferSchemaValueType(value[0])}[]`;
	}
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'object') {
		return 'object';
	}
	return typeof value;
}

function normalizeDeclaredType(type: string): string {
	const normalized = type.replace(/\s+/g, ' ').trim();
	const arrayMatch = normalized.match(/^(?:array|Array|list|List)<(.+)>$/) ?? normalized.match(/^(?:array|Array|list|List)\[(.+)]$/);
	if (arrayMatch) {
		return `${normalizeDeclaredType(arrayMatch[1])}[]`;
	}
	const mapping: Record<string, string> = {
		EmailStr: 'string',
		AnyUrl: 'string',
		HttpUrl: 'string'
	};
	return mapping[normalized] ?? normalized;
}

function areSchemaTypesCompatible(frontendType: string, backendType: string): boolean {
	if (frontendType === backendType) {
		return true;
	}
	const feParts = splitTypeUnion(frontendType);
	const beParts = splitTypeUnion(backendType);
	if (feParts.has('unknown') || beParts.has('unknown')) {
		return true;
	}
	return Array.from(beParts).every((part) => feParts.has(part) || part === 'null')
		|| Array.from(feParts).every((part) => beParts.has(part) || part === 'null');
}

function splitTypeUnion(type: string): Set<string> {
	return new Set(type.split('|').map((part) => part.trim()).filter(Boolean));
}

function normalizeFieldKey(key: string): string {
	return key.replace(/[_\-\s]/g, '').toLowerCase();
}
