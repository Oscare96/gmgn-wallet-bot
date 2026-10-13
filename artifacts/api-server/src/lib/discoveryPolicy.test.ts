// ALL records in this file are isolated, synthetic offline fixtures. Never load them into the app.
import assert from "node:assert/strict";
import test from "node:test";
import { advanceCursor, chicagoDay, DEFAULT_DISCOVERY_RULES, DISCOVERY_SOURCE, emptyMetrics, forwardMetrics, historyMetrics, isRecentlyActiveTrader, observationDecision, qualifyCandidate, refreshDue, tokenTraders, trendingTokens } from "./discoveryPolicy";
import { isSupportedReadCommand } from "./gmgnCli";
import { LIVE_TRADING_ENABLED } from "./paperTrading";
const ADDRESS = "11111111111111111111111111111111";
const now = new Date("2026-10-11T12:00:00Z");
const start = new Date("2026-10-01T12:00:00Z");
const eligibleFixture = () => ({ ...emptyMetrics(), historicalRealizedPnlUsd: 100, historicalSells: 40,
  historicalLossSamples: 40, historicalSpanDays: 20, lossRatePct: 25, holdingSeconds: 600,
  concentrationPct: 20, suspicious: false, forwardDays: 10, forwardSells: 20,
  forwardNetPnlUsd: 5, forwardCostsUsd: 3, forwardDrawdownUsd: 2, copyabilityVerified: true });

