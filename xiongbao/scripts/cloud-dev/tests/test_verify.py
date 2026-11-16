import builtins
import hashlib
import io
import json
import contextlib
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import reporting
import verify

SCHED_SLACK_S = 1.0  # r3 item 1: budget + <=1s scheduling slack (no 10s slack)


def frozen_plan_bytes(name):
    """Serialize the frozen contract exactly as verify expects it (value-equal)."""
    spec = verify.FROZEN_PLANS[name]
    plan = {
        "schema_version": "1.1",
        "plan_name": name,
        "plan_version": spec["plan_version"],
        "max_timeout_s": spec["max_timeout_s"],
        "steps": [dict(spec["step"])],
    }
    return json.dumps(plan, indent=2).encode("utf-8") + b"\n"


def dummy_registry(root, approved=None):
    """Schema-1.1 registry skeleton with format-valid (absent) tool mappings."""
    return {
        "schema_version": "1.1",
        "plans": {},
        "trusted_tools": {
            "python3": {"path": os.path.join(root, "absent-python3"),
                        "bytes": 1, "sha256": "0" * 64},
            "bun": {"path": os.path.join(root, "absent-bun"),
                    "bytes": 1, "sha256": "0" * 64},
        },
        "approved_repo_roots": approved if approved is not None else [root],
    }


def make_tool_dir(root, approved_roots=None):
    """Fresh Root-like deployment: two plan files + a frozen 1.1 registry."""
    tool_dir = os.path.join(root, "tool")
    os.makedirs(tool_dir)
    entries = {}
    for name in ("tool-self-check", "smoke"):
        raw = frozen_plan_bytes(name)
        with open(os.path.join(tool_dir, verify.FROZEN_PLANS[name]["file"]), "wb") as fh:
            fh.write(raw)
        entries[name] = {
            "plan_version": verify.FROZEN_PLANS[name]["plan_version"],
            "plan_sha256": hashlib.sha256(raw).hexdigest(),
        }
    registry = dummy_registry(root, approved_roots)
    registry["plans"] = entries
    with open(os.path.join(tool_dir, verify.REGISTRY_NAME), "w", encoding="utf-8") as fh:
        json.dump(registry, fh, indent=2)
        fh.write("\n")
    return tool_dir


def make_repo(root):
    """Minimal repo fixture: openbot/server cwd + typescript 5.9.3 prereq."""
    repo = os.path.join(root, "repo")
    os.makedirs(os.path.join(repo, "openbot", "server"))
    ts_dir = os.path.join(repo, "openbot", "node_modules", "typescript")
    os.makedirs(os.path.join(ts_dir, "bin"))
    with open(os.path.join(ts_dir, "package.json"), "w", encoding="utf-8") as fh:
        json.dump({"name": "typescript", "version": "5.9.3"}, fh)
    with open(os.path.join(ts_dir, "bin", "tsc"), "w", encoding="utf-8") as fh:
        fh.write("#!/bin/sh\nexit 0\n")
    return repo


def temp_root():
    return tempfile.mkdtemp(prefix="cloud-dev-verify-fixture-")


def fake_result(**kw):
    base = {
        "exit_code": 0, "timed_out": False, "stdout": "", "stderr": "",
        "stdout_done": True, "stderr_done": True,
        "stdout_eof": True, "stderr_eof": True,
        "stdout_error": None, "stderr_error": None,
        "stdout_kept_bytes": 0, "stderr_kept_bytes": 0,
        "stdout_discarded_bytes": 0, "stderr_discarded_bytes": 0,
        "termination": {"termination_attempted": False, "direct_child_reaped": True,
                        "group_signal_confirmed": None, "descendants_confirmed": None},
        "resources_unresolved": False, "duration_s": 0.01,
    }
    base.update(kw)
    return base


def one_step_plan(step_id="s1", deps=None, prereq=None,
                  argv=("python3", "-B", "-c", "print('x')"),
                  required=True):
    return {
        "schema_version": "1.1", "plan_name": "fixture", "plan_version": "1",
        "max_timeout_s": 600,
        "steps": [{
            "id": step_id, "argv": list(argv), "cwd": ".",
            "timeout_s": 30, "required": required, "capture": True,
            "depends_on": list(deps or []), "prereq_paths": list(prereq or []),
        }],
    }


def multi_plan(steps):
    return {"schema_version": "1.1", "plan_name": "fixture", "plan_version": "1",
            "max_timeout_s": 600, "steps": steps}


def step(sid, deps=None, required=True):
    return {"id": sid, "argv": ["python3", "-B", "-c", "print('x')"], "cwd": ".",
            "timeout_s": 30, "required": required, "capture": True,
            "depends_on": list(deps or []), "prereq_paths": []}


def by_id(checks):
    return dict((c["check_id"], c) for c in checks)


class RegistryPlanIntegrityTests(unittest.TestCase):
    """Ticket item 1: trust comes only from the tool deployment directory."""

    def setUp(self):
        self.root = temp_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tool_dir = make_tool_dir(self.root)

    def rewrite_plan(self, name, mutate):
        raw = json.loads(frozen_plan_bytes(name).decode("utf-8"))
        mutate(raw)
        data = json.dumps(raw, indent=2).encode("utf-8") + b"\n"
        with open(os.path.join(self.tool_dir, verify.FROZEN_PLANS[name]["file"]), "wb") as fh:
            fh.write(data)
        return data

    def rewrite_registry(self, registry):
        with open(os.path.join(self.tool_dir, verify.REGISTRY_NAME), "w",
                  encoding="utf-8") as fh:
            json.dump(registry, fh, indent=2)

    def full_registry(self):
        entries = {}
        for name in ("tool-self-check", "smoke"):
            entries[name] = {"plan_version": "1",
                             "plan_sha256": hashlib.sha256(frozen_plan_bytes(name)).hexdigest()}
        reg = dummy_registry(self.root)
        reg["plans"] = entries
        return reg

    def test_unknown_plan_name_rejected(self):
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "not-a-frozen-plan")

    def test_registry_missing_rejected(self):
        os.remove(os.path.join(self.tool_dir, verify.REGISTRY_NAME))
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_registry_symlink_refused(self):
        target = os.path.join(self.root, "real-registry.json")
        shutil.move(os.path.join(self.tool_dir, verify.REGISTRY_NAME), target)
        try:
            os.symlink(target, os.path.join(self.tool_dir, verify.REGISTRY_NAME))
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available")
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_plan_hash_mismatch_rejected(self):
        path = os.path.join(self.tool_dir, verify.FROZEN_PLANS["tool-self-check"]["file"])
        with open(path, "ab") as fh:
            fh.write(b" ")  # one extra byte: hash changes, JSON value does not
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_plan_version_mismatch_rejected(self):
        reg = self.full_registry()
        reg["plans"]["tool-self-check"]["plan_version"] = "2"
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_plan_not_registered_rejected(self):
        reg = self.full_registry()
        del reg["plans"]["tool-self-check"]
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_registry_entry_unknown_field_rejected(self):
        reg = self.full_registry()
        reg["plans"]["tool-self-check"]["extra"] = "x"
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_registry_wrong_schema_version_rejected(self):
        reg = self.full_registry()
        reg["schema_version"] = "1.0"
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_registry_missing_trusted_tools_rejected(self):
        reg = self.full_registry()
        del reg["trusted_tools"]
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_registry_extra_trusted_tool_rejected(self):
        reg = self.full_registry()
        reg["trusted_tools"]["gcc"] = {"path": "/usr/bin/gcc",
                                       "bytes": 1, "sha256": "0" * 64}
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_registry_relative_trusted_path_rejected(self):
        reg = self.full_registry()
        reg["trusted_tools"]["bun"] = {"path": "bun", "bytes": 1, "sha256": "0" * 64}
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_registry_relative_approved_root_rejected(self):
        reg = self.full_registry()
        reg["approved_repo_roots"] = ["some/relative/path"]
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_contract_deviation_cannot_be_authorized(self):
        # Caller rewrites plan AND re-records the registry hash: the value-level
        # frozen contract still refuses. Registry+plan pairing grants nothing.
        def mutate(plan):
            plan["steps"][0]["argv"] = ["python3", "-c", "import os; os.system('evil')"]
        data = self.rewrite_plan("tool-self-check", mutate)
        reg = self.full_registry()
        reg["plans"]["tool-self-check"] = {
            "plan_version": "1",
            "plan_sha256": hashlib.sha256(data).hexdigest()}
        self.rewrite_registry(reg)
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_plan_symlink_alias_refused(self):
        outside_dir = tempfile.mkdtemp(prefix="cloud-dev-outside-plan-")
        self.addCleanup(shutil.rmtree, outside_dir, True)
        outside = os.path.join(outside_dir, "plan.json")
        with open(outside, "wb") as fh:
            fh.write(frozen_plan_bytes("tool-self-check"))
        path = os.path.join(self.tool_dir, verify.FROZEN_PLANS["tool-self-check"]["file"])
        os.remove(path)
        try:
            os.symlink(outside, path)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available")
        with self.assertRaises(verify.InvalidPlan):
            verify.load_plan(self.tool_dir, "tool-self-check")

    def test_happy_load_returns_frozen_data_and_registry(self):
        data, raw, registry = verify.load_plan(self.tool_dir, "smoke")
        self.assertEqual(data["steps"][0]["id"], "server-tsc-noemit")
        self.assertEqual(hashlib.sha256(raw).hexdigest(),
                         hashlib.sha256(frozen_plan_bytes("smoke")).hexdigest())
        self.assertEqual(registry["schema_version"], "1.1")
        self.assertEqual(set(registry["trusted_tools"]), {"python3", "bun"})


