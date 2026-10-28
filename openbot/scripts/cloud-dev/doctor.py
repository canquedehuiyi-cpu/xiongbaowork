#!/usr/bin/env python3
"""cloud-dev doctor (B1): read-only environment report. Python stdlib only.

What it does
  - Reports OS, real cwd, git/source-snapshot identity (guarded pure-file
    reads of .git metadata; see read_git_head).
  - Probes trusted runtimes with FIXED argv (--version only), a resolved
    executable path, shell=False and a minimal non-secret environment:
    python (running interpreter), bun (required), node, npm, cargo, docker, git.
  - Reads only a fixed allowlist of non-secret files through a two-stage
    path guard (literal allowlist match, then real-path repository boundary).
    It never reads .env or any credential value, never installs anything,
    never writes to the repository, never touches the network.

Exit codes (task book 51660868; unified with reporting.overall_status)
  0 = nothing failed and every required check passed (optional incomplete OK)
  1 = at least one check failed (e.g. version mismatch, lock identity mismatch)
  2 = no failures but a required check is blocked/skipped/unverified
      (e.g. bun missing: an honest environment state, NOT a tool failure)
  3 = invalid invocation (bad flag, bad --format, bad --repo-root); errors are
      reported as one structured JSON object on stdout, never a traceback.
"""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

import reporting

# Pins from Root BASELINE READY post 51660955 and task book 51660868.
# These are DECLARATIONS (expected); they are never reported as observed.
PINNED = {
    "bun_version": "1.3.14",
    "typescript_version": "5.9.3",
    "bun_lock_size": 453991,
    "bun_lock_sha256": "c5b3f3c17b2159e033c7cf8911780b98d0ebeba93756e175e32064b15849e670",
    "source_tree_sha256": "a81cd0487fd515911e1506d0a83ba532568f52bad90f0a8f8367da675392f785",
    "baseline_commit_gitee": "0089682e785d03fa67e8463bf862d2b94447392c",
    "workspace_synth_commit": "9ba4ea9fae4b994425a49c3e6eec9ddc0d156e05",
    "workspace_synth_tree": "0064aba2afa7a6c1a90ee43b32fc26847f9192ef",
}

# Fixed argv probes. Keys are the ONLY accepted probe names; no caller input
# ever reaches argv. expect_version_key names the PINNED entry to compare with.
RUNTIME_PROBES = {
    "bun":    {"required": True,  "argv": ("bun", "--version"), "expect_version_key": "bun_version"},
    "node":   {"required": False, "argv": ("node", "--version")},
    "npm":    {"required": False, "argv": ("npm", "--version")},
    "cargo":  {"required": False, "argv": ("cargo", "--version")},
    "docker": {"required": False, "argv": ("docker", "--version")},
    "git":    {"required": False, "argv": ("git", "--version")},
}
PROBE_TIMEOUT_S = 15

# Path-escape guard: only these relative paths may ever be opened.
READ_ALLOWLIST = (
    "openbot/package.json",
    "openbot/bun.lock",
    "openbot/node_modules/typescript/package.json",
)

# Names only (values never read).
ENV_NAME_PREFIXES = ("BUN_", "NODE_", "OPENBOT_", "COMPOSIO_")

# Environment allowlist for probe subprocesses (Root review item 3):
# platform essentials + proxy/CA only. Provider secrets, option-injection
# (NODE_OPTIONS/BUN_OPTIONS/...) and preload vectors (LD_PRELOAD/...) never
# reach a probe process, and env VALUES never enter the report.
SAFE_ENV_KEYS = (
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC",
    "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
)

GIT_HEX_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
VALID_REF_RE = re.compile(r"^refs/[A-Za-z0-9._\-/]+$")


class PathNotAllowed(Exception):
    pass


class InvalidArguments(Exception):
    pass


def _is_within(child_real, parent_real):
    try:
        return os.path.commonpath([child_real, parent_real]) == parent_real
    except ValueError:  # different drives on Windows
        return False


def probe_safe_env(environ=None):
    src = os.environ if environ is None else environ
    return dict((key, src[key]) for key in SAFE_ENV_KEYS if key in src)


