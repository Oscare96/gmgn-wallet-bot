/**
 * Internal staged paper ledger. No network/order operations or HTTP entry point.
 * The worker intentionally does not call this until a genuine quote/event adapter
 * is validated. This normalized contract is NOT an invented GMGN response schema.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, gmgnSettings, gmgnWallets, gmgnSignals, gmgnPositions, gmgnTrades, gmgnEquityPoints } from "@workspace/db";
import { chicagoDay } from "./discoveryPolicy";

const M = 10n ** 12n, Q = 10n ** 18n, BPS = 10_000n * M;
export function paperUnits(value: string, places = 12): bigint {
  if (!/^-?\d+(?:\.\d+)?$/.test(value) || value.length > 65) throw new Error("Invalid ledger decimal.");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (fraction.length > places) throw new Error("Ledger precision exceeded.");
  const n = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0");
  return negative ? -n : n;
}
export function paperDecimal(value: bigint, places = 12): string {
  const sign = value < 0 ? "-" : "", n = value < 0 ? -value : value, scale = 10n ** BigInt(places);
  const fraction = (n % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return `${sign}${n / scale}${fraction ? `.${fraction}` : ""}`;
}
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
export type ValidatedPaperObservation = {
  priceUsd: string; upstreamAt: Date; receivedAt: Date;
  quoteVerified: boolean; canonicalEventVerified: boolean;
  securityVerified: boolean; liquidityUsd: string | null; topHolderPct: string | null;
  payloadHash: string;
};
export type PaperCommit = {
  userId: string; signalId: string; mode: string;
  quote: ValidatedPaperObservation | null;
  // Known leader inventory immediately before the sale, not current holdings.
  leaderSold?: string; leaderPreSellInventory?: string; leaderInventoryVerified?: boolean;
};
export type PaperCommitResult = { status: "filled" | "blocked" | "duplicate"; reason: string };

export async function commitPaperFill(
  input: PaperCommit, now = new Date(), store: Pick<typeof db, "transaction"> = db,
): Promise<PaperCommitResult> {
  if (input.mode !== "paper") return { status: "blocked", reason: "Live execution is unavailable." };
  return store.transaction(async tx => {
    // Serialize the entire owner ledger, including different leaders/signals.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.userId}), 91200346)`);
    const [settings] = await tx.select().from(gmgnSettings).where(eq(gmgnSettings.userId, input.userId)).for("update");
    const [signal] = await tx.select().from(gmgnSignals).where(and(eq(gmgnSignals.userId, input.userId), eq(gmgnSignals.id, input.signalId))).for("update");
    if (!signal) return { status: "blocked", reason: "Owned signal not found." };
    const previous = await tx.select().from(gmgnTrades).where(and(eq(gmgnTrades.userId, input.userId), eq(gmgnTrades.signalId, signal.id)));
    if (previous.length) return { status: "duplicate", reason: "This signal already has a paper fill." };
    const block = async (reason: string): Promise<PaperCommitResult> => {
      // Never convert a historical baseline or previously rejected decision to a fill.
      if (signal.status === "pending") await tx.update(gmgnSignals).set({ status: "skipped", reason }).where(eq(gmgnSignals.id, signal.id));
      return { status: "blocked", reason };
    };
    if (signal.status !== "pending") return block("Only a new pending signal can be processed; historical/rejected signals cannot replay.");
    if (!settings?.setupComplete || settings.paused || settings.fullStopped) return block("Paper setup is incomplete or monitoring is paused/full-stopped.");
    if (!["buy", "sell"].includes(signal.side)) return block("Unsupported signal side.");
    const [wallet] = await tx.select().from(gmgnWallets).where(and(eq(gmgnWallets.userId, input.userId), eq(gmgnWallets.address, signal.walletAddress)));
    if (!wallet?.enabled || !wallet.baselineComplete) return block("Leader is disabled or historical baseline is incomplete.");
    const quote = input.quote, t = now.getTime(), detected = signal.detectionAt.getTime();
    if (!Number.isFinite(t) || signal.observedAt.getTime() > t || t - signal.observedAt.getTime() > settings.maxSignalAgeSeconds * 1000) return block("Signal is stale or future-dated.");
    if (!quote?.quoteVerified || !quote.canonicalEventVerified || !/^[a-f0-9]{64}$/.test(quote.payloadHash)) return block("Verified execution quote and canonical event evidence are missing.");
    if (![quote.upstreamAt.getTime(), quote.receivedAt.getTime(), detected].every(Number.isFinite) ||
        quote.upstreamAt.getTime() < detected || quote.receivedAt < quote.upstreamAt ||
        quote.receivedAt.getTime() > t || t - quote.upstreamAt.getTime() > 15_000 ||
        t < detected + settings.latencyMs) return block("Quote is missing, stale, pre-detection or before the configured execution delay.");
    const price = paperUnits(quote.priceUsd), feeBps = paperUnits(settings.feeBps), slipBps = paperUnits(settings.slippageBps);
    if (price <= 0n || feeBps < 0n || feeBps > BPS || slipBps < 0n || slipBps >= BPS) return block("Invalid price or fee/slippage assumptions.");
    const positions = await tx.select().from(gmgnPositions).where(eq(gmgnPositions.userId, input.userId));
    const trades = await tx.select().from(gmgnTrades).where(eq(gmgnTrades.userId, input.userId));
    const today = trades.filter(x => chicagoDay(x.filledAt) === chicagoDay(now));
    let cash = paperUnits(settings.paperCashUsd), quantity: bigint, notional: bigint, fee: bigint, realized: bigint | null = null;
    const fillPrice = signal.side === "buy" ? ceil(price * (BPS + slipBps), BPS) : price * (BPS - slipBps) / BPS;
    if (fillPrice <= 0n) return block("Slippage leaves no positive fill price.");
    const matching = positions.find(p => p.tokenAddress === signal.tokenAddress && p.leaderAddress === signal.walletAddress && paperUnits(p.quantity, 18) > 0n);
    if (signal.side === "buy") {
      if (settings.buysHalted) return block("New buys are halted; attributable sells remain permitted.");
      if (!quote.securityVerified || quote.liquidityUsd === null || quote.topHolderPct === null ||
          paperUnits(quote.liquidityUsd) < paperUnits(settings.minLiquidityUsd) ||
          paperUnits(quote.topHolderPct) < 0n || paperUnits(quote.topHolderPct) > paperUnits(settings.maxTopHolderPct)) return block("Missing or failing liquidity/security/concentration evidence.");
      if (positions.some(p => p.tokenAddress === signal.tokenAddress && paperUnits(p.quantity, 18) > 0n)) return block("This token already has an open paper position, including other leaders.");
      const open = positions.filter(p => paperUnits(p.quantity, 18) > 0n);
      if (open.length >= settings.maxOpenPositions || today.length >= settings.maxTradesPerDay) return block("Position or daily trade cap reached.");
      const loss = today.reduce((a, p) => a + paperUnits(p.realizedPnlUsd ?? "0"), 0n), cutoff = paperUnits(settings.dailyLossCutoffUsd);
      if (cutoff > 0n && loss <= -cutoff) return block("Daily realized-loss cutoff reached.");
      const budget = paperUnits(wallet.buyBudgetUsd) < paperUnits(settings.maxBuyUsd) ? paperUnits(wallet.buyBudgetUsd) : paperUnits(settings.maxBuyUsd);
      if (budget <= 0n) return block("A positive reviewed leader budget is required.");
      // Unknown/stale marks cannot silently understate exposure.
      if (open.some(p => !p.priceObservedAt || t - p.priceObservedAt.getTime() > 15_000 || p.priceObservedAt > now || !p.markPriceUsd)) return block("Fresh exposure marks for existing positions are missing.");
      const exposure = open.reduce((a, p) => {
        const marked = paperUnits(p.quantity, 18) * paperUnits(p.markPriceUsd!) / Q, cost = paperUnits(p.costBasisUsd);
        return a + (marked > cost ? marked : cost);
      }, 0n);
      quantity = budget * Q / fillPrice;
      notional = quantity * fillPrice / Q; fee = ceil(notional * feeBps, BPS);
      if (quantity <= 0n || cash < notional + fee) return block("Insufficient paper cash including fees, or unrepresentable quantity.");
      if (exposure + notional + fee > paperUnits(settings.totalExposureUsd)) return block("Total exposure cap including entry fees would be exceeded.");
      cash -= notional + fee;
      await tx.insert(gmgnPositions).values({
        userId: input.userId, tokenAddress: signal.tokenAddress, tokenSymbol: signal.tokenSymbol,
        leaderAddress: signal.walletAddress, leaderLabel: signal.walletLabel,
        quantity: paperDecimal(quantity, 18), costBasisUsd: paperDecimal(notional + fee),
        markPriceUsd: quote.priceUsd, priceObservedAt: quote.upstreamAt, openedAt: now,
      });
    } else {
      if (!settings.followSells) return block("Sell following is disabled.");
      if (!matching || !input.leaderInventoryVerified || !input.leaderSold || !input.leaderPreSellInventory) return block("Attributable paper position or verified leader pre-sale inventory is missing.");
      const sold = paperUnits(input.leaderSold, 18), inventory = paperUnits(input.leaderPreSellInventory, 18);
      if (sold <= 0n || inventory <= 0n || sold > inventory) return block("Invalid proportional leader sale.");
      const held = paperUnits(matching.quantity, 18), cost = paperUnits(matching.costBasisUsd);
      quantity = held * sold / inventory;
      if (quantity <= 0n || quantity > held) return block("Unrepresentable sale or overselling rejected.");
      notional = quantity * fillPrice / Q; fee = ceil(notional * feeBps, BPS);
      const allocatedCost = quantity === held ? cost : cost * quantity / held;
      realized = notional - fee - allocatedCost; cash += notional - fee;
      if (quantity === held) await tx.delete(gmgnPositions).where(eq(gmgnPositions.id, matching.id));
      else await tx.update(gmgnPositions).set({
        quantity: paperDecimal(held - quantity, 18), costBasisUsd: paperDecimal(cost - allocatedCost),
        markPriceUsd: quote.priceUsd, priceObservedAt: quote.upstreamAt,
      }).where(eq(gmgnPositions.id, matching.id));
    }
    const slippageCost = quantity * (signal.side === "buy" ? fillPrice - price : price - fillPrice) / Q;
    await tx.update(gmgnSettings).set({ paperCashUsd: paperDecimal(cash), updatedAt: now }).where(eq(gmgnSettings.userId, input.userId));
    await tx.insert(gmgnTrades).values({
      userId: input.userId, signalId: signal.id, tokenAddress: signal.tokenAddress, tokenSymbol: signal.tokenSymbol,
      leaderAddress: signal.walletAddress, side: signal.side, quantity: paperDecimal(quantity, 18),
      priceUsd: paperDecimal(fillPrice), notionalUsd: paperDecimal(notional), feeUsd: paperDecimal(fee),
      slippageUsd: paperDecimal(slippageCost), realizedPnlUsd: realized === null ? null : paperDecimal(realized),
      simulated: true, filledAt: now,
    });
    await tx.update(gmgnSignals).set({
      status: "filled", reason: "Simulated paper fill after validated post-detection quote; not a guaranteed executable order.",
      priceUsd: quote.priceUsd, priceObservedAt: quote.upstreamAt,
      rawProvenance: { ...(signal.rawProvenance as Record<string, unknown>), paperQuote: { payloadHash: quote.payloadHash,
        upstreamAt: quote.upstreamAt.toISOString(), receivedAt: quote.receivedAt.toISOString(),
        feeBps: settings.feeBps, slippageBps: settings.slippageBps, latencyMs: settings.latencyMs, simulated: true } },
    }).where(eq(gmgnSignals.id, signal.id));
    const after = await tx.select().from(gmgnPositions).where(eq(gmgnPositions.userId, input.userId));
    if (after.every(p => p.markPriceUsd && p.priceObservedAt && p.priceObservedAt <= now && t - p.priceObservedAt.getTime() <= 15_000)) {
      const equity = after.reduce((a, p) => a + paperUnits(p.quantity, 18) * paperUnits(p.markPriceUsd!) / Q, cash);
      await tx.insert(gmgnEquityPoints).values({ userId: input.userId, equityUsd: paperDecimal(equity), createdAt: now });
    }
    // Unvalued positions stay open; never persist a fabricated zero or stale equity.
    return { status: "filled", reason: "Simulated paper ledger committed atomically." };
  });
}
