import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Ban, CheckCircle2, CircleDashed, Database, FileJson, FileSpreadsheet, History, Lock, RefreshCw, ShieldAlert, Snowflake } from 'lucide-react';
import { getBacktestReport, getGetBacktestingQueryKey, useGetBacktesting, useRequestBacktest } from '@workspace/api-client-react';
import type { BacktestAssessment, HistoricalTestRequest, HistoricalTestRun } from '@workspace/api-client-react';
import { ProviderEvidencePanel } from './ProviderEvidencePanel';
import { QuoteRecoveryPanel } from './QuoteRecoveryPanel';
import './backtesting.css';

const when = (v?: string | null) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago' }).format(d) + ' CT'; };
const day = (v?: string | null) => v ? (when(v)?.split(',').slice(0, 2).join(',') ?? v) : null;
function NA({ children }: { children?: ReactNode }) { return <span className="dv-na">{children ?? 'unavailable'}</span>; }
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const todayUtc = () => new Date().toISOString().slice(0, 10);
type DateKey = 'developmentStart' | 'developmentEnd' | 'evaluationStart' | 'evaluationEnd';
const dateFields: { k: DateKey; label: string; group: 'Development' | 'Evaluation' }[] = [
  { k: 'developmentStart', label: 'Start', group: 'Development' }, { k: 'developmentEnd', label: 'End', group: 'Development' },
  { k: 'evaluationStart', label: 'Start', group: 'Evaluation' }, { k: 'evaluationEnd', label: 'End', group: 'Evaluation' },
];

function validateDates(f: Record<DateKey, string>): string | null {
  const vals = dateFields.map(d => f[d.k].trim());
  const filled = vals.filter(Boolean).length;
  if (filled === 0) return null;
  if (filled < 4) return 'Enter all four dates, or leave all four blank to record a prerequisite assessment only.';
  for (const d of dateFields) if (!ISO.test(f[d.k].trim()) || Number.isNaN(Date.parse(f[d.k] + 'T00:00:00Z'))) return `${d.group} ${d.label.toLowerCase()} must be a valid YYYY-MM-DD date.`;
  const [ds, de, es, ee] = vals;
  if (ds > de) return 'Development start must be on or before development end.';
  if (de >= es) return 'Evaluation must begin after development ends. Windows cannot overlap.';
  if (es > ee) return 'Evaluation start must be on or before evaluation end.';
  if (ee >= todayUtc()) return `Evaluation end must be before the current UTC day (${todayUtc()}). The server also enforces this.`;
  return null;
}

const csvCell = (v: unknown) => {
  const text = v == null ? 'null' : String(v);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
function reportCsv(r: HistoricalTestRun) {
  const rows: unknown[][] = [['section', 'field', 'value', 'detail']];
  const p = (s: string, f: string, v: unknown, d: unknown = '') => rows.push([s, f, v, d]);
  p('run', 'id', r.id); p('run', 'kind', r.kind); p('run', 'status', r.status); p('run', 'validity', r.validity); p('run', 'profitability', r.profitability);
  p('run', 'requestedAt', r.requestedAt); p('run', 'assessedAt', r.assessedAt); p('run', 'startedAt', r.startedAt); p('run', 'completedAt', r.completedAt);
  p('run', 'progressPct', r.progressPct); p('run', 'processedTrades', r.processedTrades); p('run', 'liveTradingEnabled', r.liveTradingEnabled);
  dateFields.forEach(d => p('request', d.k, r.request[d.k] ?? null)); p('request', 'freezeRules', r.request.freezeRules ?? null);
  p('rules', 'rulesHash', r.rulesHash); p('rules', 'rulesFrozenAt', r.rulesFrozenAt);
  const m = r.performance;
  p('metrics', 'trades', m.trades); p('metrics', 'netReturnAfterCostsPct', m.netReturnAfterCostsPct); p('metrics', 'maxDrawdownPct', m.maxDrawdownPct); p('metrics', 'winRatePct', m.winRatePct); p('metrics', 'profitFactor', m.profitFactor);
  p('metrics', 'walletBreakdownRows', m.walletBreakdown.length); p('metrics', 'monthlyBreakdownRows', m.monthlyBreakdown.length); p('metrics', 'failureRows', m.failures.length);
  const a = r.assessment;
  p('assessment', 'status', a.status); p('assessment', 'checkedAt', a.checkedAt); p('assessment', 'apiKeyPresent', a.apiKeyPresent); p('assessment', 'permissions', a.permissions); p('assessment', 'gmgnQueriesAttempted', a.gmgnQueriesAttempted); p('assessment', 'fullStrategyAvailable', a.fullStrategyAvailable);
  a.prerequisites.forEach(x => p('prerequisite', x.code, x.status, `${x.detail} | Resolution: ${x.resolution}`));
  a.coverage.forEach(c => p('coverage', c.name, c.records, `from ${c.from ?? 'null'} to ${c.to ?? 'null'} | scope: ${c.scope} | limitation: ${c.limitation}`));
  a.sources.forEach((s, i) => p('source', String(i + 1), s)); a.limitations.forEach((s, i) => p('limitation', String(i + 1), s)); r.assumptions.forEach((s, i) => p('assumption', String(i + 1), s));
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}
function download(content: string, name: string, type: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 500); }

