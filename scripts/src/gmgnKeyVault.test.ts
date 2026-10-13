// Isolated cryptographic fixtures only; no test keys are stored or registered with GMGN.
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { createGmgnKeyVault, verifyGmgnKeyVault } from "./gmgnKeyVault";
const fixtureSecret = "OFFLINE_SYNTHETIC_ENCRYPTION_FIXTURE_NOT_A_SERVER_SECRET_123456";
test("encrypted roundtrip yields a valid Ed25519 public key and never stores plaintext private PEM", () => {
  const vault = createGmgnKeyVault(fixtureSecret);
  assert.equal(verifyGmgnKeyVault(JSON.parse(JSON.stringify(vault)), fixtureSecret), vault.publicPem);
  assert.equal(createPublicKey(vault.publicPem).asymmetricKeyType, "ed25519");
  assert.equal(JSON.stringify(vault).includes("BEGIN PRIVATE KEY"), false);
});
test("wrong encryption secret or modified ciphertext/metadata fails closed", () => {
  const vault = createGmgnKeyVault(fixtureSecret);
  assert.throws(() => verifyGmgnKeyVault(vault, `${fixtureSecret}different`));
  const bytes = Buffer.from(vault.ciphertextB64, "base64"); bytes[0] ^= 1;
  assert.throws(() => verifyGmgnKeyVault({ ...vault, ciphertextB64: bytes.toString("base64") }, fixtureSecret));
  const other = createGmgnKeyVault(fixtureSecret);
  assert.throws(() => verifyGmgnKeyVault({ ...vault, publicPem: other.publicPem }, fixtureSecret));
});
test("malformed vaults and missing/short encryption secrets cannot produce usable keys", () => {
  assert.throws(() => createGmgnKeyVault(""));
  assert.throws(() => verifyGmgnKeyVault({}, fixtureSecret));
  const vault = createGmgnKeyVault(fixtureSecret);
  assert.throws(() => verifyGmgnKeyVault({ ...vault, ivB64: "invalid" }, fixtureSecret));
});
