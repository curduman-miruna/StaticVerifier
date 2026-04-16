import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function findFilesystemFiles(
	targetPath: string,
	limit: number,
	filter?: (filePath: string) => boolean
): Promise<string[]> {
	const results: string[] = [];
	const stack = [targetPath];

	while (stack.length > 0 && results.length < limit) {
		const current = stack.pop();
		if (!current) {
			continue;
		}

		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(current);
		} catch {
			continue;
		}

		if (stat.isFile()) {
			if (!filter || filter(current)) {
				results.push(current);
			}
			continue;
		}

		if (!stat.isDirectory()) {
			continue;
		}

		let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
		try {
			entries = await fs.readdir(current, { withFileTypes: true, encoding: 'utf8' });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile()) {
				if (!filter || filter(full)) {
					results.push(full);
				}
				if (results.length >= limit) {
					break;
				}
			}
		}
	}

	return results;
}

export async function countFilesystemFiles(
	targetPath: string,
	limit: number,
	filter?: (filePath: string) => boolean
): Promise<number> {
	return (await findFilesystemFiles(targetPath, limit, filter)).length;
}
