import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One durable recovery campaign for the shared provider key, not per browser/user.
export const gmgnQuoteRecovery = pgTable("gmgn_quote_recovery", {
  id: text("id").primaryKey(),
  state: text("state").notNull().default("waiting"),
  attempts: integer("attempts").notNull().default(0),
  claimId: text("claim_id"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastResult: text("last_result"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  verification: jsonb("verification").$type<Record<string, unknown>>().notNull().default({}),
});
export const insertQuoteRecoverySchema = createInsertSchema(gmgnQuoteRecovery);
export type InsertQuoteRecovery = z.infer<typeof insertQuoteRecoverySchema>;
export type QuoteRecovery = typeof gmgnQuoteRecovery.$inferSelect;
