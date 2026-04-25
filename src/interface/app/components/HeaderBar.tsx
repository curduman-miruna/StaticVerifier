import { Activity, AlertTriangle, CheckCircle2, Loader2, Radio, Settings } from 'lucide-react';
import { Button } from './ui';

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

export function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffSecs = Math.floor(diffMs / 1000);
	if (diffSecs < 60) return `${Math.max(0, diffSecs)}s ago`;
	const diffMins = Math.floor(diffSecs / 60);
	if (diffMins < 60) return `${diffMins}m ago`;
	return `${Math.floor(diffMins / 60)}h ago`;
}

const statusConfig = {
	ready: {
		label: 'Ready',
		color: 'sv-status-color-ready',
		bg: 'sv-status-bg-ready',
		dot: 'sv-status-dot-ready',
		Icon: CheckCircle2
	},
	scanning: {
		label: 'Scanning...',
		color: 'sv-status-color-scanning',
		bg: 'sv-status-bg-scanning',
		dot: 'sv-status-dot-scanning sv-pulse',
		Icon: Loader2
	},
	error: {
		label: 'Error',
		color: 'sv-status-color-error',
		bg: 'sv-status-bg-error',
		dot: 'sv-status-dot-error',
		Icon: AlertTriangle
	},
	unconfigured: {
		label: 'Unconfigured',
		color: 'sv-status-color-unconfigured',
		bg: 'sv-status-bg-unconfigured',
		dot: 'sv-status-dot-unconfigured',
		Icon: Activity
	}
} as const;

export function resolveHeaderStatus(status: HeaderStatus, isScanning: boolean): HeaderStatus {
	return isScanning ? 'scanning' : status;
}

export function HeaderBar({ metrics, mode, onModeChange, isScanning }: HeaderBarProps) {
	const status = resolveHeaderStatus(metrics.status, isScanning);
	const cfg = statusConfig[status];
	const StatusIcon = cfg.Icon;

	return (
		<header className="sv-header">
			<div className="sv-header-row">
				<div className="sv-header-brand">
					<div className="sv-header-logo">
						<Radio size={11} />
					</div>
					<span className="sv-header-brand-name">
						StaticVerifier
					</span>
				</div>

				<div className="sv-header-status-wrap">
					<span className={`sv-header-status ${cfg.bg} ${cfg.color}`}>
						<StatusIcon size={12} className={status === 'scanning' ? 'sv-spin' : undefined} />
						<span className={`sv-header-status-dot ${cfg.dot}`} />
						{cfg.label}
					</span>
				</div>

				<div className="sv-header-metrics">
					<div className="sv-header-metric-block">
						<div className="sv-header-metric-inner">
							<span className="sv-header-tag sv-header-tag-fe">FE</span>
							<div className="sv-header-metric-text">
								<span className="sv-header-metric-main">{metrics.feSources} src</span>
								<span className="sv-header-metric-sub">{typeof metrics.feIndexed === 'number' ? metrics.feIndexed : 0} files indexed</span>
							</div>
						</div>
					</div>

					<div className="sv-header-metric-block">
						<div className="sv-header-metric-inner">
							<span className="sv-header-tag sv-header-tag-be">BE</span>
							<div className="sv-header-metric-text">
								<span className="sv-header-metric-main">{metrics.beSources} src</span>
								<span className="sv-header-metric-sub">{typeof metrics.beIndexed === 'number' ? metrics.beIndexed : 0} files indexed</span>
							</div>
						</div>
					</div>

					<div className="sv-header-scan">
						<span>
							Scanned <span className="sv-header-scan-value">{metrics.lastScanned ? formatRelativeTime(metrics.lastScanned) : 'never'}</span>
						</span>
					</div>

					<div className="sv-header-spacer" />

					<div className="sv-header-toggle-wrap">
						<div className="sv-header-toggle">
							<Button
								onClick={() => onModeChange('monitor')}
								className={`sv-header-toggle-btn ${mode === 'monitor' ? 'is-active' : ''}`}
								style={{ fontWeight: mode === 'monitor' ? 500 : 400, width: 'auto' }}
								variant="ghost"
								size="sm"
							>
								<Activity size={12} />
								Monitor
							</Button>
							<Button
								onClick={() => onModeChange('configure')}
								className={`sv-header-toggle-btn ${mode === 'configure' ? 'is-active' : ''}`}
								style={{ fontWeight: mode === 'configure' ? 500 : 400, width: 'auto' }}
								variant="ghost"
								size="sm"
							>
								<Settings size={12} />
								Configure
							</Button>
						</div>
					</div>
				</div>
			</div>
		</header>
	);
}
