import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db, pool, gmgnProviderEvidence, gmgnSettings, gmgnDiscoverySettings, gmgnWorkerState, type GmgnProviderEvidence } from "@workspace/db";
import { gmgnRead, safeErrorKind, unwrapData } from "./gmgnCli";
import { isSolanaAddress } from "./discoveryPolicy";
import { EVIDENCE_LIMITATIONS, historicalPriceProbeWindows, OFFICIAL_HISTORY_TOKEN, providerPayloadHash, redactProviderEvidence, summarizeProviderData } from "./providerEvidencePolicy";

const scope = (userId: string) => or(eq(gmgnProviderEvidence.userId, userId), isNull(gmgnProviderEvidence.userId));
export async function evidenceRows(userId: string) {
  return db.select().from(gmgnProviderEvidence).where(scope(userId)).orderBy(desc(gmgnProviderEvidence.capturedAt)).limit(60);
}
export function evidenceSummary(row: GmgnProviderEvidence) {
  return {
    id: row.id, collectionId: row.collectionId, source: row.source, status: row.status,
    capturedAt: row.capturedAt, recordCount: row.recordCount, returnedFrom: row.returnedFrom, returnedTo: row.returnedTo,
    latencyMs: row.latencyMs, payloadHash: row.payloadHash, metadata: row.metadata, limitation: row.limitation,
    historicalStrategyReady: false, paperFillReady: false,
    scope: row.userId === null ? "Authenticated workspace diagnostics of public data" : "Private owner coverage inspection",
  };
}
export async function evidenceDetail(userId: string, id: string) {
  const [row] = await db.select().from(gmgnProviderEvidence).where(and(eq(gmgnProviderEvidence.id, id), scope(userId)));
  if (!row) return null;
  // Only captured data with an intact checksum can be exported as provider evidence.
  if (row.payload && providerPayloadHash(row.payload) !== row.payloadHash) throw new Error("Provider evidence integrity failure.");
  return { evidence: evidenceSummary(row), command: row.command, payload: row.payload,
    provenance: "Captured directly from the pinned official GMGN read client. Retrospective receipt time is not historical information availability.",
    resultsKind: "provider_coverage_evidence_not_strategy_performance", liveTradingEnabled: false };
}

