import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Ban, CheckCircle2, Clock, Eye, EyeOff, History, Lock, Pin, PinOff, RefreshCw, ShieldAlert } from 'lucide-react';
import {
  getGetBotStateQueryKey, getGetDiscoveryQueryKey, getListAuditQueryKey,
  useGetDiscovery, useRefreshDiscovery, useUpdateDiscoveryCandidate, useUpdateDiscoveryRules,
} from '@workspace/api-client-react';
import type { DiscoveryCandidate, DiscoveryRanking, DiscoveryRules, RiskSettings } from '@workspace/api-client-react';
import './discovery.css';

type Tab = 'ranking' | 'candidates' | 'activity' | 'forward' | 'rejected' | 'history' | 'rules';
const tabs: { id: Tab; label: string }[] = [
  { id: 'ranking', label: 'Daily ranking' }, { id: 'candidates', label: 'Candidates' }, { id: 'activity', label: 'Observed activity' },
  { id: 'forward', label: 'Forward paper' }, { id: 'rejected', label: 'Rejected' }, { id: 'history', label: 'Ranking history' }, { id: 'rules', label: 'Rules' },
];

const num = (v: number | null | undefined, d = 2) => v == null ? null : new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(v);
const usd = (v: number | null | undefined) => v == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(v);
const when = (v?: string | null) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago' }).format(d) + ' CT'; };
const shortAddr = (a: string) => a.length > 15 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a;
const str = (v: unknown) => v == null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
function NA({ children }: { children?: ReactNode }) { return <span className="dv-na">{children ?? 'unavailable'}</span>; }
function Val({ v, signed }: { v: string | null; signed?: number | null }) { return v == null ? <NA /> : <span className={`mono ${signed == null ? '' : signed >= 0 ? 'positive' : 'negative'}`}>{v}</span>; }

