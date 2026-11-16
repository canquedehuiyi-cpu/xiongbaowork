"""Definition-level tests for receipt.py (schema b5rc1/1.0-d3).

Every test builds its document in memory. No test starts a process, reads a
file, reads the environment or touches the network, and no test imports or
runs the cloud-dev driver, exporter or any existing reporting module.

Test methods do not run automatically: there is no unittest.main() call.
Import still initialises constants/regex (in receipt), changes sys.path and
sys.dont_write_bytecode, and defines classes. No import was performed on delivery.

The single "passed" fixture in this file is definition-level data invented to
exercise the S4 branch. It is not a real receipt, not an execution record and
not evidence of anything having run.
"""

import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import receipt

EMPTY_SHA = receipt.EMPTY_LOG_SHA256
GOOD_SHA = "a" * 64
OTHER_SHA = "c" * 64
GOOD_BLOB = "b" * 40
T0 = "2026-10-19T00:00:00Z"
T1 = "2026-10-19T00:00:01Z"
T2 = "2026-10-19T00:00:02Z"
T9 = "2026-10-19T00:00:09Z"


def empty_log():
    return {"bytes": None, "sha256": None, "retained_ref": None}


def empty_window():
    return {"started_at_utc": None, "ended_at_utc": None}


def idle_stage(name="command"):
    return {
        "name": name,
        "applies": True,
        "argv": [],
        "interpreter": {"path": None, "version": None},
        "attempt": empty_window(),
        "command": empty_window(),
        "exit": {"code": None, "signal": None, "timeout": False, "not_started": True},
        "stdout": empty_log(),
        "stderr": empty_log(),
    }


def started_stage(name="command", code=0):
    stage = idle_stage(name)
    stage["argv"] = ["--emit"]
    stage["interpreter"] = {"path": "python3", "version": "3.11.9"}
    stage["attempt"] = {"started_at_utc": T0, "ended_at_utc": T1}
    stage["command"] = {"started_at_utc": T1, "ended_at_utc": T2}
    stage["exit"] = {
        "code": code,
        "signal": None,
        "timeout": False,
        "not_started": False,
    }
    stage["stdout"] = {"bytes": 0, "sha256": EMPTY_SHA, "retained_ref": "ref:" + name}
    stage["stderr"] = {"bytes": 0, "sha256": EMPTY_SHA, "retained_ref": "ref:" + name}
    return stage


def base_document(mode="single"):
    return {
        "schema": "b5rc1/1.0-d3",
        "mode": mode,
        "ticket": None,
        "gate": None,
        "task": {"batch": "B5", "step": 1, "package": "receipt", "cwd": "openbot"},
        "stages": [idle_stage()],
        "expected": [],
        "observed": [],
        "status": "blocked",
        "evidence_verification": "unverified",
        "blocked_by": ["gate", "serialslot"],
        "notes": None,
        "client": None,
    }


def pipeline_document():
    document = base_document("producer_exporter")
    document["stages"] = [started_stage("producer"), started_stage("exporter")]
    document["blocked_by"] = []
    document["status"] = "unverified"
    return document


def passed_document():
    document = base_document()
    document["ticket"] = 51682006
    document["gate"] = 51682006
    document["blocked_by"] = []
    document["stages"] = [started_stage("command")]
    document["expected"] = [
        {"path": "openbot/x.py", "bytes": 10, "sha256": GOOD_SHA, "blob": GOOD_BLOB}
    ]
    document["observed"] = [
        {
            "path": "openbot/x.py",
            "bytes": 10,
            "sha256": GOOD_SHA,
            "source": "measured",
            "measured_at_utc": T9,
        }
    ]
    document["status"] = "passed"
    return document


def encode(document):
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    return text.encode("utf-8") + b"\n"


def run(document):
    return receipt.validate_receipt_bytes(encode(document))


def codes(result):
    return sorted({item["code"] for item in result["violations"]})


class ReceiptResultContractTests(unittest.TestCase):
    def test_result_has_exactly_five_fixed_keys(self):
        result = run(base_document())
        self.assertEqual(
            sorted(result.keys()),
            [
                "claimed_status",
                "derived_status",
                "evidence_verification",
                "structure",
                "violations",
            ],
        )
        self.assertEqual(result["evidence_verification"], "unverified")

    def test_invalid_result_never_derives(self):
        document = base_document()
        document["notes"] = 5
        result = run(document)
        self.assertEqual(result["structure"], "invalid")
        self.assertIsNone(result["derived_status"])

    def test_valid_result_has_empty_violations(self):
        result = run(base_document())
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["violations"], [])

    def test_claimed_status_is_null_for_illegal_word(self):
        document = base_document()
        document["status"] = "done"
        result = run(document)
        self.assertIsNone(result["claimed_status"])
        self.assertIn("V-enum", codes(result))

    def test_non_bytes_input_is_a_programming_error(self):
        with self.assertRaises(TypeError):
            receipt.validate_receipt_bytes("{}")

    def test_pointers_never_carry_payload(self):
        document = base_document()
        document["task"]["step"] = "SECRETMARKER"
        result = run(document)
        self.assertIn("V-type", codes(result))
        for item in result["violations"]:
            self.assertNotIn("SECRETMARKER", item["pointer"])