test("discovery provenance is derived token-trader activity, not an official wallet leaderboard", () => {
  assert.match(DISCOVERY_SOURCE, /Derived/);
  assert.equal(trendingTokens({ data: { rank: [{ address: ADDRESS }] } }).length, 1);
  assert.equal(tokenTraders({ data: { list: [{ address: ADDRESS, addr_type: 0 }] } }).length, 1);
  assert.equal(tokenTraders({ list: [{ address: ADDRESS, addr_type: 2 }] }).length, 0);
  assert.throws(() => trendingTokens({ data: { wallets: [] } }), /schema/);
  assert.throws(() => tokenTraders({ data: { accounts: [] } }), /schema/);
  assert.throws(() => trendingTokens({ rank: [{ address: "fabricated-address" }] }), /identity/);
});
test("missing, stale or future trader timing never claims an active candidate", () => {
  assert.equal(isRecentlyActiveTrader({}, now), false);
  assert.equal(isRecentlyActiveTrader({ last_active_timestamp: (now.getTime() - 3600_000) / 1000 }, now), true);
  assert.equal(isRecentlyActiveTrader({ last_active_timestamp: (now.getTime() - 86_401_000) / 1000 }, now), false);
  assert.equal(isRecentlyActiveTrader({ last_active_timestamp: (now.getTime() + 1000) / 1000 }, now), false);
});
test("daily refresh uses Chicago dates, including DST's 25-hour day, not UTC or fixed 24 hours", () => {
  assert.equal(chicagoDay(new Date("2026-10-11T04:59:00Z")), "2026-10-10");
  assert.equal(refreshDue("2026-10-10", false, new Date("2026-10-11T05:00:00Z")), true);
  assert.equal(refreshDue("2026-10-10", false, new Date("2026-10-11T00:30:00Z")), false);
  assert.equal(chicagoDay(new Date("2026-11-02T05:59:00Z")), "2026-11-01");
  assert.equal(chicagoDay(new Date("2026-11-02T06:00:00Z")), "2026-11-02");
  assert.equal(refreshDue("2026-10-11", true, now), true);
});
test("cursor histories survive restart, reject cycles and bound excessive historical pagination", () => {
  let history = advanceCursor([], null, "A");
  history = advanceCursor(history, "A", "B");
  history = JSON.parse(JSON.stringify(history));
  assert.throws(() => advanceCursor(history, "B", "A"), /cyclic/);
  assert.throws(() => advanceCursor([], "A", "A"), /cyclic/);
  assert.throws(() => advanceCursor(Array.from({ length: 100 }, (_, i) => `p${i}`), "new", "more"), /limit/);
  assert.deepEqual(advanceCursor(history, "B", null), []);
});
test("historical baselines and pre-cohort events cannot become forward fills after restart", () => {
  assert.equal(observationDecision(false, null, now, now, 60).status, "baseline");
  assert.equal(observationDecision(true, start, start, now, 1_000_000).status, "baseline");
  assert.equal(observationDecision(true, start, new Date(now.getTime() - 61_000), now, 60).status, "skipped");
  assert.equal(observationDecision(true, start, new Date(now.getTime() + 1), now, 60).status, "skipped");
  assert.equal(observationDecision(true, start, now, now, 60).status, "observed");
});
test("unavailable historical metrics remain null and guessed holding times are not reported", () => {
  const metrics = historyMetrics({}, [
    { event_type: "buy", timestamp: start.getTime() / 1000, token: { address: ADDRESS } },
    { event_type: "sell", timestamp: now.getTime() / 1000, token: { address: ADDRESS } },
  ], null);
  assert.equal(metrics.historicalRealizedPnlUsd, null);
  assert.equal(metrics.lossRatePct, null);
  assert.equal(metrics.holdingSeconds, null);
  assert.equal(metrics.concentrationPct, null);
  assert.equal(qualifyCandidate({ ...emptyMetrics(), ...metrics }, DEFAULT_DISCOVERY_RULES, false, true).state, "observation_only");
});
test("high historical profit alone cannot qualify; unknown loss, security or copyability evidence blocks", () => {
  const metrics = eligibleFixture();
  assert.equal(qualifyCandidate(metrics, DEFAULT_DISCOVERY_RULES, false, true).state, "qualified"); // offline positive policy fixture only
  for (const field of ["lossRatePct", "holdingSeconds", "concentrationPct", "suspicious", "forwardNetPnlUsd"] as const) {
    assert.equal(qualifyCandidate({ ...metrics, [field]: null }, DEFAULT_DISCOVERY_RULES, false, true).state, "observation_only");
  }
  assert.equal(qualifyCandidate({ ...metrics, historicalRealizedPnlUsd: 1e9, copyabilityVerified: false }, DEFAULT_DISCOVERY_RULES, false, true).state, "observation_only");
  assert.equal(qualifyCandidate({ ...metrics, forwardDays: 1 }, DEFAULT_DISCOVERY_RULES, false, true).state, "observation_only");
  assert.equal(qualifyCandidate(metrics, DEFAULT_DISCOVERY_RULES, true, true).state, "excluded");
  assert.equal(qualifyCandidate({ ...metrics, suspicious: true }, DEFAULT_DISCOVERY_RULES, false, true).state, "excluded");
  assert.equal(qualifyCandidate(metrics, DEFAULT_DISCOVERY_RULES, false, false).state, "observation_only");
});
test("forward accounting ignores future-selected cohorts and prior fills; partial exits are not independent closed samples", () => {
  const fill = { evaluationId: "OFFLINE-COHORT", filledAt: now, simulated: true, tokenAddress: ADDRESS, side: "buy", quantity: "10", realizedPnlUsd: null, feeUsd: "1", slippageUsd: "0.5" };
  const fills = [
    { ...fill, evaluationId: "OLD-COHORT", side: "sell", realizedPnlUsd: "999999" },
    { ...fill, filledAt: new Date(start.getTime() - 1), side: "sell", realizedPnlUsd: "999999" },
    fill, { ...fill, side: "sell", quantity: "5", realizedPnlUsd: "3" },
    { ...fill, side: "sell", quantity: "5", realizedPnlUsd: "-4" },
  ];
  const result = forwardMetrics(fills, "OFFLINE-COHORT", start, now);
  assert.equal(result.forwardSells, 1);
  assert.equal(result.forwardNetPnlUsd, -1); // recorded realized PnL already includes costs; never deduct twice
  assert.equal(result.forwardCostsUsd, 4.5);
  assert.equal(result.forwardDrawdownUsd, 4);
  assert.equal(forwardMetrics([{ ...fill, side: "sell", quantity: "11", realizedPnlUsd: "100" }], "OFFLINE-COHORT", start, now).forwardNetPnlUsd, null);
  assert.equal(forwardMetrics(fills, "NEW-FUTURE-SELECTED-COHORT", now, now).forwardNetPnlUsd, null);
});
test("live execution stays unavailable and discovery adds only documented read commands", () => {
  assert.equal(LIVE_TRADING_ENABLED, false);
  assert.equal(isSupportedReadCommand(["market", "trending"]), true);
  assert.equal(isSupportedReadCommand(["token", "traders"]), true);
  assert.equal(isSupportedReadCommand(["market", "kline"]), true);
  assert.equal(isSupportedReadCommand(["order", "quote"]), true); // Documented read-only GET, not signed CLI execution.
  for (const cmd of [["order", "create"], ["order", "swap"], ["order", "status"], ["wallet", "transfer"], ["market", "wallet-rank"]]) assert.equal(isSupportedReadCommand(cmd), false);
});
