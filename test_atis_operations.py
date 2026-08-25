#!/usr/bin/env python3
"""Regression tests for KMEM D-ATIS selection and active-runway parsing."""

import unittest
from datetime import datetime, timezone
from unittest import mock

import update_weather_local as u


FULL_ZULU_ATIS = (
    "MEM ATIS INFO Z 0854Z. 07004KT 10SM SCT250 28/23 A2997 "
    "(TWO NINER NINER SEVEN). VISUAL APCH IN USE RY 27. "
    "SIMUL DEPS IN USE RY 18R 18C 18L, DEPG RWYS 27. NOTICE TO AIRMEN. "
    "RY 27 ALS OTS. RWY 18R RAILS OTS. RWY 27 RAILS OTS. "
    "BIRD ACTIVITY RPTD IN THE VC OF THE ARPT. "
    "HAZD WX INFO FOR MEM AREA AVBL FM FSS. "
    "READBACK ALL RWY HOLD SHORT INSTRUCTIONS. "
    "CONSOLIDATED WAKE TURBULENCE STANDARDS IN EFFECT. 222' CRANE IS DOWN. "
    "UNAUTH LASER ILLUMINATION EVENT. AT 0915Z, 5 MI SW, 035 FEET GREEN LASER, "
    "FROM THE 5 MI SW. AT GATES 18, 20, 22, 23, 40 CTC GC FOR PUSHBACK. "
    "ADVS YOU HAVE INFO Z."
)


def atis(letter, time_z, runway="27"):
    return (
        f"MEM ATIS INFO {letter} {time_z}. 09005KT 10SM SCT250 25/20 A3000. "
        f"VISUAL APCH IN USE RY {runway}. DEPG RWYS {runway}. "
        f"ADVS YOU HAVE INFO {letter}."
    )


class AtisOperationsTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 21, 10, 18, tzinfo=timezone.utc)

    def test_exact_zulu_broadcast_parses_all_active_runways(self):
        self.assertEqual(u.parse_atis_letter(FULL_ZULU_ATIS), "Z")
        self.assertEqual(u.phonetic_for_letter("Z"), "ZULU")
        self.assertEqual(
            u.parse_atis_datetime_utc(FULL_ZULU_ATIS, self.now),
            datetime(2026, 8, 21, 8, 54, tzinfo=timezone.utc),
        )
        self.assertEqual(u.parse_arr_runways(FULL_ZULU_ATIS), "27")
        self.assertEqual(u.parse_dep_runways(FULL_ZULU_ATIS), "18R / 18C / 18L / 27")
        self.assertEqual(
            u.determine_flow(
                u.parse_arr_runways(FULL_ZULU_ATIS),
                u.parse_dep_runways(FULL_ZULU_ATIS),
            ),
            "MIXED",
        )
        self.assertEqual(u.parse_closed_runways(FULL_ZULU_ATIS), "NONE")

    def test_newest_report_wins_regardless_of_source_order(self):
        old_zulu = atis("Z", "0854Z")
        new_alpha = atis("A", "0954Z", "18C")
        for candidates in ([old_zulu, new_alpha], [new_alpha, old_zulu]):
            selected = u.choose_latest_atis_report(candidates, self.now)
            self.assertEqual(u.parse_atis_letter(selected), "A")

    def test_fetcher_checks_all_sources_before_selecting(self):
        old_zulu = atis("Z", "0854Z")
        new_alpha = atis("A", "0954Z", "18C")
        with mock.patch.object(u, "fetch_atis_info_api_candidates", return_value=[old_zulu]):
            with mock.patch.object(u, "fetch_url", side_effect=[new_alpha, old_zulu]) as fetch:
                selected = u.fetch_current_atis(
                    ["https://relay.test/cache-busted", "https://relay.test/plain"],
                    self.now,
                )
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(u.parse_atis_letter(selected), "A")

    def test_known_header_time_beats_unknown_notice_time(self):
        unknown_header = (
            "MEM ATIS INFO Z. VISUAL APCH IN USE RY 27. DEPG RWYS 27. "
            "UNAUTH LASER EVENT AT 0915Z 5 MI SW. ADVS YOU HAVE INFO Z."
        )
        known_header = atis("Y", "0854Z")
        self.assertIsNone(u.parse_atis_datetime_utc(unknown_header, self.now))
        selected = u.choose_latest_atis_report([unknown_header, known_header], self.now)
        self.assertEqual(u.parse_atis_letter(selected), "Y")
        self.assertEqual(
            u.parse_atis_datetime_utc(selected, self.now),
            datetime(2026, 8, 21, 8, 54, tzinfo=timezone.utc),
        )

    def test_midnight_rollover_chooses_new_day_report(self):
        now = datetime(2026, 8, 22, 1, 5, tzinfo=timezone.utc)
        before_midnight = atis("Z", "2354Z")
        after_midnight = atis("A", "0054Z", "18C")
        selected = u.choose_latest_atis_report([before_midnight, after_midnight], now)
        self.assertEqual(u.parse_atis_letter(selected), "A")

    def test_unchanged_report_keeps_persisted_date_after_24_hours(self):
        old_zulu = atis("Z", "0854Z")
        now = datetime(2026, 8, 22, 9, 0, tzinfo=timezone.utc)
        persisted = datetime(2026, 8, 21, 8, 54, tzinfo=timezone.utc)
        observed = u.resolve_atis_observed_datetime(old_zulu, now, {old_zulu: persisted})
        self.assertEqual(observed, persisted)
        age = u.source_age_minutes(observed, now)
        self.assertEqual(age, 1446)
        self.assertEqual(u.freshness_status("OK", age, 60, 90), "STALE_SOURCE")

    def test_same_header_identity_keeps_date_across_source_wording(self):
        old_zulu = atis("Z", "0854Z")
        relay_variant = (
            "KMEM ATIS INFORMATION Z 0854Z. WIND 090 AT 05. VISUAL APCH IN USE RY 27. "
            "DEPG RWYS 27. NEW NOTICE WORDING. ADVS YOU HAVE INFO Z."
        )
        now = datetime(2026, 8, 22, 9, 0, tzinfo=timezone.utc)
        persisted = datetime(2026, 8, 21, 8, 54, tzinfo=timezone.utc)
        self.assertEqual(u.atis_report_identity(old_zulu), "Z:0854Z")
        self.assertEqual(u.atis_report_identity(relay_variant), "Z:0854Z")
        self.assertEqual(
            u.resolve_atis_observed_datetime(relay_variant, now, {old_zulu: persisted}),
            persisted,
        )

    def test_yesterdays_cached_report_cannot_beat_current_report(self):
        now = datetime(2026, 8, 22, 10, 18, tzinfo=timezone.utc)
        current_alpha = atis("A", "0854Z", "18C")
        cached_zulu = atis("Z", "0954Z")
        cached_observed = datetime(2026, 8, 21, 9, 54, tzinfo=timezone.utc)
        selected = u.choose_latest_atis_report(
            [current_alpha, cached_zulu],
            now,
            known_observed_times={cached_zulu: cached_observed},
        )
        self.assertEqual(u.parse_atis_letter(selected), "A")
        self.assertEqual(
            u.resolve_atis_observed_datetime(
                selected,
                now,
                {cached_zulu: cached_observed},
            ),
            datetime(2026, 8, 22, 8, 54, tzinfo=timezone.utc),
        )

    def test_warned_or_stale_atis_cannot_drive_display_ops(self):
        for status in ("WARN_SOURCE", "STALE_SOURCE", "SOURCE_TIME_UNKNOWN"):
            ops = u.parse_atis_operations(FULL_ZULU_ATIS, status)
            self.assertEqual(ops["atisDisplay"], "--")
            self.assertEqual(ops["atisLetter"], "--")
            self.assertEqual(ops["atisPhonetic"], "--")
            self.assertEqual(ops["arrRunways"], "--")
            self.assertEqual(ops["depRunways"], "--")
            self.assertEqual(ops["closedRunways"], "ATIS STALE")
            self.assertEqual(ops["flow"], "--")
            self.assertEqual(ops["reportedLetter"], "Z")
            self.assertEqual(ops["reportedArrRunways"], "27")
            self.assertEqual(ops["reportedDepRunways"], "18R / 18C / 18L / 27")

    def test_current_atis_drives_display_ops(self):
        ops = u.parse_atis_operations(FULL_ZULU_ATIS, "OK")
        self.assertEqual(ops["atisDisplay"], "ZULU")
        self.assertEqual(ops["arrRunways"], "27")
        self.assertEqual(ops["depRunways"], "18R / 18C / 18L / 27")
        self.assertEqual(ops["flow"], "MIXED")

    def test_flow_requires_one_direction_family(self):
        self.assertEqual(u.determine_flow("18C", "18R / 18C / 18L"), "SOUTH ↓")
        self.assertEqual(u.determine_flow("27", "27"), "WEST ←")
        self.assertEqual(u.determine_flow("9", "9"), "EAST →")
        self.assertEqual(u.determine_flow("27", "18R / 18C / 18L / 27"), "MIXED")

    def test_exact_screenshot_age_is_warned(self):
        observed = u.parse_atis_datetime_utc(FULL_ZULU_ATIS, self.now)
        age = u.source_age_minutes(observed, self.now)
        self.assertEqual(age, 84)
        self.assertEqual(u.freshness_status("OK", age, 60, 90), "WARN_SOURCE")

    def test_api_list_extraction_reads_every_report(self):
        older = atis("Z", "0854Z")
        newer = atis("A", "0954Z", "18C")
        reports = u._atis_candidates_from_json(
            [{"airport": "KMEM", "datis": older}, {"airport": "KMEM", "datis": newer}]
        )
        self.assertEqual(len(reports), 2)
        selected = u.choose_latest_atis_report(reports, self.now)
        self.assertEqual(u.parse_atis_letter(selected), "A")
        self.assertEqual(
            u.parse_atis_datetime_utc(selected, self.now),
            datetime(2026, 8, 21, 9, 54, tzinfo=timezone.utc),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
