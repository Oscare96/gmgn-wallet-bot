import { and, eq } from "drizzle-orm";
import { db, pool, gmgnAudit, gmgnDiscoveryCandidates, gmgnDiscoverySettings, gmgnSettings, gmgnSignals, gmgnWallets, gmgnWorkerState } from "@workspace/db";
import { activityPage, normalizeActivity } from "./gmgnActivity";
import { gmgnRead, safeErrorKind } from "./gmgnCli";
import { signalIsStale } from "./paperTrading";
import { logger } from "./logger";
import { runDiscoveryCycle } from "./discoveryService";
import { advanceCursor } from "./discoveryPolicy";

const POLL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight || !process.env.GMGN_API_KEY?.trim()) return;
  inFlight = true;
  let lock;
  try {
    lock = await pool.connect();
  } catch {
    inFlight = false;
    logger.warn("GMGN worker database connection is unavailable");
    return;
  }
  let locked = false;
  try {
    const result = await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(91200342) AS locked");
    locked = result.rows[0]?.locked ?? false;
    if (!locked) return;
    await db.insert(gmgnWorkerState).values({ id: "sol" }).onConflictDoNothing();
    const [globalState] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
    if (globalState.backoffUntil && globalState.backoffUntil > new Date()) return;
    try {
      await runDiscoveryCycle();
    } catch (error) {
      const kind = safeErrorKind(error);
      await db.update(gmgnWorkerState).set({
        status: "blocked", lastError: kind,
        backoffUntil: new Date(Date.now() + (kind === "rate_limited" || kind === "auth" ? 3_600_000 : 300_000)),
        updatedAt: new Date(),
      }).where(eq(gmgnWorkerState.id, "sol"));
      logger.warn({ kind }, "GMGN discovery entered shared backoff");
      return;
    }
    const owners = await db.select().from(gmgnSettings);
    for (const settings of owners) {
      if (settings.paused || settings.fullStopped || !settings.setupComplete) continue;
      const wallets = await db.select().from(gmgnWallets).where(and(
        eq(gmgnWallets.userId, settings.userId),
        eq(gmgnWallets.enabled, true),
      ));
      const [discovery] = await db.select().from(gmgnDiscoverySettings).where(eq(gmgnDiscoverySettings.userId, settings.userId));
      const monitoredCap = (discovery?.rules as { maxMonitoredWallets?: number } | undefined)?.maxMonitoredWallets ?? 5;
      for (const wallet of wallets.slice(0, monitoredCap)) {
        // Re-read persistent controls immediately before each upstream request.
        const [control] = await db.select().from(gmgnSettings).where(eq(gmgnSettings.userId, settings.userId));
        if (!control || control.paused || control.fullStopped) break;
        const [candidate] = await db.select().from(gmgnDiscoveryCandidates).where(and(eq(gmgnDiscoveryCandidates.userId, settings.userId), eq(gmgnDiscoveryCandidates.address, wallet.address)));
        const cursor = wallet.baselineComplete ? wallet.pollCursor : wallet.baselineCursor;
        const args = [
          "portfolio", "activity", "--chain", "sol", "--wallet", wallet.address,
          "--limit", "50", "--raw",
        ];
        if (cursor) args.push("--cursor", cursor);
        try {
          const raw = await gmgnRead(args);
          const page = activityPage(raw);
          const cursorHistory = advanceCursor((wallet.baselineComplete ? wallet.pollCursorHistory : wallet.baselineCursorHistory) as string[], cursor, page.next);
          const detectedAt = new Date();
          const normalized = page.activities
            .map((row) => normalizeActivity(wallet.address, row))
            .filter((event): event is NonNullable<typeof event> => event != null)
            .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
          for (const event of normalized) {
            const baseline = !wallet.baselineComplete;
            const stale = signalIsStale(
              event.observedAt.getTime(),
              detectedAt.getTime(),
              control.maxSignalAgeSeconds,
            );
            const reason = baseline
              ? "Historical baseline: recorded for monitoring only; never copied."
              : event.side === "buy" && candidate?.state === "excluded"
                ? "New entry rejected: this candidate is excluded. Monitoring and attributable exits are preserved when possible."
              : stale
                ? "Signal rejected: stale or future transaction timestamp."
                : control.buysHalted && event.side === "buy"
                  ? "New buys are halted; monitoring continues."
                  : event.side === "sell" && !control.followSells
                    ? "Sell following is disabled."
                    : "Paper fill blocked: executable read-only quote, upstream quote freshness, and unambiguous event identity have not been verified. Tracking only.";
            await db.insert(gmgnSignals).values({
              userId: settings.userId,
              eventIdentity: event.identity,
              walletAddress: wallet.address,
              walletLabel: wallet.label,
              tokenAddress: event.tokenAddress,
              tokenSymbol: event.tokenSymbol,
              side: event.side,
              observedAt: event.observedAt,
              detectionAt: detectedAt,
              status: baseline ? "baseline" : "skipped",
              reason,
              txHash: event.txHash,
              priceUsd: null,
              priceObservedAt: null,
              rawProvenance: {
                source: "gmgn-cli@1.6.6 portfolio activity",
                chain: "sol",
                record: event.raw,
                detected_at: detectedAt.toISOString(),
                quote_evidence: null,
              },
            }).onConflictDoNothing();
          }
          const latest = normalized.at(-1)?.observedAt;
          await db.update(gmgnWallets).set({
            baselineComplete: wallet.baselineComplete || page.next == null,
            baselineCursor: wallet.baselineComplete ? null : page.next,
            pollCursor: wallet.baselineComplete ? page.next : null,
            baselineCursorHistory: wallet.baselineComplete ? [] : cursorHistory,
            pollCursorHistory: wallet.baselineComplete ? cursorHistory : [],
            ...(latest && (!wallet.lastActivityAt || latest > wallet.lastActivityAt) ? { lastActivityAt: latest } : {}),
          }).where(and(eq(gmgnWallets.userId, settings.userId), eq(gmgnWallets.address, wallet.address)));
          const latency = wallet.baselineComplete && latest
            ? detectedAt.getTime() - latest.getTime()
            : null;
          await db.update(gmgnSettings).set({
            lastSuccessAt: detectedAt,
            observedLatencyMs: latency != null && latency >= 0 && latency <= 2_147_483_647 ? latency : null,
            workerError: null,
          }).where(eq(gmgnSettings.userId, settings.userId));
          await db.update(gmgnWorkerState).set({
            status: "tracking",
            lastError: null,
            backoffUntil: null,
            updatedAt: detectedAt,
          }).where(eq(gmgnWorkerState.id, "sol"));
          if (!wallet.baselineComplete && page.next == null) {
            await db.insert(gmgnAudit).values({
              userId: settings.userId,
              action: "wallet_baselined",
              detail: `Historical records baselined for ${wallet.label}; no historical trades were copied.`,
            });
          }
        } catch (error) {
          const kind = error instanceof Error && /schema|pagination/i.test(error.message) ? "unsupported" : safeErrorKind(error);
          await db.update(gmgnSettings).set({ workerError: kind }).where(eq(gmgnSettings.userId, settings.userId));
          // A shared API key needs a shared, persistent backoff. On rate-limit
          // errors use a conservative hour; never repeatedly probe a rolling ban.
          const delay = kind === "rate_limited" ? 3_600_000 : kind === "auth" ? 3_600_000 : 300_000;
          await db.update(gmgnWorkerState).set({
            status: "blocked",
            lastError: kind,
            backoffUntil: new Date(Date.now() + delay),
            updatedAt: new Date(),
          }).where(eq(gmgnWorkerState.id, "sol"));
          logger.warn({ kind }, "GMGN monitoring entered persistent backoff");
          return;
        }
      }
    }
  } catch {
    logger.warn("GMGN worker could not access its persistent state");
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(91200342)").catch(() => undefined);
    lock.release();
    inFlight = false;
  }
}

export function startGmgnWorker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  void tick();
}
