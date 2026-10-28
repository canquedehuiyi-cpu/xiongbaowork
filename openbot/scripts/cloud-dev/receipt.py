"""Structural validator for B5-RC1 receipt documents (schema b5rc1/1.0-d3).

Contract frozen by Root in the B5-RC1 D3 checkpoint. This module is a
pure-function validator: no CLI, no main, no file, network, subprocess or
environment access, and no import of or change to the existing reporting
modules. It judges one thing only: whether a receipt document is internally
consistent with the frozen D3 schema. It does not prove that anything ran,
it does not authorise a run, and it does not sign anything.

Public API is a single function, validate_receipt_bytes(raw), which takes an
exact bytes object and returns a dict with exactly five keys:

    structure              "valid" or "invalid"
    claimed_status         one of the five status words, or None
    derived_status         derived status when structure is "valid", else None
    evidence_verification  always "unverified"
    violations             list of {"code": <code>, "pointer": <pointer>}

Violation codes are V-size, V-encoding, V-json, V-jsondup, V-jsondepth,
V-root, V-unknown, V-missing, V-type, V-range, V-value, V-enum, V-fmt,
V-strlen, V-budget, V-unique, V-mode, V-order, V-invariant, V-status and
V-gate. D2 reported a claim/derive mismatch through V-pass and V-gate; D3
keeps the mismatch on V-status and keeps V-gate only for the narrower fact
"claimed passed while ticket or gate is null". Pointers name a schema
position or an array index and never carry payload values.
"""

import json
import re

SCHEMA_LITERAL = "b5rc1/1.0-d3"
EVIDENCE_VERIFICATION = "unverified"
EMPTY_LOG_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

MAX_RAW_BYTES = 8192
MAX_STRING_BYTES = 512
MAX_JSON_DEPTH = 8
MAX_BLOCKED_BY = 9
MAX_ARGV = 32
MAX_EXPECTED = 16
MAX_OBSERVED = 16

MAX_SAFE_INTEGER = 9007199254740991
INT32_MIN = -2147483648
INT32_MAX = 2147483647
MAX_TASK_STEP = 65535

STATUS_VALUES = ("passed", "failed", "blocked", "skipped", "unverified")
MODE_VALUES = ("single", "producer_exporter")
SINGLE_STAGE_NAMES = ("command",)
PIPELINE_STAGE_NAMES = ("producer", "exporter")
BLOCKED_BY_VALUES = (
    "gate",
    "serialslot",
    "resources",
    "manifest",
    "interpreter",
    "cwd",
    "permissions",
    "environment",
    "evidence",
)
SOURCE_VALUES = ("measured", "declared", "unknown")

TOP_KEYS = (
    "schema",
    "mode",
    "ticket",
    "gate",
    "task",
    "stages",
    "expected",
    "observed",
    "status",
    "evidence_verification",
    "blocked_by",
    "notes",
    "client",
)
TASK_KEYS = ("batch", "step", "package", "cwd")
STAGE_KEYS = (
    "name",
    "applies",
    "argv",
    "interpreter",
    "attempt",
    "command",
    "exit",
    "stdout",
    "stderr",
)
INTERPRETER_KEYS = ("path", "version")
WINDOW_KEYS = ("started_at_utc", "ended_at_utc")
EXIT_KEYS = ("code", "signal", "timeout", "not_started")
LOG_KEYS = ("bytes", "sha256", "retained_ref")
EXPECTED_KEYS = ("path", "bytes", "sha256", "blob")
OBSERVED_KEYS = ("path", "bytes", "sha256", "source", "measured_at_utc")
CLIENT_KEYS = ("name", "model")

TIME_PATTERN = re.compile(
    r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?Z$"
)
HEX64_PATTERN = re.compile(r"^[0-9a-f]{64}$")
HEX40_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def _violation(code, pointer):
    return {"code": code, "pointer": pointer}


def _join(pointer, token):
    if pointer == "/":
        return "/" + token
    return pointer + "/" + token


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _utf8_size(value):
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return -1


