# cloud-dev verify (B2 r4) — controlled plan executor

Pure Python standard library. Zero third-party dependencies, zero network,
zero writes to the repository. Part of the B-line toolset (B1 doctor, B2
verify, B3 baseline, B4 report) on branch `codex/workbuddy-cloud-validation-20261018`.
r4 adds the direct-target check on the approved Bun link (Root 51663785:
two-hop alias refused) on top of r3-fix (Root narrow-fix ticket 51663651,
two scoped fixes
over the r3 baseline 51663441/43/44/51; plans and reporting stay frozen).

## Usage

    python3 openbot/scripts/cloud-dev/verify.py --plan <name> \
        --repo-root <approved-repo> [--format json|markdown] \
        [--expect-plan-sha256 <hex>]

Registered plans (Root-frozen): `tool-self-check`, `smoke`.

Exit codes (one policy shared with `reporting.py` schema 1.1):

| exit | meaning |
| --- | --- |
| 0 | no failed step AND every required step completed (optional steps may be blocked/incomplete) |
| 1 | at least one step failed (a non-zero command is FAILED, never "expected") |
| 2 | nothing failed but a required step is blocked/skipped/unverified (e.g. trusted executable mismatch) |
| 3 | invalid invocation/registry/plan/trust-binding: one structured JSON error, never a traceback |

## Trust model (ticket 51661979 + r2 rework 51662812)

- Trust lives next to the tool's own deployment: `verify-registry.json`
  (Root-deployed, frozen, schema 1.1) and the two approved plan files in the
  tool directory. `--repo-root` never changes what is trusted; a same-named
  registry+plan inside the repo under test cannot self-authorize.
- Registry schema 1.1 fields: `schema_version` / `plans` /
  `trusted_tools` / `approved_repo_roots`.
  - `trusted_tools`: exactly `python3` and `bun`, each
    `{path, bytes, sha256}` where path is a REAL absolute file. Execution
    happens only through these byte-verified mappings — no `which`, no PATH
    fallback. Missing trusted binding (tool not registered) -> exit 3; the
    mapped file missing or size/sha256 mismatched -> blocked (honest
    environment state, exit 2 for a required step). On python3 the running
    interpreter (`sys.executable`) must equal the Root mapping.
  - `approved_repo_roots`: Root-frozen list of real absolute repo paths.
    `--repo-root` is realpath-resolved and must be on this list (exit 3
    otherwise); the CLI cannot override it and the tested repo cannot
    supply it.
- The complete argv/cwd/timeout contract of the only two approved plans is
  hardcoded (`FROZEN_PLANS`). A plan file must byte-hash-match the registry
  entry AND value-match the frozen contract; callers cannot gain authority
  by re-pairing registry+plan.
- `--expect-plan-sha256` only tightens (mismatch -> exit 3); it never
  registers or expands plans. Missing files, symlink aliases, version or
  hash mismatch -> exit 3.
- The registry is deployed by Root; until it exists verify exits 3 with
  `registry missing` (honest state, not a crash).

## Execution semantics

- Steps declare `depends_on`; failed/blocked/skipped/unverified predecessors
  block only their dependents; independent steps still run. Two independent
  halt conditions stop all further actual execution (reported to Root):
  unresolved resources after a step, OR a forced termination (timeout /
  group kill) whose `descendants_confirmed` is not proven True — EOF and
  direct reaping are NOT descendants proof. A natural exit (no timeout, no
  forced termination) with descendants still null does NOT halt.
- Trusted binding + prerequisites: the executable resolves ONCE through the
  Root mapping (above). `prereq_paths` must be regular files inside the
  repository at a NORMAL `node_modules/typescript/bin/tsc` layout (realpath-
  resolved; file or symlink aliases to `.env`/credentials/other in-repo
  locations and wrong layouts are refused), and the SAME typescript package
  (`package.json` adjacent to tsc) must pin name=typescript version 5.9.3.
  The version is judged through ONE composed path (r3 item 2, tightened by
  the r3-fix): the ORIGINAL LITERAL path is walked component by component
  BEFORE any symlink resolution (realpath-first would dissolve links and
  blind islink), every symlink component is refused, and exactly ONE alias
  shape is permitted by the Root-frozen contract: the dependency directory
  `openbot/node_modules/typescript` MAY be a (relative or absolute) link
  whose RAW target, resolved against the link's own directory, is EXACTLY
  `openbot/node_modules/.bun/typescript@5.9.3/node_modules/typescript`
  inside the SAME repo (r4 direct-target check, Root 51663785: a two-hop
  chain typescript -> in-repo hop -> canonical root is REFUSED even though
  its realpath lands on the canonical root); after approving it the walk
  continues inside the
  resolved target so no second hidden alias survives. `bin/tsc` and
  `package.json` bind to that same approved package root; package.json
  itself may never be a link (any symlink on it is refused before any
  read). A plain no-link layout is equally allowed; a real environment
  differing from this shape is simply blocked (never generalized to
  arbitrary `*/node_modules/typescript`). Only when every component is
  verified is the package.json opened ONCE and the version judged. Once
  any problem is found, no further open happens — the plan-level
  package.json read is skipped entirely (open-spy-tested: aliased targets
  — secret AND non-secret plain JSON/plain directories — are opened zero
  times).
  Step cwd additionally refuses any realpath resolving into a protected
  directory segment (`.env*`, `.ssh`, `.gnupg`, `.aws`, `.kube`). Unmet
  prerequisites are blocked, never executed-then-greenwashed.
