#!/usr/bin/env python3
"""cloud-dev verify (B2 r2): controlled plan executor. Python stdlib only.

Trust model (Root implementation ticket 51661979; r2 rework ticket 51662812):
  - Trust lives next to THIS tool's deployment, never in --repo-root:
    verify-registry.json (Root-deployed, frozen, schema 1.1) and the two
    approved plan files in this directory. No CLI flag can change the trusted
    root, registry, argv, cwd or timeout; a same-named registry+plan inside
    the repo under test can never self-authorize.
  - Registry schema 1.1 fields: schema_version / plans / trusted_tools /
    approved_repo_roots. trusted_tools holds Root-registered byte-verified
    executable mappings (path/bytes/sha256) for exactly python3 and bun;
    approved_repo_roots is the Root-frozen list of real absolute repo paths.
    Missing trusted binding -> exit 3; mapped file missing or hash mismatch
    -> blocked (exit 2 for a required step); there is NO PATH fallback and
    sys.executable must match the Root python3 mapping.
  - The complete argv/cwd/timeout contract of the ONLY two approved plans is
    hardcoded below (FROZEN_PLANS). A plan file must byte-hash-match the
    registry entry AND value-match the frozen contract field-for-field.
  - --expect-plan-sha256 only tightens (mismatch -> exit 3); it never
    registers or expands plans. Missing files, symlink aliases, version or
    hash mismatch -> exit 3.

Exit codes (shared reporting policy, schema 1.1):
  0 = no failed step AND every required step completed (optional steps may
      be blocked or incomplete)
  1 = at least one step failed (a non-zero command is FAILED, never "expected")
  2 = nothing failed but a required step is blocked/skipped/unverified
      (e.g. trusted executable mismatch: an honest environment state)
  3 = invalid invocation/registry/plan: one structured JSON error, no traceback

Bounded execution (r2: one total deadline): the deadline equals timeout_s and
covers process wait, pipe drain, reader join and reclamation. A fixed reserve
(REAP_RESERVE_S) is kept back from the process wait so reclamation always has
budget; every phase uses only the time remaining to the deadline -- there are
no fixed post-deadline additions. Each stream keeps at most the first 64KiB of
RAW bytes and counts discarded bytes; invalid UTF-8 decodes with
errors="replace". Stream evidence separates thread-finished / natural-EOF /
read-error: a read error is never green. Reclaim evidence is reported
field-by-field (termination_attempted / direct_child_reaped /
group_signal_confirmed / descendants_confirmed); killing the process group
proves the signal was sent and the direct child was reaped -- it does NOT
prove all descendants died, so descendants_confirmed stays null (unverified).
Unresolved resources stop all further actual execution and are reported to
Root.
"""

import sys

sys.dont_write_bytecode = True  # before importing repo modules: no pycache anywhere

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import threading
import time

import reporting
import doctor  # constants + pure-file readers only; importing triggers no probes

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
REGISTRY_NAME = "verify-registry.json"
REGISTRY_SCHEMA = "1.1"
TRUSTED_TOOL_KEYS = ("python3", "bun")

CAPTURE_MAX_BYTES = 64 * 1024
READ_CHUNK = 8192
DETAIL_HEAD_CHARS = 2048
REAP_RESERVE_S = 5.0      # kept back from the process wait for reclamation
TASKKILL_MAX_S = 15.0     # per-call cap, still bounded by the remaining budget

TS_VERSION_PIN = "5.9.3"

# Directory segments that must never host step cwd or prereq payloads, even
# when a symlink alias keeps them inside the repository (r2 item 5).
SECRET_DIR_SEGMENTS = (".env", ".ssh", ".gnupg", ".aws", ".kube")

# Minimal non-secret child environment (Root review B1 item 3 lineage).
SAFE_ENV_KEYS = (
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC",
    "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
)

BLOCKING_STATUSES = ("failed", "blocked", "skipped", "unverified")

# The ONLY approved plans: complete frozen contracts (ticket item 1).
FROZEN_PLANS = {
    "tool-self-check": {
        "file": "verify-plan-tool-self-check.json",
        "plan_version": "1",
        "max_timeout_s": 600,
        "step": {
            "id": "cloud-dev-unittest",
            "argv": ["python3", "-B", "-m", "unittest", "discover",
                     "-s", "openbot/scripts/cloud-dev/tests", "-p", "test_*.py"],
            "cwd": ".",
            "timeout_s": 180,
            "required": True,
            "capture": True,
            "depends_on": [],
            "prereq_paths": [],
        },
        "typescript_version_check": False,
    },
    "smoke": {
        "file": "verify-plan-smoke.json",
        "plan_version": "1",
        "max_timeout_s": 600,
        "step": {
            "id": "server-tsc-noemit",
            "argv": ["bun", "../node_modules/typescript/bin/tsc",
                     "--noEmit", "-p", "tsconfig.json"],
            "cwd": "openbot/server",
            "timeout_s": 300,
            "required": True,
            "capture": True,
            "depends_on": [],
            "prereq_paths": ["openbot/node_modules/typescript/bin/tsc"],
        },
        "typescript_version_check": True,
    },
}


class InvalidPlan(Exception):
    """Registry/plan integrity or trust-binding violation -> exit 3."""


class InvalidArguments(Exception):
    """Bad CLI invocation -> exit 3."""


