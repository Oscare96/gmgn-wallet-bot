import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireQuoteRecoveryLock, releaseQuoteRecoveryLock, type QuoteLockClient } from "./quoteRecoveryLock";
import { gmgnRead, GmgnReadError } from "./gmgnCli";

test("isolated concurrent manual/worker claim uses the same exclusive lock", async () => {
  // Offline fake SQL-lock server. Never uses real provider/database records.
  let owner: number | null = null;
  const client = (id: number) => ({
    query: async (sql: string) => {
      if (sql.includes("try_advisory_lock")) {
        const held = owner === null || owner === id;
        if (held) owner = id;
        return { rows: [{ held }] };
      }
      if (owner === id) owner = null;
      return { rows: [] };
    },
  }) as QuoteLockClient;
  const a = client(1), b = client(2);
  assert.deepEqual(await Promise.all([acquireQuoteRecoveryLock(a), acquireQuoteRecoveryLock(b)]), [true, false]);
  await releaseQuoteRecoveryLock(a);
  assert.equal(await acquireQuoteRecoveryLock(b), true);
  await releaseQuoteRecoveryLock(b);
});

test("direct quote callers cannot bypass the durable claim or trigger a provider request", async () => {
  await assert.rejects(() => gmgnRead(["order", "quote"]), (e: unknown) =>
    e instanceof GmgnReadError && e.kind === "unsupported");
});
