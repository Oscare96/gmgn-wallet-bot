import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db, pool, gmgnProviderEvidence, gmgnWorkerState, gmgnQuoteRecovery } from "@workspace/db";
import { gmgnRead, safeErrorKind, unwrapData } from "./gmgnCli";
import { isSolanaAddress, tokenTraders } from "./discoveryPolicy";
import { evidenceSummary } from "./providerEvidence";
import { EVIDENCE_LIMITATIONS, providerPayloadHash, redactProviderEvidence, summarizeProviderData } from "./providerEvidencePolicy";
import { initializeQuoteRecovery } from "./quoteRecoveryState";
import { nextQuoteAttempt, quoteRecoveryDecision, quoteFailureState } from "./quoteRecoveryPolicy";
import { verifyObservationEvidence } from "./quoteVerification";
import { acquireQuoteRecoveryLock, releaseQuoteRecoveryLock } from "./quoteRecoveryLock";

/** A real automatically discovered trader is a diagnostic quote source, not an approved execution wallet. */
export function quoteProbeInputs(sample: { payload: unknown; payloadHash: string | null; command: unknown }) {
  if (!sample.payload || typeof sample.payload !== "object" || Array.isArray(sample.payload) ||
    !sample.payloadHash || providerPayloadHash(sample.payload as Record<string, unknown>) !== sample.payloadHash) {
    throw new Error("Missing or damaged real trader evidence.");
  }
  const command = sample.command;
  if (!Array.isArray(command) || command[0] !== "token" || command[1] !== "traders" ||
    command[command.indexOf("--chain") + 1] !== "sol") {
    throw new Error("Not official token-trader evidence.");
  }
  const token = command[command.indexOf("--address") + 1];
  const wallet = tokenTraders({ data: sample.payload })[0]?.address;
  if (typeof token !== "string" || !isSolanaAddress(token) || typeof wallet !== "string" || !isSolanaAddress(wallet)) {
    throw new Error("No valid automatically discovered wallet/token for a read-only probe.");
  }
  return { wallet, token };
}

