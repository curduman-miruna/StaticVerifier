import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Zap } from 'lucide-react';
import { Badge } from './ui';
import { DiscoveryPanel } from './DiscoveryPanel';
import { VerificationView } from './VerificationView';
import type { VerificationIssue } from '../../../shared/messages';

type MonitorPanelProps = {
	metrics: {
		totalEndpoints: number;
		mismatchCount: number;
		feIndexed: number;
		beIndexed: number;
	};
	mismatches: VerificationIssue[];
	discoveredApis: Array<{
		uri: string;
		method: string;
		path: string;
		requestSchema?: string;
		responseSchema?: string;
		side: 'frontend' | 'backend';
		source: string;
		line: number;
		column: number;
	}>;
	isDiscovering: boolean;
	onRescan: () => Promise<void>;
	onRevealDiscoveredApi: (item: {
		uri: string;
		line: number;
		column: number;
	}) => void;
	onRefreshDiscovery: () => void;
};

type ResultTab = 'verification' | 'discovered';

export function MonitorPanel({
	metrics,
	mismatches,
	discoveredApis,
	isDiscovering,
	onRescan,
	onRevealDiscoveredApi,
	onRefreshDiscovery
}: MonitorPanelProps) {
	const [activeTab, setActiveTab] = useState<ResultTab>('verification');
	const [rescanning, setRescanning] = useState(false);

	const handleRescan = async () => {
		setRescanning(true);
		try {
			await onRescan();
		} finally {
			setRescanning(false);
		}
	};

	const tabs: Array<{ key: ResultTab; label: string; count: number; alert?: boolean }> = [
		{ key: 'verification', label: 'Verification', count: mismatches.length, alert: mismatches.length > 0 },
		{ key: 'discovered', label: 'Discovered APIs', count: discoveredApis.length }
	];

	return (
		<section className="monitor-panel">
			<div className="monitor-summary">
				<div className="monitor-stat-row">
					<div className="sv-ui-card monitor-stat-pill">
						<Zap size={13} />
						<span><strong>{metrics.totalEndpoints}</strong> endpoints</span>
					</div>
					<div className={`sv-ui-card monitor-stat-pill ${metrics.mismatchCount > 0 ? 'is-warn' : 'is-ok'}`}>
						{metrics.mismatchCount > 0 ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
						<span>
							<strong>{metrics.mismatchCount}</strong> mismatch{metrics.mismatchCount !== 1 ? 'es' : ''}
						</span>
					</div>
					<div className="sv-ui-card monitor-stat-pill">
						<span>FE <strong>{metrics.feIndexed}</strong> files</span>
						<span className="monitor-dot">&middot;</span>
						<span>BE <strong>{metrics.beIndexed}</strong> files</span>
					</div>
				</div>
				<button
					type="button"
					onClick={handleRescan}
					disabled={rescanning}
					className="sv-ui-button sv-ui-button-sm sv-ui-button-outline monitor-rescan"
				>
					{rescanning ? <Loader2 size={13} className="sv-spin" /> : <RefreshCw size={13} />}
					{rescanning ? 'Scanning...' : 'Rescan'}
				</button>
			</div>

			<div className="monitor-tabs">
				{tabs.map((tab) => (
					<button
						key={tab.key}
						type="button"
						onClick={() => setActiveTab(tab.key)}
						className={`sv-ui-button sv-ui-button-sm sv-ui-button-ghost monitor-tab ${activeTab === tab.key ? 'is-active' : ''}`}
					>
						{tab.label}
						<Badge variant={tab.alert && tab.count > 0 ? 'warning' : activeTab === tab.key ? 'info' : 'neutral'}>
							{tab.count}
						</Badge>
					</button>
				))}
			</div>

			<div className="monitor-content">
				{activeTab === 'verification' ? (
					<VerificationView mismatches={mismatches} />
				) : (
					<DiscoveryPanel
						items={discoveredApis}
						mismatches={mismatches}
						isLoading={isDiscovering}
						onRefresh={onRefreshDiscovery}
						onReveal={onRevealDiscoveredApi}
					/>
				)}
			</div>
		</section>
	);
}
