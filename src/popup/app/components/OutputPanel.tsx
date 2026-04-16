type OutputPanelProps = {
	text: string;
	issues?: Array<{
		file: string;
		line: number;
		column: number;
		severity: 'error' | 'warning' | 'info';
		message: string;
	}>;
};

type ParsedSummary = {
	compared?: string;
	matches?: string;
	mismatches?: string;
	missingInBackend?: string;
	requestMismatch?: string;
	responseMismatch?: string;
	backendOnly?: string;
	footer?: string;
};

function parseSummary(text: string): ParsedSummary | undefined {
	const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
	if (!lines.some((line) => line.startsWith('Compared FE endpoints:'))) {
		return undefined;
	}

	const valueOf = (prefix: string): string | undefined => {
		const line = lines.find((item) => item.startsWith(prefix));
		return line ? line.slice(prefix.length).trim() : undefined;
	};

	return {
		compared: valueOf('Compared FE endpoints:'),
		matches: valueOf('Matches:'),
		mismatches: valueOf('Mismatches:'),
		missingInBackend: valueOf('- Missing in BE:'),
		requestMismatch: valueOf('- Request schema mismatches:'),
		responseMismatch: valueOf('- Response schema mismatches:'),
		backendOnly: valueOf('- BE-only endpoints:'),
		footer: lines[lines.length - 1]
	};
}

type FileGroup = {
	file: string;
	issues: Array<{
		line: number;
		column: number;
		severity: 'error' | 'warning' | 'info';
		message: string;
	}>;
};

function groupByFile(issues: NonNullable<OutputPanelProps['issues']>): FileGroup[] {
	const map = new Map<string, FileGroup>();
	for (const issue of issues) {
		const existing = map.get(issue.file);
		if (existing) {
			existing.issues.push({
				line: issue.line,
				column: issue.column,
				severity: issue.severity,
				message: issue.message
			});
			continue;
		}
		map.set(issue.file, {
			file: issue.file,
			issues: [{
				line: issue.line,
				column: issue.column,
				severity: issue.severity,
				message: issue.message
			}]
		});
	}
	return Array.from(map.values()).sort((a, b) => a.file.localeCompare(b.file));
}

export function OutputPanel({ text, issues = [] }: OutputPanelProps) {
	const normalized = text.toLowerCase();
	const tone = normalized.includes('failed') || normalized.includes('error')
		? 'is-error'
		: normalized.includes('saved') || normalized.includes('no mismatches')
			? 'is-success'
			: 'is-neutral';
	const parsed = parseSummary(text);
	const detailLines = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('Compared FE endpoints:') && !line.startsWith('Matches:') && !line.startsWith('Mismatches:') && !line.startsWith('-'));
	const grouped = groupByFile(issues);

	return (
		<section className={`results ${tone}`}>
			<div className="results-header">
				<h2>Verification Output</h2>
				<span className="results-badge">{tone === 'is-error' ? 'Error' : tone === 'is-success' ? 'OK' : 'Info'}</span>
			</div>
			{parsed ? (
				<div className="results-grid">
					<div className="result-metric">
						<span className="metric-label">Compared</span>
						<strong>{parsed.compared ?? '-'}</strong>
					</div>
					<div className="result-metric">
						<span className="metric-label">Matches</span>
						<strong>{parsed.matches ?? '-'}</strong>
					</div>
					<div className="result-metric">
						<span className="metric-label">Mismatches</span>
						<strong>{parsed.mismatches ?? '-'}</strong>
					</div>
					<div className="result-metric">
						<span className="metric-label">Missing in BE</span>
						<strong>{parsed.missingInBackend ?? '-'}</strong>
					</div>
					<div className="result-metric">
						<span className="metric-label">Request schema</span>
						<strong>{parsed.requestMismatch ?? '-'}</strong>
					</div>
					<div className="result-metric">
						<span className="metric-label">Response schema</span>
						<strong>{parsed.responseMismatch ?? '-'}</strong>
					</div>
					<div className="result-metric">
						<span className="metric-label">BE only</span>
						<strong>{parsed.backendOnly ?? '-'}</strong>
					</div>
				</div>
			) : null}
			{grouped.length > 0 ? (
				<div className="merge-view">
					<div className="merge-header">
						<span>Files with comments</span>
						<strong>{grouped.length}</strong>
					</div>
					{grouped.map((group) => (
						<article className="merge-file" key={group.file}>
							<div className="merge-file-header">
								<span className="merge-file-name">{group.file}</span>
								<span className="merge-file-count">{group.issues.length}</span>
							</div>
							<div className="merge-rows">
								{group.issues.map((issue, index) => (
									<div className={`merge-row is-${issue.severity}`} key={`${group.file}-${issue.line}-${issue.column}-${index}`}>
										<span className="merge-line">L{issue.line}:{issue.column}</span>
										<span className="merge-msg">{issue.message}</span>
										<span className="merge-severity">{issue.severity}</span>
									</div>
								))}
							</div>
						</article>
					))}
				</div>
			) : null}
			{detailLines.length > 0 ? (
				<ul className="results-list">
					{detailLines.map((line, index) => (
						<li key={`${line}-${index}`}>{line}</li>
					))}
				</ul>
			) : null}
			{!parsed && detailLines.length === 0 && grouped.length === 0 ? <pre className="results-pre">{text}</pre> : null}
			{parsed?.footer ? <p className="results-footer">{parsed.footer}</p> : null}
		</section>
	);
}
