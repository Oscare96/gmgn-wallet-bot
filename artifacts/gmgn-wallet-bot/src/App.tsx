import { useEffect, useMemo, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertCircle, ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, FlaskConical, Check, ChevronDown, Compass, Download, FileClock, Gauge, LayoutDashboard, LogOut, Menu, Pause, Play, Plus, Radio, RefreshCw, Search, Shield, ShieldAlert, SlidersHorizontal, Wallet as WalletIcon, X } from 'lucide-react';
import { Redirect, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import {
  getGetBotStateQueryKey, getGetRiskSettingsQueryKey, getGetWalletResearchQueryKey,
  getHealthCheckQueryKey, getListAuditQueryKey, getListPositionsQueryKey, getListSignalsQueryKey,
  getListTradesQueryKey, getListWalletsQueryKey, useCreateWallet, useDeleteWallet,
  useGetBotState, useGetRiskSettings, useGetWalletResearch, useHealthCheck,
  useListAudit, useListPositions, useListSignals, useListTrades, useListWallets,
  useUpdateBotControl, useUpdateRiskSettings, useUpdateWallet,
} from '@workspace/api-client-react';
import type { AuditRecord, Position, RiskSettings, Signal, Trade, Wallet } from '@workspace/api-client-react';
import { DiscoveryView } from './DiscoveryView';
import { BacktestingView } from './BacktestingView';
import { ReadinessCompact } from './ProviderEvidencePanel';
import { QuoteRecoveryPanel } from './QuoteRecoveryPanel';
import './index.css';

const queryClient = new QueryClient();
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
function stripBase(path: string) { return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path; }
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
const clerkAppearance = {
  theme: shadcn, cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
  variables: {
    colorPrimary: '#26745f', colorForeground: '#203137', colorMutedForeground: '#687578', colorDanger: '#a44037',
    colorBackground: '#fbfaf6', colorInput: '#f4f1e9', colorInputForeground: '#203137', colorNeutral: '#ddd8cc',
    fontFamily: "'DM Sans', sans-serif", borderRadius: '0.7rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center', cardBox: 'bg-[#fbfaf6] rounded-2xl w-[440px] max-w-full overflow-hidden border border-[#ddd8cc]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none', footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#203137] font-semibold', headerSubtitle: 'text-[#687578]', socialButtonsBlockButtonText: 'text-[#203137]',
    formFieldLabel: 'text-[#34464b]', footerActionLink: 'text-[#26745f]', footerActionText: 'text-[#687578]',
    dividerText: 'text-[#687578]', identityPreviewEditButton: 'text-[#26745f]', formFieldSuccessText: 'text-[#26745f]',
    alertText: 'text-[#a44037]', logoBox: 'mb-3', logoImage: 'max-h-10', socialButtonsBlockButton: 'border-[#ddd8cc]',
    formButtonPrimary: 'bg-[#26745f] hover:bg-[#205f4f]', formFieldInput: 'bg-[#f4f1e9] text-[#203137] border-[#ddd8cc]',
    footerAction: 'text-[#687578]', dividerLine: 'bg-[#ddd8cc]', alert: 'bg-[#fbefec]', otpCodeFieldInput: 'border-[#ddd8cc]',
    formFieldRow: 'text-[#34464b]', main: 'text-[#203137]',
  },
};

type Section = 'Overview' | 'Discovery' | 'Backtesting' | 'Wallets' | 'Signals' | 'Positions' | 'Trades' | 'Risk settings' | 'System health' | 'Audit history';
const navItems: { label: Section; icon: typeof LayoutDashboard; group: string }[] = [
  { label: 'Overview', icon: LayoutDashboard, group: 'Workspace' },
  { label: 'Discovery', icon: Compass, group: 'Workspace' },
  { label: 'Backtesting', icon: FlaskConical, group: 'Workspace' },
  { label: 'Wallets', icon: WalletIcon, group: 'Workspace' },
  { label: 'Signals', icon: Radio, group: 'Workspace' },
  { label: 'Positions', icon: Activity, group: 'Paper book' },
  { label: 'Trades', icon: ArrowUpRight, group: 'Paper book' },
  { label: 'Risk settings', icon: SlidersHorizontal, group: 'Controls' },
  { label: 'System health', icon: Gauge, group: 'Controls' },
  { label: 'Audit history', icon: FileClock, group: 'Controls' },
];

function SignInPage() { return <div className="auth-wrap"><div className="auth-note"><Brand /><p>Private by design.<br />Paper by default.</p></div><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>; }
function SignUpPage() { return <div className="auth-wrap"><div className="auth-note"><Brand /><p>Build a private research desk<br />for wallets you choose.</p></div><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>; }
function Brand() { return <div className="brand"><span className="brand-mark"><span /></span><span>ledger<span className="brand-accent">/</span>watch</span></div>; }

function HomeRedirect() {
  return <><Show when="signed-in"><Redirect to="/terminal" /></Show><Show when="signed-out"><Landing /></Show></>;
}
function TerminalRoute() {
  return <><Show when="signed-in"><Dashboard /></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}
function Landing() {
  return <main className="landing noise">
    <header className="landing-nav"><Brand /><div className="landing-navright"><span className="privacy-tag"><span className="live-dot" /> PRIVATE WORKSPACE</span><a className="text-link" href={`${basePath}/sign-in`}>Sign in <ArrowRight size={15} /></a></div></header>
    <section className="landing-hero">
      <div className="hero-kicker"><span className="kicker-line" /> WALLET BEHAVIOR, WITHOUT THE BLIND COPY</div>
      <h1 className="display">Watch the wallets.<br /><em>Keep the wheel.</em></h1>
      <div className="hero-lower"><p>A private Solana research terminal for studying wallets you select and observing risk-limited copy decisions — without placing live orders.</p><a className="button button-dark" href={`${basePath}/sign-up`}>Create private workspace <ArrowRight size={16} /></a></div>
      <div className="hero-stamp"><div className="stamp-ring">PAPER<br />ONLY</div><span>NO LIVE EXECUTION<br />EVER ENABLED</span></div>
    </section>
    <section className="landing-proof">
      <div><span className="proof-index">01 / SELECT</span><h2>Study only the wallets<br />you explicitly choose.</h2><p>Maintain a private watchlist. Each leader stays visible and manageable on your terms.</p></div>
      <div><span className="proof-index">02 / OBSERVE</span><h2>Follow the signal,<br />inspect the decision.</h2><p>See observed activity, freshness and why a paper decision was accepted or skipped.</p></div>
      <div><span className="proof-index">03 / SIMULATE</span><h2>Bound every action<br />with paper risk.</h2><p>Positions and fills remain simulated. A visible pause control keeps the worker in hand.</p></div>
    </section>
    <footer className="landing-footer"><span>LEDGER/WATCH · PERSONAL RESEARCH TERMINAL</span><span>PRIVATE DATA · PAPER MODE · NO LIVE ORDERS</span></footer>
  </main>;
}

function Dashboard() {
  const [section, setSection] = useState<Section>('Overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<Signal | Position | Trade | AuditRecord | null>(null);
  const [walletModal, setWalletModal] = useState(false);
  const { signOut } = useClerk();
  const { user } = useUser();
  const qc = useQueryClient();
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } });
  const bot = useGetBotState({ query: { queryKey: getGetBotStateQueryKey(), refetchInterval: 12000 } });
  const wallets = useListWallets({ query: { queryKey: getListWalletsQueryKey() } });
  const signals = useListSignals({ query: { queryKey: getListSignalsQueryKey(), refetchInterval: 30000 } });
  const positions = useListPositions({ query: { queryKey: getListPositionsQueryKey(), refetchInterval: 30000 } });
  const trades = useListTrades({ query: { queryKey: getListTradesQueryKey(), refetchInterval: 30000 } });
  const risk = useGetRiskSettings({ query: { queryKey: getGetRiskSettingsQueryKey() } });
  const audit = useListAudit({ query: { queryKey: getListAuditQueryKey() } });
  const research = useGetWalletResearch(selectedWallet ?? '', { query: { enabled: !!selectedWallet, queryKey: getGetWalletResearchQueryKey(selectedWallet ?? '') } });
  const control = useUpdateBotControl();
  const createWallet = useCreateWallet();
  const updateWallet = useUpdateWallet();
  const deleteWallet = useDeleteWallet();
  const updateRisk = useUpdateRiskSettings();

  const sectionTitle = section === 'Overview' ? 'Your research desk' : section;
  const blocked = bot.data?.connectionStatus === 'missing_key' || bot.data?.workerStatus === 'blocked';
  const paused = bot.data?.paused ?? true;
  const [controlError, setControlError] = useState<string|null>('');
  const setControl = (action: 'pause' | 'resume' | 'halt_buys' | 'resume_buys' | 'stop') => {
    setControlError('');
    control.mutate({ data: { action } }, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getGetBotStateQueryKey() }); qc.invalidateQueries({ queryKey: getListAuditQueryKey() }); },
      onError: (error) => setControlError(error.message),
    });
  };
  const handlePause = () => setControl(paused ? 'resume' : 'pause');
  const refresh = () => Promise.all([health.refetch(), bot.refetch(), wallets.refetch(), signals.refetch(), positions.refetch(), trades.refetch(), risk.refetch(), audit.refetch()]);
  const exportRows = (rows: unknown[], name: string) => {
    if (!rows.length) return;
    const csv = [Object.keys(rows[0] as object).join(','), ...rows.map((r) => Object.values(r as object).map(v => {
      const text = String(v ?? '');
      const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    }).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${name}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const openSection = (s: Section) => { setSection(s); setSelectedRecord(null); setMenuOpen(false); };
  const groups = [...new Set(navItems.map(n => n.group))];
  const errorCount = [bot, wallets, signals, positions, trades, risk, audit].filter(q => q.isError).length;

  return <div className="app-shell noise">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="side-top"><Brand /><button className="icon-button side-close" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="side-context"><span className="context-overline">WORKSPACE</span><div className="context-name">Personal desk <ChevronDown size={14} /></div></div>
      <nav className="side-nav">{groups.map(group => <div key={group} className="nav-group"><div className="nav-caption">{group}</div>{navItems.filter(n => n.group === group).map(item => {
        const Icon = item.icon; return <button key={item.label} className={`nav-item ${section === item.label ? 'active' : ''}`} onClick={() => openSection(item.label)} data-testid={`nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.label === 'Signals' && signals.data?.length ? <b className="nav-count">{signals.data.length}</b> : null}</button>;
      })}</div>)}</nav>
      <div className="side-bottom">
        <div className="paper-card"><div className="paper-card-top"><span className="paper-glyph">P</span><div><strong>Paper environment</strong><small>Live orders disabled</small></div></div><div className="paper-divider" /><div className="paper-meta"><span>MODE</span><b className="mono">PAPER ONLY</b></div></div>
        <div className="profile-row"><div className="profile-avatar">{user?.firstName?.slice(0, 1) ?? 'U'}</div><div className="profile-copy"><strong>{user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? 'Private user'}</strong><small>Personal workspace</small></div><button className="icon-button logout" aria-label="Sign out" onClick={() => signOut({ redirectUrl: basePath || '/' })}><LogOut size={16} /></button></div>
      </div>
    </aside>
    {menuOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <main className="main-panel">
      <header className="topbar">
        <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
        <div className="breadcrumbs"><span>WORKSPACE</span><span className="crumb-slash">/</span><strong>{sectionTitle}</strong></div>
        <div className="top-actions"><div className={`connection-chip ${blocked ? 'is-blocked' : bot.data?.connectionStatus === 'connected' ? 'is-connected' : ''}`}><span className="status-dot" />{bot.data?.connectionStatus ? bot.data.connectionStatus.replaceAll('_', ' ') : bot.isLoading ? 'checking' : 'unavailable'}</div>
          <button className="icon-button" aria-label="Refresh data" onClick={() => void refresh()}><RefreshCw size={16} className={bot.isFetching ? 'spin' : ''} /></button>
          <button className={`button ${paused ? 'button-pause' : 'button-resume'}`} onClick={handlePause} disabled={!bot.data || control.isPending || (blocked && paused)} title={blocked && paused ? 'Unavailable until GMGN credentials are configured' : undefined} data-testid="button-pause-worker">{control.isPending ? <RefreshCw size={15} className="spin" /> : paused ? <Play size={14} /> : <Pause size={14} />}<span>{paused ? 'Resume' : 'Pause'} worker</span></button>
          <button className="button button-outline" onClick={() => setControl(bot.data?.buysHalted ? 'resume_buys' : 'halt_buys')} disabled={!bot.data || control.isPending}>{bot.data?.buysHalted ? 'Allow buys' : 'Halt buys'}</button>
          <button className="button button-stop" data-testid="button-full-stop" onClick={() => setControl('stop')} disabled={!bot.data || control.isPending}><X size={14}/> {bot.data?.fullStopped ? 'Stopped' : 'STOP'}</button>
        </div>
      </header>
      <div className="page-content enter">
        <div className="page-heading"><div><div className="eyebrow">{section === 'Overview' ? 'PRIVATE SOLANA MONITOR' : section === 'Discovery' ? 'EVIDENCE-BASED DISCOVERY' : section === 'Backtesting' ? 'HISTORICAL VALIDITY' : 'PAPER RESEARCH'}</div><h1 className="display">{sectionTitle}</h1><p>{section === 'Overview' ? 'Observe selected wallets. Decisions stay simulated.' : descriptions[section]}</p></div>
          {section === 'Wallets' && <button className="button button-primary" onClick={() => setWalletModal(true)}><Plus size={16} /> Add wallet</button>}
          {['Signals', 'Positions', 'Trades', 'Audit history'].includes(section) && <button className="button button-outline" onClick={() => exportRows((section === 'Signals' ? signals.data : section === 'Positions' ? positions.data : section === 'Trades' ? trades.data : audit.data) ?? [], section.toLowerCase().replaceAll(' ', '-'))}><Download size={15} /> Export CSV</button>}
        </div>
        {errorCount > 0 && <div className="error-banner"><AlertCircle size={17} /><span>{errorCount} data source{errorCount > 1 ? 's' : ''} could not be reached. Existing values may be unavailable.</span><button onClick={() => void refresh()}>Retry</button></div>}
        {controlError && <div role="alert" className="error-banner"><AlertCircle size={17}/><span>{controlError}</span></div>}
        <div className="blocked-callout execution-block"><ShieldAlert size={18}/><div><b>Tracking only until real-data verification</b><p>Paper fills, proportional exits, stop-loss and take-profit processing are blocked until a read-only execution-quote workflow, upstream price freshness and leader inventory are verified. No live orders can be placed. Halt buys preserves monitoring; STOP pauses all polling.</p></div></div>
        {(section === 'Overview' || section === 'System health') && <ReadinessCompact />}
        {(section === 'Overview' || section === 'System health') && <QuoteRecoveryPanel />}
        {section === 'Overview' && <Overview bot={bot.data} botLoading={bot.isLoading} botError={bot.isError} health={health.data} wallets={wallets.data} signals={signals.data} positions={positions.data} trades={trades.data} risk={risk.data} walletLoading={wallets.isLoading} onGo={openSection} onSelectSignal={setSelectedRecord} />}
        {section === 'Discovery' && <DiscoveryView risk={risk.data} />}
        {section === 'Backtesting' && <BacktestingView />}
        {section === 'Wallets' && <WalletsView rows={wallets.data} loading={wallets.isLoading} error={wallets.isError} selected={selectedWallet} research={research.data} researchLoading={research.isLoading} onSelect={setSelectedWallet} onUpdate={(address,data) => updateWallet.mutate({address,data},{onSuccess:()=>qc.invalidateQueries({queryKey:getListWalletsQueryKey()})})} onDelete={(address)=>{if(confirm('Remove this wallet from your private watchlist?')) deleteWallet.mutate({address},{onSuccess:()=>{qc.invalidateQueries({queryKey:getListWalletsQueryKey()});setSelectedWallet(null);}})}} updatePending={updateWallet.isPending} />}
        {section === 'Signals' && <SignalsView rows={signals.data} loading={signals.isLoading} error={signals.isError} onSelect={setSelectedRecord} />}
        {section === 'Positions' && <PositionsView rows={positions.data} loading={positions.isLoading} error={positions.isError} onSelect={setSelectedRecord} />}
        {section === 'Trades' && <TradesView rows={trades.data} loading={trades.isLoading} error={trades.isError} onSelect={setSelectedRecord} />}
        {section === 'Risk settings' && <RiskView risk={risk.data} loading={risk.isLoading} error={risk.isError} pending={updateRisk.isPending} onSave={(data) => updateRisk.mutate({data},{onSuccess:()=>{qc.invalidateQueries({queryKey:getGetRiskSettingsQueryKey()});qc.invalidateQueries({queryKey:getGetBotStateQueryKey()});qc.invalidateQueries({queryKey:getListAuditQueryKey()});setControlError(null);},onError:(error)=>setControlError(error.message)})} />}
        {section === 'System health' && <HealthView bot={bot.data} health={health.data} loading={bot.isLoading || health.isLoading} error={bot.isError || health.isError} />}
        {section === 'Audit history' && <AuditView rows={audit.data} loading={audit.isLoading} error={audit.isError} onSelect={setSelectedRecord} />}
        {selectedRecord && <RecordDrawer record={selectedRecord} close={() => setSelectedRecord(null)} />}
        <footer className="page-foot"><span>Private workspace · No live execution</span><span>Data reflects API observations only</span></footer>
      </div>
    </main>
    {walletModal && <WalletModal pending={createWallet.isPending} error={createWallet.error?.message} onClose={() => {setWalletModal(false);createWallet.reset();}} onCreate={(data) => createWallet.mutate({data},{onSuccess:()=>{qc.invalidateQueries({queryKey:getListWalletsQueryKey()});qc.invalidateQueries({queryKey:getGetBotStateQueryKey()});setWalletModal(false);}})} />}
  </div>;
}

const descriptions: Record<Section,string> = {
  Overview: '', Discovery: 'Derived daily activity ranking with evidence gates. Not a GMGN leaderboard.', Backtesting: 'Is a historical test valid yet? Prerequisites, coverage and an immutable request record. No simulated profits.', Wallets: 'A deliberate watchlist. Every leader is added by you.', Signals: 'Observed activity and the paper decision attached to it.',
  Positions: 'Open simulated exposure, marked only when a price is available.', Trades: 'Paper fills and closes. No live orders are sent.',
  'Risk settings': 'Define hard limits before observing copy decisions.', 'System health': 'Connection, worker state and data freshness.',
  'Audit history': 'A record of configuration and worker events.',
};
function Overview({ bot, botLoading, botError, health, wallets, signals, positions, trades, risk, walletLoading, onGo, onSelectSignal }: {
  bot?: any; botLoading:boolean; botError:boolean; health?:any; wallets?:Wallet[]; signals?:Signal[]; positions?:Position[]; trades?:Trade[]; risk?:RiskSettings; walletLoading:boolean;
  onGo:(s:Section)=>void; onSelectSignal:(s:Signal)=>void;
}) {
  const ready = !!bot && bot.connectionStatus === 'connected' && !!risk?.setupComplete && !!wallets?.some(w=>w.enabled);
  const setup = [
    { label:'Connect GMGN data access', detail: bot?.connectionStatus === 'connected' ? 'Connection established' : bot?.connectionMessage || 'Requires a GMGN API key on the server', done: bot?.connectionStatus === 'connected', section:'System health' as Section },
    { label:'Choose wallets to watch', detail: wallets?.length ? `${wallets.length} selected wallet${wallets.length === 1 ? '' : 's'}` : 'Add addresses you explicitly want to study', done: !!wallets?.some(w=>w.enabled), section:'Wallets' as Section },
    { label:'Review paper risk limits', detail: risk?.setupComplete ? 'Risk profile saved' : 'Set exposure, signal freshness and loss limits', done: !!risk?.setupComplete, section:'Risk settings' as Section },
    { label:'Start with the worker paused', detail: bot?.paused ? 'Paused — safe to inspect your setup' : 'Worker is active; pause before making changes', done: !!bot?.paused, section:'Overview' as Section },
  ];
  return <div className="overview-layout">
    {(!ready || botError) && <section className="onboarding panel">
      <div className="panel-heading"><div><div className="eyebrow">FIRST RUN</div><h2>Before you observe</h2><p>Nothing here places live orders. Complete the steps below to enable paper observation.</p></div><span className="checklist-progress">{setup.filter(x=>x.done).length}<span> / 4</span></span></div>
      <div className="checklist">{setup.map((item,i)=><button key={item.label} className={`check-row ${item.done?'complete':''}`} onClick={()=>onGo(item.section)}><span className="step-number">{item.done?<Check size={15}/>:String(i+1).padStart(2,'0')}</span><span className="check-copy"><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={16} className="check-arrow" /></button>)}</div>
      {bot?.connectionStatus === 'missing_key' && <div className="blocked-note"><ShieldAlert size={16}/><span><b>Connection blocked.</b> GMGN_API_KEY is unavailable on the server. Add it in server secrets; the browser never handles credentials.</span></div>}
      {botLoading && <div className="loading-line"><span/> Checking private workspace status…</div>}
    </section>}
    <div className="metric-grid">
      <Metric label="Paper equity" value={bot ? money(bot.equityUsd) : '—'} detail={bot ? `Cash ${money(bot.cashUsd)} · Exposure ${money(bot.exposureUsd)}` : botLoading?'Loading API data':'Not available'} icon={Gauge} />
      <Metric label="Open positions" value={bot ? String(bot.openPositionCount) : '—'} detail={positions?.length === undefined ? 'No position data' : `${positions.length} returned by API`} icon={Activity} />
      <Metric label="Watched wallets" value={bot ? `${bot.enabledWalletCount} / ${bot.walletCount}` : wallets ? String(wallets.filter(w=>w.enabled).length) : '—'} detail={walletLoading?'Loading wallet list':'Enabled / total'} icon={WalletIcon} />
      <Metric label="Connection" value={bot?.connectionStatus?.replaceAll('_',' ') ?? (health?.status ? 'API available' : '—')} detail={bot?.workerStatus ? `Worker ${bot.workerStatus}` : health?.status || 'Waiting for status'} icon={Radio} state={bot?.connectionStatus==='connected'?'good':bot?.connectionStatus==='missing_key'?'bad':''} />
    </div>
    <section className="panel overview-main">
      <div className="panel-heading"><div><div className="eyebrow">PAPER BOOK</div><h2>Equity & exposure</h2></div><span className="mode-badge">PAPER ONLY</span></div>
      <div className="equity-area">
        <div className="equity-summary"><div className="big-value display">{bot ? money(bot.equityUsd) : '—'}</div><div className="summary-label">CURRENT PAPER EQUITY</div>
          <div className="summary-pair"><span>Realized</span><b>{bot ? money(bot.realizedPnlUsd) : '—'}</b></div><div className="summary-pair"><span>Unrealized</span><b>{bot ? money(bot.unrealizedPnlUsd) : '—'}</b></div>
          <div className="summary-pair"><span>Last successful check</span><b>{bot?.lastSuccessAt ? dateTime(bot.lastSuccessAt) : 'Not reported'}</b></div>
        </div>
        <div className="equity-chart">
          {bot?.equityHistory?.length ? <EquityChart points={bot.equityHistory} /> : <div className="chart-empty"><div className="empty-graphic" aria-hidden="true"/><strong>No equity history yet</strong><small>History appears when the API reports observations.</small></div>}
          <div className="chart-foot"><span>API-reported history</span><span>{bot?.equityHistory?.length ?? 0} points</span></div>
        </div>
      </div>
    </section>
    <aside className="overview-side">
      <section className="panel worker-panel"><div className="worker-title"><div><div className="eyebrow">WORKER</div><h2>{bot?.workerStatus ?? (botLoading?'Checking…':'Unavailable')}</h2></div><span className={`worker-indicator ${bot?.workerStatus==='running'?'green':''}`}><span/></span></div>
        <p>{bot?.connectionMessage || (botError?'Worker status could not be loaded.':'Waiting for worker status from API.')}</p>
        <div className="worker-lines"><div><span>Execution mode</span><b>Paper</b></div><div><span>Live trading</span><b className="warning-text">Disabled</b></div><div><span>Observed latency</span><b>{bot?.observedLatencyMs == null?'—':`${bot.observedLatencyMs} ms`}</b></div></div>
        <button className="quiet-link" onClick={()=>onGo('System health')}>View system health <ArrowRight size={14}/></button>
      </section>
      <section className="panel latest-panel"><div className="panel-heading compact"><div><div className="eyebrow">LATEST SIGNALS</div><h2>Observed activity</h2></div><button className="text-action" onClick={()=>onGo('Signals')}>All signals <ArrowRight size={14}/></button></div>
        {signals?.length ? <div className="latest-list">{signals.slice(0,4).map(s=><button className="latest-row" key={s.id} onClick={()=>onSelectSignal(s)}><span className={`side-square ${s.side}`}>{s.side==='buy'?<ArrowDownLeft size={14}/>:<ArrowUpRight size={14}/>}</span><span className="latest-copy"><b>{s.tokenSymbol || short(s.tokenAddress)}</b><small>{s.walletLabel} · {dateTime(s.observedAt)}</small></span><span className={`signal-status ${s.status}`}>{s.status}</span></button>)}</div> : <Empty compact title={signals===undefined?'Signals unavailable':'No signals observed'} text={signals===undefined?'The API has not returned signal data.':'New observations will appear here.'} />}
      </section>
    </aside>
    <div className="overview-links"><button onClick={()=>onGo('Positions')}><span className="link-icon"><Activity size={17}/></span><span><b>Positions</b><small>{positions?.length === undefined ? 'Open the paper book' : `${positions.length} open from API`}</small></span><ArrowRight size={15}/></button><button onClick={()=>onGo('Trades')}><span className="link-icon"><ArrowUpRight size={17}/></span><span><b>Trade history</b><small>{trades?.length === undefined ? 'Review simulated fills' : `${trades.length} simulated records`}</small></span><ArrowRight size={15}/></button><button onClick={()=>onGo('Risk settings')}><span className="link-icon"><Shield size={17}/></span><span><b>Risk controls</b><small>{risk?.setupComplete?'Profile configured':'Setup required'}</small></span><ArrowRight size={15}/></button></div>
  </div>;
}
function Metric({label,value,detail,icon:Icon,state=''}:{label:string;value:string;detail:string;icon:typeof Activity;state?:string}) { return <div className="metric-card"><div className="metric-top"><span>{label}</span><Icon size={17}/></div><strong className={`metric-value display ${state}`}>{value}</strong><small>{detail}</small></div>; }
function EquityChart({points}:{points:{at:string;equityUsd:number}[]}) {
  const vals=points.map(p=>p.equityUsd); const min=Math.min(...vals), max=Math.max(...vals), spread=max-min||1;
  const line=points.map((p,i)=>`${i/(points.length-1||1)*100},${90-(p.equityUsd-min)/spread*72}`).join(' ');
  return <div className="chart-wrap"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="API-reported paper equity history"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#5fe0b0" stopOpacity=".2"/><stop offset="100%" stopColor="#5fe0b0" stopOpacity="0"/></linearGradient></defs><polygon points={`0,100 ${line} 100,100`} fill="url(#area)"/><polyline points={line} fill="none" stroke="#5fe0b0" strokeWidth="1.6" vectorEffect="non-scaling-stroke"/></svg><div className="chart-axis"><span>{dateTime(points[0].at)}</span><span>{dateTime(points[points.length-1].at)}</span></div></div>;
}
function Empty({title,text,compact=false}:{title:string;text:string;compact?:boolean}) { return <div className={`empty-state ${compact?'compact':''}`}><span className="empty-icon"><BookOpen size={17}/></span><strong>{title}</strong><p>{text}</p></div>; }
function LoadingRows() { return <div className="skeleton-list">{[0,1,2,3].map(i=><div className="skeleton-row" key={i}><span/><span/><span/></div>)}</div>; }
function TableFrame({children,headers}:{children:ReactNode;headers:string[]}) { return <div className="table-scroll"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function WalletsView({rows,loading,error,selected,research,researchLoading,onSelect,onUpdate,onDelete,updatePending}:{rows?:Wallet[];loading:boolean;error:boolean;selected:string|null;research?:any;researchLoading:boolean;onSelect:(a:string|null)=>void;onUpdate:(a:string,d:{label?:string;enabled?:boolean;buyBudgetUsd?:number})=>void;onDelete:(a:string)=>void;updatePending:boolean}) {
  const [search,setSearch]=useState('');
  const visible=useMemo(()=>rows?.filter(w=>`${w.label} ${w.address}`.toLowerCase().includes(search.toLowerCase()))??[],[rows,search]);
  return <div className={`data-layout ${selected?'has-drawer':''}`}><section className="panel data-panel"><div className="table-tools"><div className="search-box"><Search size={15}/><input placeholder="Search label or address" value={search} onChange={e=>setSearch(e.target.value)} aria-label="Search wallets"/></div><span className="result-count">{rows?.length ?? 0} wallets</span></div>
    {loading?<LoadingRows/>:error?<ErrorState retryText="Wallet list unavailable"/>:visible.length?<TableFrame headers={['WALLET','BUY BUDGET','LAST ACTIVITY','STATE','']}><>{visible.map(w=><tr key={w.address} className={`clickable-row ${selected===w.address?'selected-row':''}`} onClick={()=>onSelect(w.address)}><td><div className="wallet-cell"><span className="wallet-avatar">{(w.label||'W').slice(0,1).toUpperCase()}</span><span><b>{w.label}</b><small className="mono">{short(w.address)}</small></span></div></td><td className="mono">{money(w.buyBudgetUsd)}</td><td>{w.lastActivityAt?dateTime(w.lastActivityAt):'Not reported'}</td><td><button className={`switch ${w.enabled?'on':''}`} aria-label={`${w.enabled?'Disable':'Enable'} ${w.label}`} onClick={e=>{e.stopPropagation();onUpdate(w.address,{enabled:!w.enabled})}} disabled={updatePending}><span/></button><span className={`wallet-state ${w.enabled?'enabled':'disabled'}`}>{w.enabled?'Watching':'Paused'}</span></td><td><button className="row-action" onClick={e=>{e.stopPropagation();onSelect(w.address)}} aria-label="View wallet details"><ArrowRight size={15}/></button></td></tr>)}</></TableFrame>:<Empty title={rows?.length?'No matching wallets':'Your watchlist is empty'} text={rows?.length?'Try another label or address.':'Add a wallet address you explicitly want to research. No wallets are preselected.'}/>}
  </section>
  {selected&&<aside className="panel details-panel"><div className="detail-head"><span className="eyebrow">WALLET RESEARCH</span><button className="icon-button" onClick={()=>onSelect(null)} aria-label="Close wallet details"><X size={17}/></button></div>
    {rows?.find(w=>w.address===selected) ? <WalletDetail wallet={rows.find(w=>w.address===selected)!} research={research} loading={researchLoading} onUpdate={onUpdate} onDelete={onDelete}/> : <Empty title="Wallet not found" text="This wallet may have been removed."/>}
  </aside>}
  </div>;
}
function WalletDetail({wallet,research,loading,onUpdate,onDelete}:{wallet:Wallet;research?:any;loading:boolean;onUpdate:(a:string,d:{label?:string;enabled?:boolean;buyBudgetUsd?:number})=>void;onDelete:(a:string)=>void}) {
  const [label,setLabel]=useState(wallet.label); const [budget,setBudget]=useState(String(wallet.buyBudgetUsd));
  useEffect(()=>{setLabel(wallet.label);setBudget(String(wallet.buyBudgetUsd));},[wallet.address,wallet.label,wallet.buyBudgetUsd]);
  return <><div className="wallet-detail-title"><span className="wallet-avatar large">{wallet.label.slice(0,1).toUpperCase()}</span><div><h3>{wallet.label}</h3><span className="mono address-wrap">{wallet.address}</span></div></div>
    <div className="detail-section"><label>Label<input value={label} maxLength={48} onChange={e=>setLabel(e.target.value)} /></label><label>Buy budget <span className="input-prefix">$<input type="number" min="0.01" step="0.01" value={budget} onChange={e=>setBudget(e.target.value)}/></span></label><button className="button button-primary full-width" onClick={()=>onUpdate(wallet.address,{label:label.trim(),buyBudgetUsd:Number(budget)})} disabled={!label.trim()||Number(budget)<=0}>Save wallet</button></div>
    <div className="research-block"><div className="detail-section-title">Research metrics</div>{loading?<div className="loading-line"><span/> Loading research…</div>:research? <><div className="research-grid">{[['Sample size',research.sampleSize],['Realized PnL',research.realizedPnlUsd==null?null:money(research.realizedPnlUsd)],['Unrealized PnL',research.unrealizedPnlUsd==null?null:money(research.unrealizedPnlUsd)],['Win rate',research.winRate==null?null:`${research.winRate}%`],['Holding time',research.holdingTimeHours==null?null:`${research.holdingTimeHours} h`],['Losses',research.losses],['Concentration',research.concentrationPct==null?null:`${research.concentrationPct}%`],['Consistency',research.consistency]].map(([k,v])=><div className="research-cell" key={String(k)}><small>{k}</small><b>{v==null?'Not available':String(v)}</b></div>)}</div>{research.unavailableMetrics?.length>0&&<p className="muted-note">Unavailable: {research.unavailableMetrics.join(', ')}</p>}<small className="muted-note">Updated {research.updatedAt?dateTime(research.updatedAt):'not reported'}</small></>:<div className="muted-note">Research data is unavailable from the API.</div>}</div>
    <div className="detail-bottom"><span>Added {dateTime(wallet.createdAt)}</span><button className="danger-link" onClick={()=>onDelete(wallet.address)}>Remove wallet</button></div>
  </>;
}
function SignalsView({rows,loading,error,onSelect}:{rows?:Signal[];loading:boolean;error:boolean;onSelect:(x:Signal)=>void}) {
  const [filter,setFilter]=useState('all'); const [query,setQuery]=useState('');
  const visible=useMemo(()=>rows?.filter(r=>(filter==='all'||r.status===filter)&&`${r.walletLabel} ${r.tokenSymbol??''} ${r.tokenAddress} ${r.reason}`.toLowerCase().includes(query.toLowerCase()))??[],[rows,filter,query]);
  return <section className="panel data-panel"><div className="table-tools wrap-tools"><div className="filter-tabs">{['all','accepted','skipped','baseline'].map(f=><button className={filter===f?'selected':''} key={f} onClick={()=>setFilter(f)}>{f==='all'?'All':f}</button>)}</div><div className="search-box"><Search size={15}/><input placeholder="Find token or wallet" value={query} onChange={e=>setQuery(e.target.value)} aria-label="Search signals"/></div></div>
  {loading?<LoadingRows/>:error?<ErrorState retryText="Signal feed unavailable"/>:visible.length?<TableFrame headers={['OBSERVED','WALLET','TOKEN','SIDE','PRICE','DECISION']}><>{visible.map(s=><tr key={s.id} className="clickable-row" onClick={()=>onSelect(s)}><td>{dateTime(s.observedAt)}<small className="table-sub">Detected {dateTime(s.detectionAt)}</small></td><td>{s.walletLabel}<small className="table-sub mono">{short(s.walletAddress)}</small></td><td><b>{s.tokenSymbol||short(s.tokenAddress)}</b><small className="table-sub mono">{short(s.tokenAddress)}</small></td><td><span className={`side-label ${s.side}`}>{s.side==='buy'?<ArrowDownLeft size={13}/>:<ArrowUpRight size={13}/>} {s.side}</span></td><td className="mono">{s.priceUsd==null?'—':money(s.priceUsd)}</td><td><span className={`signal-status ${s.status}`}>{s.status}</span></td></tr>)}</></TableFrame>:<Empty title={rows?.length?'No signals match':'No observed signals'} text={rows?.length?'Adjust the filters to see other records.':'Signals appear when selected wallets are observed by the API.'}/>}</section>;
}
function PositionsView({rows,loading,error,onSelect}:{rows?:Position[];loading:boolean;error:boolean;onSelect:(x:Position)=>void}) { return <section className="panel data-panel">
  {loading?<LoadingRows/>:error?<ErrorState retryText="Positions unavailable"/>:rows?.length?<TableFrame headers={['TOKEN','LEADER','QUANTITY','COST BASIS','MARK','UNREALIZED PNL','OPENED']}><>{rows.map(p=><tr key={p.id} className="clickable-row" onClick={()=>onSelect(p)}><td><b>{p.tokenSymbol||short(p.tokenAddress)}</b><small className="table-sub mono">{short(p.tokenAddress)}</small></td><td>{p.leaderLabel}<small className="table-sub mono">{short(p.leaderAddress)}</small></td><td className="mono">{number(p.quantity)}</td><td className="mono">{money(p.costBasisUsd)}</td><td className="mono">{p.markPriceUsd==null?'Not marked':money(p.markPriceUsd)}{p.priceObservedAt&&<small className="table-sub">As of {dateTime(p.priceObservedAt)}</small>}</td><td className={`mono ${p.unrealizedPnlUsd==null?'':p.unrealizedPnlUsd>=0?'positive':'negative'}`}>{p.unrealizedPnlUsd==null?'—':money(p.unrealizedPnlUsd)}</td><td>{dateTime(p.openedAt)}</td></tr>)}</></TableFrame>:<Empty title="No open positions" text="Paper positions will appear only when returned by the API."/>
}</section>; }
function TradesView({rows,loading,error,onSelect}:{rows?:Trade[];loading:boolean;error:boolean;onSelect:(x:Trade)=>void}) { const [side,setSide]=useState('all'); const filtered=rows?.filter(t=>side==='all'||t.side===side)??[];
return <section className="panel data-panel"><div className="table-tools"><div className="filter-tabs">{['all','buy','sell'].map(f=><button className={side===f?'selected':''} key={f} onClick={()=>setSide(f)}>{f==='all'?'All fills':f}</button>)}</div><span className="result-count">{filtered.length} fills</span></div>
{loading?<LoadingRows/>:error?<ErrorState retryText="Trade history unavailable"/>:filtered.length?<TableFrame headers={['FILLED','TOKEN','SIDE','QUANTITY','PRICE','NOTIONAL','COSTS','REALIZED PNL','MODE']}><>{filtered.map(t=><tr key={t.id} className="clickable-row" onClick={()=>onSelect(t)}><td>{dateTime(t.filledAt)}</td><td><b>{t.tokenSymbol||short(t.tokenAddress)}</b><small className="table-sub mono">{short(t.tokenAddress)}</small></td><td><span className={`side-label ${t.side}`}>{t.side}</span></td><td className="mono">{number(t.quantity)}</td><td className="mono">{money(t.priceUsd)}</td><td className="mono">{money(t.notionalUsd)}</td><td className="mono">{money(t.feeUsd+t.slippageUsd)}</td><td className={`mono ${t.realizedPnlUsd==null?'':t.realizedPnlUsd>=0?'positive':'negative'}`}>{t.realizedPnlUsd==null?'—':money(t.realizedPnlUsd)}</td><td><span className="mode-badge">SIMULATED</span></td></tr>)}</></TableFrame>:<Empty title="No simulated fills yet" text="Trade records appear after the API reports paper fills or closes."/>}</section>;
}
function RiskView({risk,loading,error,pending,onSave}:{risk?:RiskSettings;loading:boolean;error:boolean;pending:boolean;onSave:(d:Partial<RiskSettings>)=>void}) {
  const [values,setValues]=useState<Record<string,string|number|boolean>>({});
  const [approved,setApproved]=useState(false);
  useEffect(()=>{if(risk)setValues({...risk,stopLossPct:risk.stopLossPct??'',takeProfitPct:risk.takeProfitPct??''});},[risk]);
  const numeric=[['maxBuyUsd','Maximum buy per signal','USD'],['totalExposureUsd','Maximum total exposure','USD'],['maxOpenPositions','Maximum open positions','positions'],['maxTradesPerDay','Maximum trades per day','trades'],['maxSignalAgeSeconds','Maximum signal age','seconds'],['minLiquidityUsd','Minimum liquidity','USD'],['maxTopHolderPct','Maximum top-holder concentration','%'],['dailyLossCutoffUsd','Daily loss cutoff','USD'],['feeBps','Estimated fees','basis points'],['slippageBps','Estimated slippage','basis points'],['latencyMs','Simulation latency','milliseconds'],['stopLossPct','Stop loss','%'],['takeProfitPct','Take profit','%'],['paperCashUsd','Paper cash balance','USD']] as const;
  const submit=(e:FormEvent)=>{e.preventDefault();if(!approved)return;const d:Record<string,unknown>={};for(const [k,v] of Object.entries(values)){if(k==='setupComplete')continue;if(k==='followSells'){d[k]=v;continue;}if(v===''){if(k==='stopLossPct'||k==='takeProfitPct')d[k]=null;continue;}const n=Number(v);if(Number.isFinite(n))d[k]=n;}d.setupComplete=true;onSave(d as Partial<RiskSettings>);};
  if(loading)return <section className="panel data-panel"><LoadingRows/></section>; if(error)return <ErrorState retryText="Risk settings unavailable"/>; if(!risk)return <Empty title="Risk settings unavailable" text="The API has not returned a risk profile." />;
  return <form className="risk-form" onSubmit={submit}><section className="panel risk-intro"><div className="risk-symbol"><Shield size={23}/></div><div><span className="eyebrow">PAPER CONTROLS</span><h2>Capital protection first.</h2><p>These limits constrain paper decisions only. Live trading remains disabled.</p></div><div className="risk-status"><span className={risk.setupComplete?'healthy-dot':'warning-dot'} />{risk.setupComplete?'Configured':'Setup incomplete'}</div></section>
    <section className="panel risk-panel"><div className="panel-heading"><div><div className="eyebrow">REQUESTED PAPER PROPOSAL</div><h2>$1,000 virtual cash · $20 buy cap · $100 exposure cap</h2></div></div><p>Load these three proposed values, review the remaining risk and cost assumptions, then explicitly confirm setup. Loading or saving does not start monitoring or enable real trades.</p><button type="button" className="button button-secondary" data-testid="button-load-paper-proposal" onClick={()=>{setValues(s=>({...s,paperCashUsd:1000,maxBuyUsd:20,totalExposureUsd:100}));setApproved(false);}}>Load proposed paper settings</button></section>
    <section className="panel risk-panel"><div className="panel-heading"><div><div className="eyebrow">EXPOSURE & FREQUENCY</div><h2>Hard limits</h2></div></div><div className="risk-grid">{numeric.slice(0,8).map(([key,label,unit])=><RiskInput key={key} name={key} label={label} unit={unit} value={values[key]??''} onChange={v=>setValues(s=>({...s,[key]:v}))}/>)}</div></section>
    <section className="panel risk-panel"><div className="panel-heading"><div><div className="eyebrow">SIMULATION MODEL</div><h2>Costs, timing & exits</h2></div></div><div className="risk-grid">{numeric.slice(8).map(([key,label,unit])=><RiskInput key={key} name={key} label={label} unit={unit} value={values[key]??''} onChange={v=>setValues(s=>({...s,[key]:v}))}/>)}</div><label className="toggle-line"><span><b>Follow leader sells</b><small>Mirror sell observations in the paper book.</small></span><input type="checkbox" checked={!!values.followSells} onChange={e=>setValues(s=>({...s,followSells:e.target.checked}))}/></label></section>
    <label className="toggle-line"><span><b>I reviewed these suggested limits and set my paper cash budget.</b><small>Saving confirms paper setup only. Automated fills and exits remain blocked pending real-data verification.</small></span><input type="checkbox" required checked={approved} onChange={e=>setApproved(e.target.checked)}/></label>
    <div className="risk-savebar"><span>Changes apply to paper decisions only.</span><button className="button button-primary" type="submit" disabled={pending||!approved}>{pending?<RefreshCw size={15} className="spin"/>:<Check size={15}/>} Confirm paper setup</button></div>
  </form>;
}
function RiskInput({name,label,unit,value,onChange}:{name:string;label:string;unit:string;value:string|number|boolean;onChange:(v:string)=>void}) { const nullable=name==='stopLossPct'||name==='takeProfitPct'; return <label className="risk-input"><span>{label}</span><div className="risk-control"><input type="number" min={nullable?0:undefined} step="any" value={String(value)} placeholder={nullable?'Off':''} onChange={e=>onChange(e.target.value)} /><small>{unit}</small>{nullable&&<button type="button" className="clear-risk" onClick={()=>onChange('')}>Clear</button>}</div></label>; }
function HealthView({bot,health,loading,error}:{bot?:any;health?:any;loading:boolean;error:boolean}) { return <div className="health-grid">{loading?<section className="panel data-panel"><LoadingRows/></section>:error?<ErrorState retryText="Health status unavailable"/>:<>
  <section className="panel health-summary"><div className="health-mark"><Activity size={25}/></div><div><div className="eyebrow">SYSTEM STATUS</div><h2>{bot?.connectionStatus==='connected'?'Connected':bot?.connectionStatus?.replaceAll('_',' ')||'Unavailable'}</h2><p>{bot?.connectionMessage||'No connection message has been reported.'}</p></div><span className={`health-pill ${bot?.connectionStatus==='connected'?'ok':'blocked'}`}><span/>{bot?.connectionStatus||'unknown'}</span></section>
  <section className="panel health-panel"><div className="panel-heading"><div><div className="eyebrow">RUNTIME</div><h2>Worker & API</h2></div></div><HealthLine title="Health endpoint" value={health?.status??'No response'} good={health?.status==='ok'||health?.status==='healthy'}/><HealthLine title="Worker" value={bot?.workerStatus??'Not reported'} good={bot?.workerStatus==='running'}/><HealthLine title="Last successful observation" value={bot?.lastSuccessAt?dateTime(bot.lastSuccessAt):'Not reported'}/><HealthLine title="Observed signal detection delay" value={bot?.observedLatencyMs==null?'Not reported':`${bot.observedLatencyMs} ms`}/><HealthLine title="Connection details" value={bot?.connectionMessage??'Not reported'}/></section>
  <section className="panel health-panel"><div className="panel-heading"><div><div className="eyebrow">SAFETY INVARIANTS</div><h2>Execution boundaries</h2></div></div><HealthLine title="Mode" value="Paper only" good/><HealthLine title="Live trading" value="Disabled" good/><HealthLine title="GMGN API key" value={bot?.connectionStatus==='missing_key'?'Unavailable on server':'Never shown in browser'} good={bot?.connectionStatus!=='missing_key'}/><HealthLine title="Worker paused" value={bot?.paused?'Yes':'No'} good={!!bot?.paused}/></section>
  {bot?.connectionStatus==='missing_key'&&<section className="blocked-callout"><ShieldAlert size={19}/><div><b>GMGN connection blocked</b><p>GMGN_API_KEY is unavailable. Configure it as a server secret, then refresh this view. Do not paste credentials into the browser.</p></div></section>}
  </>}</div>; }
function HealthLine({title,value,good}:{title:string;value:string;good?:boolean}) { return <div className="health-line"><span>{title}</span><b className={good?'health-good':''}>{good&&<Check size={13}/>} {value}</b></div>; }
function AuditView({rows,loading,error,onSelect}:{rows?:AuditRecord[];loading:boolean;error:boolean;onSelect:(x:AuditRecord)=>void}) { return <section className="panel data-panel">
  {loading?<LoadingRows/>:error?<ErrorState retryText="Audit history unavailable"/>:rows?.length?<TableFrame headers={['TIME','ACTION','DETAIL','RECORD']}><>{rows.map(r=><tr key={r.id} className="clickable-row" onClick={()=>onSelect(r)}><td>{dateTime(r.createdAt)}</td><td><span className="audit-action">{r.action}</span></td><td className="audit-detail">{r.detail}</td><td><span className="mono table-sub">{short(r.id)}</span></td></tr>)}</></TableFrame>:<Empty title="No audit events" text="Worker and settings changes will appear when reported by the API."/>}</section>; }
function ErrorState({retryText}:{retryText:string}) { return <div className="error-state"><span><AlertCircle size={19}/></span><strong>{retryText}</strong><p>Data is not fabricated or cached into a sample view. Try again when the service is available.</p><button onClick={()=>window.location.reload()} className="button button-outline"><RefreshCw size={14}/> Reload workspace</button></div>; }
function WalletModal({pending,error,onClose,onCreate}:{pending:boolean;error?:string;onClose:()=>void;onCreate:(d:{address:string;label:string;buyBudgetUsd:number})=>void}) {
  const [address,setAddress]=useState('');const [label,setLabel]=useState('');const [budget,setBudget]=useState('');
  const submit=(e:FormEvent)=>{e.preventDefault();if(address.length<32||address.length>44||!label.trim()||Number(budget)<=0)return;onCreate({address:address.trim(),label:label.trim(),buyBudgetUsd:Number(budget)});};
  return <div className="modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><form className="wallet-modal" onSubmit={submit}><div className="modal-head"><div><div className="eyebrow">WATCHLIST</div><h2>Add a wallet</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={18}/></button></div><p className="modal-intro">Only addresses you provide are tracked. Adding a wallet does not connect your wallet or enable execution.</p>
    {error&&<p className="negative" role="alert">{error.slice(0,250)}</p>}
    <label className="form-field">Solana wallet address<input required minLength={32} maxLength={44} value={address} onChange={e=>setAddress(e.target.value)} placeholder="Paste public address" className="mono"/></label>
    <label className="form-field">Research label<input required maxLength={48} value={label} onChange={e=>setLabel(e.target.value)} placeholder="A name you'll recognize"/></label>
    <label className="form-field">Paper buy budget <span className="field-suffix"><input required type="number" min=".01" step=".01" value={budget} onChange={e=>setBudget(e.target.value)} placeholder="0.00"/><small>USD</small></span></label>
    <div className="modal-foot"><span className="safe-caption"><Shield size={14}/> Paper only</span><button className="button button-primary" disabled={pending}>{pending?<RefreshCw size={15} className="spin"/>:<Plus size={15}/>} Add to watchlist</button></div>
  </form></div>;
}
function RecordDrawer({record,close}:{record:Signal|Position|Trade|AuditRecord;close:()=>void}) {
  const isSignal='walletAddress'in record;const isPosition='costBasisUsd'in record;const isTrade='filledAt'in record;const data=Object.entries(record).filter(([k])=>k!=='id');
  const title=isSignal?'Signal detail':isPosition?'Position detail':isTrade?'Simulated fill':'Audit record';
  return <div className="drawer-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><aside className="record-drawer"><div className="detail-head"><div><div className="eyebrow">RECORD DETAILS</div><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="Close record"><X size={18}/></button></div><div className="drawer-id mono">{record.id}</div><div className="drawer-fields">{data.map(([key,value])=><div className="drawer-field" key={key}><span>{humanize(key)}</span><b className={key.toLowerCase().includes('pnl')&&typeof value==='number'?(value>=0?'positive':'negative'):''}>{formatField(key,value)}</b></div>)}</div><div className="drawer-disclaimer"><Shield size={15}/><span>Paper research record. No live order was placed.</span></div></aside></div>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk(); const qc = useQueryClient(); const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => { const unsubscribe = addListener(({ user }) => { const userId = user?.id ?? null; if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) qc.clear(); prevUserIdRef.current = userId; }); return unsubscribe; }, [addListener,qc]);
  return null;
}
function ClerkProviderWithRoutes() {
  const [,setLocation]=useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{signIn:{start:{title:'Welcome back',subtitle:'Sign in to your private research desk'}},signUp:{start:{title:'Create your workspace',subtitle:'Private wallet research, paper mode only'}}}}
    routerPush={to=>setLocation(stripBase(to))} routerReplace={to=>setLocation(stripBase(to),{replace:true})}>
    <QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator/><Switch>
      <Route path="/" component={HomeRedirect}/>
      <Route path="/sign-in/*?" component={SignInPage}/>
      <Route path="/sign-up/*?" component={SignUpPage}/>
      <Route path="/terminal" component={TerminalRoute}/>
      <Route component={()=><Redirect to="/"/>}/>
    </Switch></QueryClientProvider>
  </ClerkProvider>;
}
function App() { return <WouterRouter base={basePath}><ClerkProviderWithRoutes/></WouterRouter>; }
export default App;

function money(value:number) { return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value); }
function number(value:number) { return new Intl.NumberFormat('en-US',{maximumFractionDigits:8}).format(value); }
function dateTime(value:string) { const d=new Date(value); return Number.isNaN(d.getTime())?'Not reported':new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d); }
function short(value:string) { return value.length>15?`${value.slice(0,6)}…${value.slice(-5)}`:value; }
function humanize(v:string) { return v.replace(/([A-Z])/g,' $1').replaceAll('_',' ').replace(/^./,s=>s.toUpperCase()); }
function formatField(key:string,value:unknown) { if(value===null||value===undefined||value==='')return 'Not available'; if(typeof value==='boolean')return value?'Yes':'No'; if(typeof value==='number'&&key.toLowerCase().includes('price'))return money(value); if(typeof value==='string'&&/At$/.test(key))return dateTime(value); if(typeof value==='string'&&/address|hash/i.test(key)&&value.length>16)return value; return String(value); }
