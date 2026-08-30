#!/usr/bin/env python3
"""Focused tests for the supplemental rolling USAHAS AHAS-risk archive."""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import bwc_history as history


UTC = timezone.utc
NOW = datetime(2026, 8, 30, 3, 0, tzinfo=UTC)


def direct_candidate(
    *,
    risk="SEVERE",
    observed="2026-08-30 02:30:00.000",
    basis="NEXRAD",
    status="PARSED_DIRECT_XML",
    source="AHAS",
    fallback=False,
    station="KMEM",
):
    return {
        "station": station,
        "bwc": "NONE" if risk == "NO DATA" else risk,
        "bwcSource": source,
        "bwcUpdatedZ": observed,
        "bwcAhasRisk": risk,
        "bwcBasedOn": basis,
        "bwcFetchStatus": status,
        "isFallback": fallback,
    }


def zulu(value):
    base = value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
    if value.microsecond:
        return f"{base}.{value.microsecond:06d}".rstrip("0") + "Z"
    return base + "Z"


def candidate_at(value, **overrides):
    values = {
        "observed": zulu(value),
    }
    values.update(overrides)
    return direct_candidate(**values)


def first_archive(
    observed=datetime(2026, 8, 30, 2, 30, tzinfo=UTC),
    *,
    state="SEVERE",
    basis="NEXRAD",
    recorded=None,
):
    recorded = recorded or observed + timedelta(minutes=1)
    return history.merge_bwc_history(
        {},
        candidate_at(observed, risk=state, basis=basis),
        now_z=recorded,
    ).archive


class BwcCandidateValidationTests(unittest.TestCase):
    def test_direct_known_state_is_canonicalized_with_observed_provenance(self):
        result = history.validate_live_bwc_candidate(
            direct_candidate(), now_z=NOW
        )

        self.assertTrue(result.accepted)
        self.assertEqual(result.kind, "STATE")
        self.assertEqual(result.observation["state"], "SEVERE")
        self.assertEqual(result.observation["sourceObservedZ"], "2026-08-30T02:30:00Z")
        self.assertEqual(result.observation["source"], "USAHAS")
        self.assertEqual(result.observation["basis"], "NEXRAD")
        self.assertEqual(result.observation["basisClass"], "OBSERVED_OPERATIONAL")

    def test_model_basis_is_not_mislabeled_as_observed(self):
        for basis in ("SOAR", "NEXBAM", "BAM"):
            with self.subTest(basis=basis):
                result = history.validate_live_bwc_candidate(
                    direct_candidate(basis=basis), now_z=NOW
                )
                self.assertEqual(result.observation["basisClass"], "MODEL_OPERATIONAL")

    def test_raw_no_data_is_actionable_unknown_not_known_none(self):
        for raw_value in ("NO DATA", "--", "", "NA", "N/A"):
            with self.subTest(raw_value=raw_value):
                result = history.validate_live_bwc_candidate(
                    direct_candidate(risk=raw_value), now_z=NOW
                )

                self.assertTrue(result.accepted)
                self.assertEqual(result.kind, "NO_DATA")
                self.assertNotIn("state", result.observation)
                self.assertEqual(result.observation["rawAhasRisk"], "NO DATA")

    def test_pending_normalized_none_fallback_and_fetch_failure_are_rejected(self):
        cases = [
            direct_candidate(risk="PENDING"),
            direct_candidate(risk="NONE"),
            direct_candidate(fallback=True),
            direct_candidate(status="RISK_ENDPOINT_FAILED"),
            {
                **direct_candidate(),
                "lastKnownGoodUsed": {"ahas": True},
            },
        ]
        for candidate in cases:
            with self.subTest(candidate=candidate):
                result = history.validate_live_bwc_candidate(candidate, now_z=NOW)
                self.assertFalse(result.accepted)

    def test_ahas_timestamp_parser_is_strict_utc_and_handles_leap_day(self):
        accepted = [
            "2028-02-29 23:59:59.123",
            "2028-02-29T23:59:59Z",
            "2028-02-29T23:59:59.123456+00:00",
        ]
        rejected = [
            "2027-02-29 23:59:59.000",
            "2028-02-29T23:59Z",
            "2028-02-29T23:59:59-06:00",
            "29 FEB 2028 2359Z",
            "",
        ]
        for value in accepted:
            with self.subTest(accepted=value):
                self.assertIsNotNone(history.parse_ahas_utc(value))
        for value in rejected:
            with self.subTest(rejected=value):
                self.assertIsNone(history.parse_ahas_utc(value))

    def test_temporal_plausibility_accepts_two_minute_skew_but_not_more(self):
        accepted = history.validate_live_bwc_candidate(
            candidate_at(NOW + timedelta(minutes=2)), now_z=NOW
        )
        future = history.validate_live_bwc_candidate(
            candidate_at(NOW + timedelta(minutes=2, microseconds=1)), now_z=NOW
        )
        stale = history.validate_live_bwc_candidate(
            candidate_at(NOW - timedelta(minutes=90, microseconds=1)), now_z=NOW
        )

        self.assertTrue(accepted.accepted)
        self.assertFalse(future.accepted)
        self.assertFalse(stale.accepted)


