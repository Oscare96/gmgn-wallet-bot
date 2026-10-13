# Automatic quote-only recovery

The API initializes a single persisted Solana recovery campaign at startup. Every
30 seconds it checks local eligibility; only an eligible campaign makes a GMGN
request. Browser polling is local status only. No browser, user click or manual
wallet selection is needed.

- Initial eligibility respects existing shared provider backoff and quote cooldown.
- Manual quote checks share the advisory lock, counter and durable schedule.
- Each claim is saved before the provider request; quote calls without the
  coordinator's claim are rejected. Coverage inspections no longer request quotes.
- The pinned SDK's automatic second quote GET is disabled. Its `resetAtUnix`
  timing is retained without logging raw errors, headers or credentials.
- Six attempts maximum across this campaign, including manual attempts.
- Retryable failures use at least one hour, doubling between attempts up to 24h,
  and never precede a later provider reset or shared cooldown.
- Missing key/evidence, authentication/schema/unsupported errors and exhaustion
  block recovery. They require resolving the stated blocker; reloading does not
  reset the counter.
- An ambiguous interrupted request is not immediately replayed. Its saved claim,
  attempt count and delayed eligibility survive restart. A resume performs one
  eligible attempt, never a catch-up burst.

Private Overview, System health and Backtesting show next time, last attempt,
result, count, heartbeat/runtime and saved readiness checks. If the API is stopped
or unreachable, the browser shows status unavailable. A stale heartbeat is not
proof of an active worker; a saved next time is not a promise of offline execution.

Success means a quote sample parsed, not a fill or a profitable strategy. Saved
automatically derived trader/activity evidence is checked without copying old
events. Upstream price age, canonical identity, starting inventory, fee/decimal/USD
semantics and staged-ledger worker integration remain explicit blockers until
proven. Owner-confirmed risk and virtual cash are required independently.
Recovery never approves proposals, resumes monitoring or sends any order.

## Runtime requirement

Replit documents Reserved VM deployments as continuously running and suitable for
background workers. Autoscale can scale to zero; an idle/sleeping preview cannot
guarantee retry timing. This change does not publish or purchase anything. While
developing, keep the managed API workflow running. A future unattended deployment
needs an always-running runtime chosen and authorized by the user.

## Verification

Timing, crash/restart spacing, overlap locking, direct-call enforcement and retry
limits use isolated synthetic software fixtures. These are not historical or
prospective trading performance. A real recovery capture, if made, is diagnostic
provider evidence only.
