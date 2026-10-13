import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const cliEntry = require.resolve("gmgn-cli");
// Exact official pinned read client. The CLI's order-quote frontend incorrectly calls
// getConfig(true), but this documented GET method uses authExistRequest, not signed auth.
// Static code + JSON argv, never shell interpolation, no dynamic method dispatch.
const QUOTE_READ_SCRIPT = `
import { pathToFileURL } from "node:url";
const { OpenApiClient } = await import(pathToFileURL(process.argv[1]).href);
const parameters = JSON.parse(process.argv[2]);
try {
  const client = new OpenApiClient({ apiKey: process.env.GMGN_API_KEY, host: "https://openapi.gmgn.ai" });
  // The durable app scheduler owns retries. Disable the pinned SDK's internal second GET.
  const execute = client.executePreparedRequest.bind(client);
  client.executePreparedRequest = (prepare) => execute(prepare, false);
  console.log(JSON.stringify(await client.quoteOrder(...parameters)));
} catch (error) {
  console.error(JSON.stringify({ quoteReadError: true,
    kind: error?.status === 429 || ["RATE_LIMIT_EXCEEDED","RATE_LIMIT_BANNED","ERROR_RATE_LIMIT_BLOCKED"].includes(error?.apiError)
      ? "rate_limited" : [401,403].includes(error?.status) ? "auth" : "upstream",
    resetAtUnix: Number.isFinite(error?.resetAtUnix) ? error.resetAtUnix : null }));
  process.exit(1);
}
`;

export class GmgnReadError extends Error {
  constructor(
    public readonly kind: "missing_key" | "rate_limited" | "auth" | "unsupported" | "upstream",
    public readonly retryAt: Date | null = null,
  ) {
    super(kind);
    this.name = "GmgnReadError";
  }
}

function hasKey(): boolean {
  return Boolean(process.env.GMGN_API_KEY?.trim());
}

export function isSupportedReadCommand(args: string[]): boolean {
  return new Set([
    "portfolio:activity", "portfolio:stats", "portfolio:profits",
    "token:info", "token:security", "token:pool",
    "market:trending", "market:kline", "token:traders", "order:quote",
  ]).has(`${args[0]}:${args[1]}`);
}

