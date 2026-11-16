"""cloud-dev reporting: shared report schema, status/exit-code policy, renderers.

Pure Python stdlib. Shared by B1..B4 tools (doctor/verify/baseline/report).

One outcome policy, applied identically to JSON, Markdown and the exit code:
  - any check "failed"                                -> overall "fail",       exit 1
  - any REQUIRED check blocked/skipped/unverified     -> overall "incomplete", exit 2
  - otherwise (OPTIONAL blocked/skipped do not block) -> overall "pass",       exit 0
Exit 3 is not a check outcome: each CLI maps invalid arguments/plan to 3
before any reporting happens, so a report never mixes the two.

Identity model (Root review 2026-10-18): expected pins and observed values
live in separate blocks (baseline_identity / candidate_identity). A pin is a
declaration ("expected"); only values actually measured in this run are
"observed". Anything not measured is "unverified" and reported as null,
never filled in from the pin.
"""

import json
from datetime import datetime, timezone

SCHEMA_VERSION = "1.1"

STATUSES = ("passed", "failed", "blocked", "skipped", "unverified")
INCOMPLETE_STATUSES = ("blocked", "skipped", "unverified")
OVERALL_STATUSES = ("pass", "incomplete", "fail")
OVERALL_TO_EXIT = {"pass": 0, "incomplete": 2, "fail": 1}


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_check(check_id, name, category, status, required, expected=None,
               observed=None, details=None):
    if status not in STATUSES:
        raise ValueError("invalid status: %r" % (status,))
    return {
        "check_id": check_id,
        "name": name,
        "category": category,
        "status": status,
        "required": bool(required),
        "expected": expected,
        "observed": observed,
        "details": details,
    }


def make_identity_block(expected=None, observed=None, status="unverified",
                        details=None):
    """Identity block: 'expected' = declared pin; 'observed' = measured this run."""
    return {
        "expected": expected,
        "observed": observed,
        "status": status,
        "details": details,
    }


def summarize(checks):
    summary = {status: 0 for status in STATUSES}
    summary["total"] = len(checks)
    for check in checks:
        summary[check["status"]] += 1
    return summary


def overall_status(checks):
    """Same rule as compute_exit_code: fail outranks required-incomplete outranks pass."""
    for check in checks:
        if check["status"] == "failed":
            return "fail"
    for check in checks:
        if check["required"] and check["status"] in INCOMPLETE_STATUSES:
            return "incomplete"
    return "pass"


def compute_exit_code(checks):
    """Task-book exit policy over a check list (exit 3 is CLI-only)."""
    return OVERALL_TO_EXIT[overall_status(checks)]


def build_report(tool, checks, identity=None, baseline_identity=None,
                 candidate_identity=None, notes=None, generated_at_utc=None):
    overall = overall_status(checks)
    return {
        "schema_version": SCHEMA_VERSION,
        "tool": tool,
        "generated_at_utc": generated_at_utc or utc_now_iso(),
        "identity": dict(identity or {}),
        "baseline_identity": baseline_identity or make_identity_block(
            details="not provided by this tool"),
        "candidate_identity": candidate_identity or make_identity_block(
            details="not provided by this tool"),
        "checks": list(checks),
        "summary": summarize(checks),
        "overall_status": overall,
        "exit_code": OVERALL_TO_EXIT[overall],
        "notes": list(notes or []),
    }


def _cell(value):
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False).replace("|", "\\|")


def _render_identity_block(lines, label, block):
    lines.append("- %s.status: %s" % (label, block.get("status")))
    if block.get("expected") is not None:
        lines.append("- %s.expected: %s" % (
            label, json.dumps(block["expected"], ensure_ascii=False, sort_keys=True)))
    lines.append("- %s.observed: %s" % (
        label, json.dumps(block.get("observed"), ensure_ascii=False, sort_keys=True)))
    if block.get("details"):
        lines.append("- %s.details: %s" % (label, block["details"]))


def render_markdown(report):
    lines = []
    lines.append("# %s report" % report["tool"])
    lines.append("")
    lines.append("- schema_version: %s" % report["schema_version"])
    lines.append("- generated_at_utc: %s" % report["generated_at_utc"])
    lines.append("- overall_status: %s" % report["overall_status"])
    lines.append("- exit_code: %d" % report["exit_code"])
    for key in sorted(report["identity"]):
        lines.append("- identity.%s: %s" % (
            key, json.dumps(report["identity"][key], ensure_ascii=False, sort_keys=True)))
    _render_identity_block(lines, "baseline_identity", report["baseline_identity"])
    _render_identity_block(lines, "candidate_identity", report["candidate_identity"])
    lines.append("")
    lines.append("| check_id | status | required | expected | observed |")
    lines.append("| --- | --- | --- | --- | --- |")
    for check in report["checks"]:
        lines.append("| %s | %s | %s | %s | %s |" % (
            check["check_id"], check["status"],
            "required" if check["required"] else "optional",
            _cell(check["expected"]), _cell(check["observed"])))
    lines.append("")
    lines.append("Summary: passed=%(passed)d failed=%(failed)d blocked=%(blocked)d "
                 "skipped=%(skipped)d unverified=%(unverified)d total=%(total)d"
                 % report["summary"])
    for note in report["notes"]:
        lines.append("Note: %s" % note)
    return chr(10).join(lines)