def _plain_path(base, parts):
    """Fixed ordinary paths only: reject even in-bound symlink aliases.

    Static snapshot policy, not an atomic filesystem race-isolation claim.
    """
    base = os.path.realpath(base)
    path = base
    for part in parts:
        if part in ("", ".", "..") or os.sep in part:
            raise PathNotAllowed("invalid path component")
        path = os.path.join(path, part)
        if os.path.islink(path):
            raise PathNotAllowed("symlink alias refused")
    if not _is_within(path, base) or os.path.realpath(path) != path:
        raise PathNotAllowed("path alias refused")
    return path


def resolve_read(repo_root, rel):
    if rel not in READ_ALLOWLIST:
        raise PathNotAllowed("literal path not in read allowlist")
    root = os.path.realpath(repo_root)
    if rel != "openbot/node_modules/typescript/package.json":
        return _plain_path(root, rel.split("/"))
    # Only the exact pinned Bun package layout, or a plain unpacked package.
    parent = _plain_path(root, ["openbot", "node_modules"])
    package = os.path.join(parent, "typescript")
    if not os.path.islink(package):
        return _plain_path(root, rel.split("/"))
    expected_parts = ["openbot", "node_modules", ".bun",
                      "typescript@" + PINNED["typescript_version"],
                      "node_modules", "typescript", "package.json"]
    expected = _plain_path(root, expected_parts)
    if os.path.realpath(os.path.join(package, "package.json")) != expected:
        raise PathNotAllowed("TypeScript package is not the exact pinned Bun layout")
    return expected


def _read_guarded_file(base_real, rel_parts):
    try:
        path = _plain_path(base_real, rel_parts)
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except (OSError, UnicodeError, PathNotAllowed):
        return None


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_probe(name):
    if name not in RUNTIME_PROBES:
        raise KeyError("unknown probe name: %r" % (name,))
    return tuple(RUNTIME_PROBES[name]["argv"])


# Explicit finite Linux probe locations. No PATH discovery or repository bins.
# Other platforms/locations are blocked until Root reviews a trusted mapping.
TRUSTED_PROBE_DIRS = ("/usr/bin", "/bin", "/usr/local/bin")


def _trusted_executable(name, executable):
    if name not in RUNTIME_PROBES or not executable or not os.path.isabs(executable):
        return False
    allowed = {os.path.join(d, name) for d in TRUSTED_PROBE_DIRS}
    return (executable in allowed and os.path.realpath(executable) == executable
            and os.path.isfile(executable) and os.access(executable, os.X_OK))


class Prober(object):
    """Resolve one approved absolute executable; no second lookup/fallback."""

    def find(self, name):
        if name not in RUNTIME_PROBES:
            return None
        for directory in TRUSTED_PROBE_DIRS:
            executable = os.path.join(directory, name)
            if _trusted_executable(name, executable):
                return executable
        return None

    def run(self, argv, timeout=PROBE_TIMEOUT_S, executable=None):
        if tuple(argv) != build_probe(argv[0]) or not _trusted_executable(argv[0], executable):
            raise OSError("trusted executable unavailable; no subprocess started")
        return subprocess.run(
            [executable] + list(argv[1:]), capture_output=True, text=True,
            timeout=timeout, shell=False, env=probe_safe_env())


