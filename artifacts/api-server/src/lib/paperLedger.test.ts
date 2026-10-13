import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, gmgnSettings, gmgnWallets, gmgnSignals, gmgnPositions, gmgnTrades, gmgnEquityPoints } from "@workspace/db";
import { commitPaperFill, paperUnits, paperDecimal, type PaperCommit, type ValidatedPaperObservation } from "./paperLedger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const now = new Date("2026-10-11T12:00:03Z");
const fixtureQuote = (): ValidatedPaperObservation => ({
  priceUsd: "2", upstreamAt: new Date("2026-10-11T12:00:02Z"), receivedAt: new Date("2026-10-11T12:00:02.100Z"),
  quoteVerified: true, canonicalEventVerified: true, securityVerified: true,
  liquidityUsd: "100000", topHolderPct: "5", payloadHash: "a".repeat(64),
});
async function fixture(body: (tx: Tx, owner: string) => Promise<void>) {
  const owner = `isolated-offline-paper-${randomUUID()}`, rollback = new Error("ROLLBACK_SYNTHETIC_PAPER_FIXTURE");
  await assert.rejects(db.transaction(async tx => {
    await tx.insert(gmgnSettings).values({
      userId: owner, paused: false, setupComplete: true, maxBuyUsd: "10", totalExposureUsd: "50",
      minLiquidityUsd: "1000", maxTopHolderPct: "20", paperCashUsd: "100",
      feeBps: "100", slippageBps: "100", latencyMs: 1500, followSells: true,
    });
    await tx.insert(gmgnWallets).values(["OFFLINE_LEADER", "OFFLINE_OTHER_LEADER"].map(address => ({
      userId: owner, address, label: "ISOLATED SYNTHETIC TEST — NEVER USER DATA",
      enabled: true, baselineComplete: true, buyBudgetUsd: "10",
    })));
    await body(tx, owner);
    throw rollback;
  }), error => error === rollback);
  for (const table of [gmgnSettings, gmgnWallets, gmgnSignals, gmgnPositions, gmgnTrades, gmgnEquityPoints]) {
    assert.equal((await db.select().from(table).where(eq(table.userId, owner))).length, 0);
  }
}
async function input(tx: Tx, owner: string, side = "buy", leader = "OFFLINE_LEADER"): Promise<PaperCommit> {
  const [signal] = await tx.insert(gmgnSignals).values({
    userId: owner, eventIdentity: `ISOLATED_SYNTHETIC:${randomUUID()}`, walletAddress: leader,
    walletLabel: "ISOLATED SYNTHETIC TEST", tokenAddress: "OFFLINE_TOKEN", side,
    observedAt: new Date("2026-10-11T12:00:00Z"), detectionAt: new Date("2026-10-11T12:00:00Z"),
    status: "pending", reason: "Synthetic fixture rolled back; not provider evidence.",
    rawProvenance: { isolatedSyntheticFixture: true },
  }).returning();
  return { userId: owner, signalId: signal.id, mode: "paper", quote: fixtureQuote() };
}
test("exact ledger decimals preserve whole trailing zeros and reject excess precision", () => {
  assert.equal(paperDecimal(paperUnits("100")), "100");
  assert.equal(paperDecimal(paperUnits("0.000000000001")), "0.000000000001");
  assert.equal(paperDecimal(paperUnits("-10.01")), "-10.01");
  assert.throws(() => paperUnits("1e2")); assert.throws(() => paperUnits("0.0000000000001"));
});
test("atomic paper buy persists cash/cost/fees/quantity/provenance/equity, and rejects restart replay", async () => {
  await fixture(async (tx, owner) => {
    const request = await input(tx, owner);
    assert.equal((await commitPaperFill(request, now, tx)).status, "filled");
    const [settings] = await tx.select().from(gmgnSettings).where(eq(gmgnSettings.userId, owner));
    const [position] = await tx.select().from(gmgnPositions).where(eq(gmgnPositions.userId, owner));
    const [trade] = await tx.select().from(gmgnTrades).where(eq(gmgnTrades.userId, owner));
    assert.equal(paperUnits(settings.paperCashUsd) + paperUnits(position.costBasisUsd), paperUnits("100"));
    assert.equal(trade.simulated, true); assert.equal(paperUnits(trade.feeUsd), paperUnits("0.1"));
    assert.equal(paperUnits(trade.priceUsd), paperUnits("2.02"));
    assert.equal(paperUnits(trade.quantity, 18), paperUnits(position.quantity, 18));
    const [signal] = await tx.select().from(gmgnSignals).where(eq(gmgnSignals.id, request.signalId));
    assert.equal(signal.status, "filled"); assert.equal((signal.rawProvenance as { isolatedSyntheticFixture: boolean }).isolatedSyntheticFixture, true);
    assert.equal((await tx.select().from(gmgnEquityPoints).where(eq(gmgnEquityPoints.userId, owner))).length, 1);
    // A new invocation has no retained worker memory; persistent identity controls replay.
    assert.equal((await commitPaperFill({ ...request, quote: null }, now, tx)).status, "duplicate");
    assert.equal((await tx.select().from(gmgnTrades).where(eq(gmgnTrades.userId, owner))).length, 1);
    assert.equal((await commitPaperFill(await input(tx, owner, "buy", "OFFLINE_OTHER_LEADER"), now, tx)).status, "blocked");
    assert.equal((await tx.select().from(gmgnPositions).where(eq(gmgnPositions.userId, owner))).length, 1);
  });
});
test("leader partial sells allocate only matching cost, preserve halt-buys exits, and cannot oversell", async () => {
  await fixture(async (tx, owner) => {
    await commitPaperFill(await input(tx, owner), now, tx);
    const [before] = await tx.select().from(gmgnPositions).where(eq(gmgnPositions.userId, owner));
    const wrongLeader = { ...await input(tx, owner, "sell", "OFFLINE_OTHER_LEADER"),
      leaderSold: "5", leaderPreSellInventory: "10", leaderInventoryVerified: true };
    assert.equal((await commitPaperFill(wrongLeader, now, tx)).status, "blocked");
    await tx.update(gmgnSettings).set({ buysHalted: true }).where(eq(gmgnSettings.userId, owner));
    const sell = { ...await input(tx, owner, "sell"), leaderSold: "5", leaderPreSellInventory: "10", leaderInventoryVerified: true };
    assert.equal((await commitPaperFill(sell, now, tx)).status, "filled");
    const [afterPosition] = await tx.select().from(gmgnPositions).where(eq(gmgnPositions.userId, owner));
    assert.equal(paperUnits(afterPosition.quantity, 18), paperUnits(before.quantity, 18) - paperUnits(before.quantity, 18) / 2n);
    const trades = await tx.select().from(gmgnTrades).where(eq(gmgnTrades.userId, owner));
    const exit = trades.find(t => t.side === "sell")!;
    const costAllocated = paperUnits(before.costBasisUsd) - paperUnits(afterPosition.costBasisUsd);
    assert.equal(paperUnits(exit.realizedPnlUsd!), paperUnits(exit.notionalUsd) - paperUnits(exit.feeUsd) - costAllocated);
    const impossible = { ...await input(tx, owner, "sell"), leaderSold: "11", leaderPreSellInventory: "10", leaderInventoryVerified: true };
    assert.equal((await commitPaperFill(impossible, now, tx)).status, "blocked");
    const full = { ...await input(tx, owner, "sell"), leaderSold: "10", leaderPreSellInventory: "10", leaderInventoryVerified: true };
    assert.equal((await commitPaperFill(full, now, tx)).status, "filled");
    assert.equal((await tx.select().from(gmgnPositions).where(eq(gmgnPositions.userId, owner))).length, 0);
  });
});
test("missing/failed/stale/pre-detection quotes, delay and ambiguous events fail without ledger mutations", async () => {
  await fixture(async (tx, owner) => {
    const bad: Array<ValidatedPaperObservation | null> = [null,
      { ...fixtureQuote(), quoteVerified: false }, { ...fixtureQuote(), canonicalEventVerified: false },
      { ...fixtureQuote(), upstreamAt: new Date("2026-10-11T11:59:59Z") },
      { ...fixtureQuote(), securityVerified: false }, { ...fixtureQuote(), liquidityUsd: null }];
    for (const quote of bad) assert.equal((await commitPaperFill({ ...await input(tx, owner), quote }, now, tx)).status, "blocked");
    assert.equal((await commitPaperFill(await input(tx, owner), new Date("2026-10-11T12:00:01Z"), tx)).status, "blocked");
    assert.equal((await commitPaperFill(await input(tx, owner), new Date("2026-10-11T12:00:30Z"), tx)).status, "blocked");
    assert.equal((await tx.select().from(gmgnTrades).where(eq(gmgnTrades.userId, owner))).length, 0);
    const [settings] = await tx.select().from(gmgnSettings).where(eq(gmgnSettings.userId, owner));
    assert.equal(paperUnits(settings.paperCashUsd), paperUnits("100"));
  });
});
test("reviewed setup, fee-inclusive exposure/cash, day/position caps and full stop are enforced", async () => {
  await fixture(async (tx, owner) => {
    const cases = [
      { setupComplete: false }, { paused: true }, { fullStopped: true }, { buysHalted: true },
      { totalExposureUsd: "10" }, { paperCashUsd: "10" }, { maxTradesPerDay: 0 }, { maxOpenPositions: 0 },
    ];
    for (const patch of cases) {
      await tx.update(gmgnSettings).set({ setupComplete: true, paused: false, fullStopped: false, buysHalted: false,
        totalExposureUsd: "50", paperCashUsd: "100", maxTradesPerDay: 5, maxOpenPositions: 5, ...patch }).where(eq(gmgnSettings.userId, owner));
      assert.equal((await commitPaperFill(await input(tx, owner), now, tx)).status, "blocked");
    }
    assert.equal((await tx.select().from(gmgnTrades).where(eq(gmgnTrades.userId, owner))).length, 0);
  });
});
test("failed persistence rolls back every component and preserves pending decision", async () => {
  await fixture(async (tx, owner) => {
    const request = await input(tx, owner), failure = new Error("ISOLATED_FAILURE_AFTER_LEDGER_WRITES");
    const failing: Pick<typeof db, "transaction"> = { transaction: callback => tx.transaction(async nested => {
      await callback(nested); throw failure;
    }) };
    await assert.rejects(commitPaperFill(request, now, failing), error => error === failure);
    for (const table of [gmgnTrades, gmgnPositions, gmgnEquityPoints]) assert.equal((await tx.select().from(table).where(eq(table.userId, owner))).length, 0);
    const [settings] = await tx.select().from(gmgnSettings).where(eq(gmgnSettings.userId, owner));
    const [signal] = await tx.select().from(gmgnSignals).where(eq(gmgnSignals.id, request.signalId));
    assert.equal(paperUnits(settings.paperCashUsd), paperUnits("100")); assert.equal(signal.status, "pending");
  });
});
test("positive daily loss stops entries; zero disables it; stale exposure marks block new tokens", async () => {
  await fixture(async (tx, owner) => {
    await tx.insert(gmgnTrades).values({ userId: owner, tokenAddress: "OFFLINE_CLOSED", leaderAddress: "OFFLINE_LEADER",
      side: "sell", quantity: "1", priceUsd: "1", notionalUsd: "1", realizedPnlUsd: "-5", simulated: true, filledAt: now });
    await tx.update(gmgnSettings).set({ dailyLossCutoffUsd: "5" }).where(eq(gmgnSettings.userId, owner));
    assert.match((await commitPaperFill(await input(tx, owner), now, tx)).reason, /loss cutoff/);
    await tx.update(gmgnSettings).set({ dailyLossCutoffUsd: "0" }).where(eq(gmgnSettings.userId, owner));
    assert.equal((await commitPaperFill(await input(tx, owner), now, tx)).status, "filled");
    await tx.update(gmgnPositions).set({ priceObservedAt: new Date(now.getTime() - 16_000) }).where(eq(gmgnPositions.userId, owner));
    const next = await input(tx, owner);
    await tx.update(gmgnSignals).set({ tokenAddress: "OFFLINE_OTHER_TOKEN" }).where(eq(gmgnSignals.id, next.signalId));
    assert.match((await commitPaperFill(next, now, tx)).reason, /exposure marks/);
  });
});
test("owner advisory lock serializes distinct connections without committed test data", async () => {
  const owner = `isolated-lock-${randomUUID()}`, a = await pool.connect(), b = await pool.connect();
  try {
    await a.query("BEGIN"); await b.query("BEGIN");
    await a.query("SELECT pg_advisory_xact_lock(hashtext($1),91200346)", [owner]);
    assert.equal((await b.query("SELECT pg_try_advisory_xact_lock(hashtext($1),91200346) AS held", [owner])).rows[0].held, false);
    await a.query("ROLLBACK");
    assert.equal((await b.query("SELECT pg_try_advisory_xact_lock(hashtext($1),91200346) AS held", [owner])).rows[0].held, true);
  } finally {
    await a.query("ROLLBACK"); await b.query("ROLLBACK"); a.release(); b.release();
  }
});
test("baseline/rejected signals never replay and live requests never touch the paper ledger", async () => {
  await fixture(async (tx, owner) => {
    for (const status of ["baseline", "skipped"]) {
      const request = await input(tx, owner);
      await tx.update(gmgnSignals).set({ status }).where(eq(gmgnSignals.id, request.signalId));
      assert.equal((await commitPaperFill(request, now, tx)).status, "blocked");
    }
    assert.equal((await commitPaperFill({ ...await input(tx, owner), mode: "live" }, now, tx)).status, "blocked");
    assert.equal((await tx.select().from(gmgnTrades).where(eq(gmgnTrades.userId, owner))).length, 0);
  });
});
after(() => pool.end());
