"""cloud-dev handoff: read-only regression handoff exporter (B4).

Reads exactly one reporting-1.1 build_report JSON document from stdin and
writes a human-facing handoff text to stdout. Read-only data export: this
tool initiates no checks and runs no commands.

Boundaries (Root 51671805, frozen):
- stdin-only input, read in a loop until true EOF with a 256 KiB total
  bound; stdout-only output, built fully first, checked against 4 MiB,
  then written once; short writes and I/O failures never report success
- non-finite numbers are refused anywhere in the document: NaN/Infinity
  tokens and out-of-range literals such as 1e999 map to exit 3
- no file open/write, no subprocess/socket/HTTP, no exec/eval/dynamic code
- bytecode writing is disabled before any other import: importing the
  deployed reporting module cannot drop __pycache__/*.pyc files, with
  no reliance on an external -B flag
- command-looking text is data: every input-derived value is rendered as a
  reversible JSON literal (json.dumps ensure_ascii=True, sort_keys=True)
  and never assembled into shell/HTML or parsed into argv; decoded values
  equal the input item by item
- exit 0 = the export itself succeeded; this is NOT the report's quality
  verdict -- the original report exit_code stays displayed in the header
- exit 3 = argument error or invalid/excessive input: one stderr line,
  stdout stays empty until the whole input is valid; the report is never
  silently fixed

Shared policy (reporting 1.1) is imported from the deployed reporting
module and re-used as-is; it is never re-implemented here.
"""

import sys

sys.dont_write_bytecode = True

import argparse
import json
import math

import reporting

FORMATS = ("text",)

TOP_FIELDS = frozenset({
    "schema_version", "tool", "generated_at_utc", "identity",
    "baseline_identity", "candidate_identity", "checks", "summary",
    "overall_status", "exit_code", "notes",
})
CHECK_FIELDS = frozenset({
    "check_id", "name", "category", "status", "required",
    "expected", "observed", "details",
})
IDENTITY_FIELDS = frozenset({"expected", "observed", "status", "details"})
SUMMARY_FIELDS = frozenset({
    "passed", "failed", "blocked", "skipped", "unverified", "total",
})

MAX_STDIN_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_DEPTH = 8        # root document = depth 0
MAX_NODES = 20000    # cumulative JSON nodes, keys included
MAX_CHECKS = 4096
MAX_STRING_BYTES = 64 * 1024  # per string, UTF-8 encoded

GROUP_ORDER = ("failed", "blocked", "skipped", "unverified", "passed")

FOOTER = (
    "This file is a read-only data export. It is not authorization, "
    "signature, or acceptance. No command was executed. Export tool exit "
    "0 is not the report's quality verdict; the report exit_code is shown "
    "in the header."
)


class HandoffError(Exception):
    """Refusal mapped to exit 3: argument error or invalid input."""


def _literal(value):
    """Render an input-derived value as a reversible JSON data literal."""
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _check_string(value, what):
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        raise HandoffError("lone surrogate in %s" % what)
    if size > MAX_STRING_BYTES:
        raise HandoffError("%s exceeds %d bytes limit"
                           % (what, MAX_STRING_BYTES))


def build_arg_parser():
    class _HandoffParser(argparse.ArgumentParser):
        def error(self, message):
            raise HandoffError("argument error: %s"
                               % _literal(str(message)))

    parser = _HandoffParser(
        prog="handoff.py",
        description="Read-only regression handoff exporter for one "
                    "reporting-1.1 build_report JSON document on stdin.")
    parser.add_argument("--format", default="text",
                        help="output format; only 'text' is supported")
    return parser


def read_stdin_bounded(reader):
    chunks = []
    total = 0
    while True:
        try:
            chunk = reader.read(MAX_STDIN_BYTES + 1 - total)
        except OSError:
            raise HandoffError("stdin read failed")
        if chunk is None:
            raise HandoffError("stdin unreadable")
        if chunk == b"":
            return b"".join(chunks)
        total += len(chunk)
        if total > MAX_STDIN_BYTES:
            raise HandoffError("stdin exceeds %d bytes limit" % MAX_STDIN_BYTES)
        chunks.append(chunk)


