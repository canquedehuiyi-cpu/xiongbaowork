"""Tests for the B3-DIA baseline subpackage (pure parts only).

No process is spawned; no project file is executed. CLI trust seams are
exercised only through the library refusal paths (blocked/2, exit 3).
"""
import builtins
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _parent not in sys.path:
    sys.path.insert(0, _parent)

import baseline


SEVEN_LOG = "\n".join([
    "run header: tsc v5.1.6",
    "src/a.ts(1,1): error TS2322: Type 'number' is not assignable to type 'string'.",
    "src/a.ts(2,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "src/b.ts(3,9): error TS2304: Cannot find name 'foo'.",
    "src/b.ts(4,1): error TS7006: Parameter 'x' implicitly has an 'any' type.",
    "  continuation of the TS7006 message with detail 42",
    "src/c.ts(5,2): warning TS6133: 'y' is declared but its value is never read.",
    "src/d.ts(6,3): error TS2551: Property 'bar' does not exist. Did you mean 'baz'?",
    "src/e.ts(7,4): error TS2307: Cannot find module './missing'.",
    "exit code 1",
    "",
])

CLEAN_LOG = "run header: tsc v5.1.6\nexit code 0\n"

NO_EVIDENCE = {"structurally_ok": False, "trusted": False,
               "reasons": ["no run-evidence provided"]}


class TempCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="dia-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.diag_dir = os.path.join(self.root, "diags")
        os.makedirs(self.diag_dir, exist_ok=True)

    def write(self, name, text):
        with open(os.path.join(self.diag_dir, name), "wb") as fh:
            fh.write(text.encode("utf-8"))
        return "diags/" + name


class CompareTests(TempCase):
    def test_t1_same_seven_still7_new0_exit1(self):
        self.write("base.log", SEVEN_LOG)
        self.write("cand.log", SEVEN_LOG)
        r = baseline.compare_texts(SEVEN_LOG, SEVEN_LOG)
        self.assertEqual(len(r["comparison"]["still_present"]), 7)
        self.assertEqual(len(r["comparison"]["new"]), 0)
        self.assertEqual(len(r["comparison"]["resolved"]), 0)
        report = baseline.assemble_report("p", r["comparison"], r["unparsed"],
                                          NO_EVIDENCE, True)
        self.assertEqual(report["exit_code"], 1)
        self.assertEqual(report["overall_status"], "fail")

    def test_t2_duplicate_diagnostic_new1(self):
        eight = SEVEN_LOG.replace(
            "src/e.ts(7,4): error TS2307: Cannot find module './missing'.",
            "src/e.ts(7,4): error TS2307: Cannot find module './missing'.\n"
            "src/e.ts(7,4): error TS2307: Cannot find module './missing'.")
        r = baseline.compare_texts(SEVEN_LOG, eight)
        self.assertEqual(len(r["comparison"]["new"]), 1)
        self.assertEqual(len(r["comparison"]["still_present"]), 7)

    def test_t3_resolved_never_upgrades_failed(self):
        six = SEVEN_LOG.replace(
            "src/e.ts(7,4): error TS2307: Cannot find module './missing'.\n",
            "")
        r = baseline.compare_texts(SEVEN_LOG, six)
        self.assertEqual(len(r["comparison"]["resolved"]), 1)
        self.assertEqual(len(r["comparison"]["still_present"]), 6)
        self.assertEqual(len(r["comparison"]["new"]), 0)
        report = baseline.assemble_report(
            "p", r["comparison"], r["unparsed"],
            {"structurally_ok": True, "trusted": True, "reasons": []}, True)
        self.assertEqual(report["exit_code"], 1)

    def test_t4_multiline_and_no_blur(self):
        crlf = SEVEN_LOG.replace("\n", "\r\n").replace(
            "type 'string'.", "type 'string'.  ")
        k1 = sorted(d["key"] for d in
                    baseline.parse_diagnostics(SEVEN_LOG)["diags"])
        self.assertEqual(
            k1, sorted(d["key"] for d in
                       baseline.parse_diagnostics(crlf)["diags"]))
        self.assertNotEqual(
            k1, sorted(d["key"] for d in baseline.parse_diagnostics(
                SEVEN_LOG.replace("detail 42", "detail 43"))["diags"]))

    def test_t5_windows_backslash_same_key(self):
        k1 = sorted(d["key"] for d in
                    baseline.parse_diagnostics(SEVEN_LOG)["diags"])
        win = SEVEN_LOG.replace("src/", "src\\")
        self.assertEqual(
            k1, sorted(d["key"] for d in
                       baseline.parse_diagnostics(win)["diags"]))

    def test_t5b_distinct_literal_files_not_merged(self):
        # r2: file key keeps leading whitespace; " a.ts" != "a.ts".
        la = baseline.parse_diagnostics("a.ts(1,1): error TS1: m\n")["diags"]
        lb = baseline.parse_diagnostics(" a.ts(1,1): error TS1: m\n")["diags"]
        self.assertNotEqual(la[0]["key"], lb[0]["key"])
        r = baseline.compare(la, lb)
        self.assertEqual(len(r["new"]), 1)
        self.assertEqual(len(r["still_present"]), 0)

    def test_t6_unparsed_kept_failed1_priority(self):
        dirty = SEVEN_LOG.replace(
            "run header: tsc v5.1.6",
            "run header: tsc v5.1.6\n??? total garbage line ???")
        r = baseline.compare_texts(dirty, dirty)
        raws = [u["raw"] for u in r["unparsed"]]
        self.assertEqual(len(r["unparsed"]), 6)  # 3 per side: header/garbage/exit
        self.assertIn("??? total garbage line ???", raws)
        self.assertFalse(r["credibility_verified"])
        self.assertEqual(len(r["comparison"]["still_present"]), 7)
        report = baseline.assemble_report("p", r["comparison"], r["unparsed"],
                                          NO_EVIDENCE, True)
        self.assertEqual(report["exit_code"], 1)

    def test_t7_empty_logs_no_runproof_exit2_never_pass(self):
        r = baseline.compare_texts("", "")
        self.assertEqual(len(r["comparison"]["new"]), 0)
        report = baseline.assemble_report("p", r["comparison"], r["unparsed"],
                                          NO_EVIDENCE, True)
        self.assertEqual(report["exit_code"], 2)
        self.assertEqual(report["overall_status"], "incomplete")

    def test_t7b_clean_logs_untrusted_evidence_exit2(self):
        r = baseline.compare_texts(CLEAN_LOG, CLEAN_LOG)
        report = baseline.assemble_report(
            "p", r["comparison"], r["unparsed"],
            {"structurally_ok": True, "trusted": False, "reasons": []}, True)
        self.assertEqual(report["exit_code"], 2)

    def test_t12_message_sha_and_raw_preserved(self):
        diags = baseline.parse_diagnostics(SEVEN_LOG)["diags"]
        target = [d for d in diags if d["code"] == "TS7006"][0]
        self.assertIn("\n", target["message"])
        self.assertEqual(
            target["message_sha256"],
            hashlib.sha256(target["message"].encode("utf-8")).hexdigest())
        self.assertIn("continuation", target["raw"])