/** Bounded real-data importer/inspection. It never writes watchlists, settings or trade ledgers. */
export async function inspectProviderHistory(userId: string | null) {
  const lock = await pool.connect();
  const collectionId = randomUUID();
  let held = false;
  try {
    const result = await lock.query<{ held: boolean }>("SELECT pg_try_advisory_lock(91200345) AS held");
    held = result.rows[0]?.held ?? false;
    if (!held) return { state: "busy", reused: false, evidence: [] };
    const [recent] = await db.select().from(gmgnProviderEvidence).where(eq(gmgnProviderEvidence.source, "whole_strategy"))
      .orderBy(desc(gmgnProviderEvidence.capturedAt)).limit(1);
    if (recent && recent.capturedAt.getTime() > Date.now() - 900_000) {
      // Reuse only global/operator or this owner's evidence, never another owner's private payload.
      const visible = userId ? await evidenceRows(userId) : await db.select().from(gmgnProviderEvidence).where(isNull(gmgnProviderEvidence.userId));
      return { state: "blocked", reused: true, evidence: visible.map(evidenceSummary) };
    }
    const captured: GmgnProviderEvidence[] = [];
    let stopReads = false, requests = 0;
    const capture = async (source: string, command: string[], metadata: Record<string, unknown> = {}, from?: Date, to?: Date) => {
      const began = Date.now();
      let payload: Record<string, unknown> | null = null;
      let status = "blocked", summary: ReturnType<typeof summarizeProviderData> | null = null, errorKind: string | null = null;
      if (!stopReads) {
        try {
          requests++;
          const value = await gmgnRead(command);
          payload = redactProviderEvidence(unwrapData(value)) as Record<string, unknown>;
          if (JSON.stringify(payload).length > 150_000) { payload = null; throw new Error("Oversized provider sample."); }
          summary = summarizeProviderData(source, value, from, to);
          status = summary.recordCount ? "verified_sample" : "empty";
        } catch (error) {
          errorKind = payload ? "schema_unverified" : safeErrorKind(error);
          status = payload ? "schema_unverified" : "blocked";
          // Do not hammer a denied, limited or failed service. No retries during shared backoff.
          if (!payload) stopReads = true;
        }
      } else errorKind = "previous_read_blocked";
      const received = new Date();
      const [row] = await db.insert(gmgnProviderEvidence).values({
        userId, collectionId, source, status, capturedAt: received, latencyMs: Date.now() - began,
        command, payload, payloadHash: payload ? providerPayloadHash(payload) : null,
        recordCount: summary?.recordCount ?? 0, returnedFrom: summary?.returnedFrom ?? null, returnedTo: summary?.returnedTo ?? null,
        metadata: { ...metadata, queriedFrom: from?.toISOString() ?? null, queriedTo: to?.toISOString() ?? null,
          fields: summary?.fields ?? Object.keys(payload ?? {}), missingCandles: summary?.missingCandles ?? null,
          timestampUnits: summary?.timestampUnits ?? null, cursorPresent: Boolean(summary?.cursor),
          paginationComplete: false, historicalInformationAvailableAt: null, errorKind, cliVersion: "1.6.6",
          planRetentionVerified: false, sourceResponseObservedAt: received.toISOString(),
          sourceDocs: "https://github.com/GMGNAI/gmgn-skills/blob/main/docs/cli-usage.md" },
        limitation: EVIDENCE_LIMITATIONS[source],
      }).returning();
      captured.push(row);
      if (!stopReads) await new Promise((resolve) => setTimeout(resolve, 1100));
      return summary;
    };
    const trending = await capture("trending", ["market", "trending", "--chain", "sol", "--interval", "24h", "--limit", "1", "--raw"]);
    const token = typeof trending?.rows[0]?.address === "string" ? trending.rows[0].address : null;
    let wallet: string | null = null;
    if (token && isSolanaAddress(token)) {
      const traders = await capture("traders", ["token", "traders", "--chain", "sol", "--address", token, "--limit", "3", "--raw"], { selection: "current_token_traders_sample_only" });
      wallet = typeof traders?.rows[0]?.address === "string" ? traders.rows[0].address : null;
      if (wallet && isSolanaAddress(wallet)) {
        const first = await capture("activity", ["portfolio", "activity", "--chain", "sol", "--wallet", wallet, "--limit", "10", "--raw"], { page: 1, sampleOnly: true });
        if (first?.cursor && first.cursor.length <= 2048) {
          const second = await capture("activity", ["portfolio", "activity", "--chain", "sol", "--wallet", wallet, "--limit", "10", "--cursor", first.cursor, "--raw"], { page: 2, sampleOnly: true });
          if (second?.cursor === first.cursor) {
            await db.update(gmgnProviderEvidence).set({ status: "schema_unverified", limitation: `${EVIDENCE_LIMITATIONS.activity} Cyclic cursor detected; import stopped.` }).where(eq(gmgnProviderEvidence.id, captured.at(-1)!.id));
          }
        }
      }
    }
    for (const window of historicalPriceProbeWindows(new Date())) {
      await capture("candles", ["market", "kline", "--chain", "sol", "--address", OFFICIAL_HISTORY_TOKEN,
        "--resolution", "1m", "--from", String(window.from.getTime() / 1000), "--to", String(window.to.getTime() / 1000 - 1), "--raw"],
      { selection: "official_documentation_example_token_not_historical_strategy_selection", resolution: "1m", expectedCandles: 60 }, window.from, window.to);
    }
    if (token && isSolanaAddress(token)) {
      for (const [source, subcommand] of [["security", "security"], ["pool", "pool"], ["info", "info"]]) {
        await capture(source, ["token", subcommand, "--chain", "sol", "--address", token, "--raw"]);
      }
      // Quotes belong exclusively to the durable shared recovery campaign. A coverage
      // inspection must not create a second path around its lock, cooldown or retry cap.
    }
    const [blocked] = await db.insert(gmgnProviderEvidence).values({
      userId, collectionId, source: "whole_strategy", status: "blocked", recordCount: 0, latencyMs: 0, command: [],
      metadata: { requestsAttempted: requests, historicalStrategyStarted: false, monitoringChanged: false,
        syntheticDataUsed: false, completedAt: new Date().toISOString(), liveTradingEnabled: false,
        missing: ["historical_as_of_discovery_universe", "losing_inactive_failed_population_coverage",
          "complete_canonical_signals_and_initial_inventory", "historical_security_liquidity_execution_and_terminal_valuation",
          "chronological_periods_and_frozen_rules", "validated_whole_strategy_replay_adapter"] },
      limitation: EVIDENCE_LIMITATIONS.whole_strategy,
    }).returning();
    captured.push(blocked);
    return { state: "blocked", reused: false, evidence: captured.map(evidenceSummary) };
  } finally {
    if (held) await lock.query("SELECT pg_advisory_unlock(91200345)");
    lock.release();
  }
}

export async function forwardReadiness(userId: string) {
  const rows = await evidenceRows(userId);
  const successes = rows.filter((r) => r.status === "verified_sample" && r.source !== "whole_strategy");
  const [settings] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, userId));
  const [discovery] = await db.select().from(gmgnDiscoverySettings).where(eq(gmgnDiscoverySettings.userId, userId));
  const [worker] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
  const backoff = worker?.backoffUntil && worker.backoffUntil > new Date() ? worker.backoffUntil : null;
  const rules = discovery?.rules as { selectionPaused?: boolean; enabled?: boolean } | undefined;
  return {
    lastVerifiedReadAt: successes[0]?.capturedAt ?? null, lastInspectionAt: rows.find((r) => r.source === "whole_strategy")?.capturedAt ?? null,
    tracking: successes.some((r) => r.source === "activity") ? "sample_verified_setup_required" : "unverified",
    paper: "blocked", monitoringPaused: !settings || settings.paused || settings.fullStopped,
    automaticSelectionPaused: !rules?.enabled || rules.selectionPaused !== false, liveTradingEnabled: false,
    reason: "No automatic fills or qualification. Historical point-in-time coverage is missing; forward fills also require unambiguous events, post-detection upstream-fresh quotes, fee/decimal/USD evidence and atomic persistent accounting. Collection remains paused.",
    planVerified: false,
    apiKeyConfigured: Boolean(process.env.GMGN_API_KEY?.trim()),
    readBackoffUntil: backoff, readBlockReason: backoff ? worker.lastError : null,
  };
}
