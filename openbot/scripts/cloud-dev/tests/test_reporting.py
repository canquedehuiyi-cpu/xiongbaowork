import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import reporting


def check(check_id, status, required=True):
    return reporting.make_check(check_id, check_id, "test", status, required)


class ExitCodePolicyTests(unittest.TestCase):
    """Exit policy (Root review item 4): fail > required-incomplete > pass;
    OPTIONAL blocked/skipped/unverified never block."""

    def test_all_required_passed_is_zero(self):
        checks = [check("a", "passed"), check("b", "passed", required=False)]
        self.assertEqual(reporting.compute_exit_code(checks), 0)
        self.assertEqual(reporting.overall_status(checks), "pass")

    def test_any_failure_is_one_even_if_optional(self):
        checks = [check("a", "passed"), check("b", "failed", required=False)]
        self.assertEqual(reporting.compute_exit_code(checks), 1)
        self.assertEqual(reporting.overall_status(checks), "fail")

    def test_required_blocked_is_two(self):
        checks = [check("a", "passed"), check("b", "blocked")]
        self.assertEqual(reporting.compute_exit_code(checks), 2)
        self.assertEqual(reporting.overall_status(checks), "incomplete")

    def test_required_skipped_is_two(self):
        checks = [check("a", "passed"), check("b", "skipped")]
        self.assertEqual(reporting.compute_exit_code(checks), 2)

    def test_required_unverified_is_two(self):
        checks = [check("a", "passed"), check("b", "unverified")]
        self.assertEqual(reporting.compute_exit_code(checks), 2)

    def test_optional_incomplete_is_pass_and_zero(self):
        for status in ("blocked", "skipped", "unverified"):
            checks = [check("a", "passed"), check("b", status, required=False)]
            self.assertEqual(reporting.compute_exit_code(checks), 0, status)
            self.assertEqual(reporting.overall_status(checks), "pass", status)

    def test_failure_outranks_incomplete(self):
        checks = [check("a", "failed"), check("b", "blocked")]
        self.assertEqual(reporting.compute_exit_code(checks), 1)
        self.assertEqual(reporting.overall_status(checks), "fail")

    def test_empty_check_list_is_zero(self):
        self.assertEqual(reporting.compute_exit_code([]), 0)
        self.assertEqual(reporting.overall_status([]), "pass")


class OverallExitAgreementTests(unittest.TestCase):
    """JSON/Markdown/exit share one policy: exit == OVERALL_TO_EXIT[overall]."""

    def test_overall_and_exit_always_agree(self):
        combos = [
            [check("a", "passed")],
            [check("a", "failed")],
            [check("a", "blocked")],
            [check("a", "passed"), check("b", "failed", required=False)],
            [check("a", "passed"), check("b", "blocked", required=False)],
            [check("a", "failed"), check("b", "blocked")],
            [check("a", "unverified", required=False)],
            [],
        ]
        for checks in combos:
            overall = reporting.overall_status(checks)
            self.assertEqual(reporting.compute_exit_code(checks),
                             reporting.OVERALL_TO_EXIT[overall],
                             "mismatch for %r" % (checks,))


class SummaryTests(unittest.TestCase):
    def test_summary_counts_and_total(self):
        checks = [check("a", "passed"), check("b", "failed"),
                  check("c", "blocked"), check("d", "skipped"),
                  check("e", "unverified"), check("f", "passed")]
        summary = reporting.summarize(checks)
        self.assertEqual(summary["passed"], 2)
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["blocked"], 1)
        self.assertEqual(summary["skipped"], 1)
        self.assertEqual(summary["unverified"], 1)
        self.assertEqual(summary["total"], 6)


class CheckValidationTests(unittest.TestCase):
    def test_invalid_status_rejected(self):
        with self.assertRaises(ValueError):
            reporting.make_check("x", "x", "t", "green", True)


class IdentityBlockTests(unittest.TestCase):
    def test_make_identity_block_defaults(self):
        block = reporting.make_identity_block()
        self.assertIsNone(block["expected"])
        self.assertIsNone(block["observed"])
        self.assertEqual(block["status"], "unverified")

    def test_expected_and_observed_stay_separate(self):
        block = reporting.make_identity_block(
            expected={"tree": "pinned"}, observed={"tree": None}, status="unverified")
        self.assertEqual(block["expected"]["tree"], "pinned")
        self.assertIsNone(block["observed"]["tree"])


class ReportTests(unittest.TestCase):
    def test_json_roundtrip_fields(self):
        report = reporting.build_report("t", [check("a", "passed")],
                                        identity={"k": "v"}, notes=["n"])
        clone = json.loads(json.dumps(report, ensure_ascii=False))
        for field in ("schema_version", "tool", "generated_at_utc", "identity",
                      "baseline_identity", "candidate_identity",
                      "checks", "summary", "overall_status", "exit_code", "notes"):
            self.assertIn(field, clone)
        self.assertEqual(clone["summary"]["passed"], 1)
        self.assertEqual(clone["overall_status"], "pass")
        self.assertEqual(clone["exit_code"], 0)

    def test_identity_blocks_default_to_unverified(self):
        report = reporting.build_report("t", [check("a", "passed")])
        self.assertEqual(report["baseline_identity"]["status"], "unverified")
        self.assertEqual(report["candidate_identity"]["status"], "unverified")

    def test_identity_blocks_are_reported_as_given(self):
        baseline = reporting.make_identity_block(
            expected={"tree": "pinned"}, observed={"tree": None}, status="unverified")
        candidate = reporting.make_identity_block(
            observed={"tree": "measured"}, status="unverified")
        report = reporting.build_report("t", [check("a", "passed")],
                                        baseline_identity=baseline,
                                        candidate_identity=candidate)
        self.assertEqual(report["baseline_identity"]["expected"]["tree"], "pinned")
        self.assertIsNone(report["baseline_identity"]["observed"]["tree"])
        self.assertEqual(report["candidate_identity"]["observed"]["tree"], "measured")

    def test_markdown_renders_rows_and_summary(self):
        report = reporting.build_report("t", [check("a", "passed"), check("b", "blocked")])
        text = reporting.render_markdown(report)
        self.assertIn("| a |", text)
        self.assertIn("blocked", text)
        self.assertIn("passed=1 failed=0 blocked=1", text)
        self.assertIn("overall_status: incomplete", text)
        self.assertIn("exit_code: 2", text)

    def test_markdown_renders_identity_blocks(self):
        baseline = reporting.make_identity_block(
            expected={"tree": "pinned"}, observed={"tree": None}, status="unverified",
            details="declared only")
        report = reporting.build_report("t", [check("a", "passed")],
                                        baseline_identity=baseline)
        text = reporting.render_markdown(report)
        self.assertIn("baseline_identity.status: unverified", text)
        self.assertIn("baseline_identity.expected:", text)
        self.assertIn("baseline_identity.observed:", text)
        self.assertIn("baseline_identity.details: declared only", text)
        self.assertIn("candidate_identity.status: unverified", text)

    def test_markdown_escapes_pipes(self):
        value = reporting.make_check("a", "a", "t", "passed", True, observed="has | pipe")
        text = reporting.render_markdown(reporting.build_report("t", [value]))
        self.assertIn("has \\| pipe", text)


if __name__ == "__main__":
    unittest.main()
