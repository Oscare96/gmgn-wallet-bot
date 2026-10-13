export type QuoteLockClient = {
  query(sql: string, values?: number[]): Promise<{ rows: { held?: boolean }[] }>;
};
export const QUOTE_RECOVERY_LOCK = 91200347;
export async function acquireQuoteRecoveryLock(client: QuoteLockClient, key = QUOTE_RECOVERY_LOCK) {
  const result = await client.query("SELECT pg_try_advisory_lock($1) AS held", [key]);
  return result.rows[0]?.held ?? false;
}
export async function releaseQuoteRecoveryLock(client: QuoteLockClient, key = QUOTE_RECOVERY_LOCK) {
  await client.query("SELECT pg_advisory_unlock($1)", [key]);
}
