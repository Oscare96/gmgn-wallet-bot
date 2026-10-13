import { Router } from "express";
import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import { db, gmgnAudit, gmgnBacktestRuns } from "@workspace/db";
import { RequestBacktestBody, InspectProviderHistoryBody, GetProviderEvidenceResponse, InspectProviderHistoryResponse, GetProviderEvidenceDetailResponse } from "@workspace/api-zod";
import { evidenceDetail, evidenceRows, evidenceSummary, forwardReadiness, inspectProviderHistory } from "../lib/providerEvidence";
import { assessHistoricalCoverage, backtestReport, backtestingState, snapshotBacktestRules } from "../lib/backtestAssessment";
import { BACKTEST_ASSUMPTIONS, EMPTY_BACKTEST_PERFORMANCE, freezeHistoricalRules, validateHistoricalPeriods } from "../lib/backtestPolicy";
import { ProbePaperQuoteBody, ProbePaperQuoteResponse, GetQuoteRecoveryResponse } from "@workspace/api-zod";
import { probePaperQuote } from "../lib/paperQuoteProbe";
import { quoteRecoveryStatus } from "../lib/quoteRecoveryState";

export const BACKTESTING_PATH = "/backtesting";
const router = Router();
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (!getAuth(req).userId) { res.status(401).json({ error: "Sign in to access private backtesting." }); return; }
  next();
});
router.get("/", async (req, res, next) => {
  try { return res.json(await backtestingState(getAuth(req).userId!)); }
  catch (error) { return next(error); }
});
router.post("/", async (req, res, next) => {
  let runId: string | undefined;
  try {
    const userId = getAuth(req).userId!;
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "Provide a request object." });
    let periods: ReturnType<typeof validateHistoricalPeriods>;
    try { periods = validateHistoricalPeriods(req.body); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }
    const parsed = RequestBacktestBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Use valid dates and a boolean rule-freeze confirmation." });
    const snapshot = freezeHistoricalRules(await snapshotBacktestRules(userId));
    const freeze = periods.complete && parsed.data.freezeRules === true;
    if (freeze && parsed.data.expectedRulesHash !== snapshot.hash) return res.status(409).json({ error: "Stale rules preview or rules not reviewed. Refresh the displayed strategy snapshot and confirm its current hash before freezing." });
    const request = { ...periods.dates, freezeRules: freeze, ...(freeze ? { expectedRulesHash: snapshot.hash } : {}) };
    const initial = await assessHistoricalCoverage(userId, false, periods.complete, freeze);
    const [row] = await db.insert(gmgnBacktestRuns).values({ userId, status: "assessing",
      request, rulesFrozenAt: freeze ? new Date() : null, rulesHash: freeze ? snapshot.hash : null,
      frozenRules: freeze ? snapshot.rules : {}, assessment: initial, performance: EMPTY_BACKTEST_PERFORMANCE, assumptions: BACKTEST_ASSUMPTIONS }).returning();
    runId = row.id;
    // Permission probe is a supported read, not a historical simulator.
    const assessment = await assessHistoricalCoverage(userId, true, periods.complete, freeze);
    const [blocked] = await db.transaction(async (tx) => {
      const updated = await tx.update(gmgnBacktestRuns).set({ status: "blocked", assessedAt: assessment.checkedAt, assessment })
        .where(and(eq(gmgnBacktestRuns.id, row.id), eq(gmgnBacktestRuns.userId, userId))).returning();
      await tx.insert(gmgnAudit).values({ userId, action: "historical_backtest_blocked", detail: `Whole-strategy historical request ${row.id} assessed; no simulation started. Missing historical point-in-time universe/market states and validated replay. Live remains disabled.` });
      return updated;
    });
    return res.json(backtestReport(blocked));
  } catch (error) {
    if (runId) {
      try {
        await db.update(gmgnBacktestRuns).set({ status: "failed", assessedAt: new Date() })
          .where(and(eq(gmgnBacktestRuns.id, runId), eq(gmgnBacktestRuns.userId, getAuth(req).userId!)));
      } catch { /* A database outage cannot be represented as a successfully persisted state. */ }
    }
    return next(error);
  }
});
router.get("/evidence", async (req, res, next) => {
  try {
    const userId = getAuth(req).userId!;
    return res.json(GetProviderEvidenceResponse.parse({ evidence: (await evidenceRows(userId)).map(evidenceSummary), readiness: await forwardReadiness(userId) }));
  } catch (error) { return next(error); }
});
router.get("/quote-recovery", async (req, res, next) => {
  try { return res.json(GetQuoteRecoveryResponse.parse(await quoteRecoveryStatus())); }
  catch (error) { return next(error); }
});
router.post("/evidence", async (req, res, next) => {
  try {
    const parsed = InspectProviderHistoryBody.safeParse(req.body);
    if (!parsed.success || parsed.data.confirmReadOnly !== true) return res.status(400).json({ error: "Confirm a read-only coverage inspection. No backtest, selection, fills or real orders will run." });
    return res.json(InspectProviderHistoryResponse.parse(await inspectProviderHistory(getAuth(req).userId!)));
  } catch (error) { return next(error); }
});
router.post("/evidence/quote-probe", async (req, res, next) => {
  try {
    const parsed = ProbePaperQuoteBody.safeParse(req.body);
    if (!parsed.success || parsed.data.confirmReadOnly !== true) return res.status(400).json({ error: "Confirm a read-only quote probe. No orders or paper evaluation will start." });
    return res.json(ProbePaperQuoteResponse.parse(await probePaperQuote(getAuth(req).userId!)));
  } catch (error) { return next(error); }
});
router.get("/evidence/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return res.status(404).json({ error: "Evidence not found." });
    const detail = await evidenceDetail(getAuth(req).userId!, id);
    if (!detail) return res.status(404).json({ error: "Evidence not found." });
    return res.json(GetProviderEvidenceDetailResponse.parse(detail));
  } catch (error) { return next(error); }
});
router.get("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return res.status(404).json({ error: "Backtest request not found." });
    const [row] = await db.select().from(gmgnBacktestRuns).where(and(eq(gmgnBacktestRuns.id, id), eq(gmgnBacktestRuns.userId, getAuth(req).userId!)));
    if (!row) return res.status(404).json({ error: "Backtest request not found." });
    res.setHeader("Cache-Control", "private, no-store");
    return res.json(backtestReport(row));
  } catch (error) { return next(error); }
});
export default router;
