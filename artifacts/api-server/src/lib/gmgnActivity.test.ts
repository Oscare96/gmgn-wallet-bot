import assert from "node:assert/strict";
import test from "node:test";
import { activityPage, normalizeActivity } from "./gmgnActivity";
import { isSupportedReadCommand } from "./gmgnCli";

// Explicitly synthetic offline records; no GMGN calls and no database inserts.
const fixture = {
  tx_hash: "synthetic-transaction",
  event_type: "buy",
  timestamp: 1_791_720_000,
  token_amount: "100",
  token: { address: "synthetic-token", symbol: "FIXTURE" },
};

test("activity identity survives serialization and process-memory loss", () => {
  const first = normalizeActivity("synthetic-leader", fixture);
  const restarted = normalizeActivity("synthetic-leader", JSON.parse(JSON.stringify(fixture)));
  assert.ok(first);
  assert.ok(restarted);
  assert.equal(first.identity, restarted.identity);
  const anotherEvent = normalizeActivity("synthetic-leader", { ...fixture, token_amount: "200" });
  assert.notEqual(first.identity, anotherEvent?.identity);
});

test("transfer events, missing transaction ids and missing timestamps cannot become signals", () => {
  assert.equal(normalizeActivity("fixture", { ...fixture, event_type: "transferIn" }), null);
  assert.equal(normalizeActivity("fixture", { ...fixture, tx_hash: "" }), null);
  assert.equal(normalizeActivity("fixture", { ...fixture, timestamp: null }), null);
});

test("documented activities/next pagination is accepted and invented envelopes are rejected", () => {
  assert.equal(activityPage({ activities: [fixture], next: "fixture-cursor" }).next, "fixture-cursor");
  assert.throws(() => activityPage({ list: [fixture] }), /schema/);
  assert.throws(() => activityPage({ activities: [], next: 2 }), /cursor/);
});

test("the adapter blocks order execution and transfers while allowing the documented API-only quote read", () => {
  assert.equal(isSupportedReadCommand(["portfolio", "activity"]), true);
  assert.equal(isSupportedReadCommand(["swap", "--chain", "sol"]), false);
  assert.equal(isSupportedReadCommand(["order", "quote"]), true);
  assert.equal(isSupportedReadCommand(["order", "create"]), false);
  assert.equal(isSupportedReadCommand(["order", "status"]), false);
  assert.equal(isSupportedReadCommand(["transfer", "--to", "fixture"]), false);
});
