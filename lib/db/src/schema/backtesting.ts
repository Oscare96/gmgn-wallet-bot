import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
export const gmgnBacktestRuns = pgTable("gmgn_backtest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  status: text("status").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  assessedAt: timestamp("assessed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  request: jsonb("request").notNull().default({}),
  rulesFrozenAt: timestamp("rules_frozen_at", { withTimezone: true }),
  rulesHash: text("rules_hash"),
  frozenRules: jsonb("frozen_rules").notNull().default({}),
  assessment: jsonb("assessment").notNull(),
  performance: jsonb("performance").notNull(),
  assumptions: jsonb("assumptions").notNull().default([]),
}, (t) => [index("gmgn_backtest_runs_owner_time").on(t.userId, t.requestedAt)]);
