const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`[ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log('[watch] build finished');
		});
	}
};

async function main() {
	const common = {
		bundle: true,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin]
	};

	const extensionCtx = await esbuild.context({
		...common,
		entryPoints: ['src/extension.ts'],
		format: 'cjs',
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode']
	});

	const interfaceCtx = await esbuild.context({
		...common,
		entryPoints: ['src/interface/main.tsx'],
		format: 'iife',
		platform: 'browser',
		outfile: 'dist/interface.js',
		loader: {
			'.css': 'css'
		}
	});

	if (watch) {
		await Promise.all([extensionCtx.watch(), interfaceCtx.watch()]);
		return;
	}

	await Promise.all([extensionCtx.rebuild(), interfaceCtx.rebuild()]);
	await Promise.all([extensionCtx.dispose(), interfaceCtx.dispose()]);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
