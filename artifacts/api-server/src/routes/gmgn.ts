import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import {
  db,
  gmgnAudit,
  gmgnEquityPoints,
  gmgnDiscoverySettings,
  gmgnPositions,
  gmgnSettings,
  gmgnSignals,
  gmgnTrades,
  gmgnWallets,
  gmgnWorkerState,
} from "@workspace/db";
import {
  CreateWalletBody,
  GetBotStateResponse,
  GetRiskSettingsResponse,
  GetWalletResearchResponse,
  ListAuditResponse,
  ListPositionsResponse,
  ListSignalsResponse,
  ListTradesResponse,
  ListWalletsResponse,
  UpdateBotControlBody,
  UpdateRiskSettingsBody,
  UpdateWalletBody,
} from "@workspace/api-zod";
import { gmgnRead, readNumber, readTimestamp, safeErrorKind, unwrapData } from "../lib/gmgnCli";
import { LIVE_TRADING_ENABLED } from "../lib/paperTrading";
import discoveryRouter, { DISCOVERY_PATH } from "./discovery";
import { discoveryConfig } from "../lib/discoveryService";
import backtestingRouter, { BACKTESTING_PATH } from "./backtesting";
import { evidenceRows, forwardReadiness } from "../lib/providerEvidence";
import { paperStartupBlock } from "../lib/paperReadinessGate";

const router = Router();
const SUGGESTED = {
  maxBuyUsd: "25",
  totalExposureUsd: "100",
  maxOpenPositions: 5,
  maxTradesPerDay: 5,
  maxSignalAgeSeconds: 60,
  minLiquidityUsd: "10000",
  maxTopHolderPct: "20",
  dailyLossCutoffUsd: "25",
  feeBps: "100",
  slippageBps: "150",
  latencyMs: 1500,
  paperCashUsd: "0",
};

function num(value: unknown): number {
  return readNumber(value) ?? 0;
}

function solAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const char of value) decoded = decoded * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (decoded > 0n) { bytes++; decoded >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}

function ownerId(req: Request, res: Response): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to access this private dashboard." });
    return null;
  }
  return userId;
}

async function getSettings(userId: string) {
  await db
    .insert(gmgnSettings)
    .values({ userId, ...SUGGESTED })
    .onConflictDoNothing();
  const [settings] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId)).limit(1);
  return settings;
}

async function audit(userId: string, action: string, detail: string) {
  await db.insert(gmgnAudit).values({ userId, action, detail: detail.slice(0, 500) });
}

function riskData(settings: NonNullable<Awaited<ReturnType<typeof getSettings>>>) {
  return GetRiskSettingsResponse.parse({
    maxBuyUsd: num(settings.maxBuyUsd),
    totalExposureUsd: num(settings.totalExposureUsd),
    maxOpenPositions: settings.maxOpenPositions,
    maxTradesPerDay: settings.maxTradesPerDay,
    maxSignalAgeSeconds: settings.maxSignalAgeSeconds,
    minLiquidityUsd: num(settings.minLiquidityUsd),
    maxTopHolderPct: num(settings.maxTopHolderPct),
    dailyLossCutoffUsd: num(settings.dailyLossCutoffUsd),
    feeBps: num(settings.feeBps),
    slippageBps: num(settings.slippageBps),
    latencyMs: settings.latencyMs,
    stopLossPct: settings.stopLossPct == null ? null : num(settings.stopLossPct),
    takeProfitPct: settings.takeProfitPct == null ? null : num(settings.takeProfitPct),
    followSells: settings.followSells,
    paperCashUsd: num(settings.paperCashUsd),
    setupComplete: settings.setupComplete,
  });
}

