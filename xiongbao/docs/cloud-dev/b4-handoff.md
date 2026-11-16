# B4 — cloud-dev regression handoff exporter (`handoff.py`)

Read-only exporter: one reporting-1.1 `build_report` JSON document on stdin,
one human-facing handoff text on stdout. This page records provenance, the
frozen contract, boundaries and the static test inventory. Status: r3
delivered for Root review (r1 reworked per Root 51672915; r2/r2b per
51673103; tests narrowed per Root 51673474); cloud run gate pending. PG17
and runtime behaviour remain unverified (PG_PENDING).

## Input source (provenance)

- Reporting contract relayed by Root in 51665136 (interface capsule,
  21321B): `make_check` / `make_identity_block` / `summarize` /
  `overall_status` / `compute_exit_code` / `build_report` /
  `render_markdown`, exit policy pass=0 / fail=1 / incomplete=2, CLI-only
  exit 3.
- Full frozen `reporting.py` (5793B, sha256
  `0ecbb710cad3e31782327200269a96d293aaf86e4afb9b46a34d319029da8b21`)
  relayed and
  independently verified by Root in 51671805. This tool imports the
  deployed module and re-uses its policy and constants only; it never
  re-implements or copies the policy.
- Input card 51671154 (contract + 2 pure data examples) was corrected by
  Root 51671805: check.status uses the real five values
  `passed/failed/blocked/skipped/unverified` (shorthand `pass/fail`
  belongs to `overall_status`), and `expected/observed/details` accept
  arbitrary bounded JSON values (dict/list/null), not only strings.

## Frozen interface

- `main(argv=None)` / `run_cli(argv=None)`: no arguments, or
  `--format=text` (only `text` is supported in this revision; `--help`
  exits 0).
- Unknown flags, positional arguments or formats: exit 3, one stderr line,
  stdout stays empty.
- stdin: bounded read in a loop until true EOF with a 256 KiB total bound
  (+1 probe byte per read); short-read readers cannot hide a tail and
  stdin I/O errors map to exit 3. stdout: the text is built fully first,
  checked against the 4 MiB bound, then written once; a failed or short
  write is never treated as success (exit 3, one stderr line).
- Non-finite numbers are refused anywhere in the document: NaN/Infinity
  tokens and out-of-range number literals such as 1e999 (float inf) map
  to exit 3.
- Exit 0 = the export itself succeeded. This is NOT the report's quality
  verdict: the original report `exit_code` (0/1/2) stays displayed in the
  header and the footer repeats the distinction.
- Exit 3 = argument error or invalid/excessive input. The report is never
  silently fixed, re-scored or "greened".

## Validation (structural consistency only)

- Top level: exactly the 11 real `build_report` fields,
  `schema_version == "1.1"`; unknown or missing fields refused.
- `checks`: exactly 8 fields per check; `check_id`/`name`/`category`
  non-empty strings; `required` strict bool; `status` one of the real five
  values; duplicate `check_id` refused.
- Identity blocks: exactly `expected/observed/status/details`; unmeasured
  `observed` stays null and is never filled from the expected pin.
- `summary`: six counts, int-not-bool, non-negative, and equal to
  `reporting.summarize(checks)`; `total == len(checks)`;
  `overall_status` / `exit_code` must equal
  `reporting.overall_status` / `compute_exit_code`. Any mismatch: exit 3.
- JSON input refusals: duplicate keys at any depth, NaN/Infinity, lone
  surrogates, invalid UTF-8, parse/Recursion errors (no object code
  execution).
- Bounds: depth <= 8 (root = 0), <= 20000 nodes, <= 4096 checks, single
  string <= 64 KiB UTF-8, stdin <= 256 KiB, output <= 4 MiB.

## Command text is data

Values that look like commands are rendered as JSON data literals
(`json.dumps(ensure_ascii=True, sort_keys=True)`): reversible escaping of
control characters, newlines and non-ASCII. Nothing is executed, joined
into a shell line, wrapped in HTML, or parsed back into argv; no argv
extraction, no measurement or execution claims. Decoded values equal the
input item by item.

## Boundaries

- No file open/write; no subprocess/socket/HTTP; no exec/eval/dynamic code.
- `sys.dont_write_bytecode = True` is set before any other module import,
  so a normal script CLI run (`python handoff.py ...`) without `-B`
  cannot drop `__pycache__/*.pyc` files when importing the deployed
  reporting module. Scope: this in-file switch only applies from the
  moment the interpreter starts executing this module body. If another
  program imports handoff itself as a module, Python may cache the
  handoff module (and what it imports) before this line runs, and the
  switch cannot retroactively stop that; such import entries are outside
  the zero-write guarantee. A future import-style entry would need its
  own `-B` or a controlled loader gate; this package adds no import
  wiring and makes no claim beyond the script CLI entry.
- No trusted/signature generation, no third authorizer, no registry or
  shared reporting/verify changes; B3 outputs stay frozen.
- Text-only output; markdown is not supported in this revision.
- Old failed checks stay failed even when new=0; nothing is translated,
  summarized away or hidden, and passed groups are not omitted.

## Static test inventory