class ReceiptStatusDerivationTests(unittest.TestCase):
    def test_single_blocked_shape_is_valid(self):
        result = run(base_document())
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "blocked")
        self.assertEqual(result["claimed_status"], "blocked")

    def test_pipeline_missing_evidence_is_unverified(self):
        result = run(pipeline_document())
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "unverified")

    def test_definition_only_passed_shape_is_valid(self):
        # Definition-level fixture only; it is not a real receipt.
        result = run(passed_document())
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "passed")

    def test_all_inapplicable_is_skipped(self):
        document = base_document()
        document["stages"][0]["applies"] = False
        document["blocked_by"] = []
        document["status"] = "skipped"
        result = run(document)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "skipped")

    def test_nonzero_exit_with_blocked_by_is_still_failed(self):
        document = base_document()
        document["stages"] = [started_stage("command", 3)]
        document["status"] = "failed"
        result = run(document)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "failed")

    def test_mixed_not_started_and_unknown_code_is_unverified(self):
        document = base_document("producer_exporter")
        unknown = started_stage("exporter", None)
        document["stages"] = [idle_stage("producer"), unknown]
        document["blocked_by"] = ["gate"]
        document["status"] = "unverified"
        result = run(document)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "unverified")

    def test_claimed_status_must_equal_derived(self):
        document = base_document()
        document["status"] = "unverified"
        result = run(document)
        self.assertEqual(result["structure"], "invalid")
        self.assertEqual(codes(result), ["V-status"])

    def test_claimed_passed_without_gate_is_rejected(self):
        document = passed_document()
        document["gate"] = None
        result = run(document)
        self.assertEqual(result["structure"], "invalid")
        self.assertIn("V-status", codes(result))
        self.assertIn("V-gate", codes(result))

    def test_declared_source_cannot_reach_passed(self):
        document = passed_document()
        document["observed"][0]["source"] = "declared"
        result = run(document)
        self.assertEqual(result["structure"], "invalid")
        self.assertIn("V-status", codes(result))

    def test_null_measurement_cannot_reach_passed(self):
        document = passed_document()
        document["observed"][0]["measured_at_utc"] = None
        result = run(document)
        self.assertEqual(result["structure"], "invalid")
        self.assertIn("V-status", codes(result))

    def test_empty_log_must_use_empty_hash_for_passed(self):
        document = passed_document()
        document["stages"][0]["stdout"]["sha256"] = GOOD_SHA
        result = run(document)
        self.assertEqual(result["structure"], "invalid")
        self.assertIn("V-status", codes(result))


class ReceiptEncodingTests(unittest.TestCase):
    def test_bom_is_rejected(self):
        raw = b"\xef\xbb\xbf" + encode(base_document())
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-encoding"])

    def test_cr_is_rejected(self):
        raw = encode(base_document()).replace(b"\n", b"\r\n")
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-encoding"])

    def test_missing_trailing_lf_is_rejected(self):
        raw = encode(base_document())[:-1]
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-encoding"])

    def test_double_trailing_lf_is_rejected(self):
        raw = encode(base_document()) + b"\n"
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-encoding"])

    def test_invalid_utf8_is_rejected(self):
        raw = b'{"schema": "\xff\xfe"}\n'
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-encoding"])

    def test_oversize_document_is_rejected(self):
        result = receipt.validate_receipt_bytes(b"x" * 8193)
        self.assertEqual(codes(result), ["V-size"])

    def test_broken_json_is_rejected(self):
        result = receipt.validate_receipt_bytes(b'{"schema": \n')
        self.assertEqual(codes(result), ["V-json"])

    def test_non_finite_constant_is_rejected(self):
        result = receipt.validate_receipt_bytes(b'{"schema": NaN}\n')
        self.assertEqual(codes(result), ["V-json"])

    def test_duplicate_key_is_rejected(self):
        raw = b'{"schema": "b5rc1/1.0-d3", "schema": "b5rc1/1.0-d3"}\n'
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-jsondup"])

    def test_deep_nesting_is_rejected(self):
        raw = ("[" * 12 + "0" + "]" * 12 + "\n").encode("utf-8")
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-jsondepth"])

    def test_non_object_root_is_rejected(self):
        result = receipt.validate_receipt_bytes(b"[]\n")
        self.assertEqual(codes(result), ["V-root"])