def _sorted_violations(violations):
    unique = []
    seen = set()
    for item in violations:
        token = (item["code"], item["pointer"])
        if token in seen:
            continue
        seen.add(token)
        unique.append(item)
    unique.sort(key=lambda item: (item["pointer"], item["code"]))
    return unique


def _closed_keys(obj, keys, pointer, violations):
    if not isinstance(obj, dict):
        violations.append(_violation("V-type", pointer))
        return False
    allowed = set(keys)
    for key in obj:
        if key not in allowed:
            violations.append(_violation("V-unknown", pointer))
    complete = True
    for key in keys:
        if key not in obj:
            violations.append(_violation("V-missing", _join(pointer, key)))
            complete = False
    return complete


def _check_string(value, pointer, violations, allow_null=False, non_empty=False):
    if value is None:
        if allow_null:
            return True
        violations.append(_violation("V-type", pointer))
        return False
    if not isinstance(value, str):
        violations.append(_violation("V-type", pointer))
        return False
    size = _utf8_size(value)
    if size < 0:
        violations.append(_violation("V-encoding", pointer))
        return False
    if size > MAX_STRING_BYTES:
        violations.append(_violation("V-strlen", pointer))
        return False
    if non_empty and size == 0:
        violations.append(_violation("V-value", pointer))
        return False
    return True


def _check_int(value, pointer, violations, minimum, maximum, allow_null=False):
    if value is None:
        if allow_null:
            return True
        violations.append(_violation("V-type", pointer))
        return False
    if not _is_int(value):
        violations.append(_violation("V-type", pointer))
        return False
    if value < minimum or value > maximum:
        violations.append(_violation("V-range", pointer))
        return False
    return True


def _check_bool(value, pointer, violations):
    if isinstance(value, bool):
        return True
    violations.append(_violation("V-type", pointer))
    return False


def _check_literal(value, expected, pointer, violations):
    if not isinstance(value, str):
        violations.append(_violation("V-type", pointer))
        return False
    if not _check_string(value, pointer, violations):
        return False
    if value != expected:
        violations.append(_violation("V-value", pointer))
        return False
    return True


def _check_member(value, allowed, pointer, violations):
    if not isinstance(value, str):
        violations.append(_violation("V-type", pointer))
        return False
    if not _check_string(value, pointer, violations):
        return False
    if value not in allowed:
        violations.append(_violation("V-enum", pointer))
        return False
    return True


def _check_sha256(value, pointer, violations, allow_null=False):
    if value is None:
        if allow_null:
            return True
        violations.append(_violation("V-type", pointer))
        return False
    if not isinstance(value, str):
        violations.append(_violation("V-type", pointer))
        return False
    if HEX64_PATTERN.fullmatch(value) is None:
        violations.append(_violation("V-fmt", pointer))
        return False
    return True


def _check_blob(value, pointer, violations):
    if value is None:
        return True
    if not isinstance(value, str):
        violations.append(_violation("V-type", pointer))
        return False
    if HEX40_PATTERN.fullmatch(value) is None:
        violations.append(_violation("V-fmt", pointer))
        return False
    return True


def _days_in_month(year, month):
    if month == 2:
        if year % 400 == 0:
            return 29
        if year % 100 == 0:
            return 28
        if year % 4 == 0:
            return 29
        return 28
    if month == 4 or month == 6 or month == 9 or month == 11:
        return 30
    return 31


def _parse_time(value):
    if not isinstance(value, str):
        return None
    match = TIME_PATTERN.fullmatch(value)
    if match is None:
        return None
    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    hour = int(match.group(4))
    minute = int(match.group(5))
    second = int(match.group(6))
    fraction = match.group(7)
    if year < 1:
        return None
    if month < 1 or month > 12:
        return None
    if day < 1 or day > _days_in_month(year, month):
        return None
    if hour > 23 or minute > 59 or second > 59:
        return None
    if fraction is None:
        micro = 0
    else:
        micro = int(fraction.ljust(6, "0"))
    return (year, month, day, hour, minute, second, micro)