class EvidenceTests(TempCase):
    FIELDS = {
        "log_path": "diags/b.log",
        "log_sha256": hashlib.sha256(SEVEN_LOG.encode("utf-8")).hexdigest(),
        "argv": ["bun", "x", "tsc", "--noEmit"],
        "cwd": "/srv/openbot",
        "dep_tree": {"bun": "1.3.14", "typescript": "5.1.6"},
        "started_at": "2026-10-19T01:00:00+00:00",
        "ended_at": "2026-10-19T01:00:03+00:00",
        "exit_code": 1,
        "log_bytes": len(SEVEN_LOG.encode("utf-8")),
    }

    def test_strict_types_and_bool_rejected(self):
        bad = dict(self.FIELDS)
        bad["exit_code"] = True
        res = baseline.parse_run_evidence(json.dumps(bad).encode("utf-8"))
        self.assertFalse(res["structurally_ok"])
        self.assertTrue(any("bool" in x for x in res["reasons"]))

    def test_missing_field_rejected(self):
        bad = dict(self.FIELDS)
        del bad["dep_tree"]
        res = baseline.parse_run_evidence(json.dumps(bad).encode("utf-8"))
        self.assertFalse(res["structurally_ok"])

    def test_binding_mismatch_detected(self):
        ev = baseline.parse_run_evidence(json.dumps(self.FIELDS).encode("utf-8"))
        self.assertTrue(ev["structurally_ok"])
        bound = baseline.bind_evidence(ev, b"different bytes")
        self.assertFalse(bound["structurally_ok"])
        self.assertTrue(any("log_sha256" in x for x in bound["reasons"]))
        bound2 = baseline.bind_evidence(ev, SEVEN_LOG.encode("utf-8"))
        self.assertTrue(bound2["structurally_ok"])
        self.assertFalse(bound2["trusted"])

    def test_self_report_never_trusted(self):
        ev = baseline.parse_run_evidence(json.dumps(self.FIELDS).encode("utf-8"))
        bound = baseline.bind_evidence(ev, SEVEN_LOG.encode("utf-8"))
        self.assertFalse(bound["trusted"])

    def test_log_sha256_exact_64hex_accepted(self):
        # r3 (Root 51669584): strict shape -- exactly 64 lowercase hex.
        good = dict(self.FIELDS)
        good["log_sha256"] = "a" * 64
        res = baseline.parse_run_evidence(json.dumps(good).encode("utf-8"))
        self.assertTrue(res["structurally_ok"])
        self.assertEqual(res["reasons"], [])

    def test_log_sha256_trailing_newline_refused(self):
        # r3 (Root 51669584): re.match with "$" accepted a 64-hex value
        # followed by one trailing LF; re.fullmatch refuses it (official
        # docs: $ matches before a final newline, fullmatch needs the
        # whole string). Structural rejection only; trusted stays False.
        bad = dict(self.FIELDS)
        bad["log_sha256"] = "a" * 64 + "\n"
        res = baseline.parse_run_evidence(json.dumps(bad).encode("utf-8"))
        self.assertFalse(res["structurally_ok"])
        self.assertTrue(any("log_sha256" in x for x in res["reasons"]))


