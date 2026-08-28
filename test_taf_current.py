#!/usr/bin/env python3
"""Focused tests for the supplemental same-origin current-TAF snapshot."""

import gzip
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from xml.sax.saxutils import escape

import taf_current as current
import update_weather_local as updater


UTC = timezone.utc
NOW = datetime(2026, 8, 28, 2, 0, tzinfo=UTC)


def taf_entry(
    *,
    station="KVOK",
    raw=(
        "TAF KVOK 280100Z 2801/2907 VRB06KT 9999 FEW060 "
        "QNH2999INS TX26/2820Z TN14/2811Z"
    ),
    issue="2026-08-28T01:00:00.000Z",
    valid_from="2026-08-28T01:00:00.000Z",
    valid_to="2026-08-29T07:00:00.000Z",
):
    return {
        "station": station,
        "raw": raw,
        "issue": issue,
        "valid_from": valid_from,
        "valid_to": valid_to,
    }


def compressed_cache(*entries):
    products = []
    for item in entries:
        products.append(
            "<TAF>"
            f"<raw_text>{escape(item['raw'])}</raw_text>"
            f"<station_id>{escape(item['station'])}</station_id>"
            f"<issue_time>{escape(item['issue'])}</issue_time>"
            f"<valid_time_from>{escape(item['valid_from'])}</valid_time_from>"
            f"<valid_time_to>{escape(item['valid_to'])}</valid_time_to>"
            "</TAF>"
        )
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<response><data num_results="{len(entries)}">'
        f"{''.join(products)}</data></response>"
    )
    return gzip.compress(xml.encode("utf-8"))