class DependencyGraphTests(unittest.TestCase):
    def test_unknown_dep_rejected(self):
        plan = multi_plan([step("a"), step("b", deps=["ghost"])])
        with self.assertRaises(verify.InvalidPlan):
            verify.execution_order(plan)

    def test_duplicate_ids_rejected(self):
        with self.assertRaises(verify.InvalidPlan):
            verify.execution_order(multi_plan([step("a"), step("a")]))

    def test_cycle_rejected(self):
        with self.assertRaises(verify.InvalidPlan):
            verify.execution_order(multi_plan([step("a", deps=["b"]), step("b", deps=["a"])]))

    def test_topological_order(self):
        plan = multi_plan([step("c", deps=["b"]), step("b", deps=["a"]), step("a")])
        order = [s["id"] for s in verify.execution_order(plan)]
        self.assertEqual(order, ["a", "b", "c"])


class ExecutePlanTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo(self.root)
        self.registry = dummy_registry(self.root)

    def test_pass_and_report_exit0(self):
        plan = one_step_plan("only")
        self.assertTrue(plan["steps"][0]["required"])
        checks = verify.execute_plan("fixture", plan, self.repo,
                                     executor=lambda s: fake_result())
        self.assertEqual(checks[0]["status"], "passed")
        report = verify.build_report("fixture", plan, self.repo, checks)
        self.assertEqual(report["exit_code"], 0)
        self.assertEqual(report["overall_status"], "pass")

    def test_nonzero_is_failed_exit1_never_green(self):
        plan = one_step_plan("only")
        checks = verify.execute_plan(
            "fixture", plan, self.repo,
            executor=lambda s: fake_result(exit_code=3))
        self.assertEqual(checks[0]["status"], "failed")
        report = verify.build_report("fixture", plan, self.repo, checks)
        self.assertEqual(report["exit_code"], 1)

    def test_timeout_is_failed(self):
        plan = one_step_plan("only")
        checks = verify.execute_plan(
            "fixture", plan, self.repo,
            executor=lambda s: fake_result(timed_out=True, exit_code=None))
        self.assertEqual(checks[0]["status"], "failed")
        self.assertEqual(checks[0]["observed"], "timeout")

    def test_streams_incomplete_exit0_is_unverified(self):
        plan = one_step_plan("only")
        result = fake_result(stdout_done=False, stdout_eof=False,
                             resources_unresolved=True)
        result["termination"]["termination_attempted"] = True
        result["termination"]["group_signal_confirmed"] = True
        checks = verify.execute_plan("fixture", plan, self.repo,
                                     executor=lambda s: result)
        self.assertEqual(checks[0]["status"], "unverified")
        report = verify.build_report("fixture", plan, self.repo, checks)
        self.assertEqual(report["exit_code"], 2)

    def test_stream_read_error_is_never_green(self):
        plan = one_step_plan("only")
        result = fake_result(stdout_error="OSError: bad pipe")
        checks = verify.execute_plan("fixture", plan, self.repo,
                                     executor=lambda s: result)
        self.assertEqual(checks[0]["status"], "unverified")
        self.assertIn("read error", checks[0]["observed"])
        report = verify.build_report("fixture", plan, self.repo, checks)
        self.assertEqual(report["exit_code"], 2)

    def test_exit0_reap_unproven_is_unverified_and_halts(self):
        plan = multi_plan([step("a"), step("b")])
        result = fake_result(
            termination={"termination_attempted": False, "direct_child_reaped": False,
                         "group_signal_confirmed": None, "descendants_confirmed": None},
            resources_unresolved=True)
        checks = verify.execute_plan("fixture", plan, self.repo,
                                     executor=lambda s: result)
        statuses = by_id(checks)
        self.assertEqual(statuses["a"]["status"], "unverified")
        self.assertIn("resources unresolved", statuses["a"]["observed"])
        self.assertEqual(statuses["b"]["status"], "blocked")  # halted, not executed

    def test_missing_executable_is_blocked_exit2(self):
        plan = one_step_plan("only", argv=("bun", "x"))
        with mock.patch.object(verify, "resolve_executable",
                               return_value=(None, "trusted executable missing")):
            checks = verify.execute_plan("fixture", plan, self.repo, executor=None,
                                         registry=self.registry)
        self.assertEqual(checks[0]["status"], "blocked")
        self.assertIn("executable", checks[0]["details"])
        report = verify.build_report("fixture", plan, self.repo, checks)
        self.assertEqual(report["exit_code"], 2)

    def test_real_execution_requires_registry(self):
        plan = one_step_plan("only")
        with self.assertRaises(verify.InvalidArguments):
            verify.execute_plan("fixture", plan, self.repo, executor=None)

    def test_prereq_missing_is_blocked(self):
        plan = one_step_plan("only",
                             prereq=["openbot/node_modules/typescript/bin/missing"])
        with mock.patch.object(verify, "resolve_executable",
                               return_value=(sys.executable, "root-mapping")):
            checks = verify.execute_plan("fixture", plan, self.repo, executor=None,
                                         registry=self.registry)
        self.assertEqual(checks[0]["status"], "blocked")
        self.assertIn("missing", checks[0]["details"])

    def test_prereq_symlink_out_of_repo_is_blocked(self):
        outside_dir = tempfile.mkdtemp(prefix="cloud-dev-outside-prereq-")
        self.addCleanup(shutil.rmtree, outside_dir, True)
        outside = os.path.join(outside_dir, "tsc")
        with open(outside, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        link = os.path.join(self.repo, "openbot", "node_modules", "typescript",
                            "bin", "tsc")
        os.remove(link)
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available")
        plan = one_step_plan(
            "only", prereq=["openbot/node_modules/typescript/bin/tsc"])
        with mock.patch.object(verify, "resolve_executable",
                               return_value=(sys.executable, "root-mapping")):
            checks = verify.execute_plan("fixture", plan, self.repo, executor=None,
                                         registry=self.registry)
        self.assertEqual(checks[0]["status"], "blocked")
        self.assertIn("symlink alias", checks[0]["details"])

    def test_prereq_in_repo_secret_alias_is_blocked(self):
        # In-repo alias (r2 item 5): tsc-like file planted under openbot/.env
        env_bin = os.path.join(self.repo, "openbot", ".env", "bin")
        os.makedirs(env_bin)
        with open(os.path.join(env_bin, "tsc"), "w", encoding="utf-8") as fh:
            fh.write("fake")
        plan = one_step_plan("only", prereq=["openbot/.env/bin/tsc"])
        with mock.patch.object(verify, "resolve_executable",
                               return_value=(sys.executable, "root-mapping")):
            checks = verify.execute_plan("fixture", plan, self.repo, executor=None,
                                         registry=self.registry)
        self.assertEqual(checks[0]["status"], "blocked")
        self.assertIn("layout", checks[0]["details"])

    def test_prereq_symlink_to_in_repo_secret_is_blocked(self):
        creds_dir = os.path.join(self.repo, "openbot", ".env")
        os.makedirs(creds_dir)
        creds = os.path.join(creds_dir, "creds")
        with open(creds, "w", encoding="utf-8") as fh:
            fh.write("SECRET")
        link = os.path.join(self.repo, "openbot", "node_modules", "typescript",
                            "bin", "tsc")
        os.remove(link)
        try:
            os.symlink(creds, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available")
        plan = one_step_plan(
            "only", prereq=["openbot/node_modules/typescript/bin/tsc"])
        with mock.patch.object(verify, "resolve_executable",
                               return_value=(sys.executable, "root-mapping")):
            checks = verify.execute_plan("fixture", plan, self.repo, executor=None,
                                         registry=self.registry)
        self.assertEqual(checks[0]["status"], "blocked")
        self.assertIn("layout", checks[0]["details"])

    def test_cwd_alias_into_secret_dir_is_blocked(self):
        server = os.path.join(self.repo, "openbot", "server")
        os.rmdir(server)
        env_dir = os.path.join(self.repo, "openbot", ".env")
        os.makedirs(env_dir)
        try:
            os.symlink(env_dir, server)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available")
        plan = one_step_plan("only")
        plan["steps"][0]["cwd"] = "openbot/server"
        with mock.patch.object(verify, "resolve_executable",
                               return_value=(sys.executable, "root-mapping")):
            checks = verify.execute_plan("fixture", plan, self.repo, executor=None,
                                         registry=self.registry)
        self.assertEqual(checks[0]["status"], "blocked")
        self.assertIn("protected directory segment", checks[0]["details"])

    def test_failed_dep_blocks_dependent_independent_survives(self):
        plan = multi_plan([step("a"), step("b", deps=["a"]), step("c")])
        calls = []

        def executor(s):
            calls.append(s["id"])
            return fake_result(exit_code=1) if s["id"] == "a" else fake_result()

        checks = verify.execute_plan("fixture", plan, self.repo, executor=executor)
        statuses = by_id(checks)
        self.assertEqual(statuses["a"]["status"], "failed")
        self.assertEqual(statuses["b"]["status"], "blocked")
        self.assertEqual(statuses["b"]["details"], "prerequisite-a:failed")
        self.assertEqual(statuses["c"]["status"], "passed")
        self.assertEqual(sorted(calls), ["a", "c"])
        report = verify.build_report("fixture", plan, self.repo, checks)
        self.assertEqual(report["exit_code"], 1)

    def test_unverified_dep_blocks_dependent(self):
        plan = multi_plan([step("a"), step("b", deps=["a"])])

        def executor(s):
            if s["id"] == "a":
                result = fake_result(stdout_done=False, stdout_eof=False,
                                     resources_unresolved=True)
                result["termination"]["termination_attempted"] = True
                return result
            return fake_result()

        checks = verify.execute_plan("fixture", plan, self.repo, executor=executor)
        statuses = by_id(checks)
        self.assertEqual(statuses["a"]["status"], "unverified")
        self.assertEqual(statuses["b"]["status"], "blocked")

    def test_unresolved_resources_halt_further_execution(self):
        plan = multi_plan([step("a"), step("b")])
        calls = []

        def executor(s):
            calls.append(s["id"])
            return fake_result(direct_child_reaped=False, resources_unresolved=True)

        checks = verify.execute_plan("fixture", plan, self.repo, executor=executor)
        self.assertEqual(calls, ["a"])  # b never actually executed
        statuses = by_id(checks)
        self.assertEqual(statuses["b"]["status"], "blocked")
        self.assertIn("unresolved", statuses["b"]["details"])

    def test_forced_termination_unknown_descendants_halts(self):
        # r3 item 3 negative: forced + group-confirmed + reaped + EOF, but
        # descendants_confirmed stays null (EOF is NOT descendants proof).
        # resources_unresolved is False, yet the plan must halt: zero further
        # runner calls, remaining steps reported blocked to Root.
        plan = multi_plan([step("a"), step("b")])
        calls = []

        def executor(s):
            calls.append(s["id"])
            return fake_result(termination={
                "termination_attempted": True, "direct_child_reaped": True,
                "group_signal_confirmed": True, "descendants_confirmed": None})

        checks = verify.execute_plan("fixture", plan, self.repo, executor=executor)
        self.assertEqual(calls, ["a"])  # b never actually executed
        statuses = by_id(checks)
        self.assertEqual(statuses["a"]["status"], "unverified")
        self.assertEqual(statuses["b"]["status"], "blocked")
        self.assertIn("halted", statuses["b"]["details"])

    def test_timeout_with_unknown_descendants_halts(self):
        # r3 item 3: timed_out alone (without resources_unresolved) is a
        # forced termination -> halt while descendants are unproven.
        plan = multi_plan([step("a"), step("b")])
        calls = []

        def executor(s):
            calls.append(s["id"])
            return fake_result(timed_out=True, exit_code=None)

        checks = verify.execute_plan("fixture", plan, self.repo, executor=executor)
        self.assertEqual(calls, ["a"])
        statuses = by_id(checks)
        self.assertEqual(statuses["a"]["status"], "failed")
        self.assertEqual(statuses["b"]["status"], "blocked")

    def test_natural_exit_with_unknown_descendants_continues(self):
        # r3 item 3 positive: natural exit/reap/EOF (no timeout, no forced
        # termination) with descendants_confirmed null must NOT halt.
        plan = multi_plan([step("a"), step("b")])
        calls = []

        def executor(s):
            calls.append(s["id"])
            return fake_result()  # descendants_confirmed stays None

        checks = verify.execute_plan("fixture", plan, self.repo, executor=executor)
        self.assertEqual(calls, ["a", "b"])
        statuses = by_id(checks)
        self.assertEqual(statuses["a"]["status"], "passed")
        self.assertEqual(statuses["b"]["status"], "passed")

    def test_optional_blocked_does_not_block_overall(self):
        plan = one_step_plan("opt", required=False, argv=("bun", "x"))
        self.assertFalse(plan["steps"][0]["required"])
        with mock.patch.object(verify, "resolve_executable",
                               return_value=(None, "trusted executable missing")):
            checks = verify.execute_plan("fixture", plan, self.repo, executor=None,
                                         registry=self.registry)
        statuses = by_id(checks)
        self.assertEqual(statuses["opt"]["status"], "blocked")
        report = verify.build_report("fixture", plan, self.repo, checks)
        self.assertEqual(report["exit_code"], 0)
        self.assertEqual(report["overall_status"], "pass")


class BoundedReaderTests(unittest.TestCase):
    """r2 item 3: done / eof / read-error are recorded separately."""

    def test_eof_recorded(self):
        reader = verify.BoundedReader(io.BytesIO(b"stream-data"))
        reader.start()
        reader.join(10)
        self.assertTrue(reader.done)
        self.assertTrue(reader.eof)
        self.assertIsNone(reader.error)
        self.assertEqual(reader.raw_bytes(), b"stream-data")

    def test_read_error_recorded_not_swallowed(self):
        class Bad:
            def read(self, size):
                raise OSError("boom")

            def close(self):
                pass

        reader = verify.BoundedReader(Bad())
        reader.start()
        reader.join(10)
        self.assertTrue(reader.done)
        self.assertFalse(reader.eof)
        self.assertIsNotNone(reader.error)
        self.assertIn("boom", reader.error)

    def test_capture_still_bounded(self):
        reader = verify.BoundedReader(io.BytesIO(b"x" * (verify.CAPTURE_MAX_BYTES + 500)))
        reader.start()
        reader.join(10)
        self.assertEqual(reader.kept, verify.CAPTURE_MAX_BYTES)
        self.assertEqual(reader.discarded, 500)


class TrustedBindingTests(unittest.TestCase):
    """r2 item 4: execution only via Root-registered byte-verified mappings."""

    def setUp(self):
        self.root = temp_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tool_file = os.path.join(self.root, "tool-binary")
        with open(self.tool_file, "wb") as fh:
            fh.write(b"MAGIC-BYTES")
        self.entry = {"path": self.tool_file, "bytes": 11,
                      "sha256": hashlib.sha256(b"MAGIC-BYTES").hexdigest()}

    def registry_with(self, python3=None, bun=None):
        reg = dummy_registry(self.root)
        reg["trusted_tools"]["python3"] = python3 or dict(self.entry)
        reg["trusted_tools"]["bun"] = bun or dict(self.entry)
        return reg

    def test_bun_resolved_from_mapping(self):
        path, how = verify.resolve_executable("bun", self.registry_with())
        self.assertEqual(path, self.tool_file)
        self.assertEqual(how, "root-mapping")

    def test_no_path_fallback_even_when_on_path(self):
        fake_bin = os.path.join(self.root, "fakebin")
        os.makedirs(fake_bin)
        with open(os.path.join(fake_bin, "bun"), "w", encoding="utf-8") as fh:
            fh.write("impostor")
        with mock.patch.dict(os.environ, {"PATH": fake_bin + os.pathsep + os.environ.get("PATH", "")}):
            path, _how = verify.resolve_executable("bun", self.registry_with())
        self.assertEqual(path, self.tool_file)  # mapping wins, PATH ignored

    def test_missing_mapped_file_is_blocked(self):
        entry = dict(self.entry)
        entry["path"] = os.path.join(self.root, "ghost-binary")
        path, reason = verify.resolve_executable("bun", self.registry_with(bun=entry))
        self.assertIsNone(path)
        self.assertIn("missing", reason)

    def test_size_mismatch_is_blocked(self):
        entry = dict(self.entry)
        entry["bytes"] = 12
        path, reason = verify.resolve_executable("bun", self.registry_with(bun=entry))
        self.assertIsNone(path)
        self.assertIn("size mismatch", reason)

    def test_hash_mismatch_is_blocked(self):
        entry = dict(self.entry)
        entry["sha256"] = "1" * 64
        path, reason = verify.resolve_executable("bun", self.registry_with(bun=entry))
        self.assertIsNone(path)
        self.assertIn("mismatch", reason)

    def test_unknown_tool_is_exit3(self):
        with self.assertRaises(verify.InvalidPlan):
            verify.resolve_executable("gcc", self.registry_with())

    def test_python3_requires_running_interpreter_match(self):
        # Mapped file is byte-valid but is NOT the running interpreter.
        path, reason = verify.resolve_executable("python3", self.registry_with())
        self.assertIsNone(path)
        self.assertIn("does not match", reason)

    def test_python3_matches_running_interpreter(self):
        real = sys.executable
        entry = {"path": real, "bytes": os.path.getsize(real),
                 "sha256": verify._sha256_file(real)}
        path, how = verify.resolve_executable("python3", self.registry_with(python3=entry))
        self.assertEqual(path, real)
        self.assertEqual(how, "root-mapping")


class RepoRootApprovalTests(unittest.TestCase):
    """r2 item 4: --repo-root must be a Root-approved real path."""

    def setUp(self):
        self.root = temp_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo(self.root)

    def test_approved_root_accepted(self):
        reg = dummy_registry(self.root, approved=[self.repo])
        self.assertEqual(verify.resolve_repo_root(self.repo, reg),
                         os.path.realpath(self.repo))

    def test_unapproved_root_rejected(self):
        reg = dummy_registry(self.root, approved=[self.repo])
        other = os.path.join(self.root, "repo2")
        os.makedirs(other)
        with self.assertRaises(verify.InvalidPlan):
            verify.resolve_repo_root(other, reg)

    def test_nonexistent_root_rejected(self):
        reg = dummy_registry(self.root, approved=[self.repo])
        with self.assertRaises(verify.InvalidArguments):
            verify.resolve_repo_root(os.path.join(self.root, "ghost"), reg)


class EnvAndRedactionTests(unittest.TestCase):
    def test_safe_env_allowlist(self):
        env = {"PATH": "/bin", "MY_TOKEN": "s3cret", "NODE_OPTIONS": "x"}
        safe = verify.build_safe_env(env)
        self.assertEqual(safe["PATH"], "/bin")
        self.assertEqual(safe["PYTHONDONTWRITEBYTECODE"], "1")
        self.assertNotIn("MY_TOKEN", safe)
        self.assertNotIn("NODE_OPTIONS", safe)

    def test_canary_redaction(self):
        with mock.patch.dict(os.environ, {"WW_CANARY": "CANARYSECRET99"}):
            values = verify.collect_excluded_env_values()
        self.assertIn("CANARYSECRET99", values)
        cleaned = verify.sanitize("out=CANARYSECRET99;", values)
        self.assertEqual(cleaned, "out=[REDACTED];")

    def test_safe_env_values_never_collected(self):
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin"}):
            values = verify.collect_excluded_env_values()
        self.assertNotIn("/usr/bin", values)


class ZeroWriteTests(unittest.TestCase):
    def test_no_writes_in_repo_or_tool_dir(self):
        root = temp_root()
        self.addCleanup(shutil.rmtree, root, True)
        tool_dir = make_tool_dir(root)
        repo = make_repo(root)

        def snapshot(base):
            state = {}
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [d for d in dirnames if d != "__pycache__"]
                for name in filenames:
                    path = os.path.join(dirpath, name)
                    state[path] = os.stat(path).st_mtime_ns
            return state

        before_repo, before_tool = snapshot(repo), snapshot(tool_dir)
        plan_data, _raw, _registry = verify.load_plan(tool_dir, "tool-self-check")
        verify.execute_plan("tool-self-check", plan_data, repo,
                            executor=lambda s: fake_result())
        self.assertEqual(snapshot(repo), before_repo)
        self.assertEqual(snapshot(tool_dir), before_tool)
        self.assertFalse(os.path.exists(os.path.join(tool_dir, "__pycache__")))


class CliTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo(self.root)
        self.tool_dir = make_tool_dir(self.root, approved_roots=[self.repo])
        patcher = mock.patch.object(verify, "TOOL_DIR", self.tool_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out):
            with contextlib.redirect_stderr(err):
                code = verify.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_cli_unknown_plan_exit3_no_traceback(self):
        code, out, err = self.run_main(["--plan", "nope", "--repo-root", self.repo])
        self.assertEqual(code, 3)
        self.assertNotIn("Traceback", err)
        self.assertEqual(json.loads(out)["exit_code"], 3)

    def test_cli_bad_repo_root_exit3(self):
        code, out, err = self.run_main(["--plan", "tool-self-check",
                                        "--repo-root", os.path.join(self.root, "ghost")])
        self.assertEqual(code, 3)
        self.assertNotIn("Traceback", err)

    def test_cli_unapproved_repo_root_exit3(self):
        other = os.path.join(self.root, "repo2")
        os.makedirs(other)
        code, out, err = self.run_main(["--plan", "tool-self-check",
                                        "--repo-root", other])
        self.assertEqual(code, 3)
        self.assertNotIn("Traceback", err)
        self.assertIn("approved", json.loads(out)["error"])

    def test_cli_registry_without_trusted_tools_exit3(self):
        path = os.path.join(self.tool_dir, verify.REGISTRY_NAME)
        with open(path, "r", encoding="utf-8") as fh:
            reg = json.load(fh)
        del reg["trusted_tools"]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(reg, fh, indent=2)
        code, out, err = self.run_main(["--plan", "tool-self-check",
                                        "--repo-root", self.repo])
        self.assertEqual(code, 3)
        self.assertNotIn("Traceback", err)

    def test_cli_hash_tighten_only_mismatch_exit3(self):
        code, out, err = self.run_main(["--plan", "tool-self-check",
                                        "--repo-root", self.repo,
                                        "--expect-plan-sha256", "0" * 64])
        self.assertEqual(code, 3)

    def test_cli_json_report_and_exit0(self):
        passed = reporting.make_check("cloud-dev-unittest", "cloud-dev-unittest",
                                      "verify", "passed", True,
                                      expected="exit 0 within 180s", observed="exit 0")
        with mock.patch.object(verify, "execute_plan", return_value=[passed]):
            code, out, err = self.run_main(["--plan", "tool-self-check",
                                            "--repo-root", self.repo])
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertEqual(parsed["tool"], "cloud-dev-verify")
        self.assertEqual(parsed["overall_status"], "pass")

    def test_cli_markdown(self):
        passed = reporting.make_check("cloud-dev-unittest", "cloud-dev-unittest",
                                      "verify", "passed", True,
                                      expected="exit 0 within 180s", observed="exit 0")
        with mock.patch.object(verify, "execute_plan", return_value=[passed]):
            code, out, err = self.run_main(["--plan", "tool-self-check",
                                            "--repo-root", self.repo,
                                            "--format", "markdown"])
        self.assertEqual(code, 0)
        self.assertIn("cloud-dev-verify report", out)


@unittest.skipUnless(os.name == "posix" and hasattr(os, "killpg"),
                     "real process-group boundary tests need POSIX")
class TsGuardOpenSpyTests(unittest.TestCase):
    """r3 item 2: composed TS guard -- no filesystem open before component
    verification. builtins.open is spied; the secret/aliased target must be
    opened ZERO times."""

    def setUp(self):
        self.root = temp_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo(self.root)

    def run_check(self, prereq_paths):
        step = {
            "id": "s", "argv": ["python3", "-c", "x"], "cwd": ".",
            "timeout_s": 30, "required": True, "capture": True,
            "depends_on": [], "prereq_paths": list(prereq_paths),
        }
        return verify.check_prereqs("smoke", self.repo, step, sys.executable)

    def spy_open(self, forbidden):
        """Patch builtins.open; any open of a forbidden target is recorded
        AND raised (so a leak fails loudly instead of silently passing)."""
        opens = []
        real_open = builtins.open

        def spy(file, *args, **kwargs):
            target = os.path.realpath(str(file))
            if target in forbidden:
                opens.append(target)
                raise AssertionError("forbidden open: %s" % file)
            return real_open(file, *args, **kwargs)

        return opens, mock.patch("builtins.open", spy)

    def _symlink(self, source, link):
        try:
            os.symlink(source, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available")
        if not os.path.lexists(link):
            # Some hosts fail silently instead of raising; never fake-pass.
            self.skipTest("symlink silently unavailable")

    def test_package_json_symlink_to_in_repo_env_never_opened(self):
        env_file = os.path.join(self.repo, "openbot", ".env")
        with open(env_file, "w", encoding="utf-8") as fh:
            fh.write('{"name": "typescript", "version": "5.9.3"}')
        pkg = os.path.join(self.repo, "openbot", "node_modules", "typescript",
                           "package.json")
        os.remove(pkg)
        self._symlink(env_file, pkg)
        opens, patcher = self.spy_open({os.path.realpath(env_file)})
        with patcher:
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/tsc"])
        self.assertEqual(opens, [])  # .env never opened
        self.assertTrue(any("package.json" in p for p in problems))

    def test_parent_directory_alias_never_opened(self):
        ts_real = os.path.join(self.repo, "openbot", ".env", "typescript")
        os.makedirs(os.path.join(ts_real, "bin"))
        with open(os.path.join(ts_real, "package.json"), "w",
                  encoding="utf-8") as fh:
            fh.write('{"name": "typescript", "version": "5.9.3"}')
        with open(os.path.join(ts_real, "bin", "tsc"), "w",
                  encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        ts_link = os.path.join(self.repo, "openbot", "node_modules", "typescript")
        shutil.rmtree(ts_link)
        self._symlink(ts_real, ts_link)
        forbidden = {
            os.path.realpath(os.path.join(ts_real, "package.json")),
            os.path.realpath(os.path.join(ts_real, "bin", "tsc")),
        }
        opens, patcher = self.spy_open(forbidden)
        with patcher:
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/tsc"])
        self.assertEqual(opens, [])
        self.assertTrue(any("layout" in p or "protected" in p for p in problems))

    def test_package_json_symlink_to_plain_json_never_opened(self):
        # r3-fix item 1 exact exploit: a non-secret plain JSON with correct
        # name/version behind a package.json symlink used to be opened and
        # accepted (realpath dissolved the link before islink could see it).
        # Now refused with ZERO opens.
        plain_dir = os.path.join(self.repo, "openbot", "fixtures")
        os.makedirs(plain_dir)
        meta = os.path.join(plain_dir, "metadata.json")
        with open(meta, "w", encoding="utf-8") as fh:
            fh.write('{"name": "typescript", "version": "5.9.3"}')
        pkg = os.path.join(self.repo, "openbot", "node_modules", "typescript",
                           "package.json")
        os.remove(pkg)
        self._symlink(meta, pkg)
        opens, patcher = self.spy_open({os.path.realpath(meta)})
        with patcher:
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/tsc"])
        self.assertEqual(opens, [])
        self.assertTrue(any("unapproved symlink" in p for p in problems))

    def test_parent_directory_alias_to_plain_dir_never_opened(self):
        # r3-fix item 1: node_modules/typescript -> an UNAPPROVED plain
        # in-repo directory (valid package.json + tsc inside) is not the
        # approved Bun-store shape: refused, ZERO opens.
        real_dir = os.path.join(self.repo, "openbot", "tools", "typescript-copy")
        os.makedirs(os.path.join(real_dir, "bin"))
        with open(os.path.join(real_dir, "package.json"), "w",
                  encoding="utf-8") as fh:
            fh.write('{"name": "typescript", "version": "5.9.3"}')
        with open(os.path.join(real_dir, "bin", "tsc"), "w",
                  encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        ts_link = os.path.join(self.repo, "openbot", "node_modules", "typescript")
        shutil.rmtree(ts_link)
        self._symlink(real_dir, ts_link)
        forbidden = {
            os.path.realpath(os.path.join(real_dir, "package.json")),
            os.path.realpath(os.path.join(real_dir, "bin", "tsc")),
        }
        opens, patcher = self.spy_open(forbidden)
        with patcher:
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/tsc"])
        self.assertEqual(opens, [])
        self.assertTrue(problems)

    def test_approved_bun_store_shape_passes(self):
        # Root-frozen single permitted alias (r3-fix item 1): a RELATIVE
        # node_modules/typescript link whose normalized target is exactly
        # node_modules/.bun/typescript@5.9.3/node_modules/typescript, with
        # plain bin/tsc + package.json inside the package root. Passes with
        # exactly one package.json read.
        store = os.path.join(self.repo, "openbot", "node_modules", ".bun",
                             "typescript@5.9.3", "node_modules", "typescript")
        os.makedirs(os.path.join(store, "bin"))
        with open(os.path.join(store, "package.json"), "w",
                  encoding="utf-8") as fh:
            fh.write('{"name": "typescript", "version": "5.9.3"}')
        with open(os.path.join(store, "bin", "tsc"), "w",
                  encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        ts_link = os.path.join(self.repo, "openbot", "node_modules", "typescript")
        shutil.rmtree(ts_link)
        self._symlink(os.path.relpath(store, os.path.dirname(ts_link)), ts_link)
        opens_count = []
        real_open = builtins.open

        def spy(file, *args, **kwargs):
            if os.path.basename(str(file)) == "package.json":
                opens_count.append(str(file))
            return real_open(file, *args, **kwargs)

        with mock.patch("builtins.open", spy):
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/tsc"])
        self.assertEqual(problems, [])
        self.assertEqual(len(opens_count), 1)

    def test_two_hop_alias_to_approved_target_refused(self):
        # r4 direct-target check (Root 51663785): typescript -> in-repo hop
        # -> approved Bun store. realpath(typescript) equals the canonical
        # root, so a realpath-only check passes; the RAW link target must
        # point directly at the canonical root. Both hops point at
        # legitimate content (valid name/version), yet the chain is refused
        # with ZERO opens.
        store = os.path.join(self.repo, "openbot", "node_modules", ".bun",
                             "typescript@5.9.3", "node_modules", "typescript")
        os.makedirs(os.path.join(store, "bin"))
        with open(os.path.join(store, "package.json"), "w",
                  encoding="utf-8") as fh:
            fh.write('{"name": "typescript", "version": "5.9.3"}')
        with open(os.path.join(store, "bin", "tsc"), "w",
                  encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        hop = os.path.join(self.repo, "openbot", "tools", "hop")
        os.makedirs(os.path.dirname(hop))
        self._symlink(store, hop)
        ts_link = os.path.join(self.repo, "openbot", "node_modules", "typescript")
        shutil.rmtree(ts_link)
        self._symlink(os.path.relpath(hop, os.path.dirname(ts_link)), ts_link)
        # Sanity: the two-hop chain really does land on the canonical root
        # through realpath (this is exactly the hole being closed).
        self.assertEqual(os.path.realpath(ts_link), os.path.realpath(store))
        forbidden = {
            os.path.realpath(os.path.join(store, "package.json")),
            os.path.realpath(os.path.join(store, "bin", "tsc")),
        }
        opens, patcher = self.spy_open(forbidden)
        with patcher:
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/tsc"])
        self.assertEqual(opens, [])
        self.assertTrue(any("not point directly" in p for p in problems))

    def test_no_read_once_problems_found(self):
        # tsc missing -> problem recorded, and the plan-level package.json
        # read is SKIPPED entirely (zero opens, r3 item 2).
        canonical = os.path.realpath(os.path.join(
            self.repo, "openbot", "node_modules", "typescript", "package.json"))
        opens, patcher = self.spy_open({canonical})
        with patcher:
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/missing"])
        self.assertTrue(any("missing" in p for p in problems))
        self.assertEqual(opens, [])

    def test_canonical_version_check_refuses_symlinked_package_json(self):
        env_file = os.path.join(self.repo, "openbot", ".env")
        with open(env_file, "w", encoding="utf-8") as fh:
            fh.write('{"name": "typescript", "version": "5.9.3"}')
        pkg = os.path.join(self.repo, "openbot", "node_modules", "typescript",
                           "package.json")
        os.remove(pkg)
        self._symlink(env_file, pkg)
        opens, patcher = self.spy_open({os.path.realpath(env_file)})
        with patcher:
            # No tsc prereq: exercises the plan-level canonical read path.
            problems = self.run_check([])
        self.assertEqual(opens, [])
        self.assertTrue(any("package.json" in p for p in problems))

    def test_normal_layout_reads_package_json_once(self):
        opens_count = []
        real_open = builtins.open

        def spy(file, *args, **kwargs):
            if os.path.basename(str(file)) == "package.json":
                opens_count.append(str(file))
            return real_open(file, *args, **kwargs)

        with mock.patch("builtins.open", spy):
            problems = self.run_check(
                ["openbot/node_modules/typescript/bin/tsc"])
        self.assertEqual(problems, [])
        self.assertEqual(len(opens_count), 1)  # same-package pin, one read


class DeadlineAccountingTests(unittest.TestCase):
    """r3 item 1: after the deadline every wait/join receives a non-positive
    timeout (non-blocking probe only). The budget is proven by the fake
    clock, not by summing timeout parameters."""

    @unittest.skipUnless(os.name == "posix", "killpg-based accounting")
    def test_no_positive_timeouts_after_expiry(self):
        clock = {"t": 1000.0}
        wait_calls = []
        join_calls = []

        class FakeReader:
            def __init__(self, stream):
                self.done = True
                self.eof = True
                self.error = None
                self.kept = 0
                self.discarded = 0

            def start(self):
                pass

            def join(self, timeout=None):
                join_calls.append(timeout)

            def text(self):
                return ""

        class FakeProc:
            # r3-fix item 2: real Popen(argv, **kwargs) call shape -- concrete
            # constructor and methods, NO all-absorbing Mock (state stays
            # consistent; the timeout path is the only way wait "fails").
            def __init__(self, argv, **kwargs):
                self.argv = list(argv)
                self.popen_kwargs = kwargs
                self.pid = 4711
                self.returncode = None
                self.stdout = io.BytesIO(b"")
                self.stderr = io.BytesIO(b"")
                self.poll_calls = []
                self.kill_calls = []

            def wait(self, timeout=None):
                wait_calls.append(timeout)
                clock["t"] += 999.0  # jump past the deadline
                raise subprocess.TimeoutExpired(
                    self.argv[0] if self.argv else "cmd", timeout)

            def poll(self):
                self.poll_calls.append(clock["t"])
                return self.returncode

            def kill(self):
                self.kill_calls.append(clock["t"])

        FakeProc.instances = []

        orig_init = FakeProc.__init__

        def recording_init(self, argv, **kwargs):
            orig_init(self, argv, **kwargs)
            FakeProc.instances.append(self)

        FakeProc.__init__ = recording_init

        def fake_monotonic():
            return clock["t"]

        with mock.patch.object(verify, "BoundedReader", FakeReader), \
                mock.patch.object(verify.subprocess, "Popen", FakeProc), \
                mock.patch.object(verify.time, "monotonic", fake_monotonic), \
                mock.patch.object(verify.os, "killpg", lambda pid, sig: None):
            result = verify.run_step_process(
                ["python3", "-c", "x"], tempfile.gettempdir(), 2.0, {})

        # Pre-expiry: the single bounded wait at run_until (deadline-reserve).
        self.assertEqual(wait_calls[0], 1.0)
        # Post-expiry: only non-blocking probes, never a positive timeout.
        for t in wait_calls[1:]:
            self.assertLessEqual(t, 0.0)
        for t in join_calls:
            self.assertLessEqual(t, 0.0)
        # Budget proven by the clock: run_step_process returned only after
        # the deadline passed.
        self.assertGreaterEqual(clock["t"], 1000.0 + 2.0)
        self.assertTrue(result["timed_out"])
        self.assertTrue(result["termination"]["termination_attempted"])
        # Real call shape reached the constructor (no TypeError): the exact
        # argv/kwargs landed, incl. start_new_session=True on POSIX.
        self.assertEqual(len(FakeProc.instances), 1)
        proc = FakeProc.instances[0]
        self.assertEqual(proc.argv, ["python3", "-c", "x"])
        if os.name == "posix":
            self.assertIs(proc.popen_kwargs.get("start_new_session"), True)
        # poll/kill exist and are callable against a consistent state.
        self.assertIs(proc.poll(), None)
        proc.kill()
        self.assertEqual(len(proc.kill_calls), 1)


class RealProcessBoundaryTests(unittest.TestCase):
    """r2 items 1+2: real Popen boundaries, single-deadline, controlled cleanup."""

    def run_proc(self, code, timeout_s):
        return verify.run_step_process([sys.executable, "-c", code],
                                       tempfile.gettempdir(), timeout_s,
                                       verify.build_safe_env())

    def test_normal_process(self):
        result = self.run_proc("print('ok')", 30)
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["stdout_done"])
        self.assertTrue(result["stdout_eof"])
        self.assertIsNone(result["stdout_error"])
        self.assertIn("ok", result["stdout"])
        self.assertFalse(result["termination"]["termination_attempted"])

    def test_posix_child_runs_in_own_group(self):
        # r2 item 1: start_new_session=True is always passed on POSIX, so the
        # child is its own process-group leader and killpg can never hit the
        # verify process group.
        result = self.run_proc("import os; print(os.getpid(), os.getpgid(0))", 30)
        self.assertEqual(result["exit_code"], 0)
        pid_s, pgid_s = result["stdout"].split()
        self.assertEqual(int(pid_s), int(pgid_s))
        self.assertNotEqual(int(pgid_s), os.getpgid(0))

    def test_large_output_is_bounded(self):
        result = self.run_proc("import sys; sys.stdout.write('x' * 200000)", 30)
        self.assertEqual(result["stdout_kept_bytes"], verify.CAPTURE_MAX_BYTES)
        self.assertEqual(result["stdout_discarded_bytes"],
                         200000 - verify.CAPTURE_MAX_BYTES)

    def test_bad_utf8_is_replaced_not_fatal(self):
        # Double backslashes: the child SOURCE stays pure ASCII and actually
        # writes 0xff/0xfe bytes (r2: no SyntaxError posing as a UTF-8 test).
        result = self.run_proc(
            "import sys; sys.stdout.buffer.write(b'\\xff\\xfe bad')", 30)
        self.assertEqual(result["exit_code"], 0)
        self.assertIn(u"\ufffd", result["stdout"])
        self.assertIn(" bad", result["stdout"])

    def test_parent_exit_descendant_holds_pipe_is_unverified(self):
        code = (
            "import subprocess, sys\n"
            "gc = subprocess.Popen([sys.executable, '-c', "
            "'import sys,time; sys.stdout.write(\"GC-READY\\\\n\"); "
            "sys.stdout.flush(); time.sleep(30)'],\n"
            "                     stdout=sys.stdout)\n"
            "print('GC-PID', gc.pid)\n"
            "print('parent-done')\n"
            "sys.exit(0)\n"
        )
        gc_pid = None
        started = time.monotonic()
        try:
            result = self.run_proc(code, 4)
            elapsed = time.monotonic() - started
            self.assertEqual(result["exit_code"], 0)
            self.assertTrue(result["termination"]["termination_attempted"])
            self.assertIsNone(result["termination"]["descendants_confirmed"])
            self.assertLess(elapsed, 4 + SCHED_SLACK_S)
            check = verify._result_check(
                {"id": "d", "timeout_s": 4, "required": True}, result, [])
            self.assertEqual(check["status"], "unverified")
            match = re.search(r"GC-PID (\d+)", result["stdout"])
            if match:
                gc_pid = int(match.group(1))
        finally:
            # Controlled cleanup: never rely on the 30s sleep expiring.
            if gc_pid:
                try:
                    os.kill(gc_pid, signal.SIGKILL)
                except OSError:
                    pass
        if gc_pid:
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                try:
                    os.kill(gc_pid, 0)
                except OSError:
                    break  # descendant gone
                time.sleep(0.05)
            else:
                self.fail("descendant survived past the cleanup budget")

    def test_timeout_kills_group_and_reaps_within_budget(self):
        started = time.monotonic()
        result = self.run_proc("import time; time.sleep(30)", 2)
        elapsed = time.monotonic() - started
        self.assertTrue(result["timed_out"])
        self.assertTrue(result["termination"]["termination_attempted"])
        self.assertTrue(result["termination"]["group_signal_confirmed"])
        self.assertTrue(result["termination"]["direct_child_reaped"])
        self.assertFalse(result["resources_unresolved"])
        # Single total budget: timeout 2s + small fixed scheduling slack.
        self.assertLess(elapsed, 2 + SCHED_SLACK_S)
        self.assertLess(result["duration_s"], 2 + SCHED_SLACK_S)


class MainBoundaryFailureTests(unittest.TestCase):
    """B2 r6: real main/default executor; inject only file/launch boundaries.

    Fixtures are local, non-secret files. Popen is always intercepted: none
    of these definitions launches a child or recursively executes a plan.
    These are test definitions, not evidence of a production registry grant.
    """

    def setUp(self):
        self.root = temp_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo(self.root)
        self.tool_dir = make_tool_dir(self.root, approved_roots=[self.repo])
        self.plan_path = os.path.join(
            self.tool_dir, verify.FROZEN_PLANS["tool-self-check"]["file"])
        self.registry_path = os.path.join(self.tool_dir, verify.REGISTRY_NAME)
        self.python_path = os.path.realpath(sys.executable)
        with open(self.python_path, "rb") as handle:
            body = handle.read()
        with open(self.registry_path, "r", encoding="utf-8") as handle:
            self.registry = json.load(handle)
        self.registry["trusted_tools"]["python3"] = {
            "path": self.python_path, "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        }
        self.write_registry()
        patcher = mock.patch.object(verify, "TOOL_DIR", self.tool_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_registry(self):
        with open(self.registry_path, "w", encoding="utf-8") as handle:
            json.dump(self.registry, handle)

    def main_json(self, expected_code, detail):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = verify.main(["--plan", "tool-self-check",
                                "--repo-root", self.repo, "--format", "json"])
        self.assertEqual(code, expected_code)
        self.assertEqual(err.getvalue(), "")
        self.assertNotIn("Traceback", out.getvalue())
        self.assertNotIn("B2R6_PRIVATE_OS_DETAIL", out.getvalue())
        report = json.loads(out.getvalue())
        self.assertEqual(report["schema_version"], "1.1")
        self.assertEqual(report["tool"], "cloud-dev-verify")
        self.assertEqual(report["exit_code"], expected_code)
        if expected_code == 3:
            self.assertNotIn("checks", report)
            self.assertIn(detail, report["error"])
        else:
            self.assertNotIn("error", report)
            self.assertEqual(report["overall_status"], "incomplete")
            self.assertEqual(report["summary"]["total"], 1)
            self.assertEqual(report["summary"]["blocked"], 1)
            self.assertEqual(report["summary"]["failed"], 0)
            self.assertEqual(len(report["checks"]), 1)
            check = report["checks"][0]
            self.assertEqual(check["check_id"], "cloud-dev-unittest")
            self.assertTrue(check["required"])
            self.assertEqual(check["status"], "blocked")
            self.assertIn(detail, check["details"])
        return report

    def assert_registry_rejected(self, detail):
        self.write_registry()
        with mock.patch.object(verify.subprocess, "Popen",
                               side_effect=AssertionError("unexpected child launch")) as spawn:
            self.main_json(3, detail)
        spawn.assert_not_called()

    def faulting_open(self, target, error_type, during_read=False):
        calls = []
        real_open = builtins.open

        class ReadFailure:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, *args):
                raise error_type("B2R6_PRIVATE_OS_DETAIL")

        def open_boundary(file, mode="r", *args, **kwargs):
            if os.fspath(file) == target and mode == "rb":
                calls.append(target)
                if during_read:
                    return ReadFailure()
                raise error_type("B2R6_PRIVATE_OS_DETAIL")
            return real_open(file, mode, *args, **kwargs)

        return calls, mock.patch("builtins.open", open_boundary)

    def test_main_accepts_exact_64hex_without_trimming(self):
        # Real registry validation/binding reaches the actual Popen boundary.
        # Launch is deliberately refused here; this is not an execution pass.
        with mock.patch.object(verify.subprocess, "Popen",
                               side_effect=PermissionError("B2R6_PRIVATE_OS_DETAIL")) as spawn:
            self.main_json(2, "Popen failed before child acquisition (PermissionError)")
        spawn.assert_called_once()
        self.assertEqual(spawn.call_args.args[0][0], self.python_path)
        self.assertEqual(spawn.call_args.kwargs["cwd"], os.path.realpath(self.repo))

    def test_main_rejects_python_digest_trailing_lf_exit3(self):
        self.registry["trusted_tools"]["python3"]["sha256"] += "\n"
        self.assert_registry_rejected("trusted_tools sha256 must be 64-hex")

    def test_main_rejects_unused_bun_digest_trailing_lf_exit3(self):
        # Unused mapping makes this discriminate registry validation from a
        # later selected-tool hash mismatch (which would merely be blocked).
        self.registry["trusted_tools"]["bun"]["sha256"] += "\n"
        self.assert_registry_rejected("trusted_tools sha256 must be 64-hex")

    def test_main_rejects_unused_plan_digest_trailing_lf_exit3(self):
        # A selected-plan hash mismatch is already exit3 in the old source;
        # the unused smoke entry specifically exercises whole-registry shape.
        self.registry["plans"]["smoke"]["plan_sha256"] += "\n"
        self.assert_registry_rejected("registry plan_sha256 must be 64-hex")

    def test_main_plan_open_os_errors_exit3_no_spawn(self):
        for error_type in (PermissionError, OSError):
            with self.subTest(error=error_type.__name__):
                calls, boundary = self.faulting_open(self.plan_path, error_type)
                with boundary, mock.patch.object(
                        verify.subprocess, "Popen",
                        side_effect=AssertionError("unexpected child launch")) as spawn:
                    self.main_json(3, "plan file unreadable:")
                self.assertEqual(calls, [self.plan_path])
                spawn.assert_not_called()

    def test_main_plan_read_os_errors_exit3_no_spawn(self):
        for error_type in (PermissionError, OSError):
            with self.subTest(error=error_type.__name__):
                calls, boundary = self.faulting_open(
                    self.plan_path, error_type, during_read=True)
                with boundary, mock.patch.object(
                        verify.subprocess, "Popen",
                        side_effect=AssertionError("unexpected child launch")) as spawn:
                    self.main_json(3, "plan file unreadable:")
                self.assertEqual(calls, [self.plan_path])
                spawn.assert_not_called()

    def test_main_mapped_tool_stat_os_errors_blocked2_no_spawn(self):
        real_getsize = os.path.getsize
        for error_type in (PermissionError, OSError):
            calls = []

            def stat_boundary(path):
                if os.fspath(path) == self.python_path:
                    calls.append(path)
                    raise error_type("B2R6_PRIVATE_OS_DETAIL")
                return real_getsize(path)

            with self.subTest(error=error_type.__name__):
                with mock.patch.object(verify.os.path, "getsize", stat_boundary), \
                        mock.patch.object(verify.subprocess, "Popen",
                                          side_effect=AssertionError("unexpected child launch")) as spawn:
                    self.main_json(2, "prerequisite-executable-missing: python3")
                self.assertEqual(calls, [self.python_path])
                spawn.assert_not_called()

    def test_main_mapped_tool_hash_open_os_errors_blocked2_no_spawn(self):
        for error_type in (PermissionError, OSError):
            with self.subTest(error=error_type.__name__):
                calls, boundary = self.faulting_open(self.python_path, error_type)
                with boundary, mock.patch.object(
                        verify.subprocess, "Popen",
                        side_effect=AssertionError("unexpected child launch")) as spawn:
                    self.main_json(2, "prerequisite-executable-missing: python3")
                self.assertEqual(calls, [self.python_path])
                spawn.assert_not_called()

    def test_main_mapped_tool_hash_read_os_errors_blocked2_no_spawn(self):
        for error_type in (PermissionError, OSError):
            with self.subTest(error=error_type.__name__):
                calls, boundary = self.faulting_open(
                    self.python_path, error_type, during_read=True)
                with boundary, mock.patch.object(
                        verify.subprocess, "Popen",
                        side_effect=AssertionError("unexpected child launch")) as spawn:
                    self.main_json(2, "prerequisite-executable-missing: python3")
                self.assertEqual(calls, [self.python_path])
                spawn.assert_not_called()

    def test_main_popen_os_errors_blocked2_one_attempt_no_retry(self):
        for error_type in (PermissionError, OSError):
            with self.subTest(error=error_type.__name__):
                with mock.patch.object(verify.subprocess, "Popen",
                                       side_effect=error_type("B2R6_PRIVATE_OS_DETAIL")) as spawn:
                    self.main_json(2, "Popen failed before child acquisition (%s)"
                                   % error_type.__name__)
                spawn.assert_called_once()
                self.assertEqual(spawn.call_args.args[0][0], self.python_path)


if __name__ == "__main__":
    unittest.main()
