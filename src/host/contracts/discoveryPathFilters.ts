import * as path from 'node:path';
import type { ContractSide } from '../../shared/contracts';

const FRONTEND_DISCOVERY_ALLOWED_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json'
]);
const BACKEND_DISCOVERY_ALLOWED_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.py',
	'.java',
	'.kt',
	'.cs',
	'.json'
]);

const DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
	'node_modules',
	'dist',
	'build',
	'out',
	'coverage',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'__test__',
	'__tests__',
	'test',
	'tests',
	'spec',
	'specs'
]);

const TEST_FILE_PATTERNS = [
	/(?:^|[._-])(?:test|spec)\.[cm]?[jt]sx?$/,
	/(?:test|spec)\.(?:java|kt|cs|py)$/,
	/^test[._-].*\.py$/
];

export function shouldSkipDiscoveryPath(side: ContractSide, filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();
	const segments = lowerPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
	if (segments.some((segment) => DISCOVERY_EXCLUDED_DIRECTORIES.has(segment))) {
		return true;
	}

	const fileName = segments.at(-1) ?? path.basename(lowerPath);
	if (TEST_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
		return true;
	}

	if (lowerPath.endsWith('.d.ts') || lowerPath.endsWith('.map') || lowerPath.endsWith('.min.js')) {
		return true;
	}

	const extension = path.extname(lowerPath);
	const allowedExtensions = side === 'frontend'
		? FRONTEND_DISCOVERY_ALLOWED_EXTENSIONS
		: BACKEND_DISCOVERY_ALLOWED_EXTENSIONS;
	return !allowedExtensions.has(extension);
}
