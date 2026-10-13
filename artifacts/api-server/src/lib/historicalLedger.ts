/**
 * Offline, exact-decimal accounting kernel. NOT a whole-strategy backtest adapter.
 * The HTTP backtest path never invokes this while historical coverage/selection replay is unvalidated.
 */
import { chicagoDay } from "./discoveryPolicy";
import type { HistoricalQuote } from "./backtestPolicy";
const MONEY = 10n ** 12n, QUANTITY = 10n ** 18n, BPS = 100_000_000n;
function units(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Use a nonnegative plain decimal.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Decimal precision exceeds ledger scale.");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}
function decimal(value: bigint, decimals = 12): string {
  const sign = value < 0 ? "-" : "", n = value < 0 ? -value : value, scale = 10n ** BigInt(decimals);
  return `${sign}${n / scale}.${(n % scale).toString().padStart(decimals, "0")}`.replace(/\.?0+$/, "");
}
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
export type HistoricalLedgerRisk = {
  setupComplete: boolean; buysHalted: boolean; fullStopped: boolean;
  maxBuyUsd: string; totalExposureUsd: string; minLiquidityUsd: string; dailyLossCutoffUsd: string;
  maxOpenPositions: number; maxTradesPerDay: number; maxSignalAgeMs: number; maxQuoteAgeMs: number; delayMs: number;
  feeBps: string; slippageBps: string;
};
type Position = { leader: string; token: string; quantity: bigint; cost: bigint; accumulatedRealized: bigint };
type Signal = { identity: string; leader: string; token: string; signalAt: number; detectedAt: number };
export class HistoricalLedger {
  private cash: bigint;
  private readonly initial: bigint;
  private positions = new Map<string, Position>();
  private seen = new Set<string>();
  private dailyTrades = new Map<string, number>();
  private dailyRealized = new Map<string, bigint>();
  private roundtrips: bigint[] = [];
  private lastFillAt = -Infinity;
  constructor(initialCashUsd: string, private readonly risk: HistoricalLedgerRisk) {
    this.cash = this.initial = units(initialCashUsd, 12);
    if (units(risk.feeBps, 4) > BPS || units(risk.slippageBps, 4) >= BPS) throw new Error("Invalid fee/slippage assumptions.");
    if (![risk.maxOpenPositions, risk.maxTradesPerDay].every((n) => Number.isInteger(n) && n > 0)) throw new Error("Invalid position/trade caps.");
    if (![risk.maxSignalAgeMs, risk.maxQuoteAgeMs, risk.delayMs].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("Invalid timing assumptions.");
  }
  snapshot() {
    return { cashUsd: decimal(this.cash), positions: [...this.positions.values()].map((p) => ({
      leader: p.leader, token: p.token, quantity: decimal(p.quantity, 18), costUsd: decimal(p.cost),
    })), closedRoundtrips: this.roundtrips.length };
  }
  private check(signal: Signal, quote: HistoricalQuote | null, side: "buy" | "sell"): string | null {
    if (this.risk.fullStopped) return "full_stop";
    if (this.seen.has(signal.identity)) return "duplicate_event";
    this.seen.add(signal.identity); // A rejected signal cannot be retrospectively retried after seeing future outcomes.
    if (!quote || quote.token !== signal.token) return "missing_quote";
    if (!Number.isFinite(signal.signalAt) || !Number.isFinite(signal.detectedAt) ||
      signal.detectedAt < signal.signalAt || signal.detectedAt - signal.signalAt > this.risk.maxSignalAgeMs) return "stale_signal";
    if (![quote.observedAt, quote.availableAt].every(Number.isFinite) || quote.observedAt < signal.detectedAt + this.risk.delayMs ||
      quote.availableAt < quote.observedAt || quote.availableAt - quote.observedAt > this.risk.maxQuoteAgeMs ||
      quote.availableAt - signal.signalAt > this.risk.maxSignalAgeMs) return "stale_or_pre_detection_quote";
    if (quote.availableAt < this.lastFillAt) return "non_chronological_fill";
    if (quote.source === "candle_close" && (quote.candleEndAt == null || quote.observedAt < quote.candleEndAt || quote.availableAt < quote.candleEndAt)) return "candle_lookahead";
    if (units(quote.priceUsd, 12) <= 0n) return "missing_price";
    if (side === "buy") {
      if (!quote.buyExecutable || quote.securityPassed !== true || quote.liquidityUsd === null ||
        units(quote.liquidityUsd, 12) < units(this.risk.minLiquidityUsd, 12)) return "missing_or_failed_security_liquidity";
    } else if (!quote.sellExecutable) return "unsellable_no_invented_exit";
    return null;
  }
  buy(signal: Signal, quote: HistoricalQuote | null, amountUsd: string) {
    const blocked = this.check(signal, quote, "buy");
    if (blocked) return { filled: false, reason: blocked };
    if (!this.risk.setupComplete || this.risk.buysHalted) return { filled: false, reason: "buys_not_approved_or_halted" };
    if (this.positions.has(signal.token)) return { filled: false, reason: "overlapping_token_entry" };
    const amount = units(amountUsd, 12);
    if (amount <= 0n || amount > units(this.risk.maxBuyUsd, 12)) return { filled: false, reason: "per_buy_cap" };
    const day = chicagoDay(new Date(quote!.availableAt));
    if (this.positions.size >= this.risk.maxOpenPositions) return { filled: false, reason: "position_cap" };
    if ((this.dailyTrades.get(day) ?? 0) >= this.risk.maxTradesPerDay) return { filled: false, reason: "daily_trade_cap" };
    const cutoff = units(this.risk.dailyLossCutoffUsd, 12);
    if (cutoff > 0n && (this.dailyRealized.get(day) ?? 0n) <= -cutoff) return { filled: false, reason: "daily_realized_loss_cutoff" };
    const price = units(quote!.priceUsd, 12), impact = units(this.risk.slippageBps, 4), feeRate = units(this.risk.feeBps, 4);
    const fillPrice = ceil(price * (BPS + impact), BPS);
    const quantity = amount * QUANTITY / fillPrice;
    if (quantity === 0n) return { filled: false, reason: "quantity_rounds_to_zero" };
    const notional = ceil(quantity * fillPrice, QUANTITY), fee = ceil(notional * feeRate, BPS), spent = notional + fee;
    const exposure = [...this.positions.values()].reduce((sum, p) => sum + p.cost, 0n);
    if (spent > this.cash) return { filled: false, reason: "cash_cap_including_fees" };
    if (exposure + spent > units(this.risk.totalExposureUsd, 12)) return { filled: false, reason: "exposure_cap_including_fees" };
    this.cash -= spent;
    this.lastFillAt = quote!.availableAt;
    this.positions.set(signal.token, { token: signal.token, leader: signal.leader, quantity, cost: spent, accumulatedRealized: 0n });
    this.seen.add(signal.identity); this.dailyTrades.set(day, (this.dailyTrades.get(day) ?? 0) + 1);
    return { filled: true, reason: "explicit_simulated_fill", quantity: decimal(quantity, 18), feeUsd: decimal(fee),
      slippageUsd: decimal(ceil(quantity * (fillPrice - price), QUANTITY)), filledAt: quote!.availableAt };
  }
  proportionalSell(signal: Signal, quote: HistoricalQuote | null, fraction: string) {
    const blocked = this.check(signal, quote, "sell");
    if (blocked) return { filled: false, reason: blocked };
    const position = this.positions.get(signal.token);
    if (!position || position.leader !== signal.leader) return { filled: false, reason: "no_attributable_position" };
    const part = units(fraction, 18);
    if (part <= 0n || part > QUANTITY) return { filled: false, reason: "invalid_leader_sell_fraction" };
    const quantity = position.quantity * part / QUANTITY;
    if (quantity === 0n) return { filled: false, reason: "quantity_rounds_to_zero" };
    const price = units(quote!.priceUsd, 12), fillPrice = price * (BPS - units(this.risk.slippageBps, 4)) / BPS;
    if (fillPrice <= 0n) return { filled: false, reason: "price_rounds_to_zero" };
    const proceeds = quantity * fillPrice / QUANTITY, fee = ceil(proceeds * units(this.risk.feeBps, 4), BPS);
    const cost = quantity === position.quantity ? position.cost : position.cost * quantity / position.quantity;
    const realized = proceeds - fee - cost;
    this.cash += proceeds - fee; position.quantity -= quantity; position.cost -= cost; position.accumulatedRealized += realized;
    this.lastFillAt = quote!.availableAt;
    if (!position.quantity) { this.roundtrips.push(position.accumulatedRealized); this.positions.delete(signal.token); }
    const day = chicagoDay(new Date(quote!.availableAt));
    this.dailyRealized.set(day, (this.dailyRealized.get(day) ?? 0n) + realized);
    // Buy halts, entry caps and entry liquidity/security filters cannot suppress an otherwise executable exit.
    this.seen.add(signal.identity); this.dailyTrades.set(day, (this.dailyTrades.get(day) ?? 0) + 1);
    return { filled: true, reason: "explicit_simulated_exit", quantity: decimal(quantity, 18),
      realizedPnlUsd: decimal(realized), feeUsd: decimal(fee), filledAt: quote!.availableAt };
  }
  terminalLiquidationEquity(quotes: HistoricalQuote[], endAt: number): string | null {
    let equity = this.cash;
    for (const position of this.positions.values()) {
      const q = quotes.filter((q) => q.token === position.token && q.availableAt <= endAt && q.observedAt <= q.availableAt &&
        endAt - q.observedAt <= this.risk.maxQuoteAgeMs && q.sellExecutable &&
        (q.source !== "candle_close" || (q.candleEndAt != null && q.availableAt >= q.candleEndAt)))
        .sort((a, b) => b.availableAt - a.availableAt)[0];
      if (!q || units(q.priceUsd, 12) <= 0n) return null;
      const price = units(q.priceUsd, 12) * (BPS - units(this.risk.slippageBps, 4)) / BPS;
      const proceeds = position.quantity * price / QUANTITY;
      equity += proceeds - ceil(proceeds * units(this.risk.feeBps, 4), BPS);
    }
    return decimal(equity);
  }
  closedMetrics() {
    const wins = this.roundtrips.filter((p) => p > 0n), losses = this.roundtrips.filter((p) => p < 0n);
    const gains = wins.reduce((sum, p) => sum + p, 0n), loss = -losses.reduce((sum, p) => sum + p, 0n);
    return { closedRoundtrips: this.roundtrips.length,
      winRatePct: this.roundtrips.length ? 100 * wins.length / this.roundtrips.length : null,
      profitFactor: loss > 0n ? Number(gains) / Number(loss) : null,
      // Open or unvalued positions prevent a full-strategy return claim.
      netReturnAfterCostsPct: !this.positions.size && this.initial > 0n ? 100 * Number(this.cash - this.initial) / Number(this.initial) : null };
  }
}