def probe_runtime(name, prober):
    spec = RUNTIME_PROBES[name]
    argv = build_probe(name)
    required = spec["required"]
    check_id = "runtime_" + name
    try:
        where = prober.find(name)
    except Exception as err:  # discovery must never crash the doctor
        return reporting.make_check(check_id, name, "runtime", "failed", required,
                                    expected="probe discovery", observed="error: %s" % err)
    if not where:
        return reporting.make_check(check_id, name, "runtime", "blocked", required,
                                    expected="present", observed="missing",
                                    details="trusted executable unavailable; no subprocess started")
    try:
        proc = prober.run(argv, executable=where)
    except subprocess.TimeoutExpired:
        return reporting.make_check(check_id, name, "runtime", "failed", required,
                                    expected="exit 0 within %ss" % PROBE_TIMEOUT_S,
                                    observed="timeout", details="argv=%r" % (argv,))
    except UnicodeError:
        return reporting.make_check(check_id, name, "runtime", "failed", required,
                                    expected="decodable UTF-8 version output",
                                    observed="version output decoding failed",
                                    details="runtime executed but its text output could not be decoded")
    except OSError as err:
        return reporting.make_check(check_id, name, "runtime", "blocked", required,
                                    expected="present", observed="spawn error: %s" % err)
    output = proc.stdout
    if proc.returncode != 0:
        return reporting.make_check(check_id, name, "runtime", "failed", required,
                                    expected="exit 0", observed="exit %d" % proc.returncode,
                                    details=output.strip()[:200] if isinstance(output, str)
                                    else "version output is not text")
    if not isinstance(output, str):
        return reporting.make_check(check_id, name, "runtime", "unverified", required,
                                    expected="text version output", observed="unsupported stdout type",
                                    details="type=" + type(output).__name__)
    output = output.strip()
    lines = output.splitlines()
    first = lines[0].strip() if lines else ""
    key = spec.get("expect_version_key")
    if key:
        expected = PINNED[key]
        normalized = first[1:] if first.startswith("v") else first
        if normalized != expected:
            return reporting.make_check(check_id, name, "runtime", "failed", required,
                                        expected=expected, observed=first,
                                        details="version mismatch")
    expected_label = PINNED[key] if key else "any, exit 0"
    return reporting.make_check(check_id, name, "runtime", "passed", required,
                                expected=expected_label, observed=first,
                                details="resolved=%s" % where)


def check_python():
    return reporting.make_check("runtime_python", "python3 (running interpreter)",
                                "runtime", "passed", True, expected="present",
                                observed=platform.python_version(),
                                details=sys.executable or "unknown")


def check_layout(repo_root):
    openbot_pkg = os.path.join(repo_root, "openbot", "package.json")
    has_openbot_pkg = os.path.isfile(openbot_pkg)
    checks = [reporting.make_check(
        "repo_layout_openbot_package_json", "openbot/package.json (workspace root)",
        "layout", "passed" if has_openbot_pkg else "failed", True,
        expected="file exists", observed="exists" if has_openbot_pkg else "missing")]
    root_pkg = os.path.join(repo_root, "package.json")
    has_root_pkg = os.path.exists(root_pkg)
    checks.append(reporting.make_check(
        "repo_layout_root_package_json_absent", "no package.json at repo root",
        "layout", "failed" if has_root_pkg else "passed", True,
        expected="absent", observed="present" if has_root_pkg else "absent",
        details="task book: repo root has no package.json; workspace root is openbot/package.json"))
    return checks


def check_package_manager(repo_root):
    check_id = "package_manager_declaration"
    expected_pm = "bun@" + PINNED["bun_version"]
    try:
        path = resolve_read(repo_root, "openbot/package.json")
    except PathNotAllowed as err:
        return reporting.make_check(check_id, "packageManager in openbot/package.json",
                                    "config", "failed", True, expected=expected_pm,
                                    observed="path-not-allowed", details=str(err)[:200])
    if not os.path.isfile(path):
        return reporting.make_check(check_id, "packageManager in openbot/package.json",
                                    "config", "blocked", True, expected=expected_pm,
                                    observed="file missing")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as err:
        return reporting.make_check(check_id, "packageManager in openbot/package.json",
                                    "config", "failed", True, expected=expected_pm,
                                    observed="unreadable", details=str(err)[:200])
    if not isinstance(data, dict):
        return reporting.make_check(check_id, "packageManager in openbot/package.json",
                                    "config", "failed", True, expected=expected_pm,
                                    observed="invalid JSON object shape")
    observed = data.get("packageManager")
    status = "passed" if observed == expected_pm else "failed"
    return reporting.make_check(check_id, "packageManager in openbot/package.json",
                                "config", status, True, expected=expected_pm,
                                observed=observed)


