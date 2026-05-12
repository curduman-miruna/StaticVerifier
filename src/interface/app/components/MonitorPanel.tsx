import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, PlaySquare, RefreshCw, Zap } from 'lucide-react';
import { Badge } from './ui';
import { DiscoveryPanel } from './DiscoveryPanel';
import { VerificationView } from './VerificationView';
import type { SourceRevealTarget, VerificationIssue } from '../../../shared/messages';

type DiscoveredApi = {
	uri: string;
	method: string;
	path: string;
	requestSchema?: string;
	responseSchema?: string;
	requestHeaders?: string[];
	side: 'frontend' | 'backend';
	source: string;
	line: number;
	column: number;
};

type MonitorPanelProps = {
	metrics: {
		totalEndpoints: number;
		mismatchCount: number;
		feIndexed: number;
		beIndexed: number;
	};
	mismatches: VerificationIssue[];
	discoveredApis: DiscoveredApi[];
	isDiscovering: boolean;
	onRescan: () => Promise<void>;
	onRevealIssue?: (issue: VerificationIssue) => void;
	onRevealField?: (location: SourceRevealTarget) => void;
	onExplainIssue?: (requestId: string, issue: VerificationIssue) => void;
	onCopyIssueFix?: (issue: VerificationIssue) => void;
	aiExplanations?: Record<string, { status: 'loading' | 'done' | 'error'; text?: string; error?: string }>;
	onRevealDiscoveredApi: (item: DiscoveredApi) => void;
	onRefreshDiscovery: () => void;
	onExportOpenApi?: () => void;
	onLoadDemoSources?: () => void;
	demoActive?: boolean;
};

type ResultTab = 'verification' | 'discovered';

export function MonitorPanel({
	metrics,
	mismatches,
	discoveredApis,
	isDiscovering,
	onRescan,
	onRevealIssue,
	onRevealField,
	onExplainIssue,
	onCopyIssueFix,
	aiExplanations,
	onRevealDiscoveredApi,
	onRefreshDiscovery,
	onExportOpenApi,
	onLoadDemoSources,
	demoActive
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
	const issueCounts = {
		missingBackend: mismatches.filter((item) => item.kind === 'missing-backend').length,
		backendOnly: mismatches.filter((item) => item.kind === 'backend-only').length,
		schema: mismatches.filter((item) => item.kind === 'request-schema-mismatch' || item.kind === 'response-schema-mismatch').length,
		headers: mismatches.filter((item) => item.kind === 'header-mismatch').length
	};
	const matched = Math.max(0, Math.floor(discoveredApis.filter((item) =>
		discoveredApis.some((candidate) => candidate.side !== item.side && candidate.method === item.method && candidate.path === item.path)
	).length / 2));

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
				{onExportOpenApi ? (
					<button type="button" className="sv-ui-button sv-ui-button-sm sv-ui-button-outline monitor-action" onClick={onExportOpenApi}>
						<Download size={13} />
						OpenAPI
					</button>
				) : null}
				{onLoadDemoSources ? (
					<button type="button" className="sv-ui-button sv-ui-button-sm sv-ui-button-outline monitor-action" onClick={onLoadDemoSources}>
						<PlaySquare size={13} />
						{demoActive ? 'Undo Demo' : 'Demo'}
					</button>
				) : null}
			</div>

			<div className="demo-health" aria-label="Demo health">
				<span><strong>{discoveredApis.length}</strong> discovered</span>
				<span><strong>{matched}</strong> matched</span>
				<span><strong>{issueCounts.missingBackend}</strong> missing BE</span>
				<span><strong>{issueCounts.backendOnly}</strong> BE only</span>
				<span><strong>{issueCounts.schema}</strong> schema</span>
				<span><strong>{issueCounts.headers}</strong> headers</span>
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
				<div className={activeTab === 'verification' ? 'monitor-tab-panel is-active' : 'monitor-tab-panel'} hidden={activeTab !== 'verification'}>
					<VerificationView
						mismatches={mismatches}
						onRevealIssue={onRevealIssue}
						onRevealField={onRevealField}
						onExplainIssue={onExplainIssue}
						onCopyIssueFix={onCopyIssueFix}
						aiExplanations={aiExplanations}
					/>
				</div>
				<div className={activeTab === 'discovered' ? 'monitor-tab-panel is-active' : 'monitor-tab-panel'} hidden={activeTab !== 'discovered'}>
					<DiscoveryPanel
						items={discoveredApis}
						mismatches={mismatches}
						isLoading={isDiscovering}
						onRefresh={onRefreshDiscovery}
						onReveal={onRevealDiscoveredApi}
					/>
				</div>
			</div>
		</section>
	);
}