export function DiscoveryView({ risk }: { risk?: RiskSettings }) {
  const qc = useQueryClient();
  const discovery = useGetDiscovery({ query: { queryKey: getGetDiscoveryQueryKey(), refetchInterval: 30000 } });
  const refresh = useRefreshDiscovery();
  const updateRules = useUpdateDiscoveryRules();
  const updateCandidate = useUpdateDiscoveryCandidate();
  const [tab, setTab] = useState<Tab>('ranking');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pendingAddr, setPendingAddr] = useState<string | null>(null);
  const d = discovery.data;

  const invalidate = () => { qc.invalidateQueries({ queryKey: getGetDiscoveryQueryKey() }); qc.invalidateQueries({ queryKey: getGetBotStateQueryKey() }); qc.invalidateQueries({ queryKey: getListAuditQueryKey() }); };
  const doRefresh = () => { setNotice(null); refresh.mutate(undefined, { onSuccess: () => { invalidate(); setNotice({ kind: 'ok', text: 'Discovery refresh requested. Results reflect only what the source returned.' }); }, onError: (e) => setNotice({ kind: 'err', text: `Refresh failed: ${e.message}` }) }); };
  const setCandidate = (address: string, data: { pinned?: boolean; excluded?: boolean }, label: string) => {
    if (data.excluded && !confirm(`Exclude ${shortAddr(address)} from automatic selection and new copy entries? Observation-only monitoring stops, but any existing attributable positions retain exit monitoring when possible.`)) return;
    if (data.excluded === false && !confirm(`Restore ${shortAddr(address)}? This opens a NEW evaluation cohort with a fresh baseline. Prior evidence does not carry over, it is not qualified, and a suspicious source flag may exclude it again.`)) return;
    setNotice(null); setPendingAddr(address);
    updateCandidate.mutate({ address, data }, {
      onSuccess: () => { invalidate(); setNotice({ kind: 'ok', text: `${label}: ${shortAddr(address)} saved.` }); },
      onError: (e) => setNotice({ kind: 'err', text: `${label} failed: ${e.message}` }),
      onSettled: () => setPendingAddr(null),
    });
  };

  const candidates = d?.candidates ?? [];
  const active = candidates.filter(c => c.state !== 'excluded');
  const rejected = candidates.filter(c => c.state === 'excluded' || c.manualExcluded);
  const latest = d?.rankings?.[0];
  const blocked = d?.status === 'blocked';

  if (discovery.isLoading) return <div className="dv"><div className="panel"><div className="skeleton-list">{[0, 1, 2, 3, 4].map(i => <div className="skeleton-row" key={i}><span /><span /><span /></div>)}</div></div></div>;
  if (discovery.isError || !d) return <div className="dv"><div className="panel error-state"><span><AlertCircle size={18} /></span><strong>Discovery state could not be loaded</strong><p>{discovery.error?.message ?? 'The API returned no discovery data.'} Nothing is shown rather than guessing.</p><button className="button button-outline" onClick={() => void discovery.refetch()} data-testid="button-retry-discovery">Retry</button></div></div>;

  return <div className="dv" data-testid="view-discovery">
    <div className="dv-derived" data-testid="text-derived-label"><b>DERIVED ACTIVITY RANKING</b><span>Not a GMGN official leaderboard and not GMGN accounts. Built from gmgn-cli market trending (24h tokens), then each token's traders ranked by buy transaction count. Activity is not evidence of profit.</span></div>

    <section className={`dv-status panel ${blocked ? 'is-blocked' : ''}`}>
      <div className="dv-status-main">
        <div className="eyebrow">DISCOVERY STATUS</div>
        <div className="dv-status-row"><span className={`dv-pill ${d.status}`} data-testid="status-discovery"><span />{d.status}</span><h2 className="display">{blocked ? 'Blocked — no candidates generated' : d.status === 'running' ? 'Observing derived candidates' : d.status === 'paused' ? 'Paused' : 'Ready'}</h2></div>
        <p data-testid="text-discovery-reason">{d.reason}</p>
      </div>
      <button className="button button-primary" onClick={doRefresh} disabled={refresh.isPending || blocked} title={blocked ? 'Unavailable while discovery is blocked' : undefined} data-testid="button-refresh-discovery"><RefreshCw size={14} className={refresh.isPending ? 'spin' : ''} />{refresh.isPending ? 'Refreshing' : 'Refresh now'}</button>
      <dl className="dv-facts">
        <div><dt>Source</dt><dd data-testid="text-source">{d.sourceLabel}</dd></div>
        <div><dt>Day ({d.timeZone})</dt><dd className="mono" data-testid="text-chicago-day">{d.chicagoDay}</dd></div>
        <div><dt>Last refresh</dt><dd className="mono">{when(d.lastRefreshAt) ?? <NA>never</NA>}</dd></div>
        <div><dt>Next refresh day</dt><dd className="mono">{d.nextRefreshDay ?? <NA>not scheduled</NA>}</dd></div>
        <div><dt>Requests last hour</dt><dd className="mono" data-testid="text-requests-hour">{d.requestsLastHour} / {d.rules.maxRequestsPerHour}</dd></div>
        <div><dt>Coverage</dt><dd>{d.coverage}</dd></div>
        <div><dt>Monitoring</dt><dd className="mono">{d.monitoringStatus}</dd></div>
        <div><dt>Periods</dt><dd className="mono">obs every {d.rules.observationIntervalMinutes}m · hist ≥{d.rules.minHistoricalDays}d · fwd ≥{d.rules.minForwardDays}d</dd></div>
      </dl>
    </section>

    {d.executionBlocked && <div className="blocked-callout dv-exec"><Lock size={17} /><div><b>Execution blocked</b><p>Verified read-only quote freshness and event identity are unavailable, so no forward paper fills can be generated. Forward metrics stay unavailable instead of reading as zero. No orders, no auto-copy.</p></div></div>}
    {notice && <div role={notice.kind === 'err' ? 'alert' : 'status'} className={notice.kind === 'err' ? 'error-banner' : 'dv-ok'} data-testid="text-discovery-notice">{notice.kind === 'err' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}<span>{notice.text}</span><button onClick={() => setNotice(null)}>Dismiss</button></div>}

    <div className="dv-tabs" role="tablist">{tabs.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} data-testid={`tab-discovery-${t.id}`}>{t.label}{t.id === 'candidates' ? <i>{active.length}</i> : t.id === 'rejected' ? <i>{rejected.length}</i> : t.id === 'activity' ? <i>{d.observations.length}</i> : null}</button>)}</div>

    {tab === 'ranking' && <RankingPanel ranking={latest} blocked={blocked} />}
    {tab === 'candidates' && <section className="panel data-panel">
      <PanelHead title="Candidates & qualification" note="Pinned = priority observation only; it does not qualify a wallet or grant copy permission. Evidence score = percentage of evidence checks passed, not expected return or skill." />
      {active.length === 0 ? <DvEmpty blocked={blocked} text="No candidates derived yet." /> : <div className="table-scroll"><table><thead><tr><th>WALLET</th><th>STATE</th><th>EVIDENCE SCORE</th><th>FIRST SEEN</th><th>OBSERVING SINCE</th><th>REASONS</th><th>ACTIONS</th></tr></thead><tbody>{active.map(c => <tr key={c.address} data-testid={`row-candidate-${c.address}`}>
        <td><Wallet c={c} /></td><td><StateTag c={c} /></td><td><Val v={c.score == null ? null : `${num(c.score, 1)}% checks`} /></td><td className="mono">{when(c.firstSeenAt) ?? <NA />}</td><td className="mono">{when(c.observationStartedAt) ?? <NA>not started</NA>}</td>
        <td className="dv-reasons"><Reasons r={c.reasons} /></td>
        <td><div className="dv-actions"><button className="button button-outline" disabled={pendingAddr === c.address} onClick={() => setCandidate(c.address, { pinned: !c.pinned }, c.pinned ? 'Unpin' : 'Pin')} data-testid={`button-pin-${c.address}`}>{c.pinned ? <PinOff size={13} /> : <Pin size={13} />}{c.pinned ? 'Unpin' : 'Pin'}</button><button className="button dv-danger" disabled={pendingAddr === c.address} onClick={() => setCandidate(c.address, { excluded: true }, 'Exclude')} data-testid={`button-exclude-${c.address}`}><Ban size={13} />Exclude</button></div></td>
      </tr>)}</tbody></table></div>}
    </section>}
    {tab === 'activity' && <section className="panel data-panel">
      <PanelHead title="Monitored observed activity" note="Observed on-chain events for monitored candidates. Observation is not execution." />
      {d.observations.length === 0 ? <DvEmpty blocked={blocked} text="No activity observed for monitored wallets." /> : <div className="table-scroll"><table><thead><tr><th>OBSERVED</th><th>DETECTED</th><th>WALLET</th><th>SIDE</th><th>TOKEN</th><th>STATUS</th><th>REASON</th></tr></thead><tbody>{d.observations.map(o => <tr key={o.id} data-testid={`row-observation-${o.id}`}><td className="mono">{when(o.observedAt) ?? <NA />}</td><td className="mono">{when(o.detectedAt) ?? <NA />}</td><td className="mono">{shortAddr(o.address)}</td><td><span className={`side-label ${o.side}`}>{o.side}</span></td><td className="mono">{shortAddr(o.tokenAddress)}</td><td><span className="signal-status">{o.status}</span></td><td className="audit-detail">{o.reason}</td></tr>)}</tbody></table></div>}
    </section>}
    {tab === 'forward' && <section className="panel data-panel">
      <PanelHead title="Forward paper metrics, after costs" note={`Qualification needs ≥${d.rules.minForwardDays} forward days, ≥${d.rules.minForwardSells} closed paper roundtrips, net ≥ ${usd(d.rules.minForwardNetPnlUsd)}, realized drawdown ≤ ${usd(d.rules.maxForwardDrawdownUsd)}.`} />
      <div className="dv-explain"><p><b>Closed roundtrips</b> count completed paper entry-to-exit cycles, not individual partial-sell fills.</p><p><b>Realized drawdown</b> is the peak-to-trough decline of cumulative net closed results only. It is not full equity drawdown; open-position risk is excluded.</p><p><b>Official hold</b> uses only completed source token start/end intervals when GMGN provides them; trades are never matched to guess it. <b>Sampled window</b> is the span of the sampled history, not wallet age. <b>Loss samples</b> are losses backed by cost evidence.</p></div>
      {candidates.length === 0 ? <DvEmpty blocked={blocked} text="No wallets under forward evaluation." /> : <div className="table-scroll"><table><thead><tr><th>WALLET</th><th>FWD DAYS</th><th>CLOSED ROUNDTRIPS</th><th>NET PNL AFTER COSTS</th><th>COSTS</th><th>REALIZED DRAWDOWN</th><th>COPYABILITY</th><th>HIST REALIZED</th><th>HIST SELLS</th><th>SAMPLED WINDOW</th><th>LOSS RATE</th><th>LOSS SAMPLES</th><th>CONCENTRATION</th><th>OFFICIAL HOLD</th></tr></thead><tbody>{candidates.map(c => { const m = c.metrics as DiscoveryCandidate['metrics'] & { historicalLossSamples?: number | null }; const noFills = !m.forwardSells; return <tr key={c.address}>
        <td><Wallet c={c} /></td><td className="mono">{m.forwardDays ?? <NA />}</td><td className="mono">{noFills ? <NA>none closed</NA> : m.forwardSells}</td>
        <td>{noFills ? <NA /> : <Val v={usd(m.forwardNetPnlUsd)} signed={m.forwardNetPnlUsd} />}</td><td>{noFills ? <NA /> : <Val v={usd(m.forwardCostsUsd)} />}</td><td>{noFills ? <NA /> : <Val v={usd(m.forwardDrawdownUsd)} />}</td>
        <td>{m.copyabilityVerified ? <span className="positive mono">verified</span> : <NA>unverified</NA>}</td><td><Val v={usd(m.historicalRealizedPnlUsd)} signed={m.historicalRealizedPnlUsd} /></td><td><Val v={num(m.historicalSells, 0)} /></td><td><Val v={m.historicalSpanDays == null ? null : `${num(m.historicalSpanDays, 1)}d sampled`} /></td><td><Val v={m.lossRatePct == null ? null : `${num(m.lossRatePct, 1)}%`} /></td><td><Val v={num(m.historicalLossSamples, 0)} /></td><td><Val v={m.concentrationPct == null ? null : `${num(m.concentrationPct, 1)}%`} /></td><td><Val v={m.holdingSeconds == null ? null : `${num(m.holdingSeconds / 60, 1)}m`} /></td>
      </tr>; })}</tbody></table></div>}
    </section>}
    {tab === 'rejected' && <section className="panel data-panel">
      <PanelHead title="Rejected & excluded candidates" note="Kept for evidence. Restore starts a new evaluation cohort and baseline. It does not qualify the wallet, and a suspicious source flag can exclude it again." />
      {rejected.length === 0 ? <DvEmpty blocked={blocked} text="No rejected candidates." /> : <div className="table-scroll"><table><thead><tr><th>WALLET</th><th>STATE</th><th>SUSPICIOUS</th><th>REASONS</th><th>ACTION</th></tr></thead><tbody>{rejected.map(c => <tr key={c.address}><td><Wallet c={c} /></td><td><StateTag c={c} /></td><td className="mono">{c.metrics.suspicious == null ? <NA /> : c.metrics.suspicious ? 'yes' : 'no'}</td><td className="dv-reasons"><Reasons r={c.reasons} /></td><td><button className="button button-outline" disabled={pendingAddr === c.address} onClick={() => setCandidate(c.address, { excluded: false }, 'Restore')} data-testid={`button-restore-${c.address}`}><Eye size={13} />Restore</button></td></tr>)}</tbody></table></div>}
    </section>}
    {tab === 'history' && <section className="panel data-panel">
      <PanelHead title="Immutable daily ranking history" note="One snapshot per America/Chicago day. Past snapshots are never rewritten." />
      {d.rankings.length === 0 ? <DvEmpty blocked={blocked} text="No ranking snapshots recorded." /> : <div className="dv-history">{d.rankings.map(r => <details key={r.id} className="dv-snap"><summary><History size={14} /><b className="mono">{r.chicagoDay}</b><span className={`dv-pill ${r.status}`}><span />{r.status}</span><small>{r.entries.length} entries · {r.coverage}</small><small className="mono">{when(r.completedAt ?? r.createdAt)}</small></summary><RankingTable ranking={r} /></details>)}</div>}
    </section>}
    {tab === 'rules' && <RulesForm rules={d.rules} risk={risk} pending={updateRules.isPending} onSave={(data, done) => { setNotice(null); updateRules.mutate({ data }, { onSuccess: () => { invalidate(); done(); setNotice({ kind: 'ok', text: 'Discovery rules saved and confirmed by the server.' }); }, onError: (e) => setNotice({ kind: 'err', text: `Rules not saved: ${e.message}` }) }); }} />}
  </div>;
}