class ReceiptSchemaTests(unittest.TestCase):
    def test_unknown_key_is_rejected(self):
        document = base_document()
        document["env"] = {}
        result = run(document)
        self.assertIn("V-unknown", codes(result))

    def test_missing_key_is_rejected(self):
        document = base_document()
        del document["notes"]
        result = run(document)
        self.assertIn("V-missing", codes(result))

    def test_schema_literal_is_enforced(self):
        document = base_document()
        document["schema"] = "b5rc1/1.0-d2"
        result = run(document)
        self.assertIn("V-value", codes(result))

    def test_evidence_verification_is_constant(self):
        document = base_document()
        document["evidence_verification"] = "verified"
        result = run(document)
        self.assertIn("V-value", codes(result))

    def test_code_boolean_is_rejected(self):
        document = base_document()
        document["stages"] = [started_stage("command", True)]
        result = run(document)
        self.assertIn("V-type", codes(result))

    def test_float_is_rejected(self):
        document = base_document()
        document["ticket"] = 1.5
        result = run(document)
        self.assertIn("V-type", codes(result))

    def test_ticket_zero_is_out_of_range(self):
        document = base_document()
        document["ticket"] = 0
        result = run(document)
        self.assertIn("V-range", codes(result))

    def test_task_step_upper_bound(self):
        document = base_document()
        document["task"]["step"] = 65536
        result = run(document)
        self.assertIn("V-range", codes(result))

    def test_blocked_by_rejects_unknown_member(self):
        document = base_document()
        document["blocked_by"] = ["nonsense"]
        result = run(document)
        self.assertIn("V-enum", codes(result))

    def test_blocked_by_rejects_duplicate_member(self):
        document = base_document()
        document["blocked_by"] = ["gate", "gate"]
        result = run(document)
        self.assertIn("V-unique", codes(result))

    def test_string_over_512_bytes_is_rejected(self):
        document = base_document()
        document["task"]["batch"] = "x" * 513
        result = run(document)
        self.assertIn("V-strlen", codes(result))

    def test_log_object_over_512_bytes_is_rejected(self):
        document = base_document()
        document["stages"][0]["stdout"]["retained_ref"] = "r" * 500
        result = run(document)
        self.assertIn("V-budget", codes(result))

    def test_argv_budget(self):
        document = base_document()
        document["stages"][0]["argv"] = ["a"] * 33
        result = run(document)
        self.assertIn("V-budget", codes(result))

    def test_blocked_by_budget(self):
        document = base_document()
        document["blocked_by"] = list(receipt.BLOCKED_BY_VALUES[:9]) + ["gate"]
        result = run(document)
        self.assertIn("V-budget", codes(result))

    def test_expected_budget(self):
        document = base_document()
        document["expected"] = [
            {"path": "p%d" % index, "bytes": 1, "sha256": GOOD_SHA, "blob": GOOD_BLOB}
            for index in range(17)
        ]
        result = run(document)
        self.assertIn("V-budget", codes(result))

    def test_observed_budget(self):
        document = base_document()
        document["observed"] = [
            {
                "path": "p%d" % index,
                "bytes": 1,
                "sha256": GOOD_SHA,
                "source": "declared",
                "measured_at_utc": None,
            }
            for index in range(17)
        ]
        result = run(document)
        self.assertIn("V-budget", codes(result))

    def test_duplicate_path_inside_expected(self):
        document = base_document()
        item = {"path": "same.py", "bytes": 1, "sha256": GOOD_SHA, "blob": GOOD_BLOB}
        document["expected"] = [dict(item), dict(item)]
        result = run(document)
        self.assertIn("V-unique", codes(result))

    def test_malformed_sha256_is_rejected(self):
        document = base_document()
        document["stages"][0]["stdout"]["sha256"] = "abc"
        result = run(document)
        self.assertIn("V-fmt", codes(result))

    def test_malformed_blob_is_rejected(self):
        document = base_document()
        document["expected"] = [
            {"path": "a.py", "bytes": 1, "sha256": GOOD_SHA, "blob": "zz"}
        ]
        result = run(document)
        self.assertIn("V-fmt", codes(result))

    def test_stage_count_must_match_mode(self):
        document = base_document()
        document["stages"] = [idle_stage("command"), idle_stage("command")]
        result = run(document)
        self.assertIn("V-mode", codes(result))

    def test_stage_name_must_match_mode(self):
        document = base_document()
        document["stages"] = [idle_stage("other")]
        result = run(document)
        self.assertIn("V-mode", codes(result))

    def test_pipeline_stage_order_is_enforced(self):
        document = pipeline_document()
        document["stages"] = [started_stage("exporter"), started_stage("producer")]
        result = run(document)
        self.assertIn("V-mode", codes(result))

    def test_duplicate_stage_name_is_rejected(self):
        document = base_document("producer_exporter")
        document["stages"] = [idle_stage("producer"), idle_stage("producer")]
        result = run(document)
        self.assertIn("V-unique", codes(result))


