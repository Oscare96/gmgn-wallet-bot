import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, FileJson, Lock, RefreshCw, ScanSearch, ShieldAlert } from 'lucide-react';
import { getGetBacktestingQueryKey, getGetProviderEvidenceQueryKey, getProviderEvidenceDetail, useGetProviderEvidence, useInspectProviderHistory, useProbePaperQuote } from '@workspace/api-client-react';
import type { ProviderEvidence, ForwardReadiness } from '@workspace/api-client-react';

const when = (v?: string | null) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago' }).format(d) + ' CT'; };
const str = (v: unknown) => v == null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
const list = (v: unknown) => Array.isArray(v) ? v.map(x => String(x)) : [];
const COOLDOWN_MS = 15 * 60 * 1000;
const isRead = (s: string) => /^(ok|success|read|verified|captured)/i.test(s);

function download(content: string, name: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 500); }

function useEvidence() {
  return useGetProviderEvidence({ query: { queryKey: getGetProviderEvidenceQueryKey(), refetchInterval: 60000, refetchOnWindowFocus: true } });
}

export function ReadinessCompact({ title = 'Provider and paper readiness' }: { title?: string }) {
  const q = useEvidence();
  const r = q.data?.readiness;
  return <section className="panel pe-compact" data-testid="panel-readiness-compact">
    <div className="eyebrow">{title.toUpperCase()}</div>
    {q.isLoading ? <div className="skeleton-row"><span /><span /></div> : q.isError || !r ? <p className="negative" role="alert">Readiness unavailable: {q.error?.message ?? 'no data'}. <button className="text-action" onClick={() => void q.refetch()} data-testid="button-retry-readiness">Retry</button></p> :
      <ReadinessFacts r={r} count={q.data?.evidence.length ?? 0} />}
  </section>;
}

function ReadinessFacts({ r, count }: { r: ForwardReadiness; count: number }) {
  const backoff = r.readBackoffUntil ? Date.parse(r.readBackoffUntil) : NaN;
  const backingOff = !Number.isNaN(backoff) && backoff > Date.now();
  const blockedNow = backingOff || !!r.readBlockReason || r.apiKeyConfigured === false;
  return <>{blockedNow && <div className="error-banner pe-blocknow" role="alert" data-testid="text-read-blocked"><AlertCircle size={16} /><span><b>Provider reads currently blocked.</b> {r.apiKeyConfigured === false ? 'API key not configured on the server. ' : ''}{r.readBlockReason ? `${r.readBlockReason}. ` : ''}{backingOff ? `Backoff until ${when(r.readBackoffUntil)}.` : ''} Earlier successful reads do not mean access is available now.</span></div>}<dl className="pe-facts">
    <div><dt>API key configured</dt><dd className={`mono ${r.apiKeyConfigured === false ? 'negative' : ''}`} data-testid="text-api-key-configured">{r.apiKeyConfigured == null ? 'not reported' : r.apiKeyConfigured ? 'yes' : 'no'}</dd></div>
    <div><dt>Read backoff until</dt><dd className={`mono ${backingOff ? 'negative' : ''}`} data-testid="text-read-backoff">{when(r.readBackoffUntil) ?? 'none'}{r.readBackoffUntil && !backingOff ? ' (elapsed)' : ''}</dd></div>
    <div><dt>Read block reason</dt><dd className={`mono ${r.readBlockReason ? 'negative' : ''}`} data-testid="text-read-block-reason">{r.readBlockReason ?? 'none'}</dd></div>
    <div><dt>Last verified provider read</dt><dd className="mono" data-testid="text-last-verified-read">{when(r.lastVerifiedReadAt) ?? 'none recorded'}</dd></div>
    <div><dt>Last inspection</dt><dd className="mono">{when(r.lastInspectionAt) ?? 'never'}</dd></div>
    <div><dt>Tracking</dt><dd className="mono" data-testid="text-tracking">{r.tracking}</dd></div>
    <div><dt>Paper fills</dt><dd className="mono negative" data-testid="text-paper">{r.paper}</dd></div>
    <div><dt>Monitoring</dt><dd className="mono">{r.monitoringPaused ? 'paused' : 'active'}</dd></div>
    <div><dt>Auto selection</dt><dd className="mono">{r.automaticSelectionPaused ? 'paused' : 'active'}</dd></div>
    <div><dt>Plan verified</dt><dd className={`mono ${r.planVerified ? '' : 'negative'}`}>{r.planVerified ? 'yes' : 'no'}</dd></div>
    <div><dt>Live trading</dt><dd className="mono negative">{r.liveTradingEnabled ? 'reported enabled, unexpected' : 'disabled'}</dd></div>
  </dl><p className="pe-note">{r.reason} {count} evidence sample{count === 1 ? '' : 's'} on record. Samples are not forward paper results and not a backtest.</p></>;
}