/** One allowlisted GET quote; no wallet enrollment, signing, orders, settings changes or fills. */
export async function probePaperQuote(userId: string | null) {
  const lock = await pool.connect();
  let held = false;
  try {
    held = await acquireQuoteRecoveryLock(lock);
    if (!held) return { state: "busy", reused: true, evidence: [] };
    await initializeQuoteRecovery();
    const [recovery] = await db.select().from(gmgnQuoteRecovery).where(eq(gmgnQuoteRecovery.id, "sol"));
    const [worker] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
    const decision = quoteRecoveryDecision(recovery, Date.now(), worker?.backoffUntil);
    if (decision === "interrupted") {
      await db.update(gmgnQuoteRecovery).set({ state: "waiting", lastResult: "interrupted_attempt_not_replayed",
        nextAttemptAt: nextQuoteAttempt(Date.now(), recovery.attempts, worker?.backoffUntil?.getTime()) })
        .where(eq(gmgnQuoteRecovery.id, "sol"));
      return { state: "recovery_interrupted_delayed", reused: true, evidence: [] };
    }
    if (decision === "exhausted") {
      await db.update(gmgnQuoteRecovery).set({ state: "blocked", lastResult: "attempt_limit_reached", nextAttemptAt: null })
        .where(eq(gmgnQuoteRecovery.id, "sol"));
    }
    if (decision !== "eligible") return { state: `recovery_${decision}`, reused: true, evidence: [] };
    if (worker?.backoffUntil && worker.backoffUntil > new Date()) {
      return { state: "blocked_shared_backoff", reused: true, evidence: [] };
    }
    const scope = userId ? or(eq(gmgnProviderEvidence.userId, userId), isNull(gmgnProviderEvidence.userId)) : isNull(gmgnProviderEvidence.userId);
    const [recent] = await db.select().from(gmgnProviderEvidence).where(eq(gmgnProviderEvidence.source, "quote"))
      .orderBy(desc(gmgnProviderEvidence.capturedAt)).limit(1);
    if (recent && recent.capturedAt.getTime() > Date.now() - 900_000) {
      await db.update(gmgnQuoteRecovery).set({ nextAttemptAt: new Date(recent.capturedAt.getTime() + 900_000) })
        .where(eq(gmgnQuoteRecovery.id, "sol"));
      return { state: "quote_probe_cooldown", reused: true, evidence: [evidenceSummary(recent)] };
    }
    const [sample] = await db.select().from(gmgnProviderEvidence).where(and(scope, eq(gmgnProviderEvidence.source, "traders"), eq(gmgnProviderEvidence.status, "verified_sample")))
      .orderBy(desc(gmgnProviderEvidence.capturedAt)).limit(1);
    const block = async (reason: string) => {
      await db.update(gmgnQuoteRecovery).set({ state: "blocked", lastResult: reason, nextAttemptAt: null })
        .where(eq(gmgnQuoteRecovery.id, "sol"));
      return { state: reason, reused: true, evidence: [] };
    };
    if (!sample) return block("blocked_missing_real_trader_evidence");
    if (!process.env.GMGN_API_KEY?.trim()) return block("blocked_missing_key");
    let inputs;
    try { inputs = quoteProbeInputs(sample); }
    catch { return block("blocked_invalid_trader_evidence"); }
    const command = ["order", "quote", "--chain", "sol", "--from", inputs.wallet,
      "--input-token", "So11111111111111111111111111111111111111112", "--output-token", inputs.token,
      "--amount", "1000000", "--slippage", "1", "--raw"];
    const began = new Date();
    const attempts = recovery.attempts + 1;
    const claimId = randomUUID();
    // Persist the claim BEFORE touching the provider. Crash ambiguity is never immediately replayed.
    await db.update(gmgnQuoteRecovery).set({ state: "running", attempts, claimId, lastAttemptAt: began,
      heartbeatAt: began, lastResult: "quote_in_flight", nextAttemptAt: nextQuoteAttempt(began.getTime(), attempts) })
      .where(eq(gmgnQuoteRecovery.id, "sol"));
    let payload: Record<string, unknown> | null = null;
    let status = "blocked", errorKind: string | null = null, recordCount = 0, fields: string[] = [];
    try {
      const raw = await gmgnRead(command, claimId);
      payload = redactProviderEvidence(unwrapData(raw)) as Record<string, unknown>;
      if (JSON.stringify(payload).length > 150_000) { payload = null; throw new Error("Oversized quote sample."); }
      const summary = summarizeProviderData("quote", raw);
      recordCount = summary.recordCount;
      fields = summary.fields;
      status = "verified_sample";
    } catch (error) {
      errorKind = payload ? "schema_unverified" : safeErrorKind(error);
      status = payload ? "schema_unverified" : "blocked";
    }
    const received = new Date();
    const [row] = await db.insert(gmgnProviderEvidence).values({
      userId, collectionId: randomUUID(), source: "quote", status, capturedAt: received,
      recordCount, latencyMs: received.getTime() - began.getTime(), command, payload,
      payloadHash: payload ? providerPayloadHash(payload) : null,
      metadata: { errorKind, fields, cliVersion: "1.6.6", requestedAt: began.toISOString(),
        recoveryAttempt: attempts, recoveryCampaign: "sol", automaticOrManualShared: true,
        sourceResponseObservedAt: received.toISOString(), sourceEvidenceId: sample.id,
        discoverySource: "real_current_trending_token_traders_not_official_wallet_ranking",
        sampleOnly: true, inputLamports: "1000000", simulatedFill: false, signingCredentialUsed: false,
        quoteFrom: "sampled_public_trader_not_user_execution_wallet",
        upstreamFreshnessVerified: false, usdConversionVerified: false, eventIdentityVerified: false,
        paperReady: false, monitoringChanged: false, liveTradingEnabled: false },
      limitation: EVIDENCE_LIMITATIONS.quote,
    }).returning();
    const [afterWorker] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
    const succeeded = status === "verified_sample";
    const verification = succeeded ? await verifyObservationEvidence(inputs, row.id) : {};
    const state = succeeded ? "verified" : quoteFailureState(errorKind, attempts);
    await db.update(gmgnQuoteRecovery).set({
      state, lastResult: succeeded ? "quote_read_verified_paper_still_blocked" : errorKind ?? status,
      verification, nextAttemptAt: state === "waiting"
        ? nextQuoteAttempt(received.getTime(), attempts, afterWorker?.backoffUntil?.getTime()) : null,
      heartbeatAt: new Date(),
    }).where(eq(gmgnQuoteRecovery.id, "sol"));
    return { state: status === "verified_sample" ? "quote_read_verified_paper_still_blocked" : status, reused: false, evidence: [evidenceSummary(row)] };
  } finally {
    if (held) await releaseQuoteRecoveryLock(lock).catch(() => undefined);
    lock.release();
  }
}
