import { desc, eq } from "drizzle-orm";
import { db, gmgnProviderEvidence, gmgnQuoteRecovery, gmgnWorkerState } from "@workspace/db";
import { QUOTE_HEARTBEAT_STALE_MS, QUOTE_MAX_ATTEMPTS } from "./quoteRecoveryPolicy";

// Called only by the authorized recovery runner/probe, never by the GET status route.
export async function initializeQuoteRecovery() {
  const [worker] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
  const [quote] = await db.select().from(gmgnProviderEvidence).where(eq(gmgnProviderEvidence.source, "quote"))
    .orderBy(desc(gmgnProviderEvidence.capturedAt)).limit(1);
  await db.insert(gmgnQuoteRecovery).values({
    id: "sol",
    lastAttemptAt: quote?.capturedAt ?? null,
    lastResult: quote ? `prior_quote_${typeof quote.metadata?.errorKind === "string" ? quote.metadata.errorKind : quote.status}` : null,
    nextAttemptAt: new Date(Math.max(Date.now(), worker?.backoffUntil?.getTime() ?? 0,
      (quote?.capturedAt.getTime() ?? 0) + 900_000)),
  }).onConflictDoNothing();
}

export async function quoteRecoveryStatus() {
  const [row] = await db.select().from(gmgnQuoteRecovery).where(eq(gmgnQuoteRecovery.id, "sol"));
  const [worker] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
  const online = !!row?.heartbeatAt && Date.now() - row.heartbeatAt.getTime() < QUOTE_HEARTBEAT_STALE_MS;
  const times = [row?.nextAttemptAt?.getTime() ?? 0, worker?.backoffUntil?.getTime() ?? 0];
  return {
    state: row?.state ?? "not_initialized", attempts: row?.attempts ?? 0, maxAttempts: QUOTE_MAX_ATTEMPTS,
    nextAttemptAt: row && !["verified", "blocked"].includes(row.state) ? new Date(Math.max(...times)) : null,
    lastAttemptAt: row?.lastAttemptAt ?? null, lastResult: row?.lastResult ?? null,
    heartbeatAt: row?.heartbeatAt ?? null, runtime: online ? "online" : "offline_or_heartbeat_stale",
    verification: row?.verification ?? {}, liveTradingEnabled: false, paperEvaluationStarted: false,
    note: "Runs only while the API is continuously running. No guaranteed retries while asleep/stopped. On resume, one eligible check; never a backlog burst. Counter covers this new shared six-attempt recovery campaign, including manual checks; earlier diagnostics are retained separately. Paper evaluation remains paused pending full evidence and explicit owner budget/risk confirmation.",
  };
}