class ReceiptTimeTests(unittest.TestCase):
    def test_offset_timestamp_is_rejected(self):
        document = base_document()
        document["stages"][0]["command"]["started_at_utc"] = "2026-10-19T00:00:00+00:00"
        result = run(document)
        self.assertIn("V-fmt", codes(result))

    def test_impossible_calendar_day_is_rejected(self):
        document = base_document()
        document["stages"][0]["attempt"]["started_at_utc"] = "2026-02-30T00:00:00Z"
        result = run(document)
        self.assertIn("V-fmt", codes(result))

    def test_month_thirteen_is_rejected(self):
        document = base_document()
        document["stages"][0]["attempt"]["started_at_utc"] = "2026-13-01T00:00:00Z"
        result = run(document)
        self.assertIn("V-fmt", codes(result))

    def test_fractional_seconds_are_accepted(self):
        document = base_document()
        document["stages"][0]["attempt"]["started_at_utc"] = "2026-10-19T00:00:00.123456Z"
        result = run(document)
        self.assertEqual(result["structure"], "valid")

    def test_window_end_before_start_is_rejected(self):
        document = base_document()
        document["stages"][0]["command"]["started_at_utc"] = T2
        document["stages"][0]["command"]["ended_at_utc"] = T1
        result = run(document)
        self.assertIn("V-order", codes(result))

    def test_command_cannot_start_before_attempt_end(self):
        document = base_document()
        document["stages"][0]["attempt"]["started_at_utc"] = T0
        document["stages"][0]["attempt"]["ended_at_utc"] = T2
        document["stages"][0]["command"]["started_at_utc"] = T1
        result = run(document)
        self.assertIn("V-order", codes(result))


class ReceiptInvariantTests(unittest.TestCase):
    def test_not_started_rejects_command_time(self):
        document = base_document()
        document["stages"][0]["command"]["started_at_utc"] = T1
        result = run(document)
        self.assertIn("V-invariant", codes(result))

    def test_not_started_rejects_exit_code(self):
        document = base_document()
        document["stages"][0]["exit"]["code"] = 0
        result = run(document)
        self.assertIn("V-invariant", codes(result))

    def test_not_started_rejects_log_content(self):
        document = base_document()
        document["stages"][0]["stdout"]["bytes"] = 0
        result = run(document)
        self.assertIn("V-invariant", codes(result))

    def test_not_started_with_timeout_is_allowed(self):
        document = base_document()
        stage = document["stages"][0]
        stage["attempt"] = {"started_at_utc": T0, "ended_at_utc": T9}
        stage["exit"]["timeout"] = True
        result = run(document)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "blocked")

    def test_started_stage_needs_command_start(self):
        document = base_document()
        stage = document["stages"][0]
        stage["exit"]["not_started"] = False
        result = run(document)
        self.assertIn("V-invariant", codes(result))

    def test_started_stage_may_have_unknown_end(self):
        document = base_document()
        stage = started_stage("command")
        stage["command"]["ended_at_utc"] = None
        document["stages"] = [stage]
        document["status"] = "unverified"
        result = run(document)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "unverified")

    def test_inapplicable_stage_rejects_argv(self):
        document = base_document()
        document["stages"][0]["applies"] = False
        document["stages"][0]["argv"] = ["--emit"]
        document["blocked_by"] = []
        result = run(document)
        self.assertIn("V-invariant", codes(result))

    def test_inapplicable_stage_rejects_not_started_false(self):
        document = base_document()
        stage = document["stages"][0]
        stage["applies"] = False
        stage["exit"]["not_started"] = False
        stage["command"]["started_at_utc"] = T1
        document["blocked_by"] = []
        result = run(document)
        self.assertIn("V-invariant", codes(result))


