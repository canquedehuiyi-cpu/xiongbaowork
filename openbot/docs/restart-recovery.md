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
| `group_task_runs` at `running` that belong to a WakerFlow run (`flow_id` set) | `failed`; the step that was running fails with "服务在这一步执行期间重启了。这一步可能已经产生了效果，系统没有重新执行它。", steps not yet started fail with "服务在这一步开始前重启了，运行已停止，这一步没有执行。" | Closed first, by `wakerflows/recovery.ts`, in one transaction with the parent and every still-open card under it, in the run's own tenant. Nobody reruns it automatically; the person decides |
| `waker_flow_requests` run request still `pending` | `completed` pointing at its run if the pipeline registered one, otherwise `unknown` (its parent card, if opened, `failed`) | Same phase. Never re-driven; it would otherwise block deleting the Flow |
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

## Approval resume: settled by the server on the approval row

An approved action is carried out by the `approval.resume` worker in `server/src/index.ts`. The
approval service is composed with `settlement: "database"` (`server/src/approvals/service.ts`). The
server itself guarantees that the action runs at most once, using the `approval_requests` row as the
fence. It does not depend on Root's release attestation, and no new table or migration is involved.

What the worker does with one item, in the owner's own tenant frame (`runAsClaimedTenant`, G01):

1. **Binding check.** It reads the row through `getRecoveryContext` and checks it. The row must be
   the owner's own and stamped with the frame's tenant, and its saved action must still name the run
   and tool call it was opened for. A row that fails this is never run or answered. It is logged as
   `{"type":"approval-resume-gated","reason":"approval_binding_refused"}` and retried up to the
   queue's attempt cap.
2. **Refusal hook.** If the deployment no longer lets this Bot run for this person (Use Bots, the
   model allowlist), nothing is run or continued. The refusal is saved and the request completed.
3. **Answers that need no run.** A declined request is answered with `DECLINED_BY_PERSON` and a
   hand-off marked done with `HANDLED_BY_PERSON`. Nothing is executed.
4. **Claim, then run.** An approved request is first re-checked by `validateReentry`: the tool is
   called again in probe mode, so current policy, grants and the resolved target are asked afresh.
   Then `consume` claims it in one conditional UPDATE under a row lock: `approved` → `consumed`, only
   while `result` is SQL NULL, and for "always allow" only while the rule still exists. Only the
   process whose claim succeeds runs the action. It runs through the same executor and gateway as the
   live call, so in device mode the command goes to the owner's paired machine. The approval gate
   recognises this approved action and lets it through once, without asking again.
5. **Save, then publish.** `saveResult` is a compare-and-set on the NULL result, so exactly one
   answer is kept. Only the process that saved it calls the `continue` dependency, which writes the
   tool result (message id `approval:<id>`) into the original conversation and resumes the Bot's
   turn. The request is then marked `completed`.

What happens after a crash or retry:

- **Claimed, nothing saved.** The row is `consumed` with no result, because the worker stopped
  mid-run. It is **never run again**. The next worker saves `APPROVAL_OUTCOME_UNKNOWN` (结果不明: the
  action was started, its outcome is unknown, it was not repeated) and continues the conversation
  with it. The Bot can then tell the person to check. A worker whose run finishes after that loses
  the compare-and-set, and its late result is not published.
- **Saved, not yet published.** For example, the model call behind `continue` failed. The retry
  re-sends the saved result and does not run the action again. Publishing is therefore at least once
  across that one crash window, always with the same message id. The action itself is at most once.
- **Concurrent workers.** Two workers can hold the same item only after its 15-minute lease has
  expired. Both can reach `consume`, and the row lock lets one of them win. The other returns without
  running or publishing.
- **Last attempt.** When the queue gives up, `abandon` never runs the action. It saves "could not be
  carried out" (or the outcome-unknown answer, if the run had been claimed) and continues the
  conversation once.

The Root-attested path (`continuationRecovery` / `freshProducer`, composed from a verified release
attestation in `approvals/local-recovery-composition.ts`) is unchanged. A composition that supplies
either port uses it instead of the database settlement. The server still never fabricates that
attestation. A service built with neither port and without `settlement: "database"` stays closed and
throws `ApprovalRecoveryBlockedError`, as before.

Still open: an approved chat-sourced card was moved back to `running` when the decision was
recorded. The continued turn now settles the request, but the restart sweep still does not close
such a card if its turn never finishes. Closing those cards safely is a separate projector change.
