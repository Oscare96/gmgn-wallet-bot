import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const money = (name: string) =>
  numeric(name, { precision: 30, scale: 12 }).notNull().default("0");
const qty = (name: string) =>
  numeric(name, { precision: 40, scale: 18 }).notNull().default("0");

export const gmgnSettings = pgTable("gmgn_settings", {
  userId: text("user_id").primaryKey(),
  paused: boolean("paused").notNull().default(true),
  buysHalted: boolean("buys_halted").notNull().default(false),
  fullStopped: boolean("full_stopped").notNull().default(false),
  setupComplete: boolean("setup_complete").notNull().default(false),
  maxBuyUsd: money("max_buy_usd"),
  totalExposureUsd: money("total_exposure_usd"),
  maxOpenPositions: integer("max_open_positions").notNull().default(5),
  maxTradesPerDay: integer("max_trades_per_day").notNull().default(5),
  maxSignalAgeSeconds: integer("max_signal_age_seconds").notNull().default(60),
  minLiquidityUsd: money("min_liquidity_usd"),
  maxTopHolderPct: money("max_top_holder_pct"),
  dailyLossCutoffUsd: money("daily_loss_cutoff_usd"),
  feeBps: money("fee_bps"),
  slippageBps: money("slippage_bps"),
  latencyMs: integer("latency_ms").notNull().default(1500),
  stopLossPct: numeric("stop_loss_pct", { precision: 12, scale: 6 }),
  takeProfitPct: numeric("take_profit_pct", { precision: 12, scale: 6 }),
  followSells: boolean("follow_sells").notNull().default(false),
  paperCashUsd: money("paper_cash_usd"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  observedLatencyMs: integer("observed_latency_ms"),
  workerError: text("worker_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gmgnWallets = pgTable(
  "gmgn_wallets",
  {
    userId: text("user_id").notNull(),
    address: text("address").notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    automatic: boolean("automatic").notNull().default(false),
    buyBudgetUsd: money("buy_budget_usd"),
    baselineComplete: boolean("baseline_complete").notNull().default(false),
    baselineCursor: text("baseline_cursor"),
    pollCursor: text("poll_cursor"),
    baselineCursorHistory: jsonb("baseline_cursor_history").notNull().default([]),
    pollCursorHistory: jsonb("poll_cursor_history").notNull().default([]),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.address] }),
    ownerIdx: index("gmgn_wallets_owner_idx").on(table.userId),
  }),
);

export const gmgnWorkerState = pgTable("gmgn_worker_state", {
  id: text("id").primaryKey(),
  backoffUntil: timestamp("backoff_until", { withTimezone: true }),
  status: text("status").notNull().default("idle"),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gmgnSignals = pgTable(
  "gmgn_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    eventIdentity: text("event_identity").notNull(),
    walletAddress: text("wallet_address").notNull(),
    walletLabel: text("wallet_label").notNull(),
    tokenAddress: text("token_address").notNull(),
    tokenSymbol: text("token_symbol"),
    side: text("side").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    detectionAt: timestamp("detection_at", { withTimezone: true }).notNull().defaultNow(),
    priceUsd: numeric("price_usd", { precision: 30, scale: 12 }),
    priceObservedAt: timestamp("price_observed_at", { withTimezone: true }),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    txHash: text("tx_hash"),
    rawProvenance: jsonb("raw_provenance").notNull().default({}),
  },
  (table) => ({
    eventUnique: uniqueIndex("gmgn_signals_user_event_unique").on(
      table.userId,
      table.eventIdentity,
    ),
    ownerRecentIdx: index("gmgn_signals_owner_recent_idx").on(
      table.userId,
      table.detectionAt,
    ),
  }),
);

export const gmgnPositions = pgTable(
  "gmgn_positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    tokenAddress: text("token_address").notNull(),
    tokenSymbol: text("token_symbol"),
    leaderAddress: text("leader_address").notNull(),
    leaderLabel: text("leader_label").notNull(),
    quantity: qty("quantity"),
    costBasisUsd: money("cost_basis_usd"),
    markPriceUsd: numeric("mark_price_usd", { precision: 30, scale: 12 }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    priceObservedAt: timestamp("price_observed_at", { withTimezone: true }),
  },
  (table) => ({
    leaderTokenUnique: uniqueIndex("gmgn_positions_user_leader_token_unique").on(
      table.userId,
      table.leaderAddress,
      table.tokenAddress,
    ),
    ownerIdx: index("gmgn_positions_owner_idx").on(table.userId),
  }),
);

export const gmgnTrades = pgTable(
  "gmgn_trades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    signalId: uuid("signal_id"),
    tokenAddress: text("token_address").notNull(),
    tokenSymbol: text("token_symbol"),
    side: text("side").notNull(),
    quantity: qty("quantity"),
    priceUsd: numeric("price_usd", { precision: 30, scale: 12 }).notNull(),
    notionalUsd: money("notional_usd"),
    feeUsd: money("fee_usd"),
    slippageUsd: money("slippage_usd"),
    realizedPnlUsd: numeric("realized_pnl_usd", { precision: 30, scale: 12 }),
    leaderAddress: text("leader_address").notNull(),
    filledAt: timestamp("filled_at", { withTimezone: true }).notNull().defaultNow(),
    simulated: boolean("simulated").notNull().default(true),
    evaluationId: uuid("evaluation_id"),
  },
  (table) => ({
    signalSideUnique: uniqueIndex("gmgn_trades_user_signal_side_unique").on(
      table.userId,
      table.signalId,
      table.side,
    ),
    ownerRecentIdx: index("gmgn_trades_owner_recent_idx").on(
      table.userId,
      table.filledAt,
    ),
  }),
);

export const gmgnAudit = pgTable(
  "gmgn_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    detail: text("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerRecentIdx: index("gmgn_audit_owner_recent_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);

export const gmgnEquityPoints = pgTable(
  "gmgn_equity_points",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    equityUsd: money("equity_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerRecentIdx: index("gmgn_equity_owner_recent_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);