def _reject_constant(name):
    raise HandoffError("non-JSON constant in input: %s" % (name,))


def _object_pairs(pairs):
    seen = set()
    for key, _value in pairs:
        if key in seen:
            raise HandoffError("duplicate JSON key: %s" % _literal(key))
        seen.add(key)
    return dict(pairs)


def decode_json(raw):
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HandoffError("stdin is not valid UTF-8")
    try:
        doc = json.loads(text, object_pairs_hook=_object_pairs,
                         parse_constant=_reject_constant)
    except HandoffError:
        raise
    except RecursionError:
        raise HandoffError("input nesting too deep to parse")
    except ValueError:
        raise HandoffError("stdin is not valid JSON")
    counter = [0]
    _check_bounds(doc, 0, counter)
    return doc


def _check_bounds(value, depth, counter):
    counter[0] += 1
    if counter[0] > MAX_NODES:
        raise HandoffError("input exceeds %d node limit" % MAX_NODES)
    if depth > MAX_DEPTH:
        raise HandoffError("input exceeds depth %d limit" % MAX_DEPTH)
    if isinstance(value, float) and not math.isfinite(value):
        raise HandoffError("non-finite number in input")
    if isinstance(value, str):
        _check_string(value, "input string")
    elif isinstance(value, dict):
        for key, item in value.items():
            counter[0] += 1
            if counter[0] > MAX_NODES:
                raise HandoffError("input exceeds %d node limit" % MAX_NODES)
            _check_string(key, "input key")
            _check_bounds(item, depth + 1, counter)
    elif isinstance(value, list):
        for item in value:
            _check_bounds(item, depth + 1, counter)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _require_nonempty_str(value, label):
    if not isinstance(value, str) or not value:
        raise HandoffError("%s must be a non-empty string" % label)


def validate_report(doc):
    """Structural consistency only; no authorization or quality claims."""
    if not isinstance(doc, dict):
        raise HandoffError("report must be a JSON object")
    if set(doc) != TOP_FIELDS:
        missing = sorted(TOP_FIELDS - set(doc))
        unknown = sorted(set(doc) - TOP_FIELDS)
        raise HandoffError("report top-level fields mismatch (missing: %s; "
                           "unknown: %s)" % (_literal(missing),
                                             _literal(unknown)))
    if doc["schema_version"] != reporting.SCHEMA_VERSION:
        raise HandoffError("unsupported schema_version: %s"
                           % _literal(doc["schema_version"]))
    if not isinstance(doc["tool"], str):
        raise HandoffError("tool must be a string")
    if not isinstance(doc["generated_at_utc"], str):
        raise HandoffError("generated_at_utc must be a string")
    if not isinstance(doc["identity"], dict):
        raise HandoffError("identity must be an object")
    for label in ("baseline_identity", "candidate_identity"):
        block = doc[label]
        if not isinstance(block, dict) or set(block) != IDENTITY_FIELDS:
            raise HandoffError("%s must be an identity block with exactly "
                               "expected/observed/status/details" % label)
        if not isinstance(block["status"], str):
            raise HandoffError("%s.status must be a string" % label)
    checks = doc["checks"]
    if not isinstance(checks, list):
        raise HandoffError("checks must be a list")
    if len(checks) > MAX_CHECKS:
        raise HandoffError("checks exceed %d items limit" % MAX_CHECKS)
    seen_ids = set()
    for index, check in enumerate(checks):
        label = "checks[%d]" % index
        if not isinstance(check, dict) or set(check) != CHECK_FIELDS:
            raise HandoffError("%s must be a check object with exactly "
                               "check_id/name/category/status/required/"
                               "expected/observed/details" % label)
        for field in ("check_id", "name", "category"):
            _require_nonempty_str(check[field], "%s.%s" % (label, field))
        if not isinstance(check["required"], bool):
            raise HandoffError("%s.required must be a strict bool" % label)
        if check["status"] not in reporting.STATUSES:
            raise HandoffError("%s.status must be one of %s (shorthand "
                               "pass/fail belongs to overall_status)"
                               % (label, _literal(list(reporting.STATUSES))))
        if check["check_id"] in seen_ids:
            raise HandoffError("duplicate check_id: %s"
                               % _literal(check["check_id"]))
        seen_ids.add(check["check_id"])
    notes = doc["notes"]
    if (not isinstance(notes, list)
            or any(not isinstance(note, str) for note in notes)):
        raise HandoffError("notes must be a list of strings")
    summary = doc["summary"]
    if not isinstance(summary, dict) or set(summary) != SUMMARY_FIELDS:
        raise HandoffError("summary must hold exactly passed/failed/blocked/"
                           "skipped/unverified/total")
    for key, value in summary.items():
        if not _is_int(value) or value < 0:
            raise HandoffError("summary.%s must be a non-negative int "
                               "(not bool)" % key)
    if summary != reporting.summarize(checks):
        raise HandoffError("summary counts do not match checks")
    if summary["total"] != len(checks):
        raise HandoffError("summary.total does not match len(checks)")
    if doc["overall_status"] not in reporting.OVERALL_STATUSES:
        raise HandoffError("overall_status must be one of %s"
                           % _literal(list(reporting.OVERALL_STATUSES)))
    if doc["overall_status"] != reporting.overall_status(checks):
        raise HandoffError("overall_status does not match checks policy")
    if not _is_int(doc["exit_code"]) or doc["exit_code"] not in (0, 1, 2):
        raise HandoffError("exit_code must be int 0/1/2 (not bool)")
    if doc["exit_code"] != reporting.compute_exit_code(checks):
        raise HandoffError("exit_code does not match checks policy")
    return doc


