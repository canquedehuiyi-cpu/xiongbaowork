import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import doctor


class FakeProc(object):
    def __init__(self, returncode, stdout):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


class FakeProber(doctor.Prober):
    """name -> behavior.

    Behaviors: ("missing",), ("ok", version), ("exit", rc, out), ("timeout",).
    Unknown probe names default to ("ok", "0.0.0-fake") so optional runtimes pass.
    """

    def __init__(self, behaviors=None):
        self.behaviors = dict(behaviors or {})

    def find(self, name):
        behavior = self.behaviors.get(name)
        if behavior and behavior[0] == "missing":
            return None
        return "/fake/bin/" + name

    def run(self, argv, timeout=doctor.PROBE_TIMEOUT_S, executable=None):
        behavior = self.behaviors.get(argv[0], ("ok", "0.0.0-fake"))
        if behavior[0] == "timeout":
            raise subprocess.TimeoutExpired(list(argv), timeout)
        if behavior[0] == "exit":
            return FakeProc(behavior[1], behavior[2])
        return FakeProc(0, behavior[1] + "\n")


LOCK_BYTES = b"# cloud-dev fixture lock\n"


def make_fixture(package_manager="bun@1.3.14", root_package_json=False,
                 ts_version=None, git_branch=None, git_commit=None):
    root = tempfile.mkdtemp(prefix="cloud-dev-doctor-fixture-")
    openbot = os.path.join(root, "openbot")
    os.makedirs(openbot)
    with open(os.path.join(openbot, "package.json"), "w", encoding="utf-8") as handle:
        json.dump({"name": "openbot", "private": True,
                   "packageManager": package_manager}, handle)
    with open(os.path.join(openbot, "bun.lock"), "wb") as handle:
        handle.write(LOCK_BYTES)
    doctor.PINNED["bun_lock_size"] = len(LOCK_BYTES)
    doctor.PINNED["bun_lock_sha256"] = hashlib.sha256(LOCK_BYTES).hexdigest()
    if root_package_json:
        with open(os.path.join(root, "package.json"), "w", encoding="utf-8") as handle:
            handle.write("{}")
    if ts_version is not None:
        ts_dir = os.path.join(openbot, "node_modules", "typescript")
        os.makedirs(ts_dir)
        with open(os.path.join(ts_dir, "package.json"), "w", encoding="utf-8") as handle:
            json.dump({"name": "typescript", "version": ts_version}, handle)
    if git_branch is not None:
        git_dir = os.path.join(root, ".git")
        os.makedirs(os.path.join(git_dir, os.path.dirname(git_branch)))
        with open(os.path.join(git_dir, "HEAD"), "w", encoding="utf-8") as handle:
            handle.write("ref: %s\n" % git_branch)
        with open(os.path.join(git_dir, *git_branch.split("/")), "w", encoding="utf-8") as handle:
            handle.write(git_commit + "\n")
    return root


class PinGuard(unittest.TestCase):
    """Fixture helpers mutate doctor.PINNED; restore module state after each test."""

    def setUp(self):
        self._environment = mock.patch.dict(os.environ, {"PATH": "", "LANG": "C.UTF-8"}, clear=True)
        self._environment.start()
        self.addCleanup(self._environment.stop)
        self._pinned_backup = dict(doctor.PINNED)

    def tearDown(self):
        doctor.PINNED.clear()
        doctor.PINNED.update(self._pinned_backup)