const calendarDay = (value?: string) => value ? value.slice(0, 10) : 'unavailable';
export function BacktestingView() {
  const qc = useQueryClient();
  const bt = useGetBacktesting({ query: { queryKey: getGetBacktestingQueryKey(), refetchInterval: (q) => q.state.data?.runs.some(r => r.status === 'assessing' || r.status === 'running') ? 12000 : false } });
  const request = useRequestBacktest();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const d = bt.data;
  const runs = useMemo(() => [...(d?.runs ?? [])].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)), [d?.runs]);
  const selected = runs.find(r => r.id === selectedId) ?? runs[0];

  const submit = (data: HistoricalTestRequest, done: () => void) => {
    setNotice(null);
    request.mutate({ data }, {
      onSuccess: (run) => { qc.invalidateQueries({ queryKey: getGetBacktestingQueryKey() }); setSelectedId(run.id); done(); setNotice({ kind: 'ok', text: `Request recorded as ${run.status}. ${run.status === 'blocked' ? 'No simulation was started.' : ''} Run ${run.id.slice(0, 8)} is now in the immutable history.` }); },
      onError: (e) => { const stale = (e as { status?: number }).status === 409 || /409|stale/i.test(e.message); if (stale) qc.invalidateQueries({ queryKey: getGetBacktestingQueryKey() }); setNotice({ kind: 'err', text: stale ? 'Rule preview was stale (409). The proposed rules have been reloaded; review the new hash and submit again.' : `Request not recorded: ${e.message}` }); },
    });
  };
  const exportReport = async (id: string, fmt: 'json' | 'csv') => {
    setExporting(`${id}-${fmt}`); setNotice(null);
    try {
      const r = await getBacktestReport(id);
      if (fmt === 'json') download(JSON.stringify(r, null, 2), `historical-test-${r.status}-${id}.json`, 'application/json');
      else download(reportCsv(r), `historical-test-${r.status}-${id}.csv`, 'text/csv');
      setNotice({ kind: 'ok', text: `Exported freshly retrieved ${fmt.toUpperCase()} report (status ${r.status}, validity: ${r.validity}).` });
    } catch (e) { setNotice({ kind: 'err', text: `Export failed: ${e instanceof Error ? e.message : 'unknown error'}` }); }
    finally { setExporting(null); }
  };

  if (bt.isLoading) return <div className="bt"><div className="panel"><div className="skeleton-list">{[0, 1, 2, 3, 4].map(i => <div className="skeleton-row" key={i}><span /><span /><span /></div>)}</div></div></div>;
  if (bt.isError || !d) return <div className="bt"><div className="panel error-state"><span><AlertCircle size={18} /></span><strong>Backtesting state could not be loaded</strong><p>{bt.error?.message ?? 'The API returned no data.'} Nothing is shown rather than guessing.</p><button className="button button-outline" onClick={() => void bt.refetch()} data-testid="button-retry-backtesting">Retry</button></div></div>;
  const a = d.assessment;
  const blocked = a.status !== 'ready';

  return <div className="bt" data-testid="view-backtesting">
    <section className={`panel bt-verdict ${a.status}`}>
      <div className="bt-verdict-main">
        <div className="eyebrow">PREREQUISITE ASSESSMENT · NOT A SIMULATION</div>
        <div className="bt-verdict-row"><span className={`dv-pill ${a.status}`} data-testid="status-assessment"><span />{a.status}</span><h2 className="display">{a.status === 'ready' ? 'Prerequisites reported ready' : a.status === 'blocked' ? 'Historical testing is not valid yet' : 'Validity inconclusive'}</h2></div>
        <p data-testid="text-backtesting-notification">{d.notification}</p>
      </div>
      <dl className="bt-facts">
        <div><dt>Assessed</dt><dd className="mono" data-testid="text-assessed-at">{when(a.checkedAt) ?? <NA />}</dd></div>
        <div><dt>API key on server</dt><dd className={a.apiKeyPresent ? 'positive' : 'negative'}>{a.apiKeyPresent ? 'present' : 'missing'}</dd></div>
        <div><dt>Permissions</dt><dd className="mono">{a.permissions}</dd></div>
        <div><dt>GMGN queries attempted</dt><dd className="mono">{a.gmgnQueriesAttempted ? 'yes' : 'no'}</dd></div>
        <div><dt>Whole-strategy replay</dt><dd className={a.fullStrategyAvailable ? 'positive' : 'negative'}>{a.fullStrategyAvailable ? 'available' : 'unavailable'}</dd></div>
        <div><dt>Live trading</dt><dd className="negative mono">disabled</dd></div>
      </dl>
    </section>

    <section className="bt-compare">
      <div className="bt-method valid"><div className="eyebrow">THE ONLY VALID TEST</div><h3 className="display">Whole-strategy, point-in-time</h3><p>Replays discovery as it would have run each historical day, including wallets that later went quiet or lost, tokens that delisted, rugged or became untradeable, with prices, liquidity and security data as they were then. Requires a validated historical archive and replay engine. <b>Currently unsupported.</b></p></div>
      <div className="bt-method biased"><div className="eyebrow">NOT OFFERED · BIASED</div><h3 className="display">Replay of today's selected wallets</h3><p>Testing wallets chosen today on their own past is survivorship and look-ahead bias: they were picked because they already did well. It would produce an attractive chart that predicts nothing. This app does not run it.</p></div>
    </section>

    <div className="blocked-callout bt-why"><Lock size={17} /><div><b>Why an API key alone does not unblock this</b><p>Adding GMGN_API_KEY in server Secrets (read-only; never a signing or wallet key) enables current queries only. It does not supply a historical point-in-time universe with losing and inactive wallets, delisted or untradeable tokens, and no official historical ranking, price, liquidity or security coverage has been validated. Fills are never fabricated from guessed prices. Forward paper evaluation in Discovery {d.forwardEvaluationSeparate ? 'remains separate' : 'is reported as not separate'} and is not a backtest substitute.</p></div></div>

    {notice && <div role={notice.kind === 'err' ? 'alert' : 'status'} className={notice.kind === 'err' ? 'error-banner' : 'dv-ok'} data-testid="text-backtesting-notice">{notice.kind === 'err' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}<span>{notice.text}</span><button onClick={() => setNotice(null)}>Dismiss</button></div>}

    <ProviderEvidencePanel />
    <QuoteRecoveryPanel />

    <AssessmentDetail a={a} title="Current prerequisites" />

    <div className="bt-split">
      <RequestForm blocked={blocked} pending={request.isPending} onSubmit={submit} proposedRules={d.proposedRules} proposedRulesHash={d.proposedRulesHash} />
      <section className="panel bt-history">
        <div className="dv-phead"><h2 className="display">Immutable run history</h2><p>Every request is recorded and never rewritten. Select a run for its full record.</p></div>
        {runs.length === 0 ? <div className="empty-state compact"><span className="empty-icon"><History size={17} /></span><strong>No requests recorded</strong><p>Recording an assessment creates the first immutable entry.</p></div> :
          <ul className="bt-runs">{runs.map(r => <li key={r.id}><button className={selected?.id === r.id ? 'on' : ''} onClick={() => setSelectedId(r.id)} data-testid={`row-run-${r.id}`}><span className={`dv-pill ${r.status}`}><span />{r.status}</span><span className="bt-run-copy"><b className="mono">{r.id.slice(0, 8)}</b><small>requested {when(r.requestedAt) ?? 'unknown'}</small></span><small className="mono">{r.request.evaluationStart ? `${calendarDay(r.request.evaluationStart)} → ${calendarDay(r.request.evaluationEnd)}` : 'no dates'}</small></button></li>)}</ul>}
      </section>
    </div>

    {selected && <RunDetail r={selected} exporting={exporting} onExport={exportReport} />}
  </div>;
}