def _read_time(value, pointer, violations):
    if value is None:
        return (True, None)
    if not isinstance(value, str):
        violations.append(_violation("V-type", pointer))
        return (False, None)
    parsed = _parse_time(value)
    if parsed is None:
        violations.append(_violation("V-fmt", pointer))
        return (False, None)
    return (True, parsed)


def _document_depth(document):
    depth = 0
    stack = [(document, 1)]
    while stack:
        node, level = stack.pop()
        if level > depth:
            depth = level
        if isinstance(node, dict):
            for child in node.values():
                stack.append((child, level + 1))
        elif isinstance(node, list):
            for child in node:
                stack.append((child, level + 1))
    return depth


def _check_window(container, pointer, violations):
    _closed_keys(container, WINDOW_KEYS, pointer, violations)
    if not isinstance(container, dict):
        return (None, None, False)
    started_ok, started = False, None
    ended_ok, ended = False, None
    if "started_at_utc" in container:
        started_ok, started = _read_time(
            container["started_at_utc"], _join(pointer, "started_at_utc"), violations
        )
    if "ended_at_utc" in container:
        ended_ok, ended = _read_time(
            container["ended_at_utc"], _join(pointer, "ended_at_utc"), violations
        )
    if started_ok and ended_ok and started is not None and ended is not None:
        if ended < started:
            violations.append(_violation("V-order", pointer))
    return (started, ended, started_ok and ended_ok)

def _check_log(container, pointer, violations):
    _closed_keys(container, LOG_KEYS, pointer, violations)
    if not isinstance(container, dict):
        return None
    if "bytes" in container:
        _check_int(
            container["bytes"], _join(pointer, "bytes"), violations,
            0, MAX_SAFE_INTEGER, allow_null=True,
        )
    if "sha256" in container:
        _check_sha256(
            container["sha256"], _join(pointer, "sha256"), violations, allow_null=True
        )
    if "retained_ref" in container:
        _check_string(
            container["retained_ref"], _join(pointer, "retained_ref"), violations,
            allow_null=True, non_empty=True,
        )
    try:
        serialised = json.dumps(container, ensure_ascii=False, separators=(",", ":"))
        size = len(serialised.encode("utf-8"))
    except (TypeError, ValueError, UnicodeEncodeError):
        size = -1
    if size < 0:
        violations.append(_violation("V-encoding", pointer))
    elif size > MAX_STRING_BYTES:
        violations.append(_violation("V-budget", pointer))
    return container

def _check_client(client, violations):
    if client is None:
        return
    _closed_keys(client, CLIENT_KEYS, "/client", violations)
    if not isinstance(client, dict):
        return
    for key in CLIENT_KEYS:
        if key in client:
            _check_string(client[key], _join("/client", key), violations, non_empty=True)

def _check_task(task, violations):
    _closed_keys(task, TASK_KEYS, "/task", violations)
    if not isinstance(task, dict):
        return
    for key in ("batch", "package", "cwd"):
        if key in task:
            _check_string(task[key], _join("/task", key), violations, non_empty=True)
    if "step" in task:
        _check_int(task["step"], "/task/step", violations, 1, MAX_TASK_STEP)

def _check_blocked_by(values, violations):
    if not isinstance(values, list):
        violations.append(_violation("V-type", "/blocked_by"))
        return
    if len(values) > MAX_BLOCKED_BY:
        violations.append(_violation("V-budget", "/blocked_by"))
    seen = set()
    for index, value in enumerate(values):
        pointer = "/blocked_by/%d" % index
        _check_member(value, BLOCKED_BY_VALUES, pointer, violations)
        if isinstance(value, str):
            if value in seen:
                violations.append(_violation("V-unique", pointer))
            seen.add(value)


