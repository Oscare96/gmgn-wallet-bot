import assert from "node:assert/strict";
import test from "node:test";
import { quoteProbeInputs } from "./paperQuoteProbe";
import { providerPayloadHash } from "./providerEvidencePolicy";

// Isolated synthetic schema fixtures only: no GMGN requests, DB writes or strategy results.
const token = "So11111111111111111111111111111111111111112";
const wallet = "11111111111111111111111111111111";
function fixture(payload: unknown = { list: [{ address: wallet, addr_type: 0 }] }) {
  return { payload, payloadHash: payload && typeof payload === "object" && !Array.isArray(payload) ? providerPayloadHash(payload as Record<string, unknown>) : null, command: ["token", "traders", "--chain", "sol", "--address", token] };
}
test("quote probe only derives identities from checksum-intact official trader evidence", () => {
  assert.deepEqual(quoteProbeInputs(fixture()), { wallet, token });
  assert.throws(() => quoteProbeInputs({ ...fixture(), payloadHash: "a".repeat(64) }));
});
test("quote probe never accepts missing or invented discovery evidence", () => {
  for (const payload of [null, {}, { list: [] }, { list: [{ address: "invented-wallet" }] }]) {
    assert.throws(() => quoteProbeInputs(fixture(payload)));
  }
  assert.throws(() => quoteProbeInputs({ ...fixture(), command: ["market", "trending"] }));
  assert.throws(() => quoteProbeInputs({ ...fixture(), command: ["token", "traders", "--address", "bad-token"] }));
  assert.throws(() => quoteProbeInputs({ ...fixture(), command: ["token", "traders", "--chain", "eth", "--address", token] }));
});
test("contract addresses are not selected as wallet candidates", () => {
  assert.throws(() => quoteProbeInputs(fixture({ list: [{ address: wallet, addr_type: 2 }] })));
});
