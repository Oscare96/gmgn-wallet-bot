import assert from "node:assert/strict";
import test from "node:test";
import {
  buyBlockReason,
  LIVE_TRADING_ENABLED,
  proportionalExitQuantity,
  signalIsStale,
  simulateBuyFill,
  realizePaperExit,
} from "./paperTrading.js";

// Synthetic fixtures live only in this test file. They are never inserted into app storage.
const now = Date.parse("2026-10-11T12:00:00.000Z");
const risk = {
  setupComplete: true,
  buysHalted: false,
  maxBuyUsd: 25,
  totalExposureUsd: 100,
  maxOpenPositions: 5,
  maxTradesPerDay: 5,
  maxSignalAgeSeconds: 60,
  minLiquidityUsd: 10_000,
  maxTopHolderPct: 0.2,
  dailyLossCutoffUsd: 50,
};
const market = {
  priceUsd: 0.002,
  observedAt: now,
  liquidityUsd: 20_000,
  topHolderPct: 0.12,
  poolAddress: "synthetic-pool",
  securityEvidence: true,
};
const account = {
  cashUsd: 100,
  exposureUsd: 20,
  openPositions: 1,
  tradesToday: 0,
  dailyRealizedPnlUsd: 0,
};

test("signal freshness rejects stale and future records", () => {
  assert.equal(signalIsStale(now - 61_000, now, 60), true);
  assert.equal(signalIsStale(now + 1, now, 60), true);
  assert.equal(signalIsStale(now - 60_000, now, 60), false);
});

test("missing price, liquidity, security evidence and risk caps block entries", () => {
  assert.match(
    buyBlockReason(risk, { ...market, priceUsd: null }, account, now, now) ?? "",
    /fresh post-detection/,
  );
  assert.match(
    buyBlockReason(risk, { ...market, liquidityUsd: null }, account, now, now) ?? "",
    /Liquidity evidence/,
  );
  assert.match(
    buyBlockReason(risk, { ...market, securityEvidence: false }, account, now, now) ?? "",
    /security or pool/,
  );
  assert.match(
    buyBlockReason(risk, market, { ...account, tradesToday: risk.maxTradesPerDay }, now, now) ?? "",
    /Daily trade limit/,
  );
});

test("projected exposure, per-buy budget, position limits, losses and setup are enforced", () => {
  assert.match(buyBlockReason(risk, market, { ...account, exposureUsd: 90 }, now, now) ?? "", /exposure/);
  assert.match(buyBlockReason(risk, market, account, now, now, 30) ?? "", /Per-buy/);
  assert.match(buyBlockReason(risk, market, { ...account, openPositions: 5 }, now, now) ?? "", /position/);
  assert.match(buyBlockReason(risk, market, { ...account, dailyRealizedPnlUsd: -50 }, now, now) ?? "", /loss/);
  assert.match(buyBlockReason({ ...risk, setupComplete: false }, market, account, now, now) ?? "", /setup/);
  assert.match(buyBlockReason({ ...risk, buysHalted: true }, market, account, now, now) ?? "", /halted/);
});

test("partial exits allocate only their cost basis and account for exit fees", () => {
  const exit = realizePaperExit({
    quantity: 2.5,
    positionQuantity: 10,
    positionCostBasisUsd: 20,
    observedPriceUsd: 3,
    feeBps: 100,
    slippageBps: 0,
  });
  assert.ok(exit);
  assert.equal(exit.notionalUsd, 7.5);
  assert.equal(exit.feeUsd, 0.075);
  assert.equal(exit.realizedPnlUsd, 2.425);
  assert.equal(realizePaperExit({
    quantity: 11,
    positionQuantity: 10,
    positionCostBasisUsd: 20,
    observedPriceUsd: 3,
    feeBps: 100,
    slippageBps: 0,
  }), null);
});

test("simulated buy accounts for price impact, fee, cash and decimal quantity", () => {
  const fill = simulateBuyFill({
    targetUsd: 25,
    cashUsd: 100,
    priceUsd: 2,
    feeBps: 100,
    slippageBps: 200,
  });
  assert.ok(fill);
  assert.equal(fill.notionalUsd, 25);
  assert.equal(fill.feeUsd, 0.25);
  assert.equal(fill.priceUsd, 2.04);
  assert.equal(fill.quantity, 12.254901960784);
  assert.equal(fill.cashDeltaUsd, 25.25);
});

test("leader exits scale only the matching paper position and never oversell", () => {
  assert.equal(proportionalExitQuantity(10, 100, 25), 2.5);
  assert.equal(proportionalExitQuantity(10, 100, 150), 10);
  assert.equal(proportionalExitQuantity(10, 0, 2), 0);
});

test("live execution is disabled at the server boundary", () => {
  assert.equal(LIVE_TRADING_ENABLED, false);
});
