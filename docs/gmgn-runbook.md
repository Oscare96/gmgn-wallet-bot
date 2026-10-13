# GMGN tracker: setup and operation

Historical tests: see [the backtest status and genuine archive checklist](historical-backtest-data.md). A blocked prerequisite assessment is not a completed backtest; no profitability is claimed.

## Current status

- The private dashboard, PostgreSQL watchlist/settings/audit records and read-only polling worker are implemented.
- A server-side GMGN API key is configured. Genuine bounded current-market, paginated wallet-activity and dated-candle samples have been captured; see Backtesting for exact scopes, timestamps and limitations. This does not verify all permissions, full historical retention or execution readiness.
- There are no seeded wallets, signals, prices, positions, trades or performance results.
- Automated paper entries, exits, stop-loss and take-profit processing are **blocked**, not active. The staged `paperLedger.ts` transaction path is tested with rolled-back synthetic fixtures, including exact decimal cash/cost accounting, owner serialization, cross-leader token deduplication, proportional exits, costs, risk limits and failure rollback. It has no HTTP entry point and is deliberately not connected to the worker: genuine quote/event validation, cohort integration and ongoing marks/exits remain prerequisites.
- Live execution is unavailable. The server always exposes `liveTradingEnabled: false`; its CLI adapter only permits an explicit list of reading commands. There are no transfer or withdrawal features.

The pinned `gmgn-cli@1.6.6` `order quote` frontend calls `getConfig(true)` despite its API-key-only documentation. The server-side adapter instead invokes the pinned official client's `quoteOrder` API-key-only GET method in an isolated subprocess with no signer. The October 11 and October 12 UTC quote probes were rate-limited, not successful. Upstream quote timestamps, executable-price semantics, event-level identity, full costs/decimals/USD conversion and real quote-to-ledger integration remain unverified. The documented activity response has no event/log index, so the current transaction/wallet/token/side/timestamp/amount identity can collide for same-shaped events within one transaction. Paper fills remain unavailable until these checks are validated against genuine data. Do not provide signing credentials merely to accommodate the CLI frontend bug.
## Inspecting data without starting monitoring

Use **Backtesting → Provider evidence**. The inspection requires explicit confirmation, permits at most ten read operations, shares the app's query budget/backoff and a 15-minute inspection cooldown, and stops further upstream reads on denial, rate limiting or service failure. The pinned client may internally retry a short rate limit once. The sample wallet is selected from current real token traders only for coverage inspection; it is not enrolled or retrospectively used to select historical winners. JSON exports contain redacted provider records, not performance. No inspection resumes monitoring or changes risk settings.

Leave monitoring and automatic selection paused until source access, plan/rate settings and manual setup are reviewed. Paper entries and exits remain unavailable until quote/freshness/event identity and atomic accounting are validated. There is no automatically started historical backtest. A deposit or API-key registration does not authorize trading.

## Read-only key setup

On the GMGN API-key screen:

1. Generate the public-key registration using the official `gmgn-cli config` command on your own trusted computer. A pinned command is `npx gmgn-cli@1.6.6 config`.
2. Use the generated **public** key or the pre-filled GMGN creation link. Never upload the private key, a wallet seed phrase, or signing credentials into chat.
3. Keep **Enable Reading** on and **Enable Trading** off.
4. Store the resulting API key in Replit Secrets as `GMGN_API_KEY`. Do not put it in source, a browser form or an exported file.
5. Restart the managed API workflow after configuring the secret.

GMGN may additionally enforce key permissions, IP allowlisting, account quota or account-plan restrictions. A rejected or rate-limited key is not reported as a successful connection.

Authentication is configured through Replit's Auth pane. The application uses Replit-managed Clerk, not an external Clerk dashboard.

## Starting monitoring

1. Sign in to your private workspace.
2. Add wallet addresses you explicitly selected, or review daily discovery for real candidate sources. Manual watchlist rows are disabled by default; pinning a discovery candidate is observation priority, not copy permission.
3. Set each wallet's label and paper buy budget.
4. Review the suggested risk thresholds, enter paper cash, and explicitly acknowledge the paper setup.
5. Enable selected wallets and resume the worker only after the read-only key is configured.

The first enabled-wallet pass baselines historical activity, one documented page at a time. A persisted cursor resumes unfinished baselines after a restart. Historical records are recorded as baseline, never copied. Subsequent observations are deduplicated in PostgreSQL and stale signals are rejected. Fresh signals are still recorded as skipped while execution evidence remains unverified.

## Daily derived wallet discovery

Open **Discovery → Rules**. Settings are proposed, not approved budgets. Confirm actual GMGN read permissions and plan limits, set a conservative local request allowance and monitored-wallet cap, review the rules, then enable discovery. Keep automatic selection paused while evidence and the paper execution path remain unavailable. With no key, the screen remains honestly blocked and has no fabricated candidates.

The pinned official CLI documents `market trending --chain sol --interval 24h` and `token traders`. No supported official daily trending-wallet leaderboard was found. This app derives an activity ranking from traders of the configured top trending tokens; it does **not** rank all GMGN accounts or claim skill. Only documented last-active timestamps within 24h qualify as active source candidates. Ranking order uses source-token coverage and reported cumulative token buy counts, not headline profit. These trader counts can cover the token's lifetime, not a wallet's daily returns.

