#!/usr/bin/env python3
"""Regression tests for NOTAMC handling in the KMEM NOTAM pipeline."""

import unittest

import nms_kmem_mil_notams_test as nms
import update_weather_local as weather


CANCEL = {
    "number": "M0031/26",
    "text": "M0031/26 NOTAMC M0030/26 A) KMEM",
    "displayText": "M0031/26 NOTAMC M0030/26 A) KMEM",
}
TARGET = {
    "number": "M0030/26",
    "text": "MIL RAMP COMMS INOP",
    "displayText": "MIL RAMP COMMS INOP",
}
KEEP = {
    "number": "M0024/26",
    "text": "MIL RAMP ARFF STATUS YELLOW FOR MIL ACFT ONLY UNTIL FURTHER NOTICE",
    "displayText": "MIL RAMP ARFF STATUS YELLOW FOR MIL ACFT ONLY UFN",
}
ORIGINAL = {
    "number": "M0100/26",
    "text": "M0100/26 MIL RAMP COMMS INOP",
    "displayText": "MIL RAMP COMMS INOP",
}
REPLACEMENT = {
    "number": "M0101/26",
    "text": "M0101/26 NOTAMR M0100/26 MIL RAMP COMMS RESTORED UHF ONLY",
    "displayText": "NOTAMR M0100/26 MIL RAMP COMMS RESTORED UHF ONLY",
}
SECOND_REPLACEMENT = {
    "number": "M0102/26",
    "text": "M0102/26 NOTAMR M0101/26 MIL RAMP COMMS FULLY RESTORED",
    "displayText": "NOTAMR M0101/26 MIL RAMP COMMS FULLY RESTORED",
}
CANCEL_LATEST = {
    "number": "M0103/26",
    "text": "M0103/26 NOTAMC M0102/26 A) KMEM",
    "displayText": "M0103/26 NOTAMC M0102/26 A) KMEM",
}
UNRELATED = {
    "number": "M0200/26",
    "text": "M0200/26 MIL RAMP ARFF STATUS GREEN",
    "displayText": "MIL RAMP ARFF STATUS GREEN",
}


class NmsCancellationFilterTests(unittest.TestCase):
    def test_exact_notamc_is_parsed_and_canonicalized(self):
        self.assertTrue(nms.is_notam_cancellation(CANCEL))
        self.assertEqual(nms.notam_cancellation_target(CANCEL), "M0030/26")
        self.assertEqual(nms.canonical_notam_number("m 30 / 26"), "M0030/26")

    def test_cancellation_and_target_are_removed_in_any_order(self):
        for records in (
            [TARGET, KEEP, CANCEL],
            [CANCEL, KEEP, TARGET],
        ):
            with self.subTest(records=[item["number"] for item in records]):
                filtered = nms.filter_inactive_notam_records(records)
                self.assertEqual([item["number"] for item in filtered], ["M0024/26"])

    def test_replacement_remains_visible_and_superseded_notam_is_removed(self):
        self.assertFalse(nms.is_notam_cancellation(REPLACEMENT))
        self.assertTrue(nms.is_notam_replacement(REPLACEMENT))
        self.assertEqual(nms.notam_replacement_target(REPLACEMENT), "M0100/26")
        self.assertEqual(
            [item["number"] for item in nms.filter_inactive_notam_records(
                [ORIGINAL, REPLACEMENT, UNRELATED]
            )],
            ["M0101/26", "M0200/26"],
        )

    def test_replacement_and_cancellation_chains_are_order_independent(self):
        cases = (
            (
                [ORIGINAL, REPLACEMENT, SECOND_REPLACEMENT, UNRELATED],
                ["M0102/26", "M0200/26"],
            ),
            (
                [UNRELATED, CANCEL_LATEST, SECOND_REPLACEMENT, REPLACEMENT, ORIGINAL],
                ["M0200/26"],
            ),
        )

        for records, expected in cases:
            with self.subTest(records=[item["number"] for item in records]):
                self.assertEqual(
                    [item["number"] for item in nms.filter_inactive_notam_records(records)],
                    expected,
                )

    def test_local_domestic_cancellation_number_is_applied(self):
        cancel = {"number": "08/369", "text": "08/369 NOTAMC 08/368 A) KMEM"}
        target = {"number": "08/368", "text": "RWY 18C CLSD"}
        keep = {"number": "08/370", "text": "RWY 18L CLSD"}

        self.assertEqual(nms.canonical_notam_number("8 / 368"), "08/368")
        self.assertEqual(nms.notam_cancellation_target(cancel), "08/368")
        self.assertEqual(
            [item["number"] for item in nms.filter_inactive_notam_records([target, keep, cancel])],
            ["08/370"],
        )


