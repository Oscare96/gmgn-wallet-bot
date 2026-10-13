import { createHash } from "node:crypto";

export const BACKTEST_SOURCES = [
  "https://docs.gmgn.ai/index/gmgn-agent-api",
  "https://github.com/GMGNAI/gmgn-skills/blob/main/docs/cli-usage.md",
  "https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md",
];
export const BACKTEST_ASSUMPTIONS = [
  "Period dates are inclusive UTC calendar dates; daily discovery boundaries are America/Chicago. Historical baseline/forward-qualification warmup must precede evaluation.",
  "Whole-strategy point-in-time testing only. Today's chosen wallets are not a historical discovery universe.",
  "Selection must be recomputed chronologically from information available at each Chicago daily decision, including the prior forward-qualification period.",
  "Losing/inactive wallets and failed, delisted or untradeable tokens must be represented where relevant; disclose omitted populations and resulting survivor bias.",
  "Detection delay, fees/slippage, liquidity/security, event identity and pre-sell inventory must be evidenced before simulation. Leader historical entry prices are not copy fills.",
  "One token entry at a time across leaders; exits apply only to that leader's attributable simulated quantity. No overselling, manual-holding exits or invented liquidation of unsellable positions.",
  "Missing terminal valuation or tradability makes return/equity drawdown inconclusive; realized-only results must not be called full strategy performance.",
  "Chronological development and untouched evaluation periods must not overlap. Freeze rules before inspecting/executing evaluation; repeated evaluation reuse must be disclosed.",
  "Validity is independent of profitability. No invented return threshold or 'passed because profitable' claim.",
  "Forward paper monitoring is prospective and separate. It is not relabeled historical evidence.",
  "gmgn-cli@1.6.6 supports dated candles, not a documented historical as-of trending-token/wallet universe. Historical spread/depth/security availability is unverified.",
  "Bounded direct-provider evidence import is implemented. Retrospectively fetched candles/current trader samples do not establish historical selection availability. No whole-strategy archive/replay adapter is validated; a key alone does not unblock it.",
];
export const EMPTY_BACKTEST_PERFORMANCE = {
  trades: null, netReturnAfterCostsPct: null, maxDrawdownPct: null, winRatePct: null, profitFactor: null,
  walletBreakdown: [], monthlyBreakdown: [], failures: [],
};
const DATE_KEYS = ["developmentStart", "developmentEnd", "evaluationStart", "evaluationEnd"] as const;
export function validateHistoricalPeriods(input: Record<string, unknown>, now = new Date()) {
  const present = DATE_KEYS.filter((k) => input[k] !== undefined);
  if (!present.length) return { complete: false, dates: {} as Partial<Record<typeof DATE_KEYS[number], string>> };
  if (present.length !== 4) throw new Error("Choose all four development/evaluation dates, or leave all blank for a prerequisite assessment.");
  const dates: Partial<Record<typeof DATE_KEYS[number], string>> = {};
  for (const key of DATE_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("Use genuine YYYY-MM-DD calendar dates.");
    if (value >= now.toISOString().slice(0, 10)) throw new Error("Historical periods must end before today's UTC date; today is incomplete.");
    dates[key] = value;
  }
  if (!(dates.developmentStart! <= dates.developmentEnd! && dates.developmentEnd! < dates.evaluationStart! && dates.evaluationStart! <= dates.evaluationEnd!)) throw new Error("Development must precede evaluation without overlap.");
  return { complete: true, dates };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function freezeHistoricalRules(rules: Record<string, unknown>) {
  const serialized = JSON.stringify(canonical(rules));
  return { rules: JSON.parse(serialized) as Record<string, unknown>, hash: createHash("sha256").update(serialized).digest("hex") };
}
export function pointInTimeEligible(decisionAt: number, evidence: { availableAt: number; measuredThrough: number; selectedAt: number }): boolean {
  return [decisionAt, evidence.availableAt, evidence.measuredThrough, evidence.selectedAt].every(Number.isFinite) &&
    evidence.availableAt <= decisionAt && evidence.measuredThrough <= decisionAt && evidence.selectedAt <= decisionAt;
}
export function wholeStrategyValidity(coverage: {
  pointInTimeUniverse: boolean; survivorAndFailureCoverage: boolean; historicalMarketStates: boolean;
  inventoryAndSignals: boolean; frozenRules: boolean; untouchedEvaluation: boolean;
}) {
  const missing = Object.entries(coverage).filter(([, ok]) => !ok).map(([key]) => key);
  return { valid: missing.length === 0, missing }; // no profit/result inputs can turn invalid coverage into a pass
}
export type HistoricalQuote = {
  token: string; priceUsd: string; observedAt: number; availableAt: number;
  liquidityUsd: string | null; securityPassed: boolean | null; buyExecutable: boolean; sellExecutable: boolean;
  source: "quote" | "candle_close"; candleEndAt?: number;
};
export function postDetectionQuote(quotes: HistoricalQuote[], token: string, detectedAt: number, delayMs: number, endAt: number, maxQuoteAgeMs: number) {
  const due = detectedAt + delayMs;
  return quotes.filter((q) => q.token === token && q.observedAt >= due && q.availableAt >= q.observedAt &&
    q.availableAt <= endAt && q.availableAt - q.observedAt <= maxQuoteAgeMs &&
    (q.source !== "candle_close" || (q.candleEndAt != null && q.observedAt >= q.candleEndAt && q.availableAt >= q.candleEndAt)))
    .sort((a, b) => a.availableAt - b.availableAt)[0] ?? null;
}
