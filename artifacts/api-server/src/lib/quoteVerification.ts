import { and, desc, eq, isNull } from "drizzle-orm";
import { db, gmgnProviderEvidence } from "@workspace/db";
import { providerPayloadHash } from "./providerEvidencePolicy";

/** Read-only continuation on genuine saved evidence. This NEVER replays trades or claims fills. */
export async function verifyObservationEvidence(inputs: { wallet: string; token: string }, quoteEvidenceId: string) {
  const rows = await db.select().from(gmgnProviderEvidence)
    .where(and(isNull(gmgnProviderEvidence.userId), eq(gmgnProviderEvidence.status, "verified_sample")))
    .orderBy(desc(gmgnProviderEvidence.capturedAt)).limit(60);
  const activity = rows.find(r => r.source === "activity" && r.command.includes(inputs.wallet) &&
    r.payload && providerPayloadHash(r.payload) === r.payloadHash);
  return {
    checkedAt: new Date().toISOString(), quoteEvidenceId,
    automaticallyDiscoveredWalletSource: "real_token_trader_evidence_not_official_wallet_ranking",
    activityEvidenceIntegrity: activity ? "verified_saved_sample" : "unavailable",
    activityCaptureAt: activity?.capturedAt.toISOString() ?? null,
    baseline: "sample_only_not_enrolled_no_historical_events_copied",
    upstreamQuoteFreshness: "unverified_receipt_time_is_not_upstream_price_age",
    canonicalEventIdentity: "unverified_conservative_hash_is_not_canonical_event_index",
    leaderStartingInventory: "unverified_incomplete_history_cannot_establish_pre_sell_inventory",
    paperAccountingIntegration: "blocked_staged_ledger_not_connected_to_verified_event_quote_adapter",
    feeDecimalUsdEvidence: "unverified",
    explicitOwnerBudgetRiskApproval: "must_be_checked_per_authenticated_owner_no_proposal_auto_approval",
    readiness: "blocked", evaluationStarted: false, liveTradingEnabled: false,
  };
}
