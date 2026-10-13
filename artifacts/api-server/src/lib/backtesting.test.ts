// Synthetic offline fixtures only. No records/prices/results from this file enter app reports.
import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_BACKTEST_PERFORMANCE, freezeHistoricalRules, pointInTimeEligible, postDetectionQuote, validateHistoricalPeriods, wholeStrategyValidity, type HistoricalQuote } from "./backtestPolicy";
import { HistoricalLedger, type HistoricalLedgerRisk } from "./historicalLedger";
const t = Date.parse("2026-09-01T12:00:00Z");
const risk = (): HistoricalLedgerRisk => ({
  setupComplete: true, buysHalted: false, fullStopped: false, maxBuyUsd: "10", totalExposureUsd: "50",
  minLiquidityUsd: "10000", dailyLossCutoffUsd: "5", maxOpenPositions: 5, maxTradesPerDay: 5,
  maxSignalAgeMs: 60_000, maxQuoteAgeMs: 10_000, delayMs: 1500, feeBps: "100", slippageBps: "0",
});
const signal = (id: string, leader = "OFFLINE_A", token = "OFFLINE_TOKEN", time = t) => ({ identity: id, leader, token, signalAt: time, detectedAt: time });
const quote = (price = "2", time = t + 1500): HistoricalQuote => ({ token: "OFFLINE_TOKEN", priceUsd: price,
  observedAt: time, availableAt: time, liquidityUsd: "20000", securityPassed: true,
  buyExecutable: true, sellExecutable: true, source: "quote" });
