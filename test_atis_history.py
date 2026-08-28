#!/usr/bin/env python3
"""Focused regression tests for the supplemental rolling KMEM D-ATIS archive."""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import atis_history as history


UTC = timezone.utc
NOW = datetime(2026, 8, 28, 0, 20, tzinfo=UTC)


def report(letter="S", hhmm="2354", variant=""):
    variant_text = f"{variant} " if variant else ""
    return (
        f"MEM {variant_text}ATIS INFO {letter} {hhmm}Z. "
        "01007KT 10SM FEW060 SCT200 BKN250 31/18 A2993. "
        "VISUAL APCH IN USE RY 36L. DEPG RWYS 36L 36C 36R. "
        f"ADVS YOU HAVE INFO {letter}."
    )


def live_candidate(
    *,
    letter="S",
    observed="2026-08-27T23:54:00Z",
    variant="COMBINED",
    raw=None,
    source="ATIS_INFO_API",
    first_seen="2026-08-28T00:00:00Z",
    is_live=True,
    is_fallback=False,
):
    return {
        "isLive": is_live,
        "isFallback": is_fallback,
        "station": "KMEM",
        "observedZ": observed,
        "letter": letter,
        "variant": variant,
        "raw": raw or report(letter, observed[11:13] + observed[14:16]),
        "firstSeenZ": first_seen,
        "source": source,
    }


def operational_validator(raw):
    """Small stand-in proving the production validator callback is honored."""

    return "A2993" in raw and "10SM" in raw and "ATIS INFO" in raw


