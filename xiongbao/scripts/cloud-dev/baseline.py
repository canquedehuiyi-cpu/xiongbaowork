#!/usr/bin/env python3
"""B3-DIA baseline: pure diagnostic multiset comparison over two tsc logs.

Scope (Root 51664384 / 51664587 / 51664814 / 51664988 / 51665136 / 51666024):
- D1: zero process spawning; inputs are two retained tsc stdout logs.
- D2: diagnostics are compared as a multiset over the complete normalized
      key (file, line, col, code, message). Numbers, codes and messages are
      never blurred. Only newline unification and per-line trailing
      whitespace stripping apply; file uses backslash->slash only.
- D3: new / resolved / still_present. resolved is displayed only and never
      upgrades a failed run.
- D5: reporting 1.1 is REUSED, not modified: checks are assembled with
      reporting.make_check and the exit code comes from
      reporting.compute_exit_code (pass=0, incomplete=2, fail=1); CLI
      parameter/plan errors are exit 3 and never enter checks.
- D4 (tree identity) is NOT implemented: tree identity stays "unverified".

Trust seams (Root 51665136/51666024): the registry 1.1 four-field schema
has NO log-path / evidence authorization field, therefore:
- POSITION 1 (log trust adapter): no Root-deployed adapter grants log
  paths yet. run_cli never reads any log byte; it returns blocked checks
  (exit 2) with the specific gap.
- POSITION 2 (evidence issuer adapter): a self-reported evidence JSON is
  structurally validated and byte-bound, but trusted stays False; it can
  never upgrade a run to passed.
Root-deployed helpers are REUSED, not copied: load_registry /
resolve_repo_root / InvalidPlan / InvalidArguments come from the deployed
verify module; make_check / summarize / overall_status / compute_exit_code /
build_report come from the deployed reporting module.
"""

import argparse
import hashlib
import json
import os
import re
import sys

from verify import (InvalidArguments, InvalidPlan, load_registry,
                    resolve_repo_root)
import reporting

MAX_LOG_BYTES = 8 * 1024 * 1024
ALLOWED_EXTS = (".log", ".txt")
SECRET_EXACT = {".env", "credentials", "id_rsa", "id_dsa", "id_ecdsa",
                "id_ed25519", "secrets", ".git-credentials"}
SECRET_SUFFIX = (".pem", ".key", ".p12", ".pfx")

DIAG_RE = re.compile(
    r"^(?P<file>.+?)\((?P<line>\d+),(?P<col>\d+)\):\s+"
    r"(?P<sev>error|warning)\s+(?P<code>[A-Za-z]+\d+):\s?(?P<msg>.*)$")

TOOL_NAME = "baseline-dia"
GAP_LOG_ADAPTER = ("POSITION 1 (log trust adapter): registry 1.1 has no "
                   "log-path authorization field; a Root-deployed log trust "
                   "adapter must grant (root, relpath) pairs before any log "
                   "byte is read")
GAP_EVIDENCE_ADAPTER = ("POSITION 2 (evidence issuer adapter): no "
                        "Root-deployed trusted evidence adapter exists; "
                        "self-reported evidence is byte-bound but never "
                        "trusted")


def norm_slashes(path):
    """Diag-key normalization: backslash -> slash only (D2, r2).

    No whitespace stripping: " a.ts" and "a.ts" are distinct keys
    (r2, Root 51667447: the previous .strip() over-normalized).
    """
    return path.replace("\\", "/")


def norm_log_path(relpath):
    """Literal path normalization for guard/open: backslash -> slash only.

    Leading/trailing whitespace is NOT stripped; guard_log_path refuses
    such paths outright, so no trim-then-open divergence exists (r2).
    """
    return relpath.replace("\\", "/")


def literal_target(root, norm):
    """Shared literal component walk: the exact open target.

    guard_log_path and read_log share this builder so the verified
    target and the opened target are the same string (r2).
    """
    cur = root
    for comp in norm.split("/"):
        if comp not in ("", "."):
            cur = os.path.join(cur, comp)
    return cur


