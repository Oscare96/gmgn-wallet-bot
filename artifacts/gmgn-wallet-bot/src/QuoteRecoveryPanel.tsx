import { useGetQuoteRecovery, getGetQuoteRecoveryQueryKey } from "@workspace/api-client-react";
import { Clock, ShieldAlert } from "lucide-react";

const when = (value?: string | null) => value ? new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  second: "2-digit", timeZone: "America/Chicago",
}).format(new Date(value)) + " CT" : "Not scheduled / unavailable";

/** Status polling never calls GMGN; recovery runs server-side without a browser. */
export function QuoteRecoveryPanel() {
  const q = useGetQuoteRecovery({ query: { queryKey: getGetQuoteRecoveryQueryKey(), refetchInterval: 15_000 } });
  const r = q.data;
  return <section className="panel health-panel" data-testid="quote-recovery-panel">
    <div className="panel-heading"><div><div className="eyebrow">AUTOMATIC READ-ONLY RECOVERY</div><h2>Quote cooldown recovery</h2></div><Clock size={18}/></div>
    {q.isLoading ? <p>Loading saved recovery state…</p> : q.isError || !r ?
      <div className="error-banner"><ShieldAlert size={16}/><span>Recovery status unavailable. API may be stopped/asleep or unreachable; no guaranteed retry while offline.</span></div> :
      <>
        <div className="health-line"><span>Recovery</span><b>{r.state}</b></div>
        <div className="health-line"><span>API recovery heartbeat</span><b>{r.runtime === "online" ? "Recent heartbeat" : "Offline or heartbeat stale"}</b></div>
        <div className="health-line"><span>Next permitted attempt</span><b>{when(r.nextAttemptAt)}</b></div>
        <div className="health-line"><span>Last attempt</span><b>{when(r.lastAttemptAt)}</b></div>
        <div className="health-line"><span>Last result</span><b>{r.lastResult ?? "No attempt yet"}</b></div>
        <div className="health-line"><span>Shared attempts</span><b>{r.attempts} / {r.maxAttempts}</b></div>
        <p className="muted-note">{r.note}</p>
        {Object.keys(r.verification).length > 0 && <details><summary>Observation-only readiness checks</summary><dl>{Object.entries(r.verification).map(([key, value]) =>
          <div className="health-line" key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</dl></details>}
      </>}
  </section>;
}
