import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Queryable, bounded provider observations, not uploaded file bytes or strategy results. */
export const gmgnProviderEvidence = pgTable("gmgn_provider_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  collectionId: uuid("collection_id").notNull(),
  // Null is a workspace diagnostic of public market data, visible only behind authentication.
  userId: text("user_id"),
  source: text("source").notNull(),
  status: text("status").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  latencyMs: integer("latency_ms").notNull(),
  recordCount: integer("record_count").notNull(),
  returnedFrom: timestamp("returned_from", { withTimezone: true }),
  returnedTo: timestamp("returned_to", { withTimezone: true }),
  command: jsonb("command").$type<string[]>().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  payloadHash: text("payload_hash"),
  limitation: text("limitation").notNull(),
}, (t) => [index("gmgn_evidence_owner_time").on(t.userId, t.capturedAt)]);

export const insertGmgnProviderEvidenceSchema = createInsertSchema(gmgnProviderEvidence).omit({ id: true, capturedAt: true });
export type GmgnProviderEvidence = typeof gmgnProviderEvidence.$inferSelect;