export function ProviderEvidencePanel() {
  const qc = useQueryClient();
  const q = useEvidence();
  const inspect = useInspectProviderHistory();
  const quoteProbe = useProbePaperQuote();
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const r = q.data?.readiness;
  const evidence = [...(q.data?.evidence ?? [])].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const last = r?.lastInspectionAt ? Date.parse(r.lastInspectionAt) : NaN;
  const cooldownUntil = Number.isNaN(last) ? null : last + COOLDOWN_MS;
  const cooling = cooldownUntil != null && cooldownUntil > Date.now();

  const run = () => {
    if (!confirm || inspect.isPending) return;
    setNotice(null);
    inspect.mutate({ data: { confirmReadOnly: true } }, {
      onSuccess: (res) => { qc.invalidateQueries({ queryKey: getGetProviderEvidenceQueryKey() }); qc.invalidateQueries({ queryKey: getGetBacktestingQueryKey() }); setConfirm(false); setNotice({ kind: 'ok', text: `Inspection ${res.state}${res.reused ? ' (cooldown active: previous samples reused, no new provider requests)' : ''}. ${res.evidence.length} sample record${res.evidence.length === 1 ? '' : 's'} returned. This is evidence capture, not a backtest.` }); },
      onError: (e) => { qc.invalidateQueries({ queryKey: getGetProviderEvidenceQueryKey() }); setNotice({ kind: 'err', text: `Inspection failed: ${e.message}` }); },
    });
  };
  const exportOne = async (id: string) => {
    setExporting(id); setNotice(null);
    try { const d = await getProviderEvidenceDetail(id); download(JSON.stringify({ evidence: d.evidence, command: d.command, provenance: d.provenance, resultsKind: d.resultsKind, liveTradingEnabled: d.liveTradingEnabled, payload: d.payload }, null, 2), `provider-evidence-${d.evidence.source}-${id}.json`); setNotice({ kind: 'ok', text: `Exported server-redacted evidence ${id.slice(0, 8)} (results kind: ${d.resultsKind}).` }); }
    catch (e) { setNotice({ kind: 'err', text: `Export failed: ${e instanceof Error ? e.message : 'unknown error'}` }); }
    finally { setExporting(null); }
  };

  return <section className="panel pe" data-testid="panel-provider-evidence">
    <div className="dv-phead pe-head"><div><h2 className="display">Provider evidence</h2><p>Real read-only provider access, captured as separate sampled windows. Not continuous coverage, not forward paper results, not a historical strategy run, not executable fills.</p></div>
      <button className="button button-outline" onClick={() => void q.refetch()} disabled={q.isFetching} data-testid="button-refresh-evidence"><RefreshCw size={13} className={q.isFetching ? 'spin' : ''} />Refresh</button></div>

    {q.isLoading ? <div className="skeleton-list">{[0, 1, 2].map(i => <div className="skeleton-row" key={i}><span /><span /><span /></div>)}</div> :
      q.isError || !r ? <div className="error-banner" role="alert"><AlertCircle size={16} /><span>Provider evidence could not be loaded: {q.error?.message ?? 'no data'}</span><button onClick={() => void q.refetch()}>Retry</button></div> :
      <div className="pe-inset"><ReadinessFacts r={r} count={evidence.length} /></div>}

    <div className="pe-inspect">
      <div className="pe-scope"><Lock size={14} /><p><b>Inspection requires explicit authorization.</b> Each run makes at most ten read-only provider read operations (the pinned client may internally retry a short rate limit once) and shares a 15-minute cooldown. It never resumes monitoring, never selects wallets, never trades. Current trending is a token list; the wallet sample is derived from current traders of those tokens, not an official trending-account ranking or a past universe. A successful market read does not validate execution quotes. The staged atomic ledger has isolated software tests, but the genuine quote/event adapter and worker integration remain blocked. Coverage inspections are not ongoing prospective paper evaluation or historical strategy performance.</p></div>
      <div className="pe-scope"><ShieldAlert size={14} /><p><b>Before collection can start:</b> resolve the displayed provider backoff/permission errors, validate a fresh read-only quote and canonical event identity, select observation wallets or review discovery rules, and explicitly review paper cash, budgets and risk limits. Freeze forward rules before beginning an evaluation cohort. Do not enable trading permissions or supply a signing key for tracking/paper mode. Missing evidence must keep fills and automatic qualification blocked.</p></div>
      <label className="dv-ack"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} data-testid="checkbox-confirm-readonly" /><span>I confirm this is a bounded read-only inspection and not a backtest.</span></label>
      <div className="pe-actions"><small className="mono">{cooling ? `Cooldown until ${when(new Date(cooldownUntil!).toISOString())}; a new request will reuse existing samples.` : 'No cooldown known to be active.'}</small>
        <button className="button button-primary" disabled={!confirm || inspect.isPending} onClick={run} data-testid="button-inspect-provider">{inspect.isPending ? <RefreshCw size={13} className="spin" /> : <ScanSearch size={13} />}{inspect.isPending ? 'Inspecting' : 'Run read-only inspection'}</button></div>
    </div>

    <div className="pe-scope-note">
      <button type="button" className="button button-secondary" disabled={!confirm || quoteProbe.isPending || inspect.isPending || (r?.readBackoffUntil != null && Date.parse(r.readBackoffUntil) > Date.now())} data-testid="button-probe-paper-quote" onClick={() => {
        setNotice(null);
        quoteProbe.mutate({ data: { confirmReadOnly: true } }, {
          onSuccess: res => { void qc.invalidateQueries({ queryKey: getGetProviderEvidenceQueryKey() }); setConfirm(false); setNotice({ kind: 'ok', text: `Quote check: ${res.state}${res.reused ? ' (no new provider request)' : ''}. Paper evaluation remains paused; successful quote access alone does not establish fill readiness.` }); },
          onError: error => setNotice({ kind: 'err', text: error.message }),
        });
      }}>{quoteProbe.isPending ? 'Checking quote…' : 'Check quote only'}</button>
      <p>Uses a real automatically discovered trader for one diagnostic 0.001 SOL quote—not a paper buy, approved budget or user execution wallet. Confirm read-only access above. Shared backoff and cooldown are enforced on the server.</p>
    </div>
    {notice && <div role={notice.kind === 'err' ? 'alert' : 'status'} className={`${notice.kind === 'err' ? 'error-banner' : 'dv-ok'} pe-notice`} data-testid="text-evidence-notice">{notice.kind === 'err' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}<span>{notice.text}</span><button onClick={() => setNotice(null)}>Dismiss</button></div>}

    {q.data && (evidence.length === 0 ? <div className="empty-state compact"><span className="empty-icon"><ScanSearch size={17} /></span><strong>No provider samples captured</strong><p>Nothing has been read. Run an inspection above when you choose.</p></div> :
      <ol className="pe-list">{evidence.map(e => <EvidenceRow key={e.id} e={e} exporting={exporting === e.id} disabled={!!exporting} onExport={() => void exportOne(e.id)} />)}</ol>)}
  </section>;
}

