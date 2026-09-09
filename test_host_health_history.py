#!/usr/bin/env python3
"""Deterministic tests for compact read-only host-health telemetry."""

from __future__ import annotations

import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone

from host_health_history import (
    DEFAULT_MAX_SERIALIZED_BYTES,
    DEFAULT_MAX_STORED_ROWS,
    HostHealthHistoryError,
    build_host_health_history_from_evidence,
    compact_host_health_history,
    host_health_storage_usage,
    update_host_health_history,
    validate_host_health_storage_budget,
)


UTC = timezone.utc
T0 = datetime(2026, 9, 9, 5, 35, 56, tzinfo=UTC)
HEALTHY_MINUTES = 15
FAILOVER_MINUTES = 25
BOARD_GAP_MINUTES = 30


def zulu(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def status(
    role: str,
    heartbeat: datetime,
    *,
    successful_update: datetime | None = None,
    successful_push: datetime | None = None,
    update_status: str = "OK",
    error: str | None = None,
    sha: str | None = None,
) -> dict:
    successful_update = successful_update if successful_update is not None else heartbeat
    successful_push = successful_push if successful_push is not None else heartbeat
    sha = sha or ("a" * 40 if role == "PRIMARY" else "b" * 40)
    return {
        "schemaVersion": 1,
        "activeRole": role,
        "heartbeatUtc": zulu(heartbeat),
        "lastSuccessfulUpdateUtc": zulu(successful_update) if successful_update else None,
        "lastSuccessfulPushUtc": zulu(successful_push) if successful_push else None,
        "updateStatus": update_status,
        "lastError": error,
        "runningCodeSha": sha,
    }


def released(role: str, acquired: datetime, released_at: datetime) -> dict:
    return {
        "schemaVersion": 1,
        "state": "RELEASED",
        "owner": role,
        "leaseId": f"lease-{role.lower()}",
        "acquiredUtc": zulu(acquired),
        "expiresUtc": zulu(released_at),
        "releasedUtc": zulu(released_at),
    }


def merge(
    archive,
    current_status,
    at: datetime,
    *,
    previous_status=None,
    lease=None,
    basis="PUBLISHED_HEARTBEAT_UTC",
    certainty="EXACT_SOURCE_TIMESTAMP",
):
    return update_host_health_history(
        archive,
        previous_status=previous_status,
        current_status=current_status,
        lease=lease,
        now_z=at,
        healthy_minutes=HEALTHY_MINUTES,
        failover_minutes=FAILOVER_MINUTES,
        board_gap_minutes=BOARD_GAP_MINUTES,
        observation_timestamp_basis=basis,
        observation_timestamp_certainty=certainty,
    )


def open_interval(archive: dict, track: str) -> dict:
    return next(
        item
        for item in archive["intervals"]
        if item["track"] == track and item["endUtc"] is None
    )


class HostHealthHistoryTests(unittest.TestCase):
    def test_primary_healthy_and_recent_backup_standby_is_truthfully_unknown(self):
        backup = status("BACKUP", T0)
        archive = merge(None, backup, T0)
        primary_time = T0 + timedelta(minutes=5)
        archive = merge(
            archive,
            status("PRIMARY", primary_time),
            primary_time,
            lease=released("PRIMARY", primary_time - timedelta(seconds=20), primary_time),
        )

        self.assertEqual(archive["hosts"]["PRIMARY"]["healthState"], "HEALTHY")
        self.assertEqual(archive["hosts"]["PRIMARY"]["roleState"], "ACTIVE_PUBLISHER")
        self.assertEqual(archive["hosts"]["BACKUP"]["healthState"], "UNKNOWN")
        self.assertEqual(archive["hosts"]["BACKUP"]["lastObservedHealthState"], "HEALTHY")
        self.assertEqual(archive["hosts"]["BACKUP"]["roleState"], "STANDBY_NOT_OBSERVED")

    def test_no_intermediate_cycle_retroactively_records_host_and_board_boundaries(self):
        primary = status("PRIMARY", T0)
        backup_time = T0 + timedelta(minutes=35)
        observations = [
            {"observedUtc": zulu(T0), "status": primary},
            {
                "observedUtc": zulu(backup_time),
                "status": status("BACKUP", backup_time),
                "lease": released("BACKUP", backup_time - timedelta(seconds=19), backup_time),
            },
        ]
        archive = build_host_health_history_from_evidence(
            observations,
            healthy_minutes=HEALTHY_MINUTES,
            failover_minutes=FAILOVER_MINUTES,
            board_gap_minutes=BOARD_GAP_MINUTES,
        )

        primary_runs = [item for item in archive["intervals"] if item["track"] == "PRIMARY"]
        self.assertEqual([item["state"] for item in primary_runs], ["HEALTHY", "DELAYED", "STALE"])
        self.assertEqual(primary_runs[1]["startUtc"], "2026-09-09T05:50:57Z")
        self.assertEqual(primary_runs[1]["startTimestampBasis"], "HEALTHY_THRESHOLD_DERIVED")
        self.assertEqual(primary_runs[2]["startUtc"], "2026-09-09T06:00:57Z")
        self.assertEqual(
            primary_runs[2]["startTimestampCertainty"],
            "DERIVED_FROM_HEARTBEAT_AND_CONFIGURED_THRESHOLD",
        )
        board_runs = [item for item in archive["intervals"] if item["track"] == "BOARD_DELIVERY"]
        self.assertEqual(
            [item["state"] for item in board_runs],
            ["CONTINUOUS", "DELAYED", "GAP", "CONTINUOUS"],
        )
        self.assertEqual(board_runs[2]["startUtc"], "2026-09-09T06:05:57Z")
        self.assertEqual(
            board_runs[2]["startTimestampCertainty"],
            "DERIVED_FROM_PUBLISH_TIMESTAMPS_AND_THRESHOLD",
        )
        self.assertEqual(board_runs[2]["endUtc"], zulu(backup_time))
        self.assertEqual(
            sum(item["eventType"] == "BOARD_PUBLISH_RECOVERED" for item in archive["events"]),
            1,
        )

    def test_first_deployment_one_call_seeds_previous_status_and_full_failover_gap(self):
        backup_time = T0 + timedelta(minutes=35)
        archive = merge(
            None,
            status("BACKUP", backup_time),
            backup_time,
            previous_status=status("PRIMARY", T0),
            lease=released("BACKUP", backup_time - timedelta(seconds=19), backup_time),
        )
        self.assertEqual(
            [item["state"] for item in archive["intervals"] if item["track"] == "PRIMARY"],
            ["HEALTHY", "DELAYED", "STALE"],
        )
        self.assertEqual(
            [item["state"] for item in archive["intervals"] if item["track"] == "BOARD_DELIVERY"],
            ["CONTINUOUS", "DELAYED", "GAP", "CONTINUOUS"],
        )
        self.assertEqual(
            next(item for item in archive["events"] if item["eventType"] == "BACKUP_TAKEOVER")[
                "timestampUtc"
            ],
            zulu(backup_time - timedelta(seconds=19)),
        )

    def test_one_failed_archive_cycle_catches_up_without_false_delay_or_gap(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        published_while_telemetry_failed = T0 + timedelta(minutes=10)
        current = T0 + timedelta(minutes=20)

        archive = merge(
            archive,
            status("PRIMARY", current),
            current,
            previous_status=status("PRIMARY", published_while_telemetry_failed),
        )

        self.assertEqual(
            [item["state"] for item in archive["intervals"] if item["track"] == "PRIMARY"],
            ["HEALTHY"],
        )
        self.assertEqual(
            [item["state"] for item in archive["intervals"] if item["track"] == "BOARD_DELIVERY"],
            ["CONTINUOUS"],
        )
        self.assertFalse(any(item["eventType"] == "PRIMARY_RECOVERED" for item in archive["events"]))
        self.assertFalse(any(item["eventType"] == "BOARD_PUBLISH_GAP" for item in archive["events"]))

    def test_multi_cycle_telemetry_hole_is_unknown_not_a_fabricated_outage(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        last_published_status = T0 + timedelta(minutes=20)
        current = T0 + timedelta(minutes=30)

        archive = merge(
            archive,
            status("PRIMARY", current),
            current,
            previous_status=status("PRIMARY", last_published_status),
        )

        primary_runs = [item for item in archive["intervals"] if item["track"] == "PRIMARY"]
        board_runs = [item for item in archive["intervals"] if item["track"] == "BOARD_DELIVERY"]
        publisher_runs = [item for item in archive["intervals"] if item["track"] == "PUBLISHER"]
        self.assertEqual([item["state"] for item in primary_runs], ["HEALTHY", "UNKNOWN", "HEALTHY"])
        self.assertEqual(
            [item["state"] for item in board_runs],
            ["CONTINUOUS", "UNKNOWN", "CONTINUOUS"],
        )
        self.assertEqual([item["state"] for item in publisher_runs], ["PRIMARY", "UNKNOWN", "PRIMARY"])
        self.assertEqual(primary_runs[1]["startUtc"], zulu(T0 + timedelta(seconds=1)))
        self.assertEqual(primary_runs[1]["endUtc"], zulu(last_published_status))
        self.assertFalse(any(item["state"] == "GAP" for item in board_runs))
        self.assertFalse(any(item["eventType"] == "BOARD_PUBLISH_GAP" for item in archive["events"]))
        self.assertEqual(
            sum(item["eventType"] == "ARCHIVE_OBSERVATION_GAP" for item in archive["events"]),
            1,
        )
        self.assertEqual(
            sum(item["eventType"] == "ARCHIVE_OBSERVATION_RESUMED" for item in archive["events"]),
            1,
        )

    def test_backup_takeover_and_board_delivery_remain_separate(self):
        primary = status("PRIMARY", T0)
        archive = merge(None, primary, T0)
        takeover = T0 + timedelta(minutes=35)
        backup = status("BACKUP", takeover)
        acquired = takeover - timedelta(seconds=19)
        archive = merge(
            archive,
            backup,
            takeover,
            lease=released("BACKUP", acquired, takeover),
        )

        self.assertEqual(archive["current"]["publisher"]["role"], "BACKUP")
        self.assertEqual(archive["current"]["publisher"]["sinceUtc"], zulu(acquired))
        self.assertEqual(archive["current"]["publisher"]["reason"], "PRIMARY_HEARTBEAT_STALE")
        self.assertFalse(archive["current"]["publisher"]["rootCauseKnown"])
        self.assertEqual(archive["hosts"]["PRIMARY"]["healthState"], "STALE")
        self.assertEqual(
            archive["hosts"]["PRIMARY"]["roleState"],
            "PREFERRED_HOST_NOT_PUBLISHING",
        )
        self.assertEqual(archive["current"]["boardDelivery"]["state"], "CONTINUOUS")
        takeover_event = next(item for item in archive["events"] if item["eventType"] == "BACKUP_TAKEOVER")
        self.assertEqual(takeover_event["timestampUtc"], zulu(acquired))
        self.assertEqual(takeover_event["timestampBasis"], "LEASE_ACQUIRED_UTC")

    def test_primary_recovers_and_successful_handoff_is_recorded_once(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        backup_time = T0 + timedelta(minutes=35)
        archive = merge(
            archive,
            status("BACKUP", backup_time),
            backup_time,
            lease=released("BACKUP", backup_time - timedelta(seconds=20), backup_time),
        )
        recovery = backup_time + timedelta(minutes=10)
        archive = merge(
            archive,
            status("PRIMARY", recovery),
            recovery,
            lease=released("PRIMARY", recovery - timedelta(seconds=17), recovery),
        )
        archive = merge(archive, status("PRIMARY", recovery + timedelta(minutes=10)), recovery + timedelta(minutes=10))

        self.assertEqual(archive["hosts"]["PRIMARY"]["healthState"], "HEALTHY")
        self.assertEqual(archive["current"]["publisher"]["role"], "PRIMARY")
        self.assertEqual(archive["hosts"]["BACKUP"]["healthState"], "UNKNOWN")
        self.assertEqual(archive["hosts"]["BACKUP"]["roleState"], "STANDBY_NOT_OBSERVED")
        self.assertEqual(archive["hosts"]["BACKUP"]["lastObservedHealthState"], "HEALTHY")
        self.assertEqual(sum(item["eventType"] == "PRIMARY_RECOVERED" for item in archive["events"]), 1)
        self.assertEqual(sum(item["eventType"] == "PRIMARY_HANDOFF" for item in archive["events"]), 1)

    def test_routine_delayed_recovery_has_distinct_aggregatable_event_type(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        delayed = T0 + timedelta(minutes=HEALTHY_MINUTES, seconds=1)
        archive = merge(archive, status("PRIMARY", T0), delayed)
        recovered = delayed + timedelta(minutes=1)
        archive = merge(archive, status("PRIMARY", recovered), recovered)
        self.assertEqual(
            sum(item["eventType"] == "PRIMARY_DELAY_RECOVERED" for item in archive["events"]),
            1,
        )
        self.assertFalse(any(item["eventType"] == "PRIMARY_RECOVERED" for item in archive["events"]))
        self.assertEqual(
            sum(item["eventType"] == "BOARD_DELAY_RECOVERED" for item in archive["events"]),
            1,
        )
        self.assertFalse(
            any(item["eventType"] == "BOARD_PUBLISH_RECOVERED" for item in archive["events"])
        )

    def test_legacy_seed_migrates_and_preserves_exact_primary_handoff(self):
        archive = merge(None, status("BACKUP", T0), T0)
        for field in (
            "dailySummaries",
            "exactHistoryDays",
            "exactHistoryStartUtc",
            "summarizedThroughUtc",
            "summaryCoverageStartUtc",
            "retentionBoundaryGap",
            "storagePolicy",
        ):
            archive.pop(field, None)
        handoff_publish = T0 + timedelta(minutes=3)
        handoff_acquired = handoff_publish - timedelta(seconds=25)
        archive = merge(
            archive,
            status("PRIMARY", handoff_publish),
            handoff_publish,
            previous_status=status("BACKUP", T0),
            lease=released("PRIMARY", handoff_acquired, handoff_publish),
        )

        handoff = next(item for item in archive["events"] if item["eventType"] == "PRIMARY_HANDOFF")
        self.assertEqual(handoff["timestampUtc"], zulu(handoff_acquired))
        self.assertEqual(handoff["timestampBasis"], "LEASE_ACQUIRED_UTC")
        self.assertIn("dailySummaries", archive)
        self.assertEqual(archive["storagePolicy"]["mode"], "EXACT_RECENT_WITH_UTC_DAILY_AGGREGATES")

    def test_unavailable_preferred_primary_does_not_make_healthy_backup_delivery_unhealthy(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        archive["hosts"]["PRIMARY"]["lastHeartbeatUtc"] = zulu(T0 + timedelta(hours=2))
        backup_time = T0 + timedelta(minutes=35)
        archive = merge(archive, status("BACKUP", backup_time), backup_time)

        self.assertEqual(archive["hosts"]["PRIMARY"]["healthState"], "UNAVAILABLE")
        self.assertEqual(archive["hosts"]["PRIMARY"]["roleState"], "PREFERRED_HOST_NOT_PUBLISHING")
        self.assertEqual(archive["hosts"]["BACKUP"]["healthState"], "HEALTHY")
        self.assertEqual(archive["current"]["boardDelivery"]["state"], "CONTINUOUS")

    def test_updater_error_is_not_hidden_by_current_heartbeat(self):
        errored = status(
            "PRIMARY",
            T0,
            successful_update=T0 - timedelta(minutes=10),
            update_status="ERROR",
            error="WEATHER_GENERATION_FAILED",
        )
        archive = merge(None, errored, T0)
        self.assertEqual(archive["hosts"]["PRIMARY"]["healthState"], "ERROR")
        self.assertEqual(archive["hosts"]["PRIMARY"]["lastError"], "WEATHER_GENERATION_FAILED")
        self.assertEqual(archive["current"]["boardDelivery"]["state"], "CONTINUOUS")

    def test_board_gap_and_recovery_use_30_minute_display_contract(self):
        stale_publish = status("PRIMARY", T0, successful_update=T0)
        archive = merge(None, stale_publish, T0)
        gap_at = T0 + timedelta(minutes=BOARD_GAP_MINUTES, seconds=1)
        archive = merge(
            archive,
            stale_publish,
            gap_at,
            basis="BOARD_PUBLISH_GAP_THRESHOLD_DERIVED",
            certainty="DERIVED_FROM_PUBLISH_AND_CONFIGURED_THRESHOLD",
        )
        self.assertEqual(archive["current"]["boardDelivery"]["state"], "GAP")
        board_gap = open_interval(archive, "BOARD_DELIVERY")
        self.assertEqual(board_gap["startUtc"], zulu(gap_at))
        self.assertEqual(board_gap["startTimestampBasis"], "BOARD_PUBLISH_GAP_THRESHOLD_DERIVED")

        recovered = gap_at + timedelta(minutes=5)
        archive = merge(archive, status("BACKUP", recovered), recovered)
        self.assertEqual(archive["current"]["boardDelivery"]["state"], "CONTINUOUS")
        self.assertEqual(sum(item["eventType"] == "BOARD_PUBLISH_RECOVERED" for item in archive["events"]), 1)

    def test_same_publisher_recovery_after_35_minutes_preserves_the_gap(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        recovered = T0 + timedelta(minutes=35)
        archive = merge(archive, status("PRIMARY", recovered), recovered)
        board_runs = [item for item in archive["intervals"] if item["track"] == "BOARD_DELIVERY"]
        self.assertEqual(
            [item["state"] for item in board_runs],
            ["CONTINUOUS", "DELAYED", "GAP", "CONTINUOUS"],
        )
        self.assertEqual(
            board_runs[2]["startUtc"],
            zulu(T0 + timedelta(minutes=30, seconds=1)),
        )
        self.assertEqual(board_runs[2]["endUtc"], zulu(recovered))
        self.assertEqual(sum(item["eventType"] == "BOARD_PUBLISH_GAP" for item in archive["events"]), 1)
        self.assertEqual(sum(item["eventType"] == "BOARD_PUBLISH_RECOVERED" for item in archive["events"]), 1)

    def test_publish_interval_at_or_below_30_minutes_never_creates_a_gap(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        recovered = T0 + timedelta(minutes=20)
        archive = merge(archive, status("PRIMARY", recovered), recovered)
        self.assertFalse(any(item["state"] == "GAP" for item in archive["intervals"]))
        self.assertFalse(any(item["eventType"] == "BOARD_PUBLISH_GAP" for item in archive["events"]))

    def test_repeated_same_state_cycles_compress_intervals_and_events(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        initial_interval_count = len(archive["intervals"])
        initial_event_count = len(archive["events"])
        for minute in (5, 10, 15):
            at = T0 + timedelta(minutes=minute)
            archive = merge(archive, status("PRIMARY", at), at)
        self.assertEqual(len(archive["intervals"]), initial_interval_count)
        self.assertEqual(len(archive["events"]), initial_event_count)

    def test_duplicate_status_replay_does_not_create_history(self):
        current = status("PRIMARY", T0)
        archive = merge(None, current, T0)
        event_count = len(archive["events"])
        interval_count = len(archive["intervals"])
        replay = merge(archive, current, T0, lease=released("PRIMARY", T0 - timedelta(seconds=5), T0))
        self.assertEqual(len(replay["events"]), event_count)
        self.assertEqual(len(replay["intervals"]), interval_count)
        self.assertEqual(replay["current"]["lease"]["state"], "RELEASED")
        self.assertIsNone(replay["current"]["lease"]["activeOwner"])

    def test_out_of_order_replay_cannot_regress_current_lease_evidence(self):
        later = T0 + timedelta(minutes=10)
        current_lease = released("PRIMARY", later - timedelta(seconds=10), later)
        archive = merge(None, status("PRIMARY", later), later, lease=current_lease)
        replay = merge(
            archive,
            status("PRIMARY", T0),
            T0,
            lease=released("PRIMARY", T0 - timedelta(seconds=10), T0),
        )
        self.assertEqual(replay["updatedUtc"], zulu(later))
        self.assertEqual(replay["current"]["lease"]["observedUtc"], zulu(later))

    def test_exact_365_day_cutoff_clips_intervals_and_prunes_events(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        later = T0 + timedelta(days=366)
        archive = merge(archive, status("PRIMARY", later), later)
        cutoff = later - timedelta(days=365)
        self.assertGreater(archive["coverageStartUtc"], zulu(cutoff))
        self.assertTrue(archive["partialHistory"])
        self.assertEqual(archive["retentionBoundaryGap"]["startUtc"], zulu(cutoff))
        self.assertEqual(
            archive["retentionBoundaryGap"]["endUtc"],
            archive["coverageStartUtc"],
        )
        self.assertTrue(all(item["timestampUtc"] >= zulu(cutoff) for item in archive["events"]))
        self.assertTrue(all(item["startUtc"] >= archive["exactHistoryStartUtc"] for item in archive["intervals"]))
        self.assertTrue(
            all(item["dayStartUtc"] >= zulu(cutoff) for item in archive["dailySummaries"])
        )

    def test_daily_summary_with_an_entirely_missing_track_is_partial(self):
        now = datetime(2026, 9, 9, tzinfo=UTC)
        day_start = now - timedelta(days=4)
        archive = merge(None, status("PRIMARY", day_start), day_start)
        archive["updatedUtc"] = zulu(now)
        archive["intervals"] = []
        for track, state in (
            ("PRIMARY", "HEALTHY"),
            ("PUBLISHER", "PRIMARY"),
            ("BOARD_DELIVERY", "CONTINUOUS"),
        ):
            archive["intervals"].append(
                {
                    "track": track,
                    "host": track if track == "PRIMARY" else None,
                    "state": state,
                    "startUtc": zulu(day_start),
                    "endUtc": zulu(day_start + timedelta(days=1)),
                    "reason": "MISSING_TRACK_FIXTURE",
                    "sourceSha": "d" * 40,
                    "startTimestampBasis": "EXACT_FIXTURE_TIMESTAMP",
                    "startTimestampCertainty": "EXACT_SOURCE_TIMESTAMP",
                }
            )
        compacted = compact_host_health_history(archive, now_z=now)
        summary = next(item for item in compacted["dailySummaries"] if item["dateUtc"] == day_start.date().isoformat())
        self.assertTrue(summary["partialCoverage"])
        self.assertEqual(summary["tracks"]["BACKUP"]["observedSeconds"], 0)
        self.assertEqual(summary["tracks"]["BACKUP"]["knownSeconds"], 0)

    def test_high_churn_year_is_compacted_without_losing_state_duration_or_critical_events(self):
        now = datetime(2026, 9, 9, tzinfo=UTC)
        start = now - timedelta(days=365)
        archive = merge(None, status("PRIMARY", start), start)
        archive["archiveStartedUtc"] = zulu(start)
        archive["coverageStartUtc"] = zulu(start)
        archive["updatedUtc"] = zulu(now)
        archive["intervals"] = []
        archive["events"] = []

        track_states = {
            "PRIMARY": ("HEALTHY", "DELAYED"),
            "BACKUP": ("UNKNOWN", "HEALTHY"),
            "PUBLISHER": ("PRIMARY", "BACKUP"),
            "BOARD_DELIVERY": ("CONTINUOUS", "DELAYED"),
        }
        step = timedelta(minutes=30)
        for track, states in track_states.items():
            cursor = start
            index = 0
            while cursor < now:
                end = min(now, cursor + step)
                archive["intervals"].append(
                    {
                        "track": track,
                        "host": track if track in {"PRIMARY", "BACKUP"} else None,
                        "state": states[index % 2],
                        "startUtc": zulu(cursor),
                        "endUtc": zulu(end),
                        "reason": "DETERMINISTIC_HIGH_CHURN_FIXTURE",
                        "sourceSha": "c" * 40,
                        "startTimestampBasis": "EXACT_FIXTURE_TIMESTAMP",
                        "startTimestampCertainty": "EXACT_SOURCE_TIMESTAMP",
                    }
                )
                cursor = end
                index += 1

        event_types = (
            "BACKUP_TAKEOVER",
            "PRIMARY_HANDOFF",
            "BOARD_PUBLISH_GAP",
            "BOARD_PUBLISH_RECOVERED",
            "ACTIVE_PRIMARY",
            "ACTIVE_BACKUP",
            "PRIMARY_DELAYED",
            "PRIMARY_STALE",
            "PRIMARY_UNAVAILABLE",
            "PRIMARY_ERROR",
            "PRIMARY_RECOVERED",
            "BACKUP_DELAYED",
            "BACKUP_STALE",
            "BACKUP_UNAVAILABLE",
            "BACKUP_ERROR",
            "BACKUP_RECOVERED",
            "BOARD_DELAYED",
            "PRIMARY_DELAY_RECOVERED",
            "BACKUP_DELAY_RECOVERED",
            "BOARD_DELAY_RECOVERED",
            "PRIMARY_HEALTHY",
        )
        day = start
        while day < now:
            for hour, event_type in enumerate(event_types, start=1):
                archive["events"].append(
                    {
                        "eventType": event_type,
                        "timestampUtc": zulu(day + timedelta(hours=hour)),
                        "host": None,
                        "reason": "DETERMINISTIC_HIGH_CHURN_FIXTURE",
                        "publisher": "PRIMARY",
                        "sourceSha": "c" * 40,
                        "timestampBasis": "EXACT_FIXTURE_TIMESTAMP",
                        "timestampCertainty": "EXACT_SOURCE_TIMESTAMP",
                        "leaseOwner": None,
                    }
                )
            day += timedelta(days=1)

        original_rows = len(archive["intervals"]) + len(archive["events"])
        compacted = compact_host_health_history(archive, now_z=now)
        exact_cutoff = now - timedelta(days=2)
        summarized_seconds = int((exact_cutoff - start).total_seconds())
        self.assertGreater(original_rows, 70_000)
        self.assertEqual(compacted["exactHistoryStartUtc"], zulu(exact_cutoff))
        self.assertTrue(all(item["startUtc"] >= zulu(exact_cutoff) for item in compacted["intervals"]))
        self.assertTrue(all(item["dayEndUtc"] <= zulu(exact_cutoff) for item in compacted["dailySummaries"]))
        for track in track_states:
            observed = sum(
                item["tracks"].get(track, {}).get("observedSeconds", 0)
                for item in compacted["dailySummaries"]
            )
            state_total = sum(
                sum(item["tracks"].get(track, {}).get("durationsSeconds", {}).values())
                for item in compacted["dailySummaries"]
            )
            self.assertEqual(observed, summarized_seconds)
            self.assertEqual(state_total, summarized_seconds)

        old_day_count = int((exact_cutoff - start).total_seconds() // (24 * 60 * 60))
        self.assertEqual(
            sum(sum(item["eventCounts"].values()) for item in compacted["dailySummaries"]),
            old_day_count * len(event_types),
        )
        critical_exact = [
            item for item in compacted["events"] if item["eventType"] == "BACKUP_TAKEOVER"
        ]
        self.assertEqual(len(critical_exact), 365)
        self.assertTrue(
            all(item.get("includedInDailySummary") for item in critical_exact if item["timestampUtc"] < zulu(exact_cutoff))
        )
        routine_event_types = {
            "PRIMARY_HEALTHY",
            "PRIMARY_DELAYED",
            "BACKUP_DELAYED",
            "BOARD_DELAYED",
            "PRIMARY_DELAY_RECOVERED",
            "BACKUP_DELAY_RECOVERED",
            "BOARD_DELAY_RECOVERED",
        }
        for event_type in routine_event_types:
            self.assertFalse(
                any(
                    item["eventType"] == event_type and item["timestampUtc"] < zulu(exact_cutoff)
                    for item in compacted["events"]
                ),
                event_type,
            )
        for event_type in set(event_types) - routine_event_types:
            self.assertEqual(
                sum(item["eventType"] == event_type for item in compacted["events"]),
                365,
                event_type,
            )
        usage = validate_host_health_storage_budget(compacted)
        self.assertLess(usage["serializedBytes"], DEFAULT_MAX_SERIALIZED_BYTES)
        self.assertLess(usage["rowCount"], DEFAULT_MAX_STORED_ROWS)
        self.assertLess(usage["rowCount"], original_rows // 10)

    def test_storage_budget_checks_both_serialized_bytes_and_rows(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        usage = host_health_storage_usage(archive)
        self.assertGreater(usage["serializedBytes"], 0)
        self.assertGreater(usage["rowCount"], 0)
        with self.assertRaises(HostHealthHistoryError):
            validate_host_health_storage_budget(
                archive,
                max_serialized_bytes=usage["serializedBytes"] - 1,
            )
        row_heavy = deepcopy(archive)
        row_heavy["events"] = archive["events"] * 2
        with self.assertRaises(HostHealthHistoryError):
            validate_host_health_storage_budget(
                row_heavy,
                max_rows=len(row_heavy["intervals"]),
            )

    def test_archive_younger_than_one_year_is_explicitly_partial(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        later = T0 + timedelta(days=30)
        archive = merge(archive, status("PRIMARY", later), later)
        self.assertTrue(archive["partialHistory"])
        self.assertEqual(archive["archiveStartedUtc"], zulu(T0))
        self.assertEqual(archive["coverageStartUtc"], zulu(T0))
        self.assertFalse(any(item["startUtc"] < zulu(T0) for item in archive["intervals"]))

    def test_backup_then_primary_continues_one_archive_without_duplicates(self):
        archive = merge(None, status("PRIMARY", T0), T0)
        backup_at = T0 + timedelta(minutes=35)
        archive = merge(archive, status("BACKUP", backup_at), backup_at)
        primary_at = backup_at + timedelta(minutes=10)
        archive = merge(archive, status("PRIMARY", primary_at), primary_at)
        archive = merge(archive, status("PRIMARY", primary_at + timedelta(minutes=10)), primary_at + timedelta(minutes=10))
        publisher_states = [item["state"] for item in archive["intervals"] if item["track"] == "PUBLISHER"]
        self.assertEqual(publisher_states, ["PRIMARY", "BACKUP", "PRIMARY"])
        self.assertEqual(sum(item["eventType"] == "BACKUP_TAKEOVER" for item in archive["events"]), 1)
        self.assertEqual(sum(item["eventType"] == "PRIMARY_HANDOFF" for item in archive["events"]), 1)

    def test_seed_api_requires_explicit_unique_utc_evidence(self):
        with self.assertRaises(ValueError):
            build_host_health_history_from_evidence(
                [{"observedUtc": "not-utc", "status": status("PRIMARY", T0)}],
                healthy_minutes=HEALTHY_MINUTES,
                failover_minutes=FAILOVER_MINUTES,
                board_gap_minutes=BOARD_GAP_MINUTES,
            )
        with self.assertRaises(ValueError):
            build_host_health_history_from_evidence(
                [
                    {"observedUtc": zulu(T0), "status": status("PRIMARY", T0)},
                    {"observedUtc": zulu(T0), "status": status("PRIMARY", T0)},
                ],
                healthy_minutes=HEALTHY_MINUTES,
                failover_minutes=FAILOVER_MINUTES,
                board_gap_minutes=BOARD_GAP_MINUTES,
            )

    def test_current_released_lease_is_observation_not_control(self):
        release_time = T0 + timedelta(seconds=30)
        archive = merge(
            None,
            status("BACKUP", release_time),
            release_time,
            lease=released("BACKUP", T0, release_time),
        )
        self.assertEqual(archive["current"]["lease"]["state"], "RELEASED")
        self.assertIsNone(archive["current"]["lease"]["activeOwner"])
        self.assertEqual(archive["current"]["lease"]["lastOwner"], "BACKUP")
        self.assertNotIn("force", str(archive).lower())


if __name__ == "__main__":
    unittest.main()