def _check_expected(items, violations):
    if not isinstance(items, list):
        violations.append(_violation("V-type", "/expected"))
        return
    if len(items) > MAX_EXPECTED:
        violations.append(_violation("V-budget", "/expected"))
    seen = set()
    for index, item in enumerate(items):
        pointer = "/expected/%d" % index
        _closed_keys(item, EXPECTED_KEYS, pointer, violations)
        if not isinstance(item, dict):
            continue
        if "path" in item:
            _check_string(item["path"], _join(pointer, "path"), violations, non_empty=True)
        if "bytes" in item:
            _check_int(item["bytes"], _join(pointer, "bytes"), violations, 0, MAX_SAFE_INTEGER)
        if "sha256" in item:
            _check_sha256(item["sha256"], _join(pointer, "sha256"), violations)
        if "blob" in item:
            _check_blob(item["blob"], _join(pointer, "blob"), violations)
        path = item.get("path")
        if isinstance(path, str):
            if path in seen:
                violations.append(_violation("V-unique", _join(pointer, "path")))
            seen.add(path)

def _check_observed(items, violations):
    if not isinstance(items, list):
        violations.append(_violation("V-type", "/observed"))
        return
    if len(items) > MAX_OBSERVED:
        violations.append(_violation("V-budget", "/observed"))
    seen = set()
    for index, item in enumerate(items):
        pointer = "/observed/%d" % index
        _closed_keys(item, OBSERVED_KEYS, pointer, violations)
        if not isinstance(item, dict):
            continue
        if "path" in item:
            _check_string(item["path"], _join(pointer, "path"), violations, non_empty=True)
        if "bytes" in item:
            _check_int(
                item["bytes"], _join(pointer, "bytes"), violations,
                0, MAX_SAFE_INTEGER, allow_null=True,
            )
        if "sha256" in item:
            _check_sha256(item["sha256"], _join(pointer, "sha256"), violations, allow_null=True)
        if "source" in item:
            _check_member(item["source"], SOURCE_VALUES, _join(pointer, "source"), violations)
        if "measured_at_utc" in item:
            _read_time(item["measured_at_utc"], _join(pointer, "measured_at_utc"), violations)
        path = item.get("path")
        if isinstance(path, str):
            if path in seen:
                violations.append(_violation("V-unique", _join(pointer, "path")))
            seen.add(path)

def _check_stage_invariants(stage, pointer, code, signal_value, timeout, not_started,
                            command_started, command_ended, stdout_log, stderr_log,
                            violations):
    if not_started is True:
        if code is not None:
            violations.append(
                _violation("V-invariant", _join(_join(pointer, "exit"), "code"))
            )
        if signal_value is not None:
            violations.append(
                _violation("V-invariant", _join(_join(pointer, "exit"), "signal"))
            )
        if command_started is not None:
            violations.append(
                _violation(
                    "V-invariant", _join(_join(pointer, "command"), "started_at_utc")
                )
            )
        if command_ended is not None:
            violations.append(
                _violation(
                    "V-invariant", _join(_join(pointer, "command"), "ended_at_utc")
                )
            )
        for log, side in ((stdout_log, "stdout"), (stderr_log, "stderr")):
            if log is None:
                continue
            for key in LOG_KEYS:
                if key in log and log[key] is not None:
                    violations.append(
                        _violation("V-invariant", _join(_join(pointer, side), key))
                    )
    if not_started is False and isinstance(stage.get("argv"), list) and not stage["argv"]:
        violations.append(_violation("V-invariant", _join(pointer, "argv")))
    if (not_started is False and isinstance(stage.get("command"), dict)
            and "started_at_utc" in stage["command"]
            and stage["command"]["started_at_utc"] is None):
        violations.append(
            _violation("V-invariant", _join(_join(pointer, "command"), "started_at_utc"))
        )
    if stage.get("applies") is False:
        if isinstance(stage.get("argv"), list) and stage["argv"]:
            violations.append(_violation("V-invariant", _join(pointer, "argv")))
        if isinstance(stage.get("interpreter"), dict):
            for key in INTERPRETER_KEYS:
                if stage["interpreter"].get(key) is not None:
                    violations.append(
                        _violation(
                            "V-invariant", _join(_join(pointer, "interpreter"), key)
                        )
                    )
        if isinstance(stage.get("attempt"), dict):
            for key in WINDOW_KEYS:
                if stage["attempt"].get(key) is not None:
                    violations.append(
                        _violation("V-invariant", _join(_join(pointer, "attempt"), key))
                    )
        if isinstance(stage.get("command"), dict):
            for key in WINDOW_KEYS:
                if stage["command"].get(key) is not None:
                    violations.append(
                        _violation("V-invariant", _join(_join(pointer, "command"), key))
                    )
        if code is not None:
            violations.append(
                _violation("V-invariant", _join(_join(pointer, "exit"), "code"))
            )
        if signal_value is not None:
            violations.append(
                _violation("V-invariant", _join(_join(pointer, "exit"), "signal"))
            )
        if timeout is True:
            violations.append(
                _violation("V-invariant", _join(_join(pointer, "exit"), "timeout"))
            )
        if not_started is False:
            violations.append(
                _violation("V-invariant", _join(_join(pointer, "exit"), "not_started"))
            )
        for log, side in ((stdout_log, "stdout"), (stderr_log, "stderr")):
            if log is None:
                continue
            for key in LOG_KEYS:
                if key in log and log[key] is not None:
                    violations.append(
                        _violation("V-invariant", _join(_join(pointer, side), key))
                    )