Delivered in `tests/test_handoff.py` (see the delivery post for the exact
counts). Coverage: per-item reversible roundtrip for every one of the 8
check fields and for identity blocks and notes; failed outranks required
blocked (fixture rebuilt through reporting.build_report so the summary is
recomputed); optional skipped does not block and zero groups shown; old
failed + new=0 stays failed; unmeasured identity stays null; malicious
strings (HTML/shell/real U+001B/newline/unicode) survive as reversible
JSON literals; `--help` exits 0; refusals for unknown flag, positional,
markdown format, oversized stdin, invalid UTF-8, invalid JSON, NaN
constant, non-finite number literals (+1e999 / -1e999 nested in expected,
observed and details), duplicate top-level/nested keys, lone surrogate,
wrong schema version, unknown/missing top fields, type errors,
bool-as-int counts, summary / overall / exit mismatches, status
shorthand, non-bool required, empty name, duplicate check_id, identity
block field mismatches, depth / node / string caps, >4096 checks,
control-character argv with exactly-one-line stderr, short-read true
EOF, first-chunk-valid-JSON-then-tail, second-chunk I/O error, stdout
write failure, stdout short write and output cap (explicitly shrunk
module constant, no exporter/policy mocking); run_main passes an
explicit argv so the helper is immune to host sys.argv (e.g. unittest
discover options); the real main(None) still reads real CLI argv and
refuses 3 on `--format=markdown`; an isolated-CLI no-bytecode witness
(definition only, unrun on delivery) replaces the earlier flag
assertion.

## r2 revision (Root 51672915)

- Non-finite numbers refused anywhere in the document: JSON NaN/Infinity
  tokens and out-of-range number literals such as 1e999 (parsed to float
  inf) map to exit 3; the export can no longer emit an Infinity literal.
- stdin is read in a loop until true EOF with a per-read remaining+1
  budget: short-read readers cannot hide a tail after a valid prefix, and
  stdin I/O errors map to exit 3.
- stdout write failures and short writes map to exit 3 with a fixed
  one-line diagnostic; already-written bytes are never claimed to be
  retractable.
- argparse diagnostics JSON-escape untrusted argv text (reversible), so
  stderr is always exactly one line without control-character injection.
- Tests reworked/added: per-item reversible roundtrip for every check
  field and for identity/notes; the failed-vs-blocked fixture is rebuilt
  through reporting.build_report so the summary is recomputed; the
  malicious-strings fixture now carries a real U+001B; real-main
  refusals for +1e999 / -1e999 nested in expected/observed/details;
  short-read true-EOF, first-chunk-tail and second-chunk I/O-error
  cases; stdout write failure and short write; output-cap refusal via an
  explicitly shrunk module constant; control-character argv with
  single-line stderr. Counts: 50 test_ methods, 13 non-test helpers,
  0 executed (no unittest run on delivery).
- Verification discipline: r2 was checked by pure in-RAM text, hashing
  and strict diff roundtrip only; no ast.parse/compile/import/execution
  of source on this machine (per Root instruction, factual receipt in
  the delivery ACK).
- Supplement (Root 51673103): `sys.dont_write_bytecode = True` is set
  before any other import, closing the static gap where a standalone CLI
  run without `-B`, in a writable directory with a missing cache, could
  let Python auto-write `__pycache__/reporting*.pyc`. No pyc write is
  known to have happened (static possibility only, now closed). Per Root
  51673474 the weak witness (asserting the flag after import, which could
  inherit a host-global switch) is replaced by a real isolated CLI test
  definition: a temp fixture copies the real handoff.py/reporting.py and
  spawns `sys.executable handoff.py --help` with no `-B`, no
  PYTHONDONTWRITEBYTECODE and no PYTHONPYCACHEPREFIX in the child env
  (removed, never set to "0"), asserting exit 0, the real help text and
  no `__pycache__`/`.pyc` in the fixture (fixed short timeout, no
  network). Definition delivered only: never spawned on this machine;
  it runs first in the cloud gate.

## r3 revision (Root 51673474)

- Test-runner argv pollution fixed on the test side only: run_main passes
  an explicit argv (`[]`) to handoff.main by default and keeps an
  explicitly passed argv, so host sys.argv under `unittest discover`
  cannot leak into argparse. The production `main(None)` behavior is
  unchanged and stays correct: real CLI argv is still read.
- Two-direction discriminating tests added: with sys.argv carrying
  unittest discover options, the helper's legal positive case still
  exports (exit 0, full header); and the real `main(None)` -- captured
  through real stdin/stdout/stderr, parser and policy never mocked --
  with sys.argv set to `["handoff.py", "--format=markdown"]` still
  refuses 3, proving real CLI options are not silently ignored.
- Weak bytecode witness replaced (see Supplement above): the isolated
  CLI test is a definition delivered unrun; it executes only in a real
  test session.
- handoff.py is frozen at r2b (13782B, sha256 `55199302...`): only
  `tests/test_handoff.py` and this document change in r3.
- Counts: 52 test_ methods, 13 non-test helpers, 0 executed (no
  unittest run, no spawn on delivery); helpers are counted by definition,
  not by unique name (5 module functions + `assert_refused` + 7 I/O
  stub-class methods).

## Pending verification

- Cloud run gate (Root): unittest + real CLI invocation pending (0run on
  delivery; no pass counts claimed).
- PG17 environment unavailable (PG_PENDING); runtime behaviour unverified.
- Tool exit 0 is not a quality pass; report exit_code 1/2 stay displayed.
