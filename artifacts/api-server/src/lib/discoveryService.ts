import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db, gmgnAudit, gmgnDiscoveryCandidates, gmgnDiscoveryObservations, gmgnDiscoveryRuns, gmgnDiscoverySettings, gmgnReadReservations, gmgnSettings, gmgnTrades, gmgnWallets, gmgnWorkerState } from "@workspace/db";
import { GetDiscoveryResponse, UpdateDiscoveryRulesBody, type DiscoveryMetrics, type DiscoveryRules } from "@workspace/api-zod";
import { activityPage, normalizeActivity } from "./gmgnActivity";
import { GmgnReadError, gmgnRead, readNumber, readTimestamp, safeErrorKind, unwrapData } from "./gmgnCli";
import { advanceCursor, chicagoDay, DEFAULT_DISCOVERY_RULES, DISCOVERY_COVERAGE, DISCOVERY_SOURCE, emptyMetrics, followingDay, forwardMetrics, historyMetrics, isRecentlyActiveTrader, observationDecision, PAPER_EVALUATION_BLOCK, qualifyCandidate, refreshDue, tokenTraders, trendingTokens } from "./discoveryPolicy";

export async function discoveryConfig(userId: string) {
  await db.insert(gmgnDiscoverySettings).values({ userId, rules: DEFAULT_DISCOVERY_RULES }).onConflictDoNothing();
  const [row] = await db.select().from(gmgnDiscoverySettings).where(eq(gmgnDiscoverySettings.userId, userId));
  return { ...row, rules: UpdateDiscoveryRulesBody.parse(row.rules) };
}
export async function discoveryState(userId: string) {
  const config = await discoveryConfig(userId);
  const [control] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId));
  const [global] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
  const candidates = await db.select().from(gmgnDiscoveryCandidates).where(eq(gmgnDiscoveryCandidates.userId, userId)).orderBy(desc(gmgnDiscoveryCandidates.pinned), desc(gmgnDiscoveryCandidates.monitored), desc(gmgnDiscoveryCandidates.firstSeenAt));
  const rankings = await db.select().from(gmgnDiscoveryRuns).where(eq(gmgnDiscoveryRuns.userId, userId)).orderBy(desc(gmgnDiscoveryRuns.createdAt)).limit(31);
  const observations = await db.select().from(gmgnDiscoveryObservations).where(eq(gmgnDiscoveryObservations.userId, userId)).orderBy(desc(gmgnDiscoveryObservations.detectedAt)).limit(200);
  const [count] = await db.select({ n: sql<number>`count(*)::integer` }).from(gmgnReadReservations).where(gte(gmgnReadReservations.createdAt, new Date(Date.now() - 3_600_000)));
  let status = "ready", reason = "Daily discovery ready; forward paper qualification remains unavailable.";
  if (!process.env.GMGN_API_KEY?.trim()) { status = "blocked"; reason = "GMGN_API_KEY is missing. Add a server-side read-only key; do not supply a signing key."; }
  else if (control?.fullStopped) { status = "paused"; reason = "Full STOP is active. Discovery and monitored-wallet queries are stopped."; }
  else if (!config.rules.enabled) { status = "paused"; reason = "Daily discovery is off. Review the proposed rules and confirm your API plan before enabling."; }
  else if (!config.rules.planConfirmed) { status = "blocked"; reason = "API plan limits and read permissions have not been confirmed."; }
  else if (global?.backoffUntil && global.backoffUntil > new Date()) { status = "blocked"; reason = `Shared query backoff (${global.lastError ?? "upstream"}) until ${global.backoffUntil.toISOString()}.`; }
  else if (rankings[0]?.status === "running") { status = "running"; reason = "Real token/trader discovery is in progress; partial coverage is not a complete ranking."; }
  else if (config.lastError) { status = "blocked"; reason = `Discovery blocked: ${config.lastError}. Check read permissions/quota; unsupported response schemas are never replaced with invented data.`; }
  const completed = rankings.find((r) => r.status === "complete");
  const day = chicagoDay(new Date());
  const monitored = candidates.filter((c) => c.monitored);
  const overdue = monitored.some((c) => !c.lastObservedAt || Date.now() - c.lastObservedAt.getTime() > config.rules.observationIntervalMinutes * 120_000);
  return GetDiscoveryResponse.parse({
    status, reason, chicagoDay: day, timeZone: "America/Chicago", sourceLabel: DISCOVERY_SOURCE,
    coverage: DISCOVERY_COVERAGE, executionBlocked: true,
    monitoringStatus: status === "blocked" ? "blocked" : control?.paused ? "paused by worker control" : !config.rules.enabled ? "discovery disabled" : !monitored.length ? "no shortlisted wallets yet" : overdue ? "pending or overdue observations" : "observing within configured interval",
    lastRefreshAt: completed?.completedAt ?? null, nextRefreshDay: completed?.chicagoDay === day ? followingDay(day) : day,
    requestsLastHour: count.n, rules: config.rules,
    candidates: candidates.map((c) => ({ ...c, metrics: { ...emptyMetrics(), ...(c.metrics as object) } })),
    rankings: rankings.map((r) => ({ ...r, sourceLabel: DISCOVERY_SOURCE })),
    observations,
  });
}
type Candidate = typeof gmgnDiscoveryCandidates.$inferSelect;
type Run = typeof gmgnDiscoveryRuns.$inferSelect;

