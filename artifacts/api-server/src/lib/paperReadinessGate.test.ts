import assert from "node:assert/strict";
import test from "node:test";
import { paperStartupBlock } from "./paperReadinessGate";

const now = new Date("2026-10-12T01:00:00Z");
test("reviewed budgets and a key cannot override unverified paper execution", () => {
  assert.match(paperStartupBlock({ paper: "blocked", readBlockReason: null, readBackoffUntil: null }, now)!, /not verified/);
  assert.match(paperStartupBlock({ paper: "sample_verified", readBlockReason: null, readBackoffUntil: null }, now)!, /not verified/);
});
test("shared backoff and failed permission evidence block even an asserted ready state", () => {
  assert.match(paperStartupBlock({ paper: "ready", readBlockReason: null, readBackoffUntil: "2026-10-12T02:00:00Z" }, now)!, /backoff/);
  assert.match(paperStartupBlock({ paper: "ready", readBlockReason: "auth", readBackoffUntil: null }, now)!, /auth/);
});
test("expired cooldown is not sufficient, but genuinely ready evidence can pass", () => {
  assert.ok(paperStartupBlock({ paper: "blocked", readBlockReason: null, readBackoffUntil: "2026-10-12T00:00:00Z" }, now));
  assert.equal(paperStartupBlock({ paper: "ready", readBlockReason: null, readBackoffUntil: null }, now), null);
});
