/**
 * Prints only public PEM and the official CLI-style registration link.
 * Reuses an existing encrypted key; never overwrites it on errors.
 * No GMGN requests, app configuration, orders or live-mode changes.
 */
import { Storage } from "@google-cloud/storage";
import { createGmgnKeyVault, verifyGmgnKeyVault } from "./gmgnKeyVault";

let stage = "checking server configuration";
async function main() {
  const secret = process.env.SESSION_SECRET;
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!secret || !privateDir) throw new Error("Required server configuration is absent.");
  const normalize = (v: string) => v.trim().replace(/^gs:\/\//, "").replace(/^\/+|\/+$/g, "");
  const dir = normalize(privateDir);
  const [bucketName, ...parts] = dir.split("/");
  if (!bucketName || !parts.length || parts.some((p) => !p || p === "." || p === "..")) throw new Error("Invalid private object directory.");
  for (const p of (process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "").split(",").filter(Boolean).map(normalize)) {
    if (dir === p || dir.startsWith(`${p}/`)) throw new Error("Private key storage overlaps a public search path.");
  }
  const storage = new Storage({ credentials: {
    audience: "replit", subject_token_type: "access_token", token_url: "http://127.0.0.1:1106/token",
    type: "external_account", credential_source: { url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" } }, universe_domain: "googleapis.com",
  }, projectId: "" });
  const file = storage.bucket(bucketName).file(`${parts.join("/")}/gmgn-auth/ed25519.vault.json`);
  stage = "checking encrypted storage";
  const [exists] = await file.exists();
  if (!exists) {
    const vault = createGmgnKeyVault(secret);
    verifyGmgnKeyVault(vault, secret);
    stage = "saving encrypted key";
    await file.save(Buffer.from(JSON.stringify(vault)), { resumable: false, contentType: "application/json",
      metadata: { cacheControl: "private, no-store", metadata: { purpose: "gmgn-api-key-registration", visibility: "private" } },
      preconditionOpts: { ifGenerationMatch: 0 } });
  }
  stage = "verifying persisted encrypted key";
  const [bytes] = await file.download();
  if (bytes.length > 8192) throw new Error("Encrypted vault exceeds the allowed size.");
  const publicPem = verifyGmgnKeyVault(JSON.parse(bytes.toString("utf8")), secret);
  // Public output is withheld until durable read-back and keypair self-test succeed.
  console.log(publicPem.trimEnd());
  console.log(`Registration link: https://gmgn.ai/ai?pbk=${encodeURIComponent(publicPem)}`);
  console.log("Verified: encrypted private App Storage read-back and local Ed25519 sign/verify.");
  console.log("Private key never written as a plaintext file or printed. No live trading enabled.");
}
main().catch(() => {
  // Do not print upstream errors, credentials, ciphertext or secret material.
  console.error(`GMGN key setup failed while ${stage}. No public key should be registered until this succeeds. Existing encrypted keys are not overwritten.`);
  process.exitCode = 1;
});