def _is_within(child_real, parent_real):
    try:
        return os.path.commonpath([child_real, parent_real]) == parent_real
    except ValueError:  # different drives on Windows
        return False


def _secret_segment_violation(real_path, repo_root):
    """Return the offending directory segment(s), or None (r2 item 5).

    Scans the repo-relative part of a realpath-resolved path so a symlink
    alias into an in-repo secret directory (.env, .ssh, ...) is refused even
    though it never leaves the repository.
    """
    try:
        rel = os.path.relpath(real_path, repo_root)
    except ValueError:
        return None
    parts = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]
    hits = sorted(set(p for p in parts
                      if p in SECRET_DIR_SEGMENTS or p.startswith(".env")))
    return ",".join(hits) if hits else None


# --------------------------------------------------------------------------
# Registry + plan loading (trust source: tool deployment directory only)
# --------------------------------------------------------------------------

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _validate_trusted_tools(trusted):
    if not isinstance(trusted, dict) or set(trusted) != set(TRUSTED_TOOL_KEYS):
        raise InvalidPlan("registry trusted_tools must hold exactly %s"
                          % (", ".join(TRUSTED_TOOL_KEYS),))
    for tool, entry in trusted.items():
        if not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"}:
            raise InvalidPlan("trusted_tools entry schema invalid for %r" % (tool,))
        if not isinstance(entry["path"], str) or not os.path.isabs(entry["path"]):
            raise InvalidPlan("trusted_tools path must be a real absolute path for %r" % (tool,))
        if not isinstance(entry["bytes"], int) or isinstance(entry["bytes"], bool) or entry["bytes"] <= 0:
            raise InvalidPlan("trusted_tools bytes must be a positive int for %r" % (tool,))
        if not isinstance(entry["sha256"], str) or not _HEX64.fullmatch(entry["sha256"]):
            raise InvalidPlan("trusted_tools sha256 must be 64-hex for %r" % (tool,))


def load_registry(tool_dir=TOOL_DIR):
    path = os.path.join(tool_dir, REGISTRY_NAME)
    if os.path.islink(path):
        raise InvalidPlan("registry is a symlink alias: refused")
    if not os.path.isfile(path):
        raise InvalidPlan("registry missing (Root-deployed file): %s" % path)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as err:
        raise InvalidPlan("registry unreadable: %s" % err)
    required = {"schema_version", "plans", "trusted_tools", "approved_repo_roots"}
    if not isinstance(data, dict) or set(data) != required:
        raise InvalidPlan("registry schema invalid (unknown/missing top fields)")
    if data["schema_version"] != REGISTRY_SCHEMA or not isinstance(data["plans"], dict):
        raise InvalidPlan("registry schema invalid (version/plans type)")
    for name, entry in data["plans"].items():
        if not isinstance(entry, dict) or set(entry) != {"plan_version", "plan_sha256"}:
            raise InvalidPlan("registry entry schema invalid for %r" % (name,))
        if not isinstance(entry["plan_version"], str):
            raise InvalidPlan("registry plan_version must be a string for %r" % (name,))
        if not isinstance(entry["plan_sha256"], str) or not _HEX64.fullmatch(entry["plan_sha256"]):
            raise InvalidPlan("registry plan_sha256 must be 64-hex for %r" % (name,))
    _validate_trusted_tools(data["trusted_tools"])
    approved = data["approved_repo_roots"]
    if (not isinstance(approved, list) or not approved
            or any(not isinstance(p, str) or not p or not os.path.isabs(p) for p in approved)):
        raise InvalidPlan("approved_repo_roots must be a non-empty list of real absolute paths")
    return data


def load_plan(tool_dir, name):
    """Load plan bytes for a frozen plan name; integrity-checked.

    Returns (data, raw_bytes, registry). Raises InvalidPlan on: unknown name,
    missing file, symlink alias, registry hash/version mismatch, or any
    deviation from the hardcoded frozen contract (ticket item 1).
    """
    spec = FROZEN_PLANS.get(name)
    if spec is None:
        raise InvalidPlan("unknown plan name (only frozen plans are executable): %r" % (name,))
    path = os.path.join(tool_dir, spec["file"])
    if os.path.islink(path):
        raise InvalidPlan("plan file is a symlink alias: refused (%s)" % spec["file"])
    if not os.path.isfile(path):
        raise InvalidPlan("plan file missing: %s" % spec["file"])
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as err:
        raise InvalidPlan("plan file unreadable: %s (%s)"
                          % (spec["file"], type(err).__name__)) from err
    registry = load_registry(tool_dir)
    entry = registry["plans"].get(name)
    if entry is None:
        raise InvalidPlan("plan not registered: %r" % (name,))
    digest = hashlib.sha256(raw).hexdigest()
    if digest != entry["plan_sha256"]:
        raise InvalidPlan("plan file hash mismatch (registry %s != file %s)"
                          % (entry["plan_sha256"][:12], digest[:12]))
    if entry["plan_version"] != spec["plan_version"]:
        raise InvalidPlan("plan version mismatch for %r" % (name,))
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as err:
        raise InvalidPlan("plan file is not valid UTF-8 JSON: %s" % err)
    expected = {
        "schema_version": "1.1",
        "plan_name": name,
        "plan_version": spec["plan_version"],
        "max_timeout_s": spec["max_timeout_s"],
        "steps": [dict(spec["step"])],
    }
    if data != expected:
        raise InvalidPlan("plan does not match the frozen contract for %r "
                          "(argv/cwd/timeout and all step fields must equal the "
                          "Root-frozen values)" % (name,))
    return data, raw, registry