def check_bun_lock(repo_root):
    check_id = "bun_lock_identity"
    expected = "size=%d sha256=%s" % (PINNED["bun_lock_size"], PINNED["bun_lock_sha256"])
    try:
        path = resolve_read(repo_root, "openbot/bun.lock")
    except PathNotAllowed as err:
        return reporting.make_check(check_id, "openbot/bun.lock size+sha256", "config",
                                    "failed", True, expected=expected,
                                    observed="path-not-allowed", details=str(err)[:200])
    if not os.path.isfile(path):
        return reporting.make_check(check_id, "openbot/bun.lock size+sha256", "config",
                                    "failed", True, expected=expected, observed="missing")
    try:
        size = os.path.getsize(path)
        digest = sha256_file(path)
    except OSError as err:
        return reporting.make_check(check_id, "openbot/bun.lock size+sha256", "config",
                                    "failed", True, expected=expected,
                                    observed="read error: %s" % err)
    observed = "size=%d sha256=%s" % (size, digest)
    ok = (size == PINNED["bun_lock_size"] and digest == PINNED["bun_lock_sha256"])
    status = "passed" if ok else "failed"
    return reporting.make_check(check_id, "openbot/bun.lock size+sha256", "config",
                                status, True, expected=expected, observed=observed)


def check_typescript_dependency(repo_root):
    check_id = "typescript_dependency"
    expected = PINNED["typescript_version"]
    try:
        path = resolve_read(repo_root, "openbot/node_modules/typescript/package.json")
    except PathNotAllowed as err:
        return reporting.make_check(check_id, "locked TypeScript version", "dependency",
                                    "failed", False, expected=expected,
                                    observed="path-not-allowed", details=str(err)[:200])
    if not os.path.isfile(path):
        return reporting.make_check(check_id, "locked TypeScript version", "dependency",
                                    "blocked", False, expected=expected, observed="missing",
                                    details="openbot/node_modules absent (dependencies not installed): missing-dependency state; doctor does not install")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as err:
        return reporting.make_check(check_id, "locked TypeScript version", "dependency",
                                    "failed", False, expected=expected,
                                    observed="unreadable", details=str(err)[:200])
    if not isinstance(data, dict):
        return reporting.make_check(check_id, "locked TypeScript version", "dependency",
                                    "failed", False, expected=expected,
                                    observed="invalid JSON object shape")
    observed = data.get("version")
    status = "passed" if observed == expected else "failed"
    return reporting.make_check(check_id, "locked TypeScript version", "dependency",
                                status, False, expected=expected, observed=observed)


def _valid_ref_name(branch):
    if not VALID_REF_RE.fullmatch(branch) or not branch.startswith(("refs/heads/", "refs/tags/")):
        return False
    parts = branch.split("/")
    return all(part not in ("", ".", "..") and not part.startswith(".")
               and not part.endswith((".", ".lock")) and ".." not in part for part in parts)


def _resolve_ref(git_dir_real, branch):
    """Resolve a validated ref via loose file or packed-refs, all reads
    guarded to the metadata root; commit values must be 40/64-hex or None."""
    raw = _read_guarded_file(git_dir_real, branch.split("/"))
    if raw is not None:
        value = raw.strip()
        return value if GIT_HEX_RE.match(value) else None
    packed = _read_guarded_file(git_dir_real, ["packed-refs"])
    if packed:
        for line in packed.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("^"):
                continue
            parts = line.split(" ", 1)
            if len(parts) == 2 and parts[1] == branch and GIT_HEX_RE.match(parts[0]):
                return parts[0]
    return None