class GuardTests(TempCase):
    def test_secret_component_refused(self):
        self.write("base.log", SEVEN_LOG)
        problems, data = baseline.read_log(self.root, "diags/.env/base.log")
        self.assertEqual(data, b"")
        self.assertTrue(any("secret" in p for p in problems))

    def test_extension_refused(self):
        self.write("evil.cfg", SEVEN_LOG)
        problems, data = baseline.read_log(self.root, "diags/evil.cfg")
        self.assertEqual(data, b"")
        self.assertTrue(any("extension" in p for p in problems))

    def test_parent_escape_refused(self):
        problems, data = baseline.read_log(
            self.root, "diags/../../etc/passwd.log")
        self.assertEqual(data, b"")
        self.assertTrue(any("parent" in p for p in problems))

    def test_absolute_refused(self):
        problems, data = baseline.read_log(self.root, "/etc/passwd.log")
        self.assertEqual(data, b"")
        self.assertTrue(any("absolute" in p for p in problems))

    def test_allowed_log_reads_bytes(self):
        self.write("base.log", SEVEN_LOG)
        problems, data = baseline.read_log(self.root, "diags/base.log")
        self.assertEqual(problems, [])
        self.assertEqual(data.decode("utf-8"), SEVEN_LOG)

    def test_whitespace_path_refused_not_trimmed_open(self):
        self.write("base.log", SEVEN_LOG)
        problems, data = baseline.read_log(self.root, " diags/base.log ")
        self.assertEqual(data, b"")
        self.assertTrue(any("whitespace" in p for p in problems))

    def test_guard_and_reader_share_literal_target(self):
        self.write("base.log", SEVEN_LOG)
        norm = baseline.norm_log_path("diags/base.log")
        self.assertEqual(
            baseline.literal_target(self.root, norm),
            os.path.join(self.root, "diags", "base.log"))

    def test_id_prefix_component_refused(self):
        self.write("id_note.log", SEVEN_LOG)
        problems, data = baseline.read_log(self.root, "diags/id_note.log")
        self.assertEqual(data, b"")
        self.assertTrue(any("id_" in p for p in problems))

    def test_symlink_component_refused(self):
        real_dir = os.path.join(self.root, "real")
        os.makedirs(real_dir, exist_ok=True)
        with open(os.path.join(real_dir, "x.log"), "wb") as fh:
            fh.write(SEVEN_LOG.encode("utf-8"))
        link_dir = os.path.join(self.root, "diags", "linked")
        try:
            os.symlink(real_dir, link_dir)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not permitted on this host")
        if not os.path.islink(link_dir):
            self.skipTest("symlink silently unavailable on this host")
        problems, data = baseline.read_log(self.root, "diags/linked/x.log")
        self.assertEqual(data, b"")
        self.assertTrue(any("symlink" in p for p in problems))


