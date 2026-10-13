export const LIVE_TRADING_ENABLED = false as const;

export type PaperRisk = {
  setupComplete: boolean;
  buysHalted: boolean;
  maxBuyUsd: number;
  totalExposureUsd: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxSignalAgeSeconds: number;
  minLiquidityUsd: number;
  maxTopHolderPct: number;
  dailyLossCutoffUsd: number;
};

export type PaperMarketObservation = {
  priceUsd: number | null;
  observedAt: number;
  liquidityUsd: number | null;
  topHolderPct: number | null;
  poolAddress: string | null;
  securityEvidence: boolean;
};

export type PaperAccount = {
  cashUsd: number;
  exposureUsd: number;
  openPositions: number;
  tradesToday: number;
  dailyRealizedPnlUsd: number;
};

export type Fill = {
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  slippageUsd: number;
  cashDeltaUsd: number;
};

export function roundDecimal(value: number, places = 12): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** places;
  return Math.trunc(value * scale) / scale;
}

export function buyBlockReason(
  risk: PaperRisk,
  market: PaperMarketObservation,
  account: PaperAccount,
  signalAt: number,
  now: number,
  plannedBuyUsd = risk.maxBuyUsd,
): string | null {
  if (!risk.setupComplete) return "Complete the risk and paper-cash setup first.";
  if (risk.buysHalted) return "New buys are halted.";
  if (signalAt > now || now - signalAt > risk.maxSignalAgeSeconds * 1000) {
    return "Signal is stale or has an invalid timestamp.";
  }
  if (
    market.priceUsd == null ||
    market.priceUsd <= 0 ||
    !Number.isFinite(market.priceUsd) ||
    now - market.observedAt < 0 ||
    now - market.observedAt > 15_000
  ) {
    return "A fresh post-detection market price is unavailable.";
  }
  if (
    market.liquidityUsd == null ||
    !Number.isFinite(market.liquidityUsd) ||
    market.liquidityUsd < risk.minLiquidityUsd
  ) {
    return "Liquidity evidence is missing or below the configured minimum.";
  }
  if (!market.securityEvidence || !market.poolAddress) {
    return "Token security or pool evidence is missing.";
  }
  if (
    market.topHolderPct == null ||
    !Number.isFinite(market.topHolderPct) ||
    market.topHolderPct > risk.maxTopHolderPct
  ) {
    return "Top-holder concentration evidence is missing or exceeds the configured maximum.";
  }
  if (account.tradesToday >= risk.maxTradesPerDay) return "Daily trade limit reached.";
  if (risk.dailyLossCutoffUsd > 0 && account.dailyRealizedPnlUsd <= -Math.abs(risk.dailyLossCutoffUsd)) {
    return "Daily loss cutoff reached.";
  }
  if (account.openPositions >= risk.maxOpenPositions) return "Open-position limit reached.";
  if (!Number.isFinite(plannedBuyUsd) || plannedBuyUsd <= 0 || plannedBuyUsd > risk.maxBuyUsd) return "Per-buy budget exceeded or invalid.";
  if (account.exposureUsd + plannedBuyUsd > risk.totalExposureUsd) return "Total exposure limit reached.";
  if (plannedBuyUsd > account.cashUsd) return "Insufficient paper cash.";
  if (account.cashUsd <= 0 || risk.maxBuyUsd <= 0) return "Paper cash or per-buy budget is not configured.";
  return null;
}

export function simulateBuyFill(input: {
  targetUsd: number;
  cashUsd: number;
  priceUsd: number;
  feeBps: number;
  slippageBps: number;
}): Fill | null {
  if (
    ![input.targetUsd, input.cashUsd, input.priceUsd, input.feeBps, input.slippageBps].every(
      Number.isFinite,
    ) ||
    input.targetUsd <= 0 ||
    input.cashUsd <= 0 ||
    input.priceUsd <= 0 ||
    input.feeBps < 0 ||
    input.slippageBps < 0 ||
    input.slippageBps >= 10_000
  ) {
    return null;
  }
  const slip = input.slippageBps / 10_000;
  const fee = input.feeBps / 10_000;
  const spend = Math.min(input.targetUsd, input.cashUsd / (1 + fee));
  const notionalUsd = roundDecimal(spend);
  const feeUsd = roundDecimal(notionalUsd * fee);
  const priceUsd = roundDecimal(input.priceUsd * (1 + slip));
  const quantity = roundDecimal(notionalUsd / priceUsd);
  if (quantity <= 0) return null;
  return {
    quantity,
    priceUsd,
    notionalUsd,
    feeUsd,
    slippageUsd: roundDecimal(quantity * (priceUsd - input.priceUsd)),
    cashDeltaUsd: roundDecimal(notionalUsd + feeUsd),
  };
}

export function proportionalExitQuantity(
  paperQuantity: number,
  leaderQuantityBefore: number,
  leaderSoldQuantity: number,
): number {
  if (
    paperQuantity <= 0 ||
    leaderQuantityBefore <= 0 ||
    leaderSoldQuantity <= 0 ||
    ![paperQuantity, leaderQuantityBefore, leaderSoldQuantity].every(Number.isFinite)
  ) {
    return 0;
  }
  const fraction = Math.min(1, leaderSoldQuantity / leaderQuantityBefore);
  return Math.min(paperQuantity, roundDecimal(paperQuantity * fraction));
}

export function realizePaperExit(input: {
  quantity: number;
  positionQuantity: number;
  positionCostBasisUsd: number;
  observedPriceUsd: number;
  feeBps: number;
  slippageBps: number;
}): {
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  slippageUsd: number;
  realizedPnlUsd: number;
} | null {
  if (
    input.quantity <= 0 ||
    input.positionQuantity <= 0 ||
    input.quantity > input.positionQuantity ||
    input.positionCostBasisUsd < 0 ||
    input.observedPriceUsd <= 0 ||
    ![input.quantity, input.positionQuantity, input.positionCostBasisUsd, input.observedPriceUsd, input.feeBps, input.slippageBps].every(Number.isFinite) ||
    input.feeBps < 0 ||
    input.slippageBps < 0 ||
    input.slippageBps >= 10_000
  ) {
    return null;
  }
  const priceUsd = roundDecimal(input.observedPriceUsd * (1 - input.slippageBps / 10_000));
  const notionalUsd = roundDecimal(input.quantity * priceUsd);
  const feeUsd = roundDecimal(notionalUsd * input.feeBps / 10_000);
  const slippageUsd = roundDecimal(input.quantity * input.observedPriceUsd * input.slippageBps / 10_000);
  const allocatedCost = roundDecimal(input.positionCostBasisUsd * input.quantity / input.positionQuantity);
  return {
    quantity: input.quantity,
    priceUsd,
    notionalUsd,
    feeUsd,
    slippageUsd,
    realizedPnlUsd: roundDecimal(notionalUsd - feeUsd - allocatedCost),
  };
}

export function signalIsStale(signalAt: number, now: number, maxAgeSeconds: number): boolean {
  return !Number.isFinite(signalAt) || signalAt > now || now - signalAt > maxAgeSeconds * 1000;
}