function PanelHead({ title, note }: { title: string; note: string }) { return <div className="dv-phead"><h2 className="display">{title}</h2><p>{note}</p></div>; }
function DvEmpty({ blocked, text }: { blocked: boolean; text: string }) { return <div className="empty-state"><span className="empty-icon">{blocked ? <ShieldAlert size={17} /> : <Clock size={17} />}</span><strong>{blocked ? 'Blocked — nothing fabricated' : text}</strong><p>{blocked ? 'Discovery needs a configured API key, permissions and confirmed plan. No candidates are shown until real source data exists.' : 'Rows appear only after the source returns real data.'}</p></div>; }
function Wallet({ c }: { c: DiscoveryCandidate }) { return <div className="wallet-cell"><span className="wallet-avatar">{c.address.slice(0, 2)}</span><div><b className="mono">{shortAddr(c.address)}</b><small>{c.pinned ? 'pinned · ' : ''}{c.monitored ? 'monitored' : 'not monitored'}</small></div></div>; }
function StateTag({ c }: { c: DiscoveryCandidate }) { return <span className={`dv-state ${c.state}`}>{c.state.replace('_', ' ')}{c.manualExcluded ? ' (manual)' : ''}</span>; }
function Reasons({ r }: { r: string[] }) { return r.length ? <ul>{r.map((x, i) => <li key={i}>{x}</li>)}</ul> : <NA>none reported</NA>; }