Automatic refresh is due on each new **America/Chicago calendar date**, including DST changes. A manually queued refresh makes another immutable snapshot, not an overwrite. Incomplete refreshes resume their persisted stage; a previous day's incomplete universe retains that date. Real fetch times, coverage, recent snapshots, candidate sources and qualification reasons are visible. The history is retained in PostgreSQL; the dashboard shows the most recent 31 refresh runs and 200 observations.

Shortlisted observations respect the configurable interval, a combined monitored-address cap and the worker's persistent pause/full-stop controls. Pinned candidates have priority, but cannot bypass suspicious flags or qualification. Existing observation cohorts are retained ahead of new unpinned candidates, avoiding replacement merely because today's token list changed. Daily discovery research has its own enable switch and can refresh while wallet activity monitoring is paused; **full STOP stops both**. Pausing automatic selection stops enrollment, not existing monitoring. A halted-buy setting does not stop attributable exit monitoring when that path is available.

Historical GMGN realized/unrealized results and sell counts use documented 30d statistics. Loss rates require cost-evidenced sampled sells; concentration is sampled traded notional, **not** full portfolio holdings. Holding times use official completed token start/end intervals only. Wallet age, historical/full-equity drawdown and missing evidence are unavailable, not inferred from profit. Evidence scores count passed checks; they are not expected return or proof of skill.

Forward results count only simulated fills tagged with the candidate's frozen evaluation cohort **after its completed baseline**. Past/manual/pre-cohort fills cannot become a retrospectively copied strategy. Closed roundtrips, net realized PnL, disclosed ledger costs and realized-only drawdown are separate; partial sell fills do not inflate closed sample counts. Restoring an excluded candidate starts a new cohort/baseline. Current quote/freshness/identity blockers mean no forward fills are generated and **no candidate can currently auto-qualify**. If verified later, enrollment additionally requires explicit paper risk setup, a positive auto-buy budget within the reviewed risk cap, free monitoring capacity and unpaused automatic selection. New watch enrollments baseline again; no historical orders replay.

Every CLI read shares a persistent rolling-hour reservation budget and upstream backoff, including research/manual polling. The lowest enabled discovery request allowance applies to the shared server key. This is a local request cap, **not** proof of GMGN credit allowance: endpoints may have different credit costs, and actual permission/quota failures remain blocked. Cursor cycles or a 100-page safety limit block incomplete baselines rather than assuming the history ended. Neither an idle/sleeping preview nor rate-limited polling guarantees continuous coverage or an executable copy price.

- **Pause worker:** pauses polling.
- **Halt buys:** preserves monitoring; it is distinct from full stop. Exit processing is currently blocked pending quote/inventory verification.
- **STOP:** persists a full polling stop.

## Reliability

The worker runs inside the API process and polls at 60-second intervals. A PostgreSQL advisory lock prevents duplicate polling across API processes. Cursors, signal identities, controls and shared backoff state are persistent. Detection latency is calculated from observed transaction time to detection time; it is not a guaranteed blockchain or execution latency.

A rate-limit or auth rejection results in a conservative shared one-hour backoff. Other upstream failures back off for five minutes. Do not repeatedly test a rolling GMGN rate-limit ban.

For continuous monitoring, run the **API process** in an always-on service, not just the static frontend. Replit Reserved VM deployments run continuously; Autoscale deployments can scale to zero when idle. Preview workflows may sleep and do not guarantee monitoring. No publication has been performed.

Official deployment reference: https://docs.replit.com/features/publishing/deployment-types

## Local validation

Managed workflows supply service environment variables:

- API: `pnpm --filter @workspace/api-server run dev`
- Web: `pnpm --filter @workspace/gmgn-wallet-bot run dev`

Checks:

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/api-server run build
PORT=22210 BASE_PATH=/ pnpm --filter @workspace/gmgn-wallet-bot run build
```

The tests use explicitly synthetic fixtures. The persistence test inserts only within a rolled-back transaction using an isolated fixture owner. No test places orders or reaches GMGN.

Research uses documented 30-day wallet statistics and at most the latest 50 activity records. Holding/loss/concentration metrics are sampled and are not an all-history analysis. Unavailable fields remain unavailable. Wallets are never automatically selected from headline PnL.

## Remaining verification

- Confirm required permissions/quotas for selected addresses within the existing account; the read-only key is configured and bounded market, activity and candle samples have been captured. Broader coverage and quote permissions remain unverified.
- Verify cursor ordering, event identity, pagination and restart behavior against actual GMGN data.
- Retry the SDK's unsigned quote path after rate-limit backoff and validate genuine responses, including trusted upstream quote time and executable-price semantics.
- Verify event-level identity from genuine activity data; the current public schema does not expose a documented event/log index.
- Only after both checks pass, implement and test atomic paper cash/quantity/cost/fee/PnL/equity transactions, fresh mark-to-market observations and owner/leader-attributed proportional exits before allowing fills.
- Verify fee/slippage/latency assumptions, risk caps and stop-loss/take-profit end-to-end with real quotes.
- Any future live adapter needs separate validation, explicit budget/risk setup, signing credentials in Secrets and later user authorization. It must remain disabled until then.