class BwcHistoryMergeTests(unittest.TestCase):
    def test_first_valid_live_observation_creates_stable_schema(self):
        result = history.merge_bwc_history({}, direct_candidate(), now_z=NOW)

        self.assertTrue(result.changed)
        self.assertEqual(result.appended, 1)
        self.assertEqual(result.archive["schemaVersion"], 1)
        self.assertEqual(result.archive["station"], "KMEM")
        self.assertEqual(result.archive["product"], "USAHAS_AHAS_RISK")
        self.assertEqual(result.archive["retentionDays"], 365)
        self.assertEqual(result.archive["continuityMinutes"], 90)
        self.assertEqual(result.archive["collectionStartedZ"], "2026-08-30T03:00:00Z")
        self.assertEqual(result.archive["archiveUpdatedZ"], "2026-08-30T03:00:00Z")
        self.assertEqual(
            result.archive["runs"],
            [
                {
                    "kind": "STATE",
                    "state": "SEVERE",
                    "rawAhasRisk": "SEVERE",
                    "startZ": "2026-08-30T02:30:00Z",
                    "firstObservedZ": "2026-08-30T02:30:00Z",
                    "lastObservedZ": "2026-08-30T02:30:00Z",
                    "observationsZ": ["2026-08-30T02:30:00Z"],
                    "firstRecordedZ": "2026-08-30T03:00:00Z",
                    "lastRecordedZ": "2026-08-30T03:00:00Z",
                    "confirmationCount": 1,
                    "startReason": "ARCHIVE_START",
                    "source": "USAHAS",
                    "basis": "NEXRAD",
                    "basisClass": "OBSERVED_OPERATIONAL",
                }
            ],
        )

    def test_unknown_run_reason_evidence_contract_is_strict(self):
        base = first_archive(
            observed=datetime(2026, 8, 30, 0, 0, tzinfo=UTC),
            recorded=datetime(2026, 8, 30, 0, 1, tzinfo=UTC),
        )
        evidence = {
            "firstObservedZ": "2026-08-30T02:00:00Z",
            "lastObservedZ": "2026-08-30T02:00:00Z",
            "firstRecordedZ": "2026-08-30T02:01:00Z",
            "lastRecordedZ": "2026-08-30T02:01:00Z",
        }
        invalid_runs = {
            "source-no-data-without-evidence": {
                "kind": "UNKNOWN",
                "startZ": "2026-08-30T02:00:00Z",
                "endZ": "",
                "reason": "SOURCE_NO_DATA",
                "source": "USAHAS",
                "firstObservedZ": "",
                "lastObservedZ": "",
                "firstRecordedZ": "",
                "lastRecordedZ": "",
                "confirmationCount": 0,
            },
            "coverage-gap-with-observation-evidence": {
                "kind": "UNKNOWN",
                "startZ": "2026-08-30T02:00:00Z",
                "endZ": "2026-08-30T02:30:00Z",
                "reason": "COVERAGE_GAP",
                "source": "USAHAS",
                **evidence,
                "confirmationCount": 1,
            },
            "zero-length-coverage-gap": {
                "kind": "UNKNOWN",
                "startZ": "2026-08-30T02:00:00Z",
                "endZ": "2026-08-30T02:00:00Z",
                "reason": "COVERAGE_GAP",
                "source": "USAHAS",
                "firstObservedZ": "",
                "lastObservedZ": "",
                "firstRecordedZ": "",
                "lastRecordedZ": "",
                "confirmationCount": 0,
            },
        }

        for label, invalid_run in invalid_runs.items():
            with self.subTest(label=label):
                archive = json.loads(json.dumps(base))
                archive["runs"].append(invalid_run)
                with self.assertRaises(history.BwcHistoryFormatError):
                    history.merge_bwc_history(archive, None, now_z=NOW)

    def test_archive_rejects_non_carry_in_future_start_and_ambiguous_runs(self):
        base = first_archive(
            observed=datetime(2026, 8, 30, 0, 0, tzinfo=UTC),
            recorded=datetime(2026, 8, 30, 0, 1, tzinfo=UTC),
        )

        future_start = json.loads(json.dumps(base))
        future_start["runs"][0]["startZ"] = "2026-08-30T00:30:00Z"
        with self.assertRaises(history.BwcHistoryFormatError):
            history.merge_bwc_history(future_start, None, now_z=NOW)

        ambiguous = json.loads(json.dumps(base))
        duplicate = json.loads(json.dumps(ambiguous["runs"][0]))
        duplicate["state"] = "LOW"
        duplicate["rawAhasRisk"] = "LOW"
        duplicate["startReason"] = "STATE_CHANGE"
        ambiguous["runs"].append(duplicate)
        with self.assertRaises(history.BwcHistoryFormatError):
            history.merge_bwc_history(ambiguous, None, now_z=NOW)

    def test_fallback_cannot_create_or_extend_archive(self):
        empty = history.merge_bwc_history(
            {}, direct_candidate(fallback=True), now_z=NOW
        )
        existing = first_archive()
        unchanged = history.merge_bwc_history(
            existing,
            direct_candidate(
                observed="2026-08-30 02:36:00.000", fallback=True
            ),
            now_z=NOW,
        )

        self.assertFalse(empty.changed)
        self.assertEqual(empty.archive["runs"], [])
        self.assertEqual(empty.rejected, 1)
        self.assertFalse(unchanged.changed)
        self.assertEqual(unchanged.archive, existing)
        self.assertEqual(unchanged.archive["runs"][0]["confirmationCount"], 1)

    def test_direct_no_data_cannot_start_archive(self):
        result = history.merge_bwc_history(
            {}, direct_candidate(risk="NO DATA"), now_z=NOW
        )

        self.assertFalse(result.changed)
        self.assertEqual(result.archive["runs"], [])
        self.assertEqual(result.rejected, 1)
        self.assertIn("NO DATA cannot start", result.warning)

    def test_direct_no_data_creates_unknown_interval_never_none(self):
        existing = first_archive()
        result = history.merge_bwc_history(
            existing,
            direct_candidate(risk="NO DATA", observed="2026-08-30 02:36:00.000"),
            now_z=NOW,
        )

        self.assertTrue(result.changed)
        self.assertEqual(result.unknown_added, 1)
        unknown = result.archive["runs"][-1]
        self.assertEqual(unknown["kind"], "UNKNOWN")
        self.assertEqual(unknown["reason"], "SOURCE_NO_DATA")
        self.assertEqual(unknown["startZ"], "2026-08-30T02:36:00Z")
        self.assertEqual(unknown["endZ"], "")
        self.assertNotIn("observationsZ", unknown)
        self.assertNotIn("NONE", json.dumps(result.archive))

    def test_identical_source_observation_is_a_no_change_duplicate(self):
        existing = first_archive()
        result = history.merge_bwc_history(existing, direct_candidate(), now_z=NOW)

        self.assertFalse(result.changed)
        self.assertEqual(result.duplicates, 1)
        self.assertEqual(result.extended, 0)
        self.assertEqual(result.archive, existing)

    def test_same_state_and_basis_new_timestamp_extends_run(self):
        existing = first_archive()
        result = history.merge_bwc_history(
            existing,
            direct_candidate(observed="2026-08-30 02:36:00.000"),
            now_z=NOW,
        )

        self.assertEqual(len(result.archive["runs"]), 1)
        self.assertEqual(result.extended, 1)
        self.assertEqual(result.archive["runs"][0]["lastObservedZ"], "2026-08-30T02:36:00Z")
        self.assertEqual(result.archive["runs"][0]["confirmationCount"], 2)
        self.assertEqual(
            result.archive["runs"][0]["observationsZ"],
            ["2026-08-30T02:30:00Z", "2026-08-30T02:36:00Z"],
        )

    def test_legacy_state_run_upgrades_using_only_exact_stored_endpoints(self):
        existing = first_archive()
        existing = history.merge_bwc_history(
            existing,
            direct_candidate(observed="2026-08-30 02:36:00.000"),
            now_z=datetime(2026, 8, 30, 2, 37, tzinfo=UTC),
        ).archive
        existing = history.merge_bwc_history(
            existing,
            direct_candidate(observed="2026-08-30 02:42:00.000"),
            now_z=datetime(2026, 8, 30, 2, 43, tzinfo=UTC),
        ).archive
        del existing["runs"][0]["observationsZ"]

        result = history.merge_bwc_history(existing, None, now_z=NOW)
        run = result.archive["runs"][0]

        self.assertTrue(result.changed)
        self.assertEqual(run["confirmationCount"], 3)
        self.assertEqual(
            run["observationsZ"],
            ["2026-08-30T02:30:00Z", "2026-08-30T02:42:00Z"],
        )
        self.assertNotIn("2026-08-30T02:36:00Z", run["observationsZ"])

    def test_upgraded_legacy_run_appends_future_exact_observations(self):
        existing = first_archive()
        del existing["runs"][0]["observationsZ"]

        result = history.merge_bwc_history(
            existing,
            direct_candidate(observed="2026-08-30 02:36:00.000"),
            now_z=NOW,
        )

        self.assertEqual(result.extended, 1)
        self.assertEqual(
            result.archive["runs"][0]["observationsZ"],
            ["2026-08-30T02:30:00Z", "2026-08-30T02:36:00Z"],
        )

    def test_legacy_upgrade_does_not_reject_previously_valid_aggregate_count(self):
        existing = first_archive()
        run = existing["runs"][0]
        del run["observationsZ"]
        run["lastObservedZ"] = "2026-08-30T02:36:00Z"
        run["lastRecordedZ"] = "2026-08-30T02:37:00Z"
        existing["archiveUpdatedZ"] = "2026-08-30T02:37:00Z"

        result = history.merge_bwc_history(existing, None, now_z=NOW)

        self.assertEqual(result.archive["runs"][0]["confirmationCount"], 1)
        self.assertEqual(
            result.archive["runs"][0]["observationsZ"],
            ["2026-08-30T02:30:00Z", "2026-08-30T02:36:00Z"],
        )

    def test_state_observation_ledger_rejects_malformed_or_conflicting_evidence(self):
        valid = first_archive()
        malformed_values = {
            "not-a-list": "2026-08-30T02:30:00Z",
            "explicit-null": None,
            "empty": [],
            "duplicate": [
                "2026-08-30T02:30:00Z",
                "2026-08-30T02:30:00Z",
            ],
            "wrong-endpoint": ["2026-08-30T02:24:00Z"],
        }
        for label, observations in malformed_values.items():
            with self.subTest(label=label):
                archive = json.loads(json.dumps(valid))
                archive["runs"][0]["observationsZ"] = observations
                with self.assertRaises(history.BwcHistoryFormatError):
                    history.merge_bwc_history(archive, None, now_z=NOW)

    def test_state_change_begins_at_exact_source_timestamp(self):
        existing = first_archive(state="MODERATE")
        result = history.merge_bwc_history(
            existing,
            direct_candidate(risk="SEVERE", observed="2026-08-30 02:36:00.000"),
            now_z=NOW,
        )

        new_run = result.archive["runs"][-1]
        self.assertEqual(new_run["startReason"], "STATE_CHANGE")
        self.assertEqual(new_run["startZ"], "2026-08-30T02:36:00Z")
        self.assertEqual(new_run["state"], "SEVERE")
        self.assertEqual(new_run["observationsZ"], ["2026-08-30T02:36:00Z"])

    def test_basis_change_splits_provenance_without_state_change_reason(self):
        existing = first_archive(state="SEVERE", basis="NEXRAD")
        result = history.merge_bwc_history(
            existing,
            direct_candidate(
                risk="SEVERE",
                basis="SOAR",
                observed="2026-08-30 02:36:00.000",
            ),
            now_z=NOW,
        )

        self.assertEqual(len(result.archive["runs"]), 2)
        new_run = result.archive["runs"][-1]
        self.assertEqual(new_run["startReason"], "BASIS_CHANGE")
        self.assertEqual(new_run["basisClass"], "MODEL_OPERATIONAL")
        self.assertEqual(new_run["observationsZ"], ["2026-08-30T02:36:00Z"])
        self.assertNotEqual(new_run["startReason"], "STATE_CHANGE")

    def test_same_timestamp_conflict_is_rejected_and_first_value_preserved(self):
        existing = first_archive(state="MODERATE")
        result = history.merge_bwc_history(
            existing,
            direct_candidate(risk="SEVERE"),
            now_z=NOW,
        )

        self.assertFalse(result.changed)
        self.assertEqual(result.conflicts, 1)
        self.assertEqual(result.rejected, 1)
        self.assertEqual(result.archive["runs"][0]["state"], "MODERATE")

    def test_out_of_order_source_timestamp_is_rejected(self):
        existing = first_archive()
        result = history.merge_bwc_history(
            existing,
            direct_candidate(observed="2026-08-30 02:24:00.000"),
            now_z=NOW,
        )

        self.assertFalse(result.changed)
        self.assertEqual(result.out_of_order, 1)
        self.assertEqual(result.rejected, 1)

    def test_exactly_ninety_minutes_is_continuous(self):
        first_time = datetime(2026, 8, 30, 0, 0, tzinfo=UTC)
        existing = first_archive(first_time)
        second_time = first_time + timedelta(minutes=90)
        result = history.merge_bwc_history(
            existing,
            candidate_at(second_time),
            now_z=second_time + timedelta(minutes=1),
        )

        self.assertEqual(result.extended, 1)
        self.assertEqual(result.unknown_added, 0)
        self.assertEqual(len(result.archive["runs"]), 1)

    def test_same_state_after_greater_than_ninety_minute_gap_resumes_coverage(self):
        first_time = datetime(2026, 8, 30, 0, 0, tzinfo=UTC)
        existing = first_archive(first_time)
        second_time = first_time + timedelta(minutes=90, seconds=1)
        result = history.merge_bwc_history(
            existing,
            candidate_at(second_time),
            now_z=second_time + timedelta(minutes=1),
        )

        self.assertEqual([run["kind"] for run in result.archive["runs"]], ["STATE", "UNKNOWN", "STATE"])
        unknown = result.archive["runs"][1]
        resumed = result.archive["runs"][2]
        self.assertEqual(unknown["startZ"], "2026-08-30T01:30:00Z")
        self.assertEqual(unknown["endZ"], "2026-08-30T01:30:01Z")
        self.assertNotIn("observationsZ", unknown)
        self.assertEqual(resumed["startReason"], "COVERAGE_RESUMED")
        self.assertEqual(resumed["observationsZ"], [zulu(second_time)])

    def test_different_state_after_gap_is_first_observed_not_exact_change(self):
        first_time = datetime(2026, 8, 30, 0, 0, tzinfo=UTC)
        existing = first_archive(first_time, state="MODERATE")
        second_time = first_time + timedelta(hours=2)
        result = history.merge_bwc_history(
            existing,
            candidate_at(second_time, risk="SEVERE"),
            now_z=second_time + timedelta(minutes=1),
        )

        self.assertEqual(result.archive["runs"][-1]["startReason"], "STATE_AFTER_GAP")
        self.assertNotEqual(result.archive["runs"][-1]["startReason"], "STATE_CHANGE")

    def test_no_data_interval_extends_then_closes_on_valid_state(self):
        existing = first_archive(state="MODERATE")
        first_no_data = history.merge_bwc_history(
            existing,
            direct_candidate(risk="NO DATA", observed="2026-08-30 02:36:00.000"),
            now_z=NOW,
        )
        second_no_data = history.merge_bwc_history(
            first_no_data.archive,
            direct_candidate(risk="NO DATA", observed="2026-08-30 02:42:00.000"),
            now_z=NOW,
        )
        recovered = history.merge_bwc_history(
            second_no_data.archive,
            direct_candidate(risk="MODERATE", observed="2026-08-30 02:48:00.000"),
            now_z=NOW,
        )

        unknown = recovered.archive["runs"][-2]
        resumed = recovered.archive["runs"][-1]
        self.assertEqual(second_no_data.extended, 1)
        self.assertEqual(unknown["confirmationCount"], 2)
        self.assertEqual(unknown["endZ"], "2026-08-30T02:48:00Z")
        self.assertEqual(resumed["startReason"], "COVERAGE_RESUMED")

    def test_fetch_failure_does_not_extend_known_or_unknown_history(self):
        existing = first_archive()
        result = history.merge_bwc_history(
            existing,
            direct_candidate(status="RISK_ENDPOINT_FAILED"),
            now_z=NOW,
        )

        self.assertFalse(result.changed)
        self.assertEqual(result.archive, existing)
        self.assertEqual(result.archive["runs"][0]["confirmationCount"], 1)

    def test_midnight_month_year_and_leap_day_use_full_utc_chronology(self):
        boundaries = [
            (
                datetime(2026, 8, 31, 23, 58, tzinfo=UTC),
                datetime(2026, 9, 1, 0, 4, tzinfo=UTC),
            ),
            (
                datetime(2026, 12, 31, 23, 58, tzinfo=UTC),
                datetime(2027, 1, 1, 0, 4, tzinfo=UTC),
            ),
            (
                datetime(2028, 2, 28, 23, 58, tzinfo=UTC),
                datetime(2028, 2, 29, 0, 4, tzinfo=UTC),
            ),
        ]
        for first_time, second_time in boundaries:
            with self.subTest(first=first_time, second=second_time):
                existing = first_archive(first_time)
                result = history.merge_bwc_history(
                    existing,
                    candidate_at(second_time),
                    now_z=second_time + timedelta(minutes=1),
                )
                self.assertEqual(result.extended, 1)
                self.assertEqual(result.archive["runs"][0]["lastObservedZ"], zulu(second_time))