function RankingPanel({ ranking, blocked }: { ranking?: DiscoveryRanking; blocked: boolean }) {
  return <section className="panel data-panel">
    <PanelHead title={ranking ? `Derived ranking · ${ranking.chicagoDay}` : 'Derived daily ranking'} note={ranking ? `${ranking.sourceLabel} · ${ranking.coverage} · status ${ranking.status}${ranking.completedAt ? ` · completed ${when(ranking.completedAt)}` : ''}` : 'Wallets ranked by buy transaction count among traders of 24h trending tokens.'} />
    {ranking?.error && <div className="error-banner dv-inset"><AlertCircle size={16} /><span>{ranking.error}</span></div>}
    {!ranking || ranking.entries.length === 0 ? <DvEmpty blocked={blocked} text="No ranking snapshot for today." /> : <RankingTable ranking={ranking} />}
  </section>;
}
type Entry = Record<string, unknown>;
const asObj = (v: unknown): Entry => v && typeof v === 'object' && !Array.isArray(v) ? v as Entry : {};
function provenanceOf(e: Entry) {
  const p = asObj(e.provenance);
  const raw = Array.isArray(p.sources) ? p.sources : [];
  const sources = raw.map(x => { const o = asObj(x); const token = str(o.tokenAddress ?? o.token ?? o.address); const at = str(o.fetchedAt ?? o.at ?? o.observedAt); const extra = str(o.buyTxCount ?? o.buy_tx_count_cur ?? o.reportedTokenBuyCount); const active = str(o.lastActiveTimestamp ?? o.last_active_timestamp); return { token, at, extra, active }; });
  return { fetchedAt: str(p.fetchedAt), sources };
}
const asNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const activeWhen = (v: string | null) => { if (!v) return null; const n = Number(v); return when(Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : v); };
function RankingTable({ ranking }: { ranking: DiscoveryRanking }) {
  const rows = useMemo(() => [...ranking.entries].sort((x, y) => (asNum(x.rank) ?? 1e9) - (asNum(y.rank) ?? 1e9)), [ranking.entries]);
  if (!rows.length) return <p className="muted-note dv-inset">No entries in this snapshot.</p>;
  return <>
    <div className="dv-explain"><p><b>Evidence score</b> is the percentage of evidence checks passed. It is not expected return and not a measure of wallet skill.</p><p><b>Token buy count</b> is the trader's cumulative buy count on that source token over the token's lifetime as reported by GMGN, not a daily count and not wallet returns. Every source candidate must carry a documented last_active_timestamp within the last 24h.</p><p><b>Coverage:</b> {ranking.coverage}</p></div>
    <div className="table-scroll"><table><thead><tr><th>RANK</th><th>WALLET</th><th>SOURCE TOKENS</th><th>TOKEN BUY COUNT (LIFETIME)</th><th>STATE</th><th>EVIDENCE SCORE</th><th>PROVENANCE</th><th>REASONS</th></tr></thead><tbody>{rows.map((e, i) => {
      const addr = str(e.address) ?? ''; const score = asNum(e.score); const pv = provenanceOf(e); const reasons = Array.isArray(e.reasons) ? e.reasons.map(String) : [];
      return <tr key={addr || i} data-testid={`row-ranking-${addr || i}`}>
        <td className="mono dv-rank">{asNum(e.rank) ?? <NA>—</NA>}</td>
        <td className="mono" title={addr}>{addr ? shortAddr(addr) : <NA />}</td>
        <td className="mono">{asNum(e.sourceTokenCount) ?? <NA />}</td>
        <td className="mono">{asNum(e.reportedTokenBuyCount) ?? <NA />}</td>
        <td>{str(e.state) ? <span className={`dv-state ${str(e.state)}`}>{String(e.state).replace('_', ' ')}</span> : <NA />}</td>
        <td>{score == null ? <NA /> : <span className="dv-score"><span className="mono">{num(score, 1)}%</span><i><b style={{ transform: `scaleX(${Math.max(0, Math.min(100, score)) / 100})` }} /></i><small>checks passed</small></span>}</td>
        <td className="dv-prov">{pv.sources.length || pv.fetchedAt ? <>{pv.fetchedAt && <small>fetched {when(pv.fetchedAt) ?? pv.fetchedAt}</small>}<ul>{pv.sources.map((x, j) => <li key={j}><span className="mono" title={x.token ?? ''}>{x.token ? shortAddr(x.token) : 'token n/a'}</span>{x.at && <small>{when(x.at) ?? x.at}</small>}{x.extra && <small>buys {x.extra}</small>}{x.active && <small>active {activeWhen(x.active) ?? x.active}</small>}</li>)}</ul></> : <NA>none recorded</NA>}</td>
        <td className="dv-reasons"><Reasons r={reasons} /></td>
      </tr>; })}</tbody></table></div>
  </>;
}

