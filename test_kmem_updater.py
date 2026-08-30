#!/usr/bin/env python3
"""Deterministic safety, heartbeat, lease, and lock tests for the updater."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from kmem_updater import (
    BACKUP_HANDOFF_MINUTES,
    BackupObservation,
    GENERATED_FILES,
    HOST_FAILOVER_MINUTES,
    InvalidLeaseObservation,
    LEASE_MINUTES,
    REQUIRED_OWNED_CYCLE_SKIPPED_EXIT,
    UpdaterCoordinator,
    active_lease,
    classify_lease_state,
    classify_host_heartbeat,
    coordinated_worker_is_authorized,
    lease_is_active,
    parse_role,
    parse_utc,
    released_lease,
    run_bounded_process,
    worker_authorization_path,
    write_worker_authorization,
    _log_generator_output,
    _terminate_process_tree,
    _windows_descendant_pids,
)
from updater_git import (
    GitRepository,
    GitSafetyError,
    LocalLockUnavailable,
    LocalProcessLock,
    ScratchClone,
    _default_runner,
    normalize_remote_identity,
)


FIXED_NOW = datetime(2026, 8, 28, 4, 0, tzinfo=timezone.utc)


BWC_LIFECYCLE_GENERATOR = """import json
import os
from pathlib import Path

role = os.environ["KMEM_UPDATER_ROLE"]
history_path = Path("bwc_history.json")
if history_path.exists():
    history = json.loads(history_path.read_text(encoding="utf-8"))
else:
    history = {
        "schemaVersion": 1,
        "station": "KMEM",
        "product": "USAHAS_AHAS_RISK",
        "retentionDays": 365,
        "continuityMinutes": 90,
        "collectionStartedZ": "2026-08-28T04:00:00Z",
        "archiveUpdatedZ": "2026-08-28T04:00:00Z",
        "runs": [],
    }

runs = history["runs"]
backup_seen = any(
    item.get("state") == "SEVERE" and item.get("startZ") == "2026-08-28T04:26:00Z"
    for item in runs
)
if role == "BACKUP":
    feed_timestamp = "2026-08-28T04:26:00Z"
    state = "SEVERE"
    observed = "2026-08-28T04:26:00Z"
    start_reason = "STATE_CHANGE"
elif backup_seen:
    feed_timestamp = "2026-08-28T04:27:00Z"
    state = "SEVERE"
    observed = "2026-08-28T04:26:00Z"
    start_reason = "STATE_CHANGE"
else:
    feed_timestamp = "2026-08-28T04:00:00Z"
    state = "LOW"
    observed = "2026-08-28T04:00:00Z"
    start_reason = "ARCHIVE_START"

candidate = {
    "kind": "STATE",
    "state": state,
    "rawAhasRisk": state,
    "startZ": observed,
    "firstObservedZ": observed,
    "lastObservedZ": observed,
    "observationsZ": [observed],
    "firstRecordedZ": feed_timestamp,
    "lastRecordedZ": feed_timestamp,
    "confirmationCount": 1,
    "startReason": start_reason,
    "source": "USAHAS",
    "basis": "NEXRAD",
    "basisClass": "OBSERVED_OPERATIONAL",
}
identity = (candidate["state"], candidate["startZ"])
if not any((item.get("state"), item.get("startZ")) == identity for item in runs):
    runs.append(candidate)
    history["archiveUpdatedZ"] = feed_timestamp
    history_path.write_text(
        json.dumps(history, indent=2, sort_keys=True) + "\\n",
        encoding="utf-8",
    )

