/** Keys and reviewed budgets alone never authorize an unverified paper pipeline to run. */
export function paperStartupBlock(readiness: {
  paper: string; readBlockReason: string | null; readBackoffUntil: Date | string | null;
}, now = new Date()): string | null {
  const until = readiness.readBackoffUntil ? new Date(readiness.readBackoffUntil) : null;
  if (until && until > now) return `Paper start blocked by provider backoff until ${until.toISOString()}.`;
  if (readiness.readBlockReason) return `Paper start blocked: ${readiness.readBlockReason}. Verify read access before starting.`;
  if (readiness.paper !== "ready") return "Paper execution is not verified. Fresh quotes, canonical signals, costs, risk checks and quote-to-ledger integration must pass before starting.";
  return null;
}
