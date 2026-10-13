import { test } from "node:test";
import assert from "node:assert/strict";
import { nextQuoteAttempt, quoteFailureState, quoteRecoveryDecision, quoteResetTime } from "./quoteRecoveryPolicy";

const now = Date.parse("2026-01-01T12:00:00Z"); // Isolated synthetic timing, not market results.
const row = { state: "waiting", attempts: 0, nextAttemptAt: new Date(now), heartbeatAt: null };
test("single due eligibility honors provider cooldown and persisted restart timing", () => {
  assert.equal(quoteRecoveryDecision(row, now - 1), "waiting");
  assert.equal(quoteRecoveryDecision(row, now), "eligible");
  assert.equal(quoteRecoveryDecision(row, now, new Date(now + 1)), "waiting");
  const persisted = { ...row, attempts: 1, nextAttemptAt: nextQuoteAttempt(now, 1) };
  assert.equal(quoteRecoveryDecision(persisted, now + 59 * 60_000), "waiting");
  assert.equal(quoteRecoveryDecision(persisted, now + 60 * 60_000), "eligible");
});
test("crash/overlap never permits immediate duplicate or burst catch-up", () => {
  assert.equal(quoteRecoveryDecision({ ...row, state: "running", heartbeatAt: new Date(now) }, now), "busy");
  assert.equal(quoteRecoveryDecision({ ...row, state: "running", heartbeatAt: new Date(now) }, now + 120_000), "interrupted");
  const delayed = nextQuoteAttempt(now + 120_000, 1);
  assert.equal(quoteRecoveryDecision({ ...row, nextAttemptAt: delayed }, now + 120_000), "waiting");
});
test("bounded retries stop at six; success, auth, missing and schema are terminal", () => {
  assert.equal(quoteRecoveryDecision({ ...row, attempts: 6 }, now), "exhausted");
  assert.equal(quoteRecoveryDecision({ ...row, state: "verified" }, now), "terminal");
  assert.equal(quoteFailureState("rate_limited", 5), "waiting");
  assert.equal(quoteFailureState("rate_limited", 6), "blocked");
  for (const error of ["auth", "missing_key", "unsupported", "schema_unverified"]) {
    assert.equal(quoteFailureState(error, 1), "blocked");
  }
});
test("provider reset is authoritative and retry spacing increases without rapid loops", () => {
  const later = now + 12 * 3_600_000;
  assert.equal(nextQuoteAttempt(now, 2, later).getTime(), later);
  assert.equal(nextQuoteAttempt(now, 3).getTime(), now + 4 * 3_600_000);
  assert.equal(quoteResetTime(later / 1000, now)?.getTime(), later + 1000);
  for (const value of [undefined, "secret", NaN, -1, Infinity]) assert.equal(quoteResetTime(value, now), null);
});