payload = {
    "allFeedsUpdatedZ": feed_timestamp,
    "atisSelectedSource": "TEST",
    "atisSourcePolicy": "NEWEST_HEADER_TIME",
    "atisSourcesChecked": ["TEST"],
    "atisLiveCandidateCount": 1,
    "atisLiveCandidates": [{"source": "TEST"}],
    "bwc": state,
    "bwcAhasRisk": state,
    "bwcUpdatedZ": observed,
    "workflowMetadata": {
        "lastWorkflowActor": "KMEM_" + role + "_UPDATER",
        "lastWorkflowTimestampZ": feed_timestamp,
    },
}
Path("weather.json").write_text(
    json.dumps(payload, sort_keys=True) + "\\n",
    encoding="utf-8",
)
"""


def run_git(cwd, *args, check=True):
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return result


def write(path, value):
    Path(path).write_text(value, encoding="utf-8")


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="KMEM updater tests with spaces ")
        self.root = Path(self.temporary.name)
        self.origin = self.root / "origin.git"
        self.seed = self.root / "seed"
        self.primary = self.root / "primary checkout"
        self.writer = self.root / "writer checkout"
        self.runtime = self.root / "runtime scratch"

        run_git(self.root, "init", "--bare", str(self.origin))
        run_git(self.root, "init", str(self.seed))
        run_git(self.seed, "config", "user.name", "KMEM Test")
        run_git(self.seed, "config", "user.email", "kmem-test@example.invalid")
        write(self.seed / "index.html", "seed\n")
        write(
            self.seed / "update_weather_local.py",
            "import json,os,time\n"
            "from pathlib import Path\n"
            "payload={'allFeedsUpdatedZ':'2026-08-28 04:00Z','atisSelectedSource':'TEST',"
            "'atisSourcePolicy':'NEWEST_HEADER_TIME','atisSourcesChecked':['TEST'],"
            "'atisLiveCandidateCount':1,'atisLiveCandidates':[{'source':'TEST'}],"
            "'workflowMetadata':{'lastWorkflowActor':'KMEM_'+os.environ['KMEM_UPDATER_ROLE']+'_UPDATER',"
            "'lastWorkflowTimestampZ':'2026-08-28T04:00:00Z'},"
            "'generatedNonce':time.time_ns()}\n"
            "Path('weather.json').write_text(json.dumps(payload)+'\\n',encoding='utf-8')\n",
        )
        write(self.seed / "weather.json", "{}\n")
        write(self.seed / "host_status.json", "{}\n")
        write(
            self.seed / "updater_lease.json",
            json.dumps({"schemaVersion": 1, "state": "RELEASED"}) + "\n",
        )
        run_git(self.seed, "add", "--", "index.html", "update_weather_local.py", "weather.json", "host_status.json", "updater_lease.json")
        run_git(self.seed, "commit", "-m", "seed")
        run_git(self.seed, "branch", "-M", "main")
        run_git(self.seed, "remote", "add", "origin", str(self.origin))
        run_git(self.seed, "push", "-u", "origin", "main")
        run_git(self.origin, "symbolic-ref", "HEAD", "refs/heads/main")
        run_git(self.root, "clone", str(self.origin), str(self.primary))
        run_git(self.root, "clone", str(self.origin), str(self.writer))
        for checkout in (self.primary, self.writer):
            run_git(checkout, "config", "user.name", "KMEM Test")
            run_git(checkout, "config", "user.email", "kmem-test@example.invalid")

    def tearDown(self):
        self.temporary.cleanup()

    def push_writer_change(self, filename="weather.json", content='{"updated":true}\n'):
        write(self.writer / filename, content)
        run_git(self.writer, "add", "--", filename)
        run_git(self.writer, "commit", "-m", f"update {filename}")
        run_git(self.writer, "push", "origin", "main")


class SafeSyncTests(GitFixture):
    def test_clean_current_is_a_true_noop(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        before = repo.sha("HEAD")
        outcome = repo.sync()
        self.assertEqual(outcome.status, "CODE_CURRENT")
        self.assertFalse(outcome.advanced)
        self.assertEqual(repo.sha("HEAD"), before)
        self.assertEqual(repo.status_lines(), [])

    def test_clean_behind_fast_forwards_without_a_merge_commit(self):
        self.push_writer_change()
        repo = GitRepository(self.primary, fetch_attempts=1)
        outcome = repo.sync()
        self.assertTrue(outcome.advanced)
        self.assertEqual(outcome.status, "CODE_FAST_FORWARDED")
        self.assertEqual(repo.sha("HEAD"), repo.sha("origin/main"))
        self.assertEqual(repo.status_lines(), [])
        parents = run_git(self.primary, "show", "-s", "--format=%P", "HEAD").stdout.split()
        self.assertEqual(len(parents), 1)

    def test_dirty_checkout_is_blocked_without_rewriting_files(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        before_sha = repo.sha("HEAD")
        write(self.primary / "index.html", "local work\n")
        with self.assertRaisesRegex(GitSafetyError, "DIRTY WORKTREE") as raised:
            repo.sync()
        self.assertEqual(raised.exception.code, "DIRTY_WORKTREE")
        self.assertEqual(repo.sha("HEAD"), before_sha)
        self.assertEqual((self.primary / "index.html").read_text(encoding="utf-8"), "local work\n")

    def test_diverged_history_is_blocked_without_merge_rebase_or_reset(self):
        write(self.primary / "index.html", "local commit\n")
        run_git(self.primary, "add", "--", "index.html")
        run_git(self.primary, "commit", "-m", "local unique")
        local_sha = run_git(self.primary, "rev-parse", "HEAD").stdout.strip()
        self.push_writer_change("weather.json", '{"remote":true}\n')

        repo = GitRepository(self.primary, fetch_attempts=1)
        with self.assertRaises(GitSafetyError) as raised:
            repo.sync()
        self.assertEqual(raised.exception.code, "DIVERGED_HISTORY")
        self.assertEqual(repo.sha("HEAD"), local_sha)

    def test_fetch_failure_stops_safely(self):
        run_git(self.primary, "remote", "set-url", "origin", str(self.root / "missing.git"))
        repo = GitRepository(self.primary, fetch_attempts=1)
        with self.assertRaises(GitSafetyError) as raised:
            repo.sync()
        self.assertEqual(raised.exception.code, "FETCH_FAILED")

    def test_in_progress_git_operation_is_blocked(self):
        git_dir = Path(run_git(self.primary, "rev-parse", "--absolute-git-dir").stdout.strip())
        (git_dir / "rebase-merge").mkdir()
        repo = GitRepository(self.primary, fetch_attempts=1)
        with self.assertRaises(GitSafetyError) as raised:
            repo.sync()
        self.assertEqual(raised.exception.code, "GIT_OPERATION_IN_PROGRESS")

    def test_fast_forward_command_failure_does_not_move_head(self):
        self.push_writer_change()
        before = run_git(self.primary, "rev-parse", "HEAD").stdout.strip()
        commands = []

        def failing_runner(command, *, cwd, env=None):
            commands.append(command)
            if command[1:3] == ["merge", "--ff-only"]:
                return subprocess.CompletedProcess(command, 1, "", "simulated failure")
            return _default_runner(command, cwd=cwd, env=env)

        repo = GitRepository(self.primary, runner=failing_runner, fetch_attempts=1)
        with self.assertRaises(GitSafetyError) as raised:
            repo.sync()
        self.assertEqual(raised.exception.code, "FAST_FORWARD_FAILED")
        self.assertEqual(run_git(self.primary, "rev-parse", "HEAD").stdout.strip(), before)
        flattened = "\n".join(" ".join(command) for command in commands)
        for forbidden in (" pull ", " rebase ", " reset ", " push --force"):
            self.assertNotIn(forbidden, f" {flattened} ")

    def test_dirty_sync_block_publishes_only_status_without_touching_local_files(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        origin_before = repo.sha("origin/main")
        original_index = (self.primary / "index.html").read_text(encoding="utf-8")
        write(self.primary / "index.html", original_index + "local work\n")
        with self.assertRaises(GitSafetyError) as raised:
            coordinator.run_once()
        self.assertEqual(raised.exception.code, "DIRTY_WORKTREE")
        self.assertTrue(coordinator.publish_code_sync_blocked(raised.exception))

        repo.fetch()
        origin_after = repo.sha("origin/main")
        self.assertEqual(repo.changed_paths(origin_before, origin_after), {"host_status.json"})
        status = repo.read_json("origin/main", "host_status.json")
        self.assertEqual(status["codeSyncStatus"], "BLOCKED_DIRTY_WORKTREE")
        self.assertEqual(status["runningSha"], repo.sha("HEAD"))
        self.assertEqual(status["runningCodeSha"], status["runningSha"])
        self.assertEqual(status["originTipObservedSha"], status["originMainSha"])
        self.assertEqual(status["shaObservedPhase"], "SYNC_BLOCK")
        self.assertEqual(
            (self.primary / "index.html").read_text(encoding="utf-8"),
            original_index + "local work\n",
        )

    def test_sync_block_status_accepts_ambiguous_success_without_duplicate_commit(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        write(self.primary / "index.html", "dirty\n")
        with self.assertRaises(GitSafetyError) as raised:
            coordinator.run_once()
        original_push = ScratchClone.push_main
        calls = {"count": 0}

        def push_then_report_failure(candidate):
            calls["count"] += 1
            self.assertTrue(original_push(candidate))
            return False

        origin_before = repo.sha("origin/main")
        with mock.patch.object(ScratchClone, "push_main", new=push_then_report_failure):
            self.assertTrue(coordinator.publish_code_sync_blocked(raised.exception))
        self.assertEqual(calls["count"], 1)
        repo.fetch()
        self.assertEqual(
            int(run_git(self.primary, "rev-list", "--count", f"{origin_before}..origin/main").stdout),
            1,
        )

    def test_diverged_sync_block_status_does_not_merge_or_move_local_head(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        write(self.primary / "local.txt", "local\n")
        run_git(self.primary, "add", "--", "local.txt")
        run_git(self.primary, "commit", "-m", "local unique")
        local_head = repo.sha("HEAD")
        self.push_writer_change("weather.json", '{"remote":true}\n')
        repo.fetch()
        remote_before = repo.sha("origin/main")
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        with self.assertRaises(GitSafetyError) as raised:
            coordinator.run_once()
        self.assertEqual(raised.exception.code, "DIVERGED_HISTORY")
        self.assertTrue(coordinator.publish_code_sync_blocked(raised.exception))
        repo.fetch()
        self.assertEqual(repo.sha("HEAD"), local_head)
        self.assertEqual(
            repo.changed_paths(remote_before, repo.sha("origin/main")),
            {"host_status.json"},
        )


class RemoteLeaseTests(GitFixture):
    def prepare_candidate(self, repo, role, lease_id):
        scratch = repo.make_scratch_clone("origin/main", self.runtime)
        scratch.run(["config", "user.name", "KMEM Test"])
        scratch.run(["config", "user.email", "kmem-test@example.invalid"])
        lease = active_lease(role, scratch.base_sha, FIXED_NOW, lease_id)
        scratch.write_json("updater_lease.json", lease)
        sha = scratch.commit(["updater_lease.json"], f"lease {role}")
        return scratch, lease, sha

    def test_required_owned_cycle_turns_lease_skip_into_failure(self):
        repo = mock.Mock()
        repo.sync.return_value = mock.Mock(
            status="CODE_CURRENT",
            local_sha="a" * 40,
            origin_sha="a" * 40,
            advanced=False,
        )
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            require_owned_cycle=True,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        with mock.patch.object(coordinator, "acquire_lease", return_value=None):
            self.assertEqual(
                coordinator.run_once(),
                REQUIRED_OWNED_CYCLE_SKIPPED_EXIT,
            )

    def test_simultaneous_lease_candidates_have_exactly_one_winner(self):
        primary_repo = GitRepository(self.primary, fetch_attempts=1)
        writer_repo = GitRepository(self.writer, fetch_attempts=1)
        primary_repo.fetch()
        writer_repo.fetch()
        primary_head = primary_repo.sha("HEAD")
        first, _, first_sha = self.prepare_candidate(primary_repo, "PRIMARY", "primary-lease")
        second, _, second_sha = self.prepare_candidate(writer_repo, "BACKUP", "backup-lease")
        try:
            results = [first.push_main(), second.push_main()]
            self.assertEqual(sorted(results), [False, True])
            self.assertNotEqual(first_sha, second_sha)
            self.assertEqual(primary_repo.sha("HEAD"), primary_head)
            self.assertEqual(primary_repo.status_lines(), [])
        finally:
            first.close()
            second.close()

    def test_ambiguous_lease_push_accepts_matching_active_descendant(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        repo.fetch()
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        original_push = ScratchClone.push_main
        injected = {"done": False}

        def push_then_report_transport_failure(candidate):
            if injected["done"]:
                return original_push(candidate)
            injected["done"] = True
            self.assertTrue(original_push(candidate))
            repo.fetch()
            mover = repo.make_scratch_clone("origin/main", self.runtime)
            mover.run(["config", "user.name", "KMEM Test"])
            mover.run(["config", "user.email", "kmem-test@example.invalid"])
            try:
                mover.write_json("host_status.json", {"duringLease": True})
                mover.commit(["host_status.json"], "status descendant")
                self.assertTrue(original_push(mover))
            finally:
                mover.close()
            return False

        with mock.patch.object(ScratchClone, "push_main", new=push_then_report_transport_failure):
            ownership = coordinator.acquire_lease()
        self.assertIsNotNone(ownership)
        repo.fetch()
        remote_lease = repo.read_json("origin/main", "updater_lease.json")
        self.assertEqual(remote_lease["leaseId"], ownership.lease["leaseId"])
        self.assertEqual(remote_lease["state"], "ACTIVE")
        ownership.scratch.close()

    def test_final_sibling_push_rejects_after_remote_moves(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        repo.fetch()
        production_head = repo.sha("HEAD")
        lease_scratch, lease, lease_sha = self.prepare_candidate(repo, "PRIMARY", "lease-1")
        try:
            self.assertTrue(lease_scratch.push_main())
        finally:
            lease_scratch.close()

        repo.fetch()
        first = repo.make_scratch_clone("origin/main", self.runtime)
        second = repo.make_scratch_clone("origin/main", self.runtime)
        for scratch in (first, second):
            scratch.run(["config", "user.name", "KMEM Test"])
            scratch.run(["config", "user.email", "kmem-test@example.invalid"])
        try:
            for scratch, marker in ((first, "first"), (second, "second")):
                scratch.write_json("host_status.json", {"winner": marker})
                scratch.write_json("updater_lease.json", released_lease(lease, FIXED_NOW + timedelta(minutes=1)))
                scratch.commit(["host_status.json", "updater_lease.json"], marker)
            self.assertTrue(first.push_main())
            self.assertFalse(second.push_main())
            self.assertEqual(repo.sha("HEAD"), production_head)
            self.assertEqual(repo.status_lines(), [])
            self.assertEqual(lease_sha, first.base_sha)
        finally:
            first.close()
            second.close()

    def test_active_backup_lease_blocks_until_release_or_expiration(self):
        lease = active_lease("BACKUP", "a" * 40, FIXED_NOW, "backup")
        self.assertTrue(lease_is_active(lease, FIXED_NOW + timedelta(minutes=19)))
        self.assertFalse(lease_is_active(lease, FIXED_NOW + timedelta(minutes=20)))
        self.assertFalse(lease_is_active(released_lease(lease, FIXED_NOW + timedelta(minutes=2)), FIXED_NOW + timedelta(minutes=3)))
        self.assertEqual(LEASE_MINUTES, 20)

    def test_malformed_active_lease_fails_closed_but_expired_lease_is_recoverable(self):
        malformed = {
            "state": "ACTIVE",
            "owner": "PRIMARY",
            "leaseId": "bad",
            "acquiredUtc": FIXED_NOW.isoformat(),
            "expiresUtc": (FIXED_NOW + timedelta(hours=3)).isoformat(),
        }
        self.assertEqual(classify_lease_state(malformed, FIXED_NOW), "INVALID")
        malformed["expiresUtc"] = (FIXED_NOW - timedelta(minutes=1)).isoformat()
        self.assertEqual(classify_lease_state(malformed, FIXED_NOW), "EXPIRED")
        expired = active_lease("PRIMARY", "a" * 40, FIXED_NOW, "expired")
        self.assertEqual(classify_lease_state(expired, FIXED_NOW + timedelta(minutes=21)), "EXPIRED")

    def test_unchanged_malformed_lease_recovers_only_after_local_quarantine(self):
        malformed = {
            "owner": "PRIMARY",
            "leaseId": "malformed",
            "acquiredUtc": FIXED_NOW.isoformat(),
            "expiresUtc": (FIXED_NOW + timedelta(minutes=LEASE_MINUTES)).isoformat(),
        }
        self.assertEqual(classify_lease_state(malformed, FIXED_NOW), "INVALID")
        write(self.writer / "updater_lease.json", json.dumps(malformed) + "\n")
        run_git(self.writer, "add", "--", "updater_lease.json")
        run_git(self.writer, "commit", "-m", "malformed lease")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)

        clock = {"now": FIXED_NOW}
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: clock["now"],
            python_executable=sys.executable,
        )
        self.assertIsNone(coordinator.acquire_lease())
        clock["now"] = FIXED_NOW + timedelta(minutes=LEASE_MINUTES, seconds=1)
        ownership = coordinator.acquire_lease()
        self.assertIsNotNone(ownership)
        ownership.scratch.close()

    def test_remote_activity_resets_malformed_lease_quarantine(self):
        malformed = {
            "owner": "PRIMARY",
            "leaseId": "legacy",
            "acquiredUtc": FIXED_NOW.isoformat(),
            "expiresUtc": (FIXED_NOW + timedelta(minutes=LEASE_MINUTES)).isoformat(),
        }
        write(self.writer / "updater_lease.json", json.dumps(malformed) + "\n")
        run_git(self.writer, "add", "--", "updater_lease.json")
        run_git(self.writer, "commit", "-m", "legacy malformed lease")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)

        clock = {"now": FIXED_NOW}
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: clock["now"],
            python_executable=sys.executable,
        )
        self.assertIsNone(coordinator.acquire_lease())

        clock["now"] = FIXED_NOW + timedelta(minutes=19)
        self.push_writer_change("weather.json", '{"legacyWriter":true}\n')
        clock["now"] = FIXED_NOW + timedelta(minutes=21)
        self.assertIsNone(coordinator.acquire_lease())

    def test_primary_waits_for_an_active_backup_lease(self):
        lease = active_lease("BACKUP", "a" * 40, FIXED_NOW, "backup-active")
        write(self.writer / "updater_lease.json", json.dumps(lease) + "\n")
        run_git(self.writer, "add", "--", "updater_lease.json")
        run_git(self.writer, "commit", "-m", "active backup lease")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW + timedelta(minutes=1),
            python_executable=sys.executable,
        )
        self.assertIsNone(coordinator.acquire_lease())

    def test_recent_backup_yields_one_cycle_then_primary_resumes_and_backup_stands_down(self):
        backup_status = {
            "schemaVersion": 1,
            "activeRole": "BACKUP",
            "heartbeatUtc": FIXED_NOW.isoformat(),
            "lastSuccessfulUpdateUtc": FIXED_NOW.isoformat(),
            "codeSyncStatus": "CURRENT",
        }
        write(self.writer / "host_status.json", json.dumps(backup_status) + "\n")
        run_git(self.writer, "add", "--", "host_status.json")
        run_git(self.writer, "commit", "-m", "backup completed")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)

        backup_clock = FIXED_NOW + timedelta(minutes=10)
        backup = UpdaterCoordinator(
            repo,
            "BACKUP",
            self.runtime,
            now_fn=lambda: backup_clock,
            sleep_fn=lambda _seconds: None,
            python_executable=sys.executable,
        )
        origin_before = repo.sha("origin/main")
        self.assertEqual(backup.run_once(), 0)
        repo.fetch()
        self.assertEqual(repo.sha("origin/main"), origin_before)

        primary_clock = FIXED_NOW + timedelta(minutes=10, seconds=1)
        primary = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: primary_clock,
            python_executable=sys.executable,
        )
        self.assertEqual(primary.run_once(), 0)
        repo.fetch()
        self.assertEqual(repo.read_json("origin/main", "host_status.json")["activeRole"], "PRIMARY")

        origin_after_primary = repo.sha("origin/main")
        backup_after_handoff = UpdaterCoordinator(
            repo,
            "BACKUP",
            self.runtime,
            now_fn=lambda: FIXED_NOW + timedelta(minutes=20),
            python_executable=sys.executable,
        )
        self.assertEqual(backup_after_handoff.run_once(), 0)
        repo.fetch()
        self.assertEqual(repo.sha("origin/main"), origin_after_primary)

    def test_backup_rechecks_at_handoff_boundary_instead_of_waiting_twenty_minutes(self):
        backup_status = {
            "schemaVersion": 1,
            "activeRole": "BACKUP",
            "heartbeatUtc": FIXED_NOW.isoformat(),
            "lastSuccessfulUpdateUtc": FIXED_NOW.isoformat(),
            "codeSyncStatus": "CURRENT",
        }
        write(self.writer / "host_status.json", json.dumps(backup_status) + "\n")
        run_git(self.writer, "add", "--", "host_status.json")
        run_git(self.writer, "commit", "-m", "backup completed for recheck")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)

        clock = {"now": FIXED_NOW + timedelta(minutes=10)}
        waits = []

        def advance_clock(seconds):
            waits.append(seconds)
            clock["now"] += timedelta(seconds=seconds)

        backup = UpdaterCoordinator(
            repo,
            "BACKUP",
            self.runtime,
            now_fn=lambda: clock["now"],
            sleep_fn=advance_clock,
            python_executable=sys.executable,
        )
        self.assertEqual(backup.run_once(), 0)
        self.assertEqual(len(waits), 1)
        self.assertLessEqual(waits[0], 3 * 60)
        repo.fetch()
        final_status = repo.read_json("origin/main", "host_status.json")
        self.assertEqual(final_status["activeRole"], "BACKUP")
        self.assertLess((parse_utc(final_status["heartbeatUtc"]) - FIXED_NOW), timedelta(minutes=13))

    def test_successful_full_cycle_publishes_status_releases_lease_and_syncs_local_main(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        self.assertEqual(coordinator.run_once(), 0)
        repo.fetch()
        self.assertEqual(repo.sha("HEAD"), repo.sha("origin/main"))
        self.assertEqual(repo.status_lines(), [])
        status = json.loads((self.primary / "host_status.json").read_text(encoding="utf-8"))
        lease = json.loads((self.primary / "updater_lease.json").read_text(encoding="utf-8"))
        self.assertEqual(status["activeRole"], "PRIMARY")
        self.assertEqual(status["updateStatus"], "OK")
        self.assertEqual(status["runningSha"], status["originMainSha"])
        self.assertEqual(status["runningCodeSha"], status["runningSha"])
        self.assertEqual(status["originTipObservedSha"], status["originMainSha"])
        self.assertEqual(status["shaObservedPhase"], "PRE_LEASE_CODE_SYNC")
        self.assertNotEqual(status["publishBaseSha"], status["runningCodeSha"])
        self.assertEqual(lease["state"], "RELEASED")
        messages = run_git(self.primary, "log", "-2", "--format=%s").stdout
        self.assertIn("KMEM updater lease PRIMARY", messages)
        self.assertIn("KMEM weather update", messages)

    def test_generator_timeout_returns_stable_error_without_publishing_output(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        repo.fetch()
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        scratch = coordinator._new_scratch("origin/main")
        try:
            with mock.patch.dict(
                os.environ,
                {"KMEM_COORDINATED_WORKER_TOKEN": "must-not-reach-generator"},
            ), mock.patch(
                "kmem_updater.run_bounded_process",
                side_effect=subprocess.TimeoutExpired(["python"], 1),
            ) as runner:
                ok, error = coordinator._run_generator(scratch)
            self.assertFalse(ok)
            self.assertEqual(error, "WEATHER_GENERATION_TIMEOUT")
            self.assertEqual(scratch.status_paths(), set())
            self.assertNotIn(
                "KMEM_COORDINATED_WORKER_TOKEN",
                runner.call_args.kwargs["env"],
            )
        finally:
            scratch.close()

    def test_generator_rejects_stale_timestamps_bad_diagnostics_and_local_identity(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        repo.fetch()
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        base = {
            "allFeedsUpdatedZ": "2026-08-28 04:00Z",
            "atisSelectedSource": "TEST",
            "atisSourcePolicy": "NEWEST_HEADER_TIME",
            "atisSourcesChecked": ["TEST"],
            "atisLiveCandidateCount": 1,
            "atisLiveCandidates": [{"source": "TEST"}],
            "workflowMetadata": {
                "lastWorkflowActor": "KMEM_PRIMARY_UPDATER",
                "lastWorkflowTimestampZ": "2026-08-28T04:00:00Z",
            },
        }
        cases = []
        stale = dict(base, allFeedsUpdatedZ="2026-08-28 03:00Z")
        cases.append((stale, "WEATHER_TIMESTAMP_INVALID"))
        bad_diagnostics = dict(base, atisLiveCandidateCount="1")
        cases.append((bad_diagnostics, "WEATHER_DIAGNOSTICS_INVALID"))
        bad_actor = dict(base, workflowMetadata=dict(base["workflowMetadata"], lastWorkflowActor="local-user"))
        cases.append((bad_actor, "WEATHER_METADATA_INVALID"))
        local_path = dict(base, debugPath=r"C:\Users\operator\cache.json")
        cases.append((local_path, "WEATHER_PII_DETECTED"))

        for payload, expected_error in cases:
            with self.subTest(expected_error=expected_error):
                scratch = coordinator._new_scratch("origin/main")
                try:
                    script = (
                        "from pathlib import Path\n"
                        f"Path('weather.json').write_text({(json.dumps(payload) + chr(10))!r},encoding='utf-8')\n"
                    )
                    write(scratch.path / "update_weather_local.py", script)
                    ok, error = coordinator._run_generator(scratch)
                    self.assertFalse(ok)
                    self.assertEqual(error, expected_error)
                finally:
                    scratch.close()

    def test_noop_generator_is_an_error_and_preserves_existing_weather(self):
        original_weather = (self.writer / "weather.json").read_text(encoding="utf-8")
        write(self.writer / "update_weather_local.py", "pass\n")
        run_git(self.writer, "add", "--", "update_weather_local.py")
        run_git(self.writer, "commit", "-m", "noop generator")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        self.assertEqual(coordinator.run_once(), 1)
        repo.fetch()
        status = repo.read_json("origin/main", "host_status.json")
        self.assertEqual(status["lastError"], "WEATHER_ARTIFACT_UNCHANGED")
        self.assertEqual(
            run_git(self.primary, "show", "origin/main:weather.json").stdout,
            original_weather,
        )

    def test_generator_must_preserve_atis_candidate_diagnostics(self):
        write(
            self.writer / "update_weather_local.py",
            "from pathlib import Path\n"
            "Path('weather.json').write_text('{\"allFeedsUpdatedZ\":\"2026-08-28 04:00Z\"}\\n')\n",
        )
        run_git(self.writer, "add", "--", "update_weather_local.py")
        run_git(self.writer, "commit", "-m", "missing diagnostics")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        self.assertEqual(coordinator.run_once(), 1)
        repo.fetch()
        status = repo.read_json("origin/main", "host_status.json")
        self.assertEqual(status["lastError"], "WEATHER_DIAGNOSTICS_MISSING")

    def test_generator_cannot_delete_an_allowlisted_artifact(self):
        original_weather = (self.writer / "weather.json").read_text(encoding="utf-8")
        write(
            self.writer / "update_weather_local.py",
            "from pathlib import Path\nPath('weather.json').unlink()\n",
        )
        run_git(self.writer, "add", "--", "update_weather_local.py")
        run_git(self.writer, "commit", "-m", "deleting generator")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        self.assertEqual(coordinator.run_once(), 1)
        repo.fetch()
        status = repo.read_json("origin/main", "host_status.json")
        self.assertEqual(status["lastError"], "GENERATED_FILE_DELETION")
        self.assertEqual(
            run_git(self.primary, "show", "origin/main:weather.json").stdout,
            original_weather,
        )

    def test_generation_failure_publishes_only_error_status_and_released_lease(self):
        write(self.writer / "update_weather_local.py", "raise SystemExit(1)\n")
        run_git(self.writer, "add", "--", "update_weather_local.py")
        run_git(self.writer, "commit", "-m", "failing generator")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)

        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        self.assertEqual(coordinator.run_once(), 1)
        repo.fetch()
        self.assertEqual(repo.sha("HEAD"), repo.sha("origin/main"))
        self.assertEqual(repo.status_lines(), [])
        status = json.loads((self.primary / "host_status.json").read_text(encoding="utf-8"))
        lease = json.loads((self.primary / "updater_lease.json").read_text(encoding="utf-8"))
        self.assertEqual(status["updateStatus"], "ERROR")
        self.assertEqual(status["lastError"], "WEATHER_GENERATION_FAILED")
        self.assertEqual(lease["state"], "RELEASED")

    def test_unexpected_generator_file_is_never_published(self):
        write(self.writer / "update_weather_local.py", "from pathlib import Path\nPath('unexpected.txt').write_text('no')\n")
        run_git(self.writer, "add", "--", "update_weather_local.py")
        run_git(self.writer, "commit", "-m", "unexpected generator")
        run_git(self.writer, "push", "origin", "main")
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)

        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        self.assertEqual(coordinator.run_once(), 1)
        repo.fetch()
        self.assertEqual(repo.sha("HEAD"), repo.sha("origin/main"))
        self.assertEqual(repo.status_lines(), [])
        self.assertFalse((self.primary / "unexpected.txt").exists())
        self.assertNotIn("unexpected.txt", run_git(self.primary, "ls-tree", "-r", "--name-only", "HEAD").stdout.splitlines())

    def test_rejected_final_push_retries_without_loading_scratch_commit_in_production_repo(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        repo.validate()
        repo.fetch()
        ownership = coordinator.acquire_lease()
        self.assertIsNotNone(ownership)
        try:
            with mock.patch("updater_git.ScratchClone.push_main", return_value=False):
                with self.assertRaises(GitSafetyError) as raised:
                    coordinator.publish_owned_cycle(ownership, FIXED_NOW)
            self.assertEqual(raised.exception.code, "FINAL_PUSH_REJECTED")
            self.assertEqual(repo.status_lines(), [])
        finally:
            ownership.scratch.close()


class BwcActiveOwnerLifecycleTests(GitFixture):
    def install_bwc_lifecycle_generator(self):
        write(self.writer / "update_weather_local.py", BWC_LIFECYCLE_GENERATOR)
        run_git(self.writer, "add", "--", "update_weather_local.py")
        run_git(self.writer, "commit", "-m", "install BWC lifecycle test generator")
        run_git(self.writer, "push", "origin", "main")

        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)
        return repo, repo.sha("HEAD")

    def remote_bwc_history(self, repo):
        return repo.read_json("origin/main", "bwc_history.json")

    def commit_paths(self, sha):
        output = run_git(
            self.primary,
            "show",
            "--pretty=format:",
            "--name-only",
            sha,
        ).stdout
        return {line.strip() for line in output.splitlines() if line.strip()}

    def test_bwc_history_primary_standby_takeover_return_is_atomic_and_deduplicated(self):
        repo, lifecycle_base_sha = self.install_bwc_lifecycle_generator()

        primary = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        self.assertEqual(primary.run_once(), 0)
        repo.fetch()
        primary_update_sha = repo.sha("origin/main")
        history_after_primary = self.remote_bwc_history(repo)
        self.assertEqual([run["state"] for run in history_after_primary["runs"]], ["LOW"])
        self.assertEqual(
            history_after_primary["runs"][0]["observationsZ"],
            ["2026-08-28T04:00:00Z"],
        )

        standby = UpdaterCoordinator(
            repo,
            "BACKUP",
            self.runtime,
            now_fn=lambda: FIXED_NOW + timedelta(minutes=10),
            python_executable=sys.executable,
        )
        standby_origin_sha = repo.sha("origin/main")
        with mock.patch.object(
            standby,
            "_run_generator",
            side_effect=AssertionError("healthy BACKUP standby must not generate"),
        ) as generator:
            self.assertEqual(standby.run_once(), 0)
        generator.assert_not_called()
        repo.fetch()
        self.assertEqual(repo.sha("origin/main"), standby_origin_sha)
        self.assertEqual(self.remote_bwc_history(repo), history_after_primary)

        takeover = UpdaterCoordinator(
            repo,
            "BACKUP",
            self.runtime,
            now_fn=lambda: FIXED_NOW + timedelta(minutes=26),
            python_executable=sys.executable,
        )
        self.assertEqual(takeover.run_once(), 0)
        repo.fetch()
        backup_update_sha = repo.sha("origin/main")
        history_after_takeover = self.remote_bwc_history(repo)
        self.assertEqual(
            [run["state"] for run in history_after_takeover["runs"]],
            ["LOW", "SEVERE"],
        )
        self.assertEqual(
            [run["observationsZ"] for run in history_after_takeover["runs"]],
            [["2026-08-28T04:00:00Z"], ["2026-08-28T04:26:00Z"]],
        )
        self.assertEqual(
            history_after_takeover["collectionStartedZ"],
            history_after_primary["collectionStartedZ"],
        )
        self.assertEqual(history_after_takeover["runs"][0], history_after_primary["runs"][0])

        returned_primary = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW + timedelta(minutes=27),
            python_executable=sys.executable,
        )
        self.assertEqual(returned_primary.run_once(), 0)
        repo.fetch()
        self.assertEqual(self.remote_bwc_history(repo), history_after_takeover)
        self.assertEqual(
            repo.read_json("origin/main", "host_status.json")["activeRole"],
            "PRIMARY",
        )

        lifecycle_commits = run_git(
            self.primary,
            "rev-list",
            "--reverse",
            f"{lifecycle_base_sha}..origin/main",
        ).stdout.splitlines()
        bwc_commits = []
        for sha in lifecycle_commits:
            paths = self.commit_paths(sha)
            self.assertNotEqual(paths, {"bwc_history.json"})
            if "bwc_history.json" not in paths:
                continue
            bwc_commits.append(sha)
            message = run_git(
                self.primary,
                "show",
                "-s",
                "--format=%s",
                sha,
            ).stdout.strip()
            self.assertTrue(message.startswith("KMEM weather update "))
            self.assertTrue(
                {"bwc_history.json", "weather.json", "host_status.json", "updater_lease.json"}
                .issubset(paths)
            )
        self.assertEqual(bwc_commits, [primary_update_sha, backup_update_sha])

    def test_bwc_history_lease_loss_prevents_generated_publication(self):
        repo, lifecycle_base_sha = self.install_bwc_lifecycle_generator()
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        repo.fetch()
        ownership = coordinator.acquire_lease()
        self.assertIsNotNone(ownership)

        mover = None
        try:
            repo.fetch()
            mover = repo.make_scratch_clone("origin/main", self.runtime)
            mover.run(["config", "user.name", "KMEM Test"])
            mover.run(["config", "user.email", "kmem-test@example.invalid"])
            replacement = active_lease(
                "BACKUP",
                mover.base_sha,
                FIXED_NOW + timedelta(minutes=1),
                "replacement-owner",
            )
            mover.write_json("updater_lease.json", replacement)
            lost_lease_sha = mover.commit(
                ["updater_lease.json"],
                "replace updater lease during BWC generation",
            )
            self.assertTrue(mover.push_main())

            with mock.patch.object(
                coordinator,
                "_run_generator",
                wraps=coordinator._run_generator,
            ) as generator:
                with self.assertRaises(GitSafetyError) as raised:
                    coordinator.publish_owned_cycle(ownership, FIXED_NOW)
            generator.assert_called_once()
            self.assertEqual(raised.exception.code, "REMOTE_MOVED_DURING_RUN")

            repo.fetch()
            self.assertEqual(repo.sha("origin/main"), lost_lease_sha)
            self.assertIsNone(self.remote_bwc_history(repo))
            self.assertEqual(
                run_git(self.primary, "show", "origin/main:weather.json").stdout,
                "{}\n",
            )
            commits = run_git(
                self.primary,
                "rev-list",
                f"{lifecycle_base_sha}..origin/main",
            ).stdout.splitlines()
            self.assertFalse(
                any("bwc_history.json" in self.commit_paths(sha) for sha in commits)
            )
        finally:
            if mover is not None:
                mover.close()
            ownership.scratch.close()


class HeartbeatAndRoleTests(unittest.TestCase):
    def status(self, age_minutes, role="PRIMARY", **extra):
        value = {
            "activeRole": role,
            "heartbeatUtc": (FIXED_NOW - timedelta(minutes=age_minutes)).isoformat(),
            "codeSyncStatus": "CURRENT",
        }
        value.update(extra)
        return value

    def test_heartbeat_boundaries_and_roles(self):
        self.assertEqual(classify_host_heartbeat(self.status(0), FIXED_NOW).state, "OK")
        self.assertEqual(classify_host_heartbeat(self.status(15), FIXED_NOW).state, "OK")
        self.assertEqual(classify_host_heartbeat(self.status(15, heartbeatUtc=(FIXED_NOW - timedelta(minutes=15, seconds=1)).isoformat()), FIXED_NOW).state, "DELAYED")
        self.assertEqual(classify_host_heartbeat(self.status(25), FIXED_NOW).state, "DELAYED")
        self.assertEqual(classify_host_heartbeat(self.status(25, heartbeatUtc=(FIXED_NOW - timedelta(minutes=25, seconds=1)).isoformat()), FIXED_NOW).state, "NO_HEARTBEAT")
        self.assertEqual(classify_host_heartbeat(self.status(60), FIXED_NOW).state, "NO_HEARTBEAT")
        self.assertEqual(classify_host_heartbeat(self.status(5, role="BACKUP"), FIXED_NOW).role, "BACKUP")

    def test_missing_malformed_future_and_code_blocked(self):
        for value in (None, {}, {"heartbeatUtc": "bad"}, {"heartbeatUtc": (FIXED_NOW + timedelta(minutes=1)).isoformat()}):
            self.assertEqual(classify_host_heartbeat(value, FIXED_NOW).state, "UNAVAILABLE")
        blocked = self.status(5, codeSyncStatus="BLOCKED_DIRTY_WORKTREE")
        self.assertEqual(classify_host_heartbeat(blocked, FIXED_NOW).state, "CODE_SYNC_BLOCKED")
        invalid_role = self.status(5, role="WORKSTATION")
        self.assertEqual(classify_host_heartbeat(invalid_role, FIXED_NOW).state, "UNAVAILABLE")

    def test_unknown_heartbeat_requires_full_local_observation_grace(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = BackupObservation(Path(directory) / "observation.json")
            self.assertFalse(tracker.unknown_is_eligible(FIXED_NOW))
            self.assertFalse(tracker.unknown_is_eligible(FIXED_NOW + timedelta(minutes=HOST_FAILOVER_MINUTES)))
            self.assertTrue(tracker.unknown_is_eligible(FIXED_NOW + timedelta(minutes=HOST_FAILOVER_MINUTES, seconds=1)))

    def test_role_is_explicit_and_generic(self):
        self.assertEqual(parse_role("primary"), "PRIMARY")
        self.assertEqual(parse_role("BACKUP"), "BACKUP")
        for invalid in (None, "", "HOME-PC", "laptop"):
            with self.assertRaises(ValueError):
                parse_role(invalid)

    def test_backup_standby_boundaries_and_force_override(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            coordinator = UpdaterCoordinator(
                repo=None,
                role="BACKUP",
                runtime_root=runtime,
                now_fn=lambda: FIXED_NOW,
            )
            for age in (5, 15, 16, 25):
                with self.subTest(age=age):
                    self.assertFalse(coordinator._backup_should_run(self.status(age)))
            self.assertTrue(coordinator._backup_should_run(self.status(26)))
            self.assertFalse(coordinator._backup_should_run(self.status(10, role="BACKUP")))
            self.assertTrue(coordinator._backup_should_run(self.status(13, role="BACKUP")))
            self.assertEqual(BACKUP_HANDOFF_MINUTES, 12)

            forced = UpdaterCoordinator(
                repo=None,
                role="BACKUP",
                runtime_root=runtime,
                force_failover=True,
                now_fn=lambda: FIXED_NOW,
            )
            self.assertTrue(forced._backup_should_run(self.status(5)))

    def test_invalid_lease_quarantine_is_bounded_and_resets_when_value_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = InvalidLeaseObservation(Path(directory) / "invalid-lease.json")
            self.assertFalse(tracker.unchanged_is_recoverable("first", FIXED_NOW))
            self.assertFalse(
                tracker.unchanged_is_recoverable(
                    "first",
                    FIXED_NOW + timedelta(minutes=LEASE_MINUTES),
                )
            )
            self.assertFalse(
                tracker.unchanged_is_recoverable(
                    "changed",
                    FIXED_NOW + timedelta(minutes=LEASE_MINUTES, seconds=1),
                )
            )
            self.assertTrue(
                tracker.unchanged_is_recoverable(
                    "changed",
                    FIXED_NOW + timedelta(minutes=(LEASE_MINUTES * 2), seconds=2),
                )
            )


class LocalLockTests(unittest.TestCase):
    def test_coordinated_worker_requires_matching_token_parent_and_live_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "updater.lock"
            token = "worker-token-123"
            lock = LocalProcessLock(path, role="PRIMARY")
            lock.acquire()
            authorization_path = worker_authorization_path(path)
            write_worker_authorization(authorization_path, "PRIMARY", token, lock.lock_id)
            try:
                serialized = authorization_path.read_text(encoding="utf-8")
                self.assertNotIn(token, serialized)
                authorized_epoch = json.loads(serialized)["authorizedEpoch"]
                with mock.patch("kmem_updater.os.getppid", return_value=os.getpid()):
                    self.assertTrue(coordinated_worker_is_authorized(path, "PRIMARY", token))
                    self.assertFalse(coordinated_worker_is_authorized(path, "PRIMARY", "wrong-token"))
                    self.assertFalse(coordinated_worker_is_authorized(path, "BACKUP", token))
                    with mock.patch("kmem_updater.time.time", return_value=authorized_epoch + 60):
                        self.assertTrue(coordinated_worker_is_authorized(path, "PRIMARY", token))
                    with mock.patch("kmem_updater.time.time", return_value=authorized_epoch + 60.001):
                        self.assertFalse(coordinated_worker_is_authorized(path, "PRIMARY", token))
                    with mock.patch("kmem_updater.time.time", return_value=authorized_epoch - 5):
                        self.assertTrue(coordinated_worker_is_authorized(path, "PRIMARY", token))
                    with mock.patch("kmem_updater.time.time", return_value=authorized_epoch - 5.001):
                        self.assertFalse(coordinated_worker_is_authorized(path, "PRIMARY", token))
            finally:
                lock.release()

            replacement = LocalProcessLock(path, role="PRIMARY")
            replacement.acquire()
            try:
                with mock.patch("kmem_updater.os.getppid", return_value=os.getpid()):
                    self.assertFalse(coordinated_worker_is_authorized(path, "PRIMARY", token))
            finally:
                replacement.release()

            with mock.patch("kmem_updater.os.getppid", return_value=os.getpid()):
                self.assertFalse(coordinated_worker_is_authorized(path, "PRIMARY", token))

    def test_coordinated_worker_authorization_crosses_only_to_direct_child(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "updater.lock"
            token = "direct-child-token"
            lock = LocalProcessLock(path, role="PRIMARY")
            lock.acquire()
            write_worker_authorization(worker_authorization_path(path), "PRIMARY", token, lock.lock_id)
            script = (
                "import sys; from pathlib import Path; "
                "from kmem_updater import coordinated_worker_is_authorized; "
                "ok=coordinated_worker_is_authorized(Path(sys.argv[1]),'PRIMARY',sys.argv[2]); "
                "print('AUTHORIZED' if ok else 'DENIED'); raise SystemExit(0 if ok else 3)"
            )
            try:
                authorized = subprocess.run(
                    [sys.executable, "-c", script, str(path), token],
                    cwd=str(Path(__file__).resolve().parent),
                    text=True,
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(authorized.returncode, 0, authorized.stderr)
                self.assertEqual(authorized.stdout.strip(), "AUTHORIZED")
            finally:
                lock.release()

            denied = subprocess.run(
                [sys.executable, "-c", script, str(path), token],
                cwd=str(Path(__file__).resolve().parent),
                text=True,
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(denied.returncode, 3, denied.stderr)
            self.assertEqual(denied.stdout.strip(), "DENIED")

    def test_second_instance_exits_and_lock_is_recoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "updater.lock"
            first = LocalProcessLock(path, role="PRIMARY")
            second = LocalProcessLock(path, role="BACKUP")
            first.acquire()
            try:
                with self.assertRaises(LocalLockUnavailable):
                    second.acquire()
            finally:
                first.release()
            second.acquire()
            second.release()

    def test_process_termination_releases_kernel_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "updater.lock"
            script = (
                "import sys,time; "
                "from updater_git import LocalProcessLock; "
                "lock=LocalProcessLock(sys.argv[1],role='PRIMARY'); "
                "lock.acquire(); print('LOCKED',flush=True); time.sleep(30)"
            )
            holder = subprocess.Popen(
                [sys.executable, "-u", "-c", script, str(path)],
                cwd=str(Path(__file__).resolve().parent),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(holder.stdout.readline().strip(), "LOCKED")
                with self.assertRaises(LocalLockUnavailable):
                    LocalProcessLock(path, role="BACKUP").acquire()
            finally:
                holder.terminate()
                holder.wait(timeout=5)
                holder.stdout.close()
                holder.stderr.close()

            recovered = LocalProcessLock(path, role="BACKUP")
            recovered.acquire()
            recovered.release()

    def test_bounded_process_preserves_invalid_byte_diagnostics_without_reader_thread_failure(self):
        script = (
            "import os; "
            "os.write(1, b'WIND: \\xe2\\x86\\x90 INVALID: \\x90\\n'); "
            "os.write(2, b'WARNING: \\xff\\n'); "
            "raise SystemExit(23)"
        )
        reader_failures = []

        with mock.patch("threading.excepthook", side_effect=reader_failures.append):
            result = run_bounded_process(
                [sys.executable, "-c", script],
                timeout=5,
                capture_output=True,
            )

        self.assertEqual(reader_failures, [])
        self.assertEqual(result.returncode, 23)
        self.assertEqual(result.stdout, "WIND: ← INVALID: \\x90\n")
        self.assertEqual(result.stderr, "WARNING: \\xff\n")

        with self.assertLogs("kmem-updater", level="INFO") as captured:
            _log_generator_output(result, {})
        combined = "\n".join(captured.output)
        self.assertIn("GENERATOR STDOUT WIND: ← INVALID: \\x90", combined)
        self.assertIn("GENERATOR STDERR WARNING: \\xff", combined)

    @unittest.skipUnless(os.name == "nt", "Windows no-window process contract")
    def test_bounded_process_combines_process_group_and_no_window_flags(self):
        process = mock.Mock()
        process.communicate.return_value = ("", "")
        process.returncode = 0
        with mock.patch("kmem_updater.subprocess.Popen", return_value=process) as popen:
            result = run_bounded_process(
                [sys.executable, "-c", "raise SystemExit(0)"],
                timeout=5,
                capture_output=True,
            )

        self.assertEqual(result.returncode, 0)
        creationflags = popen.call_args.kwargs["creationflags"]
        self.assertEqual(
            creationflags & subprocess.CREATE_NEW_PROCESS_GROUP,
            subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        self.assertEqual(
            creationflags & subprocess.CREATE_NO_WINDOW,
            subprocess.CREATE_NO_WINDOW,
        )

    def test_bounded_process_timeout_terminates_grandchild_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / "grandchild-survived.txt"
            grandchild = (
                "import pathlib,sys,time; "
                "time.sleep(1.0); pathlib.Path(sys.argv[1]).write_text('survived')"
            )
            parent = (
                "import subprocess,sys,time; "
                f"subprocess.Popen([sys.executable,'-c',{grandchild!r},sys.argv[1]]); "
                "time.sleep(30)"
            )
            with self.assertRaises(subprocess.TimeoutExpired):
                run_bounded_process(
                    [sys.executable, "-c", parent, str(sentinel)],
                    timeout=0.25,
                    capture_output=True,
                )
            time.sleep(1.25)
            self.assertFalse(sentinel.exists())

    @unittest.skipUnless(os.name == "nt", "Windows process snapshot coverage")
    def test_windows_descendant_snapshot_tracks_grandchild(self):
        grandchild = "import time; time.sleep(30)"
        parent = (
            "import subprocess,sys,time; "
            f"child=subprocess.Popen([sys.executable,'-c',{grandchild!r}]); "
            "print(child.pid,flush=True); time.sleep(30)"
        )
        holder = subprocess.Popen(
            [sys.executable, "-u", "-c", parent],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        child_pid = int(holder.stdout.readline().strip())
        try:
            self.assertIn(child_pid, _windows_descendant_pids(holder.pid))
        finally:
            _terminate_process_tree(holder)
            holder.wait(timeout=5)
            holder.stdout.close()
            holder.stderr.close()


class StaticSafetyTests(unittest.TestCase):
    def test_generator_output_is_logged_with_environment_secrets_redacted(self):
        result = subprocess.CompletedProcess(
            ["python", "generator.py"],
            1,
            stdout="weather updated using secret-value",
            stderr="radar warning secret-value",
        )
        with self.assertLogs("kmem-updater", level="INFO") as captured:
            _log_generator_output(result, {"NMS_CLIENT_SECRET": "secret-value"})

        combined = "\n".join(captured.output)
        self.assertIn("GENERATOR STDOUT weather updated using [REDACTED]", combined)
        self.assertIn("GENERATOR STDERR radar warning [REDACTED]", combined)
        self.assertNotIn("secret-value", combined)

    def test_remote_identity_normalizes_https_and_ssh_and_rejects_wrong_origin(self):
        expected = "github.com/btenner1013/kmem-ops-board"
        for value in (
            "https://github.com/btenner1013/kmem-ops-board.git",
            "git@github.com:btenner1013/kmem-ops-board.git",
            "ssh://git@github.com/btenner1013/kmem-ops-board.git",
        ):
            self.assertEqual(normalize_remote_identity(value), expected)
        self.assertEqual(
            normalize_remote_identity(expected, allow_bare_identity=True),
            expected,
        )
        for rejected in (
            expected,
            "http://github.com/btenner1013/kmem-ops-board.git",
            "git://github.com/btenner1013/kmem-ops-board.git",
            "ftp://github.com/btenner1013/kmem-ops-board.git",
            "ssh://github.com/btenner1013/kmem-ops-board.git",
            "https://github.com/btenner1013/kmem-ops-board.git?token=bad",
        ):
            self.assertEqual(normalize_remote_identity(rejected), "")
        self.assertEqual(
            normalize_remote_identity("https://embedded-token@github.com/btenner1013/kmem-ops-board.git"),
            "",
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_git(root, "init", "-b", "main")
            write(root / "index.html", "seed")
            write(root / "update_weather_local.py", "# seed")
            run_git(root, "remote", "add", "origin", "https://github.com/other/repository.git")
            repo = GitRepository(root, expected_remote=expected, fetch_attempts=1)
            with self.assertRaises(GitSafetyError) as raised:
                repo.validate()
            self.assertEqual(raised.exception.code, "WRONG_REMOTE")

    def test_generated_allowlist_is_exact(self):
        self.assertEqual(
            set(GENERATED_FILES),
            {
                "weather.json",
                "radar.gif",
                "atis_history.json",
                "bwc_history.json",
                "taf_current.json",
                "host_status.json",
                "updater_lease.json",
            },
        )

    def test_runtime_sources_contain_no_destructive_git_commands(self):
        root = Path(__file__).resolve().parent
        source = (root / "updater_git.py").read_text(encoding="utf-8") + (root / "kmem_updater.py").read_text(encoding="utf-8")
        for forbidden in ('["pull"', '["rebase"', '["reset"', '"--force-with-lease"', '"push", "--force"', 'git add .'):
            self.assertNotIn(forbidden, source)
        self.assertIn("cleanup_stale_scratch_clones(runtime_root, max_age_seconds=0)", source)

    def test_backup_tool_is_pinned_transactional_and_fail_closed(self):
        root = Path(__file__).resolve().parent
        source = (root / "create_backup_snapshot.ps1").read_text(encoding="utf-8")
        self.assertIn('Desktop\\KMEM Ops Board Portable', source)
        self.assertIn('E:\\KMEM-Ops-Board-Shop-Display', source)
        self.assertIn('archive --format=zip --output=$archivePath $sourceSha', source)
        self.assertNotIn('archive --format=zip --output=$archivePath HEAD', source)
        self.assertIn('Source and destination overlap', source)
        self.assertIn('contains the active source checkout', source)
        self.assertIn('fetch --no-tags origin main', source)
        self.assertIn('github.com/btenner1013/kmem-ops-board', source)
        self.assertIn('Replacement requires -ExpectedSourceSha', source)
        self.assertIn('Destination contains a reparse point', source)
        self.assertIn('[switch]$AllowVerifiedUsbRecoveryCheckout', source)
        self.assertIn('valid only with -Replace for the exact approved USB target', source)
        self.assertIn('exact legacy recovery location site\\.git', source)
        self.assertIn('Scheduled Task inspection is unavailable', source)
        self.assertIn('[int]$drive.DriveType -ne 2', source)
        self.assertIn('KMEM updater entrypoint is referenced by a running process', source)
        self.assertIn('remote get-url --push origin', source)
        self.assertIn('USB recovery checkout is dirty', source)
        self.assertIn('merge-base --is-ancestor $recoverySha $sourceSha', source)
        self.assertIn('.kmem-backup-transaction-', source)
        self.assertIn('[System.Threading.Mutex]::new', source)
        self.assertIn('Assert-NoReparseAncestor $destinationPath', source)
        self.assertIn('Get-TreeFingerprint $stagingPath', source)
        self.assertIn('Assert-TreeFingerprintMatch $stagedFingerprint $finalFingerprint', source)
        self.assertIn('ROLLBACK_INCOMPLETE', source)
        self.assertIn('journal.json', source)
        self.assertIn('launch_kmem_display.bat', source)
        self.assertIn('install_display_tasks.ps1', source)
        self.assertIn('run_kmem_daemon.bat', source)
        self.assertIn('$uri.Scheme -notin @("https", "ssh")', source)
        for sensitive_pattern in ('.env.*', '*.pfx', '*.p12', 'id_rsa*', 'id_ed25519*', '*token*'):
            self.assertIn(sensitive_pattern, source)
        get_child_lines = [line for line in source.splitlines() if 'Get-ChildItem' in line]
        self.assertTrue(all('SilentlyContinue' not in line for line in get_child_lines))

        move_position = source.index('Move-Item -LiteralPath $item.FullName -Destination $destinationPath')
        track_position = source.index('[void]$installedNames.Add($item.Name)')
        self.assertLess(move_position, track_position)


if __name__ == "__main__":
    unittest.main(verbosity=2)