def read_git_head(repo_root):
    """Guarded pure-file read of .git HEAD. No git plumbing, no writes.

    Returns None when metadata is absent/unreadable, or a dict:
      {"branch", "commit"}                          healthy HEAD
      {"branch", "commit": None, "malformed_ref"}   ref fails validation
      {"branch": None, "commit": None, "malformed_head"}  HEAD is neither
      {"external_metadata_root": True, "gitdir"}    worktree gitfile points
                                                    outside the repo (never read)
    """
    root_real = os.path.realpath(repo_root)
    git_literal = os.path.join(root_real, ".git")
    git_dir_real = None
    if os.path.islink(git_literal):
        return {"external_metadata_root": not _is_within(os.path.realpath(git_literal), root_real),
                "metadata_refused": True, "gitdir": ".git alias refused"}
    if os.path.isdir(git_literal):
        git_dir_real = os.path.realpath(git_literal)
        if not _is_within(git_dir_real, root_real):
            return {"external_metadata_root": True, "gitdir": ".git (symlink out of repository)"}
    elif os.path.isfile(git_literal):
        raw = _read_guarded_file(root_real, [".git"])
        if raw is None:
            return {"branch": None, "commit": None, "unreadable_metadata": True}
        first = raw.strip()
        if not first.startswith("gitdir:"):
            return None
        target = first[len("gitdir:"):].strip()
        target_literal = os.path.normpath(os.path.abspath(os.path.join(root_real, target)))
        if not _is_within(target_literal, root_real):
            return {"external_metadata_root": True, "gitdir": target}
        # In-repository gitfile targets are also unverified; never interpret
        # a repo root/config/credentials directory as a Git metadata root.
        return {"metadata_refused": True, "gitdir": "gitfile target not supported"}
    else:
        return None
    head_raw = _read_guarded_file(git_dir_real, ["HEAD"])
    if head_raw is None:
        if os.path.lexists(os.path.join(git_dir_real, "HEAD")):
            return {"branch": None, "commit": None, "unreadable_metadata": True}
        return None
    head = head_raw.strip()
    if head.startswith("ref: "):
        branch = head[5:].strip()
        if not _valid_ref_name(branch):
            return {"branch": None, "commit": None, "malformed_ref": True}
        return {"branch": branch, "commit": _resolve_ref(git_dir_real, branch)}
    if GIT_HEX_RE.match(head):
        return {"branch": None, "commit": head}
    return {"branch": None, "commit": None, "malformed_head": True}


def check_git_identity(repo_root):
    check_id = "git_identity"
    head = read_git_head(repo_root)
    if head is None:
        return reporting.make_check(check_id, "git/source snapshot identity",
                                    "identity", "skipped", False, expected=".git present",
                                    observed="no .git metadata",
                                    details="source tree without git metadata; no plumbing is used")
    if head.get("external_metadata_root") or head.get("metadata_refused"):
        return reporting.make_check(check_id, "git/source snapshot identity",
                                    "identity", "unverified", False,
                                    expected="in-repository metadata",
                                    observed="external worktree metadata (not read)",
                                    details=json.dumps(head, sort_keys=True))
    if head.get("commit") is None:
        reason = ("unreadable metadata (rejected)" if head.get("unreadable_metadata")
                  else "malformed ref (rejected)" if head.get("malformed_ref")
                  else "malformed HEAD (rejected)" if head.get("malformed_head")
                  else "ref unresolved")
        return reporting.make_check(check_id, "git/source snapshot identity",
                                    "identity", "unverified", False,
                                    expected="commit resolvable",
                                    observed=reason,
                                    details=json.dumps(head, sort_keys=True))
    return reporting.make_check(check_id, "git/source snapshot identity",
                                "identity", "passed", False, expected="HEAD readable",
                                observed=json.dumps(head, sort_keys=True),
                                details="tree sha unverified without git plumbing; pins are declarations under baseline_identity.expected")


def check_env_names():
    interesting = [n for n in sorted(os.environ) if n.startswith(ENV_NAME_PREFIXES)]
    details = ("names-only scan; PATH=%s HOME=%s; %d relevant name(s) present; names=%s"
               % ("PATH" in os.environ, "HOME" in os.environ, len(interesting), interesting[:20]))
    return reporting.make_check("env_var_names", "environment variable names",
                                "environment", "passed", False,
                                expected="informational only", observed="names-only",
                                details=details)



def build_identity(repo_root):
    return {
        "os": {"name": os.name, "system": platform.system(),
               "release": platform.release(), "machine": platform.machine()},
        "real_cwd": os.getcwd(),
        "repo_root_abs": os.path.abspath(repo_root),
        "git": read_git_head(repo_root) or {"branch": None, "commit": None},
    }