class ReceiptExhaustionTests(unittest.TestCase):
    def test_missing_gate_does_not_mask_sibling_violations(self):
        document = base_document()
        document["status"] = "passed"
        document["blocked_by"] = []
        document["stages"][0]["name"] = "wrong"
        document["stages"][0]["exit"]["timeout"] = "no"
        document["stages"][0]["stderr"]["sha256"] = "zz"
        result = run(document)
        found = codes(result)
        self.assertIn("V-type", found)
        self.assertIn("V-fmt", found)
        self.assertIn("V-mode", found)

    def test_each_violation_has_code_and_pointer_only(self):
        document = base_document()
        document["task"]["step"] = "x"
        document["blocked_by"] = ["nope"]
        result = run(document)
        self.assertGreaterEqual(len(result["violations"]), 2)
        for item in result["violations"]:
            self.assertEqual(sorted(item.keys()), ["code", "pointer"])
            self.assertTrue(item["pointer"].startswith("/"))

    def test_violations_are_deduplicated_and_ordered(self):
        document = base_document()
        document["extra_one"] = 1
        document["extra_two"] = 2
        result = run(document)
        pairs = [(item["code"], item["pointer"]) for item in result["violations"]]
        self.assertEqual(pairs, sorted(pairs))
        self.assertEqual(len(pairs), len(set(pairs)))


