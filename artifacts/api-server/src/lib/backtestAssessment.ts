import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, gmgnBacktestRuns, gmgnDiscoveryRuns, gmgnSettings, gmgnSignals, gmgnTrades } from "@workspace/db";
import { GetBacktestingResponse, GetBacktestReportResponse, type BacktestPrerequisite } from "@workspace/api-zod";
import { discoveryConfig } from "./discoveryService";
import { evidenceRows, evidenceSummary, inspectProviderHistory } from "./providerEvidence";
import { BACKTEST_ASSUMPTIONS, BACKTEST_SOURCES, freezeHistoricalRules } from "./backtestPolicy";

export async function assessHistoricalCoverage(userId: string, probe = false, periodsComplete = false, rulesFrozen = false) {
  const key = Boolean(process.env.GMGN_API_KEY?.trim());
  let permissions = key ? "Unverified: key presence is not permission or history coverage." : "Unverified: GMGN_API_KEY missing; no GMGN queries attempted.";
  let attempted = false, currentReadVerified = false;
  if (probe && key) {
    const inspected = await inspectProviderHistory(userId);
    attempted = !inspected.reused && inspected.state !== "busy";
  }
  const evidence = await evidenceRows(userId);
  const verified = evidence.filter((r) => r.status === "verified_sample");
  currentReadVerified = verified.some((r) => r.capturedAt.getTime() > Date.now() - 86_400_000);
  if (key && verified.length) {
    const sources = [...new Set(verified.map((r) => r.source))].join(", ");
    const quote = evidence.find((r) => r.source === "quote");
    permissions = `Persisted real-provider samples verified for: ${sources}. Latest successful read ${verified[0].capturedAt.toISOString()}. Quote: ${quote?.status ?? "unverified"}${quote?.metadata.errorKind ? ` (${quote.metadata.errorKind})` : ""}. This is sampled capability evidence, not exhaustive historical retention, complete wallet coverage or paper-fill readiness.`;
  }
  const countAndRange = { records: sql<number>`count(*)::integer` };
  const [discovery] = await db.select({ ...countAndRange, from: sql<Date | null>`min(${gmgnDiscoveryRuns.createdAt})`, to: sql<Date | null>`max(${gmgnDiscoveryRuns.completedAt})` }).from(gmgnDiscoveryRuns)
    .where(and(eq(gmgnDiscoveryRuns.userId, userId), eq(gmgnDiscoveryRuns.status, "complete")));
  const [signals] = await db.select({ ...countAndRange, from: sql<Date | null>`min(${gmgnSignals.observedAt})`, to: sql<Date | null>`max(${gmgnSignals.observedAt})` }).from(gmgnSignals).where(eq(gmgnSignals.userId, userId));
  const [quotes] = await db.select({ ...countAndRange, from: sql<Date | null>`min(${gmgnSignals.priceObservedAt})`, to: sql<Date | null>`max(${gmgnSignals.priceObservedAt})` }).from(gmgnSignals)
    .where(and(eq(gmgnSignals.userId, userId), isNotNull(gmgnSignals.priceUsd), isNotNull(gmgnSignals.priceObservedAt)));
  const [forward] = await db.select({ ...countAndRange, from: sql<Date | null>`min(${gmgnTrades.filledAt})`, to: sql<Date | null>`max(${gmgnTrades.filledAt})` }).from(gmgnTrades).where(eq(gmgnTrades.userId, userId));
  const prerequisite = (code: string, status: BacktestPrerequisite["status"], detail: string, resolution: string): BacktestPrerequisite => ({ code, status, detail, resolution });
  const prerequisites = [
    prerequisite("credentials", key ? "verified" : "missing", key ? "A server-side GMGN key is present, but no secret values are exposed." : "No GMGN_API_KEY is available.", "Add your GMGN read-only API key through server-side Secrets. Keep trading off; no signing key is needed."),
    prerequisite("permissions_and_retention", currentReadVerified ? "partial" : "unverified", permissions, "Verify the actual plan's wallet-history/candle permissions, date retention, pagination and quotas using genuine source responses. A current rank read proves only that capability."),
    prerequisite("chronological_periods", periodsComplete ? "verified" : "missing", periodsComplete ? "Nonoverlapping historical development/evaluation dates selected." : "No complete chronological development/evaluation split is selected.", "Choose all four dates: development first, followed by an untouched evaluation period; neither may include today's incomplete day."),
    prerequisite("rules_freeze", rulesFrozen ? "verified" : "missing", rulesFrozen ? "The exact strategy/risk rules are frozen in this request before any evaluation." : "No evaluation rule freeze has been confirmed.", "Explicitly freeze the displayed discovery and paper-risk rules before evaluating. Disclose prior inspection or reuse of the evaluation data."),
    prerequisite("point_in_time_universe", discovery.records ? "partial" : "missing", `${discovery.records} completed local discovery snapshots. No validated historical as-of universe for the requested dates. Current trending queries have no documented historical-as-of parameter.`, "Provide genuine timestamped candidate/token discovery archives available at every historical Chicago decision, including eligibility data for losing/inactive wallets and failed/delisted tokens, with explicit gaps."),
    prerequisite("canonical_signals_and_inventory", signals.records ? "partial" : "missing", `${signals.records} locally observed signal records; completeness and pre-sell inventory are not validated.`, "Provide canonical chain/transaction/event identities, historical availability times, quantities and pre-trade leader inventory over the full period plus baseline/warmup. Current holdings cannot infer historical proportional sells."),
    prerequisite("historical_quotes_and_market_states", quotes.records || verified.some((r) => r.source === "candles") ? "partial" : "missing", `${quotes.records} local priced signal observations. Dated candle samples are separately listed below; current security/pools cannot be used as historical states. No validated historical execution/liquidity/security archive.`, "Provide timestamped post-detection quotes or valid delayed-price evidence, historical depth/liquidity and security, spreads where available, failure/unsellable status and terminal valuation. Candles alone are insufficient; candle close is not known at candle open."),
    prerequisite("validated_archive_and_simulator", verified.length ? "partial" : "missing", "A bounded direct-provider importer now persists actual response schemas, dates, pagination samples, redacted queryable source records and integrity hashes. Historical-as-of archive ingestion and a validated whole-strategy discovery/qualification replay adapter remain unavailable.", "Obtain genuine timestamped discovery/population and market-state archives for a chronological development/evaluation period without purchasing services here. Validate source availability, completeness, inventory and failures before implementing or running whole-strategy replay; do not substitute current winners."),
    prerequisite("untouched_evaluation", "unverified", "No evaluation data has been executed here. Prior external inspection/reuse is unknown.", "Document which period was used to develop rules, freeze before first evaluation, and disclose tuning/repeated tests. Positive return is not evidence of validity."),
  ];
  return {
    checkedAt: new Date(), status: "blocked" as const, apiKeyPresent: key, permissions,
    gmgnQueriesAttempted: attempted, fullStrategyAvailable: false,
    prerequisites,
    coverage: [
      { name: "Daily discovery snapshots", ...discovery, scope: "Owner's real locally collected derived daily universe", limitation: "Partial filtered sources cannot reconstruct an older full market or omitted failures." },
      { name: "Wallet signal history", ...signals, scope: "Owner's locally observed signals, not all historical wallets", limitation: "Today's wallet selection and current realized results cannot select past winners." },
      { name: "Priced observations", ...quotes, scope: "Recorded price and observation timestamps only", limitation: "Not a validated historical spread/depth/security or executable-price archive." },
      { name: "Forward paper fills (separate)", ...forward, scope: "Prospective simulated ledger, never relabeled a backtest", limitation: "Current forward fills remain blocked pending quote/identity verification." },
      ...evidence.filter((r) => r.source !== "whole_strategy").map((r) => ({
        name: `Provider sample: ${r.source} (${r.capturedAt.toISOString()})`,
        records: r.recordCount, from: r.returnedFrom, to: r.returnedTo,
        scope: `Separate ${r.status} sample; retrieved now, not then-available universe.`, limitation: r.limitation,
      })),
    ],
    providerEvidence: evidence.map(evidenceSummary),
    sources: BACKTEST_SOURCES, limitations: BACKTEST_ASSUMPTIONS,
  };
}
export async function backtestingState(userId: string) {
  const rows = await db.select().from(gmgnBacktestRuns).where(eq(gmgnBacktestRuns.userId, userId)).orderBy(sql`${gmgnBacktestRuns.requestedAt} DESC`).limit(50);
  const proposed = freezeHistoricalRules(await snapshotBacktestRules(userId));
  return GetBacktestingResponse.parse({ assessment: await assessHistoricalCoverage(userId),
    runs: rows.map(backtestReport), forwardEvaluationSeparate: true,
    proposedRules: proposed.rules, proposedRulesHash: proposed.hash,
    notification: "Backtesting has NOT started. Requests are blocked until genuine point-in-time coverage and a validated replay path exist. No completion or profitability is claimed." });
}
export function backtestReport(row: typeof gmgnBacktestRuns.$inferSelect) {
  return GetBacktestReportResponse.parse({ ...row, kind: "whole_strategy_point_in_time", progressPct: null, processedTrades: null,
    validity: row.status === "failed" ? "Assessment failed; no strategy result." : "Blocked: complete-strategy validity cannot be established.",
    profitability: "Not measured. No backtest executed; no claim of profitability.",
    assumptions: row.assumptions, liveTradingEnabled: false });
}
export async function reconcileInterruptedBacktestAssessments(bootAt: Date) {
  await db.update(gmgnBacktestRuns).set({ status: "failed", assessedAt: bootAt })
    .where(and(eq(gmgnBacktestRuns.status, "assessing"), isNull(gmgnBacktestRuns.startedAt), lt(gmgnBacktestRuns.requestedAt, bootAt)));
}
export async function snapshotBacktestRules(userId: string) {
  const discovery = await discoveryConfig(userId);
  const [risk] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId));
  return { discovery: discovery.rules, paperRisk: risk ? {
    setupComplete: risk.setupComplete, maxBuyUsd: risk.maxBuyUsd, totalExposureUsd: risk.totalExposureUsd,
    maxOpenPositions: risk.maxOpenPositions, maxTradesPerDay: risk.maxTradesPerDay,
    maxSignalAgeSeconds: risk.maxSignalAgeSeconds, minLiquidityUsd: risk.minLiquidityUsd,
    maxTopHolderPct: risk.maxTopHolderPct, dailyLossCutoffUsd: risk.dailyLossCutoffUsd,
    feeBps: risk.feeBps, slippageBps: risk.slippageBps, latencyMs: risk.latencyMs,
    paperCashUsd: risk.paperCashUsd, followSells: risk.followSells, stopLossPct: risk.stopLossPct, takeProfitPct: risk.takeProfitPct,
  } : null, chain: "sol", liveTradingEnabled: false, selection: "derived_traders_of_trending_tokens", quoteVerification: "unverified",
    historicalSimulator: "unavailable_pending_validated_archive_and_point_in_time_selection_replay" };
}