def execution_order(plan_data):
    """DFS topological order; raises InvalidPlan on unknown dep or cycle."""
    steps = plan_data["steps"]
    by_id = {}
    for step in steps:
        if step["id"] in by_id:
            raise InvalidPlan("duplicate step id: %r" % (step["id"],))
        by_id[step["id"]] = step
    order, state = [], {}

    def visit(step):
        mark = state.get(step["id"])
        if mark == "done":
            return
        if mark == "visiting":
            raise InvalidPlan("dependency cycle at step %r" % (step["id"],))
        state[step["id"]] = "visiting"
        for dep in step["depends_on"]:
            if dep not in by_id:
                raise InvalidPlan("step %r depends on unknown id %r" % (step["id"], dep))
            visit(by_id[dep])
        state[step["id"]] = "done"
        order.append(step)

    for step in steps:
        visit(step)
    return order


# --------------------------------------------------------------------------
# Path resolution and trusted executable binding (r2 items 2+4+5)
# --------------------------------------------------------------------------

def resolve_repo_root(raw, registry):
    """Realpath the requested root; it MUST be a Root-approved real path."""
    if not raw or not isinstance(raw, str):
        raise InvalidArguments("repo-root must be a non-empty string")
    root = os.path.abspath(raw)
    if not os.path.isdir(root):
        raise InvalidArguments("repo-root is not an existing directory: %r" % (raw,))
    resolved = os.path.realpath(root)
    approved = [os.path.realpath(p) for p in registry["approved_repo_roots"]]
    if resolved not in approved:
        raise InvalidPlan("repo-root is not a Root-approved path (registry "
                          "approved_repo_roots): %s" % resolved)
    return resolved


def resolve_step_cwd(repo_root, rel):
    """Literal + real-path + secret-segment guard. Returns (abs_dir, None) or
    (None, reason)."""
    literal = os.path.normpath(os.path.abspath(os.path.join(repo_root, rel)))
    if not _is_within(literal, repo_root):
        raise InvalidPlan("step cwd escapes repository: %r" % (rel,))
    resolved = os.path.realpath(literal)
    if not _is_within(resolved, repo_root):
        raise InvalidPlan("step cwd escapes repository via symlink: %r" % (rel,))
    violation = _secret_segment_violation(resolved, repo_root)
    if violation:
        return None, ("step cwd resolves into a protected directory segment "
                      "(%s): %s" % (violation, rel))
    if not os.path.isdir(resolved):
        return None, "prerequisite-cwd-missing: %s" % rel
    return resolved, None


def _verify_trusted_file(entry):
    """Byte-verify a Root-registered executable mapping. Returns (path, None)
    or (None, reason). Physical mismatch is an environment state (blocked),
    not an authorization failure (exit 3)."""
    path = entry["path"]
    try:
        if not os.path.isfile(path):
            return None, "trusted executable missing: %s" % path
        size = os.path.getsize(path)
        if size != entry["bytes"]:
            return None, ("trusted executable size mismatch (%s: registry %d != on-disk %d)"
                          % (path, entry["bytes"], size))
        digest = _sha256_file(path)
    except OSError as err:
        return None, "trusted executable unreadable: %s (%s)" % (path, type(err).__name__)
    if digest != entry["sha256"]:
        return None, "trusted executable sha256 mismatch: %s" % path
    return path, None


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_executable(name, registry):
    """Resolve ONCE to the Root-registered byte-verified mapping.

    No PATH fallback, no which(). python3/python must additionally equal the
    running interpreter (sys.executable). Missing trusted binding (tool not
    in the Root registry) is an authorization failure -> InvalidPlan (exit 3);
    a mapped file that is missing or byte-mismatched is an environment state
    -> (None, reason) which the step reports as blocked.
    """
    key = "python3" if name in ("python3", "python") else name
    trusted = registry.get("trusted_tools", {})
    if key not in trusted:
        raise InvalidPlan("no trusted binding for tool %r (Root registry)" % (name,))
    entry = trusted[key]
    path, reason = _verify_trusted_file(entry)
    if path is None:
        return None, reason
    if key == "python3":
        running = os.path.realpath(sys.executable or "")
        if running != os.path.realpath(path):
            return None, ("running interpreter does not match the Root python3 "
                          "mapping: %s != %s" % (sys.executable, entry["path"]))
    return path, "root-mapping"


BUN_LINK_REL = os.path.join("openbot", "node_modules", "typescript")
BUN_LINK_TARGET_REL = os.path.join("openbot", "node_modules", ".bun",
                                   "typescript@5.9.3", "node_modules",
                                   "typescript")


def _approved_bun_link(repo_root):
    """Root-frozen contract (r3-fix item 1): the ONLY permitted alias is the
    dependency directory openbot/node_modules/typescript, and its normalized
    target must be EXACTLY openbot/node_modules/.bun/typescript@5.9.3/
    node_modules/typescript inside the SAME repo. Any other link position or
    target is refused. Relative links are acceptable but must normalize to
    this canonical target. This is the allowed shape, not a claim that the
    observed environment uses it: a real environment that differs is simply
    blocked (never generalized to arbitrary */node_modules/typescript)."""
    return (os.path.normpath(os.path.join(repo_root, BUN_LINK_REL)),
            os.path.normpath(os.path.join(repo_root, BUN_LINK_TARGET_REL)))