test("zero disables the proposed historical daily realized-loss cutoff; positive cutoff remains enforced", () => {
  const off = new HistoricalLedger("100", { ...risk(), dailyLossCutoffUsd: "0" });
  assert.equal(off.buy(signal("cutoff-off"), quote(), "10").filled, true);
  const on = new HistoricalLedger("100", { ...risk(), dailyLossCutoffUsd: "1" });
  assert.equal(on.buy(signal("loss-buy"), quote(), "10").filled, true);
  assert.equal(on.proportionalSell(signal("loss-sell", "OFFLINE_A", "OFFLINE_TOKEN", t + 10_000), quote("0.5", t + 11_500), "1").filled, true);
  assert.equal(on.buy(signal("after-loss", "OFFLINE_A", "OFFLINE_TOKEN", t + 20_000), quote("2", t + 21_500), "10").reason, "daily_realized_loss_cutoff");
});
test("chronological development/evaluation cannot overlap, use invalid calendar dates or future incomplete days", () => {
  assert.equal(validateHistoricalPeriods({}, new Date("2026-10-11")).complete, false);
  assert.throws(() => validateHistoricalPeriods({ developmentStart: "2026-09-01" }), /four/);
  const dates = { developmentStart: "2026-08-01", developmentEnd: "2026-08-31", evaluationStart: "2026-09-01", evaluationEnd: "2026-09-30" };
  assert.equal(validateHistoricalPeriods(dates, new Date("2026-10-11")).complete, true);
  assert.throws(() => validateHistoricalPeriods({ ...dates, evaluationStart: "2026-08-30" }), /overlap/);
  assert.throws(() => validateHistoricalPeriods({ ...dates, evaluationEnd: "2026-10-11" }, new Date("2026-10-11")), /incomplete/);
  assert.throws(() => validateHistoricalPeriods({ ...dates, developmentStart: "2026-02-30" }), /calendar/);
  assert.throws(() => validateHistoricalPeriods({ ...dates, developmentStart: true }), /calendar/);
});
test("rule snapshots are immutable copies with order-independent hashes; later tuning changes the hash", () => {
  const original = { risk: { maxBuy: 10, fee: 100 }, discovery: { window: 7 } };
  const frozen = freezeHistoricalRules(original);
  assert.equal(frozen.hash, freezeHistoricalRules({ discovery: original.discovery, risk: { fee: 100, maxBuy: 10 } }).hash);
  original.risk.maxBuy = 99;
  assert.equal((frozen.rules.risk as { maxBuy: number }).maxBuy, 10);
  assert.notEqual(frozen.hash, freezeHistoricalRules(original).hash);
});
test("today's selection, future performance and late-published history cannot leak into historical decisions", () => {
  assert.equal(pointInTimeEligible(t, { availableAt: t, selectedAt: t, measuredThrough: t }), true);
  for (const key of ["availableAt", "selectedAt", "measuredThrough"] as const) {
    assert.equal(pointInTimeEligible(t, { availableAt: t, selectedAt: t, measuredThrough: t, [key]: t + 1 }), false);
  }
  const coverage = { pointInTimeUniverse: true, survivorAndFailureCoverage: true, historicalMarketStates: true, inventoryAndSignals: true, frozenRules: true, untouchedEvaluation: true };
  assert.equal(wholeStrategyValidity(coverage).valid, true); // isolated positive validity fixture; no profit input
  for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) {
    assert.equal(wholeStrategyValidity({ ...coverage, [key]: false }).valid, false);
  }
  assert.equal(EMPTY_BACKTEST_PERFORMANCE.netReturnAfterCostsPct, null);
  assert.equal(EMPTY_BACKTEST_PERFORMANCE.trades, null); // no completed simulation is not a zero-trade strategy result
});
test("delayed entries never use leader past entry or a candle close before its availability", () => {
  const past = quote("1", t - 1000), delayed = quote("2", t + 1500);
  assert.equal(postDetectionQuote([past, delayed], "OFFLINE_TOKEN", t, 1500, t + 60_000, 10_000)?.priceUsd, "2");
  const futureClose = { ...delayed, source: "candle_close" as const, candleEndAt: t + 60_000 };
  assert.equal(postDetectionQuote([futureClose], "OFFLINE_TOKEN", t, 1500, t + 60_000, 10_000), null);
  assert.equal(postDetectionQuote([{ ...delayed, availableAt: t + 60_000 }], "OFFLINE_TOKEN", t, 1500, t + 60_000, 10_000), null);
});
test("exact cash, fees and partial leader exits reconcile; exit attribution cannot touch another leader", () => {
  const ledger = new HistoricalLedger("100", risk());
  assert.equal(ledger.buy(signal("buy"), quote(), "10").filled, true);
  assert.equal(ledger.snapshot().cashUsd, "89.9");
  assert.equal(ledger.snapshot().positions[0].quantity, "5");
  assert.equal(ledger.proportionalSell(signal("other", "OFFLINE_B", "OFFLINE_TOKEN", t + 10_000), quote("3", t + 11_500), "1").reason, "no_attributable_position");
  const half = ledger.proportionalSell(signal("half", "OFFLINE_A", "OFFLINE_TOKEN", t + 10_000), quote("3", t + 11_500), "0.5");
  assert.equal(half.realizedPnlUsd, "2.375");
  assert.equal(ledger.snapshot().cashUsd, "97.325");
  assert.equal(ledger.snapshot().positions[0].costUsd, "5.05");
  assert.equal(ledger.closedMetrics().closedRoundtrips, 0); // partial exits do not inflate sample size
  const close = ledger.proportionalSell(signal("close", "OFFLINE_A", "OFFLINE_TOKEN", t + 20_000), quote("3", t + 21_500), "1");
  assert.equal(close.filled, true);
  assert.equal(ledger.snapshot().cashUsd, "104.75");
  assert.equal(ledger.snapshot().positions.length, 0);
  assert.equal(ledger.closedMetrics().netReturnAfterCostsPct, 4.75);
  assert.equal(ledger.closedMetrics().profitFactor, null); // undefined with no observed losses; never invent infinity
});
test("overlapping token signals and rejected event replays cannot create a second attributed purchase", () => {
  const ledger = new HistoricalLedger("100", risk());
  ledger.buy(signal("A"), quote(), "10");
  assert.equal(ledger.buy(signal("B", "OFFLINE_B"), quote(), "10").reason, "overlapping_token_entry");
  ledger.proportionalSell(signal("exit", "OFFLINE_A", "OFFLINE_TOKEN", t + 10_000), quote("2", t + 11_500), "1");
  assert.equal(ledger.buy(signal("B", "OFFLINE_B", "OFFLINE_TOKEN", t + 20_000), quote("2", t + 21_500), "10").reason, "duplicate_event");
  assert.equal(ledger.snapshot().positions.length, 0);
});
test("unsellable positions and missing terminal marks remain open/unknown, not invented liquidation results", () => {
  const ledger = new HistoricalLedger("100", risk());
  ledger.buy(signal("buy"), quote(), "10");
  const untradeable = { ...quote("999", t + 11_500), sellExecutable: false };
  assert.equal(ledger.proportionalSell(signal("exit", "OFFLINE_A", "OFFLINE_TOKEN", t + 10_000), untradeable, "1").reason, "unsellable_no_invented_exit");
  assert.equal(ledger.snapshot().positions[0].quantity, "5");
  assert.equal(ledger.terminalLiquidationEquity([untradeable], t + 11_500), null);
  assert.equal(ledger.closedMetrics().netReturnAfterCostsPct, null);
});
test("signal/quote freshness, fee-inclusive exposure, cash and daily/position entry caps fail closed", () => {
  assert.equal(new HistoricalLedger("100", risk()).buy(signal("stale"), quote("2", t + 61_000), "10").filled, false);
  assert.equal(new HistoricalLedger("100", risk()).buy(signal("missing"), { ...quote(), securityPassed: null }, "10").filled, false);
  assert.equal(new HistoricalLedger("100", risk()).buy(signal("missing"), { ...quote(), liquidityUsd: null }, "10").filled, false);
  assert.equal(new HistoricalLedger("10", risk()).buy(signal("cash"), quote(), "10").reason, "cash_cap_including_fees");
  assert.equal(new HistoricalLedger("100", { ...risk(), totalExposureUsd: "10" }).buy(signal("exp"), quote(), "10").reason, "exposure_cap_including_fees");
  const capped = new HistoricalLedger("100", { ...risk(), maxOpenPositions: 1 });
  capped.buy(signal("one"), quote(), "10");
  assert.equal(capped.buy(signal("two", "OFFLINE_A", "OTHER"), { ...quote(), token: "OTHER" }, "10").reason, "position_cap");
  const trades = new HistoricalLedger("100", { ...risk(), maxTradesPerDay: 1 });
  trades.buy(signal("one"), quote(), "10");
  assert.equal(trades.buy(signal("two", "OFFLINE_A", "OTHER"), { ...quote(), token: "OTHER" }, "10").reason, "daily_trade_cap");
});
test("buy halt preserves executable exits; losses halt later entries; overlarge fractions cannot oversell", () => {
  const config = risk(), ledger = new HistoricalLedger("100", config);
  ledger.buy(signal("one"), quote(), "10");
  assert.equal(ledger.proportionalSell(signal("invalid"), quote(), "1.1").reason, "invalid_leader_sell_fraction");
  config.buysHalted = true;
  assert.equal(ledger.proportionalSell(signal("exit", "OFFLINE_A", "OFFLINE_TOKEN", t + 10_000), quote("0.1", t + 11_500), "1").filled, true);
  config.buysHalted = false;
  assert.equal(ledger.buy(signal("new", "OFFLINE_A", "OFFLINE_TOKEN", t + 20_000), quote("2", t + 21_500), "10").reason, "daily_realized_loss_cutoff");
  config.fullStopped = true;
  assert.equal(ledger.buy(signal("stop"), quote(), "1").reason, "full_stop");
});
