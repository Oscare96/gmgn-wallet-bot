import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";

const CONTEXT = "gmgn-api-ed25519-registration-vault-v1";
export type GmgnKeyVault = {
  version: 1; algorithm: "AES-256-GCM"; privateFormat: "pkcs8-der";
  createdAt: string; publicPem: string; saltB64: string; ivB64: string; tagB64: string; ciphertextB64: string;
};
function encryptionKey(secret: string, salt: Buffer) {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Server encryption secret must contain at least 32 bytes.");
  return Buffer.from(hkdfSync("sha256", secret, salt, CONTEXT, 32));
}
function aad(v: GmgnKeyVault) {
  return Buffer.from(JSON.stringify({ context: CONTEXT, version: v.version, algorithm: v.algorithm,
    privateFormat: v.privateFormat, createdAt: v.createdAt, publicPem: v.publicPem }), "utf8");
}
function decode(value: string, expectedLength?: number) {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid encrypted vault.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (expectedLength != null && bytes.length !== expectedLength)) throw new Error("Invalid encrypted vault.");
  return bytes;
}
export function createGmgnKeyVault(secret: string): GmgnKeyVault {
  const salt = randomBytes(32), iv = randomBytes(12), key = encryptionKey(secret, salt);
  const pair = generateKeyPairSync("ed25519");
  const privateBytes = pair.privateKey.export({ type: "pkcs8", format: "der" });
  try {
    const vault: GmgnKeyVault = { version: 1, algorithm: "AES-256-GCM", privateFormat: "pkcs8-der",
      createdAt: new Date().toISOString(), publicPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      saltB64: salt.toString("base64"), ivB64: iv.toString("base64"), tagB64: "", ciphertextB64: "" };
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(vault));
    vault.ciphertextB64 = Buffer.concat([cipher.update(privateBytes), cipher.final()]).toString("base64");
    vault.tagB64 = cipher.getAuthTag().toString("base64");
    return vault;
  } finally { key.fill(0); privateBytes.fill(0); }
}
/** In-memory verification only. Never returns or logs private key material. */
export function verifyGmgnKeyVault(input: unknown, secret: string): string {
  if (!input || typeof input !== "object") throw new Error("Invalid encrypted vault.");
  const v = input as GmgnKeyVault;
  if (v.version !== 1 || v.algorithm !== "AES-256-GCM" || v.privateFormat !== "pkcs8-der" ||
    typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt)) ||
    typeof v.publicPem !== "string" || v.publicPem.length > 256) throw new Error("Invalid encrypted vault.");
  const key = encryptionKey(secret, decode(v.saltB64, 32));
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decode(v.ivB64, 12));
    decipher.setAAD(aad(v)); decipher.setAuthTag(decode(v.tagB64, 16));
    plaintext = Buffer.concat([decipher.update(decode(v.ciphertextB64)), decipher.final()]);
    const privateKey = createPrivateKey({ key: plaintext, type: "pkcs8", format: "der" });
    const publicKey = createPublicKey(privateKey);
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.export({ type: "spki", format: "pem" }).toString() !== v.publicPem) throw new Error("Keypair verification failed.");
    const message = Buffer.from("GMGN keypair local self-test only; not an API request or trade.", "utf8");
    if (!verify(null, message, publicKey, sign(null, message, privateKey))) throw new Error("Keypair verification failed.");
    return v.publicPem;
  } finally { key.fill(0); plaintext?.fill(0); }
}