class CliSeamTests(unittest.TestCase):
    def test_positions_declared(self):
        self.assertIn("POSITION 1", baseline.GAP_LOG_ADAPTER)
        self.assertIn("POSITION 2", baseline.GAP_EVIDENCE_ADAPTER)

    def test_nonexistent_repo_root_is_plain_exit3(self):
        # r2 contract: parameter/plan errors build NO reporting report;
        # JSON output and process return code agree on 3 (Root 51667447).
        outcome = baseline.run_cli("Z:/definitely/not/here", "a.log", "b.log")
        self.assertEqual(outcome["exit_code"], 3)
        self.assertIsNone(outcome["report"])
        self.assertTrue(outcome["error"])

    def test_argparse_failures_exit3(self):
        for argv in (
            ["--diag-baseline", "a", "--diag-candidate", "b",
             "--repo-root", "Z:/no", "--plan-name", "other"],
            ["--diag-baseline", "a", "--diag-candidate", "b",
             "--repo-root", "Z:/no", "--format", "yaml"],
            ["--diag-baseline", "a"],
            ["--diag-baseline", "a", "--diag-candidate", "b",
             "--repo-root", "Z:/no", "--bogus"],
        ):
            with self.assertRaises(SystemExit) as cm:
                baseline.main(argv)
            self.assertEqual(cm.exception.code, 3)

    def test_main_json_error_same_exit3(self):
        buf = io.StringIO()
        with mock.patch.object(sys, "stdout", buf):
            rc = baseline.main(["--diag-baseline", "a", "--diag-candidate",
                                "b", "--repo-root", "Z:/definitely/not/here"])
        self.assertEqual(rc, 3)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["exit_code"], 3)
        self.assertTrue(payload["error"])

    def test_unread_log_never_fakely_bound(self):
        # r2: evidence bytes present but zero log bytes read -> structural
        # validation only, no bind_evidence(ev, b"") fake binding.
        fields = dict(EvidenceTests.FIELDS)
        fields["log_sha256"] = "0" * 64
        with mock.patch.object(baseline, "load_registry", lambda: {}), \
                mock.patch.object(baseline, "resolve_repo_root",
                                  lambda arg, reg: os.getcwd()):
            outcome = baseline.run_cli("x", "a.log", "b.log",
                                       json.dumps(fields).encode("utf-8"))
        self.assertEqual(outcome["exit_code"], 2)
        checks = {c["check_id"]: c for c in outcome["report"]["checks"]}
        self.assertEqual(checks["run-evidence"]["status"], "blocked")
        self.assertIn("binding not performed",
                      checks["run-evidence"].get("details") or "")

    def test_unauthorized_evidence_path_never_read(self):
        opened = []
        real_open = builtins.open

        def spy(file, *a, **kw):
            opened.append(str(file))
            return real_open(file, *a, **kw)

        with mock.patch.object(baseline, "load_registry", lambda: {}), \
                mock.patch.object(baseline, "resolve_repo_root",
                                  lambda arg, reg: os.getcwd()), \
                mock.patch("builtins.open", spy):
            outcome = baseline.run_cli(
                "x", "a.log", "b.log", None,
                "/definitely/not/here/evidence.json")
        self.assertEqual(outcome["exit_code"], 2)
        self.assertFalse(any("evidence.json" in p for p in opened))
        notes = outcome["report"].get("notes") or []
        self.assertTrue(any("never read" in n for n in notes))

    def test_main_zero_open_regression_actual_main(self):
        # r3 gate (Root 51669037 + 51669584): actual main() on a fully
        # valid argv must attempt ZERO file opens and ZERO evidence
        # bindings. The r2 CliSeam tests either call run_cli directly or
        # stop at parameter/registry error paths, so a P1-style pre-read
        # of --run-evidence reinserted between parse_args and run_cli
        # would not be caught there. builtins.open is replaced by a deny
        # spy and bind_evidence by a deny stub: the FIRST attempt raises
        # AssertionError immediately -- nothing is read, nothing is bound.
        argv = ["--diag-baseline", "diags/base.log",
                "--diag-candidate", "diags/cand.log",
                "--repo-root", "Z:/trusted/root",
                "--run-evidence", "evidence/record.json",
                "--format", "json"]
        opened = []

        def deny_open(file, *a, **kw):
            opened.append(str(file))
            raise AssertionError("unexpected open attempt in main: %r"
                                 % (file,))

        def deny_bind(*a, **kw):
            raise AssertionError("unexpected bind_evidence call in main")

        buf = io.StringIO()
        with mock.patch.object(baseline, "load_registry", lambda: {}), \
                mock.patch.object(baseline, "resolve_repo_root",
                                  lambda arg, reg: "Z:/trusted/root"), \
                mock.patch("builtins.open", deny_open), \
                mock.patch.object(baseline, "bind_evidence", deny_bind), \
                mock.patch.object(sys, "stdout", buf):
            rc = baseline.main(argv)
        self.assertEqual(opened, [])
        self.assertEqual(rc, 2)
        report = json.loads(buf.getvalue())
        self.assertEqual(report["exit_code"], 2)
        checks = {c["check_id"]: c for c in report["checks"]}
        self.assertEqual(checks["diag-compare"]["status"], "blocked")
        self.assertEqual(checks["run-evidence"]["status"], "blocked")
        notes = report.get("notes") or []
        self.assertTrue(any("never read" in n for n in notes))


if __name__ == "__main__":
    unittest.main()
