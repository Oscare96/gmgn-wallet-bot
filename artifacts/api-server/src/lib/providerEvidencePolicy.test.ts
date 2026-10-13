// ISOLATED SYNTHETIC SOFTWARE FIXTURES. Never collected from GMGN, persisted or shown as user results.
import assert from "node:assert/strict";
import test from "node:test";
import { candleRecords, EVIDENCE_LIMITATIONS, historicalPriceProbeWindows, providerPayloadHash, redactProviderEvidence, summarizeProviderData } from "./providerEvidencePolicy";
import { gmgnRead, isSupportedReadCommand, GmgnReadError } from "./gmgnCli";

const from = new Date("2026-10-10T12:00:00Z"), to = new Date("2026-10-10T13:00:00Z");
const candle = (minute = 0) => ({ time: from.getTime() / 1000 + minute * 60, open: "2", high: "3", low: "1", close: "2.5", volume: "100", amount: "250" });

test("dated import requires the supported list schema, valid prices and correct time range", () => {
  assert.throws(() => candleRecords({ data: { candles: [] } }, from, to));
  assert.throws(() => candleRecords({ list: [candle(-1)] }, from, to));
  assert.throws(() => candleRecords({ list: [candle(60)] }, from, to));
  assert.throws(() => candleRecords({ list: [{ ...candle(), close: "NaN" }] }, from, to));
  assert.throws(() => candleRecords({ list: [{ ...candle(), high: "1" }] }, from, to));
  assert.throws(() => candleRecords({ list: [{ ...candle(), open: "0" }] }, from, to));
});
test("duplicate candle events are rejected instead of inflating source coverage", () => {
  assert.throws(() => candleRecords({ list: [candle(), candle()] }, from, to));
});
test("milliseconds are normalized explicitly; gaps are recorded without invented candles or liquidity", () => {
  const a = candle(), b = candle(2);
  a.time *= 1000; b.time *= 1000;
  const summary = summarizeProviderData("candles", { data: { list: [b, a] } }, from, to);
  assert.equal(summary.recordCount, 2);
  assert.equal(summary.timestampUnits, "milliseconds");
  assert.equal(summary.missingCandles, 58);
  assert.equal(summary.returnedFrom?.toISOString(), from.toISOString());
  assert.equal(summary.rows.length, 2);
  assert.ok(!summary.fields.includes("liquidity"));
});
test("empty real-source history is an empty sample, not fabricated activity", () => {
  const summary = summarizeProviderData("activity", { data: { activities: [], next: null } });
  assert.equal(summary.recordCount, 0);
  assert.equal(summary.returnedFrom, null);
  assert.equal(summary.cursor, null);
});
test("unsupported wallet schema and cursor types fail explicitly", () => {
  assert.throws(() => summarizeProviderData("activity", { data: { trades: [] } }));
  assert.throws(() => summarizeProviderData("activity", { data: { activities: [], next: 100 } }));
});
test("pagination cursor is observed but never presented as exhaustive historical coverage", () => {
  const summary = summarizeProviderData("activity", { activities: [{ timestamp: 1791633600, event_type: "buy" }], next: "OFFLINE_CURSOR" });
  assert.equal(summary.cursor, "OFFLINE_CURSOR");
  assert.equal(summary.recordCount, 1);
  assert.match(EVIDENCE_LIMITATIONS.activity, /No exhaustive history/);
});
test("API-only quote samples require actual raw integer amounts, not invented prices/fills", () => {
  assert.throws(() => summarizeProviderData("quote", { output_amount: "5" }));
  assert.throws(() => summarizeProviderData("quote", { input_amount: "1", output_amount: "5", min_output_amount: "6" }));
  assert.equal(summarizeProviderData("quote", { input_amount: "1000", output_amount: "500", min_output_amount: "495" }).recordCount, 1);
  assert.match(EVIDENCE_LIMITATIONS.quote, /not an executable fill/);
});
test("source provenance never labels current traders/security/pools as past decision evidence", () => {
  assert.match(EVIDENCE_LIMITATIONS.trending, /not trending wallets/);
  assert.match(EVIDENCE_LIMITATIONS.traders, /Never used to pick past winners/);
  assert.match(EVIDENCE_LIMITATIONS.security, /cannot be applied to past entries/);
  assert.match(EVIDENCE_LIMITATIONS.pool, /no dated historical-as-of/);
  assert.match(EVIDENCE_LIMITATIONS.whole_strategy, /No historical performance/);
});
test("bounded history windows are distinct, complete past hours, not a fabricated development/evaluation split", () => {
  const windows = historicalPriceProbeWindows(new Date("2026-10-11T22:00:00Z"));
  assert.deepEqual(windows.map((w) => w.from.toISOString()), ["2026-10-10T12:00:00.000Z", "2026-10-04T12:00:00.000Z"]);
  assert.ok(windows.every((w) => w.to.getTime() - w.from.getTime() === 3_600_000));
});
test("secrets are redacted recursively, including request headers and embedded key text", () => {
  const data = redactProviderEvidence({ api_key: "OFFLINE_KEY", token: { address: "OFFLINE_TOKEN" },
    nested: [{ privateKey: "OFFLINE_PRIVATE", price: "2" }], requestHeaders: { Authorization: "OFFLINE_AUTH" },
    note: "GMGN_API_KEY=OFFLINE_KEY", authText: "Bearer OFFLINE_TOKEN" }) as Record<string, unknown>;
  assert.equal(data.api_key, undefined);
  assert.equal(data.requestHeaders, undefined);
  assert.equal(data.note, "[REDACTED]");
  assert.equal(data.authText, "[REDACTED]");
  assert.deepEqual(data.nested, [{ price: "2" }]);
  assert.deepEqual(data.token, { address: "OFFLINE_TOKEN" });
});
test("integrity hash survives JSONB key reordering and detects edited records", () => {
  const first = { b: 1, a: { d: 3, c: 2 }, rows: [{ quantity: "10", token: "OFFLINE_TOKEN" }] };
  const reordered = { rows: [{ token: "OFFLINE_TOKEN", quantity: "10" }], a: { c: 2, d: 3 }, b: 1 };
  assert.equal(providerPayloadHash(first), providerPayloadHash(reordered));
  assert.notEqual(providerPayloadHash(first), providerPayloadHash({ ...first, b: 2 }));
});
test("only documented read commands are allowed: no swap, submission, transfer or withdrawal", () => {
  assert.equal(isSupportedReadCommand(["market", "kline"]), true);
  assert.equal(isSupportedReadCommand(["order", "quote"]), true);
  for (const command of [["swap"], ["order", "create"], ["order", "submit"], ["transfer"], ["withdrawal"]]) assert.equal(isSupportedReadCommand(command), false);
});
test("malformed quote input is rejected before credentials, reservations or network access", async () => {
  const malformed = ["order", "quote", "--chain", "sol", "--from", "OFFLINE_INVALID_ADDRESS",
    "--input-token", "OFFLINE_INVALID_TOKEN", "--output-token", "OFFLINE_INVALID_TOKEN",
    "--amount", "1;echo OFFLINE_INJECTION", "--slippage", "1", "--raw"];
  await assert.rejects(gmgnRead(malformed), (error: unknown) => error instanceof GmgnReadError && error.kind === "unsupported");
  await assert.rejects(gmgnRead(["order", "create"]), (error: unknown) => error instanceof GmgnReadError && error.kind === "unsupported");
});
