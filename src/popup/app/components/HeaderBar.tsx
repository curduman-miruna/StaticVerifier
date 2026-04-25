type AppMode = 'monitor' | 'configure';
type HeaderStatus = 'ready' | 'scanning' | 'error' | 'unconfigured';

type HeaderMetrics = {
	feSources: number;
	feIndexed?: number;
	beSources: number;
	beIndexed?: number;
	lastScanned?: Date;
	status: HeaderStatus;
};

type HeaderBarProps = {
	metrics: HeaderMetrics;
	mode: AppMode;
	onModeChange: (mode: AppMode) => void;
	isScanning: boolean;
};

function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffSecs = Math.max(0, Math.floor(diffMs / 1000));
	if (diffSecs < 60) {
		return `${diffSecs}s ago`;
	}
	const diffMins = Math.floor(diffSecs / 60);
	if (diffMins < 60) {
		return `${diffMins}m ago`;
	}
	return `${Math.floor(diffMins / 60)}h ago`;
}

const STATUS_LABEL: Record<HeaderStatus, string> = {
	ready: 'Ready',
	scanning: 'Scanning',
	error: 'Error',
	unconfigured: 'Unconfigured'
};

export function HeaderBar({ metrics, mode, onModeChange, isScanning }: HeaderBarProps) {
	const status: HeaderStatus = isScanning ? 'scanning' : metrics.status;
	return (
		<header className="top-header">
			<div className="top-header-brand">
				<span className="brand-dot" />
				<span className="brand-name">StaticVerifier</span>
			</div>

			<div className={`header-status is-${status}`}>
				<span className="status-dot-sm" />
				<span>{STATUS_LABEL[status]}</span>
			</div>

			<div className="header-metric">
				<span className="metric-tag">FE</span>
				<div>
					<div className="metric-main">{metrics.feSources} src</div>
					<div className="metric-sub">{typeof metrics.feIndexed === 'number' ? `${metrics.feIndexed} files indexed` : 'index pending'}</div>
				</div>
			</div>

			<div className="header-metric">
				<span className="metric-tag">BE</span>
				<div>
					<div className="metric-main">{metrics.beSources} src</div>
					<div className="metric-sub">{typeof metrics.beIndexed === 'number' ? `${metrics.beIndexed} files indexed` : 'index pending'}</div>
				</div>
			</div>

			<div className="header-scan">
				Scanned <span>{metrics.lastScanned ? formatRelativeTime(metrics.lastScanned) : 'never'}</span>
			</div>

			<div className="header-mode">
				<button
					type="button"
					className={`mode-btn ${mode === 'monitor' ? 'is-active' : ''}`}
					onClick={() => onModeChange('monitor')}
				>
					Monitor
				</button>
				<button
					type="button"
					className={`mode-btn ${mode === 'configure' ? 'is-active' : ''}`}
					onClick={() => onModeChange('configure')}
				>
					Configure
				</button>
			</div>
		</header>
	);
}