type NumKey = { [K in keyof DiscoveryRules]: DiscoveryRules[K] extends number ? K : never }[keyof DiscoveryRules];
const numFields: { k: NumKey; label: string; min: number; max: number; unit?: string; group: string }[] = [
  { k: 'maxRequestsPerHour', label: 'Max requests / hour', min: 1, max: 1000, group: 'Budget' },
  { k: 'maxMonitoredWallets', label: 'Max monitored wallets', min: 1, max: 25, group: 'Budget' },
  { k: 'tokenLimit', label: 'Trending tokens scanned', min: 1, max: 10, group: 'Budget' },
  { k: 'tradersPerToken', label: 'Traders per token', min: 1, max: 20, group: 'Budget' },
  { k: 'observationIntervalMinutes', label: 'Observation interval', min: 5, max: 1440, unit: 'min', group: 'Budget' },
  { k: 'minHistoricalDays', label: 'Min sampled history window', min: 1, max: 30, unit: 'd', group: 'Historical evidence' },
  { k: 'minHistoricalSells', label: 'Min historical sells', min: 1, max: 1000, group: 'Historical evidence' },
  { k: 'maxHistoricalLossRatePct', label: 'Max loss rate', min: 0, max: 100, unit: '%', group: 'Historical evidence' },
  { k: 'maxConcentrationPct', label: 'Max concentration', min: 0, max: 100, unit: '%', group: 'Historical evidence' },
  { k: 'minHoldingSeconds', label: 'Min official holding time', min: 0, max: 86400, unit: 's', group: 'Historical evidence' },
  { k: 'minForwardDays', label: 'Min forward days', min: 1, max: 90, unit: 'd', group: 'Forward evidence' },
  { k: 'minForwardSells', label: 'Min closed paper roundtrips', min: 1, max: 1000, group: 'Forward evidence' },
  { k: 'minForwardNetPnlUsd', label: 'Min forward net PnL', min: 0, max: 100000, unit: 'USD', group: 'Forward evidence' },
  { k: 'maxForwardDrawdownUsd', label: 'Max realized drawdown (closed only)', min: 0, max: 100000, unit: 'USD', group: 'Forward evidence' },
  { k: 'autoBuyBudgetUsd', label: 'Auto-buy budget (proposal)', min: 0, max: 100000, unit: 'USD', group: 'Selection' },
];

