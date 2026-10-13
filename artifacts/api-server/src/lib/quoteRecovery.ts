import { eq } from "drizzle-orm";
import { db, gmgnQuoteRecovery } from "@workspace/db";
import { initializeQuoteRecovery } from "./quoteRecoveryState";
import { probePaperQuote } from "./paperQuoteProbe";
import { logger } from "./logger";

let started = false, ticking = false;
export function startQuoteRecovery() {
  if (started) return;
  started = true;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await initializeQuoteRecovery();
      // Never overwrite a running claim's heartbeat from another process.
      const [row] = await db.select().from(gmgnQuoteRecovery).where(eq(gmgnQuoteRecovery.id, "sol"));
      if (row?.state !== "running") await db.update(gmgnQuoteRecovery).set({ heartbeatAt: new Date() })
        .where(eq(gmgnQuoteRecovery.id, "sol"));
      await probePaperQuote(null); // Shared lock + persisted eligibility; no due request = no provider call.
    } catch {
      logger.warn("Quote recovery cycle unavailable; no paper evaluation started. Persisted claims retain retry timing.");
    } finally { ticking = false; }
  };
  void tick();
  setInterval(() => void tick(), 30_000).unref();
}