def _check_stage(stage, index, violations):
    pointer = "/stages/%d" % index
    _closed_keys(stage, STAGE_KEYS, pointer, violations)
    if not isinstance(stage, dict):
        return False

    if "name" in stage:
        _check_string(stage["name"], _join(pointer, "name"), violations, non_empty=True)
    if "applies" in stage:
        _check_bool(stage["applies"], _join(pointer, "applies"), violations)

    if "argv" in stage:
        argv = stage["argv"]
        argv_pointer = _join(pointer, "argv")
        if not isinstance(argv, list):
            violations.append(_violation("V-type", argv_pointer))
        else:
            if len(argv) > MAX_ARGV:
                violations.append(_violation("V-budget", argv_pointer))
            for position, value in enumerate(argv):
                _check_string(value, _join(argv_pointer, str(position)), violations)

    if "interpreter" in stage:
        interpreter_pointer = _join(pointer, "interpreter")
        interpreter = stage["interpreter"]
        _closed_keys(interpreter, INTERPRETER_KEYS, interpreter_pointer, violations)
        if isinstance(interpreter, dict):
            for key in INTERPRETER_KEYS:
                if key in interpreter:
                    _check_string(
                        interpreter[key], _join(interpreter_pointer, key), violations,
                        allow_null=True, non_empty=True,
                    )

    attempt_started, attempt_ended, attempt_ok = None, None, False
    command_started, command_ended, command_ok = None, None, False
    command_pointer = _join(pointer, "command")
    if "attempt" in stage:
        attempt_started, attempt_ended, attempt_ok = _check_window(
            stage["attempt"], _join(pointer, "attempt"), violations
        )
    if "command" in stage:
        command_started, command_ended, command_ok = _check_window(
            stage["command"], command_pointer, violations
        )
    # This relation needs only these two successfully parsed endpoints; an
    # unrelated missing window field must not hide a safely checkable order.
    if attempt_ended is not None and command_started is not None:
        if command_started < attempt_ended:
            violations.append(_violation("V-order", command_pointer))

    exit_pointer = _join(pointer, "exit")
    code = None
    signal_value = None
    timeout = None
    not_started = None
    if "exit" in stage:
        exit_container = stage["exit"]
        _closed_keys(exit_container, EXIT_KEYS, exit_pointer, violations)
        if isinstance(exit_container, dict):
            if "code" in exit_container:
                code = exit_container["code"]
                _check_int(
                    code, _join(exit_pointer, "code"), violations,
                    INT32_MIN, INT32_MAX, allow_null=True,
                )
            if "signal" in exit_container:
                signal_value = exit_container["signal"]
                _check_string(
                    signal_value, _join(exit_pointer, "signal"), violations,
                    allow_null=True, non_empty=True,
                )
            if "timeout" in exit_container:
                timeout = exit_container["timeout"]
                _check_bool(timeout, _join(exit_pointer, "timeout"), violations)
            if "not_started" in exit_container:
                not_started = exit_container["not_started"]
                _check_bool(not_started, _join(exit_pointer, "not_started"), violations)

    stdout_log = None
    stderr_log = None
    if "stdout" in stage:
        stdout_log = _check_log(stage["stdout"], _join(pointer, "stdout"), violations)
    if "stderr" in stage:
        stderr_log = _check_log(stage["stderr"], _join(pointer, "stderr"), violations)

    _check_stage_invariants(
        stage,
        pointer,
        code,
        signal_value,
        timeout,
        not_started,
        command_started,
        command_ended,
        stdout_log,
        stderr_log,
        violations,
    )
    return True

