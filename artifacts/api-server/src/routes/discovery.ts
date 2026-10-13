import { Router } from "express";
import { getAuth } from "@clerk/express";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, gmgnAudit, gmgnDiscoveryCandidates, gmgnDiscoverySettings, gmgnPositions, gmgnSettings, gmgnWallets } from "@workspace/db";
import { UpdateDiscoveryCandidateBody, UpdateDiscoveryRulesBody } from "@workspace/api-zod";
import { discoveryConfig, discoveryState } from "../lib/discoveryService";
import { isSolanaAddress } from "../lib/discoveryPolicy";

const router = Router();
export const DISCOVERY_PATH = "/discovery";
router.use((req, res, next) => {
  if (!getAuth(req).userId) { res.status(401).json({ error: "Sign in to access discovery." }); return; }
  next();
});
router.get("/", async (req, res, next) => {
  try { return res.json(await discoveryState(getAuth(req).userId!)); }
  catch (error) { return next(error); }
});
router.patch("/settings", async (req, res, next) => {
  try {
    const userId = getAuth(req).userId!, parsed = UpdateDiscoveryRulesBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter complete discovery rules within the displayed bounds." });
    const rules = parsed.data;
    if (rules.enabled && !rules.planConfirmed) return res.status(400).json({ error: "Confirm your actual API plan read permissions and local request budget before enabling discovery." });
    const watched = await db.select().from(gmgnWallets).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.enabled, true)));
    if (watched.length > rules.maxMonitoredWallets) return res.status(400).json({ error: "Disable excess watched wallets before lowering the monitored count cap." });
    const [risk] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId));
    if (!rules.selectionPaused && (!risk?.setupComplete || rules.autoBuyBudgetUsd <= 0 || rules.autoBuyBudgetUsd > Number(risk.maxBuyUsd))) {
      return res.status(400).json({ error: "Before unpausing automatic selection, explicitly complete paper risk setup and choose a positive auto-buy budget within its per-buy cap. Quote verification is still required." });
    }
    await discoveryConfig(userId);
    const saved = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(91200344)`);
      const currentWatched = await tx.select().from(gmgnWallets).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.enabled, true)));
      if (currentWatched.length > rules.maxMonitoredWallets) return false;
      await tx.update(gmgnDiscoverySettings).set({ rules, updatedAt: new Date() }).where(eq(gmgnDiscoverySettings.userId, userId));
      await tx.insert(gmgnAudit).values({ userId, action: "discovery_rules_reviewed", detail: `Discovery ${rules.enabled ? "enabled" : "paused"}; automatic selection ${rules.selectionPaused ? "paused" : "requested"}; local shared request allowance ${rules.maxRequestsPerHour}/rolling hour; monitored cap ${rules.maxMonitoredWallets}. Live remains disabled; forward verification is required.` });
      return true;
    });
    if (!saved) return res.status(409).json({ error: "Watched-wallet count changed. Disable excess wallets before lowering the cap." });
    return res.json(await discoveryState(userId));
  } catch (error) { return next(error); }
});
router.post("/refresh", async (req, res, next) => {
  try {
    const userId = getAuth(req).userId!, config = await discoveryConfig(userId);
    const [control] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId));
    if (!process.env.GMGN_API_KEY?.trim()) return res.status(409).json({ error: "Discovery blocked: add GMGN_API_KEY through server-side Secrets. No signing key is required." });
    if (!config.rules.enabled || !config.rules.planConfirmed || control?.fullStopped) return res.status(409).json({ error: "Enable reviewed discovery rules with confirmed API limits and clear full STOP before requesting refresh." });
    await db.update(gmgnDiscoverySettings).set({ refreshRequested: true }).where(eq(gmgnDiscoverySettings.userId, userId));
    await db.insert(gmgnAudit).values({ userId, action: "discovery_refresh_queued", detail: "Refresh queued for the background worker, subject to shared backoff and budget. Prior ranking snapshots will not be rewritten." });
    return res.json(await discoveryState(userId));
  } catch (error) { return next(error); }
});
router.patch("/candidates/:address", async (req, res, next) => {
  try {
    const userId = getAuth(req).userId!, address = String(req.params.address), parsed = UpdateDiscoveryCandidateBody.safeParse(req.body);
    if (!isSolanaAddress(address) || !parsed.success || (parsed.data.pinned === undefined && parsed.data.excluded === undefined)) return res.status(400).json({ error: "Choose a valid discovered wallet and pin/exclude action." });
    const [candidate] = await db.select().from(gmgnDiscoveryCandidates).where(and(eq(gmgnDiscoveryCandidates.userId, userId), eq(gmgnDiscoveryCandidates.address, address)));
    if (!candidate) return res.status(404).json({ error: "This wallet is not in your real discovered candidate set." });
    const reset = candidate.state === "excluded" && parsed.data.excluded === false;
    await db.transaction(async (tx) => {
      await tx.update(gmgnDiscoveryCandidates).set({
        ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
        ...(parsed.data.excluded !== undefined ? { manualExcluded: parsed.data.excluded } : {}),
        ...(parsed.data.excluded ? { state: "excluded", monitored: false, qualifiedAt: null, reasons: ["Manually excluded. New copy entries and automatic selection are blocked."] } : {}),
        ...(reset ? { state: "candidate", monitored: false, evaluationId: randomUUID(), evaluationStartedAt: null, observationStartedAt: null, lastObservedAt: null, baselineComplete: false, baselineCursor: null, pollCursor: null, baselineCursorHistory: [], pollCursorHistory: [], evaluationRules: null, metrics: {}, score: null, reasons: ["Restored with a new forward evaluation cohort. Previous fills/history cannot qualify this trial."] } : {}),
      }).where(and(eq(gmgnDiscoveryCandidates.userId, userId), eq(gmgnDiscoveryCandidates.address, address)));
      if (parsed.data.excluded) {
        const positions = await tx.select().from(gmgnPositions).where(and(eq(gmgnPositions.userId, userId), eq(gmgnPositions.leaderAddress, address), sql`${gmgnPositions.quantity} > 0`));
        // Preserve exit monitoring for existing positions; never alter manual holdings.
        if (!positions.length) await tx.update(gmgnWallets).set({ enabled: false }).where(and(eq(gmgnWallets.userId, userId), eq(gmgnWallets.address, address), eq(gmgnWallets.automatic, true)));
      }
      await tx.insert(gmgnAudit).values({ userId, action: "candidate_selection_changed", detail: `${address}: ${parsed.data.excluded ? "excluded" : reset ? "new forward cohort" : parsed.data.pinned ? "pinned for observation only" : "selection changed"}. Pinning never overrides qualification or approved risk rules.` });
    });
    return res.json(await discoveryState(userId));
  } catch (error) { return next(error); }
});
export default router;
