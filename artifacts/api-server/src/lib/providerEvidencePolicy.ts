import { createHash } from "node:crypto";
import { activityPage } from "./gmgnActivity";
import { readNumber, readTimestamp, unwrapData } from "./gmgnCli";
import { tokenTraders, trendingTokens } from "./discoveryPolicy";

export const OFFICIAL_HISTORY_TOKEN = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
export const EVIDENCE_LIMITATIONS: Record<string, string> = {
  trending: "Current filtered trending tokens only; not trending wallets or a historical-as-of universe. Losing, inactive and disappeared populations are not complete.",
  traders: "Current top traders of one trending token, used solely as a coverage sample. Never used to pick past winners or enroll a wallet.",
  activity: "At most two 10-record pages from one current sampled wallet. No exhaustive history, availability times, unique event indices or pre-test inventory verified.",
  candles: "Dated USD OHLC observations for the official documentation's example token, not strategy-selected tokens. Not quotes, spread, depth, historical security or proof of sellability; no interpolation over gaps.",
  security: "Current token security only; no dated historical-as-of option. These observations cannot be applied to past entries.",
  pool: "Current pool evidence only; no dated historical-as-of option. Volume and candle amount are never treated as liquidity.",
  info: "Current token information only. Receipt time does not establish upstream price freshness or an executable quote.",
  quote: "A read-only quote sample is not an executable fill or approved budget. The official pinned client's quoteOrder method uses API-key-only GET auth; the CLI frontend incorrectly requires a signing key. No signer is supplied. Upstream freshness, fees, USD conversion, depth and user execution-wallet suitability remain unverified.",
  whole_strategy: "BLOCKED: no historical-as-of discovery universe including losses/failures, historical security/liquidity/execution evidence, complete events/inventory, approved chronological periods/frozen rules, or validated whole-strategy replay adapter. No historical performance exists.",
};

export function redactProviderEvidence(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new Error("Provider structure too deep.");
  if (Array.isArray(value)) return value.map((x) => redactProviderEvidence(x, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
      return !/apikey|privatekey|secret|password|authorization|accesstoken|refreshtoken|signature|requestheaders/.test(normalized);
    }).map(([key, item]) => [key, redactProviderEvidence(item, depth + 1)]));
  }
  if (typeof value === "string" && /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----|Bearer\s+\S+|(?:GMGN_API_KEY|api[_-]?key)\s*[=:]/i.test(value)) return "[REDACTED]";
  return value;
}

export function providerPayloadHash(payload: Record<string, unknown>) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

export function candleRecords(value: unknown, from: Date, to: Date) {
  const root = unwrapData(value);
  if (!Array.isArray(root.list)) throw new Error("Expected candle data.list.");
  const seen = new Set<number>();
  const rows = root.list.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid candle.");
    const row = item as Record<string, unknown>;
    const at = readTimestamp(row.time);
    const prices = ["open", "high", "low", "close"].map((key) => readNumber(row[key]));
    if (!at || at < from || at >= to || at.getTime() % 60_000 !== 0 || seen.has(at.getTime()) ||
      prices.some((p) => p == null || p <= 0)) throw new Error("Unsupported, duplicate or out-of-window candle.");
    if (prices[1]! < Math.max(prices[0]!, prices[2]!, prices[3]!) || prices[2]! > Math.min(prices[0]!, prices[1]!, prices[3]!)) throw new Error("Invalid OHLC bounds.");
    seen.add(at.getTime());
    return row;
  });
  return rows.sort((a, b) => readTimestamp(a.time)!.getTime() - readTimestamp(b.time)!.getTime());
}

export function summarizeProviderData(source: string, value: unknown, from?: Date, to?: Date) {
  const root = unwrapData(value);
  let rows: Record<string, unknown>[];
  let cursor: string | null = null;
  if (source === "trending") rows = trendingTokens(value);
  else if (source === "traders") rows = tokenTraders(value);
  else if (source === "activity") {
    const page = activityPage(value);
    rows = page.activities; cursor = page.next;
  } else if (source === "candles") {
    if (!from || !to) throw new Error("Explicit closed candle window required.");
    rows = candleRecords(value, from, to);
  } else if (source === "quote") {
    if (!["input_amount", "output_amount", "min_output_amount"].every((k) => typeof root[k] === "string" && /^\d+$/.test(root[k] as string))) throw new Error("Unsupported quote amount schema.");
    if (BigInt(root.input_amount as string) <= 0n || BigInt(root.output_amount as string) <= 0n ||
      BigInt(root.min_output_amount as string) > BigInt(root.output_amount as string)) throw new Error("Invalid quote amounts.");
    rows = [root];
  } else {
    if (!Object.keys(root).length) throw new Error("Empty unsupported provider object.");
    rows = [root];
  }
  const times = rows.map((r) => readTimestamp(source === "candles" ? r.time : r.timestamp)).filter((t): t is Date => t != null);
  const stamps = times.map((t) => t.getTime());
  return {
    rows, cursor, recordCount: rows.length,
    returnedFrom: stamps.length ? new Date(Math.min(...stamps)) : null,
    returnedTo: stamps.length ? new Date(Math.max(...stamps)) : null,
    fields: [...new Set(rows.flatMap((r) => Object.keys(r)))].sort(),
    missingCandles: source === "candles" && from && to ? Math.max(0, (to.getTime() - from.getTime()) / 60_000 - rows.length) : null,
    timestampUnits: source === "candles" && rows.length ? (Number(rows[0].time) > 10_000_000_000 ? "milliseconds" : "seconds") : null,
  };
}

export function historicalPriceProbeWindows(now: Date) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Small, separate probes, not a selected backtest split or a claim of continuous coverage.
  return [1, 7].map((days) => ({ from: new Date(midnight - days * 86_400_000 + 12 * 3_600_000),
    to: new Date(midnight - days * 86_400_000 + 13 * 3_600_000) }));
}
