import type { DiscoveryMetrics, DiscoveryRules } from "@workspace/api-zod";
import { readNumber, readTimestamp, unwrapData } from "./gmgnCli";

export const DISCOVERY_SOURCE = "Derived activity ranking: traders of trending Solana tokens";
export const DISCOVERY_COVERAGE = "Not an official GMGN wallet leaderboard. Token universe: trailing 24h; token trader summaries may cover token lifetime. Only traders with documented last-active time within 24h are candidates. Limited top tokens/traders and monitored count; staggered fetches are not a synchronized midnight snapshot. Historical stats: 30d; losses/concentration: latest sampled trades. Holding times: only official completed token start/end intervals when present. Wallet age, historical/full-equity drawdown and total holdings concentration unavailable. Forward results only from the frozen cohort after baseline; realized-only drawdown excludes unmarked open risk.";
export const PAPER_EVALUATION_BLOCK = "Forward paper execution unavailable: read-only executable quotes, upstream freshness and event identity are not verified. No wallet can qualify from historical profit alone.";
export const DEFAULT_DISCOVERY_RULES: DiscoveryRules = {
  enabled: false, selectionPaused: true, planConfirmed: false,
  maxRequestsPerHour: 60, maxMonitoredWallets: 5, tokenLimit: 5, tradersPerToken: 10,
  observationIntervalMinutes: 30, minForwardDays: 7, minHistoricalDays: 7,
  minHistoricalSells: 30, minForwardSells: 20, minForwardNetPnlUsd: 0,
  maxForwardDrawdownUsd: 25, maxHistoricalLossRatePct: 50, maxConcentrationPct: 35,
  minHoldingSeconds: 120, autoBuyBudgetUsd: 0, excludeSuspicious: true,
};