export async function gmgnRead(args: string[], quoteClaimId?: string): Promise<unknown> {
  if (!isSupportedReadCommand(args)) throw new GmgnReadError("unsupported");
  let quoteParameters: string[] | null = null;
  if (args[0] === "order") {
    // All quote callers, including future workers, must use the durable coordinator.
    if (!quoteClaimId) throw new GmgnReadError("unsupported");
    const { isSolanaAddress } = await import("./discoveryPolicy");
    const flags = ["--chain", "--from", "--input-token", "--output-token", "--amount", "--slippage"];
    if (args.length !== 15 || args.at(-1) !== "--raw") throw new GmgnReadError("unsupported");
    quoteParameters = flags.map((flag, i) => {
      if (args[2 + i * 2] !== flag) throw new GmgnReadError("unsupported");
      return args[3 + i * 2];
    });
    if (quoteParameters[0] !== "sol" || !quoteParameters.slice(1, 4).every(isSolanaAddress) ||
      !/^[1-9]\d{0,30}$/.test(quoteParameters[4]) || !/^(?:100|[1-9]?\d)$/.test(quoteParameters[5])) throw new GmgnReadError("unsupported");
  }
  if (!hasKey()) throw new GmgnReadError("missing_key");
  const { db, gmgnWorkerState, gmgnReadReservations, gmgnDiscoverySettings } = await import("@workspace/db");
  const { eq, gte, lt, sql } = await import("drizzle-orm");
  if (quoteParameters) {
    const { gmgnQuoteRecovery } = await import("@workspace/db");
    const [claim] = await db.select().from(gmgnQuoteRecovery).where(eq(gmgnQuoteRecovery.id, "sol"));
    if (claim?.state !== "running" || claim.claimId !== quoteClaimId ||
      !claim.lastAttemptAt || Date.now() - claim.lastAttemptAt.getTime() > 60_000) {
      throw new GmgnReadError("unsupported");
    }
  }
  await db.insert(gmgnWorkerState).values({ id: "sol" }).onConflictDoNothing();
  const [state] = await db.select().from(gmgnWorkerState).where(eq(gmgnWorkerState.id, "sol"));
  if (state.backoffUntil && state.backoffUntil > new Date()) {
    throw new GmgnReadError(state.lastError === "rate_limited" ? "rate_limited" : state.lastError === "auth" ? "auth" : "upstream");
  }
  const configs = await db.select().from(gmgnDiscoverySettings);
  const budgets = configs.map((c) => c.rules as { enabled?: boolean; maxRequestsPerHour?: number }).filter((r) => r.enabled && Number.isFinite(r.maxRequestsPerHour));
  const allowance = budgets.length ? Math.max(1, Math.min(...budgets.map((r) => r.maxRequestsPerHour!), 1000)) : 60;
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(91200343)`);
    const [usage] = await tx.select({ count: sql<number>`count(*)::integer`, oldest: sql<Date | null>`min(${gmgnReadReservations.createdAt})` })
      .from(gmgnReadReservations).where(gte(gmgnReadReservations.createdAt, new Date(Date.now() - 3_600_000)));
    if (usage.count >= allowance) return { allowed: false, until: usage.oldest ? new Date(new Date(usage.oldest).getTime() + 3_600_001) : new Date(Date.now() + 3_600_000) };
    await tx.insert(gmgnReadReservations).values({});
    await tx.delete(gmgnReadReservations).where(lt(gmgnReadReservations.createdAt, new Date(Date.now() - 172_800_000)));
    return { allowed: true, until: null };
  });
  if (!reservation.allowed) {
    await db.update(gmgnWorkerState).set({ status: "blocked", lastError: "local_query_budget", backoffUntil: reservation.until, updatedAt: new Date() }).where(eq(gmgnWorkerState.id, "sol"));
    throw new GmgnReadError("rate_limited");
  }
  // Other app credentials never enter the GMGN subprocess.
  const safeEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/tmp/gmgn-read-only", GMGN_API_KEY: process.env.GMGN_API_KEY, GMGN_PRIVATE_KEY: "", NODE_ENV: process.env.NODE_ENV };

  try {
    const argv = quoteParameters
      ? ["--input-type=module", "-e", QUOTE_READ_SCRIPT, fileURLToPath(new URL("./client/OpenApiClient.js", pathToFileURL(cliEntry))), JSON.stringify(quoteParameters)]
      : [cliEntry, ...args];
    const { stdout } = await execFileAsync(process.execPath, argv, {
      env: safeEnv,
      timeout: 25_000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const text = `${err.stderr ?? ""} ${err.stdout ?? ""} ${err.message ?? ""}`;
    let quoteError: { quoteReadError?: boolean; kind?: string; resetAtUnix?: unknown } | null = null;
    if (quoteParameters) { try { quoteError = JSON.parse(err.stderr?.trim() ?? ""); } catch { /* Fail conservatively. */ } }
    const { quoteResetTime } = await import("./quoteRecoveryPolicy");
    const providerReset = quoteError?.quoteReadError ? quoteResetTime(quoteError.resetAtUnix, Date.now()) : null;
    const kind = quoteError?.kind === "rate_limited" || /RATE_LIMIT_BANNED|429|rate.?limit/i.test(text) ? "rate_limited" :
      quoteError?.kind === "auth" ? "auth" :
      /401|403|AUTH_KEY_INVALID|invalid.*key|unauthorized|forbidden/i.test(text) ? "auth" :
        /not supported|unsupported|unknown command/i.test(text) ? "unsupported" : "upstream";
    const retryAt = new Date(Math.max(providerReset?.getTime() ?? 0,
      Date.now() + (kind === "rate_limited" || kind === "auth" ? 3_600_000 : 300_000)));
    await db.update(gmgnWorkerState).set({
      status: "blocked",
      lastError: kind,
      backoffUntil: sql`greatest(${gmgnWorkerState.backoffUntil}, ${retryAt.toISOString()}::timestamptz)`,
      updatedAt: new Date(),
    }).where(eq(gmgnWorkerState.id, "sol"));
    // Never propagate CLI output: upstream errors can include request details.
    throw new GmgnReadError(kind, retryAt);
  }
}

export function unwrapData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const root = value as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function readTimestamp(value: unknown): Date | null {
  const seconds = readNumber(value);
  if (seconds != null) {
    const date = new Date(seconds > 10_000_000_000 ? seconds : seconds * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

export function safeErrorKind(error: unknown): GmgnReadError["kind"] {
  return error instanceof GmgnReadError ? error.kind : "upstream";
}