class WeatherCancellationFilterTests(unittest.TestCase):
    def test_normalizer_recomputes_count_status_and_scroll(self):
        raw = {
            "source": "FAA_NMS_STAGING",
            "milNotamCount": 99,
            "milNotamStatus": "99 ACTIVE",
            "milNotamScrollText": "STALE CANCELLATION TEXT",
            "milNotams": [TARGET, KEEP, CANCEL],
        }

        result = weather.normalize_mil_notams_output(raw)

        self.assertEqual([item["number"] for item in result["milNotams"]], ["M0024/26"])
        self.assertEqual(result["milNotamCount"], 1)
        self.assertEqual(result["milNotamStatus"], "1 ACTIVE")
        self.assertEqual(
            result["milNotamScrollText"],
            "M0024/26 MIL RAMP ARFF STATUS YELLOW FOR MIL ACFT ONLY UFN",
        )

    def test_empty_after_cancellation_reports_none_active(self):
        result = weather.normalize_mil_notams_output({"milNotams": [TARGET, CANCEL]})

        self.assertEqual(result["milNotams"], [])
        self.assertEqual(result["milNotamCount"], 0)
        self.assertEqual(result["milNotamStatus"], "NONE ACTIVE")
        self.assertEqual(result["milNotamScrollText"], "")

    def test_cancellation_in_one_list_suppresses_target_in_every_category(self):
        raw = {
            "milNotams": [CANCEL, KEEP],
            "ficonNotams": [
                {"number": "M0030/26", "text": "RWY 18C FICON 3/3/3"},
                {"number": "M0040/26", "text": "RWY 18C FICON 5/5/5"},
            ],
            "runwayClosureNotams": [
                {"number": "M0030/26", "text": "RWY 18C CLSD"},
                {"number": "M0041/26", "text": "RWY 18L CLSD"},
            ],
            "constructionStatusNotams": [
                {"number": "M0030/26", "text": "MIL RAMP CONSTRUCTION"},
                {"number": "M0042/26", "text": "MIL RAMP WIP"},
            ],
            "taxiRestrictionNotams": [
                {"number": "M0030/26", "text": "TWY A CLSD"},
                {"number": "M0043/26", "text": "TWY B CLSD"},
            ],
        }

        result = weather.normalize_mil_notams_output(raw)

        expected = {
            "milNotams": "M0024/26",
            "ficonNotams": "M0040/26",
            "runwayClosureNotams": "M0041/26",
            "constructionStatusNotams": "M0042/26",
            "taxiRestrictionNotams": "M0043/26",
        }
        for key, number in expected.items():
            with self.subTest(key=key):
                self.assertEqual([item["number"] for item in result[key]], [number])

        self.assertEqual(result["milNotamCount"], 1)
        self.assertEqual(result["ficonNotamCount"], 1)
        self.assertEqual(result["runwayClosureNotamCount"], 1)
        self.assertEqual(result["constructionStatusNotamCount"], 1)
        self.assertEqual(result["taxiRestrictionNotamCount"], 1)

    def test_stale_cache_path_is_sanitized_too(self):
        previous = {
            "milNotamCount": 3,
            "milNotamStatus": "3 ACTIVE",
            "milNotamScrollText": "INCLUDES NOTAMC",
            "milNotams": [TARGET, KEEP, CANCEL],
            "milNotamSource": "FAA_NMS_STAGING",
            "milNotamUpdatedZ": "2026-08-27 02:26:48Z",
            "milNotamRawStatus": "Success",
        }

        result = weather.previous_mil_notams_or_default(previous, "NO_CREDENTIALS")

        self.assertEqual([item["number"] for item in result["milNotams"]], ["M0024/26"])
        self.assertEqual(result["milNotamCount"], 1)
        self.assertNotIn("NOTAMC", result["milNotamScrollText"])
        self.assertEqual(result["milNotamFetchStatus"], "NO_CREDENTIALS")

    def test_normalizer_keeps_latest_replacement_and_unrelated_notam(self):
        result = weather.normalize_mil_notams_output({
            "milNotams": [ORIGINAL, REPLACEMENT, SECOND_REPLACEMENT, UNRELATED],
        })

        self.assertEqual(
            [item["number"] for item in result["milNotams"]],
            ["M0102/26", "M0200/26"],
        )
        self.assertEqual(result["milNotamCount"], 2)
        self.assertEqual(result["milNotamStatus"], "2 ACTIVE")
        self.assertIn("M0102/26", result["milNotamScrollText"])
        self.assertIn("M0200/26", result["milNotamScrollText"])
        scroll_entries = result["milNotamScrollText"].split("  |  ")
        self.assertFalse(any(entry.startswith("M0100/26 ") for entry in scroll_entries))
        self.assertFalse(any(entry.startswith("M0101/26 ") for entry in scroll_entries))

    def test_normalizer_cancellation_of_latest_does_not_resurrect_chain(self):
        result = weather.normalize_mil_notams_output({
            "milNotams": [
                UNRELATED,
                CANCEL_LATEST,
                SECOND_REPLACEMENT,
                REPLACEMENT,
                ORIGINAL,
            ],
        })

        self.assertEqual(
            [item["number"] for item in result["milNotams"]],
            ["M0200/26"],
        )
        self.assertEqual(result["milNotamCount"], 1)
        self.assertEqual(result["milNotamStatus"], "1 ACTIVE")
        self.assertEqual(result["milNotamScrollText"], "M0200/26 MIL RAMP ARFF STATUS GREEN")

    def test_local_cancellation_in_airport_list_suppresses_runway_target(self):
        raw = {
            "airportNotams": [
                {"number": "08/369", "text": "08/369 NOTAMC 08/368 A) KMEM"},
            ],
            "runwayClosureNotams": [
                {"number": "08/368", "text": "RWY 18C CLSD"},
                {"number": "08/370", "text": "RWY 18L CLSD"},
            ],
        }

        result = weather.normalize_mil_notams_output(raw)

        self.assertEqual(
            [item["number"] for item in result["runwayClosureNotams"]],
            ["08/370"],
        )
        self.assertEqual(result["runwayClosureNotamCount"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
