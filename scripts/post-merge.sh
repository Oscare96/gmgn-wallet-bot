#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile
# Apply the development schema. Do not auto-approve destructive/ambiguous changes:
# with closed stdin, those must fail for review rather than silently discard data.
pnpm --filter @workspace/db run push
