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

from host_health_history import DEFAULT_MAX_SERIALIZED_BYTES
import kmem_updater
from kmem_updater import (
    ACQUIRE_DEADLINE_SECONDS,
    BACKUP_HANDOFF_MINUTES,
    BackupObservation,
    GENERATED_FILES,
    GENERATOR_TIMEOUT_SECONDS,
    HOST_FAILOVER_MINUTES,
    InvalidLeaseObservation,
    LEASE_FILE,
    LEASE_MINUTES,
    NMS_PROBE_RESULT_MARKER,
    NMS_PROBE_TIMEOUT_SECONDS,
    NOTAM_FEED_FRESH_MINUTES,
    NOTAM_FEED_RETAKE_COOLDOWN_MINUTES,
    NOTAM_FEED_TAKEOVER_MINUTES,
    NOTAM_HANDOFF_REOFFER_MINUTES,
    NOTAM_HANDOFF_WINDOW_MINUTES,
    NotamFeedTakeoverObservation,
    PUBLISH_REASONS,
    REQUIRED_OWNED_CYCLE_SKIPPED_EXIT,
    RESTART_AFTER_SYNC_EXIT,
    RemoteSnapshot,
    STATUS_FILE,
    UpdaterCoordinator,
    WEATHER_FILE,
    WORKER_TIMEOUT_SECONDS,
    active_lease,
    atomic_write_json,
    classify_lease_state,
    classify_host_heartbeat,
    classify_published_notam_feed,
    coordinated_worker_is_authorized,
    evaluate_backup_publication,
    format_utc,
    lease_is_active,
    parse_notam_handoff,
    parse_role,
    parse_utc,
    released_lease,
    run_bounded_process,
    worker_authorization_path,
    write_worker_authorization,
    _log_generator_output,
    _probe_summary_line,
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
import update_weather_local as weather


FIXED_NOW = datetime(2026, 8, 28, 4, 0, tzinfo=timezone.utc)


def notam_cache_fixture(tag, updated_z, *, fetch_status="OK", raw_status="Success"):
    """Return one internally coherent generated NMS cache block for handoff tests."""
    collections = {
        "milNotams": [{"number": f"{tag}-MIL", "text": "MIL RAMP STATUS"}],
        "ficonNotams": [{"number": f"{tag}-FICON", "text": "RWY 18C FICON 5/5/5"}],
        "runwayClosureNotams": [{
            "number": f"{tag}-CLOSURE",
            "text": "RWY 18C/36C CLSD",
            "effectiveStart": "202609070400",
            "effectiveEnd": "202609070700",
        }],
        "constructionStatusNotams": [{
            "number": f"{tag}-CONST",
            "text": "RWY 18L WIP MEN AND EQUIPMENT",
        }],
        "taxiRestrictionNotams": [{
            "number": f"{tag}-TAXI",
            "text": "TWY A CLSD",
        }],
    }
    block = {
        "milNotamStatus": "1 ACTIVE",
        "milNotamScrollText": f"{tag} MIL RAMP STATUS",
        "milNotamSource": "FAA_NMS_STAGING",
        "milNotamUpdatedZ": updated_z,
        "milNotamFetchStatus": fetch_status,
        "milNotamRawStatus": raw_status,
    }
    for list_key, count_key in weather.MIL_NOTAM_CACHE_LIST_COUNTS:
        block[list_key] = collections[list_key]
        block[count_key] = len(collections[list_key])
    return block


def bwc_cache_fixture(tag, updated, *, risk="SEVERE", fetch_status="PARSED_DIRECT_XML"):
    """Return one AHAS/BWC cache block using the AHAS service timestamp format."""
    return {
        "bwc": risk,
        "bwcSource": "AHAS",
        "bwcUpdatedZ": updated,
        "bwcNexrad": risk,
        "bwcSoarRisk": "LOW",
        "bwcBamRisk": "MODERATE",
        "bwcAhasRisk": risk,
        "bwcBasedOn": "NEXRAD",
        "bwcHeight100FtAgl": 0,
        "bwcUrl": f"https://www.usahas.com/print.aspx?tag={tag}",
        "bwcRiskUrl": f"https://www.usahas.com/webservices/GetAHASRisk?tag={tag}",
        "bwcFetchStatus": fetch_status,
    }


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


class WeatherCacheHandoffTests(unittest.TestCase):
    def load_caches(self, local, repo_last_good, repo_weather):
        with tempfile.TemporaryDirectory(prefix="KMEM weather cache handoff ") as directory:
            root = Path(directory)
            local_path = root / "local-weather-last-good.json"
            repo_path = root / "weather-last-good.json"
            weather_path = root / "weather.json"
            for path, payload in (
                (local_path, local),
                (repo_path, repo_last_good),
                (weather_path, repo_weather),
            ):
                path.write_text(json.dumps(payload), encoding="utf-8")

            with (
                mock.patch.object(weather, "LAST_GOOD_WEATHER_PATH", str(local_path)),
                mock.patch.object(weather, "REPO_LAST_GOOD_WEATHER_PATH", str(repo_path)),
                mock.patch.object(weather, "REPO_DIR", str(root)),
            ):
                return weather.load_previous_weather()

    def test_newest_complete_notam_block_overlays_without_replacing_local_weather(self):
        local = {
            "metar": "LOCAL METAR MUST WIN",
            "localOnly": "preserved",
            **notam_cache_fixture("LOCAL", "2026-09-07T01:38:53Z"),
        }
        repo_last_good = {
            "metar": "REPO METAR MUST NOT WIN",
            **notam_cache_fixture(
                "REPO",
                "2026-09-07T05:01:41Z",
                fetch_status="SCRIPT_FAILED",
            ),
        }
        repo_weather = {
            "metar": "WEATHER.JSON METAR MUST NOT WIN",
            **notam_cache_fixture("WEATHER", "2026-09-07T04:00:00Z"),
        }

        selected = self.load_caches(local, repo_last_good, repo_weather)

        self.assertEqual(selected["metar"], "LOCAL METAR MUST WIN")
        self.assertEqual(selected["localOnly"], "preserved")
        for key in weather.MIL_NOTAM_CACHE_FIELDS:
            self.assertEqual(selected[key], repo_last_good[key], key)

    def test_incomplete_or_incoherent_newer_notam_block_cannot_win(self):
        local = {
            "metar": "LOCAL",
            **notam_cache_fixture("LOCAL", "2026-09-07T01:38:53Z"),
        }
        invalid_cases = []

        missing_list = notam_cache_fixture("MISSING", "2026-09-07T06:00:00Z")
        del missing_list["taxiRestrictionNotams"]
        invalid_cases.append(missing_list)

        mismatched_count = notam_cache_fixture("COUNT", "2026-09-07T06:00:00Z")
        mismatched_count["runwayClosureNotamCount"] = 99
        invalid_cases.append(mismatched_count)

        bad_raw_status = notam_cache_fixture(
            "RAW-ERROR",
            "2026-09-07T06:00:00Z",
            raw_status="Error",
        )
        invalid_cases.append(bad_raw_status)

        missing_source = notam_cache_fixture("NO-SOURCE", "2026-09-07T06:00:00Z")
        missing_source["milNotamSource"] = ""
        invalid_cases.append(missing_source)

        for invalid in invalid_cases:
            with self.subTest(tag=invalid.get("milNotamScrollText")):
                selected = self.load_caches(local, invalid, {})
                self.assertEqual(selected["milNotamUpdatedZ"], local["milNotamUpdatedZ"])
                self.assertEqual(selected["milNotams"], local["milNotams"])

    def test_equal_notam_timestamps_keep_location_priority(self):
        timestamp = "2026-09-07T05:01:41Z"
        local = {"metar": "LOCAL", **notam_cache_fixture("LOCAL", timestamp)}
        repo_last_good = {"metar": "REPO", **notam_cache_fixture("REPO", timestamp)}
        repo_weather = {"metar": "WEATHER", **notam_cache_fixture("WEATHER", timestamp)}

        selected = self.load_caches(local, repo_last_good, repo_weather)

        self.assertEqual(selected["milNotams"], local["milNotams"])
        self.assertEqual(selected["metar"], "LOCAL")

    def test_newest_ahas_block_overlays_across_cache_locations_after_handoff(self):
        # Observed 2026-09-11 13:36Z: PRIMARY's AHAS fetch failed on a degraded
        # link and it republished its local 12:06 snapshot over the 13:12
        # snapshot BACKUP had already published from the repository.
        local = {
            "metar": "LOCAL METAR MUST WIN",
            **bwc_cache_fixture("LOCAL", "2026-09-11 12:06:00.000", risk="SEVERE"),
        }
        repo_last_good = {
            "metar": "REPO METAR MUST NOT WIN",
            **bwc_cache_fixture("REPO", "2026-09-11 12:48:00.000", risk="MODERATE"),
        }
        repo_weather = {
            "metar": "WEATHER.JSON METAR MUST NOT WIN",
            **bwc_cache_fixture("WEATHER", "2026-09-11 13:12:00.000", risk="SEVERE"),
        }

        selected = self.load_caches(local, repo_last_good, repo_weather)

        self.assertEqual(selected["metar"], "LOCAL METAR MUST WIN")
        for key in weather.BWC_CACHE_FIELDS:
            self.assertEqual(selected[key], repo_weather[key], key)

        # The failed-fetch fallback then carries the newest block, not the
        # host-local one, and stays parseable for the board's age display.
        self.assertEqual(
            weather.cached_bwc_updated_datetime(selected),
            datetime(2026, 9, 11, 13, 12, tzinfo=timezone.utc),
        )

    def test_unusable_or_equal_ahas_blocks_keep_location_priority(self):
        local = {"metar": "LOCAL", **bwc_cache_fixture("LOCAL", "2026-09-11 12:06:00.000")}

        pending_newer = bwc_cache_fixture("PENDING", "2026-09-11 13:12:00.000", risk="PENDING")
        missing_time_newer = bwc_cache_fixture("NOTIME", "--")
        for invalid in (pending_newer, missing_time_newer):
            with self.subTest(tag=invalid["bwcUrl"]):
                selected = self.load_caches(local, invalid, {})
                self.assertEqual(selected["bwcUpdatedZ"], local["bwcUpdatedZ"])
                self.assertEqual(selected["bwcUrl"], local["bwcUrl"])

        equal_repo = {"metar": "REPO", **bwc_cache_fixture("REPO", "2026-09-11 12:06:00.000")}
        selected = self.load_caches(local, equal_repo, {})
        self.assertEqual(selected["bwcUrl"], local["bwcUrl"])
        self.assertEqual(selected["metar"], "LOCAL")

    def test_failed_fetch_retains_newest_content_but_remains_error_and_fail_closed(self):
        local = {
            "metar": "LOCAL",
            **notam_cache_fixture("LOCAL", "2026-09-07T01:38:53Z"),
        }
        repo_last_good = {
            "metar": "REPO",
            **notam_cache_fixture("REPO", "2026-09-07T05:01:41Z"),
        }
        selected = self.load_caches(local, repo_last_good, {})
        decision_now = datetime(2026, 9, 7, 5, 5, tzinfo=timezone.utc)

        for fetch_status in ("SCRIPT_FAILED", "TIMEOUT"):
            with self.subTest(fetch_status=fetch_status):
                retained = weather.previous_mil_notams_or_default(selected, fetch_status)
                self.assertEqual(retained["milNotamUpdatedZ"], "2026-09-07T05:01:41Z")
                self.assertEqual(retained["milNotamFetchStatus"], fetch_status)
                self.assertEqual(retained["milNotamRawStatus"], "Success")
                self.assertEqual(retained["runwayClosureNotamCount"], 1)
                self.assertEqual(
                    weather.classify_notam_feed(retained, decision_now),
                    {"status": "ERROR", "detail": fetch_status, "age": 4},
                )
                self.assertEqual(
                    weather.resolve_closed_runways(
                        {"sourceIsCurrent": False},
                        retained,
                        decision_now,
                    ),
                    "UNKNOWN",
                )


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
        host_health = json.loads(
            (self.primary / "host_health_history.json").read_text(encoding="utf-8")
        )
        self.assertEqual(status["activeRole"], "PRIMARY")
        self.assertEqual(status["updateStatus"], "OK")
        self.assertEqual(status["runningSha"], status["originMainSha"])
        self.assertEqual(status["runningCodeSha"], status["runningSha"])
        self.assertEqual(status["originTipObservedSha"], status["originMainSha"])
        self.assertEqual(status["shaObservedPhase"], "PRE_LEASE_CODE_SYNC")
        self.assertNotEqual(status["publishBaseSha"], status["runningCodeSha"])
        self.assertEqual(lease["state"], "RELEASED")
        self.assertEqual(host_health["current"]["publisher"]["role"], "PRIMARY")
        self.assertEqual(host_health["current"]["lease"]["state"], "RELEASED")
        self.assertIsNone(host_health["current"]["lease"]["activeOwner"])
        messages = run_git(self.primary, "log", "-2", "--format=%s").stdout
        self.assertIn("KMEM updater lease PRIMARY", messages)
        self.assertIn("KMEM weather update", messages)

    def test_standby_fast_forwards_new_coordinator_code_before_standing_down(self):
        # M: a BACKUP that keeps deferring to a healthy PRIMARY must still load new
        # coordinator logic. Previously the standby returned on heartbeat/lease
        # checks BEFORE repo.sync(), so it could run stale code indefinitely.
        healthy = {
            "schemaVersion": 1,
            "activeRole": "PRIMARY",
            "heartbeatUtc": FIXED_NOW.isoformat(),
            "lastSuccessfulUpdateUtc": FIXED_NOW.isoformat(),
            "codeSyncStatus": "CURRENT",
            "updateStatus": "OK",
        }
        write(self.writer / "host_status.json", json.dumps(healthy) + "\n")
        write(
            self.writer / "update_weather_local.py",
            "# new coordinator-era code\n"
            + (self.writer / "update_weather_local.py").read_text(encoding="utf-8"),
        )
        run_git(self.writer, "add", "--", "host_status.json", "update_weather_local.py")
        run_git(self.writer, "commit", "-m", "code change while PRIMARY is healthy")
        run_git(self.writer, "push", "origin", "main")

        repo = GitRepository(self.primary, fetch_attempts=1)
        stale_head = repo.sha("HEAD")
        backup = UpdaterCoordinator(
            repo,
            "BACKUP",
            self.runtime,
            now_fn=lambda: FIXED_NOW + timedelta(minutes=2),
            python_executable=sys.executable,
        )
        self.assertEqual(backup.run_once(), RESTART_AFTER_SYNC_EXIT)
        self.assertNotEqual(repo.sha("HEAD"), stale_head)
        self.assertEqual(repo.sha("HEAD"), repo.sha("origin/main"))
        # The restarted (now current) standby still stands down for a healthy PRIMARY.
        origin_before = repo.sha("origin/main")
        self.assertEqual(backup.run_once(), 0)
        repo.fetch()
        self.assertEqual(repo.sha("origin/main"), origin_before)

    def test_primary_honours_its_own_handoff_window_without_touching_the_lease(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        primary = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        primary.handoff.record_offer(FIXED_NOW - timedelta(minutes=1), FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES - 1))
        origin_before = repo.sha("origin/main")
        self.assertEqual(primary.run_once(), 0)
        repo.fetch()
        self.assertEqual(repo.sha("origin/main"), origin_before, "a yielding PRIMARY must publish nothing")
        self.assertEqual(repo.read_json("origin/main", "updater_lease.json")["state"], "RELEASED")
        # Once the window lapses PRIMARY resumes normal ownership automatically.
        resumed = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES),
            python_executable=sys.executable,
        )
        self.assertEqual(resumed.run_once(), 0)
        repo.fetch()
        self.assertNotEqual(repo.sha("origin/main"), origin_before)
        status = repo.read_json("origin/main", "host_status.json")
        self.assertEqual(status["activeRole"], "PRIMARY")
        self.assertEqual(status["publishReason"], "SCHEDULED")
        self.assertIsNone(status["notamHandoff"])

    def test_host_health_failure_never_blocks_weather_status_or_lease_publication(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        with mock.patch(
            "kmem_updater.update_host_health_history",
            side_effect=RuntimeError("simulated non-critical telemetry failure"),
        ):
            self.assertEqual(coordinator.run_once(), 0)

        repo.fetch()
        self.assertEqual(repo.sha("HEAD"), repo.sha("origin/main"))
        self.assertEqual(repo.read_json("origin/main", "host_status.json")["updateStatus"], "OK")
        self.assertEqual(repo.read_json("origin/main", "updater_lease.json")["state"], "RELEASED")
        self.assertIsNotNone(repo.read_json("origin/main", "weather.json"))
        self.assertNotEqual(
            run_git(self.primary, "show", "origin/main:host_health_history.json", check=False).returncode,
            0,
        )

    def test_unavailable_host_health_helper_never_blocks_owned_publication(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        with mock.patch("kmem_updater.update_host_health_history", None):
            self.assertEqual(coordinator.run_once(), 0)

        repo.fetch()
        self.assertEqual(repo.sha("HEAD"), repo.sha("origin/main"))
        self.assertEqual(repo.read_json("origin/main", "host_status.json")["updateStatus"], "OK")
        self.assertEqual(repo.read_json("origin/main", "updater_lease.json")["state"], "RELEASED")
        self.assertIsNotNone(repo.read_json("origin/main", "weather.json"))
        self.assertNotEqual(
            run_git(self.primary, "show", "origin/main:host_health_history.json", check=False).returncode,
            0,
        )

    def test_oversized_host_health_candidate_is_skipped_before_write(self):
        repo = GitRepository(self.primary, fetch_attempts=1)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        oversized = {
            "schemaVersion": 1,
            "intervals": [],
            "events": [],
            "dailySummaries": [],
            "padding": "x" * (DEFAULT_MAX_SERIALIZED_BYTES + 1),
        }
        with mock.patch(
            "kmem_updater.update_host_health_history",
            return_value=oversized,
        ):
            self.assertEqual(coordinator.run_once(), 0)

        repo.fetch()
        self.assertEqual(repo.read_json("origin/main", "host_status.json")["updateStatus"], "OK")
        self.assertEqual(repo.read_json("origin/main", "updater_lease.json")["state"], "RELEASED")
        self.assertIsNotNone(repo.read_json("origin/main", "weather.json"))
        self.assertNotEqual(
            run_git(self.primary, "show", "origin/main:host_health_history.json", check=False).returncode,
            0,
        )

    def test_oversized_existing_host_health_archive_is_rejected_before_parse(self):
        oversized_content = json.dumps(
            {
                "schemaVersion": 1,
                "padding": "x" * (DEFAULT_MAX_SERIALIZED_BYTES + 1),
            }
        ) + "\n"
        self.push_writer_change("host_health_history.json", oversized_content)
        repo = GitRepository(self.primary, fetch_attempts=1)
        self.assertTrue(repo.sync().advanced)
        coordinator = UpdaterCoordinator(
            repo,
            "PRIMARY",
            self.runtime,
            now_fn=lambda: FIXED_NOW,
            python_executable=sys.executable,
        )
        original_read_json = ScratchClone.read_json

        def bounded_spy(instance, ref, relative_path):
            if relative_path == "host_health_history.json":
                self.fail("oversized host-health archive was parsed")
            return original_read_json(instance, ref, relative_path)

        with mock.patch.object(
            ScratchClone,
            "read_json",
            autospec=True,
            side_effect=bounded_spy,
        ):
            self.assertEqual(coordinator.run_once(), 0)

        repo.fetch()
        self.assertEqual(repo.read_json("origin/main", "host_status.json")["updateStatus"], "OK")
        self.assertEqual(repo.read_json("origin/main", "updater_lease.json")["state"], "RELEASED")
        self.assertIsNotNone(repo.read_json("origin/main", "weather.json"))

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


class NotamAwareFailoverTests(unittest.TestCase):
    """NOTAM-aware failover: PRIMARY stays primary; BACKUP covers a PRIMARY that
    is alive but cannot retrieve NOTAMs; PRIMARY reclaims only after proving
    recovery. All decisions use fake clocks and in-memory documents."""

    # ----- fixtures ---------------------------------------------------------

    def status(self, age_minutes, role="PRIMARY", **extra):
        completed = FIXED_NOW - timedelta(minutes=age_minutes)
        value = {
            "schemaVersion": 1,
            "activeRole": role,
            "heartbeatUtc": format_utc(completed),
            "lastSuccessfulUpdateUtc": format_utc(completed),
            "runStartedUtc": format_utc(completed - timedelta(seconds=25)),
            "runCompletedUtc": format_utc(completed),
            "codeSyncStatus": "CURRENT",
            "updateStatus": "OK",
            "publishReason": "SCHEDULED",
            "notamHandoff": None,
        }
        value.update(extra)
        return value

    def weather(self, notam_age_minutes, fetch_status="OK", raw_status="Success",
                actor="KMEM_BACKUP_UPDATER", generated_age_minutes=None):
        notam_at = FIXED_NOW - timedelta(minutes=notam_age_minutes)
        generated_at = (
            FIXED_NOW - timedelta(minutes=generated_age_minutes)
            if generated_age_minutes is not None
            else notam_at
        )
        return {
            "milNotamFetchStatus": fetch_status,
            "milNotamRawStatus": raw_status,
            "milNotamUpdatedZ": notam_at.strftime("%Y-%m-%d %H:%M:%SZ"),
            "allFeedsUpdatedZ": generated_at.strftime("%Y-%m-%d %H:%MZ"),
            "workflowMetadata": {
                "lastWorkflowActor": actor,
                "lastWorkflowTimestampZ": generated_at.strftime("%Y-%m-%d %H:%M:%SZ"),
            },
        }

    def backup_ok(self, age_minutes=5, **status_extra):
        """A coherent successful BACKUP publication `age_minutes` old."""
        extra = {"publishReason": "NOTAM_DEGRADED_TAKEOVER", **status_extra}
        status = self.status(age_minutes, role="BACKUP", **extra)
        weather = self.weather(age_minutes + 0.1)  # pull finished seconds before completion
        return status, weather

    def coordinator(self, role, runtime, **kwargs):
        return UpdaterCoordinator(
            repo=kwargs.pop("repo", None),
            role=role,
            runtime_root=runtime,
            now_fn=kwargs.pop("now_fn", lambda: FIXED_NOW),
            **kwargs,
        )

    # ----- classifiers -------------------------------------------------------

    def test_published_feed_classification_boundaries_and_bad_input(self):
        ok = classify_published_notam_feed(self.weather(5), FIXED_NOW)
        self.assertTrue(ok.ok)
        self.assertTrue(classify_published_notam_feed(self.weather(NOTAM_FEED_FRESH_MINUTES), FIXED_NOW).ok)
        self.assertFalse(classify_published_notam_feed(self.weather(NOTAM_FEED_FRESH_MINUTES + 0.01), FIXED_NOW).ok)
        # The threshold is "last authoritative retrieval older than 20 minutes",
        # not a count of attempts: exactly 20 does not qualify.
        at_threshold = classify_published_notam_feed(self.weather(NOTAM_FEED_TAKEOVER_MINUTES, "SCRIPT_FAILED"), FIXED_NOW)
        self.assertEqual(at_threshold.status, "FAILED")
        self.assertFalse(at_threshold.failing_beyond_takeover)
        self.assertTrue(classify_published_notam_feed(self.weather(NOTAM_FEED_TAKEOVER_MINUTES + 0.01, "TIMEOUT"), FIXED_NOW).failing_beyond_takeover)
        # Retained content after a failed pull keeps rawStatus Success but is FAILED.
        retained = classify_published_notam_feed(self.weather(40, "SCRIPT_FAILED", "Success"), FIXED_NOW)
        self.assertEqual(retained.status, "FAILED")
        self.assertFalse(classify_published_notam_feed(self.weather(5, "OK", "LAST_GOOD"), FIXED_NOW).ok)
        for bad in (None, {}, {"milNotamFetchStatus": ""}, {"milNotamFetchStatus": "OK", "milNotamRawStatus": "Success", "milNotamUpdatedZ": "garbage"}):
            state = classify_published_notam_feed(bad, FIXED_NOW)
            self.assertFalse(state.ok)
            self.assertFalse(state.failing_beyond_takeover)
        future = classify_published_notam_feed(self.weather(-5, "SCRIPT_FAILED"), FIXED_NOW)
        self.assertIsNone(future.age_minutes)
        self.assertFalse(future.failing_beyond_takeover)

    def test_backup_publication_requires_one_coherent_successful_run(self):
        status, weather = self.backup_ok(5)
        result = evaluate_backup_publication(status, weather, FIXED_NOW)
        self.assertTrue(result.qualifies, result.reason)

        cases = {
            # F: fresh error heartbeat + retained successful weather must not qualify.
            "error heartbeat with retained weather": (
                self.status(2, role="BACKUP", updateStatus="ERROR", lastSuccessfulUpdateUtc=format_utc(FIXED_NOW - timedelta(minutes=20))),
                self.weather(20),
                "BACKUP_LAST_RUN_NOT_OK",
            ),
            "success timestamp not this run": (
                self.status(2, role="BACKUP", lastSuccessfulUpdateUtc=format_utc(FIXED_NOW - timedelta(minutes=20))),
                self.weather(2.1),
                "BACKUP_RUN_WINDOW_INCONSISTENT",
            ),
            "weather from an older run than the heartbeat": (self.status(2, role="BACKUP"), self.weather(20), "WEATHER_NOT_FROM_BACKUP_RUN"),
            "weather generated by PRIMARY": (self.status(2, role="BACKUP"), self.weather(2.1, actor="KMEM_PRIMARY_UPDATER"), "WEATHER_NOT_FROM_BACKUP_RUN"),
            "retained OK NOTAMs older than this run": (self.status(2, role="BACKUP"), self.weather(25, generated_age_minutes=2.1), "BACKUP_NOTAMS_RETAINED_NOT_FRESH"),
            "NOTAM pull failed this run": (self.status(2, role="BACKUP"), self.weather(2.1, "SCRIPT_FAILED"), "BACKUP_NOTAM_PULL_NOT_OK"),
            "publisher is PRIMARY": (self.status(2, role="PRIMARY"), self.weather(2.1), "PUBLISHER_NOT_BACKUP"),
            "heartbeat delayed": (self.status(16, role="BACKUP"), self.weather(16.1), "BACKUP_HEARTBEAT_DELAYED"),
            "heartbeat silent": (self.status(40, role="BACKUP"), self.weather(40.1), "BACKUP_HEARTBEAT_NO_HEARTBEAT"),
            "future run": (self.status(-3, role="BACKUP"), self.weather(-2.9), "BACKUP_HEARTBEAT_UNAVAILABLE"),
            "malformed window": (self.status(2, role="BACKUP", runStartedUtc="not-a-time"), self.weather(2.1), "BACKUP_RUN_WINDOW_MALFORMED"),
            "missing status": (None, self.weather(2.1), "BACKUP_EVIDENCE_MISSING"),
            "missing weather": (self.status(2, role="BACKUP"), None, "BACKUP_EVIDENCE_MISSING"),
        }
        for label, (status, weather, expected) in cases.items():
            with self.subTest(case=label):
                result = evaluate_backup_publication(status, weather, FIXED_NOW)
                self.assertFalse(result.qualifies)
                self.assertEqual(result.reason, expected)

    def test_handoff_offer_parsing_is_strict(self):
        offered = FIXED_NOW - timedelta(minutes=2)
        expires = offered + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES)
        good = self.status(2, notamHandoff={"offeredUtc": format_utc(offered), "expiresUtc": format_utc(expires)})
        self.assertEqual(parse_notam_handoff(good, FIXED_NOW), (offered, expires))
        bad = {
            "expired": {"offeredUtc": format_utc(FIXED_NOW - timedelta(minutes=20)), "expiresUtc": format_utc(FIXED_NOW - timedelta(minutes=8))},
            "future offer": {"offeredUtc": format_utc(FIXED_NOW + timedelta(minutes=1)), "expiresUtc": format_utc(FIXED_NOW + timedelta(minutes=13))},
            "window too long": {"offeredUtc": format_utc(offered), "expiresUtc": format_utc(offered + timedelta(hours=2))},
            "inverted": {"offeredUtc": format_utc(expires), "expiresUtc": format_utc(offered)},
            "malformed": {"offeredUtc": "x", "expiresUtc": format_utc(expires)},
            "not a dict": "soon",
        }
        for label, offer in bad.items():
            with self.subTest(case=label):
                self.assertIsNone(parse_notam_handoff(self.status(2, notamHandoff=offer), FIXED_NOW))
        self.assertIsNone(parse_notam_handoff(None, FIXED_NOW))

    # ----- BACKUP eligibility --------------------------------------------------

    def test_healthy_primary_behavior_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            backup = self.coordinator("BACKUP", runtime)
            fresh = self.weather(5, actor="KMEM_PRIMARY_UPDATER")
            for age in (5, 15, 16, 25):
                with self.subTest(age=age):
                    self.assertFalse(backup._backup_should_run(self.status(age), fresh))
                    self.assertEqual(backup.publish_reason, "SCHEDULED")
            self.assertTrue(backup._backup_should_run(self.status(26), fresh))
            self.assertEqual(backup.publish_reason, "HEARTBEAT_FAILOVER")
            # No weather supplied at all: identical to the pre-change contract.
            self.assertFalse(backup._backup_should_run(self.status(5)))
            self.assertFalse(backup._backup_should_run(self.status(10, role="BACKUP")))
            self.assertTrue(backup._backup_should_run(self.status(13, role="BACKUP")))

    def test_alive_primary_with_failing_feed_makes_backup_eligible(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            backup = self.coordinator("BACKUP", runtime)
            failing = self.weather(25, "SCRIPT_FAILED", actor="KMEM_PRIMARY_UPDATER")
            for age, state in ((5, "OK"), (20, "DELAYED")):
                with self.subTest(primary_heartbeat=state):
                    self.assertTrue(backup._backup_should_run(self.status(age), failing))
                    self.assertTrue(backup.feed_takeover_active)
                    self.assertEqual(backup.publish_reason, "NOTAM_DEGRADED_TAKEOVER")
            self.assertFalse(backup._backup_should_run(self.status(5), self.weather(15, "SCRIPT_FAILED", actor="KMEM_PRIMARY_UPDATER")))
            self.assertFalse(backup.feed_takeover_active)
            self.assertFalse(backup._backup_should_run(self.status(5), self.weather(25, actor="KMEM_PRIMARY_UPDATER")))
            self.assertFalse(backup._backup_should_run(self.status(5, codeSyncStatus="BLOCKED_DIRTY_WORKTREE"), failing))
            # An explicit handoff offer is accepted immediately ...
            offered = FIXED_NOW - timedelta(minutes=1)
            offer = {"offeredUtc": format_utc(offered), "expiresUtc": format_utc(offered + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES))}
            self.assertTrue(backup._backup_should_run(self.status(1, notamHandoff=offer), self.weather(21, "SCRIPT_FAILED", actor="KMEM_PRIMARY_UPDATER")))
            self.assertEqual(backup.publish_reason, "NOTAM_DEGRADED_TAKEOVER")
            # ... unless this host's own recent takeover also failed NMS.
            backup.feed_takeover.record_failed_takeover(FIXED_NOW - timedelta(minutes=5))
            self.assertFalse(backup._backup_should_run(self.status(1, notamHandoff=offer), self.weather(21, "SCRIPT_FAILED", actor="KMEM_PRIMARY_UPDATER")))
            backup.feed_takeover.reset()

    def test_notam_takeover_keeps_ten_minute_cadence_only_while_own_pull_is_proven(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            backup = self.coordinator("BACKUP", runtime)
            # D: own heartbeat 10 minutes old would normally wait for PRIMARY; in a
            # NOTAM takeover with a proven pull it continues on schedule.
            status, weather = self.backup_ok(10)
            self.assertTrue(backup._backup_should_run(status, weather))
            self.assertEqual(backup.publish_reason, "NOTAM_DEGRADED_TAKEOVER")
            self.assertTrue(backup.feed_takeover_active)
            # Own last publication red -> ordinary handoff window applies again.
            red_weather = self.weather(10.1, "SCRIPT_FAILED")
            self.assertFalse(backup._backup_should_run(status, red_weather))
            # Own last publication was a heartbeat-driven takeover -> unchanged rules.
            plain, plain_weather = self.backup_ok(10, publishReason="HEARTBEAT_FAILOVER")
            self.assertFalse(backup._backup_should_run(plain, plain_weather))
            self.assertTrue(backup._backup_should_run(*self.backup_ok(13, publishReason="HEARTBEAT_FAILOVER")))

    def test_cooldown_limits_feed_rule_only_and_never_heartbeat_failover(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            backup = self.coordinator("BACKUP", runtime)
            failing = self.weather(25, "SCRIPT_FAILED", actor="KMEM_PRIMARY_UPDATER")
            backup.feed_takeover.record_failed_takeover(FIXED_NOW - timedelta(minutes=5))
            self.assertFalse(backup._backup_should_run(self.status(5), failing))
            # I: PRIMARY goes heartbeat-stale while the cooldown is active.
            self.assertTrue(backup._backup_should_run(self.status(26), failing))
            self.assertEqual(backup.publish_reason, "HEARTBEAT_FAILOVER")
            # Already-active BACKUP keeps publishing regardless of cooldown.
            self.assertTrue(backup._backup_should_run(self.status(13, role="BACKUP"), failing))
            # Cooldown expires; a healthy published feed clears it early.
            backup.feed_takeover.reset()
            backup.feed_takeover.record_failed_takeover(FIXED_NOW - timedelta(minutes=NOTAM_FEED_RETAKE_COOLDOWN_MINUTES))
            self.assertTrue(backup._backup_should_run(self.status(5), failing))
            backup.feed_takeover.record_failed_takeover(FIXED_NOW - timedelta(minutes=1))
            backup._backup_should_run(self.status(5), self.weather(3, actor="KMEM_PRIMARY_UPDATER"))
            self.assertFalse(backup.feed_takeover.cooling_down(FIXED_NOW))
            # Consecutive failed takeovers back off 30 -> 60 -> 120 (cap) minutes; success resets.
            backup.feed_takeover.reset()
            for expected in (30, 60, 120, 120):
                backup.feed_takeover.record_failed_takeover(FIXED_NOW)
                self.assertEqual(backup.feed_takeover.cooldown_minutes(), expected)
            self.assertTrue(backup.feed_takeover.cooling_down(FIXED_NOW + timedelta(minutes=119)))
            self.assertFalse(backup.feed_takeover.cooling_down(FIXED_NOW + timedelta(minutes=120)))
            backup.feed_takeover.reset()
            backup.feed_takeover.record_failed_takeover(FIXED_NOW)
            self.assertEqual(backup.feed_takeover.cooldown_minutes(), 30)
            # O: malformed / future cooldown metadata never blocks.
            atomic_write_json(backup.feed_takeover.path, {"lastFailedTakeoverUtc": "garbage"})
            self.assertFalse(backup.feed_takeover.cooling_down(FIXED_NOW))
            backup.feed_takeover.record_failed_takeover(FIXED_NOW + timedelta(hours=1))
            self.assertFalse(backup.feed_takeover.cooling_down(FIXED_NOW))

    def test_takeover_outcome_recorded_from_actual_notam_status(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            backup = self.coordinator("BACKUP", runtime)
            backup.feed_takeover_active = True
            # J: generator exit 0 / publish OK but NOTAM status failed -> cooldown.
            backup.last_generated_notam_status = "SCRIPT_FAILED"
            backup._record_feed_takeover_outcome(published=True)
            self.assertTrue(backup.feed_takeover.cooling_down(FIXED_NOW))
            backup.last_generated_notam_status = "OK"
            backup._record_feed_takeover_outcome(published=True)
            self.assertFalse(backup.feed_takeover.cooling_down(FIXED_NOW))
            backup._record_feed_takeover_outcome(published=False)
            self.assertTrue(backup.feed_takeover.cooling_down(FIXED_NOW))
            for status in ("TIMEOUT", "NO_OUTPUT_JSON", "ERROR", "NO_CREDENTIALS", ""):
                backup.feed_takeover.reset()
                backup.last_generated_notam_status = status
                backup._record_feed_takeover_outcome(published=True)
                self.assertTrue(backup.feed_takeover.cooling_down(FIXED_NOW), status)
            # Heartbeat-driven takeovers and PRIMARY never touch it.
            backup.feed_takeover.reset()
            backup.feed_takeover_active = False
            backup.last_generated_notam_status = "SCRIPT_FAILED"
            backup._record_feed_takeover_outcome(published=True)
            self.assertFalse(backup.feed_takeover.cooling_down(FIXED_NOW))
            primary = self.coordinator("PRIMARY", runtime)
            primary.feed_takeover_active = True
            primary.last_generated_notam_status = "SCRIPT_FAILED"
            primary._record_feed_takeover_outcome(published=True)
            self.assertFalse(primary.feed_takeover.cooling_down(FIXED_NOW))

    # ----- PRIMARY: handoff opportunity (mechanism A) --------------------------

    def test_primary_offers_bounded_handoff_only_for_its_own_stale_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            primary = self.coordinator("PRIMARY", runtime)
            primary.last_generated_notam_status = "OK"
            primary.last_generated_notam_updated = FIXED_NOW - timedelta(minutes=40)
            self.assertIsNone(primary._primary_handoff_offer(FIXED_NOW))
            primary.last_generated_notam_status = "SCRIPT_FAILED"
            primary.last_generated_notam_updated = FIXED_NOW - timedelta(minutes=NOTAM_FEED_TAKEOVER_MINUTES)
            self.assertIsNone(primary._primary_handoff_offer(FIXED_NOW))
            primary.last_generated_notam_updated = FIXED_NOW - timedelta(minutes=NOTAM_FEED_TAKEOVER_MINUTES, seconds=1)
            offer = primary._primary_handoff_offer(FIXED_NOW)
            self.assertEqual(offer, {
                "offeredUtc": format_utc(FIXED_NOW),
                "expiresUtc": format_utc(FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES)),
            })
            # The local record is written only once the push carrying it succeeds.
            self.assertIsNone(primary.handoff.open_window(FIXED_NOW))
            primary.handoff.record_offer(FIXED_NOW, FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES))
            # Not re-offered while a recent offer is on record.
            later = FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_REOFFER_MINUTES - 1)
            primary.last_generated_notam_updated = later - timedelta(minutes=60)
            self.assertIsNone(primary._primary_handoff_offer(later))
            self.assertIsNotNone(primary._primary_handoff_offer(FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_REOFFER_MINUTES)))
            # BACKUP never offers.
            backup = self.coordinator("BACKUP", runtime)
            backup.last_generated_notam_status = "SCRIPT_FAILED"
            backup.last_generated_notam_updated = FIXED_NOW - timedelta(hours=1)
            self.assertIsNone(backup._primary_handoff_offer(FIXED_NOW))

    def test_handoff_window_is_honoured_until_taken_or_expired(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            primary = self.coordinator("PRIMARY", runtime)
            snapshot_primary = RemoteSnapshot("s1", self.status(1), self.weather(30, "SCRIPT_FAILED", actor="KMEM_PRIMARY_UPDATER"), None)
            self.assertFalse(primary._primary_handoff_window_open(snapshot_primary))
            primary.handoff.record_offer(FIXED_NOW - timedelta(minutes=1), FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES - 1))
            self.assertTrue(primary._primary_handoff_window_open(snapshot_primary))
            # Expired -> resume; PRIMARY is never withdrawn past the window.
            expired = self.coordinator("PRIMARY", runtime, now_fn=lambda: FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES))
            self.assertFalse(expired._primary_handoff_window_open(snapshot_primary))
            # Taken by BACKUP -> window closes, re-offer bookkeeping kept.
            primary.handoff.record_offer(FIXED_NOW - timedelta(minutes=1), FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES - 1))
            snapshot_backup = RemoteSnapshot("s2", *self.backup_ok(0.5), None)
            self.assertFalse(primary._primary_handoff_window_open(snapshot_backup))
            self.assertIsNone(primary.handoff.open_window(FIXED_NOW))
            self.assertFalse(primary.handoff.may_offer(FIXED_NOW))
            self.assertTrue(primary.handoff.may_offer(FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_REOFFER_MINUTES)))
            # Taken by a BACKUP whose own pull failed -> next offer waits twice as long.
            primary.handoff.record_offer(FIXED_NOW - timedelta(minutes=1), FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_WINDOW_MINUTES - 1))
            red_taker = RemoteSnapshot("s3", self.status(0.5, role="BACKUP", publishReason="NOTAM_DEGRADED_TAKEOVER"), self.weather(0.6, "SCRIPT_FAILED"), None)
            self.assertFalse(primary._primary_handoff_window_open(red_taker))
            self.assertFalse(primary.handoff.may_offer(FIXED_NOW + timedelta(minutes=NOTAM_HANDOFF_REOFFER_MINUTES)))
            self.assertTrue(primary.handoff.may_offer(FIXED_NOW + timedelta(minutes=2 * NOTAM_HANDOFF_REOFFER_MINUTES)))
            # O: malformed / future local offer state is ignored.
            atomic_write_json(primary.handoff.path, {"offeredUtc": "x", "expiresUtc": "y"})
            self.assertFalse(primary._primary_handoff_window_open(snapshot_primary))
            primary.handoff.record_offer(FIXED_NOW + timedelta(minutes=5), FIXED_NOW + timedelta(minutes=17))
            self.assertFalse(primary._primary_handoff_window_open(snapshot_primary))

    # ----- PRIMARY: recovery probe + post-probe recheck (mechanism B) ----------

    class FakeRepo:
        """Two-phase remote: `before` is read first, `after` once fetch() runs."""

        def __init__(self, before, after=None, advance_code_after_probe=False):
            self.before = before
            self.after = after if after is not None else before
            self.advance_code_after_probe = advance_code_after_probe
            self.fetches = 0
            self.repo_dir = Path(".")

        def fetch(self):
            self.fetches += 1

        def sync(self, already_fetched=True):
            advanced = self.advance_code_after_probe and self.fetches > 0
            return type("Outcome", (), {"advanced": advanced, "status": "CODE_CURRENT", "local_sha": "a", "origin_sha": "b"})()

        def sha(self, ref):
            return "after" if self.fetches else "before"

        def read_json(self, ref, name):
            docs = self.after if ref == "after" else self.before
            return docs.get(name)

    def docs(self, status, weather):
        return {STATUS_FILE: status, WEATHER_FILE: weather, LEASE_FILE: {"state": "RELEASED"}}

    def test_primary_probes_before_lease_and_rechecks_after(self):
        healthy = self.docs(*self.backup_ok(5))
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            probe = mock.Mock(return_value=False)

            # No qualifying standby -> proceed, probe never spent.
            plain = self.coordinator("PRIMARY", runtime, repo=self.FakeRepo(self.docs(self.status(5), self.weather(5, actor="KMEM_PRIMARY_UPDATER"))), notam_probe_fn=probe)
            self.assertEqual(plain._primary_recovery_decision(plain._read_snapshot()), "PROCEED")
            probe.assert_not_called()

            # Standby healthy, probe fails, still healthy after -> yield.
            repo = self.FakeRepo(healthy)
            primary = self.coordinator("PRIMARY", runtime, repo=repo, notam_probe_fn=probe)
            self.assertEqual(primary._primary_recovery_decision(primary._read_snapshot()), "YIELD")
            self.assertEqual(probe.call_count, 1)
            self.assertEqual(repo.fetches, 1)

            # E: standby dies during the probe -> resume normal ownership path.
            died = self.docs(self.status(40, role="BACKUP"), self.weather(40.1))
            repo = self.FakeRepo(healthy, after=died)
            primary = self.coordinator("PRIMARY", runtime, repo=repo, notam_probe_fn=mock.Mock(return_value=False))
            self.assertEqual(primary._primary_recovery_decision(primary._read_snapshot()), "PROCEED")

            # Probe passes -> proceed (reclaim under lease rules), even if standby still healthy.
            primary = self.coordinator("PRIMARY", runtime, repo=self.FakeRepo(healthy), notam_probe_fn=mock.Mock(return_value=True))
            self.assertEqual(primary._primary_recovery_decision(primary._read_snapshot()), "PROCEED")

            # G: code advanced while probing -> restart, probe result discarded.
            repo = self.FakeRepo(healthy, advance_code_after_probe=True)
            primary = self.coordinator("PRIMARY", runtime, repo=repo, notam_probe_fn=mock.Mock(return_value=True))
            primary.probe_result_path = runtime / "stale-probe.json"
            primary.probe_result_path.write_text("{}", encoding="utf-8")
            self.assertEqual(primary._primary_recovery_decision(primary._read_snapshot()), "RESTART")
            self.assertIsNone(primary.probe_result_path)

            # Probe launch failure counts as a failed probe.
            primary = self.coordinator("PRIMARY", runtime, repo=self.FakeRepo(healthy), notam_probe_fn=mock.Mock(side_effect=OSError("no python")))
            self.assertEqual(primary._primary_recovery_decision(primary._read_snapshot()), "YIELD")

            # BACKUP role never runs mechanism B.
            backup = self.coordinator("BACKUP", runtime, repo=self.FakeRepo(healthy), notam_probe_fn=probe)
            probe.reset_mock()
            self.assertEqual(backup._primary_recovery_decision(backup._read_snapshot()), "PROCEED")
            probe.assert_not_called()

    def test_acquire_deadline_skips_generation_when_budget_is_gone(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            primary = self.coordinator("PRIMARY", runtime)
            self.assertFalse(primary._acquire_deadline_exceeded())  # no cycle started
            with mock.patch("kmem_updater.time.monotonic", side_effect=[1000.0, 1000.0 + ACQUIRE_DEADLINE_SECONDS, 1000.0 + ACQUIRE_DEADLINE_SECONDS + 1]):
                primary.cycle_started_monotonic = kmem_updater.time.monotonic()
                self.assertFalse(primary._acquire_deadline_exceeded())
                self.assertTrue(primary._acquire_deadline_exceeded())
            self.assertEqual(ACQUIRE_DEADLINE_SECONDS, WORKER_TIMEOUT_SECONDS - GENERATOR_TIMEOUT_SECONDS - 120)
            self.assertGreater(ACQUIRE_DEADLINE_SECONDS, NMS_PROBE_TIMEOUT_SECONDS)

    # ----- probe result reuse (generator side) ---------------------------------

    def probe_payload(self, **overrides):
        payload = {
            "status": "Success",
            "generatedZ": (FIXED_NOW - timedelta(seconds=30)).strftime("%Y-%m-%d %H:%M:%SZ"),
            "location": "KMEM",
            "source": "FAA_NMS_STAGING",
            "httpTransport": "WINDOWS_CURL",
            "processBoundary": "WINDOWS_JOB_OBJECT",
            "requestStage": "NOTAMS",
            "milNotams": [{"number": "M0024/26", "text": "MIL RAMP ARFF STATUS YELLOW", "classification": "MIL"}],
            "ficonNotams": [],
            "runwayClosureNotams": [],
            "constructionStatusNotams": [],
            "taxiRestrictionNotams": [],
        }
        payload.update(overrides)
        return payload

    def test_recovery_probe_result_is_reused_only_when_fully_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "nms-probe-abc.json")
            fixed = FIXED_NOW
            with mock.patch.object(weather, "datetime", wraps=datetime) as fake_datetime:
                fake_datetime.now.return_value = fixed
                weather.write_recovery_probe_result(path, "abc", self.probe_payload())
                env = {"KMEM_NMS_PROBE_RESULT_PATH": path, "KMEM_NMS_PROBE_TOKEN": "abc"}
                with mock.patch.dict(os.environ, env, clear=False):
                    reused = weather.load_recovery_probe_result()
                self.assertIsNotNone(reused)
                self.assertEqual(reused["milNotamFetchStatus"], "OK")
                self.assertEqual(reused["milNotamAcquisition"], "RECOVERY_PROBE")
                self.assertEqual(reused["milNotamUpdatedZ"], self.probe_payload()["generatedZ"])  # original retrieval time
                self.assertEqual(reused["milNotamCount"], 1)

                rejects = {
                    "wrong token": ({"KMEM_NMS_PROBE_TOKEN": "zzz"}, {}),
                    "no token": ({"KMEM_NMS_PROBE_TOKEN": ""}, {}),
                    "too old": ({}, {"probedAtUtc": (fixed - timedelta(minutes=weather.NMS_PROBE_RESULT_MAX_AGE_MINUTES + 1)).strftime("%Y-%m-%d %H:%M:%SZ")}),
                    "future": ({}, {"probedAtUtc": (fixed + timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%SZ")}),
                    "wrong location": ({}, {"location": "KBNA"}),
                    "wrong source": ({}, {"source": "OTHER"}),
                    "failed payload": ({}, {"payload": self.probe_payload(status="Error")}),
                    "bad schema": ({}, {"schemaVersion": 99}),
                }
                for label, (env_override, record_override) in rejects.items():
                    with self.subTest(case=label):
                        record = json.loads(Path(path).read_text(encoding="utf-8"))
                        record.update(record_override)
                        other = os.path.join(directory, f"{label}.json")
                        Path(other).write_text(json.dumps(record), encoding="utf-8")
                        with mock.patch.dict(os.environ, {**env, "KMEM_NMS_PROBE_RESULT_PATH": other, **env_override}, clear=False):
                            self.assertIsNone(weather.load_recovery_probe_result())
                with mock.patch.dict(os.environ, {"KMEM_NMS_PROBE_RESULT_PATH": os.path.join(directory, "missing.json"), "KMEM_NMS_PROBE_TOKEN": "abc"}, clear=False):
                    self.assertIsNone(weather.load_recovery_probe_result())
            # Without the env contract the normal path is untouched.
            with mock.patch.dict(os.environ, {"KMEM_NMS_PROBE_RESULT_PATH": "", "KMEM_NMS_PROBE_TOKEN": ""}, clear=False):
                self.assertIsNone(weather.load_recovery_probe_result())

    def test_generator_probe_writes_result_only_on_success_and_never_reads_one(self):
        with tempfile.TemporaryDirectory() as directory:
            out = os.path.join(directory, "probe-out.json")
            raw_path = os.path.join(directory, "helper-output.json")
            Path(raw_path).write_text(json.dumps(self.probe_payload()), encoding="utf-8")
            ok_block = {"milNotamFetchStatus": "OK", "milNotamRawStatus": "Success", "milNotamFailureCategory": "NONE",
                        "milNotamAttemptStage": "NOTAMS", "milNotamAttemptTransport": "WINDOWS_CURL", "milNotamCount": 1}
            failed_block = dict(ok_block, milNotamFetchStatus="SCRIPT_FAILED", milNotamFailureCategory="UPSTREAM_RESPONSE_TIMEOUT", milNotamCount=0)
            for block, expected in ((failed_block, False), (ok_block, True)):
                with self.subTest(expected=expected):
                    env = {"KMEM_PROBE_OUTPUT_PATH_INTERNAL": out, "KMEM_NMS_PROBE_TOKEN": "tok",
                           "KMEM_NMS_PROBE_RESULT_PATH": out}  # must be ignored by the probe itself
                    with (
                        mock.patch.dict(os.environ, env, clear=False),
                        mock.patch.object(weather, "fetch_mil_notams", return_value=block) as fetch,
                        mock.patch.object(weather, "NMS_MIL_NOTAMS_OUTPUT_PATH", raw_path),
                        mock.patch("builtins.print"),
                    ):
                        self.assertIs(weather.probe_mil_notam_feed(), expected)
                        self.assertNotIn("KMEM_NMS_PROBE_RESULT_PATH", os.environ)
                    fetch.assert_called_once_with({})
                    self.assertEqual(os.path.exists(out), expected)
            record = json.loads(Path(out).read_text(encoding="utf-8"))
            self.assertEqual(record["invocationToken"], "tok")
            self.assertEqual(record["location"], "KMEM")
            self.assertEqual(record["payload"]["status"], "Success")

    def test_probe_summary_line_returns_only_the_marker_payload(self):
        stdout = (
            "MIL NOTAMS: running FAA NMS pull...\n"
            "Authorization: Basic SHOULD-NEVER-BE-LOGGED\n"
            f"{NMS_PROBE_RESULT_MARKER}" '{"fetchStatus": "OK", "ok": true}\n'
        )
        self.assertEqual(_probe_summary_line(stdout), '{"fetchStatus": "OK", "ok": true}')
        self.assertEqual(_probe_summary_line("no marker here"), "summary=unavailable")
        self.assertEqual(_probe_summary_line(None), "summary=unavailable")

    def test_status_payload_carries_validated_reason_and_offer(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            backup = self.coordinator("BACKUP", runtime)
            backup.publish_reason = "NOTAM_DEGRADED_TAKEOVER"
            payload = backup._status_payload(run_started=FIXED_NOW - timedelta(seconds=20), completed=FIXED_NOW,
                                             code_sha="c", origin_sha="c", publish_base_sha="b", generation_ok=True, error_code="")
            self.assertEqual(payload["publishReason"], "NOTAM_DEGRADED_TAKEOVER")
            self.assertIsNone(payload["notamHandoff"])
            backup.publish_reason = "MADE_UP"
            payload = backup._status_payload(run_started=FIXED_NOW, completed=FIXED_NOW, code_sha="c", origin_sha="c",
                                             publish_base_sha="b", generation_ok=True, error_code="", notam_handoff={"offeredUtc": "x", "expiresUtc": "y"})
            self.assertEqual(payload["publishReason"], "SCHEDULED")
            self.assertEqual(payload["notamHandoff"], {"offeredUtc": "x", "expiresUtc": "y"})
            self.assertIn("SCHEDULED", PUBLISH_REASONS)



class NotamFailoverScheduleSimulationTests(unittest.TestCase):
    """Deterministic two-host discrete-event simulation driving the REAL decision
    methods (`_backup_should_run`, `_primary_handoff_window_open`,
    `_primary_recovery_decision`, `_primary_handoff_offer`,
    `_record_feed_takeover_outcome`, `_status_payload`) with a fake clock, an
    in-memory remote, a modelled atomic lease with the real 20-minute TTL,
    10-minute triggers with IgnoreNew, configurable trigger offsets, fetch /
    probe / generation durations, and per-host NMS outcomes. Time-consuming
    steps re-enter the scheduler, so the other host observes active leases and
    acts during a slow probe or generation.

    Stated assumption of every scenario: at least one host executes scheduled
    work and can reach the remote. Simultaneous outages are not covered."""

    class World:
        def __init__(self):
            self.now = FIXED_NOW
            self.sha = 0
            self.docs = {STATUS_FILE: None, WEATHER_FILE: None, LEASE_FILE: {"state": "RELEASED"}}
            self.publishes = []  # (time, role, notam_ok, notam_updated, reason)
            self.code_advanced = False
            self.events = []  # (time, seq, host)
            self.seq = 0

        def read(self, name):
            value = self.docs.get(name)
            return json.loads(json.dumps(value)) if value is not None else None

        def lease_active(self):
            return lease_is_active(self.docs[LEASE_FILE], self.now)

        def schedule(self, when, host):
            self.seq += 1
            self.events.append((when, self.seq, host))
            self.events.sort(key=lambda item: (item[0], item[1]))

        def advance_to(self, when):
            """Run every trigger due up to `when` (re-entrant), then set the clock."""
            while self.events and self.events[0][0] <= when:
                due, _, host = self.events.pop(0)
                self.now = max(self.now, due)
                host.trigger()
            self.now = max(self.now, when)

    class WorldRepo:
        def __init__(self, world):
            self.world = world
            self.repo_dir = Path(".")

        def fetch(self):
            return None

        def sync(self, already_fetched=True):
            advanced = self.world.code_advanced
            self.world.code_advanced = False
            return type("Outcome", (), {"advanced": advanced, "status": "CODE_CURRENT", "local_sha": "a", "origin_sha": "b"})()

        def sha(self, ref):
            return str(self.world.sha)

        def read_json(self, ref, name):
            return self.world.read(name)

    class Host:
        def __init__(self, sim, role, offset_minutes, *, fetch_minutes, generation_minutes, nms_ok, probe_minutes=2.0):
            self.sim = sim
            self.world = sim.world
            self.role = role
            self.offset = offset_minutes
            self.fetch_minutes = fetch_minutes
            self.generation_minutes = generation_minutes
            self.nms_ok = nms_ok  # callable(now) -> bool
            self.probe_minutes = probe_minutes
            self.busy = False
            self.crashed_until = None
            self.runtime = Path(sim.directory) / f"{role}-runtime"
            self.runtime.mkdir(parents=True, exist_ok=True)
            self.coordinator = UpdaterCoordinator(
                repo=sim.repo,
                role=role,
                runtime_root=self.runtime,
                now_fn=lambda: self.world.now,
                sleep_fn=self.spend_seconds,
                notam_probe_fn=self.probe,
            )
            self.probes = []
            self.skips = []
            self.cycles = 0

        # -- time -----------------------------------------------------------
        def spend(self, minutes):
            self.world.advance_to(self.world.now + timedelta(minutes=minutes))

        def spend_seconds(self, seconds):
            self.spend(seconds / 60.0)

        def probe(self):
            self.spend(self.probe_minutes)
            ok = bool(self.nms_ok(self.world.now))
            self.probes.append((self.world.now, ok))
            if ok:
                self.coordinator.probe_result_path = self.runtime / "probe.json"
                self.coordinator.probe_token = "sim"
            return ok

        def snapshot(self):
            w = self.world
            return RemoteSnapshot(str(w.sha), w.read(STATUS_FILE), w.read(WEATHER_FILE), w.read(LEASE_FILE))

        # -- one scheduled invocation -----------------------------------------
        def trigger(self):
            world = self.world
            if self.crashed_until is not None and world.now < self.crashed_until:
                return
            if self.busy:
                self.skips.append(world.now)  # IgnoreNew
                return
            self.busy = True
            try:
                self.cycle()
            finally:
                self.busy = False

        def cycle(self):
            world = self.world
            coordinator = self.coordinator
            start = world.now
            self.cycles += 1
            coordinator.cycle_started_monotonic = None
            coordinator.feed_takeover_active = False
            coordinator.publish_reason = "SCHEDULED"
            coordinator._discard_probe_result()
            self.spend(self.fetch_minutes)
            snapshot = self.snapshot()
            if self.role == "BACKUP":
                if world.lease_active():
                    return
                if not coordinator._backup_should_run(snapshot.status, snapshot.weather):
                    wait = coordinator._backup_handoff_wait_seconds(snapshot.status)
                    if wait is None:
                        return
                    coordinator.sleep_fn(wait)
                    snapshot = self.snapshot()
                    if world.lease_active() or not coordinator._backup_should_run(snapshot.status, snapshot.weather):
                        return
            else:
                if coordinator._primary_handoff_window_open(snapshot):
                    return
                if coordinator._primary_recovery_decision(snapshot) != "PROCEED":
                    return
            if world.lease_active():
                coordinator._discard_probe_result()
                return
            acquired = world.now
            world.docs[LEASE_FILE] = {
                "state": "ACTIVE", "owner": self.role, "leaseId": f"{self.role}-{world.sha}",
                "acquiredUtc": format_utc(acquired), "expiresUtc": format_utc(acquired + timedelta(minutes=LEASE_MINUTES)),
            }
            world.sha += 1
            self.spend(self.generation_minutes)
            if coordinator.probe_result_path is not None:
                notam_ok, acquisition = True, "RECOVERY_PROBE"  # reused; no second download
            else:
                notam_ok, acquisition = bool(self.nms_ok(world.now)), "GENERATION"
            previous = world.read(WEATHER_FILE) or {}
            if notam_ok:
                updated, fetch_status = world.now, "OK"
            else:
                updated = parse_utc(previous.get("milNotamUpdatedZ")) or (FIXED_NOW - timedelta(hours=2))
                fetch_status = "SCRIPT_FAILED"
            coordinator.last_generated_notam_status = fetch_status
            coordinator.last_generated_notam_updated = updated
            if world.now > acquired + timedelta(minutes=LEASE_MINUTES):
                world.docs[LEASE_FILE] = {"state": "RELEASED", "owner": self.role}
                coordinator._discard_probe_result()
                return  # lease expired during generation: existing rule, nothing published
            completed = world.now
            offer = coordinator._primary_handoff_offer(completed)
            status = coordinator._status_payload(
                run_started=start, completed=completed, code_sha="c", origin_sha="c",
                publish_base_sha="b", generation_ok=True, error_code="", notam_handoff=offer,
            )
            world.docs[STATUS_FILE] = status
            world.docs[WEATHER_FILE] = {
                "milNotamFetchStatus": fetch_status,
                "milNotamRawStatus": "Success",
                "milNotamUpdatedZ": updated.strftime("%Y-%m-%d %H:%M:%SZ"),
                "milNotamAcquisition": acquisition if notam_ok else "NONE",
                "allFeedsUpdatedZ": completed.strftime("%Y-%m-%d %H:%MZ"),
                "workflowMetadata": {
                    "lastWorkflowActor": f"KMEM_{self.role}_UPDATER",
                    "lastWorkflowTimestampZ": completed.strftime("%Y-%m-%d %H:%M:%SZ"),
                },
            }
            world.docs[LEASE_FILE] = {"state": "RELEASED", "owner": self.role, "releasedUtc": format_utc(completed)}
            world.sha += 1
            if offer:
                coordinator.handoff.record_offer(parse_utc(offer["offeredUtc"]), parse_utc(offer["expiresUtc"]))
            coordinator._record_feed_takeover_outcome(True)
            coordinator._discard_probe_result()
            world.publishes.append((completed, self.role, notam_ok, updated, status["publishReason"]))

    # ----- harness -------------------------------------------------------------

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="KMEM notam failover sim ")
        self.directory = self.temporary.name
        self.world = self.World()
        self.repo = self.WorldRepo(self.world)
        self.hosts = []

    def tearDown(self):
        self.temporary.cleanup()

    def host(self, role, offset, **kwargs):
        created = self.Host(self, role, offset, **kwargs)
        self.hosts.append(created)
        return created

    def seed_primary_publish(self, notam_ok=True, minutes_ago=1.0):
        completed = FIXED_NOW - timedelta(minutes=minutes_ago)
        self.world.docs[STATUS_FILE] = {
            "schemaVersion": 1, "activeRole": "PRIMARY", "heartbeatUtc": format_utc(completed),
            "lastSuccessfulUpdateUtc": format_utc(completed), "runStartedUtc": format_utc(completed - timedelta(seconds=20)),
            "runCompletedUtc": format_utc(completed), "codeSyncStatus": "CURRENT", "updateStatus": "OK",
            "publishReason": "SCHEDULED", "notamHandoff": None,
        }
        self.world.docs[WEATHER_FILE] = {
            "milNotamFetchStatus": "OK" if notam_ok else "SCRIPT_FAILED", "milNotamRawStatus": "Success",
            "milNotamUpdatedZ": completed.strftime("%Y-%m-%d %H:%M:%SZ"),
            "allFeedsUpdatedZ": completed.strftime("%Y-%m-%d %H:%MZ"),
            "workflowMetadata": {"lastWorkflowActor": "KMEM_PRIMARY_UPDATER", "lastWorkflowTimestampZ": completed.strftime("%Y-%m-%d %H:%M:%SZ")},
        }

    def run_minutes(self, minutes):
        horizon = FIXED_NOW + timedelta(minutes=minutes)
        for host in self.hosts:
            when = FIXED_NOW + timedelta(minutes=host.offset)
            while when <= horizon:
                self.world.schedule(when, host)
                when += timedelta(minutes=10)
        self.world.advance_to(horizon)

    def notam_staleness(self, publishes, horizon_minutes):
        """Max minutes the board's last successful NOTAM retrieval was old, sampled each minute."""
        worst = 0.0
        for minute in range(horizon_minutes):
            now = FIXED_NOW + timedelta(minutes=minute)
            visible = [p for p in publishes if p[0] <= now]
            if not visible:
                continue
            worst = max(worst, (now - visible[-1][3]).total_seconds() / 60.0)
        return worst

    def role_switches(self, publishes):
        roles = [p[1] for p in publishes]
        return sum(1 for a, b in zip(roles, roles[1:]) if a != b)

    # ----- scenarios -----------------------------------------------------------

    def test_healthy_primary_never_yields_and_backup_never_publishes(self):
        self.seed_primary_publish()
        primary = self.host("PRIMARY", 0, fetch_minutes=0.05, generation_minutes=0.3, nms_ok=lambda now: True)
        self.host("BACKUP", 5, fetch_minutes=0.05, generation_minutes=0.3, nms_ok=lambda now: True)
        self.run_minutes(180)
        self.assertGreaterEqual(len(self.world.publishes), 17)
        self.assertEqual({p[1] for p in self.world.publishes}, {"PRIMARY"})
        self.assertEqual(primary.probes, [])
        self.assertEqual({p[4] for p in self.world.publishes}, {"SCHEDULED"})

    def test_congested_primary_hands_off_under_every_backup_offset(self):
        # C: PRIMARY cycles run ~9.4 minutes on the bad link, so back-to-back
        # 10-minute triggers leave the lease free for well under a minute per
        # slot; a purely eligibility-based BACKUP can be starved for any offset.
        for offset in range(10):
            with self.subTest(backup_offset_minutes=offset):
                self.setUp()
                self.seed_primary_publish()
                primary = self.host("PRIMARY", 0, fetch_minutes=1.0, generation_minutes=8.4, nms_ok=lambda now: False)
                self.host("BACKUP", offset, fetch_minutes=0.05, generation_minutes=0.3, nms_ok=lambda now: True)
                self.run_minutes(240)
                publishes = self.world.publishes
                backup_ok = [p for p in publishes if p[1] == "BACKUP" and p[2]]
                self.assertTrue(backup_ok, "BACKUP never published a successful pull")
                first = (backup_ok[0][0] - FIXED_NOW).total_seconds() / 60.0
                # Measured chain: threshold (20) + the PRIMARY cycle that publishes the
                # offer (<=10) + handoff window (12) + one BACKUP slot (10) + margin.
                self.assertLessEqual(first, 20 + 10 + 12 + 10 + 3, f"first BACKUP success at {first:.1f} min")
                # D: after takeover BACKUP keeps its 10-minute cadence (no 18-minute gaps),
                # so its heartbeat stays inside PRIMARY's 15-minute qualification window.
                times = [p[0] for p in publishes if p[1] == "BACKUP"]
                gaps = [(b - a).total_seconds() / 60.0 for a, b in zip(times, times[1:])]
                self.assertTrue(gaps, "BACKUP published only once")
                self.assertLessEqual(max(gaps), 11.0, f"BACKUP gaps {['%.1f' % g for g in gaps]}")
                # A still-failing PRIMARY never reclaimed: every reclaim needs a passing probe.
                reclaimed = [p for p in publishes if p[1] == "PRIMARY" and p[0] > backup_ok[0][0]]
                self.assertEqual(reclaimed, [], "PRIMARY reclaimed without demonstrating recovery")
                self.assertTrue(primary.probes)
                self.assertFalse(any(ok for _, ok in primary.probes))
                self.tearDown()

    def test_primary_reclaims_after_recovery_and_backup_stands_down(self):
        self.seed_primary_publish()
        recovery_at = FIXED_NOW + timedelta(minutes=150)
        self.host("PRIMARY", 0, fetch_minutes=1.0, generation_minutes=5.0, nms_ok=lambda now: now >= recovery_at)
        self.host("BACKUP", 3, fetch_minutes=0.05, generation_minutes=0.3, nms_ok=lambda now: True)
        self.run_minutes(300)
        publishes = self.world.publishes
        self.assertTrue(any(p[1] == "BACKUP" for p in publishes))
        primary_reclaim = next(p for p in publishes if p[1] == "PRIMARY" and p[0] > recovery_at)
        self.assertTrue(primary_reclaim[2], "reclaim must publish a successful pull (probe reused)")
        self.assertLessEqual((primary_reclaim[0] - recovery_at).total_seconds() / 60.0, 25)
        after = [p for p in publishes if p[0] > primary_reclaim[0] + timedelta(minutes=15)]
        self.assertTrue(after)
        self.assertTrue(all(p[1] == "PRIMARY" for p in after), "BACKUP must stand down after PRIMARY resumes")
        self.assertLessEqual(self.notam_staleness(publishes, 300), 60)

    def test_both_hosts_failing_nms_keeps_other_feeds_and_avoids_ping_pong(self):
        # K: neither host can reach NMS for 4 hours.
        self.seed_primary_publish()
        self.host("PRIMARY", 0, fetch_minutes=0.5, generation_minutes=3.0, nms_ok=lambda now: False)
        self.host("BACKUP", 4, fetch_minutes=0.05, generation_minutes=0.5, nms_ok=lambda now: False)
        self.run_minutes(240)
        publishes = self.world.publishes
        self.assertGreaterEqual(len(publishes), 18, "other feeds must keep publishing")
        self.assertTrue(all(not p[2] for p in publishes))
        self.assertEqual(len({p[3] for p in publishes}), 1, "last-success time must not move")
        # Bounded, documented oscillation: BACKUP's cooldown backs off 30/60/120 min
        # after each failed takeover and PRIMARY re-offers at most hourly after a
        # failed taker; every takeover is red for both hosts and content is retained.
        self.assertLessEqual(self.role_switches(publishes), 8, f"role oscillation: {self.role_switches(publishes)} switches")
        self.assertEqual(publishes[-1][1], "PRIMARY", "PRIMARY must not stay withdrawn")
        gaps = [(b[0] - a[0]).total_seconds() / 60.0 for a, b in zip(publishes, publishes[1:])]
        self.assertLessEqual(max(gaps), 25, f"publication gap {max(gaps):.1f} min")

    def test_intermittent_primary_never_reclaims_on_a_lucky_probe_alone(self):
        # L: PRIMARY link flaps minute to minute; BACKUP is solid.
        import random
        rng = random.Random(1013)
        flaps = {}

        def primary_ok(now):
            key = int((now - FIXED_NOW).total_seconds() // 60)
            if key not in flaps:
                flaps[key] = rng.random() < 0.55
            return flaps[key]

        self.seed_primary_publish()
        primary = self.host("PRIMARY", 0, fetch_minutes=1.0, generation_minutes=4.0, nms_ok=primary_ok)
        self.host("BACKUP", 5, fetch_minutes=0.05, generation_minutes=0.3, nms_ok=lambda now: True)
        self.run_minutes(480)
        publishes = self.world.publishes
        # PRIMARY never takes the board back from a successfully publishing BACKUP
        # with a failed pull: a reclaim reuses the validated probe result. (A later
        # ordinary PRIMARY cycle may still fail; that is a truthful red, not a reclaim.)
        for previous, current in zip(publishes, publishes[1:]):
            if previous[1] == "BACKUP" and previous[2] and current[1] == "PRIMARY":
                self.assertTrue(current[2], f"reclaim at {current[0]} published a failed pull")
        self.assertTrue(any(ok for _, ok in primary.probes) and any(not ok for _, ok in primary.probes))
        self.assertLessEqual(self.notam_staleness(publishes, 480), 60)
        self.assertLessEqual(self.role_switches(publishes), 16, f"{self.role_switches(publishes)} role switches in 8 h")

    def test_backup_dying_after_takeover_returns_primary_to_normal_ownership(self):
        # E at the schedule level: BACKUP takes over, then disappears for good.
        self.seed_primary_publish()
        primary = self.host("PRIMARY", 0, fetch_minutes=1.0, generation_minutes=6.0, nms_ok=lambda now: False)
        backup = self.host("BACKUP", 5, fetch_minutes=0.05, generation_minutes=0.3, nms_ok=lambda now: True)
        original_trigger = backup.trigger

        def crash_after_first_takeover():
            if any(p[1] == "BACKUP" for p in self.world.publishes):
                return  # crashed for good
            original_trigger()

        backup.trigger = crash_after_first_takeover
        self.run_minutes(240)
        publishes = self.world.publishes
        first_backup = next(p for p in publishes if p[1] == "BACKUP")
        later = [p for p in publishes if p[0] > first_backup[0] + timedelta(minutes=40)]
        self.assertTrue(later, "PRIMARY must resume when the standby disappears")
        self.assertTrue(all(p[1] == "PRIMARY" for p in later))
        self.assertTrue(primary.probes)

    def test_mixed_offsets_speeds_and_a_primary_crash_still_make_progress(self):
        # P: sweep offsets, generation speeds, and a PRIMARY that is down for an hour.
        for primary_offset, backup_offset, primary_gen, crash in (
            (0, 5, 8.4, None), (3, 3, 4.0, None), (7, 2, 9.0, None), (0, 9, 6.0, 60), (2, 6, 0.3, None),
        ):
            with self.subTest(primary_offset=primary_offset, backup_offset=backup_offset, primary_gen=primary_gen, crash=crash):
                self.setUp()
                self.seed_primary_publish()
                primary = self.host("PRIMARY", primary_offset, fetch_minutes=1.0, generation_minutes=primary_gen, nms_ok=lambda now: False)
                self.host("BACKUP", backup_offset, fetch_minutes=0.05, generation_minutes=0.3, nms_ok=lambda now: True)
                if crash:
                    primary.crashed_until = FIXED_NOW + timedelta(minutes=crash)
                self.run_minutes(240)
                staleness = self.notam_staleness(self.world.publishes, 240)
                self.assertLessEqual(staleness, 60, f"NOTAM staleness reached {staleness:.1f} min")
                self.assertTrue(any(p[1] == "BACKUP" and p[2] for p in self.world.publishes))
                self.tearDown()


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
                "host_health_history.json",
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
