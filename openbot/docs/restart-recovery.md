# Restart recovery

What happens to work that was "in progress" when a server process stopped, and what deliberately does
not happen. Implemented in `server/src/recovery/abandoned-work.ts`.

## What is closed, and when

Every API server replica runs a recovery sweep once a minute (started inside the server's startup
lifecycle, never on import). Rows count as abandoned once they have been idle longer than
`ABANDONED_RUN_MS` (ten minutes, measured on the database clock). That is twice the turn timeout, so a
slow turn that is still alive is never closed out from under the server running it.

| Left behind by a dead process | Closed as | Notes |
|---|---|---|
| `routine_runs` row with no status | `skipped`, with the reason in `error` | Same reaper the routine sweep uses |
| `group_task_runs` at `running` (crew run) | `failed`; open steps `failed`, finished steps untouched | Parent and open step cards closed `failed` in the run's own tenant |
| Routine / responsibility task card at `running` | `failed` | Only when its run is no longer open in its own ledger (`tasks/reclaim.ts`) |

The sweep leaves these alone:

- `needs_action` cards, pending approvals and crew runs at `awaiting_action`. These wait on a person and are never aged out.
- Chat cards.
- Any card whose run is still `queued`, `running` or `waiting`.

`work_items` leases (responsibility, delivery, approval queues) already recover themselves: an expired
lease is claimed again.

## Nothing is replayed

A stopped step or firing may already have spent quota or written to the world. Re-running it is the
duplicate this sweep exists not to cause. A card closed this way says the work did not finish, and the
person starts it again.

## Multiple replicas

The sweep takes a lease on the shared work queue (kind `recovery.abandoned`, one key per five-minute
bucket). Only the replica that holds that bucket's lease runs the phases. It renews the lease before
each phase and stops if the lease was lost.

Every phase is also a conditional UPDATE on the database clock, and the crew phase is fenced by
revision. So a second runner, for example after clock skew between replicas or the routines CronJob
running beside the server, affects no rows.

Finished lease rows are purged after 24 hours.

The routines CronJob (`server/scripts/fire-routines.ts`) calls the same sweep, so a deployment with
routines enabled has one implementation, not two.

## Tenancy

Rows are found in the platform frame. Each write keeps the row's own `tenant_id`:

- the routine and card phases are single UPDATEs that never set `tenant_id`;
- the crew phase writes each run and its cards inside that run's tenant.

Nothing is written as `system`. The lease row belongs to the platform, not to any tenant.

## Approval resume stays gated

Resuming an approved action needs the local continuation recovery port
(`server/src/approvals/local-recovery-composition.ts`). That port is composed only from a release
attestation verified by Root's trusted release verifier. The attestation names lineage
`recovery-20261018-v1` and feature `approval-local-target-v1`, and must carry a matching catalogue
digest. A production deployment has no such attestation, and the server never fabricates one.

Until that release exists:

- `approval.resume` work items fail with `ApprovalRecoveryBlockedError`. The server logs this as `{"type":"approval-resume-gated","reason":"root_release_not_attested"}` rather than as a generic error. The items are retried up to the queue's attempt cap and then are no longer claimed.
- An approved chat-sourced card was already moved back to `running` when the decision was recorded, so it can stay `running`. The restart sweep does not close it: it has no run or approval reference left to tell an abandoned card from a live one. Closing those cards safely is a separate projector change.

Wiring approval resume needs Root's release authority. That is outside what this server may grant
itself.