def _check_stages(document, violations):
    stages = document["stages"]
    mode = document.get("mode")
    if not isinstance(stages, list):
        violations.append(_violation("V-type", "/stages"))
        return
    expected_count = None
    if mode == "single":
        expected_count = 1
    elif mode == "producer_exporter":
        expected_count = 2
    if expected_count is not None and len(stages) != expected_count:
        violations.append(_violation("V-mode", "/stages"))
    expected_names = None
    if mode == "single":
        expected_names = SINGLE_STAGE_NAMES
    elif mode == "producer_exporter":
        expected_names = PIPELINE_STAGE_NAMES
    names = []
    for index, stage in enumerate(stages):
        if not _check_stage(stage, index, violations):
            continue
        if isinstance(stage.get("name"), str):
            names.append(stage["name"])
            if expected_names is not None and index < len(expected_names):
                if stage["name"] != expected_names[index]:
                    violations.append(_violation("V-mode", "/stages"))
    if len(set(names)) != len(names):
        violations.append(_violation("V-unique", "/stages"))


def _check_document(document, violations):
    _closed_keys(document, TOP_KEYS, "/", violations)

    if "schema" in document:
        _check_literal(document["schema"], SCHEMA_LITERAL, "/schema", violations)
    if "mode" in document:
        _check_member(document["mode"], MODE_VALUES, "/mode", violations)
    if "ticket" in document:
        _check_int(
            document["ticket"], "/ticket", violations, 1, MAX_SAFE_INTEGER,
            allow_null=True,
        )
    if "gate" in document:
        _check_int(
            document["gate"], "/gate", violations, 1, MAX_SAFE_INTEGER,
            allow_null=True,
        )
    if "status" in document:
        _check_member(document["status"], STATUS_VALUES, "/status", violations)
    if "evidence_verification" in document:
        _check_literal(
            document["evidence_verification"], EVIDENCE_VERIFICATION,
            "/evidence_verification", violations,
        )
    if "notes" in document:
        _check_string(document["notes"], "/notes", violations, allow_null=True)
    if "client" in document:
        _check_client(document["client"], violations)
    if "task" in document:
        _check_task(document["task"], violations)
    if "blocked_by" in document:
        _check_blocked_by(document["blocked_by"], violations)
    if "expected" in document:
        _check_expected(document["expected"], violations)
    if "observed" in document:
        _check_observed(document["observed"], violations)
    if "stages" in document:
        _check_stages(document, violations)