class ReceiptR2RegressionTests(unittest.TestCase):
    """Root Codex repair definitions only: no claimed executions or receipts."""

    def assert_invalid_unverified(self, result):
        self.assertEqual(result["structure"], "invalid")
        self.assertIsNone(result["derived_status"])
        self.assertEqual(result["evidence_verification"], "unverified")

    def assert_violation(self, result, code, pointer):
        self.assertIn({"code": code, "pointer": pointer}, result["violations"])

    def test_started_empty_argv_has_otherwise_complete_s4_evidence(self):
        document = passed_document()
        self.assertEqual(run(document)["derived_status"], "passed")
        self.assertEqual(document["stages"][0]["argv"], ["--emit"])
        document["stages"][0]["argv"] = []
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assertEqual(result["violations"], [
            {"code": "V-invariant", "pointer": "/stages/0/argv"}
        ])

    def test_hex_fields_reject_only_added_field_lf(self):
        paths = [
            ("stages", 0, "stdout", "sha256"),
            ("stages", 0, "stderr", "sha256"),
            ("expected", 0, "sha256"),
            ("expected", 0, "blob"),
            ("observed", 0, "sha256"),
        ]
        for path in paths:
            with self.subTest(path=path):
                document = passed_document()
                self.assertEqual(run(document)["derived_status"], "passed")
                parent = document
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] += "\n"
                result = run(document)
                self.assert_invalid_unverified(result)
                self.assert_violation(result, "V-fmt", "/" + "/".join(map(str, path)))

    def test_every_time_entry_rejects_added_lf(self):
        paths = [
            ("stages", 0, "attempt", "started_at_utc"),
            ("stages", 0, "attempt", "ended_at_utc"),
            ("stages", 0, "command", "started_at_utc"),
            ("stages", 0, "command", "ended_at_utc"),
            ("observed", 0, "measured_at_utc"),
        ]
        for path in paths:
            with self.subTest(path=path):
                document = passed_document()
                self.assertEqual(run(document)["derived_status"], "passed")
                parent = document
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] += "\n"
                result = run(document)
                self.assert_invalid_unverified(result)
                self.assert_violation(result, "V-fmt", "/" + "/".join(map(str, path)))

    def test_timestamp_digits_are_ascii_and_fraction_is_one_to_six(self):
        for fraction in ("1", "12", "123", "1234", "12345", "123456"):
            with self.subTest(fraction=fraction):
                document = base_document()
                document["stages"][0]["attempt"]["started_at_utc"] = (
                    "2026-10-19T00:00:00." + fraction + "Z"
                )
                self.assertEqual(run(document)["structure"], "valid")
        for value in ("٢٠٢٦-10-19T00:00:00Z", "2026-10-19T00:00:00.Z",
                      "2026-10-19T00:00:00.1234567Z"):
            with self.subTest(value=value):
                document = base_document()
                document["stages"][0]["attempt"]["started_at_utc"] = value
                result = run(document)
                self.assert_invalid_unverified(result)
                self.assert_violation(result, "V-fmt", "/stages/0/attempt/started_at_utc")

    def test_stage_missing_name_does_not_hide_exit_or_stderr(self):
        document = base_document()
        del document["stages"][0]["name"]
        document["stages"][0]["exit"]["code"] = True
        document["stages"][0]["stderr"]["sha256"] = "zz"
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-missing", "/stages/0/name")
        self.assert_violation(result, "V-type", "/stages/0/exit/code")
        self.assert_violation(result, "V-fmt", "/stages/0/stderr/sha256")

    def test_log_missing_key_keeps_safe_siblings(self):
        for side in ("stdout", "stderr"):
            with self.subTest(side=side):
                document = base_document()
                log = document["stages"][0][side]
                del log["bytes"]
                log["sha256"] = "zz"
                log["retained_ref"] = False
                result = run(document)
                self.assert_invalid_unverified(result)
                prefix = "/stages/0/" + side
                self.assert_violation(result, "V-missing", prefix + "/bytes")
                self.assert_violation(result, "V-fmt", prefix + "/sha256")
                self.assert_violation(result, "V-type", prefix + "/retained_ref")

    def test_window_missing_key_keeps_safe_sibling_and_stage(self):
        for window in ("attempt", "command"):
            with self.subTest(window=window):
                document = base_document()
                del document["stages"][0][window]["started_at_utc"]
                document["stages"][0][window]["ended_at_utc"] = "not a time"
                document["stages"][0]["exit"]["code"] = True
                result = run(document)
                self.assert_invalid_unverified(result)
                prefix = "/stages/0/" + window
                self.assert_violation(result, "V-missing", prefix + "/started_at_utc")
                self.assert_violation(result, "V-fmt", prefix + "/ended_at_utc")
                self.assert_violation(result, "V-type", "/stages/0/exit/code")

    def test_order_uses_available_endpoints_when_unrelated_key_missing(self):
        document = passed_document()
        self.assertEqual(run(document)["derived_status"], "passed")
        stage = document["stages"][0]
        del stage["attempt"]["started_at_utc"]
        stage["attempt"]["ended_at_utc"] = T2
        stage["command"]["started_at_utc"] = T1
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-missing", "/stages/0/attempt/started_at_utc")
        self.assert_violation(result, "V-order", "/stages/0/command")

    def test_client_and_task_missing_keys_do_not_hide_siblings(self):
        document = base_document()
        document["client"] = {"model": False}
        del document["task"]["batch"]
        document["task"]["step"] = True
        document["task"]["cwd"] = False
        result = run(document)
        self.assert_invalid_unverified(result)
        for code, pointer in (("V-missing", "/client/name"), ("V-type", "/client/model"),
                              ("V-missing", "/task/batch"), ("V-type", "/task/step"),
                              ("V-type", "/task/cwd")):
            self.assert_violation(result, code, pointer)

    def test_expected_missing_key_keeps_all_safe_fields(self):
        document = base_document()
        document["expected"] = [{"bytes": True, "sha256": "zz", "blob": "zz"}]
        result = run(document)
        self.assert_invalid_unverified(result)
        for code, field in (("V-missing", "path"), ("V-type", "bytes"),
                            ("V-fmt", "sha256"), ("V-fmt", "blob")):
            self.assert_violation(result, code, "/expected/0/" + field)

    def test_observed_missing_key_keeps_all_safe_fields(self):
        document = base_document()
        document["observed"] = [{"bytes": True, "sha256": "zz", "source": "bad",
                                 "measured_at_utc": "not a time"}]
        result = run(document)
        self.assert_invalid_unverified(result)
        for code, field in (("V-missing", "path"), ("V-type", "bytes"),
                            ("V-fmt", "sha256"), ("V-enum", "source"),
                            ("V-fmt", "measured_at_utc")):
            self.assert_violation(result, code, "/observed/0/" + field)

    def test_interpreter_and_exit_missing_keys_keep_safe_siblings(self):
        document = base_document()
        stage = document["stages"][0]
        stage["interpreter"] = {"version": False}
        stage["exit"] = {"code": True, "signal": False, "timeout": "no"}
        result = run(document)
        self.assert_invalid_unverified(result)
        for code, pointer in (("V-missing", "/stages/0/interpreter/path"),
                              ("V-type", "/stages/0/interpreter/version"),
                              ("V-missing", "/stages/0/exit/not_started"),
                              ("V-type", "/stages/0/exit/code"),
                              ("V-type", "/stages/0/exit/signal"),
                              ("V-type", "/stages/0/exit/timeout")):
            self.assert_violation(result, code, pointer)

    def test_non_object_child_does_not_hide_other_child(self):
        document = base_document()
        document["stages"][0]["stdout"] = []
        document["stages"][0]["stderr"]["sha256"] = "zz"
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-type", "/stages/0/stdout")
        self.assert_violation(result, "V-fmt", "/stages/0/stderr/sha256")

    def test_valid_json_at_depth_eight_reaches_root_gate(self):
        # Seven arrays + scalar = depth8 (root at1); schema root is separately invalid.
        raw = b"[" * 7 + b"0" + b"]" * 7 + b"\n"
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(codes(result), ["V-root"])
        self.assertNotIn("V-jsondepth", codes(result))

    def test_raw_8192_valid_and_8193_same_json(self):
        encoded = encode(base_document())
        self.assertLess(len(encoded), 8192)
        raw = b" " * (8192 - len(encoded)) + encoded
        self.assertEqual(len(raw), 8192)
        result = receipt.validate_receipt_bytes(raw)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "blocked")
        over = b" " + raw
        self.assertEqual(len(over), 8193)
        result = receipt.validate_receipt_bytes(over)
        self.assert_invalid_unverified(result)
        self.assertEqual(codes(result), ["V-size"])

    def test_utf8_string_512_and_513_bytes(self):
        document = base_document()
        document["notes"] = "é" * 256
        self.assertEqual(len(document["notes"].encode("utf-8")), 512)
        self.assertEqual(run(document)["structure"], "valid")
        document["notes"] += "x"
        self.assertEqual(len(document["notes"].encode("utf-8")), 513)
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-strlen", "/notes")

    def test_each_compact_log_512_and_513_bytes(self):
        for side in ("stdout", "stderr"):
            with self.subTest(side=side):
                document = passed_document()
                log = document["stages"][0][side]
                # Independent fixed JSON overhead105; SHA64 and bytes0 are unchanged.
                log["retained_ref"] = "r" * 407
                compact = json.dumps(log, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.assertEqual(len(compact), 512)
                self.assertEqual(run(document)["derived_status"], "passed")
                log["retained_ref"] += "r"
                compact = json.dumps(log, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.assertEqual(len(compact), 513)
                result = run(document)
                self.assert_invalid_unverified(result)
                self.assert_violation(result, "V-budget", "/stages/0/" + side)
                self.assertNotIn("V-strlen", codes(result))

    def test_argv_32_and_33_with_complete_s4_baseline(self):
        document = passed_document()
        document["stages"][0]["argv"] = ["a"] * 32
        self.assertEqual(run(document)["derived_status"], "passed")
        document["stages"][0]["argv"].append("a")
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-budget", "/stages/0/argv")

    def test_blocked_by_nine_distinct_and_ten_real_list(self):
        document = base_document()
        document["blocked_by"] = ["gate", "serialslot", "resources", "manifest", "interpreter",
                                   "cwd", "permissions", "environment", "evidence"]
        self.assertEqual(len(document["blocked_by"]), 9)
        self.assertEqual(run(document)["structure"], "valid")
        document["blocked_by"].append("gate")
        self.assertIsInstance(document["blocked_by"], list)
        self.assertEqual(len(document["blocked_by"]), 10)
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-budget", "/blocked_by")
        self.assert_violation(result, "V-unique", "/blocked_by/9")

    def test_expected_16_and_17_isolated_from_observed_budget(self):
        document = base_document()
        document["expected"] = [
            {"path": "p%d" % i, "bytes": 1, "sha256": GOOD_SHA, "blob": None}
            for i in range(16)
        ]
        self.assertLessEqual(len(encode(document)), 8192)
        self.assertEqual(run(document)["structure"], "valid")
        document["expected"].append({"path": "p16", "bytes": 1, "sha256": GOOD_SHA, "blob": None})
        self.assertLessEqual(len(encode(document)), 8192)
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-budget", "/expected")
        self.assertNotIn("V-unique", codes(result))

    def test_observed_16_and_17_isolated_from_expected_budget(self):
        document = base_document()
        document["observed"] = [
            {"path": "p%d" % i, "bytes": None, "sha256": None, "source": "unknown",
             "measured_at_utc": None} for i in range(16)
        ]
        self.assertLessEqual(len(encode(document)), 8192)
        self.assertEqual(run(document)["structure"], "valid")
        document["observed"].append({"path": "p16", "bytes": None, "sha256": None,
                                      "source": "unknown", "measured_at_utc": None})
        self.assertLessEqual(len(encode(document)), 8192)
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-budget", "/observed")
        self.assertNotIn("V-unique", codes(result))

    def test_time_precisions_compare_equal_not_lexical(self):
        document = passed_document()
        stage = document["stages"][0]
        stage["attempt"] = {"started_at_utc": "2026-10-19T00:00:01.1Z",
                            "ended_at_utc": "2026-10-19T00:00:01.100000Z"}
        stage["command"] = {"started_at_utc": "2026-10-19T00:00:01.100Z",
                            "ended_at_utc": "2026-10-19T00:00:01.10Z"}
        result = run(document)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "passed")
        self.assertNotIn("V-order", codes(result))

    def test_s4_each_missing_evidence_field_is_not_passed(self):
        paths = [
            ("ticket",), ("gate",), ("blocked_by",), ("expected",), ("observed",),
            ("stages",), ("stages", 0, "exit"), ("stages", 0, "command"),
            ("stages", 0, "interpreter"), ("stages", 0, "stdout"), ("stages", 0, "stderr"),
            ("stages", 0, "applies"), ("stages", 0, "argv"),
            ("stages", 0, "exit", "not_started"), ("stages", 0, "exit", "timeout"),
            ("stages", 0, "exit", "code"), ("stages", 0, "exit", "signal"),
            ("stages", 0, "command", "started_at_utc"),
            ("stages", 0, "command", "ended_at_utc"),
            ("stages", 0, "interpreter", "path"), ("stages", 0, "interpreter", "version"),
            ("expected", 0, "path"), ("expected", 0, "bytes"), ("expected", 0, "sha256"),
            ("expected", 0, "blob"),
            ("observed", 0, "path"), ("observed", 0, "bytes"), ("observed", 0, "sha256"),
            ("observed", 0, "source"), ("observed", 0, "measured_at_utc"),
        ]
        for side in ("stdout", "stderr"):
            for field in ("bytes", "sha256", "retained_ref"):
                paths.append(("stages", 0, side, field))
        for path in paths:
            with self.subTest(path=path):
                document = passed_document()
                self.assertEqual(run(document)["derived_status"], "passed")
                parent = document
                for key in path[:-1]:
                    parent = parent[key]
                del parent[path[-1]]
                result = run(document)
                self.assert_invalid_unverified(result)
                self.assert_violation(result, "V-missing", "/" + "/".join(map(str, path)))

    def test_s4_each_well_typed_evidence_tamper_is_discriminated(self):
        cases = [
            (("ticket",), None), (("gate",), None), (("blocked_by",), ["gate"]),
            (("expected",), []), (("observed",), []),
            (("stages", 0, "exit", "timeout"), True),
            (("stages", 0, "exit", "code"), None),
            (("stages", 0, "exit", "code"), 1),
            (("stages", 0, "exit", "signal"), "SIGTERM"),
            (("stages", 0, "command", "ended_at_utc"), None),
            (("stages", 0, "interpreter", "path"), None),
            (("stages", 0, "interpreter", "version"), None),
            (("expected", 0, "path"), "other.py"),
            (("expected", 0, "bytes"), 11), (("expected", 0, "sha256"), OTHER_SHA),
            (("observed", 0, "path"), "other.py"),
            (("observed", 0, "bytes"), None), (("observed", 0, "sha256"), None),
            (("observed", 0, "source"), "declared"),
            (("observed", 0, "source"), "unknown"),
            (("observed", 0, "measured_at_utc"), None),
        ]
        for side in ("stdout", "stderr"):
            for field in ("bytes", "sha256", "retained_ref"):
                cases.append((("stages", 0, side, field), None))
            cases.append((("stages", 0, side, "sha256"), GOOD_SHA))
        for path, value in cases:
            with self.subTest(path=path, value=value):
                document = passed_document()
                self.assertEqual(run(document)["derived_status"], "passed")
                parent = document
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] = value
                result = run(document)
                self.assert_invalid_unverified(result)
                expected_codes = ["V-status"]
                if path in (("ticket",), ("gate",)):
                    expected_codes.append("V-gate")
                self.assertEqual(codes(result), sorted(expected_codes))

    def test_s4_impossible_flag_and_missing_start_tamper_rejects(self):
        cases = [
            (("stages", 0, "applies"), False, "/stages/0/argv"),
            (("stages", 0, "exit", "not_started"), True, "/stages/0/exit/code"),
            (("stages", 0, "command", "started_at_utc"), None,
             "/stages/0/command/started_at_utc"),
        ]
        for path, value, pointer in cases:
            with self.subTest(path=path):
                document = passed_document()
                self.assertEqual(run(document)["derived_status"], "passed")
                parent = document
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] = value
                result = run(document)
                self.assert_invalid_unverified(result)
                self.assert_violation(result, "V-invariant", pointer)

    def test_s4_nullable_attempt_and_blob_do_not_add_new_requirements(self):
        document = passed_document()
        document["stages"][0]["attempt"] = empty_window()
        document["expected"][0]["blob"] = None
        result = run(document)
        self.assertEqual(result["structure"], "valid")
        self.assertEqual(result["derived_status"], "passed")
        self.assertEqual(result["evidence_verification"], "unverified")

    def test_missing_stage_name_keeps_other_stage_name_check(self):
        document = base_document("producer_exporter")
        document["stages"] = [idle_stage("producer"), idle_stage("wrong")]
        del document["stages"][0]["name"]
        result = run(document)
        self.assert_invalid_unverified(result)
        self.assert_violation(result, "V-missing", "/stages/0/name")
        self.assert_violation(result, "V-mode", "/stages")