function statusIcon(s: string) { return s === 'verified' ? <CheckCircle2 size={14} /> : s === 'missing' ? <Ban size={14} /> : s === 'partial' ? <CircleDashed size={14} /> : <ShieldAlert size={14} />; }

function AssessmentDetail({ a, title }: { a: BacktestAssessment; title: string }) {
  return <section className="panel bt-assess">
    <div className="dv-phead"><h2 className="display">{title}</h2><p>Checked {when(a.checkedAt) ?? 'at an unknown time'} · {a.prerequisites.filter(p => p.status === 'verified').length} of {a.prerequisites.length} verified</p></div>
    <ol className="bt-prereqs">{a.prerequisites.map(p => <li key={p.code} className={p.status} data-testid={`prereq-${p.code}`}>
      <span className="bt-pstatus">{statusIcon(p.status)}{p.status}</span>
      <div><b className="mono">{p.code}</b><p>{p.detail}</p><p className="bt-resolution"><span>Resolution</span>{p.resolution}</p></div>
    </li>)}</ol>
    <div className="dv-phead bt-sub"><h3 className="display"><Database size={14} /> Historical coverage actually held</h3><p>Counts and ranges reported by the server. Zero means zero.</p></div>
    {a.coverage.length === 0 ? <p className="muted-note bt-inset">No coverage entries reported.</p> : <div className="table-scroll"><table><thead><tr><th>DATASET</th><th>RECORDS</th><th>FROM</th><th>TO</th><th>SCOPE</th><th>LIMITATION</th></tr></thead><tbody>{a.coverage.map(c => <tr key={c.name}><td><b>{c.name}</b></td><td className={`mono ${c.records === 0 ? 'negative' : ''}`}>{c.records}</td><td className="mono">{day(c.from) ?? <NA>none</NA>}</td><td className="mono">{day(c.to) ?? <NA>none</NA>}</td><td className="audit-detail">{c.scope}</td><td className="audit-detail">{c.limitation}</td></tr>)}</tbody></table></div>}
    <div className="bt-lists">
      <div><div className="eyebrow">SOURCES</div>{a.sources.length ? <ul>{a.sources.map((s, i) => <li key={i}>{s}</li>)}</ul> : <NA>none reported</NA>}</div>
      <div><div className="eyebrow">LIMITATIONS</div>{a.limitations.length ? <ul>{a.limitations.map((s, i) => <li key={i}>{s}</li>)}</ul> : <NA>none reported</NA>}</div>
    </div>
  </section>;
}