def _open_component_problems(repo_root, abs_path, allow_bun_link=False):
    """r3-fix item 1: verify EVERY component of the ORIGINAL LITERAL path
    (before any symlink resolution) from repo_root down to abs_path. The r3
    bug is fixed here: realpath-ing first dissolved literal symlinks so
    os.path.islink could never see them. Any symlink component is refused
    EXCEPT the single approved Bun-store link, whose RAW link target must
    resolve (against the link's own directory) EXACTLY to the canonical
    package root -- a two-hop chain through any in-repo hop is refused even
    though its realpath would land on the canonical root -- and whose
    normalized realpath must equal the canonical root exactly; after
    approving it the walk
    continues INSIDE the resolved target (checking the remaining components
    for links), so no second hidden alias can survive. tsc and package.json
    bind to the SAME approved package root; package.json itself may never be
    a link. Returns [] only when the open is approved."""
    literal = os.path.normpath(abs_path)
    if not _is_within(literal, repo_root):
        return ["path escapes repository: %s" % abs_path]
    if allow_bun_link:
        allowed_literal, allowed_target = _approved_bun_link(repo_root)
    else:
        allowed_literal = allowed_target = None
    rel = os.path.relpath(literal, repo_root)
    parts = rel.split(os.sep)
    cur = repo_root
    for i, part in enumerate(parts):
        cur = os.path.normpath(os.path.join(cur, part))
        if os.path.islink(cur):
            if allowed_literal is not None and cur == allowed_literal:
                # r4 direct-target check (Root 51663785): the link must point
                # DIRECTLY at the canonical root. A two-hop chain
                # typescript -> in-repo hop -> canonical root would otherwise
                # pass because realpath(cur) already equals allowed_target;
                # resolve the RAW link target against the link's own
                # directory (relative or absolute) and require exact equality
                # BEFORE any realpath resolution.
                raw_target = os.readlink(cur)
                direct_target = os.path.normpath(os.path.join(
                    os.path.dirname(cur), raw_target))
                if direct_target != allowed_target:
                    return ["bun dependency link does not point directly at "
                            "the approved canonical package root: %s" % rel]
                target = os.path.normpath(os.path.realpath(cur))
                if target != allowed_target or not _is_within(target, repo_root):
                    return ["bun dependency link target is not the approved "
                            "canonical package root: %s" % rel]
                tail = parts[i + 1:]
                inner = target
                for tpart in tail:
                    inner = os.path.normpath(os.path.join(inner, tpart))
                    if os.path.islink(inner):
                        return ["symlink component after the approved link: "
                                "%s" % rel]
                break
            return ["unapproved symlink component in path: %s" % rel]
    real = os.path.realpath(literal)
    if not _is_within(real, repo_root):
        return ["path escapes repository"]
    violation = _secret_segment_violation(real, repo_root)
    if violation:
        return ["protected directory segment (%s)" % violation]
    if not os.path.isfile(real):
        return ["missing or not a regular file"]
    return []


def _read_approved_json(abs_path):
    """Open an ALREADY-VERIFIED regular file (approved by
    _open_component_problems; no symlink component remains). Callers must
    run the component verification first -- this function itself opens
    unconditionally by design and is never called on unverified paths."""
    try:
        with open(abs_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, UnicodeDecodeError, ValueError):
        return None


def _ts_layout_and_version_problems(repo_root, rel):
    """r3 item 2: ONE composed path -- verify the TS layout and the approved
    files first, then (only when every component is verified) read the SAME
    package's fixed package.json and judge the version. Any layout/secret/
    alias problem stops BEFORE any open. Returns (problems, version_judged).
    """
    problems = []
    literal = os.path.normpath(os.path.abspath(os.path.join(repo_root, rel)))
    real = os.path.realpath(literal)
    bin_dir = os.path.dirname(real)
    pkg_dir = os.path.dirname(bin_dir)
    if (os.path.basename(bin_dir) != "bin"
            or os.path.basename(pkg_dir) != "typescript"
            or os.path.basename(os.path.dirname(pkg_dir)) != "node_modules"):
        problems.append("prereq layout is not node_modules/typescript/bin/tsc "
                        "(aliases refused): %s" % rel)
        return problems, False
    violation = _secret_segment_violation(real, repo_root)
    if violation:
        problems.append("prereq resolves into a protected directory segment "
                        "(%s): %s" % (violation, rel))
        return problems, False
    tsc_problems = _open_component_problems(repo_root, literal,
                                            allow_bun_link=True)
    if tsc_problems:
        problems.append("prereq tsc: %s (%s)" % ("; ".join(tsc_problems), rel))
        return problems, False
    pkg_json_abs = os.path.join(pkg_dir, "package.json")
    # Same approved package root as tsc (r3-fix item 1); package.json itself
    # may never be a link -- the walk refuses it before any read.
    pkg_problems = _open_component_problems(repo_root, pkg_json_abs,
                                            allow_bun_link=True)
    if pkg_problems:
        problems.append("typescript package.json: %s (%s)"
                        % ("; ".join(pkg_problems), pkg_json_abs))
        return problems, False
    data = _read_approved_json(pkg_json_abs)
    if (not isinstance(data, dict) or data.get("name") != "typescript"
            or data.get("version") != TS_VERSION_PIN):
        problems.append("typescript package.json adjacent to tsc must pin "
                        "name=typescript version=%s (same package)" % TS_VERSION_PIN)
        return problems, False
    return problems, True


