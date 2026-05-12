export type SelectedEndpoint = {
	pathText: string;
	baseHint?: string;
	methodHint?: string;
};

export type EndpointTextAtPosition = {
	text: string;
	start: number;
	end: number;
};

export function cleanSelectedEndpointText(text: string): string {
	return parseSelectedEndpointText(text).pathText;
}

export function findEndpointTextAtOffset(lineText: string, offset: number): EndpointTextAtPosition | undefined {
	const tokenPattern = /(['"`])((?:\$\{[^}]+}\s*)?(?:https?:\/\/[^'"`)\]\s]+|\/[^'"`)\]\s]+))\1/g;
	for (const match of lineText.matchAll(tokenPattern)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (offset >= start && offset <= end) {
			return { text: match[0], start, end };
		}
	}

	const barePattern = /(?:https?:\/\/[^\s'"`)\]}]+|\/[A-Za-z0-9_./:{}?&=%-]+)/g;
	for (const match of lineText.matchAll(barePattern)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (offset >= start && offset <= end) {
			return { text: match[0], start, end };
		}
	}

	return undefined;
}

export function parseSelectedEndpointText(text: string, documentText = ''): SelectedEndpoint {
	const original = text.trim();
	const candidate = extractEndpointCandidate(original) ?? text;
	const unquoted = normalizeEndpointLiteral(candidate.trim().replace(/^['"`]+|['"`;,)\]}]+$/g, ''));
	const methodHint = inferMethodHint(original, candidate);
	const templateMatch = unquoted.match(/^\$\{\s*([^}]+?)\s*}\s*(.*)$/);
	if (!templateMatch) {
		return { pathText: unquoted, methodHint };
	}

	const expression = templateMatch[1]?.trim() ?? '';
	const suffix = templateMatch[2]?.trim() ?? '';
	const literalBase = resolveStringExpression(expression, documentText);
	if (literalBase) {
		return {
			pathText: joinBaseAndPath(literalBase, suffix),
			baseHint: expression,
			methodHint
		};
	}

	return {
		pathText: suffix,
		baseHint: expression,
		methodHint
	};
}

function extractEndpointCandidate(text: string): string | undefined {
	if (!text || isEndpointLikeText(text)) {
		return undefined;
	}

	const quotedLiteralPattern = /(['"`])([\s\S]*?)\1/g;
	for (const match of text.matchAll(quotedLiteralPattern)) {
		if (isEndpointLikeText(match[2])) {
			return match[0];
		}
	}

	const quotedPattern = /(['"`])((?:\$\{[^}]+}\s*)?(?:https?:\/\/[^'"`)\]\s,]+|\/[^'"`)\]\s,]+))\1/g;
	for (const match of text.matchAll(quotedPattern)) {
		return match[0];
	}

	const barePattern = /(?:https?:\/\/[^\s'"`)\]},]+|\/[A-Za-z0-9_./:{}?&=%-]+)/g;
	for (const match of text.matchAll(barePattern)) {
		return match[0];
	}

	return undefined;
}

function normalizeEndpointLiteral(value: string): string {
	const trimmed = value.trim();
	if (!/[\r\n]/.test(trimmed)) {
		return trimmed;
	}
	return trimmed.replace(/\s+/g, '');
}

function inferMethodHint(text: string, candidate: string): string | undefined {
	const value = text.trim();
	const methodClient = value.match(/\b[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(/i);
	if (methodClient && value.includes(candidate)) {
		return methodClient[1].toUpperCase();
	}

	const fetchMethod = value.match(/\bmethod\s*:\s*(['"`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/i);
	if (fetchMethod) {
		return fetchMethod[2].toUpperCase();
	}

	const requestCtor = value.match(/\bnew\s+Request\s*\([^)]*\bmethod\s*:\s*(['"`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/i);
	if (requestCtor) {
		return requestCtor[2].toUpperCase();
	}

	return undefined;
}

function isEndpointLikeText(text: string): boolean {
	const trimmed = normalizeEndpointLiteral(text.trim().replace(/^['"`]+|['"`;,)\]}]+$/g, ''));
	return /^\$\{\s*[^}]+}\s*(?:\/|https?:\/\/)/i.test(trimmed)
		|| /^https?:\/\//i.test(trimmed)
		|| trimmed.startsWith('/');
}

export function baseHintTokens(baseHint: string | undefined): string[] {
	if (!baseHint) {
		return [];
	}
	return Array.from(new Set(
		baseHint
			.replace(/\b(?:process|env|import|meta|VITE|REACT_APP|NEXT_PUBLIC)\b/g, ' ')
			.split(/[^A-Za-z0-9]+|(?=[A-Z][a-z])/)
			.map((token) => token.toLowerCase())
			.filter((token) => token.length >= 3 && !['url', 'api', 'base', 'href', 'origin', 'vite', 'react', 'app', 'next', 'public'].includes(token))
	));
}

function resolveStringExpression(expression: string, documentText: string): string | undefined {
	const direct = stripQuotes(expression);
	if (direct) {
		return direct;
	}

	const identifier = expression.match(/[A-Za-z_$][\w$]*$/)?.[0];
	if (!identifier || !documentText) {
		return undefined;
	}

	const escaped = escapeRegExp(identifier);
	const declaration = documentText.match(new RegExp(
		`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(['"\`])([^'"\`]+)\\1`
	));
	return declaration?.[2];
}

function stripQuotes(value: string): string | undefined {
	const match = value.trim().match(/^(['"`])([^'"`]+)\1$/);
	return match?.[2];
}

function joinBaseAndPath(base: string, suffix: string): string {
	if (!suffix) {
		return base;
	}
	if (/^https?:\/\//i.test(suffix) || suffix.startsWith('/')) {
		if (/^https?:\/\//i.test(base)) {
			try {
				return new URL(suffix, base.endsWith('/') ? base : `${base}/`).toString();
			} catch {
				return suffix;
			}
		}
		return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
	}
	return `${base.replace(/\/+$/, '')}/${suffix}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
