import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

import updater_git
from updater_git import (
    DEFAULT_FETCH_ATTEMPTS,
    DEFAULT_GIT_TIMEOUT_SECONDS,
    GitRepository,
    GitSafetyError,
    LocalProcessLock,
    ScratchClone,
    _default_runner,
    cleanup_stale_scratch_clones,
)


def run_git(cwd, *args):
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"},
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return result


class RepositoryFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.remote = self.root / "remote.git"
        self.checkout = self.root / "checkout"
        self.runtime = self.root / "runtime"
        self.checkout.mkdir()
        run_git(self.root, "init", "--bare", str(self.remote))
        run_git(self.checkout, "init")
        run_git(self.checkout, "checkout", "-b", "main")
        run_git(self.checkout, "config", "user.name", "KMEM Test")
        run_git(self.checkout, "config", "user.email", "kmem-test@example.invalid")
        (self.checkout / "index.html").write_text("board\n", encoding="utf-8")
        (self.checkout / "update_weather_local.py").write_text("# updater\n", encoding="utf-8")
        run_git(self.checkout, "add", "--", "index.html", "update_weather_local.py")
        run_git(self.checkout, "commit", "-m", "initial")
        run_git(self.checkout, "remote", "add", "origin", str(self.remote))
        run_git(self.checkout, "push", "-u", "origin", "main")
        self.repo = GitRepository(self.checkout, fetch_attempts=1)

    def tearDown(self):
        self.temporary.cleanup()


class GitRunnerHardeningTests(unittest.TestCase):
    def test_default_runner_forces_noninteractive_environment_and_timeout(self):
        completed = subprocess.CompletedProcess(["git", "status"], 0, "", "")
        with mock.patch("updater_git.subprocess.run", return_value=completed) as run:
            result = _default_runner(
                ["git", "status"],
                cwd=Path.cwd(),
                env={"CUSTOM_VALUE": "preserved", "GIT_TERMINAL_PROMPT": "1"},
            )

        self.assertIs(result, completed)
        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs["timeout"], DEFAULT_GIT_TIMEOUT_SECONDS)
        self.assertEqual(kwargs["env"]["CUSTOM_VALUE"], "preserved")
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(kwargs["env"]["GCM_INTERACTIVE"], "Never")
        if os.name == "nt":
            self.assertEqual(
                kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW,
                subprocess.CREATE_NO_WINDOW,
            )
        else:
            self.assertNotIn("creationflags", kwargs)

    def test_timeout_has_stable_checked_and_unchecked_results(self):
        def timeout_runner(command, *, cwd, env=None):
            raise subprocess.TimeoutExpired(command, DEFAULT_GIT_TIMEOUT_SECONDS)

        repo = GitRepository(Path.cwd(), runner=timeout_runner, fetch_attempts=1)
        with self.assertRaises(GitSafetyError) as raised:
            repo.run(["status"])
        self.assertEqual(raised.exception.code, "GIT_TIMEOUT")

        unchecked = repo.run(["status"], check=False)
        self.assertEqual(unchecked.returncode, 124)
        self.assertIn("timed out", unchecked.stderr)

    def test_fetch_timeout_retries_are_bounded(self):
        calls = []

        def timeout_runner(command, *, cwd, env=None):
            calls.append(command)
            raise subprocess.TimeoutExpired(command, DEFAULT_GIT_TIMEOUT_SECONDS)

        repo = GitRepository(Path.cwd(), runner=timeout_runner)
        with mock.patch("updater_git.time.sleep"):
            with self.assertRaises(GitSafetyError) as raised:
                repo.fetch()
        self.assertEqual(raised.exception.code, "FETCH_FAILED")
        self.assertEqual(len(calls), DEFAULT_FETCH_ATTEMPTS)