export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const char of value) decoded = decoded * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (decoded > 0n) { bytes++; decoded >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
export function chicagoDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function followingDay(day: string): string {
  return new Date(new Date(`${day}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}
export function refreshDue(lastDay: string | null, requested: boolean, now: Date): boolean {
  return requested || lastDay !== chicagoDay(now);
}
export function trendingTokens(value: unknown): Record<string, unknown>[] {
  const root = unwrapData(value);
  if (!Array.isArray(root.rank)) throw new Error("Unsupported trending schema: expected data.rank.");
  if (root.rank.some((t) => !t || typeof t !== "object" || typeof t.address !== "string" || !isSolanaAddress(t.address))) throw new Error("Unsupported trending schema: invalid Solana token identity.");
  return root.rank.filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof t.address === "string" && isSolanaAddress(t.address));
}
export function tokenTraders(value: unknown): Record<string, unknown>[] {
  const root = unwrapData(value);
  if (!Array.isArray(root.list)) throw new Error("Unsupported trader schema: expected list.");
  if (root.list.some((t) => !t || typeof t !== "object" || typeof t.address !== "string" || !isSolanaAddress(t.address))) throw new Error("Unsupported trader schema: invalid Solana wallet identity.");
  return root.list.filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof t.address === "string" && isSolanaAddress(t.address) && readNumber(t.addr_type) !== 2);
}
export function isRecentlyActiveTrader(trader: Record<string, unknown>, now: Date): boolean {
  const activeAt = readTimestamp(trader.last_active_timestamp);
  return activeAt != null && activeAt <= now && now.getTime() - activeAt.getTime() <= 86_400_000;
}
export function advanceCursor(history: string[], current: string | null, next: string | null): string[] {
  if (next && (next === current || history.includes(next))) throw new Error("Unsupported pagination: cyclic cursor.");
  if (next && history.length >= 100) throw new Error("Unsupported pagination: 100-page safety limit reached; baseline remains incomplete.");
  return next ? [...history, ...(current ? [current] : [])] : [];
}
export function observationDecision(baselineComplete: boolean, start: Date | null, observedAt: Date, detectedAt: Date, maxAgeSeconds: number) {
  if (observedAt > detectedAt || detectedAt.getTime() - observedAt.getTime() > maxAgeSeconds * 1000) return { status: baselineComplete ? "skipped" : "baseline", reason: "Historical/stale/future timestamp: never copied or scored as forward performance." };
  if (!baselineComplete || !start || observedAt <= start) return { status: "baseline", reason: "Historical baseline/pre-cohort activity: never copied or scored as forward performance." };
  return { status: "observed", reason: PAPER_EVALUATION_BLOCK };
}
export function emptyMetrics(): DiscoveryMetrics {
  return { historicalRealizedPnlUsd: null, historicalUnrealizedPnlUsd: null, historicalSells: null,
    historicalSpanDays: null, historicalLossSamples: null, sampledTrades: null, lossRatePct: null, holdingSeconds: null,
    concentrationPct: null, suspicious: null, forwardNetPnlUsd: null, forwardSells: 0,
    forwardCostsUsd: null, forwardDrawdownUsd: null, forwardDays: 0, copyabilityVerified: false };
}
export function historyMetrics(stats: unknown, activity: Record<string, unknown>[], suspicious: boolean | null, officialHoldingIntervals: number[] = []): Partial<DiscoveryMetrics> {
  const root = unwrapData(stats);
  const rows = activity.map((r) => ({ raw: r, time: readTimestamp(r.timestamp), side: r.event_type ?? r.type }))
    .filter((r) => r.time).sort((a, b) => a.time!.getTime() - b.time!.getTime());
  const holds = officialHoldingIntervals.filter((v) => Number.isFinite(v) && v >= 0);
  const pnl: number[] = [];
  const volumes = new Map<string, number>();
  for (const row of rows) {
    const token = row.raw.token as { address?: string } | undefined;
    if (!token?.address || !["buy", "sell"].includes(String(row.side))) continue;
    const dollars = readNumber(row.raw.cost_usd);
    if (dollars != null && dollars >= 0) volumes.set(token.address, (volumes.get(token.address) ?? 0) + dollars);
    if (row.side === "sell") {
      const cost = readNumber(row.raw.buy_cost_usd);
      if (dollars != null && cost != null) pnl.push(dollars - cost);
    }
  }
  const volume = [...volumes.values()].reduce((a, b) => a + b, 0);
  holds.sort((a, b) => a - b);
  return {
    historicalRealizedPnlUsd: readNumber(root.realized_profit),
    historicalUnrealizedPnlUsd: readNumber(root.unrealized_profit),
    historicalSells: readNumber(root.sell_count),
    historicalLossSamples: pnl.length,
    historicalSpanDays: rows.length > 1 ? (rows.at(-1)!.time!.getTime() - rows[0].time!.getTime()) / 86_400_000 : null,
    sampledTrades: rows.length,
    lossRatePct: pnl.length ? 100 * pnl.filter((v) => v < 0).length / pnl.length : null,
    holdingSeconds: holds.length ? holds[Math.floor(holds.length / 2)] : null,
    concentrationPct: volume > 0 ? 100 * Math.max(...volumes.values()) / volume : null,
    suspicious,
  };
}
type ForwardFill = {
  evaluationId: string | null; filledAt: Date; simulated: boolean; tokenAddress: string;
  side: string; quantity: string | number; realizedPnlUsd: string | number | null;
  feeUsd: string | number; slippageUsd: string | number;
};
export function forwardMetrics(fills: ForwardFill[], evaluationId: string, start: Date | null, now: Date): Partial<DiscoveryMetrics> {
  if (!start) return { forwardDays: 0, forwardSells: 0, forwardNetPnlUsd: null, forwardCostsUsd: null, forwardDrawdownUsd: null };
  const rows = fills.filter((f) => f.simulated && f.evaluationId === evaluationId && f.filledAt >= start && f.filledAt <= now)
    .sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
  let net = 0, peak = 0, drawdown = 0, costs = 0, closed = 0;
  const quantity = new Map<string, number>();
  let complete = true;
  for (const fill of rows) {
    const q = readNumber(fill.quantity), fee = readNumber(fill.feeUsd), slip = readNumber(fill.slippageUsd);
    if (q == null || q <= 0 || fee == null || fee < 0 || slip == null || slip < 0) { complete = false; continue; }
    costs += fee + slip;
    const held = quantity.get(fill.tokenAddress) ?? 0;
    if (fill.side === "buy") quantity.set(fill.tokenAddress, held + q);
    else if (fill.side === "sell") {
      const realized = readNumber(fill.realizedPnlUsd);
      if (realized == null || q > held + 1e-12) { complete = false; continue; }
      quantity.set(fill.tokenAddress, Math.max(0, held - q));
      if (held > 0 && held - q <= 1e-12) closed++;
      net += realized; peak = Math.max(peak, net); drawdown = Math.max(drawdown, peak - net);
    } else complete = false;
  }
  return { forwardDays: Math.max(0, (now.getTime() - start.getTime()) / 86_400_000),
    forwardSells: closed, forwardNetPnlUsd: rows.length && complete ? net : null,
    forwardCostsUsd: rows.length && complete ? costs : null,
    forwardDrawdownUsd: closed && complete ? drawdown : null };
}
export function qualifyCandidate(metrics: DiscoveryMetrics, rules: DiscoveryRules, excluded: boolean, regularWallet: boolean) {
  if (excluded || (rules.excludeSuspicious && metrics.suspicious === true)) {
    return { state: "excluded", score: null, reasons: [excluded ? "Manually excluded." : "Official source flags suspicious activity; pinning cannot override exclusion."] };
  }
  const checks: [string, boolean][] = [
    ["Known regular wallet classification", regularWallet],
    ["Historical realized result is available and nonnegative (not proof of skill)", metrics.historicalRealizedPnlUsd != null && metrics.historicalRealizedPnlUsd >= 0],
    [`Historical sells >= ${rules.minHistoricalSells}`, metrics.historicalSells != null && metrics.historicalSells >= rules.minHistoricalSells],
    [`Cost-evidenced historical sell samples >= ${rules.minHistoricalSells}`, metrics.historicalLossSamples != null && metrics.historicalLossSamples >= rules.minHistoricalSells],
    [`Sample history spans >= ${rules.minHistoricalDays} days (wallet age unavailable)`, metrics.historicalSpanDays != null && metrics.historicalSpanDays >= rules.minHistoricalDays],
    [`Measured sampled loss rate <= ${rules.maxHistoricalLossRatePct}%`, metrics.lossRatePct != null && metrics.lossRatePct <= rules.maxHistoricalLossRatePct],
    [`Matched sampled holding time >= ${rules.minHoldingSeconds}s`, metrics.holdingSeconds != null && metrics.holdingSeconds >= rules.minHoldingSeconds],
    [`Sample traded-notional concentration <= ${rules.maxConcentrationPct}%`, metrics.concentrationPct != null && metrics.concentrationPct <= rules.maxConcentrationPct],
    ["Suspicious-activity evidence available", !rules.excludeSuspicious || metrics.suspicious === false],
    [`Forward observation >= ${rules.minForwardDays} days`, (metrics.forwardDays ?? 0) >= rules.minForwardDays],
    [`Forward closed roundtrips >= ${rules.minForwardSells}`, (metrics.forwardSells ?? 0) >= rules.minForwardSells],
    [`Forward net realized result after costs >= $${rules.minForwardNetPnlUsd}`, metrics.forwardNetPnlUsd != null && metrics.forwardNetPnlUsd >= rules.minForwardNetPnlUsd],
    [`Forward realized-only drawdown <= $${rules.maxForwardDrawdownUsd}`, metrics.forwardDrawdownUsd != null && metrics.forwardDrawdownUsd <= rules.maxForwardDrawdownUsd],
    ["Post-detection executable quote freshness, security/liquidity, fee/delay copyability and event identity verified", metrics.copyabilityVerified === true],
  ];
  const pass = checks.filter(([, ok]) => ok).length;
  return { state: checks.every(([, ok]) => ok) ? "qualified" : "observation_only",
    score: metrics.historicalRealizedPnlUsd == null ? null : Math.floor(100 * pass / checks.length),
    reasons: checks.map(([label, ok]) => `${ok ? "Pass" : "Pending/unavailable"}: ${label}`).concat(metrics.copyabilityVerified ? [] : [PAPER_EVALUATION_BLOCK]) };
}