class TafCurrentParseTests(unittest.TestCase):
    def test_kvok_military_taf_is_preserved_with_stable_schema(self):
        raw = (
            "TAF KVOK 271700Z 2717/2823 VRB06KT 9999 FEW030 QNH3001INS\n"
            "BECMG 2800/2801 VRB06KT 9999 BKN060 QNH3000INS\n"
            "TX23/2719Z TN12/2811Z"
        )
        parsed = current.parse_awc_current_taf_cache(
            compressed_cache(
                taf_entry(
                    raw=raw,
                    issue="2026-08-27T17:00:00.000Z",
                    valid_from="2026-08-27T17:00:00.000Z",
                    valid_to="2026-08-28T23:00:00.000Z",
                )
            ),
            now_z=datetime(2026, 8, 27, 18, 0, tzinfo=UTC),
        )

        self.assertEqual(parsed.seen, 1)
        self.assertEqual(parsed.accepted, 1)
        self.assertEqual(parsed.rejected, 0)
        self.assertEqual(
            parsed.reports[0],
            {
                "station": "KVOK",
                "issueTime": "2026-08-27T17:00:00Z",
                "validTimeFrom": "2026-08-27T17:00:00Z",
                "validTimeTo": "2026-08-28T23:00:00Z",
                "variant": "",
                "raw": raw,
            },
        )

    def test_station_issue_and_validity_must_match_raw_header(self):
        good = taf_entry()
        mismatched_station = taf_entry(station="KMEM")
        mismatched_issue = taf_entry(issue="2026-08-28T01:01:00Z")
        mismatched_validity = taf_entry(valid_to="2026-08-29T08:00:00Z")
        invalid_station = taf_entry(station="KVO1")
        nil_product = taf_entry(raw="TAF KVOK 280100Z 2801/2907 NIL")
        expired = taf_entry(
            raw="TAF KJFK 270100Z 2701/2801 18005KT P6SM SCT050",
            station="KJFK",
            issue="2026-08-27T01:00:00Z",
            valid_from="2026-08-27T01:00:00Z",
            valid_to="2026-08-28T01:00:00Z",
        )
        parsed = current.parse_awc_current_taf_cache(
            compressed_cache(
                good,
                mismatched_station,
                mismatched_issue,
                mismatched_validity,
                invalid_station,
                nil_product,
                expired,
            ),
            now_z=NOW,
        )

        self.assertEqual([item["station"] for item in parsed.reports], ["KVOK"])
        self.assertEqual(parsed.accepted, 1)
        self.assertEqual(parsed.rejected, 6)

    def test_newest_station_issuance_wins_and_reports_sort_by_station(self):
        older = taf_entry(
            raw="TAF KVOK 271900Z 2719/2901 VRB05KT 9999 FEW050",
            issue="2026-08-27T19:00:00Z",
            valid_from="2026-08-27T19:00:00Z",
            valid_to="2026-08-29T01:00:00Z",
        )
        amendment = taf_entry(
            raw="TAF AMD KVOK 280100Z 2801/2907 VRB06KT 9999 BKN050",
        )
        routine_same_time = taf_entry(
            raw="TAF KVOK 280100Z 2801/2907 VRB06KT 9999 SCT050",
        )
        egll = taf_entry(
            station="EGLL",
            raw="TAF EGLL 272254Z 2800/2906 23008KT 9999 FEW045",
            issue="2026-08-27T22:54:00Z",
            valid_from="2026-08-28T00:00:00Z",
            valid_to="2026-08-29T06:00:00Z",
        )
        parsed = current.parse_awc_current_taf_cache(
            compressed_cache(older, routine_same_time, amendment, egll),
            now_z=NOW,
        )

        self.assertEqual([item["station"] for item in parsed.reports], ["EGLL", "KVOK"])
        self.assertEqual(parsed.reports[1]["variant"], "AMD")
        self.assertEqual(parsed.reports[1]["raw"], amendment["raw"])

    def test_dd24_validity_end_is_checked_across_utc_midnight(self):
        parsed = current.parse_awc_current_taf_cache(
            compressed_cache(
                taf_entry(
                    station="KMEM",
                    raw="TAF KMEM 272329Z 2800/2824 36008KT P6SM FEW060",
                    issue="2026-08-27T23:29:00Z",
                    valid_from="2026-08-28T00:00:00Z",
                    valid_to="2026-08-29T00:00:00Z",
                )
            ),
            now_z=NOW,
        )

        self.assertEqual(parsed.accepted, 1)
        self.assertEqual(parsed.reports[0]["validTimeTo"], "2026-08-29T00:00:00Z")

    def test_military_validity_only_header_uses_authoritative_awc_issue_time(self):
        raw = (
            "TAF AMD KNIP 2723/2823 16008KT 9999 VCTS BKN040CB BKN100 BKN250 "
            "QNH2995INS TEMPO 2723/2801 VRB25G35KT 4800 TSRA SCT015 BKN030CB "
            "OVC070 TX32/2819Z TN24/2811Z AMD 2325"
        )
        parsed = current.parse_awc_current_taf_cache(
            compressed_cache(
                taf_entry(
                    station="KNIP",
                    raw=raw,
                    issue="2026-08-27T23:30:00.000Z",
                    valid_from="2026-08-27T23:00:00.000Z",
                    valid_to="2026-08-28T23:00:00.000Z",
                )
            ),
            now_z=NOW,
        )

        self.assertEqual(parsed.accepted, 1)
        self.assertEqual(parsed.rejected, 0)
        self.assertEqual(parsed.reports[0]["station"], "KNIP")
        self.assertEqual(parsed.reports[0]["issueTime"], "2026-08-27T23:30:00Z")
        self.assertEqual(parsed.reports[0]["variant"], "AMD")
        self.assertEqual(parsed.reports[0]["raw"], raw)

    def test_malformed_gzip_xml_and_document_declarations_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "valid gzip"):
            current.parse_awc_current_taf_cache(b"not gzip", now_z=NOW)
        with self.assertRaisesRegex(ValueError, "XML was malformed"):
            current.parse_awc_current_taf_cache(gzip.compress(b"<broken>"), now_z=NOW)
        with self.assertRaisesRegex(ValueError, "prohibited"):
            current.parse_awc_current_taf_cache(
                gzip.compress(b"<!DOCTYPE response><response />"), now_z=NOW
            )


class TafCurrentFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "taf_current.json"
        self.cache = compressed_cache(taf_entry())

    def update(self, payload=None, **kwargs):
        cache = self.cache if payload is None else payload
        return current.maintain_taf_current(
            self.path,
            now_z=NOW,
            fetcher=lambda: cache,
            minimum_report_count=kwargs.pop("minimum_report_count", 1),
            **kwargs,
        )

    def test_first_valid_cache_creates_stable_public_payload(self):
        result = self.update()

        self.assertTrue(result.success)
        self.assertTrue(result.changed)
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(list(stored), ["schemaVersion", "sourcePolicy", "reports"])
        self.assertEqual(stored["schemaVersion"], 1)
        self.assertEqual(stored["sourcePolicy"], "NOAA_AWC_COMPLETE_CURRENT_CACHE")
        self.assertEqual(len(stored["reports"]), 1)
        self.assertNotIn("generatedZ", stored)
        self.assertNotIn("fetchedZ", stored)

    def test_unchanged_semantic_report_set_causes_no_write_or_timestamp_churn(self):
        first = self.update()
        self.assertTrue(first.changed)
        original = self.path.read_bytes()

        with mock.patch.object(
            current, "_atomic_write_json", side_effect=AssertionError("unexpected write")
        ) as writer:
            second = self.update()

        writer.assert_not_called()
        self.assertTrue(second.success)
        self.assertFalse(second.changed)
        self.assertEqual(self.path.read_bytes(), original)

    def test_fetch_or_parse_failure_preserves_previous_snapshot_byte_for_byte(self):
        self.assertTrue(self.update().success)
        original = self.path.read_bytes()

        result = self.update(b"not gzip")

        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("failed safely", result.error)
        self.assertEqual(self.path.read_bytes(), original)

    def test_suspiciously_partial_refresh_preserves_larger_previous_snapshot(self):
        second = taf_entry(
            station="EGLL",
            raw="TAF EGLL 272254Z 2800/2906 23008KT 9999 FEW045",
            issue="2026-08-27T22:54:00Z",
            valid_from="2026-08-28T00:00:00Z",
            valid_to="2026-08-29T06:00:00Z",
        )
        complete = compressed_cache(taf_entry(), second)
        self.assertTrue(self.update(complete).success)
        original = self.path.read_bytes()

        partial = self.update(self.cache)

        self.assertFalse(partial.success)
        self.assertIn("suspiciously partial", partial.error)
        self.assertEqual(self.path.read_bytes(), original)

    def test_atomic_replace_failure_is_isolated_and_cleans_temp_file(self):
        self.assertTrue(self.update().success)
        original = self.path.read_bytes()
        changed = compressed_cache(
            taf_entry(
                raw="TAF AMD KVOK 280130Z 2801/2907 VRB06KT 9999 BKN050",
                issue="2026-08-28T01:30:00Z",
            )
        )

        with mock.patch.object(current.os, "replace", side_effect=OSError("disk full")):
            result = self.update(changed)

        self.assertFalse(result.success)
        self.assertFalse(result.changed)
        self.assertIn("write failed safely", result.error)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.glob(".taf_current.json.*.tmp")), [])

    def test_default_completeness_floor_rejects_fixture_sized_partial_cache(self):
        result = current.maintain_taf_current(
            self.path,
            now_z=NOW,
            fetcher=lambda: self.cache,
        )

        self.assertFalse(result.success)
        self.assertIn("expected at least 500", result.error)
        self.assertFalse(self.path.exists())


class TafCurrentUpdaterIntegrationTests(unittest.TestCase):
    def test_supplemental_wrapper_passes_exact_path_and_isolates_maintainer_failure(self):
        calls = []

        def maintainer(path, **kwargs):
            calls.append((path, kwargs))
            return SimpleNamespace(
                success=False,
                changed=False,
                report_count=0,
                rejected=0,
                warning="",
                error="provider timeout",
            )

        result = updater.maintain_taf_current_safely(NOW, maintainer=maintainer)

        self.assertFalse(result.success)
        self.assertEqual(calls[0][0], updater.TAF_CURRENT_PATH)
        self.assertEqual(calls[0][1], {"now_z": NOW})

        def crashing_maintainer(*_args, **_kwargs):
            raise RuntimeError("supplemental failure")

        self.assertIsNone(
            updater.maintain_taf_current_safely(NOW, maintainer=crashing_maintainer)
        )

    def test_git_staging_names_taf_snapshot_exactly_without_broad_add(self):
        completed = SimpleNamespace(returncode=0)
        with mock.patch.object(updater.os.path, "exists", return_value=True), mock.patch.object(
            updater, "run_cmd", return_value=completed
        ) as run_cmd:
            updater.git_commit_and_push()

        commands = [call.args[0] for call in run_cmd.call_args_list]
        self.assertIn(["git", "add", "taf_current.json"], commands)
        self.assertNotIn(["git", "add", "."], commands)
        self.assertNotIn(["git", "add", "-A"], commands)

    def test_existing_ten_minute_cadence_remains_unchanged(self):
        self.assertEqual(updater.run_loop.__defaults__, (600,))


if __name__ == "__main__":
    unittest.main()
