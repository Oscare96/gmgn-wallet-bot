export const QUOTE_MAX_ATTEMPTS = 6;
export const QUOTE_MIN_INTERVAL_MS = 3_600_000;
export const QUOTE_HEARTBEAT_STALE_MS = 120_000;

export function nextQuoteAttempt(now: number, attempt: number, providerUntil?: number | null) {
  // Conservative exponential spacing, capped at 24h. Never shorten provider timing.
  return new Date(Math.max(now + Math.min(24, 2 ** Math.max(0, attempt - 1)) * QUOTE_MIN_INTERVAL_MS,
    providerUntil ?? 0));
}

export function quoteRecoveryDecision(row: {
  state: string; attempts: number; nextAttemptAt: Date | null;
  heartbeatAt: Date | null;
}, now: number, backoffUntil?: Date | null) {
  if (row.state === "verified" || row.state === "blocked") return "terminal";
  if (row.attempts >= QUOTE_MAX_ATTEMPTS) return "exhausted";
  if (row.state === "running") return row.heartbeatAt &&
    now - row.heartbeatAt.getTime() < QUOTE_HEARTBEAT_STALE_MS ? "busy" : "interrupted";
  if (Math.max(row.nextAttemptAt?.getTime() ?? 0, backoffUntil?.getTime() ?? 0) > now) return "waiting";
  return "eligible";
}

export function quoteFailureState(errorKind: string | null, attempts: number) {
  return attempts >= QUOTE_MAX_ATTEMPTS || !["rate_limited", "upstream"].includes(errorKind ?? "")
    ? "blocked" : "waiting";
}

/** The official pinned client's documented OpenApiError.resetAtUnix, never raw stderr. */
export function quoteResetTime(value: unknown, now: number): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value * 1000 + 1000;
  return ms > now && ms < 8.64e15 ? new Date(ms) : null;
}