function EvidenceRow({ e, exporting, disabled, onExport }: { e: ProviderEvidence; exporting: boolean; disabled: boolean; onExport: () => void }) {
  const m = e.metadata ?? {};
  const ok = isRead(e.status) && !m.errorKind;
  const fields = list(m.fields), missing = list(m.missingCandles), docs = list(m.sourceDocs);
  return <li className={`pe-row ${ok ? 'read' : 'blocked'}`} data-testid={`row-evidence-${e.id}`}>
    <div className="pe-row-head">
      <span className={`dv-pill ${ok ? 'ready' : 'blocked'}`}><span />{ok ? 'source read' : e.status}</span>
      <b className="mono">{e.source}</b><small className="mono">{e.collectionId.slice(0, 8)} / {e.id.slice(0, 8)}</small>
      <button className="button button-outline pe-export" disabled={disabled} onClick={onExport} data-testid={`button-export-evidence-${e.id}`}>{exporting ? <RefreshCw size={12} className="spin" /> : <FileJson size={12} />}JSON</button>
    </div>
    <dl className="pe-facts">
      <div><dt>Captured</dt><dd className="mono">{when(e.capturedAt) ?? 'unknown'}</dd></div>
      <div><dt>Queried window</dt><dd className="mono">{when(str(m.queriedFrom)) ?? 'n/a'} to {when(str(m.queriedTo)) ?? 'n/a'}</dd></div>
      <div><dt>Returned window (this sample only)</dt><dd className="mono">{when(e.returnedFrom) ?? 'none'} to {when(e.returnedTo) ?? 'none'}</dd></div>
      <div><dt>Records / latency</dt><dd className="mono">{e.recordCount} / {e.latencyMs} ms</dd></div>
      <div><dt>Pagination</dt><dd className="mono negative">{m.paginationComplete === true ? 'complete' : 'incomplete'}{m.cursorPresent ? ', cursor present' : ''}</dd></div>
      <div><dt>Schema</dt><dd className="mono">{ok ? 'sample parsed; completeness unverified' : `blocked${m.errorKind ? `: ${str(m.errorKind)}` : ''}`}</dd></div>
      <div><dt>Historical strategy ready</dt><dd className="mono negative">{e.historicalStrategyReady ? 'reported yes' : 'no'}</dd></div>
      <div><dt>Paper fill ready</dt><dd className="mono negative">{e.paperFillReady ? 'reported yes' : 'no'}</dd></div>
    </dl>
    <p className="pe-note"><ShieldAlert size={12} /> <b>Scope:</b> {e.scope} <b>Limitation:</b> {e.limitation}</p>
    <p className="pe-note mono">fields: {fields.length ? fields.join(', ') : 'none reported'}{missing.length ? ` | missing candles: ${missing.length}` : ''}{str(m.selection) ? ` | selection: ${str(m.selection)}` : ''}{str(m.cliVersion) ? ` | cli ${str(m.cliVersion)}` : ''} | hash {e.payloadHash ? e.payloadHash.slice(0, 16) : 'none'}</p>
    {docs.length > 0 && <p className="pe-note">Sources: {docs.join(' · ')}</p>}
  </li>;
}