class DoctorReportTests(PinGuard):
    def report_for(self, behaviors=None, **kwargs):
        root = make_fixture(**kwargs)
        self.addCleanup(shutil.rmtree, root, True)
        return root, doctor.build_report(root, prober=FakeProber(behaviors))

    def by_id(self, report):
        return dict((c["check_id"], c) for c in report["checks"])

    def test_happy_path_exit0_optional_incomplete_is_pass(self):
        behaviors = {"bun": ("ok", "1.3.14"), "git": ("ok", "git version 2.40.0")}
        root, report = self.report_for(behaviors=behaviors)
        self.assertEqual(report["exit_code"], 0)
        self.assertEqual(report["overall_status"], "pass")
        statuses = self.by_id(report)
        self.assertEqual(statuses["runtime_bun"]["status"], "passed")
        self.assertEqual(statuses["bun_lock_identity"]["status"], "passed")
        self.assertEqual(statuses["package_manager_declaration"]["status"], "passed")
        self.assertEqual(statuses["repo_layout_root_package_json_absent"]["status"], "passed")
        self.assertEqual(statuses["typescript_dependency"]["status"], "blocked")
        self.assertFalse(statuses["typescript_dependency"]["required"])
        self.assertEqual(statuses["git_identity"]["status"], "skipped")

    def test_missing_required_bun_is_blocked_exit2(self):
        root, report = self.report_for(behaviors={"bun": ("missing",)})
        self.assertEqual(report["exit_code"], 2)
        self.assertEqual(report["overall_status"], "incomplete")
        bun = self.by_id(report)["runtime_bun"]
        self.assertEqual(bun["status"], "blocked")
        self.assertTrue(bun["required"])

    def test_bun_version_mismatch_is_failed_exit1(self):
        root, report = self.report_for(behaviors={"bun": ("ok", "1.2.9")})
        self.assertEqual(report["exit_code"], 1)
        bun = self.by_id(report)["runtime_bun"]
        self.assertEqual(bun["status"], "failed")
        self.assertEqual(bun["observed"], "1.2.9")

    def test_bun_timeout_is_failed_exit1(self):
        root, report = self.report_for(behaviors={"bun": ("timeout",)})
        self.assertEqual(report["exit_code"], 1)
        self.assertEqual(self.by_id(report)["runtime_bun"]["status"], "failed")

    def test_bun_probe_nonzero_exit_is_failed(self):
        root, report = self.report_for(behaviors={"bun": ("exit", 3, "boom")})
        self.assertEqual(report["exit_code"], 1)
        bun = self.by_id(report)["runtime_bun"]
        self.assertEqual(bun["status"], "failed")
        self.assertEqual(bun["observed"], "exit 3")

    def test_root_package_json_is_failure(self):
        root, report = self.report_for(root_package_json=True)
        self.assertEqual(report["exit_code"], 1)
        self.assertEqual(self.by_id(report)["repo_layout_root_package_json_absent"]["status"], "failed")

    def test_package_manager_mismatch_is_failure(self):
        root, report = self.report_for(package_manager="bun@1.2.0")
        self.assertEqual(report["exit_code"], 1)
        self.assertEqual(self.by_id(report)["package_manager_declaration"]["status"], "failed")

    def test_typescript_version_mismatch_is_failure(self):
        root, report = self.report_for(ts_version="5.9.2")
        self.assertEqual(report["exit_code"], 1)
        self.assertEqual(self.by_id(report)["typescript_dependency"]["status"], "failed")

    def test_typescript_present_and_matching_passes(self):
        root, report = self.report_for(ts_version="5.9.3")
        self.assertEqual(self.by_id(report)["typescript_dependency"]["status"], "passed")

    def test_git_head_identity_is_read(self):
        commit = "9ba4ea9fae4b994425a49c3e6eec9ddc0d156e05"
        root, report = self.report_for(git_branch="refs/heads/main", git_commit=commit)
        self.assertEqual(self.by_id(report)["git_identity"]["status"], "passed")
        self.assertEqual(report["identity"]["git"]["commit"], commit)
        self.assertEqual(report["identity"]["git"]["branch"], "refs/heads/main")

    def test_identity_pins_are_expected_not_observed(self):
        commit = "9ba4ea9fae4b994425a49c3e6eec9ddc0d156e05"
        root, report = self.report_for(git_branch="refs/heads/main", git_commit=commit)
        base = report["baseline_identity"]
        self.assertEqual(base["expected"]["source_tree_sha256"],
                         doctor.PINNED["source_tree_sha256"])
        self.assertEqual(base["expected"]["workspace_synth_commit"],
                         doctor.PINNED["workspace_synth_commit"])
        self.assertIsNone(base["observed"]["source_tree_sha256"])
        self.assertEqual(base["observed"]["git_commit"], commit)
        self.assertEqual(base["observed"]["git_branch"], "refs/heads/main")
        self.assertEqual(base["status"], "unverified")
        cand = report["candidate_identity"]
        self.assertIsNone(cand["expected"])
        self.assertEqual(cand["observed"]["git_commit"], commit)
        self.assertIn("real_cwd", report["identity"])

    def test_doctor_writes_nothing_in_repo(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)

        def snapshot():
            state = {}
            for dirpath, _dirnames, filenames in os.walk(root):
                for name in filenames:
                    path = os.path.join(dirpath, name)
                    state[path] = os.stat(path).st_mtime_ns
            return state

        before = snapshot()
        doctor.build_report(root, prober=FakeProber({"bun": ("ok", "1.3.14")}))
        self.assertEqual(snapshot(), before)

    def test_env_scan_reports_names_only(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        env = {"BUN_FIXTURE_SECRET_NAME": "SUPER_SECRET_VALUE"}
        with mock.patch.dict(os.environ, env):
            report = doctor.build_report(root, prober=FakeProber())
        blob = json.dumps(self.by_id(report)["env_var_names"], ensure_ascii=False)
        self.assertNotIn("SUPER_SECRET_VALUE", blob)
        self.assertIn("BUN_FIXTURE_SECRET_NAME", blob)

    def test_invalid_repo_root_raises(self):
        bogus = os.path.join(tempfile.gettempdir(), "no-such-dir-ww-b1")
        with self.assertRaises(doctor.InvalidArguments):
            doctor.validate_repo_root(bogus)

    def test_probe_name_unknown_rejected(self):
        with self.assertRaises(KeyError):
            doctor.build_probe("bun; rm -rf /")

    def test_probe_argv_are_constant_version_pairs(self):
        for name in doctor.RUNTIME_PROBES:
            argv = doctor.build_probe(name)
            self.assertEqual(argv, tuple(doctor.RUNTIME_PROBES[name]["argv"]))
            self.assertEqual(len(argv), 2)
            self.assertEqual(argv[1], "--version")

    def test_read_allowlist_blocks_escape(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        with self.assertRaises(doctor.PathNotAllowed):
            doctor.resolve_read(root, "../../etc/passwd")
        with self.assertRaises(doctor.PathNotAllowed):
            doctor.resolve_read(root, "openbot/../server/secrets.json")

    def test_allowlist_symlink_escape_is_refused(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        outside_dir = tempfile.mkdtemp(prefix="cloud-dev-outside-lock-")
        self.addCleanup(shutil.rmtree, outside_dir, True)
        outside = os.path.join(outside_dir, "outside.lock")
        with open(outside, "wb") as handle:
            handle.write(b"outside-bytes")
        lock = os.path.join(root, "openbot", "bun.lock")
        os.remove(lock)
        try:
            os.symlink(outside, lock)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available on this platform/account")
        with self.assertRaises(doctor.PathNotAllowed):
            doctor.resolve_read(root, "openbot/bun.lock")
        report = doctor.build_report(root, prober=FakeProber({"bun": ("ok", "1.3.14")}))
        bun_lock = self.by_id(report)["bun_lock_identity"]
        self.assertEqual(bun_lock["status"], "failed")
        self.assertEqual(bun_lock["observed"], "path-not-allowed")
        self.assertIn("bun_lock_identity", doctor.reporting.render_markdown(report))


class GitGuardTests(PinGuard):
    """Root review item 2: git metadata reads are bounded and validated."""

    def root_with_git_dir(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        os.makedirs(os.path.join(root, ".git"))
        return root

    def test_ref_traversal_rejected(self):
        root = self.root_with_git_dir()
        outside_dir = tempfile.mkdtemp(prefix="cloud-dev-outside-git-")
        self.addCleanup(shutil.rmtree, outside_dir, True)
        with open(os.path.join(outside_dir, "evil"), "w", encoding="utf-8") as handle:
            handle.write("a" * 40 + "\n")
        with open(os.path.join(root, ".git", "HEAD"), "w", encoding="utf-8") as handle:
            handle.write("ref: refs/heads/../../%s/evil\n" % os.path.basename(outside_dir))
        head = doctor.read_git_head(root)
        self.assertIsNotNone(head)
        self.assertIsNone(head.get("commit"))
        self.assertTrue(head.get("malformed_ref"))
        report = doctor.build_report(root, prober=FakeProber())
        git_check = dict((c["check_id"], c) for c in report["checks"])["git_identity"]
        self.assertEqual(git_check["status"], "unverified")

    def test_gitdir_escape_not_read(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        with open(os.path.join(root, ".git"), "w", encoding="utf-8") as handle:
            handle.write("gitdir: ../../outside/.git\n")
        head = doctor.read_git_head(root)
        self.assertIsNotNone(head)
        self.assertTrue(head.get("external_metadata_root"))
        report = doctor.build_report(root, prober=FakeProber())
        git_check = dict((c["check_id"], c) for c in report["checks"])["git_identity"]
        self.assertEqual(git_check["status"], "unverified")
        self.assertIn("external worktree", git_check["observed"])

    def test_git_dir_symlink_out_is_not_read(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        outside_dir = tempfile.mkdtemp(prefix="cloud-dev-outside-gitdir-")
        self.addCleanup(shutil.rmtree, outside_dir, True)
        try:
            os.symlink(outside_dir, os.path.join(root, ".git"))
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available on this platform/account")
        head = doctor.read_git_head(root)
        self.assertIsNotNone(head)
        self.assertTrue(head.get("external_metadata_root"))

    def test_head_symlink_out_is_not_read(self):
        root = self.root_with_git_dir()
        outside_dir = tempfile.mkdtemp(prefix="cloud-dev-outside-head-")
        self.addCleanup(shutil.rmtree, outside_dir, True)
        with open(os.path.join(outside_dir, "HEAD"), "w", encoding="utf-8") as handle:
            handle.write("c" * 40 + "\n")
        try:
            os.symlink(os.path.join(outside_dir, "HEAD"),
                       os.path.join(root, ".git", "HEAD"))
        except (OSError, NotImplementedError):
            self.skipTest("symlink not available on this platform/account")
        head = doctor.read_git_head(root)
        self.assertTrue(head is None or head.get("commit") is None)

    def test_head_must_be_hex_or_valid_ref(self):
        root = self.root_with_git_dir()
        with open(os.path.join(root, ".git", "HEAD"), "w", encoding="utf-8") as handle:
            handle.write("not-a-commit\n")
        head = doctor.read_git_head(root)
        self.assertIsNone(head.get("commit"))
        self.assertTrue(head.get("malformed_head"))

    def test_head_accepts_sha256_style_64hex(self):
        root = self.root_with_git_dir()
        commit64 = "b" * 64
        with open(os.path.join(root, ".git", "HEAD"), "w", encoding="utf-8") as handle:
            handle.write(commit64 + "\n")
        head = doctor.read_git_head(root)
        self.assertEqual(head.get("commit"), commit64)

    def test_ref_file_non_hex_content_rejected(self):
        root = self.root_with_git_dir()
        with open(os.path.join(root, ".git", "HEAD"), "w", encoding="utf-8") as handle:
            handle.write("ref: refs/heads/main\n")
        heads_dir = os.path.join(root, ".git", "refs", "heads")
        os.makedirs(heads_dir)
        with open(os.path.join(heads_dir, "main"), "w", encoding="utf-8") as handle:
            handle.write("../../etc/passwd\n")
        head = doctor.read_git_head(root)
        self.assertIsNone(head.get("commit"))


class ProberSafetyTests(unittest.TestCase):
    """Root review item 3: inspect the REAL subprocess call kwargs —
    resolved absolute executable, shell=False, minimal non-secret env.
    No FakeProber is involved on this boundary."""

    def test_run_uses_resolved_path_fixed_env_and_shell_false(self):
        prober = doctor.Prober()
        captured = {}

        def fake_run(*args, **kwargs):
            captured["argv"] = args[0]
            captured["kwargs"] = kwargs
            return FakeProc(0, "1.3.14\n")

        secret_env = {
            "EVIL_SECRET": "must-not-leak",
            "NODE_OPTIONS": "--experimental-inject",
            "BUN_OPTIONS": "--inject",
            "PYTHONSTARTUP": "evil.py",
            "LD_PRELOAD": "evil.so",
        }
        with mock.patch.object(doctor.subprocess, "run", side_effect=fake_run):
            with mock.patch.dict(os.environ, secret_env):
                with mock.patch.object(doctor, "_trusted_executable", return_value=True):
                    with mock.patch.object(doctor.shutil, "which", side_effect=AssertionError("no second lookup")):
                        prober.run(("bun", "--version"), executable="/usr/bin/bun")
        self.assertEqual(captured["argv"][0], "/usr/bin/bun")
        self.assertEqual(captured["argv"][1:], ["--version"])
        kwargs = captured["kwargs"]
        self.assertIs(kwargs["shell"], False)
        env = kwargs["env"]
        self.assertIn("PATH", env)
        for name in ("EVIL_SECRET", "NODE_OPTIONS", "BUN_OPTIONS",
                     "PYTHONSTARTUP", "LD_PRELOAD"):
            self.assertNotIn(name, env)

    def test_probe_safe_env_keeps_platform_essentials_only(self):
        env = {"PATH": "/bin", "SYSTEMROOT": "C:/Windows",
               "HTTP_PROXY": "http://proxy:1", "MY_TOKEN": "secret",
               "NODE_OPTIONS": "x", "PYTHONPATH": "y"}
        safe = doctor.probe_safe_env(env)
        for key in ("PATH", "SYSTEMROOT", "HTTP_PROXY"):
            self.assertIn(key, safe)
        for key in ("MY_TOKEN", "NODE_OPTIONS", "PYTHONPATH"):
            self.assertNotIn(key, safe)
        self.assertEqual(set(safe), set(["PATH", "SYSTEMROOT", "HTTP_PROXY"]))


class DoctorCliTests(PinGuard):
    """Controlled CLI validation: probes are injected; stdlib-only, no Bun,
    no real PATH, no network (Root review item 1)."""

    def test_cli_json_output_and_exit_code(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = doctor.main(["--repo-root", root, "--format", "json"],
                               prober=FakeProber({"bun": ("ok", "1.3.14")}))
        self.assertEqual(code, 0)
        parsed = json.loads(buffer.getvalue())
        self.assertEqual(parsed["tool"], "cloud-dev-doctor")
        self.assertEqual(parsed["exit_code"], 0)
        self.assertEqual(parsed["overall_status"], "pass")

    def test_cli_invalid_repo_root_exit3(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = doctor.main(["--repo-root", os.path.join(
                tempfile.gettempdir(), "no-such-dir-ww-b1"), "--format", "json"])
        self.assertEqual(code, 3)
        parsed = json.loads(buffer.getvalue())
        self.assertEqual(parsed["exit_code"], 3)

    def test_cli_markdown_output(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = doctor.main(["--repo-root", root, "--format", "markdown"],
                               prober=FakeProber({"bun": ("ok", "1.3.14")}))
        self.assertEqual(code, 0)
        self.assertIn("cloud-dev-doctor report", buffer.getvalue())

    def test_cli_unknown_flag_exit3_no_traceback(self):
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with contextlib.redirect_stderr(err):
                code = doctor.main(["--no-such-flag"])
        self.assertEqual(code, 3)
        self.assertNotIn("Traceback", err.getvalue())
        parsed = json.loads(out.getvalue())
        self.assertEqual(parsed["exit_code"], 3)

    def test_cli_bad_format_exit3_no_traceback(self):
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with contextlib.redirect_stderr(err):
                code = doctor.main(["--format", "xml"])
        self.assertEqual(code, 3)
        self.assertNotIn("Traceback", err.getvalue())
        parsed = json.loads(out.getvalue())
        self.assertEqual(parsed["exit_code"], 3)


class CodexBoundaryRegressionTests(PinGuard):
    def fixture(self):
        root = make_fixture()
        self.addCleanup(shutil.rmtree, root, True)
        return root

    def test_json_object_shapes_do_not_crash(self):
        for value in (None, [], "text", 7, True):
            root = self.fixture()
            for rel, call in (("openbot/package.json", doctor.check_package_manager),
                              ("openbot/node_modules/typescript/package.json", doctor.check_typescript_dependency)):
                path = os.path.join(root, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump(value, handle)
                self.assertEqual(call(root)["status"], "failed")

    def test_invalid_utf8_git_metadata_never_crashes(self):
        for rel in ("HEAD", "refs/heads/main", "packed-refs"):
            root = self.fixture()
            git = os.path.join(root, ".git")
            os.makedirs(git)
            with open(os.path.join(git, "HEAD"), "w", encoding="utf-8") as handle:
                handle.write("ref: refs/heads/main\n")
            path = os.path.join(git, *rel.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(b"\xff")
            result = doctor.check_git_identity(root)
            self.assertEqual(result["status"], "unverified")

    def test_in_repository_package_and_lock_secret_aliases_refused(self):
        root = self.fixture()
        secret = os.path.join(root, ".env")
        with open(secret, "w", encoding="utf-8") as handle:
            handle.write("fixture sentinel only")
        for rel in ("openbot/package.json", "openbot/bun.lock"):
            path = os.path.join(root, rel)
            os.remove(path)
            os.symlink(secret, path)
            with self.assertRaises(doctor.PathNotAllowed):
                doctor.resolve_read(root, rel)

    def test_gitfile_dot_and_ref_alias_are_unverified(self):
        root = self.fixture()
        git = os.path.join(root, ".git")
        with open(git, "w", encoding="utf-8") as handle:
            handle.write("gitdir: .\n")
        self.assertTrue(doctor.read_git_head(root)["metadata_refused"])
        os.remove(git)
        os.makedirs(os.path.join(git, "refs", "heads"))
        with open(os.path.join(git, "HEAD"), "w", encoding="utf-8") as handle:
            handle.write("ref: refs/heads/main\n")
        with open(os.path.join(git, "config"), "w", encoding="utf-8") as handle:
            handle.write("a" * 40 + "\n")
        os.symlink(os.path.join(git, "config"), os.path.join(git, "refs", "heads", "main"))
        self.assertIsNone(doctor.read_git_head(root)["commit"])

    def test_missing_trusted_probe_never_spawns_or_uses_relative_path(self):
        with mock.patch.object(doctor, "TRUSTED_PROBE_DIRS", ()):
            with mock.patch.object(doctor.subprocess, "run", side_effect=AssertionError("must not spawn")):
                self.assertEqual(doctor.probe_runtime("bun", doctor.Prober())["status"], "blocked")
                with self.assertRaises(OSError):
                    doctor.Prober().run(("bun", "--version"), executable="relative/bun")

    def test_home_absence_is_informational(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            check = doctor.check_env_names()
        self.assertEqual(check["status"], "passed")
        self.assertFalse(check["required"])

    def test_fresh_real_cli_import_writes_neither_tooldir_nor_repo(self):
        root = self.fixture()
        tooldir = tempfile.mkdtemp(prefix="cloud-dev-isolated-tool-")
        self.addCleanup(shutil.rmtree, tooldir, True)
        source = os.path.dirname(doctor.__file__)
        for name in ("doctor.py", "reporting.py"):
            shutil.copyfile(os.path.join(source, name), os.path.join(tooldir, name))
        def snapshot(directory):
            return {os.path.relpath(os.path.join(base, name), directory):
                    doctor.sha256_file(os.path.join(base, name))
                    for base, dirs, files in os.walk(directory) for name in files}
        before_tool, before_root = snapshot(tooldir), snapshot(root)
        # Real script entry; invalid invocation exits before any runtime probe.
        # No -B/PYTHONDONTWRITEBYTECODE can mask a missing in-tool protection.
        proc = subprocess.run([sys.executable, os.path.join(tooldir, "doctor.py"), "--no-such-flag"],
                              cwd=root, env={"PATH": "", "LANG": "C.UTF-8"},
                              capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(json.loads(proc.stdout)["exit_code"], 3)
        self.assertNotIn("Traceback", proc.stderr)
        self.assertEqual(snapshot(tooldir), before_tool)
        self.assertEqual(snapshot(root), before_root)


class ProbeOutputRegressionTests(PinGuard):
    def call_with_result(self, result=None, error=None):
        with mock.patch.object(doctor.Prober, "find", return_value="/usr/bin/bun"):
            with mock.patch.object(doctor, "_trusted_executable", return_value=True):
                with mock.patch.object(doctor.subprocess, "run", return_value=result,
                                       side_effect=error) as run:
                    check = doctor.probe_runtime("bun", doctor.Prober())
        self.assertEqual(run.call_count, 1)
        return check

    def test_subprocess_text_decode_failure_is_failed_not_pass(self):
        error = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "fixture invalid byte")
        check = self.call_with_result(error=error)
        self.assertEqual(check["status"], "failed")
        self.assertEqual(doctor.reporting.compute_exit_code([check]), 1)
        self.assertNotIn("fixture invalid byte", json.dumps(check))

    def test_non_string_stdout_is_unverified_without_value_echo(self):
        for value in (None, b"fixture secret", 17, ["fixture secret"], {"key": "fixture secret"}):
            check = self.call_with_result(FakeProc(0, value))
            self.assertEqual(check["status"], "unverified")
            self.assertEqual(doctor.reporting.compute_exit_code([check]), 2)
            self.assertNotIn("fixture secret", json.dumps(check))

    def test_nonzero_exit_still_fails_with_non_string_stdout(self):
        check = self.call_with_result(FakeProc(7, {"secret": "fixture secret"}))
        self.assertEqual(check["status"], "failed")
        self.assertEqual(doctor.reporting.compute_exit_code([check]), 1)
        self.assertNotIn("fixture secret", json.dumps(check))


if __name__ == "__main__":
    unittest.main()