async function updateTokenCandidates(userId: string, run: Run, token: Record<string, unknown>, rules: DiscoveryRules) {
  const response = await gmgnRead(["token", "traders", "--chain", "sol", "--address", String(token.address), "--limit", String(rules.tradersPerToken), "--order-by", "buy_tx_count_cur", "--direction", "desc", "--raw"]);
  const now = new Date();
  const known = await db.select().from(gmgnDiscoveryCandidates).where(eq(gmgnDiscoveryCandidates.userId, userId));
  const map = new Map(known.map((c) => [c.address, c]));
  const traders = tokenTraders(response).slice(0, rules.tradersPerToken);
  if (traders.length && traders.every((t) => !readTimestamp(t.last_active_timestamp))) throw new GmgnReadError("unsupported");
  for (const trader of traders) {
    const activeAt = readTimestamp(trader.last_active_timestamp);
    // An old top trader is not evidence of a currently active wallet.
    if (!activeAt || !isRecentlyActiveTrader(trader, now)) continue;
    const address = String(trader.address), existing = map.get(address);
    const old = existing?.provenance as { runId?: string; sources?: Record<string, unknown>[] } | undefined;
    const sources = old?.runId === run.id ? [...(old.sources ?? [])] : [];
    if (!sources.some((s) => s.tokenAddress === token.address)) sources.push({
      tokenAddress: token.address, tokenRank: readNumber(token.rank), lastActiveAt: activeAt.toISOString(),
      trader: { address, addr_type: trader.addr_type, is_suspicious: trader.is_suspicious,
        buy_tx_count_cur: trader.buy_tx_count_cur, realized_profit: trader.realized_profit,
        unrealized_profit: trader.unrealized_profit, wallet_tag_v2: trader.wallet_tag_v2 },
      startHoldingAt: trader.start_holding_at, endHoldingAt: trader.end_holding_at,
    });
    const provenance = { sourceLabel: DISCOVERY_SOURCE, cliVersion: "1.6.6", runId: run.id, chicagoDay: run.chicagoDay,
      fetchedAt: now.toISOString(), tokenUniverseInterval: "24h", traderActivityScope: "token lifetime; last-active verified within 24h", sources };
    const suspicious = sources.some((s) => (s.trader as Record<string, unknown>).is_suspicious === true);
    await db.insert(gmgnDiscoveryCandidates).values({
      userId, address, provenance, metrics: { ...emptyMetrics(), suspicious: typeof trader.is_suspicious === "boolean" ? trader.is_suspicious : null },
      state: suspicious && rules.excludeSuspicious ? "excluded" : "candidate",
      reasons: suspicious ? ["Official token trader source flags suspicious activity."] : ["Real active trader discovered; historical and forward evidence pending.", PAPER_EVALUATION_BLOCK],
    }).onConflictDoUpdate({
      target: [gmgnDiscoveryCandidates.userId, gmgnDiscoveryCandidates.address],
      set: { provenance, ...(suspicious && rules.excludeSuspicious ? { state: "excluded", reasons: ["Official token trader source flags suspicious activity."] } : {}) },
    });
  }
}
async function dailyRefresh(userId: string, config: Awaited<ReturnType<typeof discoveryConfig>>) {
  const rules = config.rules, now = new Date(), day = chicagoDay(now);
  const [latest] = await db.select().from(gmgnDiscoveryRuns).where(eq(gmgnDiscoveryRuns.userId, userId)).orderBy(desc(gmgnDiscoveryRuns.createdAt)).limit(1);
  // Resume incomplete runs even across a date change; do not silently label yesterday's universe as today's.
  let run = latest && latest.status !== "complete" ? latest : undefined;
  if (!run && !refreshDue(latest?.chicagoDay ?? null, config.refreshRequested, now)) return;
  if (!run) {
    run = await db.transaction(async (tx) => {
      const [created] = await tx.insert(gmgnDiscoveryRuns).values({ userId, chicagoDay: day, coverage: DISCOVERY_COVERAGE }).returning();
      await tx.update(gmgnDiscoverySettings).set({ refreshRequested: false }).where(eq(gmgnDiscoverySettings.userId, userId));
      return created;
    });
  }
  try {
    await db.update(gmgnDiscoveryRuns).set({ status: "running", error: null }).where(eq(gmgnDiscoveryRuns.id, run.id));
    let tokens = run.tokens as Record<string, unknown>[];
    if (!tokens.length && run.nextTokenIndex === 0) {
      tokens = trendingTokens(await gmgnRead(["market", "trending", "--chain", "sol", "--interval", "24h", "--limit", String(rules.tokenLimit), "--raw"])).slice(0, rules.tokenLimit);
      await db.update(gmgnDiscoveryRuns).set({ tokens }).where(eq(gmgnDiscoveryRuns.id, run.id));
    }
    for (let i = run.nextTokenIndex; i < tokens.length; i++) {
      const [stop] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId));
      const current = await discoveryConfig(userId);
      if (stop?.fullStopped || !current.rules.enabled) return;
      await updateTokenCandidates(userId, run, tokens[i], rules);
      await db.update(gmgnDiscoveryRuns).set({ nextTokenIndex: i + 1 }).where(eq(gmgnDiscoveryRuns.id, run.id));
    }
    const all = await db.select().from(gmgnDiscoveryCandidates).where(eq(gmgnDiscoveryCandidates.userId, userId));
    const entries = all.filter((c) => (c.provenance as { runId?: string }).runId === run!.id).map((c) => {
      const sources = (c.provenance as { sources: { trader: { buy_tx_count_cur?: unknown } }[] }).sources;
      return { address: c.address, state: c.state, score: c.score, reasons: c.reasons, metrics: c.metrics,
        firstSeenAt: c.firstSeenAt, evaluationId: c.evaluationId, observationStartedAt: c.observationStartedAt,
        sourceTokenCount: sources.length, reportedTokenBuyCount: sources.reduce((sum, s) => sum + (readNumber(s.trader.buy_tx_count_cur) ?? 0), 0), provenance: c.provenance };
    }).sort((a, b) => b.sourceTokenCount - a.sourceTokenCount || b.reportedTokenBuyCount - a.reportedTokenBuyCount || a.address.localeCompare(b.address))
      .map((e, index) => ({ ...e, rank: index + 1 }));
    const completedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.update(gmgnDiscoveryRuns).set({ status: "complete", entries, completedAt, error: null }).where(eq(gmgnDiscoveryRuns.id, run!.id));
      await tx.update(gmgnDiscoverySettings).set({ lastSuccessAt: completedAt, lastError: null }).where(eq(gmgnDiscoverySettings.userId, userId));
      await tx.insert(gmgnAudit).values({ userId, action: "derived_discovery_refreshed", detail: `${run!.chicagoDay} Chicago: ${entries.length} real active candidates from ${tokens.length} trending tokens. Derived activity ranking, not official wallet leaderboard.` });
    });
  } catch (error) {
    const kind = error instanceof Error && /schema|pagination/i.test(error.message) ? "unsupported" : safeErrorKind(error);
    await db.update(gmgnDiscoveryRuns).set({ status: "blocked", error: kind }).where(eq(gmgnDiscoveryRuns.id, run.id));
    await db.update(gmgnDiscoverySettings).set({ lastError: kind }).where(eq(gmgnDiscoverySettings.userId, userId));
    throw new GmgnReadError(kind);
  }
}
async function observeCandidate(userId: string, candidate: Candidate, rules: DiscoveryRules) {
  const now = new Date();
  if (candidate.lastObservedAt && now.getTime() - candidate.lastObservedAt.getTime() < rules.observationIntervalMinutes * 60_000) return;
  const stats = await gmgnRead(["portfolio", "stats", "--chain", "sol", "--wallet", candidate.address, "--period", "30d", "--raw"]);
  const cursor = candidate.baselineComplete ? candidate.pollCursor : candidate.baselineCursor;
  const args = ["portfolio", "activity", "--chain", "sol", "--wallet", candidate.address, "--limit", "50", "--raw"];
  if (cursor) args.push("--cursor", cursor);
  const page = activityPage(await gmgnRead(args));
  const cursorHistory = advanceCursor((candidate.baselineComplete ? candidate.pollCursorHistory : candidate.baselineCursorHistory) as string[], cursor, page.next);
  const detectedAt = new Date();
  const events = page.activities.map((row) => normalizeActivity(candidate.address, row)).filter((e) => e != null);
  const [control] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId));
  if (control?.paused || control?.fullStopped) return;
  const baseline = !candidate.baselineComplete;
  const started = candidate.observationStartedAt ?? (!page.next && baseline ? detectedAt : null);
  const provenance = candidate.provenance as { sources?: { trader: Record<string, unknown>; startHoldingAt?: unknown; endHoldingAt?: unknown }[] };
  const sourceFlags = (provenance.sources ?? []).map((s) => s.trader.is_suspicious);
  const suspicious = sourceFlags.includes(true) ? true : sourceFlags.length && sourceFlags.every((f) => f === false) ? false : null;
  const holds = (provenance.sources ?? []).flatMap((s) => {
    const start = readTimestamp(s.startHoldingAt), end = readTimestamp(s.endHoldingAt);
    return start && end && end >= start && end <= detectedAt ? [(end.getTime() - start.getTime()) / 1000] : [];
  });
  const metrics: DiscoveryMetrics = {
    ...emptyMetrics(), ...(candidate.metrics as object),
    ...(!cursor ? historyMetrics(stats, page.activities, suspicious, holds) : {}),
    historicalRealizedPnlUsd: readNumber(unwrapData(stats).realized_profit),
    historicalUnrealizedPnlUsd: readNumber(unwrapData(stats).unrealized_profit),
    historicalSells: readNumber(unwrapData(stats).sell_count),
    suspicious,
  };
  const fills = await db.select().from(gmgnTrades).where(and(eq(gmgnTrades.userId, userId), eq(gmgnTrades.evaluationId, candidate.evaluationId))).orderBy(asc(gmgnTrades.filledAt));
  Object.assign(metrics, forwardMetrics(fills, candidate.evaluationId, started, detectedAt), { copyabilityVerified: false });
  const regular = (provenance.sources ?? []).every((s) => s.trader.addr_type === 0) && Boolean(provenance.sources?.length);
  const decision = qualifyCandidate(metrics, rules, candidate.manualExcluded, regular);
  const committed = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(gmgnDiscoveryCandidates).where(and(eq(gmgnDiscoveryCandidates.userId, userId), eq(gmgnDiscoveryCandidates.address, candidate.address))).for("update");
    if (!fresh || fresh.manualExcluded || fresh.state === "excluded" || fresh.evaluationId !== candidate.evaluationId) return false;
    for (const event of events) {
      const classification = observationDecision(candidate.baselineComplete, candidate.observationStartedAt, event.observedAt, detectedAt, control?.maxSignalAgeSeconds ?? 60);
      await tx.insert(gmgnDiscoveryObservations).values({
        userId, address: candidate.address, evaluationId: candidate.evaluationId, eventIdentity: event.identity,
        tokenAddress: event.tokenAddress, side: event.side, observedAt: event.observedAt, detectedAt,
        status: classification.status, reason: classification.reason,
        provenance: { source: "gmgn-cli@1.6.6 portfolio activity", record: event.raw, quoteEvidence: null },
      }).onConflictDoNothing();
    }
    await tx.update(gmgnDiscoveryCandidates).set({
      metrics, state: decision.state, score: decision.score, reasons: decision.reasons,
      baselineComplete: candidate.baselineComplete || !page.next,
      baselineCursor: baseline ? page.next : null, pollCursor: baseline ? null : page.next,
      baselineCursorHistory: baseline ? cursorHistory : [],
      pollCursorHistory: baseline ? [] : cursorHistory,
      observationStartedAt: started, evaluationStartedAt: candidate.evaluationStartedAt ?? now,
      evaluationRules: candidate.evaluationRules ?? rules, lastObservedAt: detectedAt,
      qualifiedAt: decision.state === "qualified" ? candidate.qualifiedAt ?? detectedAt : null,
    }).where(and(eq(gmgnDiscoveryCandidates.userId, userId), eq(gmgnDiscoveryCandidates.address, candidate.address)));
    return true;
  });
  if (!committed) return;
  // This activation branch cannot be reached with today's unverified execution adapter.
  // Pinning and historical profits never set copyabilityVerified or bypass this decision.
  if (decision.state === "qualified" && !rules.selectionPaused && control?.setupComplete && !control.paused && !control.buysHalted && rules.autoBuyBudgetUsd > 0 && rules.autoBuyBudgetUsd <= Number(control.maxBuyUsd)) {
    const watched = await db.select().from(gmgnWallets).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.enabled, true)));
    if (watched.length < rules.maxMonitoredWallets && !watched.some((w) => w.address === candidate.address)) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(91200344)`);
        const rows = await tx.select().from(gmgnWallets).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.enabled, true)));
        if (rows.length >= rules.maxMonitoredWallets) return;
        const inserted = await tx.insert(gmgnWallets).values({ userId, address: candidate.address, label: `Qualified ${candidate.address.slice(0, 6)}`, enabled: true, automatic: true, buyBudgetUsd: String(rules.autoBuyBudgetUsd), baselineComplete: false }).onConflictDoNothing().returning();
        if (inserted.length) await tx.insert(gmgnAudit).values({ userId, action: "qualified_wallet_watched", detail: "Forward-qualified wallet enrolled; fresh historical baseline required before any new signal." });
      });
    }
  }
}
export async function runDiscoveryCycle() {
  const configs = await db.select().from(gmgnDiscoverySettings);
  for (const stored of configs) {
    const config = { ...stored, rules: UpdateDiscoveryRulesBody.parse(stored.rules) };
    if (!config.rules.enabled || !config.rules.planConfirmed) continue;
    const [control] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, stored.userId));
    if (control?.fullStopped) continue;
    try {
      await dailyRefresh(stored.userId, config);
      if (!control || control.paused) continue;
      const candidates = await db.select().from(gmgnDiscoveryCandidates).where(eq(gmgnDiscoveryCandidates.userId, stored.userId));
      const watched = await db.select().from(gmgnWallets).where(and(eq(gmgnWallets.userId, stored.userId), eq(gmgnWallets.enabled, true)));
      const used = new Set(watched.slice(0, config.rules.maxMonitoredWallets).map((w) => w.address));
      const chosen = candidates.filter((c) => c.state !== "excluded" && !c.manualExcluded)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.monitored) - Number(a.monitored) || a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
      await db.update(gmgnDiscoveryCandidates).set({ monitored: false }).where(eq(gmgnDiscoveryCandidates.userId, stored.userId));
      for (const candidate of chosen) {
        if (!used.has(candidate.address) && used.size >= config.rules.maxMonitoredWallets) continue;
        used.add(candidate.address);
        await db.update(gmgnDiscoveryCandidates).set({ monitored: true }).where(and(eq(gmgnDiscoveryCandidates.userId, stored.userId), eq(gmgnDiscoveryCandidates.address, candidate.address)));
        await observeCandidate(stored.userId, candidate, config.rules);
      }
      await db.update(gmgnDiscoverySettings).set({ lastError: null }).where(eq(gmgnDiscoverySettings.userId, stored.userId));
    } catch (error) {
      const kind = error instanceof Error && /schema|pagination/i.test(error.message) ? "unsupported" : safeErrorKind(error);
      await db.update(gmgnDiscoverySettings).set({ lastError: kind }).where(eq(gmgnDiscoverySettings.userId, stored.userId));
      throw new GmgnReadError(kind); // shared worker backoff stops further requests this tick
    }
  }
}