def _s4_holds(document, applicable):
    for stage in applicable:
        exit_container = stage["exit"]
        if exit_container["not_started"] is not False:
            return False
        if exit_container["timeout"] is not False:
            return False
        if exit_container["code"] != 0:
            return False
        if exit_container["signal"] is not None:
            return False
        command = stage["command"]
        if command["started_at_utc"] is None or command["ended_at_utc"] is None:
            return False
        interpreter = stage["interpreter"]
        if interpreter["path"] is None or interpreter["version"] is None:
            return False
        for side in ("stdout", "stderr"):
            log = stage[side]
            if log["bytes"] is None:
                return False
            if log["sha256"] is None:
                return False
            if log["retained_ref"] is None:
                return False
            if log["bytes"] == 0 and log["sha256"] != EMPTY_LOG_SHA256:
                return False
    expected = document["expected"]
    if not expected:
        return False
    observed_index = {}
    for item in document["observed"]:
        observed_index[item["path"]] = item
    for item in expected:
        observed = observed_index.get(item["path"])
        if observed is None:
            return False
        if observed["bytes"] != item["bytes"]:
            return False
        if observed["sha256"] != item["sha256"]:
            return False
        if observed["source"] != "measured":
            return False
        if observed["measured_at_utc"] is None:
            return False
    return True


def _derive_status(document):
    stages = document["stages"]
    blocked_by = document["blocked_by"]
    applicable = []
    for stage in stages:
        if stage["applies"] is True:
            applicable.append(stage)
    if not applicable and not blocked_by:
        return "skipped"
    for stage in applicable:
        exit_container = stage["exit"]
        if exit_container["not_started"] is False:
            if _is_int(exit_container["code"]) and exit_container["code"] != 0:
                return "failed"
    if applicable and blocked_by:
        all_not_started = True
        for stage in applicable:
            if stage["exit"]["not_started"] is not True:
                all_not_started = False
        if all_not_started:
            return "blocked"
    if applicable and not blocked_by:
        if document["ticket"] is not None and document["gate"] is not None:
            if _s4_holds(document, applicable):
                return "passed"
    return "unverified"


def _invalid(claimed_status, violations):
    return {
        "structure": "invalid",
        "claimed_status": claimed_status,
        "derived_status": None,
        "evidence_verification": EVIDENCE_VERIFICATION,
        "violations": _sorted_violations(violations),
    }


def validate_receipt_bytes(raw):
    if not isinstance(raw, bytes):
        raise TypeError("validate_receipt_bytes() requires exact bytes")
    if len(raw) > MAX_RAW_BYTES:
        return _invalid(None, [_violation("V-size", "/")])
    if raw.startswith(b"\xef\xbb\xbf"):
        return _invalid(None, [_violation("V-encoding", "/")])
    if b"\r" in raw:
        return _invalid(None, [_violation("V-encoding", "/")])
    if not raw.endswith(b"\n") or raw.endswith(b"\n\n"):
        return _invalid(None, [_violation("V-encoding", "/")])
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return _invalid(None, [_violation("V-encoding", "/")])

    duplicates = []

    def _pairs(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                duplicates.append(key)
            obj[key] = value
        return obj

    def _reject_constant(name):
        raise ValueError("non-finite constant")

    try:
        document = json.loads(
            text, object_pairs_hook=_pairs, parse_constant=_reject_constant
        )
    except RecursionError:
        return _invalid(None, [_violation("V-jsondepth", "/")])
    except ValueError:
        return _invalid(None, [_violation("V-json", "/")])

    if duplicates:
        return _invalid(None, [_violation("V-jsondup", "/")])
    if _document_depth(document) > MAX_JSON_DEPTH:
        return _invalid(None, [_violation("V-jsondepth", "/")])
    if not isinstance(document, dict):
        return _invalid(None, [_violation("V-root", "/")])

    claimed = None
    status_value = document.get("status")
    if isinstance(status_value, str):
        if status_value in STATUS_VALUES:
            claimed = status_value

    violations = []
    _check_document(document, violations)
    if violations:
        return _invalid(claimed, violations)

    derived = _derive_status(document)
    if claimed != derived:
        blocked = [_violation("V-status", "/status")]
        if claimed == "passed":
            if document["ticket"] is None or document["gate"] is None:
                blocked.append(_violation("V-gate", "/gate"))
        return _invalid(claimed, blocked)

    return {
        "structure": "valid",
        "claimed_status": claimed,
        "derived_status": derived,
        "evidence_verification": EVIDENCE_VERIFICATION,
        "violations": [],
    }