function RequestForm({ blocked, pending, onSubmit, proposedRules, proposedRulesHash }: { blocked: boolean; pending: boolean; onSubmit: (d: HistoricalTestRequest, done: () => void) => void; proposedRules: Record<string, unknown>; proposedRulesHash: string }) {
  const ruleKeys = Object.keys(proposedRules ?? {});
  const empty = { developmentStart: '', developmentEnd: '', evaluationStart: '', evaluationEnd: '' };
  const [f, setF] = useState<Record<DateKey, string>>(empty);
  const [freeze, setFreeze] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const anyDate = Object.values(f).some(v => v.trim());
  const live = validateDates(f);
  const submit = (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pending) return;
    if (live) return setErr(live);
    if (anyDate && !freeze) return setErr('Complete date windows require confirming the rule freeze below.');
    const data: HistoricalTestRequest = {};
    if (anyDate) dateFields.forEach(d => { data[d.k] = f[d.k].trim(); });
    if (freeze) data.freezeRules = true;
    if (anyDate && freeze) data.expectedRulesHash = proposedRulesHash;
    onSubmit(data, () => { setF(empty); setFreeze(false); });
  };
  const label = blocked ? (anyDate ? 'Record blocked request' : 'Assess prerequisites') : 'Record assessed request';
  return <form className="panel bt-form" onSubmit={submit} data-testid="form-historical-test">
    <div className="dv-phead"><h2 className="display">Request a historical test</h2><p>All fields optional. Leave blank to record a prerequisite assessment. If any date is entered, all four are required, in chronological order, without overlap, and before today (UTC). No default dates, targets or pass thresholds are supplied.</p></div>
    <div className="bt-dates">{(['Development', 'Evaluation'] as const).map(g => <fieldset key={g}><legend>{g} window{g === 'Evaluation' ? ' (held out)' : ''}</legend>{dateFields.filter(d => d.group === g).map(d => <label key={d.k} className="risk-input">{d.label}<span className="risk-control"><input type="date" max={todayUtc()} value={f[d.k]} onChange={e => { setF(x => ({ ...x, [d.k]: e.target.value })); setErr(null); }} data-testid={`input-${d.k}`} /></span></label>)}</fieldset>)}</div>
    <p className={`bt-hint ${anyDate && live ? 'bad' : anyDate ? 'good' : ''}`} data-testid="text-date-hint">{!anyDate ? 'No dates entered: assessment only.' : live ?? 'Dates are chronological and non-overlapping.'}</p>
    <div className="bt-proposed" data-testid="panel-proposed-rules"><div className="eyebrow">RULES THAT WOULD BE FROZEN · REVIEW FIRST</div><dl className="bt-kv"><div><dt>Current preview hash</dt><dd className="mono bt-hash" data-testid="text-proposed-hash">{proposedRulesHash || <NA>none reported</NA>}</dd></div><div><dt>Snapshot fields</dt><dd className="mono">{ruleKeys.length ? `${ruleKeys.length} top-level: ${ruleKeys.join(', ')}` : <NA>empty</NA>}</dd></div></dl>{ruleKeys.length > 0 ? <details className="bt-snap"><summary>Review full proposed rules snapshot</summary><pre data-testid="text-proposed-rules">{JSON.stringify(proposedRules, null, 2)}</pre></details> : <p className="muted-note">The server reported no proposed rules.</p>}<p className="muted-note">Server snapshot of current risk and discovery rules. Nothing is filled in by this page. If rules change before you submit, the server rejects the stale preview (409) and you can review again.</p></div>
    <label className="dv-ack bt-freeze"><input type="checkbox" checked={freeze} onChange={e => setFreeze(e.target.checked)} data-testid="checkbox-freeze-rules" /><span><Snowflake size={13} /> Freeze the currently proposed discovery and paper-risk rules as an immutable snapshot with a hash before any evaluation could execute. Freezing records rules; it is not a risk approval and does not enable trading.{anyDate ? ' Required with dates.' : ''}</span></label>
    {err && <div role="alert" className="error-banner"><AlertCircle size={16} /><span>{err}</span></div>}
    <div className="bt-formfoot"><small>{blocked ? 'Blockers exist: the request is recorded as blocked. Nothing runs.' : 'Server decides final status.'}</small><button type="submit" className="button button-primary" disabled={pending || (anyDate && (!!live || !freeze))} data-testid="button-request-backtest">{pending ? <RefreshCw size={13} className="spin" /> : <ShieldAlert size={13} />}{pending ? 'Recording' : label}</button></div>
  </form>;
}