function RulesForm({ rules, risk, pending, onSave }: { rules: DiscoveryRules; risk?: RiskSettings; pending: boolean; onSave: (d: DiscoveryRules, done: () => void) => void }) {
  const [form, setForm] = useState<DiscoveryRules>(rules);
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(numFields.map(f => [f.k, String(rules[f.k])])));
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const serverKey = JSON.stringify(rules);
  const lastServer = useRef(serverKey);
  const dirty = JSON.stringify(form) !== serverKey || numFields.some(f => text[f.k] !== String(form[f.k]));
  useEffect(() => { if (lastServer.current !== serverKey && !dirty) { setForm(rules); setText(Object.fromEntries(numFields.map(f => [f.k, String(rules[f.k])]))); } lastServer.current = serverKey; }, [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const flag = (k: 'enabled' | 'selectionPaused' | 'planConfirmed' | 'excludeSuspicious', v: boolean) => { setForm(f => ({ ...f, [k]: v })); setAck(false); };

  const submit = (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    const next = { ...form };
    for (const f of numFields) { const v = Number(text[f.k]); if (text[f.k].trim() === '' || !Number.isFinite(v) || v < f.min || v > f.max) return setErr(`${f.label} must be between ${f.min} and ${f.max}.`); next[f.k] = v; }
    if (next.enabled && !next.planConfirmed) return setErr('Enabling discovery requires confirming the GMGN API plan review first.');
    if (!next.selectionPaused) {
      if (!risk?.setupComplete) return setErr('Unpausing automatic selection requires a completed risk setup (Risk settings).');
      if (!(next.autoBuyBudgetUsd > 0)) return setErr('Unpausing automatic selection requires an auto-buy budget above $0.');
      if (next.autoBuyBudgetUsd > risk.maxBuyUsd) return setErr(`Auto-buy budget must not exceed the risk max buy of ${usd(risk.maxBuyUsd)}.`);
    }
    if (!ack) return setErr('Confirm the review acknowledgement before saving.');
    onSave(next, () => setAck(false));
  };
  const groups = [...new Set(numFields.map(f => f.group))];

  return <form className="dv-rules" onSubmit={submit} data-testid="form-discovery-rules">
    <section className="panel dv-rules-intro"><div className="eyebrow">PROPOSED RULES</div><h2 className="display">Defaults are proposals, not approvals.</h2><p>Request budgets and the auto-buy budget are not approved until you review and confirm here. Enabling requires plan confirmation, never a signing key. Automatic selection can stay paused while monitoring continues; the topbar STOP halts all upstream worker queries. Nothing here publishes, activates live trading or places orders.</p></section>
    <section className="panel dv-switches">
      <Toggle label="Plan reviewed" detail="I reviewed my GMGN API plan, permissions and request limits." on={form.planConfirmed} set={v => flag('planConfirmed', v)} id="plan-confirmed" />
      <Toggle label="Discovery enabled" detail={form.planConfirmed ? 'Worker may query the derived source within the request budget.' : 'Requires plan review first.'} on={form.enabled} set={v => flag('enabled', v)} id="enabled" disabled={!form.planConfirmed && !form.enabled} />
      <Toggle label="Automatic selection paused" detail="Paused: candidates are observed only. Unpausing needs risk setup and budget within max buy." on={form.selectionPaused} set={v => flag('selectionPaused', v)} id="selection-paused" />
      <Toggle label="Exclude suspicious wallets" detail="Drop wallets the source flags as suspicious." on={form.excludeSuspicious} set={v => flag('excludeSuspicious', v)} id="exclude-suspicious" />
    </section>
    {groups.map(g => <section key={g} className="panel risk-panel"><div className="eyebrow">{g}</div><div className="risk-grid">{numFields.filter(f => f.group === g).map(f => <label key={f.k} className="risk-input">{f.label}<span className="risk-control"><input inputMode="decimal" value={text[f.k]} onChange={e => { setText(t => ({ ...t, [f.k]: e.target.value })); setAck(false); }} data-testid={`input-${f.k}`} /><small>{f.unit ?? `${f.min}–${f.max}`}</small></span></label>)}</div>{g === 'Selection' && <p className="muted-note">Risk max buy: {risk ? usd(risk.maxBuyUsd) : 'unavailable'} · risk setup {risk?.setupComplete ? 'complete' : 'incomplete'}.</p>}</section>)}
    <section className="panel dv-savebar">
      <label className="dv-ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="checkbox-ack-rules" /><span>I reviewed every value above. I understand budgets are only approved once saved, pinned wallets are not qualified, and no live orders are placed.</span></label>
      {err && <div role="alert" className="error-banner"><AlertCircle size={16} /><span>{err}</span></div>}
      <div className="dv-savebtns"><button type="button" className="button button-outline" disabled={!dirty || pending} onClick={() => { setForm(rules); setText(Object.fromEntries(numFields.map(f => [f.k, String(rules[f.k])]))); setAck(false); setErr(null); }} data-testid="button-reset-rules"><EyeOff size={13} />Discard changes</button><button type="submit" className="button button-primary" disabled={pending || !ack} data-testid="button-save-rules">{pending ? <RefreshCw size={13} className="spin" /> : <CheckCircle2 size={13} />}{pending ? 'Saving' : 'Save reviewed rules'}</button></div>
    </section>
  </form>;
}
function Toggle({ label, detail, on, set, id, disabled }: { label: string; detail: string; on: boolean; set: (v: boolean) => void; id: string; disabled?: boolean }) {
  return <div className="dv-toggle"><div><b>{label}</b><small>{detail}</small></div><button type="button" className={`switch ${on ? 'on' : ''}`} aria-pressed={on} aria-label={label} disabled={disabled} onClick={() => set(!on)} data-testid={`toggle-${id}`}><span /></button></div>;
}