class BwcHistoryRetentionTests(unittest.TestCase):
    RETENTION_NOW = datetime(2026, 8, 30, 3, 0, tzinfo=UTC)

    def test_exactly_365_days_old_is_retained_inclusively(self):
        cutoff = self.RETENTION_NOW - timedelta(days=365)
        existing = first_archive(cutoff, recorded=cutoff + timedelta(minutes=1))
        result = history.merge_bwc_history(existing, None, now_z=self.RETENTION_NOW)

        self.assertEqual(result.pruned, 0)
        self.assertEqual(len(result.archive["runs"]), 1)
        self.assertEqual(result.archive["runs"][0]["lastObservedZ"], zulu(cutoff))
        self.assertEqual(result.archive["runs"][0]["observationsZ"], [zulu(cutoff)])

    def test_greater_than_365_days_old_is_pruned(self):
        cutoff = self.RETENTION_NOW - timedelta(days=365)
        old = cutoff - timedelta(minutes=90, microseconds=1)
        existing = first_archive(old, recorded=old + timedelta(minutes=1))
        result = history.merge_bwc_history(existing, None, now_z=self.RETENTION_NOW)

        self.assertEqual(result.pruned, 1)
        self.assertEqual(result.archive["runs"], [])

    def test_pre_cutoff_observation_with_usable_continuity_tail_is_carry_in(self):
        cutoff = self.RETENTION_NOW - timedelta(days=365)
        observed = cutoff - timedelta(minutes=30)
        existing = first_archive(observed, recorded=observed + timedelta(minutes=1))

        result = history.merge_bwc_history(existing, None, now_z=self.RETENTION_NOW)
        run = result.archive["runs"][0]

        self.assertEqual(result.pruned, 0)
        self.assertEqual(result.clipped, 1)
        self.assertEqual(run["startZ"], zulu(cutoff))
        self.assertEqual(run["firstObservedZ"], zulu(observed))
        self.assertEqual(run["lastObservedZ"], zulu(observed))
        self.assertEqual(run["observationsZ"], [])
        self.assertEqual(run["startReason"], "RETENTION_CARRY_IN")

    def test_aged_out_carry_in_rejects_nonempty_impossible_observation_ledger(self):
        cutoff = self.RETENTION_NOW - timedelta(days=365)
        observed = cutoff - timedelta(minutes=30)
        existing = first_archive(observed, recorded=observed + timedelta(minutes=1))
        carry_in = history.merge_bwc_history(
            existing, None, now_z=self.RETENTION_NOW
        ).archive
        carry_in["runs"][0]["observationsZ"] = [zulu(cutoff + timedelta(minutes=12))]

        with self.assertRaises(history.BwcHistoryFormatError):
            history.merge_bwc_history(carry_in, None, now_z=self.RETENTION_NOW)

    def test_state_run_crossing_cutoff_is_clipped_without_fabricated_observation(self):
        cutoff = self.RETENTION_NOW - timedelta(days=365)
        first_time = cutoff - timedelta(minutes=10)
        later_time = cutoff + timedelta(minutes=10)
        existing = first_archive(first_time, state="LOW", recorded=first_time + timedelta(minutes=1))
        existing = history.merge_bwc_history(
            existing,
            candidate_at(later_time, risk="LOW"),
            now_z=later_time + timedelta(minutes=1),
        ).archive

        result = history.merge_bwc_history(existing, None, now_z=self.RETENTION_NOW)
        run = result.archive["runs"][0]

        self.assertEqual(result.clipped, 1)
        self.assertEqual(run["startZ"], zulu(cutoff))
        self.assertEqual(run["firstObservedZ"], zulu(first_time))
        self.assertEqual(run["lastObservedZ"], zulu(later_time))
        self.assertEqual(run["observationsZ"], [zulu(later_time)])
        self.assertNotIn(zulu(cutoff), run["observationsZ"])
        self.assertEqual(run["startReason"], "RETENTION_CARRY_IN")
        self.assertEqual(run["originalStartReason"], "ARCHIVE_START")

    def test_unknown_interval_crossing_cutoff_is_clipped(self):
        cutoff = self.RETENTION_NOW - timedelta(days=365)
        first_time = cutoff - timedelta(minutes=100)
        next_time = cutoff + timedelta(minutes=10)
        existing = first_archive(first_time, recorded=first_time + timedelta(minutes=1))
        existing = history.merge_bwc_history(
            existing,
            candidate_at(next_time),
            now_z=next_time + timedelta(minutes=1),
        ).archive

        result = history.merge_bwc_history(existing, None, now_z=self.RETENTION_NOW)
        unknown = next(run for run in result.archive["runs"] if run["kind"] == "UNKNOWN")

        self.assertEqual(unknown["startZ"], zulu(cutoff))
        self.assertEqual(unknown["endZ"], zulu(next_time))
        self.assertTrue(unknown["carryIn"])


class BwcHistoryFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "bwc_history.json"

    def test_missing_archive_without_valid_live_state_is_not_created(self):
        for candidate in (None, direct_candidate(fallback=True), direct_candidate(risk="NO DATA")):
            with self.subTest(candidate=candidate):
                result = history.maintain_bwc_history(self.path, candidate, now_z=NOW)
                self.assertTrue(result.success)
                self.assertFalse(result.changed)
                self.assertFalse(self.path.exists())

    def test_first_valid_state_is_written_atomically(self):
        result = history.maintain_bwc_history(
            self.path, direct_candidate(), now_z=NOW
        )

        self.assertTrue(result.success)
        self.assertTrue(result.changed)
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(stored, result.archive)
        self.assertEqual(stored["runs"][0]["startReason"], "ARCHIVE_START")

    def test_duplicate_causes_no_atomic_write_or_file_churn(self):
        first = history.maintain_bwc_history(
            self.path, direct_candidate(), now_z=NOW
        )
        self.assertTrue(first.changed)
        original_bytes = self.path.read_bytes()

        with mock.patch.object(
            history, "_atomic_write_json", side_effect=AssertionError("unexpected write")
        ) as writer:
            second = history.maintain_bwc_history(
                self.path, direct_candidate(), now_z=NOW
            )

        writer.assert_not_called()
        self.assertTrue(second.success)
        self.assertFalse(second.changed)
        self.assertEqual(second.duplicates, 1)
        self.assertEqual(self.path.read_bytes(), original_bytes)

    def test_malformed_archive_recovers_only_from_valid_direct_state(self):
        self.path.write_text("{broken", encoding="utf-8")
        result = history.maintain_bwc_history(
            self.path, direct_candidate(), now_z=NOW
        )

        self.assertTrue(result.success)
        self.assertTrue(result.changed)
        self.assertIn("malformed BWC history", result.warning)
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(stored["runs"][0]["startReason"], "ARCHIVE_RECOVERY")

    def test_malformed_archive_without_valid_state_is_left_untouched(self):
        original = b"{broken"
        self.path.write_bytes(original)
        result = history.maintain_bwc_history(
            self.path, direct_candidate(risk="NO DATA"), now_z=NOW
        )

        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("no valid live state", result.error)
        self.assertEqual(self.path.read_bytes(), original)

    def test_unsupported_newer_schema_fails_closed_without_overwrite(self):
        original = json.dumps({"schemaVersion": 2, "runs": []}).encode("utf-8")
        self.path.write_bytes(original)
        result = history.maintain_bwc_history(
            self.path, direct_candidate(), now_z=NOW
        )

        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("schema 2", result.error)
        self.assertEqual(self.path.read_bytes(), original)

    def test_filesystem_read_failure_fails_closed_without_attempting_write(self):
        self.path.write_text("{}", encoding="utf-8")
        with mock.patch.object(
            history,
            "load_bwc_history",
            return_value=({}, "unable to load BWC history: access denied", True),
        ), mock.patch.object(
            Path, "read_bytes", side_effect=OSError("access denied")
        ), mock.patch.object(history, "_atomic_write_json") as writer:
            result = history.maintain_bwc_history(
                self.path, direct_candidate(), now_z=NOW
            )

        writer.assert_not_called()
        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("read failed safely", result.error)

    def test_atomic_replace_failure_leaves_old_archive_and_cleans_temp_file(self):
        first = history.maintain_bwc_history(
            self.path, direct_candidate(), now_z=NOW
        )
        self.assertTrue(first.success)
        original_bytes = self.path.read_bytes()

        with mock.patch.object(history.os, "replace", side_effect=OSError("disk full")):
            result = history.maintain_bwc_history(
                self.path,
                direct_candidate(observed="2026-08-30 02:36:00.000"),
                now_z=NOW,
            )

        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("write failed safely", result.error)
        self.assertEqual(self.path.read_bytes(), original_bytes)
        self.assertEqual(list(self.path.parent.glob(".bwc_history.json.*.tmp")), [])

    def test_unexpected_merge_error_is_returned_and_never_raised(self):
        with mock.patch.object(
            history, "merge_bwc_history", side_effect=RuntimeError("boom")
        ):
            result = history.maintain_bwc_history(
                self.path, direct_candidate(), now_z=NOW
            )

        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("failed safely", result.error)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