class ScratchLifecycleTests(RepositoryFixture):
    def test_marker_is_private_to_git_metadata_and_close_is_verified(self):
        scratch = self.repo.make_scratch_clone("HEAD", self.runtime)
        path = scratch.path
        self.assertTrue((path / ".git" / ScratchClone.MARKER).is_file())
        self.assertEqual(scratch.status_paths(), set())

        self.assertTrue(scratch.close())
        self.assertTrue(scratch.closed)
        self.assertTrue(scratch.cleanup_complete)
        self.assertFalse(path.exists())
        with self.assertRaises(GitSafetyError) as raised:
            scratch.run(["status"])
        self.assertEqual(raised.exception.code, "SCRATCH_CLOSED")

    def test_partial_clone_failure_removes_exact_created_directory(self):
        source_path = self.root / "synthetic-source"
        source_path.mkdir()

        def failing_clone_runner(command, *, cwd, env=None):
            if command[1:3] == ["rev-parse", "--verify"]:
                return subprocess.CompletedProcess(command, 0, "a" * 40 + "\n", "")
            if command[1] == "clone":
                partial = Path(command[-1])
                partial.mkdir(parents=True)
                (partial / "partial").write_text("incomplete", encoding="utf-8")
                return subprocess.CompletedProcess(command, 1, "", "simulated clone failure")
            raise AssertionError(command)

        repo = GitRepository(source_path, runner=failing_clone_runner, fetch_attempts=1)
        with self.assertRaises(GitSafetyError) as raised:
            repo.make_scratch_clone("HEAD", self.runtime)
        self.assertEqual(raised.exception.code, "SCRATCH_CLONE_FAILED")
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_setup_failure_after_clone_removes_marked_scratch(self):
        with mock.patch.object(
            ScratchClone,
            "run",
            side_effect=GitSafetyError("SIMULATED_SETUP_FAILURE", "simulated"),
        ):
            with self.assertRaises(GitSafetyError):
                self.repo.make_scratch_clone("HEAD", self.runtime)
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_failed_partial_cleanup_is_marked_for_later_stale_cleanup(self):
        source_path = self.root / "synthetic-locked-source"
        source_path.mkdir()

        def failing_clone_runner(command, *, cwd, env=None):
            if command[1:3] == ["rev-parse", "--verify"]:
                return subprocess.CompletedProcess(command, 0, "b" * 40 + "\n", "")
            if command[1] == "clone":
                Path(command[-1]).mkdir(parents=True)
                return subprocess.CompletedProcess(command, 1, "", "simulated clone failure")
            raise AssertionError(command)

        repo = GitRepository(source_path, runner=failing_clone_runner, fetch_attempts=1)
        with mock.patch("updater_git.shutil.rmtree", side_effect=OSError("locked")), mock.patch(
            "updater_git.time.sleep"
        ), self.assertLogs("updater_git", level="WARNING"):
            with self.assertRaises(GitSafetyError):
                repo.make_scratch_clone("HEAD", self.runtime)

        leftovers = list(self.runtime.iterdir())
        self.assertEqual(len(leftovers), 1)
        self.assertTrue((leftovers[0] / ".git" / ScratchClone.MARKER).is_file())
        removed = cleanup_stale_scratch_clones(
            self.runtime,
            max_age_seconds=60,
            now_epoch=time.time() + 120,
        )
        self.assertEqual(removed, leftovers)
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_marker_write_failure_removes_unmarked_clone(self):
        with mock.patch("updater_git._write_scratch_marker", side_effect=OSError("simulated")):
            with self.assertRaises(GitSafetyError) as raised:
                self.repo.make_scratch_clone("HEAD", self.runtime)
        self.assertEqual(raised.exception.code, "SCRATCH_MARKER_FAILED")
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_close_retries_then_verifies_removal(self):
        scratch = self.repo.make_scratch_clone("HEAD", self.runtime)
        path = scratch.path
        real_rmtree = shutil.rmtree
        calls = []

        def flaky_rmtree(candidate, *args, **kwargs):
            calls.append(Path(candidate))
            if len(calls) == 1:
                raise OSError("simulated transient file lock")
            return real_rmtree(candidate, *args, **kwargs)

        with mock.patch("updater_git.shutil.rmtree", side_effect=flaky_rmtree), mock.patch(
            "updater_git.time.sleep"
        ):
            self.assertTrue(scratch.close())
        self.assertEqual(len(calls), 2)
        self.assertFalse(path.exists())

    def test_failed_close_scrubs_copied_auth_and_remains_retryable(self):
        secret = "AUTHORIZATION: basic test-secret"
        run_git(
            self.checkout,
            "config",
            "--local",
            "http.https://github.com/.extraheader",
            secret,
        )
        scratch = self.repo.make_scratch_clone("HEAD", self.runtime)
        config_path = scratch.path / ".git" / "config"
        self.assertIn("test-secret", config_path.read_text(encoding="utf-8"))

        with mock.patch("updater_git.shutil.rmtree", side_effect=OSError("locked")), mock.patch(
            "updater_git.time.sleep"
        ), self.assertLogs("updater_git", level="WARNING"):
            self.assertFalse(scratch.close())
        self.assertTrue(scratch.closed)
        self.assertFalse(scratch.cleanup_complete)
        self.assertTrue(scratch.path.exists())
        self.assertNotIn("test-secret", config_path.read_text(encoding="utf-8"))

        self.assertTrue(scratch.close())

    def test_close_refuses_runtime_root_mismatch_without_deleting(self):
        scratch = self.repo.make_scratch_clone("HEAD", self.runtime)
        real_root = scratch.runtime_root
        scratch.runtime_root = self.root / "different-runtime"
        with self.assertLogs("updater_git", level="ERROR"):
            self.assertFalse(scratch.close())
        self.assertTrue(scratch.path.exists())

        scratch.runtime_root = real_root
        self.assertTrue(scratch.close())

    def test_stale_cleanup_removes_only_old_validly_marked_clone(self):
        self.runtime.mkdir(exist_ok=True)
        old = self._manual_scratch(created_epoch=800)
        fresh = self._manual_scratch(created_epoch=980)
        unmarked = self.runtime / f"scratch-{uuid.uuid4().hex}"
        (unmarked / ".git").mkdir(parents=True)

        removed = cleanup_stale_scratch_clones(
            self.runtime,
            max_age_seconds=60,
            now_epoch=1000,
        )

        self.assertEqual(removed, [old])
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(unmarked.exists())

    def _manual_scratch(self, *, created_epoch):
        candidate = self.runtime / f"scratch-{uuid.uuid4().hex}"
        git_dir = candidate / ".git"
        git_dir.mkdir(parents=True)
        marker = {
            "schemaVersion": 1,
            "scratchId": candidate.name,
            "createdEpoch": created_epoch,
        }
        (git_dir / ScratchClone.MARKER).write_text(json.dumps(marker), encoding="utf-8")
        return candidate


class LocalLockFailureTests(unittest.TestCase):
    def test_metadata_failure_releases_kernel_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / "updater.lock"
            failed = LocalProcessLock(lock_path, role="PRIMARY")
            with mock.patch("updater_git.json.dumps", side_effect=RuntimeError("simulated")):
                with self.assertRaises(RuntimeError):
                    failed.acquire()
            self.assertIsNone(failed.handle)

            recovered = LocalProcessLock(lock_path, role="BACKUP")
            recovered.acquire()
            recovered.release()


if __name__ == "__main__":
    unittest.main(verbosity=2)