def check_prereqs(plan_name, repo_root, step, exec_abs):
    """Pre-flight for one step. Returns list of problem strings (empty=OK).

    TS prereq must be a regular file inside the repository at a normal
    node_modules/typescript/bin/tsc layout (symlink or file aliases to
    .env/credentials/outside are refused) and the SAME typescript package
    must pin version 5.9.3, judged through the single composed path of
    _ts_layout_and_version_problems (r3 item 2: no open before approval,
    and no plan-level package.json read once any problem was found).
    Steady cloud snapshot: TOCTOU between this check and spawn is a
    declared limitation.
    """
    problems = []
    if exec_abs is None:
        problems.append("prerequisite-executable-missing: %s" % step["argv"][0])
    version_judged = False
    for rel in step["prereq_paths"]:
        literal = os.path.normpath(os.path.abspath(os.path.join(repo_root, rel)))
        if not _is_within(literal, repo_root):
            problems.append("prereq path escapes repository: %s" % rel)
            continue
        real = os.path.realpath(literal)
        if not _is_within(real, repo_root):
            problems.append("prereq path is a symlink alias out of repository: %s" % rel)
        elif not os.path.isfile(real):
            problems.append("prereq path missing or not a regular file: %s" % rel)
        else:
            tsc_problems, judged = _ts_layout_and_version_problems(repo_root, rel)
            problems.extend(tsc_problems)
            version_judged = version_judged or judged
    spec = FROZEN_PLANS.get(plan_name, {})
    if spec.get("typescript_version_check") and not version_judged and not problems:
        # Plan-level dependency version judgement on the canonical layout,
        # still only through the component-verified composed path (r3 item 2:
        # skipped entirely when problems were already found -- zero opens).
        pkg_json_abs = os.path.normpath(os.path.join(
            repo_root, "openbot", "node_modules", "typescript", "package.json"))
        pkg_problems = _open_component_problems(repo_root, pkg_json_abs,
                                                allow_bun_link=True)
        if pkg_problems:
            problems.append("typescript package.json: %s"
                            % "; ".join(pkg_problems))
        else:
            data = _read_approved_json(pkg_json_abs)
            if (not isinstance(data, dict)
                    or data.get("version") != TS_VERSION_PIN):
                problems.append("typescript dependency version != %s (prereq)"
                                % TS_VERSION_PIN)
    return problems


# --------------------------------------------------------------------------
# Environment, redaction (ticket item 6)
# --------------------------------------------------------------------------

def build_safe_env(environ=None):
    src = os.environ if environ is None else environ
    env = dict((key, src[key]) for key in SAFE_ENV_KEYS if key in src)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def collect_excluded_env_values(environ=None):
    """Values NOT inherited by children (bounded canary redaction source)."""
    src = os.environ if environ is None else environ
    values = []
    for key, value in sorted(src.items()):
        if key in SAFE_ENV_KEYS:
            continue
        if isinstance(value, str) and 8 <= len(value) <= 256 and not any(c.isspace() for c in value):
            values.append(value)
        if len(values) >= 64:
            break
    return values


def sanitize(text, excluded_values):
    """Bounded redaction of not-inherited secret values (canary-verifiable)."""
    for value in excluded_values:
        if value in text:
            text = text.replace(value, "[REDACTED]")
    return text


# --------------------------------------------------------------------------
# Bounded process execution (r2 items 1+2+3)
# --------------------------------------------------------------------------

class BoundedReader(threading.Thread):
    """Keeps at most CAPTURE_MAX_BYTES of RAW bytes; counts the rest.

    Evidence is separated (r2 item 3): `done` means the reader thread ended
    (any outcome), `eof` means the stream reached natural EOF, `error` is a
    non-None description when reading failed. A read error is never treated
    as a complete stream, so it can never greenwash a step.
    """

    def __init__(self, stream):
        super().__init__(daemon=True)
        self.stream = stream
        self.chunks = []
        self.kept = 0
        self.discarded = 0
        self.done = False
        self.eof = False
        self.error = None

    def run(self):
        try:
            while True:
                chunk = self.stream.read(READ_CHUNK)
                if not chunk:
                    self.eof = True
                    break
                room = CAPTURE_MAX_BYTES - self.kept
                if room > 0:
                    keep = chunk[:room]
                    self.chunks.append(keep)
                    self.kept += len(keep)
                    self.discarded += len(chunk) - len(keep)
                else:
                    self.discarded += len(chunk)
        except (OSError, ValueError) as err:
            self.error = "%s: %s" % (type(err).__name__, err)
        finally:
            try:
                self.stream.close()
            except OSError:
                pass
            self.done = True

    def raw_bytes(self):
        return b"".join(self.chunks)

    def text(self):
        return self.raw_bytes().decode("utf-8", "replace")


def _remaining(deadline):
    # r3 item 1: no positive floor. Once the deadline has passed this returns
    # 0.0, so subprocess.wait/join act as NON-BLOCKING probes only.
    return max(0.0, deadline - time.monotonic())