def guard_log_path(root, relpath):
    """literal-first component walk. Returns [] when allowed, else reasons.

    The root must already be trusted (resolved via the registry seam).
    Every symlink component is refused; no exception list exists in DIA.
    Rejection happens before any open: zero bytes of the target are read.
    Defense-in-depth for the future Root-deployed log trust adapter
    (POSITION 1); the CLI itself never reaches this while the adapter is
    missing.
    """
    if not isinstance(relpath, str) or not relpath.strip():
        return ["empty log path"]
    if relpath != relpath.strip():
        return ["leading/trailing whitespace refused: %r" % relpath]
    norm = norm_log_path(relpath)
    if (norm.startswith("/") or re.match(r"^[A-Za-z]:", norm)
            or os.path.isabs(norm)):
        return ["absolute path refused: %s" % norm]
    parts = [p for p in norm.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return ["parent component refused: %s" % norm]
    for comp in parts:
        low = comp.lower()
        if low.startswith("id_"):
            return ["secret component refused (id_ prefix): %s" % comp]
        if comp in SECRET_EXACT or low in SECRET_EXACT:
            return ["secret component refused: %s" % comp]
        if low.endswith(SECRET_SUFFIX):
            return ["secret-like component refused: %s" % comp]
    walked = root
    for comp in parts:
        walked = os.path.join(walked, comp)
        if os.path.islink(walked):
            return ["symlink component refused: %s" % comp]
    if not norm.lower().endswith(ALLOWED_EXTS):
        return ["extension not allowed (only .log/.txt): %s" % norm]
    if not os.path.isfile(literal_target(root, norm)):
        return ["not a regular file: %s" % norm]
    return []


def read_log(root, relpath):
    """Guard first, then bounded read. Returns (problems, data_bytes).

    Only callable once POSITION 1 adapter grants (root, relpath).
    """
    problems = guard_log_path(root, relpath)
    if problems:
        return problems, b""
    cur = literal_target(root, norm_log_path(relpath))
    with open(cur, "rb") as fh:
        head = fh.read(MAX_LOG_BYTES + 1)
    if len(head) > MAX_LOG_BYTES:
        return ["log exceeds %d bytes bound" % MAX_LOG_BYTES], b""
    return [], head


def parse_diagnostics(text):
    """Parse tsc-style lines into diagnostics (pure, in-memory).

    Returns {"diags": [...], "unparsed": [...]}.
    Diag fields: key (file, line, col, code, message), file, line, col,
    code, message (normalized), message_sha256 (of normalized message),
    raw (original lines joined), parsed=True.
    Unparsed non-empty lines are preserved verbatim, never dropped and
    never counted as pass evidence.
    """
    unified = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = unified.split("\n")
    diags = []
    unparsed = []
    current = None
    for raw in lines:
        stripped = raw.rstrip()
        m = DIAG_RE.match(stripped)
        if m:
            current = {
                "file": norm_slashes(m.group("file")),
                "line": int(m.group("line")),
                "col": int(m.group("col")),
                "code": m.group("code"),
                "message": m.group("msg"),
                "raw": raw,
            }
            diags.append(current)
            continue
        if stripped == "":
            current = None
            continue
        if current is not None and raw[:1] in (" ", "\t"):
            current["message"] = current["message"] + "\n" + stripped
            current["raw"] = current["raw"] + "\n" + raw
            continue
        unparsed.append({"raw": raw, "parsed": False})
    out = []
    for d in diags:
        key = (d["file"], d["line"], d["col"], d["code"], d["message"])
        out.append({
            "key": key,
            "file": d["file"], "line": d["line"], "col": d["col"],
            "code": d["code"], "message": d["message"],
            "message_sha256": hashlib.sha256(
                d["message"].encode("utf-8")).hexdigest(),
            "raw": d["raw"],
            "parsed": True,
        })
    return {"diags": out, "unparsed": unparsed}


def compare(baseline_diags, candidate_diags):
    """Multiset comparison over complete keys (pure, in-memory).

    new = candidate surplus; resolved = baseline surplus;
    still_present = per-key minimum overlap (repeated entries kept).
    """
    from collections import Counter
    base = Counter(d["key"] for d in baseline_diags)
    cand = Counter(d["key"] for d in candidate_diags)
    base_by_key = {}
    for d in baseline_diags:
        base_by_key.setdefault(d["key"], []).append(d)
    cand_by_key = {}
    for d in candidate_diags:
        cand_by_key.setdefault(d["key"], []).append(d)
    new, resolved, still = [], [], []
    for k in sorted(set(base) | set(cand)):
        b, c = base.get(k, 0), cand.get(k, 0)
        if c > b:
            new.extend(cand_by_key[k][b:])
        if b > c:
            resolved.extend(base_by_key[k][c:])
        if min(b, c) > 0:
            still.extend(cand_by_key[k][:min(b, c)])
    return {"new": new, "resolved": resolved, "still_present": still}


def compare_texts(baseline_text, candidate_text):
    """Pure in-memory entry: parse both texts and compare.

    Returns {"comparison": ..., "unparsed": [...],
             "credibility_verified": bool}.
    """
    pb = parse_diagnostics(baseline_text)
    pc = parse_diagnostics(candidate_text)
    unparsed = pb["unparsed"] + pc["unparsed"]
    return {"comparison": compare(pb["diags"], pc["diags"]),
            "unparsed": unparsed,
            "credibility_verified": not unparsed}


def parse_run_evidence(raw_bytes):
    """Strict-typed structural check of a candidate evidence record.

    bool is rejected wherever an int is required (bool subclasses int).
    Returns {"structurally_ok": bool, "reasons": [...], "fields": dict}.
    This is data validation only; it never grants issuer trust
    (POSITION 2).
    """
    reasons = []
    try:
        obj = json.loads(raw_bytes.decode("utf-8"))
    except Exception:
        return {"structurally_ok": False,
                "reasons": ["evidence is not valid UTF-8 JSON"], "fields": {}}
    if not isinstance(obj, dict):
        return {"structurally_ok": False,
                "reasons": ["evidence root must be an object"], "fields": {}}
    fields = {}

    def want_str(name):
        v = obj.get(name)
        if not isinstance(v, str):
            reasons.append("field %s must be str" % name)
        else:
            fields[name] = v

    def want_int(name):
        v = obj.get(name)
        if isinstance(v, bool) or not isinstance(v, int):
            reasons.append("field %s must be int (bool rejected)" % name)
        else:
            fields[name] = v

    want_str("log_path")
    want_str("cwd")
    want_str("started_at")
    want_str("ended_at")
    want_int("exit_code")
    want_int("log_bytes")
    v = obj.get("log_sha256")
    if not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{64}", v):
        reasons.append("field log_sha256 must be 64 lowercase hex chars")
    else:
        fields["log_sha256"] = v
    v = obj.get("argv")
    if not isinstance(v, list) or not v or not all(
            isinstance(x, str) for x in v):
        reasons.append("field argv must be a non-empty list of str")
    else:
        fields["argv"] = v
    v = obj.get("dep_tree")
    if not isinstance(v, dict):
        reasons.append("field dep_tree must be an object")
    else:
        fields["dep_tree"] = v
    return {"structurally_ok": not reasons, "reasons": reasons,
            "fields": fields}


def bind_evidence(evidence, actual_log_bytes):
    """Bind evidence to actual log bytes; issuer trust stays unproven.

    trusted is False until POSITION 2 (Root-deployed trusted evidence
    adapter) exists, so a self-reported JSON alone can never make the run
    "passed" (Root 51664988/51665136).
    """
    res = {"structurally_ok": evidence["structurally_ok"],
           "reasons": list(evidence["reasons"]), "trusted": False}
    if evidence["structurally_ok"]:
        f = evidence["fields"]
        if f["log_bytes"] != len(actual_log_bytes):
            res["reasons"].append(
                "log_bytes mismatch: evidence %d vs actual %d"
                % (f["log_bytes"], len(actual_log_bytes)))
        actual_sha = hashlib.sha256(actual_log_bytes).hexdigest()
        if f["log_sha256"] != actual_sha:
            res["reasons"].append("log_sha256 mismatch with actual bytes")
    res["structurally_ok"] = (evidence["structurally_ok"]
                              and not res["reasons"])
    return res


def build_checks(comparison, unparsed, evidence_bound, logs_read):
    """Assemble reporting-1.1 checks (reuse, no new status levels).

    failed1 priority: any new/still_present makes diag-compare failed even
    when unparsed lines exist or evidence is untrusted.
    """
    dirty = len(comparison["new"]) > 0 or len(comparison["still_present"]) > 0
    if not logs_read:
        checks = [
            reporting.make_check(
                "diag-compare", "diagnostic multiset comparison",
                "baseline", "blocked", True,
                expected="new=0 and still_present=0",
                details=GAP_LOG_ADAPTER),
            reporting.make_check(
                "run-evidence", "structured run evidence binding",
                "baseline", "blocked", True,
                details="; ".join([GAP_EVIDENCE_ADAPTER] +
                                  list(evidence_bound.get("reasons") or []))),
        ]
        return checks
    if dirty:
        cmp_status = "failed"
    elif unparsed:
        cmp_status = "unverified"
    else:
        cmp_status = "passed"
    checks = [
        reporting.make_check(
            "diag-compare", "diagnostic multiset comparison", "baseline",
            cmp_status, True,
            expected="new=0 and still_present=0",
            observed="new=%d resolved=%d still_present=%d unparsed=%d"
                     % (len(comparison["new"]), len(comparison["resolved"]),
                        len(comparison["still_present"]), len(unparsed)),
            details="multiset over (file,line,col,code,message); "
                    "raw+message_sha256 preserved per entry"),
        reporting.make_check(
            "run-evidence", "structured run evidence binding", "baseline",
            "passed" if evidence_bound.get("trusted") else "unverified",
            True,
            details="; ".join(evidence_bound.get("reasons") or []) or
                    GAP_EVIDENCE_ADAPTER),
    ]
    return checks


def assemble_report(plan_name, comparison, unparsed, evidence_bound,
                    logs_read, base_identity=None, cand_identity=None,
                    extra_note=None):
    checks = build_checks(comparison, unparsed, evidence_bound, logs_read)
    notes = ["plan: %s" % plan_name,
             "D4 tree identity: unverified (not implemented, not granted)"]
    if extra_note:
        notes.append(extra_note)
    return reporting.build_report(
        TOOL_NAME, checks,
        baseline_identity=base_identity,
        candidate_identity=cand_identity,
        notes=notes)


def run_cli(repo_root_arg, baseline_path, candidate_path,
            evidence_bytes=None, evidence_path=None):
    """CLI entry. Reuses deployed verify helpers; refuses at POSITION 1.

    r2 contract (Root 51667447): parameter/plan errors never build a
    reporting report and never enter checks; the CLI returns a plain
    error and both the JSON output and the process return code are 3.
    evidence_bytes is validated structurally only: bind_evidence is NOT
    called because no log byte has been read (no empty-bytes fake
    binding). evidence_path is never opened; it is reported as an
    unread gap (zero unapproved bytes read).
    """
    try:
        registry = load_registry()
        root = resolve_repo_root(repo_root_arg, registry)
    except (InvalidPlan, InvalidArguments) as err:
        return {"report": None, "exit_code": 3, "error": str(err)}
    evidence_bound = {"structurally_ok": False, "trusted": False,
                      "binding_performed": False,
                      "reasons": ["no run-evidence provided"]}
    if evidence_bytes is not None:
        ev = parse_run_evidence(evidence_bytes)
        evidence_bound = {"structurally_ok": ev["structurally_ok"],
                          "trusted": False, "binding_performed": False,
                          "reasons": list(ev["reasons"]) or
                          ["binding not performed: no log bytes read"]}
    extra_note = None
    if evidence_path is not None:
        extra_note = ("--run-evidence path accepted but never read "
                      "(no authorized evidence adapter): %s" % evidence_path)
    report = assemble_report("dia-baseline", {"new": [], "resolved": [],
                                              "still_present": []},
                             [], evidence_bound, logs_read=False,
                             extra_note=extra_note)
    return {"report": report,
            "exit_code": reporting.compute_exit_code(report["checks"]),
            "error": None}


class _Exit3Parser(argparse.ArgumentParser):
    """argparse failures (missing/unknown args, bad choices) exit 3 (r2)."""

    def error(self, message):
        self.exit(3, "%s: error: %s\n" % (self.prog, message))


def main(argv=None):
    parser = _Exit3Parser(
        description="B3-DIA diagnostic baseline comparison (no process spawn)")
    parser.add_argument("--plan-name", default="dia-baseline",
                        choices=("dia-baseline",))
    parser.add_argument("--diag-baseline", required=True)
    parser.add_argument("--diag-candidate", required=True)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--run-evidence", default=None,
                        help="candidate evidence JSON record path "
                             "(accepted but NEVER opened; reported as a gap)")
    parser.add_argument("--format", choices=("json", "text"), default="json")
    args = parser.parse_args(argv)
    outcome = run_cli(args.repo_root, args.diag_baseline,
                      args.diag_candidate, None, args.run_evidence)
    report = outcome["report"]
    if report is None:
        if args.format == "json":
            sys.stdout.write(json.dumps(
                {"error": outcome["error"], "exit_code": 3},
                ensure_ascii=False) + "\n")
        else:
            sys.stderr.write("error: %s\n" % outcome["error"])
        return 3
    if args.format == "json":
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    else:
        for c in report["checks"]:
            sys.stdout.write("%s: %s -- %s\n" % (
                c["check_id"], c["status"], c.get("details")))
        sys.stdout.write("overall: %s (exit %d)\n" % (
            report["overall_status"], outcome["exit_code"]))
    return outcome["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
