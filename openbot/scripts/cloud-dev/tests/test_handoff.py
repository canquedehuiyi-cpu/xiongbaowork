"""Tests for the B4 handoff exporter (read-only data export tool).

Positive fixtures are built with the real reporting.build_report; the real
handoff.main is exercised end to end through a mocked sys.stdin (bytes) and
captured sys.stdout/sys.stderr. reporting, its policy and the export core
are never mocked. run_main passes an explicit argv ([]) to handoff.main so
host sys.argv (e.g. unittest discover options) cannot leak into argparse;
the real main(None) path reads real sys.argv and is covered separately.
The sole subprocess is test_isolated_cli_does_not_write_bytecode: it copies
the real handoff.py/reporting.py into a temp fixture and spawns
sys.executable handoff.py --help (no -B, no PYTHONDONTWRITEBYTECODE or
PYTHONPYCACHEPREFIX in the child env, fixed short timeout, no network) to
witness that the script CLI alone writes no bytecode. Nothing else is
executed and no other file is touched.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _parent not in sys.path:
    sys.path.insert(0, _parent)

import handoff
import reporting


def legal_report():
    checks = [
        reporting.make_check("c1", "tree-hash", "evidence", "passed", True,
                             expected="sha256:aa11", observed="sha256:aa11",
                             details=None),
        reporting.make_check("c2", "diag-new-errors", "diagnostic",
                             "failed", True,
                             expected={"new": 0, "resolved": 0},
                             observed={"new": 0, "still_present": 7},
                             details="tsc stdout L12: error TS2339 ..."),
    ]
    return reporting.build_report("diag-compare", checks,
                                  notes=["new=0; old failures kept failed"])


def legal_payload():
    return json.dumps(legal_report(), ensure_ascii=True).encode("utf-8")


def payload_with(mutate):
    report = legal_report()
    mutate(report)
    return json.dumps(report, ensure_ascii=True).encode("utf-8")


def deep_value(levels):
    value = []
    for _ in range(levels):
        value = [value]
    return value


def run_main(payload, argv=None, stdin_reader=None, stdout=None):
    out = stdout if stdout is not None else io.StringIO()
    err = io.StringIO()
    buffer = stdin_reader if stdin_reader is not None \
        else io.BytesIO(payload)
    fake_stdin = types.SimpleNamespace(buffer=buffer)
    with mock.patch.object(sys, "stdin", fake_stdin), \
            mock.patch.object(sys, "stdout", out), \
            mock.patch.object(sys, "stderr", err):
        try:
            # Explicit default argv: parse_args(None) would read host
            # sys.argv (unittest discover -v/-s/...) and poison both
            # directions. Callers passing an explicit argv keep it.
            rc = handoff.main([] if argv is None else argv)
        except SystemExit as exit_error:  # argparse --help path
            rc = exit_error.code
    if hasattr(out, "getvalue"):
        out_text = out.getvalue()
    else:
        out_text = "".join(getattr(out, "chunks", []))
    return rc, out_text, err.getvalue()


class HandoffExportTests(unittest.TestCase):

    def test_export_success_full_fields_roundtrip(self):
        report = legal_report()
        rc, out, err = run_main(legal_payload())
        self.assertEqual((rc, err), (0, ""))
        lines = out.splitlines()
        self.assertIn("== regression handoff (read-only data export) ==",
                      lines)
        self.assertIn("exit_code: 1", lines)
        self.assertIn("summary: passed=1 failed=1 blocked=0 skipped=0 "
                      "unverified=0 total=2", lines)
        self.assertIn("-- FAILED (1) --", lines)
        self.assertIn("-- PASSED (1) --", lines)
        self.assertIn(handoff.FOOTER, lines)
        for check in report["checks"]:
            for field in ("check_id", "name", "category", "status",
                          "required", "expected", "observed", "details"):
                literal = json.dumps(check[field], ensure_ascii=True,
                                     sort_keys=True)
                line = "  %s: %s" % (field, literal)
                self.assertIn(line, lines)
                self.assertEqual(json.loads(literal), check[field])

    def test_run_main_immune_to_host_sys_argv(self):
        # With parse_args(None) this host argv would reach argparse and the
        # legal payload would be refused 3 ("argument error"). The helper's
        # explicit [] must keep the positive path green.
        fake_argv = [sys.argv[0], "discover", "-s", "tests", "-v"]
        with mock.patch.object(sys, "argv", fake_argv):
            rc, out, err = run_main(legal_payload())
        self.assertEqual((rc, err), (0, ""))
        self.assertIn("== regression handoff (read-only data export) ==", out)

    def test_failed_outranks_required_blocked_shows_both_groups(self):
        report = reporting.build_report("diag-compare", [
            reporting.make_check(
                "c1", "tree-hash", "evidence", "passed", True,
                expected="sha256:aa11", observed="sha256:aa11"),
            reporting.make_check(
                "c2", "diag-new-errors", "diagnostic", "failed", True,
                expected={"new": 0, "resolved": 0},
                observed={"new": 0, "still_present": 7},
                details="tsc stdout L12: error TS2339 ..."),
            reporting.make_check(
                "c3", "runtime-probe", "environment", "blocked", True,
                details="bun not found"),
        ])
        payload = json.dumps(report, ensure_ascii=True).encode("utf-8")
        rc, out, err = run_main(payload)
        self.assertEqual((rc, err), (0, ""))
        self.assertIn('overall_status: "fail"', out)
        self.assertIn("exit_code: 1", out)
        self.assertIn("-- FAILED (1) --", out)
        self.assertIn("-- BLOCKED (1) --", out)
        self.assertIn("-- PASSED (1) --", out)

    def test_optional_skipped_does_not_block_and_zero_groups_shown(self):
        report = reporting.build_report("diag-compare", [
            reporting.make_check("c1", "tree-hash", "evidence", "passed",
                                 True, expected="x", observed="x"),
            reporting.make_check("c2", "optional-probe", "environment",
                                 "skipped", False),
        ])
        payload = json.dumps(report, ensure_ascii=True).encode("utf-8")
        rc, out, err = run_main(payload)
        self.assertEqual((rc, err), (0, ""))
        self.assertIn('overall_status: "pass"', out)
        self.assertIn("exit_code: 0", out)
        self.assertIn("-- SKIPPED (1) --", out)
        self.assertIn("-- BLOCKED (0) --", out)
        self.assertIn("-- UNVERIFIED (0) --", out)

    def test_old_failed_with_new_zero_stay_failed(self):
        rc, out, err = run_main(legal_payload())
        self.assertEqual((rc, err), (0, ""))
        self.assertIn('overall_status: "fail"', out)
        self.assertIn('"still_present": 7', out)
        self.assertIn("-- FAILED (1) --", out)

    def test_unmeasured_identity_observed_stays_null(self):
        rc, out, err = run_main(legal_payload())
        self.assertEqual((rc, err), (0, ""))
        self.assertIn("baseline_identity.observed: null", out)
        self.assertIn("baseline_identity.expected: null", out)
        self.assertIn("candidate_identity.observed: null", out)
        self.assertIn('"not provided by this tool"', out)

    def test_malicious_strings_reversible_json_literals(self):
        nasty = ["<script>alert(1)</script>", "'; rm -rf /",
                 "ESC:" + chr(27) + "[31m red", "line1" + chr(10) + "line2",
                 "\u4e2d\u6587\U0001f680"]
        report = reporting.build_report("diag-compare", [
            reporting.make_check("c9", "nasty", "data", "failed", True,
                                 details=nasty)])
        payload = json.dumps(report, ensure_ascii=True).encode("utf-8")
        rc, out, err = run_main(payload)
        self.assertEqual((rc, err), (0, ""))
        lines = out.splitlines()
        expected_line = "  details: " + json.dumps(
            nasty, ensure_ascii=True, sort_keys=True)
        self.assertIn(expected_line, lines)
        self.assertEqual(json.loads(expected_line[len("  details: "):]),
                          nasty)
        self.assertIn("\\u001b", out)
        self.assertIn("\\u4e2d\\u6587", out)
        self.assertNotIn(chr(27), out)

    def test_identity_and_notes_full_roundtrip(self):
        report = legal_report()
        rc, out, err = run_main(legal_payload())
        self.assertEqual((rc, err), (0, ""))
        lines = out.splitlines()
        self.assertIn(
            "identity: "
            + json.dumps(report["identity"], ensure_ascii=True,
                         sort_keys=True), lines)
        for label in ("baseline_identity", "candidate_identity"):
            for field in ("status", "expected", "observed", "details"):
                self.assertIn(
                    "%s.%s: %s" % (label, field, json.dumps(
                        report[label][field], ensure_ascii=True,
                        sort_keys=True)), lines)
        for note in report["notes"]:
            self.assertIn("  " + json.dumps(note, ensure_ascii=True,
                                            sort_keys=True), lines)

    def test_help_flag_exits_zero(self):
        rc, out, err = run_main(b"", ["--help"])
        self.assertEqual(rc, 0)
        self.assertIn("usage:", out)


class HandoffRejectTests(unittest.TestCase):

    def assert_refused(self, payload, argv=None):
        rc, out, err = run_main(payload, argv)
        self.assertEqual(rc, 3)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("handoff: "))
        self.assertEqual(err.count("\n"), 1)
        return err

    def test_unknown_flag_refused(self):
        self.assert_refused(legal_payload(), ["--x"])

    def test_positional_argument_refused(self):
        self.assert_refused(legal_payload(), ["report.json"])

    def test_markdown_format_refused(self):
        self.assert_refused(legal_payload(), ["--format=markdown"])

    def test_stdin_over_256kib_refused(self):
        self.assert_refused(b'{"tool": "' + b"a" * (300 * 1024) + b'"}')

    def test_invalid_utf8_refused(self):
        self.assert_refused(legal_payload().replace(b"diag-compare",
                                                    b"diag\xffcompare"))

    def test_invalid_json_refused(self):
        self.assert_refused(b"{not json}")

    def test_nan_constant_refused(self):
        self.assert_refused(b'{"tool": NaN}')

    def test_duplicate_top_level_key_refused(self):
        self.assert_refused(
            b'{"schema_version": "1.1", "schema_version": "1.1"}')

    def test_duplicate_nested_key_refused(self):
        text = legal_payload().decode("utf-8")
        self.assertIn('"identity": {}', text)
        self.assert_refused(text.replace(
            '"identity": {}', '"identity": {"a": 1, "a": 2}').encode("utf-8"))

    def test_lone_surrogate_refused(self):
        self.assert_refused(rb'{"tool": "\ud800"}')

    def test_wrong_schema_version_refused(self):
        self.assert_refused(payload_with(
            lambda r: r.update(schema_version="1.0")))

    def test_unknown_top_level_field_refused(self):
        self.assert_refused(payload_with(lambda r: r.update(extra=1)))

    def test_missing_top_level_field_refused(self):
        self.assert_refused(payload_with(lambda r: r.pop("notes")))

    def test_tool_type_error_refused(self):
        self.assert_refused(payload_with(lambda r: r.update(tool=123)))

    def test_summary_bool_count_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["summary"].update(passed=True)))

    def test_summary_count_mismatch_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["summary"].update(passed=2)))

    def test_overall_status_mismatch_refused(self):
        self.assert_refused(payload_with(
            lambda r: r.update(overall_status="pass")))

    def test_exit_code_mismatch_refused(self):
        self.assert_refused(payload_with(lambda r: r.update(exit_code=0)))

    def test_exit_code_bool_refused(self):
        self.assert_refused(payload_with(lambda r: r.update(exit_code=True)))

    def test_status_shorthand_pass_fail_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["checks"][1].update(status="fail")))

    def test_required_not_strict_bool_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["checks"][0].update(required=1)))

    def test_empty_name_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["checks"][0].update(name="")))

    def test_duplicate_check_id_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["checks"].append(dict(r["checks"][0]))))

    def test_identity_block_unknown_field_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["baseline_identity"].update(extra=1)))

    def test_identity_block_missing_field_refused(self):
        self.assert_refused(payload_with(
            lambda r: r["candidate_identity"].pop("status")))

    def test_depth_cap_refused(self):
        self.assert_refused(payload_with(
            lambda r: r.update(identity={"deep": deep_value(12)})))

    def test_node_cap_refused(self):
        self.assert_refused(payload_with(
            lambda r: r.update(identity={"big": ["x"] * 20001})))

    def test_string_cap_refused(self):
        self.assert_refused(payload_with(
            lambda r: r.update(identity={"big": "a" * 65537})))

    def test_non_finite_1e999_in_details_refused(self):
        base = legal_payload().decode("utf-8")
        self.assertIn('"tsc stdout L12: error TS2339 ..."', base)
        bad = base.replace('"tsc stdout L12: error TS2339 ..."', "1e999")
        self.assert_refused(bad.encode("utf-8"))

    def test_non_finite_minus_1e999_in_nested_observed_refused(self):
        base = legal_payload().decode("utf-8")
        self.assertIn('"still_present": 7', base)
        bad = base.replace('"still_present": 7', '"still_present": -1e999')
        self.assert_refused(bad.encode("utf-8"))

    def test_non_finite_1e999_in_nested_expected_refused(self):
        base = legal_payload().decode("utf-8")
        self.assertIn('"new": 0, "resolved": 0', base)
        bad = base.replace('"new": 0, "resolved": 0',
                           '"new": 1e999, "resolved": 0')
        self.assert_refused(bad.encode("utf-8"))

    def test_unknown_flag_with_newline_single_line_stderr(self):
        err = self.assert_refused(legal_payload(), ["--x" + chr(10) + "y"])
        self.assertNotIn(chr(27), err)

    def test_unknown_flag_with_esc_single_line_stderr(self):
        err = self.assert_refused(legal_payload(), ["--x" + chr(27) + "y"])
        self.assertNotIn(chr(27), err)
        self.assertIn("\\u001b", err)

    def test_positional_with_control_chars_single_line_stderr(self):
        err = self.assert_refused(
            legal_payload(), ["re" + chr(10) + "port" + chr(27) + ".json"])
        self.assertNotIn(chr(27), err)


class ShortReader(object):
    """Reader returning at most `size` bytes per read call, then true EOF."""

    def __init__(self, data, size):
        self._buf = io.BytesIO(data)
        self._size = size

    def read(self, limit):
        return self._buf.read(min(limit, self._size))


class OneShotThenBrokenReader(object):
    """Returns the first chunk, then raises OSError on the next read."""

    def __init__(self, data, size):
        self._buf = io.BytesIO(data)
        self._size = size
        self._served = False

    def read(self, limit):
        if not self._served:
            self._served = True
            return self._buf.read(min(limit, self._size))
        raise OSError("simulated stdin I/O failure")


class BrokenStdout(object):
    """Stdout sink whose write always fails with OSError."""

    def write(self, text):
        raise OSError("simulated stdout write failure")


class ShortStdout(object):
    """Stdout sink that reports half of the characters as written."""

    def __init__(self):
        self.chunks = []

    def write(self, text):
        self.chunks.append(text)
        return len(text) // 2


class HandoffIoTests(unittest.TestCase):

    def test_short_read_reader_reads_true_eof_success(self):
        rc, out, err = run_main(
            None, stdin_reader=ShortReader(legal_payload(), 7))
        self.assertEqual((rc, err), (0, ""))
        self.assertIn(handoff.FOOTER, out)

    def test_first_chunk_valid_json_then_tail_refused(self):
        rc, out, err = run_main(
            None, stdin_reader=ShortReader(legal_payload() + b" tail", 64))
        self.assertEqual(rc, 3)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("handoff: "))

    def test_second_chunk_io_error_refused(self):
        rc, out, err = run_main(
            None, stdin_reader=OneShotThenBrokenReader(
                legal_payload(), 32))
        self.assertEqual(rc, 3)
        self.assertEqual(out, "")

    def test_stdout_write_failure_not_success(self):
        rc, out, err = run_main(legal_payload(), stdout=BrokenStdout())
        self.assertEqual(rc, 3)
        self.assertEqual(err, "handoff: stdout write failed\n")

    def test_stdout_short_write_not_success(self):
        rc, out, err = run_main(legal_payload(), stdout=ShortStdout())
        self.assertEqual(rc, 3)
        self.assertEqual(err, "handoff: stdout short write\n")

    def test_output_cap_refused_with_shrunk_constant(self):
        with mock.patch.object(handoff, "MAX_OUTPUT_BYTES", 64):
            rc, out, err = run_main(legal_payload())
        self.assertEqual(rc, 3)
        self.assertEqual(out, "")
        self.assertIn("output exceeds", err)

    def test_real_main_none_reads_host_cli_argv(self):
        # The real main(None) must keep reading real sys.argv; the helper's
        # explicit [] must not let tests silently ignore real CLI options.
        # Real stdin/stdout/stderr capture; parser and policy not mocked.
        fake_stdin = types.SimpleNamespace(buffer=io.BytesIO(legal_payload()))
        with mock.patch.object(sys, "argv",
                               ["handoff.py", "--format=markdown"]), \
                mock.patch.object(sys, "stdin", fake_stdin), \
                mock.patch.object(sys, "stdout", io.StringIO()), \
                mock.patch.object(sys, "stderr", io.StringIO()) as err:
            rc = handoff.main(None)
        self.assertEqual(rc, 3)
        self.assertIn("unsupported format", err.getvalue())

    def test_isolated_cli_does_not_write_bytecode(self):
        # Real isolated CLI witness replacing the previous weak
        # sys.dont_write_bytecode assertion (which could inherit a global
        # switch from the test host). Copies the REAL handoff.py and
        # reporting.py into a temp fixture and runs the script CLI
        # directly: no -B flag, no PYTHONDONTWRITEBYTECODE and no
        # PYTHONPYCACHEPREFIX in the child env (removed, never set to
        # "0"), asserts exit 0 with the real help text and that the
        # fixture contains no __pycache__ and no .pyc afterwards. Fixed
        # short timeout; no network and no vendor calls.
        src_dir = os.path.dirname(os.path.abspath(handoff.__file__))
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copyfile(os.path.join(src_dir, "handoff.py"),
                            os.path.join(tmp, "handoff.py"))
            shutil.copyfile(os.path.join(src_dir, "reporting.py"),
                            os.path.join(tmp, "reporting.py"))
            env = dict(os.environ)
            env.pop("PYTHONDONTWRITEBYTECODE", None)
            env.pop("PYTHONPYCACHEPREFIX", None)
            proc = subprocess.run(
                [sys.executable, os.path.join(tmp, "handoff.py"), "--help"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                timeout=30)
            self.assertEqual(proc.returncode, 0)
            self.assertIn(b"usage:", proc.stdout)
            leftovers = []
            for root, dirs, files in os.walk(tmp):
                for name in list(dirs) + list(files):
                    if name == "__pycache__" or name.endswith(".pyc"):
                        leftovers.append(os.path.join(root, name))
            self.assertEqual(leftovers, [])


class HandoffUnitTests(unittest.TestCase):

    def test_checks_over_4096_refused(self):
        report = legal_report()
        report["checks"] = [report["checks"][0]] * 4097
        with self.assertRaises(handoff.HandoffError):
            handoff.validate_report(report)


if __name__ == "__main__":
    unittest.main()