class AtisHistoryMergeTests(unittest.TestCase):
    def test_first_valid_live_report_is_appended_with_stable_schema(self):
        result = history.merge_atis_history(
            {}, [live_candidate()], now_z=NOW, validator=operational_validator
        )

        self.assertEqual(result.appended, 1)
        self.assertEqual(result.rejected, 0)
        self.assertEqual(result.archive["schemaVersion"], 1)
        self.assertEqual(result.archive["station"], "KMEM")
        self.assertEqual(result.archive["retentionHours"], 96)
        self.assertEqual(result.archive["archiveStartedZ"], "2026-08-28T00:00:00Z")
        self.assertEqual(
            result.archive["records"][0],
            {
                "station": "KMEM",
                "observedZ": "2026-08-27T23:54:00Z",
                "letter": "S",
                "variant": "COMBINED",
                "raw": report(),
                "firstSeenZ": "2026-08-28T00:00:00Z",
                "sources": ["ATIS_INFO_API"],
            },
        )

    def test_identical_updater_observation_is_not_duplicated(self):
        first = history.merge_atis_history(
            {}, [live_candidate()], now_z=NOW, validator=operational_validator
        )
        repeated = live_candidate(first_seen="2026-08-28T00:10:00Z")
        second = history.merge_atis_history(
            first.archive, [repeated], now_z=NOW, validator=operational_validator
        )

        self.assertEqual(len(second.archive["records"]), 1)
        self.assertEqual(second.appended, 0)
        self.assertEqual(second.archive["records"][0]["firstSeenZ"], "2026-08-28T00:00:00Z")
        self.assertFalse(second.changed)

    def test_same_broadcast_from_two_providers_dedupes_and_merges_sources(self):
        first_raw = report()
        second_raw = first_raw.replace("MEM ATIS INFO", "KMEM ATIS INFORMATION")
        candidates = [
            live_candidate(raw=first_raw, source="ATIS_INFO_API"),
            live_candidate(raw=second_raw, source="ATIS_RELAY"),
        ]
        forward = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        )
        reverse = history.merge_atis_history(
            {}, reversed(candidates), now_z=NOW, validator=operational_validator
        )

        self.assertEqual(forward.archive, reverse.archive)
        self.assertEqual(len(forward.archive["records"]), 1)
        self.assertEqual(forward.deduplicated, 1)
        self.assertEqual(
            forward.archive["records"][0]["sources"],
            ["ATIS_INFO_API", "ATIS_RELAY"],
        )

    def test_arrival_variant_hint_dedupes_provider_header_wording(self):
        candidates = [
            live_candidate(
                variant="ARR",
                raw=report("S", "2354", "ARR"),
                source="ATIS_INFO_API",
            ),
            live_candidate(
                variant="ARR",
                raw=report("S", "2354").replace("MEM ATIS INFO", "KMEM ATIS INFORMATION"),
                source="ATIS_RELAY",
            ),
        ]
        result = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        )

        self.assertEqual(len(result.archive["records"]), 1)
        self.assertEqual(result.archive["records"][0]["variant"], "ARR")
        self.assertEqual(
            result.archive["records"][0]["sources"],
            ["ATIS_INFO_API", "ATIS_RELAY"],
        )

    def test_next_information_letter_is_appended(self):
        candidates = [
            live_candidate(),
            live_candidate(
                letter="T",
                observed="2026-08-28T00:04:00Z",
                first_seen="2026-08-28T00:10:00Z",
            ),
        ]
        result = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        )

        self.assertEqual([item["letter"] for item in result.archive["records"]], ["T", "S"])

    def test_z_to_a_rollover_is_ordered_by_full_utc_time_not_letter(self):
        candidates = [
            live_candidate(
                letter="Z",
                observed="2026-08-27T23:54:00Z",
                raw=report("Z", "2354"),
            ),
            live_candidate(
                letter="A",
                observed="2026-08-28T00:04:00Z",
                raw=report("A", "0004"),
                first_seen="2026-08-28T00:10:00Z",
            ),
        ]
        result = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        )

        self.assertEqual([item["letter"] for item in result.archive["records"]], ["A", "Z"])

    def test_arrival_and_departure_broadcasts_remain_distinct(self):
        candidates = [
            live_candidate(
                variant="ARR",
                raw=report("S", "2354", "ARR"),
                source="ATIS_INFO_API",
            ),
            live_candidate(
                variant="DEP",
                raw=report("S", "2354", "DEP").replace(
                    "VISUAL APCH IN USE RY 36L. ", ""
                ),
                source="ATIS_RELAY",
            ),
        ]
        result = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        )

        self.assertEqual(len(result.archive["records"]), 2)
        self.assertEqual(
            {item["variant"] for item in result.archive["records"]}, {"ARR", "DEP"}
        )

    def test_distinct_text_at_same_time_is_not_deduplicated(self):
        changed_runway = report().replace("RY 36L", "RY 27")
        result = history.merge_atis_history(
            {},
            [live_candidate(), live_candidate(raw=changed_runway, source="ATIS_RELAY")],
            now_z=NOW,
            validator=operational_validator,
        )

        self.assertEqual(len(result.archive["records"]), 2)

    def test_malformed_report_is_rejected_by_operational_validator(self):
        malformed = live_candidate(
            raw=(
                "MEM ATIS INFO S 2354Z. CORRUPT PAYLOAD WITHOUT USABLE WEATHER "
                "OR OPERATIONS. ADVS YOU HAVE INFO S."
            )
        )
        result = history.merge_atis_history(
            {}, [malformed], now_z=NOW, validator=operational_validator
        )

        self.assertEqual(result.rejected, 1)
        self.assertEqual(result.archive["records"], [])

    def test_corrupted_existing_record_is_removed_by_operational_validator(self):
        valid = history.merge_atis_history(
            {}, [live_candidate()], now_z=NOW, validator=operational_validator
        ).archive
        valid["records"][0]["raw"] = (
            "MEM ATIS INFO S 2354Z. CORRUPT ARCHIVED BODY WITHOUT USABLE "
            "WEATHER DATA. ADVS YOU HAVE INFO S."
        )

        repaired = history.merge_atis_history(
            valid, [], now_z=NOW, validator=operational_validator
        )

        self.assertEqual(repaired.archive["records"], [])
        self.assertIn("discarded 1 malformed archived record", repaired.warning)

    def test_fallback_or_unmarked_candidate_is_never_archived(self):
        candidates = [
            live_candidate(is_live=False),
            live_candidate(is_fallback=True),
            {key: value for key, value in live_candidate().items() if key != "isLive"},
        ]
        result = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        )

        self.assertEqual(result.rejected, 3)
        self.assertEqual(result.archive["records"], [])

    def test_records_older_than_96_hours_are_pruned_and_boundary_is_inclusive(self):
        cutoff = NOW - timedelta(hours=96)
        candidates = [
            live_candidate(
                letter="B",
                observed=(cutoff - timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                raw=report("B", (cutoff - timedelta(seconds=1)).strftime("%H%M")),
                first_seen="2026-08-24T00:19:59Z",
            ),
            live_candidate(
                letter="C",
                observed=cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
                raw=report("C", cutoff.strftime("%H%M")),
                first_seen="2026-08-24T00:20:00Z",
            ),
        ]
        result = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        )

        self.assertEqual(result.pruned, 1)
        self.assertEqual([item["letter"] for item in result.archive["records"]], ["C"])

    def test_pruned_live_candidate_does_not_claim_an_archive_start(self):
        old_observed = NOW - timedelta(hours=96, seconds=1)
        old = live_candidate(
            letter="B",
            observed=old_observed.strftime("%Y-%m-%dT%H:%M:%SZ"),
            raw=report("B", old_observed.strftime("%H%M")),
            first_seen=NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        result = history.merge_atis_history(
            {}, [old], now_z=NOW, validator=operational_validator
        )

        self.assertEqual(result.archive["records"], [])
        self.assertEqual(result.archive["archiveStartedZ"], "")

    def test_range_filter_is_inclusive_and_newest_first(self):
        candidates = [
            live_candidate(
                letter="R",
                observed="2026-08-27T22:00:00Z",
                raw=report("R", "2200"),
            ),
            live_candidate(),
            live_candidate(
                letter="T",
                observed="2026-08-28T00:10:00Z",
                raw=report("T", "0010"),
                first_seen="2026-08-28T00:11:00Z",
            ),
        ]
        archive = history.merge_atis_history(
            {}, candidates, now_z=NOW, validator=operational_validator
        ).archive
        selected = history.records_in_range(
            archive,
            start_z=datetime(2026, 8, 27, 23, 54, tzinfo=UTC),
            end_z=datetime(2026, 8, 28, 0, 10, tzinfo=UTC),
        )

        self.assertEqual([item["letter"] for item in selected], ["T", "S"])


class AtisHistoryFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "atis_history.json"

    def test_missing_archive_with_no_live_report_is_safe_and_not_created(self):
        result = history.maintain_atis_history(
            self.path, [], now_z=NOW, validator=operational_validator
        )

        self.assertTrue(result.success)
        self.assertFalse(result.changed)
        self.assertFalse(self.path.exists())

    def test_malformed_archive_recovers_when_a_valid_live_report_arrives(self):
        self.path.write_text("{broken", encoding="utf-8")
        result = history.maintain_atis_history(
            self.path, [live_candidate()], now_z=NOW, validator=operational_validator
        )

        self.assertTrue(result.success)
        self.assertTrue(result.changed)
        self.assertIn("unable to load ATIS history", result.warning)
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(len(stored["records"]), 1)

    def test_malformed_archive_without_live_data_is_left_untouched(self):
        original = b"{broken"
        self.path.write_bytes(original)
        result = history.maintain_atis_history(
            self.path, [], now_z=NOW, validator=operational_validator
        )

        self.assertTrue(result.success)
        self.assertFalse(result.changed)
        self.assertIn("unable to load ATIS history", result.warning)
        self.assertEqual(self.path.read_bytes(), original)

    def test_unchanged_observation_causes_no_atomic_write_or_file_churn(self):
        first = history.maintain_atis_history(
            self.path, [live_candidate()], now_z=NOW, validator=operational_validator
        )
        self.assertTrue(first.changed)
        original_bytes = self.path.read_bytes()

        with mock.patch.object(
            history, "_atomic_write_json", side_effect=AssertionError("unexpected write")
        ) as writer:
            second = history.maintain_atis_history(
                self.path,
                [live_candidate(first_seen="2026-08-28T00:10:00Z")],
                now_z=NOW,
                validator=operational_validator,
            )

        writer.assert_not_called()
        self.assertTrue(second.success)
        self.assertFalse(second.changed)
        self.assertEqual(self.path.read_bytes(), original_bytes)

    def test_atomic_write_failure_is_returned_without_breaking_caller(self):
        first = history.maintain_atis_history(
            self.path, [live_candidate()], now_z=NOW, validator=operational_validator
        )
        self.assertTrue(first.success)
        original_bytes = self.path.read_bytes()
        next_report = live_candidate(
            letter="T",
            observed="2026-08-28T00:04:00Z",
            raw=report("T", "0004"),
            first_seen="2026-08-28T00:10:00Z",
        )

        with mock.patch.object(history.os, "replace", side_effect=OSError("disk full")):
            result = history.maintain_atis_history(
                self.path, [next_report], now_z=NOW, validator=operational_validator
            )

        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("write failed safely", result.error)
        self.assertEqual(self.path.read_bytes(), original_bytes)
        self.assertEqual(list(self.path.parent.glob(".atis_history.json.*.tmp")), [])

    def test_archive_start_remains_the_first_truthful_observation_time(self):
        first = history.maintain_atis_history(
            self.path, [live_candidate()], now_z=NOW, validator=operational_validator
        )
        later_now = NOW + timedelta(minutes=20)
        next_report = live_candidate(
            letter="T",
            observed="2026-08-28T00:14:00Z",
            raw=report("T", "0014"),
            first_seen="2026-08-28T00:20:00Z",
        )
        second = history.maintain_atis_history(
            self.path,
            [next_report],
            now_z=later_now,
            validator=operational_validator,
        )

        self.assertTrue(first.success and second.success)
        self.assertEqual(second.archive["archiveStartedZ"], "2026-08-28T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