function Metric({ label, v, unit = '' }: { label: string; v: number | null; unit?: string }) {
  return <div className="bt-metric"><small>{label}</small>{v == null ? <NA /> : <b className="mono">{v}{unit}</b>}</div>;
}

function RunDetail({ r, exporting, onExport }: { r: HistoricalTestRun; exporting: string | null; onExport: (id: string, f: 'json' | 'csv') => void }) {
  const m = r.performance;
  const frozenKeys = Object.keys(r.frozenRules ?? {});
  const steps: [string, string | null][] = [['Requested', r.requestedAt], ['Assessed', r.assessedAt], ['Started', r.startedAt], ['Completed', r.completedAt]];
  return <section className="panel bt-run" data-testid={`detail-run-${r.id}`}>
    <div className="bt-run-head">
      <div><div className="eyebrow">RUN {r.id}</div><h2 className="display">{r.kind.replaceAll('_', ' ')}</h2></div>
      <div className="bt-exports">
        <button className="button button-outline" disabled={!!exporting} onClick={() => onExport(r.id, 'json')} data-testid="button-export-json">{exporting === `${r.id}-json` ? <RefreshCw size={13} className="spin" /> : <FileJson size={13} />}JSON report</button>
        <button className="button button-outline" disabled={!!exporting} onClick={() => onExport(r.id, 'csv')} data-testid="button-export-csv">{exporting === `${r.id}-csv` ? <RefreshCw size={13} className="spin" /> : <FileSpreadsheet size={13} />}CSV report</button>
      </div>
    </div>
    <ol className="bt-timeline">{steps.map(([k, v]) => <li key={k} className={v ? 'done' : ''}><span /><b>{k}</b><small className="mono">{when(v) ?? (k === 'Requested' ? 'unknown' : 'not started / unavailable')}</small></li>)}</ol>
    <div className="bt-vp">
      <div><div className="eyebrow">STATUS</div><span className={`dv-pill ${r.status}`} data-testid="status-run"><span />{r.status}</span></div>
      <div><div className="eyebrow">VALIDITY</div><p data-testid="text-validity">{r.validity}</p></div>
      <div><div className="eyebrow">PROFITABILITY (SEPARATE FROM VALIDITY)</div><p data-testid="text-profitability">{r.profitability}</p></div>
      <div><div className="eyebrow">PROGRESS</div><p className="mono">{r.progressPct == null ? 'unavailable' : `${r.progressPct}%`} · processed trades {r.processedTrades ?? 'unavailable'}</p></div>
    </div>
    <div className="bt-grid2">
      <div className="bt-box"><div className="eyebrow">SELECTED DATES (UTC)</div>{r.request.developmentStart ? <dl className="bt-kv"><div><dt>Development</dt><dd className="mono">{calendarDay(r.request.developmentStart)} → {calendarDay(r.request.developmentEnd)}</dd></div><div><dt>Evaluation</dt><dd className="mono">{calendarDay(r.request.evaluationStart)} → {calendarDay(r.request.evaluationEnd)}</dd></div></dl> : <NA>no dates requested (assessment only)</NA>}</div>
      <div className="bt-box"><div className="eyebrow">FROZEN RULES SNAPSHOT</div><dl className="bt-kv"><div><dt>Freeze requested</dt><dd className="mono">{r.request.freezeRules ? 'yes' : 'no'}</dd></div><div><dt>Frozen at</dt><dd className="mono">{when(r.rulesFrozenAt) ?? <NA>not frozen</NA>}</dd></div><div><dt>Hash</dt><dd className="mono bt-hash">{r.rulesHash ?? <NA>none</NA>}</dd></div><div><dt>Snapshot fields</dt><dd className="mono">{frozenKeys.length ? frozenKeys.join(', ') : <NA>empty</NA>}</dd></div></dl>{frozenKeys.length > 0 && <details className="bt-snap"><summary>View immutable snapshot</summary><pre>{JSON.stringify(r.frozenRules, null, 2)}</pre></details>}</div>
    </div>
    <div className="eyebrow bt-mhead">METRICS · AFTER COSTS · NULL MEANS NOT COMPUTED</div>
    <div className="bt-metrics"><Metric label="Trades" v={m.trades} /><Metric label="Net return after costs" v={m.netReturnAfterCostsPct} unit="%" /><Metric label="Max drawdown" v={m.maxDrawdownPct} unit="%" /><Metric label="Win rate" v={m.winRatePct} unit="%" /><Metric label="Profit factor" v={m.profitFactor} /></div>
    <p className="muted-note bt-inset">Wallet breakdown {m.walletBreakdown.length} rows · monthly breakdown {m.monthlyBreakdown.length} rows · failures {m.failures.length} rows. A positive result would not by itself mean a test passed; validity is judged separately.</p>
    <Breakdown title="Wallet breakdown" rows={m.walletBreakdown} />
    <Breakdown title="Monthly breakdown" rows={m.monthlyBreakdown} />
    <Breakdown title="Failures" rows={m.failures} />
    <div className="bt-lists"><div><div className="eyebrow">ASSUMPTIONS</div>{r.assumptions.length ? <ul>{r.assumptions.map((s, i) => <li key={i}>{s}</li>)}</ul> : <NA>none reported</NA>}</div><div><div className="eyebrow">LIVE TRADING</div><p className="negative mono">{r.liveTradingEnabled ? 'reported enabled — unexpected' : 'false · no orders, no activation, no publishing'}</p></div></div>
    <details className="bt-snap bt-inset"><summary>Assessment captured with this run</summary><AssessmentDetail a={r.assessment} title="Prerequisites at request time" /></details>
  </section>;
}

const cell = (v: unknown) => v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
function Breakdown({ title, rows }: { title: string; rows: Record<string, unknown>[] }) {
  const cols = useMemo(() => [...new Set(rows.flatMap(r => Object.keys(r)))].slice(0, 10), [rows]);
  return <div className="bt-breakdown" data-testid={`table-${title.toLowerCase().replaceAll(' ', '-')}`}>
    <div className="bt-bhead"><b>{title}</b><small className="mono">{rows.length} rows</small></div>
    {rows.length === 0 ? <p className="muted-note">No entries reported by the server. Unavailable, not zero.</p> :
      <div className="table-scroll"><table className="bt-mini"><thead><tr>{cols.map(c => <th key={c}>{c.toUpperCase()}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{cols.map(c => { const v = cell(r[c]); return <td key={c} className="mono">{v ?? <NA />}</td>; })}</tr>)}</tbody></table></div>}
  </div>;
}
