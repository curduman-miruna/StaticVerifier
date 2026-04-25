import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Zap } from 'lucide-react';
import { Badge, Button, Card } from './ui';
import { DiscoveryPanel } from './DiscoveryPanel';
import { VerificationView } from './VerificationView';

type MonitorPanelProps = {
	metrics: {
		totalEndpoints: number;
		mismatchCount: number;
		feIndexed: number;
		beIndexed: number;
	};
	mismatches: Array<{
		file: string;
		line: number;
		column: number;
		severity: 'error' | 'warning' | 'info';
		message: string;
	}>;
	discoveredApis: Array<{
		uri: string;
		method: string;
		path: string;
		requestSchema?: string;
		responseSchema?: string;
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
					<Card className="monitor-stat-pill">
						<Zap size={13} />
						<span><strong>{metrics.totalEndpoints}</strong> endpoints</span>
					</Card>
					<Card className={`monitor-stat-pill ${metrics.mismatchCount > 0 ? 'is-warn' : 'is-ok'}`}>
						{metrics.mismatchCount > 0 ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
						<span>
							<strong>{metrics.mismatchCount}</strong> mismatch{metrics.mismatchCount !== 1 ? 'es' : ''}
						</span>
					</Card>
					<Card className="monitor-stat-pill">
						<span>FE <strong>{metrics.feIndexed}</strong> files</span>
						<span className="monitor-dot">·</span>
						<span>BE <strong>{metrics.beIndexed}</strong> files</span>
					</Card>
				</div>
				<Button onClick={handleRescan} disabled={rescanning} variant="outline" size="sm" className="monitor-rescan">
					{rescanning ? <Loader2 size={13} className="sv-spin" /> : <RefreshCw size={13} />}
					{rescanning ? 'Scanning...' : 'Rescan'}
				</Button>
			</div>

			<div className="monitor-tabs">
				{tabs.map((tab) => (
					<Button
						key={tab.key}
						onClick={() => setActiveTab(tab.key)}
						variant="ghost"
						size="sm"
						className={`monitor-tab ${activeTab === tab.key ? 'is-active' : ''}`}
					>
						{tab.label}
						<Badge variant={tab.alert && tab.count > 0 ? 'warning' : activeTab === tab.key ? 'info' : 'neutral'}>
							{tab.count}
						</Badge>
					</Button>
				))}
			</div>

			<div className="monitor-content">
				{activeTab === 'verification' ? (
					<VerificationView mismatches={mismatches} />
				) : (
					<DiscoveryPanel
						items={discoveredApis}
						isLoading={isDiscovering}
						onRefresh={onRefreshDiscovery}
						onReveal={onRevealDiscoveredApi}
					/>
				)}
			</div>
		</section>
	);
}
