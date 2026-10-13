# Operational readiness and archive investigation

## Verified inspection, not a forward evaluation

An explicitly authorized bounded inspection captured genuine GMGN samples starting **2026-10-12 00:13:30 UTC** (October 11, 19:13:30 America/Chicago). This is a diagnostic capture start time, **not** the start of continuous collection or a paper strategy evaluation.

Nine source operations returned parseable data: current trending tokens, traders of one token, two wallet activity pages, two dated candle windows, security, pool and token info. The two activity pages contain 20 records spanning October 11 22:56:19–23:37:42 UTC; pagination is not exhausted. The documentation-example token returned 60 one-minute candles for October 5 12:00–12:59 UTC and 57 for October 11 12:00–12:59 UTC, with three missing bars. These are separate sampled hours, not full daily coverage or a development/evaluation period.

The tenth operation, an unsigned read-only quote, returned `rate_limited`. The persisted application backoff ends **2026-10-12 01:13:49.663 UTC**. Its expiry is permission to reassess, not evidence the upstream quota has recovered. Do not bypass backoff or enable signing/trading to obtain a read quote. Check the existing GMGN key's read permissions, usage and actual plan allowance; no deposit readiness or successful quote is inferred.

Records and payload checksums are saved in private provider evidence and displayed in the dashboard. No wallet was enrolled, no monitoring or selection was resumed, no budget was approved, and no trade was created.

## Existing task workflow

The inspected task board shows tracking verification waiting for input, while past daily selection is queued due to the active-task limit. No conflicting task was created, cancelled or discarded. The queued historical task is not executing and remains data-blocked even when capacity becomes available.

Open the existing tracking task's thread and answer its requested **selected Solana wallet addresses**; the API key is already configured in the main workspace and must not be pasted into a thread. Alternatively, request observation-only selection from real discovery candidates in that thread instead of treating current winners as approved copy targets. Review any Ready result before applying it. Queued work starts when capacity becomes available; completing the waiting task does not supply historical archives.

Before actual forward execution, review owner-specific paper cash/risk settings and discovery/evaluation rules, validate quote and event evidence, and freeze a new forward cohort. Preserve excluded/losing/inactive observations and failed fill decisions. The current conditional start prerequisites did not pass, so prospective evaluation remains unstarted.

## What is implemented versus verified

### Latest paper-preparation check

One quote-only read was made on October 12 at **01:13:55 UTC**, after the previous shared backoff expired. It used the pinned official normal-auth quote method and a real trader/token from existing checksum-verified automatic-discovery evidence. It was rate-limited again, and shared backoff now runs until **02:13:55 UTC** (October 11, 9:13:55 PM America/Chicago). There was no signing credential, order, wallet enrollment or paper fill.

The authenticated dashboard now provides **Check quote only**, with explicit read-only confirmation, server-side shared backoff/cooldown, and persisted redacted provenance. The probe is for 0.001 SOL, not a $20 paper buy or proof of user execution-wallet suitability. Even a successful quote read would leave upstream freshness, USD/fee/decimal semantics, canonical event identity and end-to-end paper execution unverified.

Risk settings provide the user's **proposed** $1,000 virtual cash, $20 buy cap and $100 total exposure cap. Loading the proposal changes form values only, resets consent and does not change account balances or start monitoring. Remaining risk/cost assumptions require review and owner-scoped confirmation. Resume/restart now fail closed server-side while paper readiness is unverified; key presence and reviewed budgets cannot bypass this gate.

The staged atomic ledger is still not invoked by the worker. Authentic observed-activity baseline coverage and quote-to-ledger/cohort/mark/exit integration remain incomplete. Prospective collection/evaluation and historical replay have not started.

- Discovery, pagination/baselines, observed activity records, risk helpers and private persisted records exist. Bounded source schemas work; sustained worker operation with selected wallets and actual plan coverage is not verified.
- The staged atomic ledger is software-tested only. It has no network/order methods or HTTP fill endpoint and is not invoked by the worker. Current GMGN activity lacks verified canonical event indices and pre-sale inventories; quote freshness, normalized amounts/USD costs and failure/sellability semantics are not validated.
- Ledger tests use synthetic owners and transactions that are rolled back, not real candidates or strategy results. They cover fee-inclusive cash/exposure, quantities/cost basis, proportional matching exits, duplicate/restart protection, stale evidence, delays, halt versus full stop, and failure rollback.
- Neither ongoing mark/stop-loss integration nor candidate-cohort paper qualification is certified operational. Paper readiness remains blocked.
- Live execution remains unavailable. No order, signature, transfer, withdrawal or publishing was performed.

## Historical sources investigated, not acquired

Authoritative sources consulted:

- https://docs.gmgn.ai/index/gmgn-agent-api
- https://github.com/GMGNAI/gmgn-skills/blob/main/docs/cli-usage.md
- https://docs.dune.com/data-catalog/curated/dex-trades/solana/solana-dex-trades

GMGN documents **current** trending-token ranks, token traders, wallet activity pagination, current holdings/security/pool and dated OHLC. The reviewed commands do not document historical-as-of daily wallet rankings, dated security/pool snapshots or historical quote/orderbooks. This is a coverage finding, not proof no archive exists elsewhere. No provider archive has been obtained through current access.

Dune's public Solana DEX catalog documents raw bought/sold amounts, trader/transaction/slot and outer/inner instruction indices, pool vaults, USD values and fees. A provenance-preserving export under an existing/free account could supply part of the event archive. No connection/export or complete period coverage was verified or purchased. A routed trade has multiple pool legs: these cannot be counted as independent wallet buys or charged duplicated costs. Trade rows alone do not provide starting holdings, failed transaction population, complete pool reserves at each future delayed entry, historical GMGN suspicion/security flags, or the past GMGN ranking/candidate universe. SQL reconstruction would need audited coverage and known publication times; current rankings cannot be substituted.

Feasible next sources are an original operator's dated GMGN discovery/candidate exports, the user's existing historical archives, and authorized provenance-preserving DEX/chain exports with pre-period inventory and pool/mint state reconstruction. Any chain-derived alternative universe is a **different explicitly defined strategy**, not a replay of past GMGN rankings.

The complete historical strategy remains blocked until a point-in-time candidate universe including losing/inactive/failed populations, canonical events and opening inventories, delayed-entry price/liquidity/security/cost/sellability evidence, chronological development/untouched evaluation periods, frozen rules and a validated replay adapter are present. No historical profitability metrics can currently be reported.