- One total deadline equals `timeout_s` from spawn and covers process wait,
  pipe drain, reader join and reclamation. The process wait is bounded by
  deadline minus `REAP_RESERVE_S` (5s, at most half the budget) so
  reclamation always keeps budget; every later phase uses only the time
  remaining to the deadline — there are NO fixed post-deadline additions
  and NO positive lower bounds (r3 item 1): once the deadline has passed,
  `wait`/`join` receive a zero timeout and act as non-blocking probes only.
  The budget is proven by a fake-clock test asserting post-expiry wait/join
  calls never get a positive timeout, not by summing timeout parameters.
  Each stream keeps the first 64KiB of raw bytes and counts discarded bytes
  (memory-bounded; no full-capture-then-truncate). Invalid UTF-8 decodes
  with errors="replace". Stream evidence separates thread-finished /
  natural-EOF / read-error; a read error is never green. A step passes only
  when its streams closed naturally (EOF, no read error) and the direct
  child was reaped without any group kill; killing the group (e.g. a
  descendant holding the pipe) yields `unverified`.
- Reclaim evidence is field-separated: `termination_attempted`,
  `direct_child_reaped`, `group_signal_confirmed`, `descendants_confirmed`
  (null unless proven: stdlib cannot enumerate descendants, so tree-wide
  reclamation is never claimed as proven — not even when killpg succeeded).
  POSIX passes Popen `start_new_session=True` unconditionally (it is a Popen
  parameter, not an os attribute), so the child leads its own session/group
  and `killpg(proc.pid)` targets ONLY that group — never the verify group or
  unrelated processes; this is asserted by a real boundary test. Windows
  uses `taskkill /T /F` (bounded by the remaining budget) with reclamation
  reported unverified.
- Child environment: non-secret allowlist + `PYTHONDONTWRITEBYTECODE=1`.
  Non-inherited values feed a bounded redaction pass (canary-verifiable) so
  the report carries only a sanitized summary; raw output stays private
  cloud-side evidence for Root.
- Reports use `reporting.build_report` schema 1.1; one check per step; the
  overall status and exit code share the frozen reporting policy.

## Tests

    python3 -m unittest discover -s openbot/scripts/cloud-dev/tests

(from a Root-approved repository root). All tests are stdlib-only and
hermetic: plan integrity (unknown name, missing/symlinked registry, hash/
version mismatch, unregistered plan, unknown registry fields, schema-1.1
field validation, contract deviation with a re-recorded hash still refused),
registry 1.1 trusted-tools/approved-roots validation, trusted binding
(mapping resolution, no PATH fallback, missing/size/hash mismatch blocked,
running-interpreter match, unknown tool exit 3), repo-root approval,
BoundedReader done/eof/error separation (read error recorded, never
swallowed), dependency graph rejections, execution semantics with an
injected executor (stream read error unverified; exit 0 with unproven reap
unverified and halting; r3: forced termination with unknown descendants
halts, natural exit continues; timeout with unknown descendants halts),
open-spy TS-guard controls (package.json symlink to in-repo `.env`,
package.json symlink to a plain non-secret JSON with a correct pin,
parent directory alias to an unapproved plain directory, no read once
problems found, canonical-read symlink refusal, the single approved
Bun-store link shape passing with exactly one package.json read, a two-hop
alias (typescript -> in-repo hop -> the approved store, both hops pointing
at legitimate content) refused without any open, normal
layout reading package.json exactly once), a fake-clock deadline test
(concrete Popen-shaped fake: constructor receives the real argv/kwargs
incl. `start_new_session=True`, poll/kill present; post-expiry wait/join
never receive a positive timeout; budget proven by the clock), canary
redaction, zero-write dual snapshots,
CLI exit-3 contracts, and six REAL Popen boundary cases (normal / child in
own process group / large output truncation / bad UTF-8 with pure-ASCII
child source / parent-exit descendant holding the pipe -> unverified with
try/finally controlled cleanup / timeout group kill + reap within the
single budget plus <=1s scheduling slack; POSIX-gated, no network, fully
cleaned up). Self-tests never run the default plans.

## Limitations / honest boundaries

- TOCTOU between prerequisite checks and spawn on a steady cloud snapshot.
- Windows taskkill tree reclamation unverified; the path strategy follows
  the restricted-Linux tool policy (Windows not audited).
- `descendants_confirmed` stays null unless proven; unresolved resources or
  a forced termination with unproven descendants halt the plan and are
  reported to Root instead of being claimed reclaimed.
- The registry is Root-deployed; verify refuses to run any plan until the
  registry and plan bytes match the frozen contracts and the requested
  repo-root is a Root-approved real path.