def build_identity_blocks(repo_root):
    """baseline/candidate identity blocks (Root review item 4): expected pins
    and observed values are separate; anything not measured stays null and
    the block status is 'unverified'. B1 never computes the tree hash."""
    head = read_git_head(repo_root) or {}
    observed = {
        "git_branch": head.get("branch"),
        "git_commit": head.get("commit"),
        "source_tree_sha256": None,
    }
    expected = {
        "source_tree_sha256": PINNED["source_tree_sha256"],
        "workspace_synth_commit": PINNED["workspace_synth_commit"],
        "pinned_from": "Root BASELINE READY board post 51660955 (2026-10-18)",
    }
    details = ("B1 is read-only and never computes the full source tree hash "
               "(B3 scope); the tree pin is a declaration, not an observation. "
               "git commit is observed from .git via guarded reads.")
    baseline = reporting.make_identity_block(
        expected=expected, observed=dict(observed), status="unverified",
        details=details)
    candidate = reporting.make_identity_block(
        expected=None, observed=dict(observed), status="unverified",
        details="same workspace in B1; baseline-vs-candidate comparison is B3 scope")
    return baseline, candidate


def build_notes():
    return [
        "Read-only tool: opens only the fixed read allowlist through a two-stage guard (literal allowlist match, then real-path repository boundary); never reads .env or credential values; never writes to the repository.",
        "Git metadata reads are guarded: gitdir must resolve inside the repository, ref names are validated, commits must be 40/64-hex; external worktree metadata is reported unverified and never read.",
        "Runtimes probed with fixed argv (--version) only, resolved executable path, shell=False and a minimal non-secret environment allowlist; nothing is installed; no network access.",
        "Missing required runtime (bun) is reported as blocked and yields exit 2: an honest environment state, not a tool failure.",
        "The historical 7 server type diagnostics (plan-model.ts 5x TS7006, voice/summary.ts 1x TS7006, telemetry/otel.ts 1x TS2739) are out of B1 scope; doctor does not run tsc.",
    ]


def build_report(repo_root, prober=None, generated_at_utc=None):
    prober = prober if prober is not None else Prober()
    root = os.path.abspath(repo_root)
    checks = []
    checks.extend(check_layout(root))
    checks.append(check_package_manager(root))
    checks.append(check_bun_lock(root))
    checks.append(check_python())
    for name in ("git", "bun", "node", "npm", "cargo", "docker"):
        checks.append(probe_runtime(name, prober))
    checks.append(check_git_identity(root))
    checks.append(check_typescript_dependency(root))
    checks.append(check_env_names())
    baseline_identity, candidate_identity = build_identity_blocks(root)
    return reporting.build_report("cloud-dev-doctor", checks,
                                  identity=build_identity(root),
                                  baseline_identity=baseline_identity,
                                  candidate_identity=candidate_identity,
                                  notes=build_notes(),
                                  generated_at_utc=generated_at_utc)


def validate_repo_root(repo_root):
    if not repo_root or not os.path.isdir(repo_root):
        raise InvalidArguments("repo-root is not an existing directory: %r" % (repo_root,))
    return os.path.abspath(repo_root)


class _Parser(argparse.ArgumentParser):
    """argparse maps bad invocations to SystemExit(2); the task-book contract
    is exit 3 for invalid invocation (Root review item 5). error() therefore
    raises InvalidArguments and main maps it to one structured JSON object."""

    def error(self, message):
        raise InvalidArguments(message)


def _emit_error(err):
    print(json.dumps({"schema_version": reporting.SCHEMA_VERSION,
                      "tool": "cloud-dev-doctor", "error": str(err),
                      "exit_code": 3}, ensure_ascii=False, indent=2))


def main(argv=None, prober=None):
    parser = _Parser(
        prog="doctor.py",
        description="cloud-dev doctor (B1): read-only environment report, stdlib only")
    parser.add_argument("--repo-root", default=".",
                        help="repository root (default: current directory)")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    try:
        args = parser.parse_args(argv)
    except InvalidArguments as err:
        _emit_error(err)
        return 3
    try:
        root = validate_repo_root(args.repo_root)
    except InvalidArguments as err:
        _emit_error(err)
        return 3
    report = build_report(root, prober=prober)
    if args.format == "markdown":
        print(reporting.render_markdown(report))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