def _terminate_group(proc, evidence, budget_s):
    """Send the kill signal; record what is actually proven (item 4).

    On POSIX the child runs in its own session/group (Popen
    start_new_session=True), so killpg targets ONLY that group -- never the
    verify process group or unrelated processes. The signal call proves the
    signal was sent; it does NOT prove descendants died.
    """
    evidence["termination_attempted"] = True
    if os.name == "posix" and hasattr(os, "killpg"):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            evidence["group_signal_confirmed"] = True
        except OSError:
            evidence["group_signal_confirmed"] = False
    else:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True,
                           timeout=max(0.5, min(TASKKILL_MAX_S, budget_s)))
            evidence["group_signal_confirmed"] = None  # unverified on Windows
        except (OSError, subprocess.SubprocessError):
            evidence["group_signal_confirmed"] = None


def run_step_process(argv_resolved, cwd_abs, timeout_s, env):
    """Run one resolved step under a SINGLE total deadline.

    The deadline is timeout_s from spawn and covers wait, drain, join and
    reclamation. The process wait is bounded by deadline minus REAP_RESERVE_S
    (reserve >= REAP_RESERVE_S, at most half the budget) so reclamation always
    keeps budget; every later phase uses only the time remaining to the
    deadline. exit_code may be None when the child could not be reaped.
    descendants_confirmed stays null unless proven (stdlib cannot enumerate
    descendants, so tree-wide reclamation is never claimed as proven).
    """
    evidence = {
        "termination_attempted": False,
        "direct_child_reaped": False,
        "group_signal_confirmed": None,
        "descendants_confirmed": None,
    }
    popen_kwargs = dict(cwd=cwd_abs, env=env, stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if os.name == "posix":
        # start_new_session is a Popen parameter (r2 item 1): pass it
        # unconditionally on POSIX so the child gets its own session/group
        # and killpg(proc.pid) can never hit the wrong group.
        popen_kwargs["start_new_session"] = True
    started = time.monotonic()
    budget = max(0.1, float(timeout_s))
    deadline = started + budget
    reserve = min(REAP_RESERVE_S, budget / 2.0)
    run_until = deadline - reserve
    try:
        proc = subprocess.Popen(argv_resolved, **popen_kwargs)
    except OSError as err:
        # No child handle was acquired. Do not catch wait/read/reap failures
        # after this boundary or reclassify unknown running resources.
        return {"status": "blocked",
                "expected": "trusted executable starts",
                "observed": "process launch failed before child acquisition",
                "details": "Popen failed before child acquisition (%s)"
                           % type(err).__name__}
    readers = [BoundedReader(proc.stdout), BoundedReader(proc.stderr)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        # r3 item 1: max(0.0, ...) -- at/after run_until this is a
        # non-blocking probe, never a positive extension of the budget.
        proc.wait(timeout=max(0.0, run_until - time.monotonic()))
    except subprocess.TimeoutExpired:
        timed_out = True
    if timed_out:
        _terminate_group(proc, evidence, _remaining(deadline))
    # Drain/join bounded by the SAME deadline (never fixed additions); the
    # pre-kill join stops at run_until so the reserve stays available for
    # post-kill cleanup (r2 item 2), and post-expiry joins are 0-timeout
    # probes (r3 item 1).
    for reader in readers:
        reader.join(timeout=max(0.0, run_until - time.monotonic()))
    unresolved = any(not reader.done for reader in readers)
    if unresolved:
        # Parent may have exited 0 while a descendant still holds the pipe:
        # bounded cleanup inside the budget, then report honestly (never an
        # infinite join).
        _terminate_group(proc, evidence, _remaining(deadline))
        for reader in readers:
            reader.join(timeout=_remaining(deadline))
        unresolved = any(not reader.done for reader in readers)
    try:
        proc.wait(timeout=_remaining(deadline))
        evidence["direct_child_reaped"] = True
    except subprocess.TimeoutExpired:
        evidence["direct_child_reaped"] = False
    reclaim_ok = (evidence["direct_child_reaped"]
                  and evidence["group_signal_confirmed"] is not False)
    return {
        "exit_code": proc.returncode,
        "timed_out": timed_out,
        "stdout": readers[0].text(),
        "stderr": readers[1].text(),
        "stdout_done": readers[0].done,
        "stderr_done": readers[1].done,
        "stdout_eof": readers[0].eof,
        "stderr_eof": readers[1].eof,
        "stdout_error": readers[0].error,
        "stderr_error": readers[1].error,
        "stdout_kept_bytes": readers[0].kept,
        "stderr_kept_bytes": readers[1].kept,
        "stdout_discarded_bytes": readers[0].discarded,
        "stderr_discarded_bytes": readers[1].discarded,
        "termination": dict(evidence),
        "resources_unresolved": bool(unresolved or not reclaim_ok),
        "duration_s": round(time.monotonic() - started, 3),
    }


def _head(text):
    return text[:DETAIL_HEAD_CHARS]


def default_executor(plan_name, repo_root, step, registry):
    """Trusted binding + prereq flight + bounded process run for one step."""
    exec_abs, exec_how = resolve_executable(step["argv"][0], registry)
    cwd_abs, cwd_problem = resolve_step_cwd(repo_root, step["cwd"])
    problems = check_prereqs(plan_name, repo_root, step, exec_abs)
    if cwd_problem:
        problems.append(cwd_problem)
    if problems:
        return {"status": "blocked", "problems": problems,
                "expected": "resolvable trusted prerequisites",
                "observed": "prerequisites not met",
                "details": "; ".join(problems)[:DETAIL_HEAD_CHARS]}
    argv_resolved = [exec_abs] + list(step["argv"][1:])
    result = run_step_process(argv_resolved, cwd_abs, step["timeout_s"],
                              build_safe_env())
    result["argv_resolved"] = argv_resolved
    result["cwd_abs"] = cwd_abs
    result["exec_how"] = exec_how
    result["redaction_values"] = collect_excluded_env_values()
    return result


def _result_check(step, result, excluded_values):
    """Turn an executor result into a reporting check (item 3: no greenwash)."""
    if result.get("status") == "blocked":
        return reporting.make_check(
            step["id"], step["id"], "verify", "blocked", bool(step["required"]),
            expected=result.get("expected"), observed=result.get("observed"),
            details=result.get("details"))
    details = {}
    if "argv_resolved" in result:
        details["argv_resolved"] = result["argv_resolved"]
        details["cwd"] = result.get("cwd_abs")
    termination = result.get("termination", {})
    details.update({
        "exit_code": result.get("exit_code"),
        "timed_out": result.get("timed_out"),
        "duration_s": result.get("duration_s"),
        "stdout_done": result.get("stdout_done"),
        "stderr_done": result.get("stderr_done"),
        "stdout_eof": result.get("stdout_eof"),
        "stderr_eof": result.get("stderr_eof"),
        "stdout_error": result.get("stdout_error"),
        "stderr_error": result.get("stderr_error"),
        "stdout_kept_bytes": result.get("stdout_kept_bytes"),
        "stderr_kept_bytes": result.get("stderr_kept_bytes"),
        "stdout_discarded_bytes": result.get("stdout_discarded_bytes"),
        "stderr_discarded_bytes": result.get("stderr_discarded_bytes"),
        "termination": termination,
    })
    details["stdout_head"] = _head(sanitize(result.get("stdout", ""), excluded_values))
    details["stderr_head"] = _head(sanitize(result.get("stderr", ""), excluded_values))
    details_json = json.dumps(details, ensure_ascii=False, sort_keys=True)[:8192]
    expected = "exit 0 within %ss" % step["timeout_s"]
    observed = "exit %s" % result.get("exit_code")
    if result.get("timed_out"):
        return reporting.make_check(step["id"], step["id"], "verify", "failed",
                                    bool(step["required"]), expected=expected,
                                    observed="timeout", details=details_json)
    if result.get("exit_code") != 0:
        return reporting.make_check(step["id"], step["id"], "verify", "failed",
                                    bool(step["required"]), expected=expected,
                                    observed=observed, details=details_json)
    if result.get("resources_unresolved"):
        return reporting.make_check(
            step["id"], step["id"], "verify", "unverified", bool(step["required"]),
            expected=expected, observed="resources unresolved (reclaim not proven)",
            details=details_json)
    if result.get("stdout_error") or result.get("stderr_error"):
        # A read error means captured evidence is incomplete: never green.
        return reporting.make_check(
            step["id"], step["id"], "verify", "unverified", bool(step["required"]),
            expected=expected, observed="stream read error (evidence incomplete)",
            details=details_json)
    streams_closed = (result.get("stdout_done") and result.get("stderr_done")
                      and result.get("stdout_eof") and result.get("stderr_eof"))
    if (streams_closed
            and not result.get("termination", {}).get("termination_attempted")
            and result.get("termination", {}).get("direct_child_reaped")):
        # A step only passes when its streams closed naturally (EOF, no read
        # error) and the direct child was reaped without any group kill: if
        # we had to kill the group (e.g. a descendant holding the pipe), the
        # honest status is unverified even when bytes were eventually captured.
        return reporting.make_check(step["id"], step["id"], "verify", "passed",
                                    bool(step["required"]), expected=expected,
                                    observed=observed, details=details_json)
    return reporting.make_check(step["id"], step["id"], "verify", "unverified",
                                bool(step["required"]), expected=expected,
                                observed="reclaim or stream evidence incomplete",
                                details=details_json)


def execute_plan(plan_name, plan_data, repo_root, executor=None, registry=None):
    """Execute a validated plan; returns (checks, extra_notes).

    Dependency rule (item 3): failed/blocked/skipped/unverified predecessors
    block only their dependents; independent steps still run. Unresolved
    resources from a step stop all FURTHER actual execution (item 4); r3
    item 3 adds the independent halt: forced termination (timeout or group
    kill) with descendants_confirmed not proven True also halts -- EOF is
    not proof descendants died. A NATURAL exit (no timeout, no forced
    termination) with descendants still null does NOT halt.
    The default executor is the trusted-binding bounded Popen path; tests
    inject fakes and never run the default plans recursively. A real
    execution (executor=None) requires the Root registry for trusted binding.
    """
    if executor is None:
        if registry is None:
            raise InvalidArguments("real execution requires the Root registry")
        def executor(step):
            return default_executor(plan_name, repo_root, step, registry)
    excluded_values = collect_excluded_env_values()
    checks = []
    statuses = {}
    unresolved_halt = False
    for step in execution_order(plan_data):
        if unresolved_halt:
            checks.append(reporting.make_check(
                step["id"], step["id"], "verify", "blocked", bool(step["required"]),
                expected="executable step", observed="not executed",
                details="halted: unresolved resources or forced termination "
                        "with unproven descendants after an earlier step "
                        "(reported to Root)"))
            statuses[step["id"]] = "blocked"
            continue
        bad_dep = None
        for dep in step["depends_on"]:
            if statuses.get(dep) in BLOCKING_STATUSES:
                bad_dep = (dep, statuses[dep])
                break
        if bad_dep is not None:
            checks.append(reporting.make_check(
                step["id"], step["id"], "verify", "blocked", bool(step["required"]),
                expected="executable step", observed="prerequisite %s is %s" % bad_dep,
                details="prerequisite-%s:%s" % bad_dep))
            statuses[step["id"]] = "blocked"
            continue
        result = executor(step)
        check = _result_check(step, result, excluded_values)
        checks.append(check)
        statuses[step["id"]] = check["status"]
        # Independent halt condition (r3 item 3): unresolved resources, OR a
        # forced termination (timeout / group kill) whose descendants were
        # not proven dead. EOF/direct reaping is NOT descendants proof.
        termination = result.get("termination", {}) or {}
        forced = bool(result.get("timed_out")) or bool(
            termination.get("termination_attempted"))
        if (result.get("resources_unresolved")
                or (forced
                    and termination.get("descendants_confirmed") is not True)):
            unresolved_halt = True
    return checks


def build_report(plan_name, plan_data, repo_root, checks, generated_at_utc=None):
    head = doctor.read_git_head(repo_root) or {}
    identity = {
        "os": {"name": os.name, "system": platform.system(),
               "release": platform.release(), "machine": platform.machine()},
        "real_cwd": os.getcwd(),
        "repo_root_abs": os.path.abspath(repo_root),
        "git": head,
    }
    baseline_identity, candidate_identity = doctor.build_identity_blocks(repo_root)
    notes = [
        "Rejection behaviour vs environment passing are separate: CLI/plan/registry/"
        "trust-binding rejections are deterministic unit-test contracts (exit 3); "
        "this report covers only the executed plan steps (environment evidence).",
        "Trust source is this tool's deployment directory (Root-deployed schema-1.1 "
        "registry and plan files); --repo-root must be a Root-approved real path and "
        "never changes what is trusted.",
        "Trusted execution: python3 and bun run only from Root-registered "
        "byte-verified mappings (path/bytes/sha256); no PATH fallback; the running "
        "interpreter must equal the Root python3 mapping.",
        "A non-zero command is failed; there is no expected-exit greenwash.",
        "The deadline is a single budget covering wait, drain, join and "
        "reclamation; a fixed reserve is kept back for cleanup and every phase "
        "uses only the remaining time (no fixed post-deadline additions).",
        "Stream evidence separates thread-finished / natural-EOF / read-error; a "
        "read error is never green.",
        "Termination evidence is field-separated; killing the process group does "
        "not prove descendants died (descendants_confirmed stays null unless "
        "proven).",
        "Secrets: children do not inherit non-allowlisted environment values; the "
        "report carries only a bounded, redacted summary (raw logs stay private "
        "cloud-side evidence for Root).",
        "Declared limitations: TOCTOU between prereq checks and spawn on a steady "
        "cloud snapshot; Windows taskkill tree reclamation unverified; path "
        "strategy follows the restricted-Linux tool policy (not audited for Windows).",
    ]
    return reporting.build_report(
        "cloud-dev-verify", checks, identity=identity,
        baseline_identity=baseline_identity, candidate_identity=candidate_identity,
        notes=notes, generated_at_utc=generated_at_utc)


# --------------------------------------------------------------------------
# CLI (exit 3 contract: one structured error, never a traceback)
# --------------------------------------------------------------------------

class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise InvalidArguments(message)


def _emit_error(err):
    print(json.dumps({"schema_version": reporting.SCHEMA_VERSION,
                      "tool": "cloud-dev-verify", "error": str(err),
                      "exit_code": 3}, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = _Parser(
        prog="verify.py",
        description="cloud-dev verify (B2 r2): controlled plan executor, stdlib only")
    parser.add_argument("--plan", required=True,
                        help="registered plan name (tool-self-check | smoke)")
    parser.add_argument("--repo-root", default=".",
                        help="Root-approved repository root under test")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument("--expect-plan-sha256", default=None,
                        help="optional additional consistency check (never authorizes)")
    try:
        args = parser.parse_args(argv)
    except InvalidArguments as err:
        _emit_error(err)
        return 3
    try:
        data, raw, registry = load_plan(TOOL_DIR, args.plan)
        root = resolve_repo_root(args.repo_root, registry)
        if args.expect_plan_sha256 is not None:
            digest = hashlib.sha256(raw).hexdigest()
            if args.expect_plan_sha256.lower() != digest:
                raise InvalidPlan("CLI expect-plan-sha256 mismatch (tighten-only check)")
        checks = execute_plan(args.plan, data, root, registry=registry)
        report = build_report(args.plan, data, root, checks)
    except (InvalidPlan, InvalidArguments) as err:
        _emit_error(err)
        return 3
    if args.format == "markdown":
        print(reporting.render_markdown(report))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
