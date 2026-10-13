# GMGN Wallet Tracker

A private-access Solana wallet research dashboard and guarded paper-trading foundation using supported GMGN data. This public repository contains source code only, not credentials, private keys, user database records or previous Git history.

## Safety and current limitations

- Live trading is hard-disabled. No withdrawal or transfer features.
- Authentication protects dashboard records and controls.
- Paper execution remains blocked until genuine quote freshness, canonical event identity, leader starting inventory, costs/decimals/USD conversion and quote-to-ledger integration are verified. Implemented components and isolated software tests are not evidence of profitability.
- The quote recovery scheduler persists cooldowns and bounded attempts, shares a lock with manual checks, and makes read-only diagnostic requests. It cannot run while the API is stopped or asleep.
- No historical strategy backtest result is supplied. Whole-strategy replay requires authentic point-in-time discovery archives and sufficient inventory/activity/market evidence. Forward paper evaluation is separate.
- Suggested virtual budgets must be explicitly confirmed by the authenticated owner. No user balances or account records are included.

## Stack and source

Node.js 24, pnpm, TypeScript, React/Vite, Express, Clerk, PostgreSQL/Drizzle, and the pinned official gmgn-cli.

- artifacts/gmgn-wallet-bot: dashboard
- artifacts/api-server: backend and workers
- lib/db: persistent schemas
- lib/api-spec: OpenAPI source
- lib/api-client-react and lib/api-zod: generated clients/validation
- scripts: setup helpers and isolated tests

## Setup

Install with pnpm install --frozen-lockfile. Configure environment variables through your server secret manager, never commit values. Required services include PostgreSQL (DATABASE_URL), Clerk (CLERK_SECRET_KEY and frontend publishable key configuration), and GMGN_API_KEY for authorized reads. Optional private App Storage registration-key tooling also needs its storage configuration and SESSION_SECRET; do not rotate a wrapping secret without a verified migration. Tracking/paper mode does not require a wallet signing credential.

Review docs/gmgn-runbook.md and docs/gmgn-quote-recovery.md before starting workers. Apply the development database schema only after reviewing the change: pnpm --filter @workspace/db run push.

Local commands (in separate terminals):

    PORT=8080 BASE_PATH=/api pnpm --filter @workspace/api-server run dev
    PORT=22210 BASE_PATH=/ pnpm --filter @workspace/gmgn-wallet-bot run dev

Artifact-managed Replit workflows inject their service configuration automatically. A continuously running backend is required for unattended monitoring/recovery; a static frontend alone is insufficient. Starting the backend can start eligible read-only recovery, so inspect persisted schedules and permissions first.

## Software checks

    pnpm run typecheck
    pnpm --filter @workspace/api-server run test
    PORT=22210 BASE_PATH=/ pnpm --filter @workspace/gmgn-wallet-bot run build

Tests use isolated synthetic fixtures (some need a development PostgreSQL database). They do not represent user results, historical profitability or successful real-data integration.
