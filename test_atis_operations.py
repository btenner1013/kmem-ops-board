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
        diagnostics = {}
        with mock.patch.object(u, "fetch_atis_info_api_candidates", return_value=[old_zulu]):
            with mock.patch.object(u, "fetch_url", side_effect=[new_alpha, old_zulu]) as fetch:
                selected = u.fetch_current_atis(
                    ["https://relay.test/cache-busted", "https://relay.test/plain"],
                    self.now,
                    diagnostics=diagnostics,
                )
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(u.parse_atis_letter(selected), "A")
        self.assertEqual(diagnostics["policy"], "NEWEST_HEADER_TIME")
        self.assertEqual(diagnostics["sourcesChecked"], ["ATIS_INFO_API", "ATIS_RELAY"])
        # Equivalent provider wording can produce more than one normalized text
        # for the same header identity, but every valid candidate is compared.
        self.assertGreaterEqual(diagnostics["candidateCount"], 2)
        self.assertEqual(diagnostics["selectedSources"], ["ATIS_RELAY"])

    def test_same_time_provider_revision_uses_newer_information_letter(self):
        api_bravo = atis("B", "0954Z")
        relay_charlie = atis("C", "0954Z", "18C")
        persisted = datetime(2026, 8, 21, 9, 54, tzinfo=timezone.utc)
        diagnostics = {}

        with mock.patch.object(u, "fetch_atis_info_api_candidates", return_value=[api_bravo]):
            with mock.patch.object(u, "fetch_url", return_value=relay_charlie):
                selected = u.fetch_current_atis(
                    ["https://relay.test/current"],
                    self.now,
                    known_observed_times={api_bravo: persisted},
                    diagnostics=diagnostics,
                )

        self.assertEqual(u.parse_atis_letter(selected), "C")
        self.assertEqual(diagnostics["selectedSources"], ["ATIS_RELAY"])
        self.assertEqual(
            {item["identity"] for item in diagnostics["candidates"]},
            {"B:0954Z", "C:0954Z"},
        )
        self.assertEqual(
            {item["observedZ"] for item in diagnostics["candidates"]},
            {"2026-08-21T09:54:00Z"},
        )

    def test_direct_atis_info_and_mirror_are_configured(self):
        self.assertEqual(
            u.ATIS_JSON_API_URL_TEMPLATES,
            (
                "https://atis.info/api/{icao}",
                "https://datis.clowd.io/api/{icao}",
            ),
        )

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

    def test_equal_header_time_prefers_forward_information_letter(self):
        previous_bravo = atis("B", "0954Z")
        next_charlie = atis("C", "0954Z", "18C")
        persisted = datetime(2026, 8, 21, 9, 54, tzinfo=timezone.utc)

        for candidates in ([previous_bravo, next_charlie], [next_charlie, previous_bravo]):
            selected = u.choose_latest_atis_report(
                candidates,
                self.now,
                known_observed_times={previous_bravo: persisted},
            )
            self.assertEqual(u.parse_atis_letter(selected), "C")

    def test_equal_header_time_rolls_zulu_forward_to_alpha(self):
        previous_zulu = atis("Z", "0954Z")
        next_alpha = atis("A", "0954Z", "18C")
        persisted = datetime(2026, 8, 21, 9, 54, tzinfo=timezone.utc)

        for candidates in ([previous_zulu, next_alpha], [next_alpha, previous_zulu]):
            selected = u.choose_latest_atis_report(
                candidates,
                self.now,
                known_observed_times={previous_zulu: persisted},
            )
            self.assertEqual(u.parse_atis_letter(selected), "A")

    def test_equal_header_time_orders_adjacent_letters_without_cache_anchor(self):
        bravo = atis("B", "0954Z")
        charlie = atis("C", "0954Z", "18C")

        for candidates in ([bravo, charlie], [charlie, bravo]):
            selected = u.choose_latest_atis_report(candidates, self.now)
            self.assertEqual(u.parse_atis_letter(selected), "C")

    def test_equal_header_time_rejects_provider_letter_regression(self):
        old_zulu = atis("Z", "0954Z")
        current_alpha = atis("A", "0954Z", "18C")
        persisted = datetime(2026, 8, 21, 9, 54, tzinfo=timezone.utc)

        selected = u.choose_latest_atis_report(
            [old_zulu, current_alpha],
            self.now,
            known_observed_times={current_alpha: persisted},
        )
        self.assertEqual(u.parse_atis_letter(selected), "A")

    def test_equal_time_ignores_letter_hint_from_day_old_cache(self):
        first_provider = atis("N", "0954Z")
        second_provider = atis("A", "0954Z", "18C")
        old_reference = atis("Z", "0854Z")
        old_observed = datetime(2026, 8, 20, 8, 54, tzinfo=timezone.utc)

        selected = u.choose_latest_atis_report(
            [first_provider, second_provider],
            self.now,
            known_observed_times={old_reference: old_observed},
        )
        self.assertEqual(u.parse_atis_letter(selected), "N")

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
            "KMEM ATIS INFORMATION Z 0854Z. WIND 090 AT 05. 10SM A3000. "
            "VISUAL APCH IN USE RY 27. "
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

    def test_live_report_beats_cached_fallback_across_utc_midnight(self):
        now = datetime(2026, 8, 22, 0, 10, tzinfo=timezone.utc)
        cached_zulu = atis("Z", "2354Z")
        live_alpha = atis("A", "0004Z", "18C")
        cached_observed = datetime(2026, 8, 21, 23, 54, tzinfo=timezone.utc)

        selected = u.choose_latest_atis_report(
            [cached_zulu, live_alpha],
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
            datetime(2026, 8, 22, 0, 4, tzinfo=timezone.utc),
        )

    def test_newer_cached_fallback_beats_regressed_live_report_after_midnight(self):
        now = datetime(2026, 8, 22, 0, 10, tzinfo=timezone.utc)
        regressed_live = atis("Z", "2354Z")
        cached_alpha = atis("A", "0004Z", "18C")
        cached_observed = datetime(2026, 8, 22, 0, 4, tzinfo=timezone.utc)

        selected = u.choose_latest_atis_report(
            [regressed_live, cached_alpha],
            now,
            known_observed_times={cached_alpha: cached_observed},
        )

        self.assertEqual(u.parse_atis_letter(selected), "A")
        self.assertEqual(
            u.resolve_atis_observed_datetime(
                selected,
                now,
                {cached_alpha: cached_observed},
            ),
            cached_observed,
        )

    def test_newer_header_with_unusable_body_cannot_displace_valid_report(self):
        valid_old = atis("A", "0854Z")
        malformed_new = (
            "MEM ATIS INFO B 0954Z. CORRUPT PAYLOAD WITHOUT USABLE WEATHER "
            "OR AIRPORT OPERATIONS DATA. ADVS YOU HAVE INFO B."
        )

        self.assertFalse(u.is_good_atis(malformed_new))
        selected = u.choose_latest_atis_report([malformed_new, valid_old], self.now)
        self.assertEqual(u.parse_atis_letter(selected), "A")

        mismatched_handoff = (
            "MEM ATIS INFO B 0954Z. 09005KT 10SM SCT250 25/20 A3000. "
            "VISUAL APCH IN USE RY 18C. DEPG RWYS 18C. "
            "ADVS YOU HAVE INFO A."
        )
        self.assertFalse(u.is_good_atis(mismatched_handoff))

    def test_provider_timeout_does_not_block_current_other_provider(self):
        current = atis("A", "0954Z", "18C")
        diagnostics = {}

        with mock.patch.object(
            u,
            "fetch_atis_info_api_candidates",
            side_effect=TimeoutError("provider timed out"),
        ):
            with mock.patch.object(u, "fetch_url", return_value=current):
                selected = u.fetch_current_atis(
                    ["https://relay.test/current"],
                    self.now,
                    diagnostics=diagnostics,
                )

        self.assertEqual(u.parse_atis_letter(selected), "A")
        self.assertEqual(diagnostics["selectedSources"], ["ATIS_RELAY"])
        self.assertEqual(diagnostics["candidateCount"], 1)

    def test_relay_timeout_does_not_block_current_api_provider(self):
        current = atis("A", "0954Z", "18C")
        diagnostics = {}

        with mock.patch.object(u, "fetch_atis_info_api_candidates", return_value=[current]):
            with mock.patch.object(u, "fetch_url", side_effect=TimeoutError("relay timed out")):
                selected = u.fetch_current_atis(
                    ["https://relay.test/timeout"],
                    self.now,
                    diagnostics=diagnostics,
                )

        self.assertEqual(u.parse_atis_letter(selected), "A")
        self.assertEqual(diagnostics["selectedSources"], ["ATIS_INFO_API"])
        self.assertEqual(diagnostics["candidateCount"], 1)

    def test_all_stale_providers_are_suppressed_at_60_minute_gate(self):
        now = datetime(2026, 8, 21, 10, 54, tzinfo=timezone.utc)
        older_api = atis("Z", "0854Z")
        newest_relay = atis("A", "0954Z", "18C")

        with mock.patch.object(u, "fetch_atis_info_api_candidates", return_value=[older_api]):
            with mock.patch.object(u, "fetch_url", return_value=newest_relay):
                selected = u.fetch_current_atis(["https://relay.test/stale"], now)

        observed = u.resolve_atis_observed_datetime(selected, now)
        age = u.source_age_minutes(observed, now)
        status = u.freshness_status("OK", age, 60, 90)
        ops = u.parse_atis_operations(selected, status)

        self.assertEqual(age, 60)
        self.assertEqual(status, "WARN_SOURCE")
        self.assertEqual(ops["atisDisplay"], "--")
        self.assertEqual(ops["atisLetter"], "--")
        self.assertEqual(ops["arrRunways"], "--")
        self.assertEqual(ops["depRunways"], "--")
        self.assertEqual(ops["closedRunways"], "ATIS STALE")
        self.assertEqual(ops["flow"], "--")
        self.assertFalse(ops["sourceIsCurrent"])

    def test_newest_atis_wins_across_fallback_cache_locations(self):
        local_old = {
            "metar": "LOCAL CACHE METAR",
            "atisText": atis("Z", "0854Z"),
            "atisObservedZ": "2026-08-21T08:54:00Z",
        }
        repo_new = {
            "metar": "REPO CACHE METAR",
            "atisText": atis("A", "0954Z", "18C"),
            "atisObservedZ": "2026-08-21T09:54:00Z",
        }

        with mock.patch.object(
            u,
            "load_json_file",
            side_effect=[local_old, repo_new, {}],
        ):
            selected = u.load_previous_weather()

        # Non-ATIS fields retain the preferred local cache, while the newer ATIS
        # is overlaid from the lower-priority repository fallback.
        self.assertEqual(selected["metar"], "LOCAL CACHE METAR")
        self.assertEqual(u.parse_atis_letter(selected["atisText"]), "A")
        self.assertEqual(selected["atisObservedZ"], "2026-08-21T09:54:00Z")

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
