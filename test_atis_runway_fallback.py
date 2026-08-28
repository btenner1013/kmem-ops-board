#!/usr/bin/env python3
"""Deterministic tests for ATIS-primary RWY CLSD with NOTAM fallback."""

import copy
import unittest
from datetime import datetime, timedelta, timezone

import update_weather_local as weather


CURRENT_ATIS_WITH_CLOSURE = (
    "MEM ATIS INFO A 1154Z. 09005KT 10SM SCT250 25/20 A3000. "
    "VISUAL APCH IN USE RY 27. DEPG RWYS 27. RWY 27 CLSD. "
    "ADVS YOU HAVE INFO A."
)


def closure(number, runway, start="202608281100", end="202608281300", text=None):
    body = text or f"{number} RWY {runway} CLSD"
    return {
        "number": number,
        "text": body,
        "rawText": body,
        "effectiveStart": start,
        "effectiveEnd": end,
    }


def normalized_notams(
    records,
    fetch_status="OK",
    generated_z="2026-08-28 12:00:00Z",
    raw_status="Success",
):
    raw = {
        "status": raw_status,
        "runwayClosureNotams": records,
        "airportNotams": records,
    }
    if generated_z is not None:
        raw["generatedZ"] = generated_z
    result = weather.normalize_mil_notams_output(
        raw,
        fetch_status,
    )
    return result


class RunwayClosureFallbackTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
        self.current_ops = weather.parse_atis_operations(CURRENT_ATIS_WITH_CLOSURE, "OK")
        self.warn_ops = weather.parse_atis_operations(CURRENT_ATIS_WITH_CLOSURE, "WARN_SOURCE")
        self.stale_ops = weather.parse_atis_operations(CURRENT_ATIS_WITH_CLOSURE, "STALE_SOURCE")

    def feed_at(self, age_seconds=0, fetch_status="OK", raw_status="Success"):
        return {
            "milNotamUpdatedZ": (
                self.now - timedelta(seconds=age_seconds)
            ).strftime("%Y-%m-%d %H:%M:%SZ"),
            "milNotamFetchStatus": fetch_status,
            "milNotamRawStatus": raw_status,
        }

    def test_notam_classifier_uses_exact_30_and_60_minute_boundaries(self):
        cases = [
            (0, {"status": "OK", "detail": "", "age": 0}),
            (30 * 60, {"status": "OK", "detail": "", "age": 30}),
            (30 * 60 + 1, {"status": "WARN", "detail": "31M", "age": 31}),
            (60 * 60, {"status": "WARN", "detail": "60M", "age": 60}),
            (60 * 60 + 1, {"status": "STALE", "detail": "61M", "age": 61}),
        ]
        for age_seconds, expected in cases:
            with self.subTest(age_seconds=age_seconds):
                self.assertEqual(
                    weather.classify_notam_feed(
                        self.feed_at(age_seconds),
                        self.now,
                    ),
                    expected,
                )

    def test_notam_classifier_prioritizes_errors_over_cached_success(self):
        for fetch_status in ("SCRIPT_FAILED", "TIMEOUT", "ERROR", "NO_OUTPUT_JSON", "NO-OUTPUT", "NO OUTPUT"):
            with self.subTest(fetch_status=fetch_status):
                state = weather.classify_notam_feed(
                    self.feed_at(5 * 60, fetch_status),
                    self.now,
                )
                self.assertEqual(state["status"], "ERROR")
                self.assertEqual(state["detail"], fetch_status)

        raw_error = weather.classify_notam_feed(
            self.feed_at(5 * 60, raw_status="Source Error"),
            self.now,
        )
        self.assertEqual(raw_error["status"], "ERROR")
        self.assertEqual(raw_error["detail"], "SOURCE ERROR")

        raw_no_output = weather.classify_notam_feed(
            self.feed_at(5 * 60, raw_status="NO_OUTPUT_JSON"),
            self.now,
        )
        self.assertEqual(raw_no_output["status"], "ERROR")
        self.assertEqual(raw_no_output["detail"], "NO_OUTPUT_JSON")

    def test_notam_classifier_marks_non_current_or_unprovable_states_unavailable(self):
        for fetch_status in ("NO_DATA", "NO_CREDENTIALS", "NO_NMS_SCRIPT"):
            with self.subTest(fetch_status=fetch_status):
                state = weather.classify_notam_feed(
                    self.feed_at(5 * 60, fetch_status),
                    self.now,
                )
                self.assertEqual(state["status"], "UNAVAILABLE")
                self.assertEqual(state["detail"], fetch_status)

        for value, expected_detail in (
            (
                {
                    "milNotamUpdatedZ": "--",
                    "milNotamFetchStatus": "OK",
                    "milNotamRawStatus": "Success",
                },
                "TIME UNKNOWN",
            ),
            (
                {
                    "milNotamUpdatedZ": "not-a-time",
                    "milNotamFetchStatus": "OK",
                    "milNotamRawStatus": "Success",
                },
                "TIME UNKNOWN",
            ),
            (
                {
                    "milNotamUpdatedZ": (
                        self.now + timedelta(seconds=1)
                    ).strftime("%Y-%m-%d %H:%M:%SZ"),
                    "milNotamFetchStatus": "OK",
                    "milNotamRawStatus": "Success",
                },
                "FUTURE TIME",
            ),
            (
                self.feed_at(5 * 60, raw_status="UNKNOWN"),
                "UNKNOWN",
            ),
            (
                self.feed_at(5 * 60, raw_status="NO_PREVIOUS_DATA"),
                "NO_PREVIOUS_DATA",
            ),
        ):
            with self.subTest(value=value):
                state = weather.classify_notam_feed(value, self.now)
                self.assertEqual(state["status"], "UNAVAILABLE")
                self.assertEqual(state["detail"], expected_detail)

    def test_runway_fallback_trusts_only_ok_or_warn_notam_freshness(self):
        for age_seconds in (30 * 60, 60 * 60):
            with self.subTest(age_seconds=age_seconds):
                self.assertTrue(
                    weather.notam_feed_is_healthy(
                        self.feed_at(age_seconds),
                        self.now,
                    )
                )

        for data in (
            self.feed_at(60 * 60 + 1),
            self.feed_at(5 * 60, "TIMEOUT"),
            self.feed_at(5 * 60, "NO_CREDENTIALS"),
            {
                "milNotamUpdatedZ": "--",
                "milNotamFetchStatus": "OK",
                "milNotamRawStatus": "Success",
            },
        ):
            with self.subTest(data=data):
                self.assertFalse(weather.notam_feed_is_healthy(data, self.now))

    def test_runway_fallback_stops_after_the_60_minute_boundary(self):
        records = [closure("08/401", "18C")]
        at_sixty = normalized_notams(
            records,
            generated_z=(self.now - timedelta(minutes=60)).strftime(
                "%Y-%m-%d %H:%M:%SZ"
            ),
        )
        after_sixty = normalized_notams(
            records,
            generated_z=(self.now - timedelta(minutes=60, seconds=1)).strftime(
                "%Y-%m-%d %H:%M:%SZ"
            ),
        )

        self.assertEqual(
            weather.resolve_closed_runways(self.warn_ops, at_sixty, self.now),
            "18C",
        )
        self.assertEqual(
            weather.resolve_closed_runways(self.warn_ops, after_sixty, self.now),
            "UNKNOWN",
        )
        self.assertEqual(
            weather.resolve_closed_runways(self.current_ops, after_sixty, self.now),
            "27",
        )

    def test_missing_source_timestamp_is_not_replaced_with_current_time(self):
        notams = normalized_notams([], generated_z=None)
        self.assertEqual(notams["milNotamUpdatedZ"], "--")
        self.assertEqual(
            weather.classify_notam_feed(notams, self.now)["status"],
            "UNAVAILABLE",
        )

    def test_current_atis_closure_wins_over_notam(self):
        notams = normalized_notams([closure("08/401", "18C")])
        self.assertEqual(
            weather.resolve_closed_runways(self.current_ops, notams, self.now),
            "27",
        )

    def test_current_atis_none_wins_over_notam_closure(self):
        current_no_closure = weather.parse_atis_operations(
            CURRENT_ATIS_WITH_CLOSURE.replace(" RWY 27 CLSD.", ""),
            "OK",
        )
        notams = normalized_notams([closure("08/401", "18C")])
        self.assertEqual(
            weather.resolve_closed_runways(current_no_closure, notams, self.now),
            "NONE",
        )

    def test_warned_or_stale_atis_falls_back_to_active_closure(self):
        notams = normalized_notams([closure("08/401", "18C")])
        for ops in (self.warn_ops, self.stale_ops):
            with self.subTest(status=ops):
                self.assertEqual(
                    weather.resolve_closed_runways(ops, notams, self.now),
                    "18C",
                )

    def test_healthy_notam_feed_without_active_closure_returns_none(self):
        ignored = [
            closure("08/402", "18L", start="202608281300", end="202608281900"),
            closure("08/403", "36R", start="202608270100", end="202608280900"),
        ]
        self.assertEqual(
            weather.resolve_closed_runways(self.warn_ops, normalized_notams(ignored), self.now),
            "NONE",
        )

    def test_unavailable_or_untrusted_notam_feed_returns_unknown(self):
        unavailable_ops = weather.parse_atis_operations(
            "D-ATIS unavailable",
            "FAILED_NO_LAST_GOOD",
        )
        for fetch_status in ("NO_DATA", "NO_CREDENTIALS", "TIMEOUT", "ERROR"):
            with self.subTest(fetch_status=fetch_status):
                notams = normalized_notams([closure("08/401", "18C")], fetch_status)
                self.assertEqual(
                    weather.resolve_closed_runways(unavailable_ops, notams, self.now),
                    "UNKNOWN",
                )

    def test_multiple_active_runway_closures_are_combined_without_duplicates(self):
        notams = normalized_notams([
            closure("08/401", "18C/36C"),
            closure("08/404", "18L"),
            closure("08/405", "18C"),
        ])
        self.assertEqual(
            weather.resolve_closed_runways(self.warn_ops, notams, self.now),
            "18C / 36C / 18L",
        )

    def test_notamc_cancelled_closure_is_ignored_in_either_order(self):
        target = closure("08/401", "18C")
        cancellation = {
            "number": "08/402",
            "text": "08/402 NOTAMC 08/401 A) KMEM",
        }
        unrelated = closure("08/403", "18L")

        for records in ([target, cancellation, unrelated], [unrelated, cancellation, target]):
            with self.subTest(order=[item["number"] for item in records]):
                self.assertEqual(
                    weather.resolve_closed_runways(
                        self.warn_ops,
                        normalized_notams(records),
                        self.now,
                    ),
                    "18L",
                )

    def test_notamr_replacement_remains_and_superseded_closure_is_hidden(self):
        original = closure("M0100/26", "18C")
        replacement = closure(
            "M0101/26",
            "18L",
            text="M0101/26 NOTAMR M0100/26 RWY 18L CLSD",
        )
        unrelated = {"number": "M0200/26", "text": "MIL RAMP ARFF STATUS GREEN"}

        for records in ([original, replacement, unrelated], [unrelated, replacement, original]):
            with self.subTest(order=[item["number"] for item in records]):
                result = normalized_notams(records)
                self.assertEqual(
                    [item["number"] for item in result["runwayClosureNotams"]],
                    ["M0101/26"],
                )
                self.assertEqual(
                    weather.resolve_closed_runways(self.warn_ops, result, self.now),
                    "18L",
                )

    def test_replacement_cancellation_chain_is_order_independent(self):
        original = closure("M0100/26", "18C")
        first_replacement = closure(
            "M0101/26",
            "18L",
            text="M0101/26 NOTAMR M0100/26 RWY 18L CLSD",
        )
        second_replacement = closure(
            "M0102/26",
            "36R",
            text="M0102/26 NOTAMR M0101/26 RWY 36R CLSD",
        )
        cancellation = {
            "number": "M0103/26",
            "text": "M0103/26 NOTAMC M0102/26 A) KMEM",
        }
        unrelated = closure("M0200/26", "27")
        records = [
            original,
            first_replacement,
            second_replacement,
            cancellation,
            unrelated,
        ]

        for ordered in (records, list(reversed(records))):
            with self.subTest(order=[item["number"] for item in ordered]):
                result = normalized_notams(ordered)
                self.assertEqual(
                    weather.resolve_closed_runways(self.warn_ops, result, self.now),
                    "27",
                )

    def test_nonclosure_notams_do_not_manufacture_runway_closures(self):
        records = [
            {"number": "08/410", "text": "TWY A BTN RWY 18C AND TWY B CLSD"},
            {"number": "08/411", "text": "RWY 18C ALS U/S"},
            {"number": "08/412", "text": "CONSTRUCTION ADJ RWY 18C"},
            {"number": "08/413", "text": "RWY 18C FICON 5/5/5 WET"},
            {"number": "08/414", "text": "ILS RWY 18C U/S"},
            {"number": "08/415", "text": "RWY 18C SIGNAGE OBSC"},
        ]
        self.assertEqual(
            weather.resolve_closed_runways(self.warn_ops, normalized_notams(records), self.now),
            "NONE",
        )

    def test_fallback_never_changes_arrival_departure_or_flow(self):
        before = copy.deepcopy(self.warn_ops)
        result = weather.resolve_closed_runways(
            self.warn_ops,
            normalized_notams([closure("08/401", "18C")]),
            self.now,
        )

        self.assertEqual(result, "18C")
        self.assertEqual(self.warn_ops, before)
        self.assertEqual(self.warn_ops["arrRunways"], "--")
        self.assertEqual(self.warn_ops["depRunways"], "--")
        self.assertEqual(self.warn_ops["flow"], "--")


if __name__ == "__main__":
    unittest.main(verbosity=2)
