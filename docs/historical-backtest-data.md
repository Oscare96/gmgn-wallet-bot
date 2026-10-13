# Historical testing: current status and data requirements

**The prerequisite assessment is complete; a historical simulation has not started.**
As of October 11, 2026, the server-side API key is configured and bounded genuine read-only probes have been persisted. No whole-strategy historical execution or performance result exists. Source records and software tests must not be relabeled strategy trades or returns.

## Verified provider coverage, not strategy performance

The authenticated Backtesting evidence panel reports captured source timestamps, distinct requested/returned windows, parser status, field names, gaps, latency, pagination limits and SHA-256 checksums. Original redacted structured responses are stored in PostgreSQL and available through authenticated, owner-scoped JSON exports. Operator diagnostics cover public sampled market data; private owner inspections are not shared with other owners.

The October 11 inspection verified current trending tokens, a derived current token-trader sample, two 10-record wallet-activity pages, current security/pool/info, and dated 1-minute candles for GMGN's official documentation example token:

- **October 4, 12:00–13:00 UTC:** 60 minute candles.
- **October 10, 12:00–13:00 UTC:** 58 minute candles; two absent bars, cause unverified. No interpolation or substitute prices.
- **Wallet activity:** 20 returned records from October 11, about 20:26–21:10 UTC. Pagination was sampled, not exhausted; no historical retention or pre-test inventory claim.

These are separate sample windows, not continuous October 4–10 coverage and not a historical wallet universe. No wallets were added/enabled and monitoring stayed paused.

The official pinned CLI frontend still mistakenly requires a private key for `order quote`. Its official read-client method uses the documented API-key-only GET `/v1/trade/quote`, so the narrowly allowlisted adapter can attempt that read without a signer. The actual quote probe was blocked by a rate-limit condition; no quote or fill is verified. Reads honor the persisted shared backoff. A successful token-price or candle read does not prove executable quoting, upstream freshness, complete costs, depth, price impact or ability to sell.

The complete strategy remains **blocked**. The bounded direct-provider importer does not invent unavailable as-of daily rankings, historical security/liquidity or disappeared populations. An archive-backed whole-strategy replay adapter is not implemented/validated because those prerequisites are absent. The exact-decimal accounting kernel and chronological/bias checks are software building blocks only.

Open the authenticated **Backtesting** section for the current assessment. A request saves an owner-private immutable assessment, optional date split, reviewed rule snapshot and SHA-256 hash. “Assessed” is not “simulation completed”: blocked requests retain null execution timestamps, progress, trades and returns. JSON/CSV exports preserve this distinction. An interrupted assessment becomes failed after restart; it is never relabeled a completed simulation.

## Why adding a key is not sufficient

The official agent API and pinned official `gmgn-cli@1.6.6` document current trending-token queries, token-trader queries and wallet histories/statistics. These support derived current wallet discovery—not an official daily trending-wallet leaderboard. Dated candles are documented, but a historical as-of trending universe or wallet ranking has not been established. Available commands and permissions must be checked against actual provider responses.

Replaying today's selected wallets could omit losers and inactive accounts, use future selection information and ignore failed tokens. It is not offered as a complete strategy backtest or proof of profitability.

## Required genuine archive

Provide original provider or on-chain exports with source documentation and timestamps, not screenshots, hand-written candidate lists or fabricated fixture results:

1. **Point-in-time daily universe:** candidates/tokens actually available at each historical America/Chicago decision; ranking provenance, filter rules, coverage and losing/inactive/failed/delisted populations. Explain gaps explicitly.
2. **Information availability:** when each record was obtainable, the performance measurement cutoff, retention, pagination and sampling. A historical event timestamp alone does not establish when it could be detected.
3. **Canonical wallet activity:** Solana transaction/event identities, ordered buys and sells, quantities and pre-sell inventory. Include baseline and warmup needed for discovery history and forward qualification. Current portfolio holdings do not establish a past sell fraction.
4. **Post-delay price and tradability:** observed/available timestamps, delayed quotes or defensible price observations, historical liquidity/depth/security, spread evidence where available, failures and unsellability. Do not treat trading volume as pool liquidity or candle close as known at candle open.
5. **Terminal valuation:** reliable end-period observations for every remaining position. Missing or unsellable marks cannot be invented as free liquidations; whole-equity return/drawdown may remain inconclusive.
6. **Study configuration:** nonoverlapping chronological development and untouched evaluation periods, explicit historical initial capital and budget/risk assumptions, and frozen discovery/qualification/fees/slippage/delay rules. Historical starting capital must not silently be inferred from today's forward-paper cash. Disclose previous evaluation inspection or reuse.

Date fields are inclusive UTC calendar dates; daily selection boundaries remain America/Chicago. Neither period may include today's incomplete day. No dates, budget approval, profit target or acceptance threshold are invented by the app.

**A provenance-validated authenticated importer and complete chronological discovery/qualification replay adapter are not implemented or validated.** Supplying a key or uploading any arbitrary data does not silently start a run. This remaining implementation must validate the archive, losing/failed-population coverage, historical market states, risk/exit rules and untouched evaluation before execution.

## What has been tested versus what has not

Offline tests use clearly isolated synthetic fixtures; database fixtures are rolled back. They cover date/holdout separation, future-information rejection, immutable rule copies/hashes, delayed quote selection and candle availability, exact fixed-decimal ledger costs and partial leader exits, overlap/replay rejection, missing/stale evidence, unsellable positions, entry caps and loss halts. Existing discovery provenance/baseline/restart/risk/live-disabled tests remain in place.

The accounting kernel is **not** a validated whole-strategy backtest engine. Passing unit tests is not real-data integration verification, historical market coverage or evidence of profitability. No complete-strategy historical run or genuine forward copy fills have been validated without the missing provider data and execution-price evidence.

## Operation and safety

Keep the API and web managed workflows running in development. The API process contains the forward monitoring worker; an idle/sleeping preview cannot guarantee monitoring. For eventual continuous operation, Replit documents Reserved VM publishing as suitable for always-on workers; Autoscale may scale to zero. Publishing is a separate user action and has not been performed.

Use server-side Secrets for `GMGN_API_KEY`, with **reading enabled and trading disabled**. Do not provide a signing key for tracking/paper assessment. Real orders, withdrawals and transfers are not invoked. Live execution stays disabled regardless of backtest form fields or client requests.

Sources:
- https://docs.gmgn.ai/index/gmgn-agent-api
- https://github.com/GMGNAI/gmgn-skills/blob/main/docs/cli-usage.md
- https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md