def export_text(report):
    lines = []
    lines.append("== regression handoff (read-only data export) ==")
    lines.append("schema_version: %s" % _literal(report["schema_version"]))
    lines.append("tool: %s" % _literal(report["tool"]))
    lines.append("generated_at_utc: %s"
                 % _literal(report["generated_at_utc"]))
    lines.append("overall_status: %s" % _literal(report["overall_status"]))
    lines.append("exit_code: %s" % _literal(report["exit_code"]))
    lines.append("identity: %s" % _literal(report["identity"]))
    for label in ("baseline_identity", "candidate_identity"):
        block = report[label]
        for field in ("status", "expected", "observed", "details"):
            lines.append("%s.%s: %s"
                         % (label, field, _literal(block[field])))
    summary = report["summary"]
    lines.append("summary: passed=%d failed=%d blocked=%d skipped=%d "
                 "unverified=%d total=%d"
                 % (summary["passed"], summary["failed"], summary["blocked"],
                    summary["skipped"], summary["unverified"],
                    summary["total"]))
    lines.append("")
    for status in GROUP_ORDER:
        group = [c for c in report["checks"] if c["status"] == status]
        lines.append("-- %s (%d) --" % (status.upper(), len(group)))
        for position, check in enumerate(group, 1):
            lines.append("check %d:" % position)
            for field in ("check_id", "name", "category", "status",
                          "required", "expected", "observed", "details"):
                lines.append("  %s: %s" % (field, _literal(check[field])))
    lines.append("-- NOTES (%d) --" % len(report["notes"]))
    for note in report["notes"]:
        lines.append("  %s" % _literal(note))
    lines.append(FOOTER)
    return "\n".join(lines) + "\n"


def run_cli(argv=None):
    try:
        args = build_arg_parser().parse_args(argv)
        if args.format not in FORMATS:
            raise HandoffError("unsupported format: %s (only 'text' is "
                               "supported)" % _literal(args.format))
        raw = read_stdin_bounded(sys.stdin.buffer)
        report = validate_report(decode_json(raw))
        text = export_text(report)
        if len(text.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise HandoffError("output exceeds %d bytes limit"
                               % MAX_OUTPUT_BYTES)
    except HandoffError as err:
        message = str(err)
        if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in message):
            message = _literal(message)
        sys.stderr.write("handoff: %s\n" % (message,))
        return 3
    try:
        written = sys.stdout.write(text)
    except OSError:
        sys.stderr.write("handoff: stdout write failed\n")
        return 3
    if written != len(text):
        sys.stderr.write("handoff: stdout short write\n")
        return 3
    return 0


def main(argv=None):
    return run_cli(argv)


if __name__ == "__main__":
    sys.exit(main())
