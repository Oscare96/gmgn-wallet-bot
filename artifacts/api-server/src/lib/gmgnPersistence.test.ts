import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { db, pool, gmgnSignals, gmgnDiscoveryCandidates, gmgnDiscoveryObservations, gmgnDiscoveryRuns, gmgnBacktestRuns } from "@workspace/db";
import { BACKTEST_ASSUMPTIONS, EMPTY_BACKTEST_PERFORMANCE, freezeHistoricalRules } from "./backtestPolicy";
import { and, eq } from "drizzle-orm";

test("persisted signal uniqueness rejects replay after loss of worker memory", async () => {
  const owner = `offline-fixture-${randomUUID()}`;
  const eventIdentity = `offline-fixture-event-${randomUUID()}`;
  const rollback = new Error("ROLLBACK_ISOLATED_FIXTURE");
  await assert.rejects(db.transaction(async (tx) => {
    const record = {
      userId: owner,
      eventIdentity,
      walletAddress: "isolated-synthetic-leader",
      walletLabel: "OFFLINE TEST FIXTURE",
      tokenAddress: "isolated-synthetic-token",
      side: "buy",
      observedAt: new Date("2026-10-11T12:00:00Z"),
      status: "baseline",
      reason: "Isolated test fixture; transaction is rolled back.",
    };
    const inserted = await tx.insert(gmgnSignals).values(record).onConflictDoNothing().returning();
    assert.equal(inserted.length, 1);
    // Replay consults persistent uniqueness, not an in-memory Set.
    const restored = JSON.parse(JSON.stringify(record)) as typeof record;
    restored.observedAt = new Date(record.observedAt);
    const replay = await tx.insert(gmgnSignals).values(restored).onConflictDoNothing().returning();
    assert.equal(replay.length, 0);
    const rows = await tx.select().from(gmgnSignals).where(and(
      eq(gmgnSignals.userId, owner),
      eq(gmgnSignals.eventIdentity, eventIdentity),
    ));
    assert.equal(rows.length, 1);
    throw rollback;
  }), (error) => error === rollback);
  const visibleAfterRollback = await db.select().from(gmgnSignals).where(eq(gmgnSignals.userId, owner));
  assert.equal(visibleAfterRollback.length, 0);
});
after(() => pool.end());

test("blocked historical assessment freezes parameters, is owner-scoped and never manufactures an execution/result", async () => {
  const owner = `offline-fixture-${randomUUID()}`, rollback = new Error("ROLLBACK_BACKTEST_FIXTURE");
  await assert.rejects(db.transaction(async (tx) => {
    const source = { feeBps: 100, maxBuyUsd: "10" }, snapshot = freezeHistoricalRules(source);
    const [row] = await tx.insert(gmgnBacktestRuns).values({ userId: owner, status: "blocked", assessedAt: new Date(),
      rulesFrozenAt: new Date(), rulesHash: snapshot.hash, frozenRules: snapshot.rules,
      assessment: { fixture: "ISOLATED OFFLINE FIXTURE" }, performance: EMPTY_BACKTEST_PERFORMANCE, assumptions: BACKTEST_ASSUMPTIONS }).returning();
    source.maxBuyUsd = "999";
    const [stored] = await tx.select().from(gmgnBacktestRuns).where(and(eq(gmgnBacktestRuns.id, row.id), eq(gmgnBacktestRuns.userId, owner)));
    assert.equal((stored.frozenRules as { maxBuyUsd: string }).maxBuyUsd, "10");
    assert.equal(stored.startedAt, null); assert.equal(stored.completedAt, null);
    assert.equal((stored.performance as typeof EMPTY_BACKTEST_PERFORMANCE).trades, null);
    assert.equal((await tx.select().from(gmgnBacktestRuns).where(and(eq(gmgnBacktestRuns.id, row.id), eq(gmgnBacktestRuns.userId, `${owner}-other`)))).length, 0);
    throw rollback;
  }), (error) => error === rollback);
  assert.equal((await db.select().from(gmgnBacktestRuns).where(eq(gmgnBacktestRuns.userId, owner))).length, 0);
});

test("isolated discovery provenance, frozen rankings and restart dedup persist without exposing fixture results", async () => {
  const owner = `offline-fixture-${randomUUID()}`, address = "ISOLATED_SYNTHETIC_WALLET";
  const rollback = new Error("ROLLBACK_DISCOVERY_FIXTURES");
  await assert.rejects(db.transaction(async (tx) => {
    const [candidate] = await tx.insert(gmgnDiscoveryCandidates).values({ userId: owner, address,
      provenance: { source: "ISOLATED OFFLINE FIXTURE, NOT GMGN DATA" }, score: 10 }).returning();
    const record = { userId: owner, address, evaluationId: candidate.evaluationId, eventIdentity: "OFFLINE:sol:tx:event",
      tokenAddress: "OFFLINE_TOKEN", side: "buy", observedAt: new Date(), status: "baseline",
      reason: "Synthetic historical baseline fixture; never a fill.", provenance: { fixture: true } };
    assert.equal((await tx.insert(gmgnDiscoveryObservations).values(record).onConflictDoNothing().returning()).length, 1);
    const replay = JSON.parse(JSON.stringify(record)) as typeof record;
    replay.observedAt = new Date(replay.observedAt);
    assert.equal((await tx.insert(gmgnDiscoveryObservations).values(replay).onConflictDoNothing().returning()).length, 0);
    const [ranking] = await tx.insert(gmgnDiscoveryRuns).values({ userId: owner, chicagoDay: "2026-10-11", status: "complete",
      entries: [{ address, score: candidate.score, provenance: candidate.provenance }], coverage: "ISOLATED OFFLINE FIXTURE" }).returning();
    await tx.update(gmgnDiscoveryCandidates).set({ score: 100 }).where(eq(gmgnDiscoveryCandidates.userId, owner));
    const [frozen] = await tx.select().from(gmgnDiscoveryRuns).where(eq(gmgnDiscoveryRuns.id, ranking.id));
    assert.equal((frozen.entries as { score: number }[])[0].score, 10); // no future information rewrites old ranking
    const otherOwnerRows = await tx.select().from(gmgnDiscoveryObservations).where(eq(gmgnDiscoveryObservations.userId, `${owner}-other`));
    assert.equal(otherOwnerRows.length, 0);
    throw rollback;
  }), (error) => error === rollback);
  assert.equal((await db.select().from(gmgnDiscoveryCandidates).where(eq(gmgnDiscoveryCandidates.userId, owner))).length, 0);
});
