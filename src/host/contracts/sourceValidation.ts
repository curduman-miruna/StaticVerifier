import type {
	ContractInput,
	ContractSide,
	ContractSourceEntry,
	SourceCountItem
} from '../../shared/contracts';
import { countGitHubFiles, isSupportedGitHubContractUrl, normalizeGitHubRawUrl } from './githubSource';
import { countLocalFiles, findLocalMatches, localEntryExists } from './localSource';
export { browseLocalEntry } from './browseLocalEntry';

export async function computeSourceCounts(
	frontend: ContractInput,
	backend: ContractInput
): Promise<{ frontendCounts: SourceCountItem[]; backendCounts: SourceCountItem[] }> {
	const frontendCounts = await countEntriesForSide('frontend', frontend.entries);
	const backendCounts = await countEntriesForSide('backend', backend.entries);
	return { frontendCounts, backendCounts };
}

export async function validateBeforeSave(
	frontend: ContractInput,
	backend: ContractInput
): Promise<{
	valid: boolean;
	errors: string[];
	summary: string;
	frontendCounts: SourceCountItem[];
	backendCounts: SourceCountItem[];
}> {
	const errors: string[] = [];
	const { frontendCounts, backendCounts } = await computeSourceCounts(frontend, backend);
	const frontendStats = await validateSideEntries('FE', frontend.entries, errors);
	const backendStats = await validateSideEntries('BE', backend.entries, errors);
	return {
		valid: errors.length === 0,
		errors,
		summary: `Loaded FE local files: ${frontendStats.localMatched}, FE GitHub links validated: ${frontendStats.githubLoaded}; BE local files: ${backendStats.localMatched}, BE GitHub links validated: ${backendStats.githubLoaded}.`,
		frontendCounts,
		backendCounts
	};
}

async function countEntriesForSide(
	side: ContractSide,
	entries: ContractSourceEntry[]
): Promise<SourceCountItem[]> {
	const result: SourceCountItem[] = [];
	for (const entry of entries) {
		const value = entry.value.trim();
		if (!value) {
			continue;
		}
		if (entry.type === 'local') {
			result.push({ side, type: 'local', value, fileCount: await countLocalFiles(value) });
			continue;
		}
		if (!isSupportedGitHubContractUrl(value)) {
			result.push({ side, type: 'github', value, fileCount: 0 });
			continue;
		}
		result.push({ side, type: 'github', value, fileCount: await countGitHubFiles(value) });
	}
	return result;
}

async function validateSideEntries(
	label: 'FE' | 'BE',
	entries: ContractSourceEntry[],
	errors: string[]
): Promise<{ localMatched: number; githubLoaded: number }> {
	let localMatched = 0;
	let githubLoaded = 0;

	for (const entry of entries) {
		const value = entry.value.trim();
		if (!value) {
			continue;
		}
		if (entry.type === 'local') {
			if (!(await localEntryExists(value))) {
				errors.push(`${label} local path does not exist: ${value}`);
				continue;
			}
			localMatched += (await findLocalMatches(value)).length;
			continue;
		}

		if (!isSupportedGitHubContractUrl(value)) {
			errors.push(`${label} GitHub URL must point to a file (blob/raw): ${value}`);
			continue;
		}

		const normalizedUrl = normalizeGitHubRawUrl(value);
		let response: Response;
		try {
			response = await fetch(normalizedUrl);
		} catch {
			errors.push(`${label} GitHub link cannot be fetched: ${value}`);
			continue;
		}
		if (!response.ok) {
			errors.push(`${label} GitHub link returned ${response.status}: ${value}`);
			continue;
		}
		githubLoaded += 1;
	}

	return { localMatched, githubLoaded };
}