async function botState(userId: string) {
  const settings = await getSettings(userId);
  const [walletRows, positionRows, trades, equityRows, workerRows] = await Promise.all([
    db.select().from(gmgnWallets).where(eq(gmgnWallets.userId, userId)),
    db.select().from(gmgnPositions).where(eq(gmgnPositions.userId, userId)),
    db.select().from(gmgnTrades).where(eq(gmgnTrades.userId, userId)),
    db.select().from(gmgnEquityPoints).where(eq(gmgnEquityPoints.userId, userId)).orderBy(desc(gmgnEquityPoints.createdAt)).limit(120),
    db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol")).limit(1),
  ]);
  const realizedPnlUsd = trades.reduce((sum, trade) => sum + num(trade.realizedPnlUsd), 0);
  const exposureUsd = positionRows.reduce((sum, position) => sum + num(position.costBasisUsd), 0);
  const unrealizedPnlUsd = positionRows.reduce((sum, position) => {
    const price = num(position.markPriceUsd);
    return sum + (price > 0 ? num(position.quantity) * price - num(position.costBasisUsd) : 0);
  }, 0);
  const cashUsd = num(settings.paperCashUsd);
  const equityUsd = cashUsd + exposureUsd + unrealizedPnlUsd;
  const keyPresent = Boolean(process.env.GMGN_API_KEY?.trim());
  const rateLimited = Boolean(workerRows[0]?.lastError === "rate_limited" && workerRows[0]?.backoffUntil && workerRows[0].backoffUntil > new Date());
  const sources = await evidenceRows(userId);
  const recentRead = sources.find((r) => r.status === "verified_sample" && r.capturedAt.getTime() > Date.now() - 86_400_000);
  const sharedBlocked = Boolean(workerRows[0]?.lastError && workerRows[0]?.backoffUntil && workerRows[0].backoffUntil > new Date());
  const status = !keyPresent ? "missing_key" : rateLimited ? "rate_limited" :
    !sharedBlocked && !settings.workerError && (settings.lastSuccessAt || recentRead) ? "connected" : "error";
  let workerStatus: "running" | "paused" | "blocked" | "idle" | "error" = "idle";
  if (!keyPresent || !settings.setupComplete) workerStatus = "blocked";
  else if (settings.fullStopped || settings.paused) workerStatus = "paused";
  else if (settings.workerError) workerStatus = "error";
  else workerStatus = walletRows.some((w) => w.enabled) ? "running" : "idle";
  const openPositions = positionRows.filter((p) => num(p.quantity) > 0).length;
  const data = GetBotStateResponse.parse({
    connectionStatus: status,
    connectionMessage: keyPresent
      ? rateLimited
        ? `A GMGN rate-limit condition was recorded; the application's persisted read backoff lasts until ${workerRows[0]?.backoffUntil?.toISOString()}. Earlier successful source samples do not prove quote readiness.`
        : settings.workerError
          ? `GMGN reads are blocked (${settings.workerError}). Verify read permission, IP allowlisting, quota, and key validity.`
          : sharedBlocked
            ? `Provider reads are blocked (${workerRows[0]?.lastError}) until ${workerRows[0]?.backoffUntil?.toISOString()}. Earlier successful samples remain visible under Backtesting; this does not verify quotes or historical coverage.`
            : recentRead
              ? `Real provider read verified at ${recentRead.capturedAt.toISOString()} (${recentRead.source}); wallet monitoring remains separate and its last-success timestamp is unchanged. Paper execution and full historical backtesting are not ready.`
              : "Key configured, but no recent persisted provider read is verified. Paper entries remain blocked until quote, freshness and event evidence are verified; live execution is unavailable."
      : "GMGN_API_KEY is not configured. Add a read-only key in Replit Secrets to enable GMGN queries.",
    workerStatus,
    lastSuccessAt: settings.lastSuccessAt,
    observedLatencyMs: settings.observedLatencyMs,
    liveTradingEnabled: LIVE_TRADING_ENABLED,
    mode: "paper",
    paused: settings.paused,
    buysHalted: settings.buysHalted,
    fullStopped: settings.fullStopped,
    cashUsd,
    exposureUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    equityUsd,
    equityHistory: equityRows.reverse().map((item) => ({ at: item.createdAt, equityUsd: num(item.equityUsd) })),
    setupComplete: settings.setupComplete,
    walletCount: walletRows.length,
    enabledWalletCount: walletRows.filter((w) => w.enabled).length,
    openPositionCount: openPositions,
  });
  return data;
}

