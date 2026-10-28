# cloud-dev doctor (B1) — read-only environment report

Pure Python standard library. Zero third-party dependencies, zero network,
zero writes to the repository. Part of the B-line toolset (B1 doctor, B2
verify, B3 baseline, B4 report) on branch `codex/workbuddy-cloud-validation-20261018`.

## Usage

    python3 openbot/scripts/cloud-dev/doctor.py --repo-root <repo> --format json|markdown

Exit codes (task book 51660868; one policy shared with `reporting.py`):

| exit | meaning |
| --- | --- |
| 0 | nothing failed and every required check passed (optional incomplete checks allowed) |
| 1 | at least one check failed (version mismatch, lock identity mismatch, path-not-allowed, ...) |
| 2 | no failures, but a required check is blocked/skipped/unverified (e.g. bun missing) |
| 3 | invalid invocation: unknown flag, bad `--format`, bad `--repo-root`; one structured JSON error on stdout, never a traceback |

`overall_status` in the JSON/Markdown report and the exit code are the same
policy: any failed check -> "fail" -> 1; required incomplete -> "incomplete" -> 2;
otherwise "pass" -> 0 (optional blocked/skipped/unverified never block).

## Checks (14)

| check | required | what it verifies |
| --- | --- | --- |
| `repo_layout_openbot_package_json` | yes | `openbot/package.json` (workspace root) exists |
| `repo_layout_root_package_json_absent` | yes | no `package.json` at repo root |
| `package_manager_declaration` | yes | `packageManager == bun@1.3.14` in `openbot/package.json` |
| `bun_lock_identity` | yes | `openbot/bun.lock` size 453991B and pinned SHA256 |
| `runtime_python` | yes | the running interpreter reports its version |
| `runtime_git` / `bun` / `node` / `npm` / `cargo` / `docker` | bun required, others optional | fixed argv `--version` probes |
| `git_identity` | no | guarded pure-file read of `.git` HEAD (branch + 40/64-hex commit) |
| `typescript_dependency` | no | locked TypeScript version `5.9.3` in `openbot/node_modules/typescript/package.json` |
| `env_var_names` | no | informational PATH/HOME presence and relevant variable NAMES only (values never reported) |

## Safety design

- Read allowlist: package and lock use exact ordinary literal paths; all symlink aliases, including aliases inside the repository, are refused. TypeScript permits a plain directory or the exact pinned Bun TypeScript 5.9.3 layout. Refusals remain structured, never guessed passes.
- Git metadata: every gitfile target is unsupported/unverified and never followed. Only an ordinary .git directory is supported; metadata/ref symlink aliases are refused. HEAD refs are restricted to valid refs/heads or refs/tags segments, commits to 40/64-hex; malformed UTF8 is structured unverified. These are stable-snapshot guards, not atomic race isolation.
- Runtime probes: fixed argv (`--version`), one absolute non-alias executable from the approved finite Linux locations, `shell=False`, and a minimal environment allowlist (`SAFE_ENV_KEYS`: platform essentials + proxy/CA). Provider secrets, `NODE_OPTIONS`/`BUN_OPTIONS`-style injection and preload variables never reach a probe process; probe environment VALUES never enter the report.
- Identity reporting separates declarations from observations: `baseline_identity.expected` / `candidate_identity.expected` carry the pinned values (from Root post 51660955); `observed` carries only what this run actually measured; the full source-tree hash is NOT computed by B1 (read-only, B3 scope) and stays `null` with block status `unverified`.
- Zero repository/tool-source writes: controlled verification compared both tool-source and fixture snapshots, including a fresh CLI child without -B or bytecode environment masking. This scoped evidence is not a claim about every host/runtime write.

## Tests

    python3 -m unittest discover -s openbot/scripts/cloud-dev/tests

(from the repository root; or `-s tests` from `openbot/scripts/cloud-dev`).
All tests are stdlib-only and deterministic: probes are injected (`FakeProber`),
CLI paths are driven through `main(argv, prober=...)`, and the subprocess
boundary is verified by capturing the real `subprocess.run` kwargs (resolved
absolute argv[0], `shell is False`, secret-free env). Symlink negative cases
require symlink privileges and are skipped (not silently passed) on platforms
without them.

## Limitations / honest boundaries

- The full source-tree SHA256 is a declaration (`baseline_identity.expected`), not a measurement; computing it is B3 scope.
- Missing `node_modules` makes the TypeScript check blocked (missing-dependency state); that is reported, not hidden. The historical 7 server type diagnostics are out of B1 scope; doctor does not run tsc and never installs dependencies.
- Probe locations are limited to /usr/bin, /bin, /usr/local/bin. Aliases, Windows and other locations remain blocked until separately reviewed; missing trusted bun yields honest incomplete/exit2.

## Codex narrow repair — actual controlled validation

Original author: ww / GLM5.3-flash. Boundary fixes: Codex.
Executor: Root-cloud-relay. Original author-reconciled six files preserved.

- No PATH-based runtime discovery: finite Linux trusted probe directories only,
  absolute regular non-alias executable resolved once; no fallback/relookup.
  Missing/unreviewed locations/platforms are blocked, never auto-installed.
- Package/lock must be exact plain paths, not even in-repository secret aliases.
  TS accepts a plain directory or only exact pinned Bun TypeScript layout.
- Gitfile targets are unverified, never followed; .git/ref symlink aliases refused.
  These guards assume a stable offline snapshot, not atomic filesystem race isolation.
- Malformed UTF8 metadata and non-object JSON yield structured unknown/failure.
- HOME/PATH presence is informational, never a required portability failure.
- doctor disables bytecode before local import. A fresh real CLI invalid-argument
  regression snapshots both separate tooldir and repo without -B/env masking.

Actual controlled evidence: 58 existing cases plus 3 output-boundary cases passed (61 tests, exit0) in one residual verification run; no old assertion/expectation removed. Fresh CLI no-B/no-bytecode-envmask regression remains in the suite and passed. Source snapshot unchanged during the run. Documentation was updated afterward only to record these results.

UnicodeError from the real subprocess text-decoding boundary is a structured failed check; non-text stdout with exit0 is unverified (not a guessed version/pass); nonzero process exit remains failed regardless of stdout shape. New cases mock the subprocess boundary, never execute an untrusted program.

Earlier controlled valid CLI returned exit2/incomplete for unavailable trusted Bun/other probes; dual tooldir/fixture snapshots unchanged. These facts are not Windows, arbitrary PATH, network/provisioning or product acceptance. Root retains final B1 acceptance authority.
