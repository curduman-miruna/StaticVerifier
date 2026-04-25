type DiscoveredApi = {
	uri: string;
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	source: string;
	line: number;
	column: number;
};

type DiscoveryPanelProps = {
	items: DiscoveredApi[];
	isLoading: boolean;
	onRefresh: () => void;
	onReveal: (item: DiscoveredApi) => void;
};

type GroupedSource = {
	source: string;
	items: DiscoveredApi[];
};

function groupBySource(items: DiscoveredApi[]): GroupedSource[] {
	const groups = new Map<string, GroupedSource>();
	for (const item of items) {
		const existing = groups.get(item.source);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		groups.set(item.source, { source: item.source, items: [item] });
	}
	return Array.from(groups.values()).sort((a, b) => a.source.localeCompare(b.source));
}

export function DiscoveryPanel({ items, isLoading, onRefresh, onReveal }: DiscoveryPanelProps) {
	const grouped = groupBySource(items);

	return (
		<section className="results">
			<div className="results-header">
				<h2>Discovered APIs</h2>
				<button type="button" className="corner-button" onClick={onRefresh} disabled={isLoading}>
					{isLoading ? 'Loading...' : 'Refresh'}
				</button>
			</div>
			{items.length === 0 ? (
				<p className="results-footer">{isLoading ? 'Discovering endpoints...' : 'No APIs discovered yet.'}</p>
			) : (
				<div className="merge-view">
					<div className="merge-header">
						<span>Endpoints</span>
						<strong>{items.length} across {grouped.length} files</strong>
					</div>
					{grouped.map((group) => (
						<article className="merge-file" key={group.source}>
							<div className="merge-file-header">
								<span className="merge-file-name">{group.source}</span>
								<span className="merge-file-count">{group.items.length}</span>
							</div>
							<div className="merge-rows">
								{group.items.map((item, index) => (
									<div className="discovery-item" key={`${item.method}-${item.path}-${index}`}>
										<div className="discovery-main">
											<span className="discovery-method">{item.method}</span>
											<span className="discovery-path">{item.path}</span>
											<span className="discovery-location">L{item.line}:{item.column}</span>
										</div>
										<div className="discovery-meta">
											<span>{item.requestSchema ? `REQ: ${item.requestSchema}` : 'REQ: -'}</span>
											<span>{item.responseSchema ? `RES: ${item.responseSchema}` : 'RES: -'}</span>
										</div>
										<button
											type="button"
											className="discovery-open"
											onClick={() => onReveal(item)}
										>
											Open
										</button>
									</div>
								))}
							</div>
						</article>
					))}
				</div>
			)}
		</section>
	);
}