router.use((req, res, next) => {
  if (!ownerId(req, res)) return;
  next();
});

router.get("/state", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    return res.json(await botState(userId));
  } catch (error) {
    return next(error);
  }
});

router.get("/wallets", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const rows = await db.select().from(gmgnWallets).where(eq(gmgnWallets.userId, userId)).orderBy(desc(gmgnWallets.createdAt));
    return res.json(ListWalletsResponse.parse(rows.map((w) => ({
      address: w.address,
      label: w.label,
      enabled: w.enabled,
      buyBudgetUsd: num(w.buyBudgetUsd),
      createdAt: w.createdAt,
      lastActivityAt: w.lastActivityAt,
    }))));
  } catch (error) {
    return next(error);
  }
});

router.post("/wallets", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const parsed = CreateWalletBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Wallet address, label, or individual paper budget is invalid." });
    const address = parsed.data.address.trim();
    if (!solAddress(address)) return res.status(400).json({ error: "Enter a valid 32-byte Solana base58 address." });
    if (!parsed.data.label.trim()) return res.status(400).json({ error: "Wallet label cannot be blank." });
    const [created] = await db.insert(gmgnWallets).values({
      userId,
      address,
      label: parsed.data.label.trim(),
      buyBudgetUsd: String(parsed.data.buyBudgetUsd),
      enabled: false,
    }).onConflictDoNothing().returning();
    if (!created) return res.status(409).json({ error: "That wallet is already in your watchlist." });
    await audit(userId, "wallet_added", `${created.label} (${created.address.slice(0, 5)}…${created.address.slice(-4)})`);
    return res.status(201).json({
      address: created.address,
      label: created.label,
      enabled: created.enabled,
      buyBudgetUsd: num(created.buyBudgetUsd),
      createdAt: created.createdAt,
      lastActivityAt: created.lastActivityAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/wallets/:address", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const parsed = UpdateWalletBody.safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data).length) return res.status(400).json({ error: "Provide a valid label, enabled state, or paper budget." });
    const fields = parsed.data;
    if (fields.label !== undefined && !fields.label.trim()) return res.status(400).json({ error: "Wallet label cannot be blank." });
    const update: Record<string, unknown> = {};
    if (fields.label !== undefined) update.label = fields.label.trim();
    if (fields.enabled !== undefined) update.enabled = fields.enabled;
    if (fields.enabled === true) {
      update.baselineComplete = false;
      update.baselineCursor = null;
      update.pollCursor = null;
      update.baselineCursorHistory = [];
      update.pollCursorHistory = [];
    }
    if (fields.buyBudgetUsd !== undefined) update.buyBudgetUsd = String(fields.buyBudgetUsd);
    const config = await discoveryConfig(userId);
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(91200344)`);
      const [currentConfig] = await tx.select().from(gmgnDiscoverySettings).where(eq(gmgnDiscoverySettings.userId, userId));
      const currentCap = (currentConfig?.rules as { maxMonitoredWallets?: number } | undefined)?.maxMonitoredWallets ?? config.rules.maxMonitoredWallets;
      const watched = await tx.select().from(gmgnWallets).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.enabled, true)));
      if (fields.enabled === true && !watched.some((w) => w.address === req.params.address) && watched.length >= currentCap) return "cap" as const;
      const [row] = await tx.update(gmgnWallets).set(update).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.address, req.params.address))).returning();
      return row;
    });
    if (updated === "cap") return res.status(409).json({ error: "Monitored-wallet cap reached. Disable another wallet or review the discovery count limit." });
    if (!updated) return res.status(404).json({ error: "Wallet not found." });
    await audit(userId, "wallet_updated", `Updated ${updated.label} (${updated.address.slice(0, 5)}…${updated.address.slice(-4)})`);
    return res.json({
      address: updated.address,
      label: updated.label,
      enabled: updated.enabled,
      buyBudgetUsd: num(updated.buyBudgetUsd),
      createdAt: updated.createdAt,
      lastActivityAt: updated.lastActivityAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/wallets/:address", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const [deleted] = await db.delete(gmgnWallets).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.address, req.params.address))).returning({ address: gmgnWallets.address });
    if (!deleted) return res.status(404).json({ error: "Wallet not found." });
    await audit(userId, "wallet_removed", `Removed wallet ${deleted.address.slice(0, 5)}…${deleted.address.slice(-4)}`);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

router.get("/wallets/:address/research", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const address = req.params.address;
    if (!solAddress(address)) return res.status(400).json({ error: "Invalid Solana address." });
    const now = new Date();
    const unavailableMetrics: string[] = [];
    let stats: Record<string, unknown> = {};
    let activities: Record<string, unknown>[] = [];
    let failure: string | null = null;
    try {
      const [statsRaw, activityRaw] = await Promise.all([
        gmgnRead(["portfolio", "stats", "--chain", "sol", "--wallet", address, "--period", "30d", "--raw"]),
        gmgnRead(["portfolio", "activity", "--chain", "sol", "--wallet", address, "--limit", "50", "--raw"]),
      ]);
      stats = unwrapData(statsRaw);
      const activityData = unwrapData(activityRaw);
      activities = Array.isArray(activityData.activities)
        ? activityData.activities.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
        : [];
    } catch (error) {
      failure = safeErrorKind(error);
    }
    if (failure) {
      const status = failure === "missing_key" ? "blocked: add GMGN_API_KEY" :
        failure === "rate_limited" ? "blocked: GMGN rate limit" :
        failure === "auth" ? "blocked: GMGN key rejected" : "unavailable: GMGN query failed";
      return res.json({
        address,
        status,
        sampleSize: null,
        realizedPnlUsd: null,
        unrealizedPnlUsd: null,
        winRate: null,
        holdingTimeHours: null,
        losses: null,
        concentrationPct: null,
        consistency: null,
        unavailableMetrics: ["realized PnL", "holding time", "loss count", "trade concentration", "consistency"],
        updatedAt: null,
      });
    }

    const buyCount = readNumber(stats.buy_count);
    const sellCount = readNumber(stats.sell_count);
    const sampleSize = buyCount == null || sellCount == null ? null : Math.trunc(buyCount + sellCount);
    const realizedPnlUsd = readNumber(stats.realized_profit);
    const unrealizedPnlUsd = readNumber(stats.unrealized_profit);
    const winRate = readNumber(stats.winrate);
    if (sampleSize == null) unavailableMetrics.push("trade sample size");
    if (realizedPnlUsd == null) unavailableMetrics.push("realized PnL");
    if (unrealizedPnlUsd == null) unavailableMetrics.push("unrealized PnL");
    if (winRate == null) unavailableMetrics.push("win rate");

    const tokenTotals = new Map<string, number>();
    const buysByToken = new Map<string, { quantity: number; at: Date }[]>();
    const holdingHours: number[] = [];
    let losses = 0;
    let lossEvidence = 0;
    let totalBuyCost = 0;
    activities.sort((a, b) => (readTimestamp(a.timestamp)?.getTime() ?? 0) - (readTimestamp(b.timestamp)?.getTime() ?? 0));
    for (const row of activities) {
      const token = row.token && typeof row.token === "object" ? row.token as Record<string, unknown> : {};
      const tokenAddress = String(token.address ?? "");
      const side = String(row.event_type ?? row.type ?? "");
      const amount = readNumber(row.token_amount) ?? 0;
      const cost = readNumber(row.cost_usd);
      const at = readTimestamp(row.timestamp);
      if (side === "buy" && tokenAddress) {
        if (cost != null) {
          tokenTotals.set(tokenAddress, (tokenTotals.get(tokenAddress) ?? 0) + cost);
          totalBuyCost += cost;
        }
        if (at) {
          const queue = buysByToken.get(tokenAddress) ?? [];
          queue.push({ quantity: amount, at });
          buysByToken.set(tokenAddress, queue);
        }
      } else if (side === "sell" && tokenAddress && at) {
        const buyCost = readNumber(row.buy_cost_usd);
        if (cost != null && buyCost != null) {
          lossEvidence += 1;
          if (cost - buyCost < 0) losses += 1;
        }
        let left = amount;
        const queue = buysByToken.get(tokenAddress) ?? [];
        for (const lot of queue) {
          const matched = Math.min(left, lot.quantity);
          if (matched > 0) holdingHours.push((at.getTime() - lot.at.getTime()) / 3_600_000);
          lot.quantity -= matched;
          left -= matched;
          if (left <= 0) break;
        }
      }
    }
    if (!holdingHours.length) unavailableMetrics.push("holding time (no paired buy/sell sample)");
    if (!lossEvidence) unavailableMetrics.push("loss count (GMGN did not provide exit cost evidence)");
    if (!totalBuyCost) unavailableMetrics.push("token concentration (no sampled buy volume)");
    unavailableMetrics.push("consistency (not provided by the documented GMGN research fields)");
    const concentrationPct = totalBuyCost
      ? Math.max(...tokenTotals.values()) / totalBuyCost * 100
      : null;
    const data = GetWalletResearchResponse.parse({
      address,
      status: "30-day GMGN statistics; holding/loss/concentration metrics use only the latest 50 activity records. See unavailable metrics.",
      sampleSize,
      realizedPnlUsd,
      unrealizedPnlUsd,
      winRate,
      holdingTimeHours: holdingHours.length
        ? holdingHours.reduce((sum, duration) => sum + duration, 0) / holdingHours.length
        : null,
      losses: lossEvidence ? losses : null,
      concentrationPct,
      consistency: null,
      unavailableMetrics,
      updatedAt: now,
    });
    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

router.get("/signals", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const rows = await db.select().from(gmgnSignals).where(eq(gmgnSignals.userId, userId)).orderBy(desc(gmgnSignals.detectionAt)).limit(500);
    return res.json(ListSignalsResponse.parse(rows.map((row) => ({
      ...row,
      priceUsd: row.priceUsd == null ? null : num(row.priceUsd),
    }))));
  } catch (error) {
    return next(error);
  }
});

router.get("/positions", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const rows = await db.select().from(gmgnPositions).where(and(eq(gmgnPositions.userId, userId), gt(gmgnPositions.quantity, "0"))).orderBy(desc(gmgnPositions.openedAt));
    return res.json(ListPositionsResponse.parse(rows.map((p) => ({
      ...p,
      quantity: num(p.quantity),
      costBasisUsd: num(p.costBasisUsd),
      markPriceUsd: p.markPriceUsd == null ? null : num(p.markPriceUsd),
      unrealizedPnlUsd: p.markPriceUsd == null ? null : num(p.quantity) * num(p.markPriceUsd) - num(p.costBasisUsd),
    }))));
  } catch (error) {
    return next(error);
  }
});

router.get("/trades", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const rows = await db.select().from(gmgnTrades).where(eq(gmgnTrades.userId, userId)).orderBy(desc(gmgnTrades.filledAt)).limit(500);
    return res.json(ListTradesResponse.parse(rows.map((t) => ({
      ...t,
      quantity: num(t.quantity),
      priceUsd: num(t.priceUsd),
      notionalUsd: num(t.notionalUsd),
      feeUsd: num(t.feeUsd),
      slippageUsd: num(t.slippageUsd),
      realizedPnlUsd: t.realizedPnlUsd == null ? null : num(t.realizedPnlUsd),
    }))));
  } catch (error) {
    return next(error);
  }
});

router.get("/settings", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    return res.json(riskData(await getSettings(userId)));
  } catch (error) {
    return next(error);
  }
});

router.patch("/settings", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const parsed = UpdateRiskSettingsBody.safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data).length) return res.status(400).json({ error: "Risk settings are invalid or empty." });
    const current = await getSettings(userId);
    const requested = parsed.data;
    const maxBuy = requested.maxBuyUsd ?? num(current.maxBuyUsd);
    const exposure = requested.totalExposureUsd ?? num(current.totalExposureUsd);
    const cash = requested.paperCashUsd ?? num(current.paperCashUsd);
    if (requested.setupComplete === true && (cash <= 0 || maxBuy <= 0 || exposure < maxBuy)) {
      return res.status(400).json({ error: "Setup needs a positive paper cash amount and total exposure at least as large as the per-buy cap." });
    }
    const update: Record<string, unknown> = { updatedAt: new Date() };
    const decimalKeys = new Set(["maxBuyUsd", "totalExposureUsd", "minLiquidityUsd", "maxTopHolderPct", "dailyLossCutoffUsd", "feeBps", "slippageBps", "stopLossPct", "takeProfitPct", "paperCashUsd"]);
    if (requested.paperCashUsd !== undefined) {
      const [existingTrade] = await db.select({ id: gmgnTrades.id }).from(gmgnTrades).where(eq(gmgnTrades.userId, userId)).limit(1);
      if (existingTrade) return res.status(409).json({ error: "Paper cash cannot be reset after fills. A separate ledger adjustment is required." });
    }
    for (const [key, value] of Object.entries(requested)) {
      update[key] = value == null ? null : decimalKeys.has(key) ? String(value) : value;
    }
    const [saved] = await db.update(gmgnSettings).set(update).where(eq(gmgnSettings.userId, userId)).returning();
    await audit(userId, "risk_settings_updated", requested.setupComplete ? "Paper risk setup explicitly completed." : "Edited suggested paper risk settings.");
    return res.json(riskData(saved));
  } catch (error) {
    return next(error);
  }
});

router.post("/control", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const parsed = UpdateBotControlBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Unknown control action." });
    const settings = await getSettings(userId);
    const { action } = parsed.data;
    if ((action === "resume" || action === "restart") && !settings.setupComplete) {
      return res.status(409).json({ error: "Complete and explicitly confirm paper risk setup before starting the worker." });
    }
    if ((action === "resume" || action === "restart") && !process.env.GMGN_API_KEY?.trim()) {
      return res.status(409).json({ error: "GMGN_API_KEY is missing. The worker cannot query GMGN yet." });
    }
    if (action === "resume" || action === "restart") {
      const blocked = paperStartupBlock(await forwardReadiness(userId));
      if (blocked) return res.status(409).json({ error: blocked });
    }
    const update = action === "pause"
      ? { paused: true }
      : action === "resume"
        ? { paused: false, fullStopped: false }
        : action === "halt_buys"
          ? { buysHalted: true }
          : action === "resume_buys"
            ? { buysHalted: false }
            : action === "stop"
              ? { fullStopped: true, paused: true }
              : { paused: false, fullStopped: false };
    await db.update(gmgnSettings).set({ ...update, updatedAt: new Date() }).where(eq(gmgnSettings.userId, userId));
    await audit(userId, "bot_control", `Persistent control set to ${action}.`);
    return res.json(await botState(userId));
  } catch (error) {
    return next(error);
  }
});

router.get("/audit", async (req, res, next) => {
  try {
    const userId = ownerId(req, res);
    if (!userId) return;
    const rows = await db.select().from(gmgnAudit).where(eq(gmgnAudit.userId, userId)).orderBy(desc(gmgnAudit.createdAt)).limit(500);
    return res.json(ListAuditResponse.parse(rows));
  } catch (error) {
    return next(error);
  }
});

router.use(DISCOVERY_PATH, discoveryRouter);
router.use(BACKTESTING_PATH, backtestingRouter);

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const kind = safeErrorKind(error);
  if (kind === "rate_limited") return res.status(429).json({ error: "GMGN rate limit reached. Monitoring will back off." });
  if (kind === "missing_key") return res.status(503).json({ error: "GMGN_API_KEY is not configured." });
  return res.status(500).json({ error: "The private dashboard request could not be completed." });
});

export default router;
