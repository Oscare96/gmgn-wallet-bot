import { createHash } from "node:crypto";
import { readNumber, readTimestamp, unwrapData } from "./gmgnCli";

export type ObservedActivity = {
  identity: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  side: "buy" | "sell";
  observedAt: Date;
  txHash: string;
  tokenAmount: number | null;
  raw: Record<string, unknown>;
};

export function activityPage(value: unknown): {
  activities: Record<string, unknown>[];
  next: string | null;
} {
  const data = unwrapData(value);
  if (!Array.isArray(data.activities)) {
    throw new Error("Unsupported activity response schema");
  }
  const cursor = data.next;
  if (cursor != null && typeof cursor !== "string") {
    throw new Error("Unsupported pagination cursor schema");
  }
  return {
    activities: data.activities.filter(
      (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
    ),
    next: typeof cursor === "string" && cursor ? cursor : null,
  };
}

export function normalizeActivity(wallet: string, row: Record<string, unknown>): ObservedActivity | null {
  const token = row.token && typeof row.token === "object"
    ? row.token as Record<string, unknown>
    : {};
  const side = row.event_type ?? row.type;
  if (side !== "buy" && side !== "sell") return null;
  const tokenAddress = typeof token.address === "string" ? token.address : "";
  const txHash = typeof row.tx_hash === "string" ? row.tx_hash : "";
  const observedAt = readTimestamp(row.timestamp);
  if (!tokenAddress || !txHash || !observedAt) return null;
  // The public activity schema supplies no documented log/event index.
  // Use transaction + wallet + token + side + timestamp + exact quantity as a
  // conservative identity, and block execution until event identity is verified.
  const identityInput = JSON.stringify([
    "sol", wallet, txHash, tokenAddress, side, row.timestamp, row.token_amount,
  ]);
  return {
    identity: createHash("sha256").update(identityInput).digest("hex"),
    tokenAddress,
    tokenSymbol: typeof token.symbol === "string" ? token.symbol.slice(0, 32) : null,
    side,
    observedAt,
    txHash,
    tokenAmount: readNumber(row.token_amount),
    raw: row,
  };
}
