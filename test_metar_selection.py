"""Deterministic METAR endpoint and retained-observation regression tests."""

import inspect
import json
import unittest
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import update_weather_local as u


NOW = datetime(2026, 10, 17, 19, 25, 41, tzinfo=timezone.utc)


def report(time="171854", kind="METAR", extra=""):
    return f"{kind} KMEM {time}Z {extra}01009KT 10SM CLR 18/02 A3043 RMK AO2".replace("  ", " ")


def cache(raw=None, observed="2026-10-17T18:54:00Z", **extra):
    return {"metar": raw or report(), "metarObservedZ": observed, **extra}


class MetarSelectionTests(unittest.TestCase):
    def test_newest_line_wins_in_any_order(self):
        for lines in ([report("171754"), report()], [report(), report("171754")]):
            self.assertEqual(u.choose_latest_metar_report("\n".join(lines), NOW), report())

    def test_noaa_date_line_and_bare_station_are_normalized(self):
        raw = "2026/10/17 18:54\n" + report().removeprefix("METAR ") + "=\n"
        self.assertEqual(u.choose_latest_metar_report(raw, NOW), report())

    def test_wrong_station_and_embedded_header_are_rejected(self):
        for raw in (report().replace("KMEM", "KBNA"), "ERROR " + report(), "<html>" + report()):
            with self.subTest(raw=raw):
                self.assertEqual(u.choose_latest_metar_report(raw, NOW), "")

    def test_missing_weather_nil_and_invalid_calendar_time_are_rejected(self):
        for raw in ("METAR KMEM 171854Z", "METAR KMEM 171854Z NIL", report("321854"), report("172554"), report("171899")):
            with self.subTest(raw=raw):
                self.assertEqual(u.choose_latest_metar_report(raw, NOW), "")

    def test_valid_missing_wind_or_visibility_groups_remain_usable(self):
        for raw in (report().replace("01009KT", "/////KT"), report().replace("01009KT", "///09KT"), report().replace("10SM", "////SM"), report().replace("10SM", "////")):
            with self.subTest(raw=raw):
                self.assertEqual(u.choose_latest_metar_report(raw, NOW), raw)

    def test_zero_denominator_visibility_is_rejected_before_weather_parsing(self):
        for visibility in ("1/0SM", "1 1/0SM", "M1/00SM"):
            with self.subTest(visibility=visibility):
                self.assertEqual(u.choose_latest_metar_report(report().replace("10SM", visibility), NOW), "")

    def test_future_report_does_not_become_last_month(self):
        self.assertIsNone(u.parse_metar_datetime_utc(report("172054"), NOW))
        self.assertEqual(u.choose_latest_metar_report(report("172054"), NOW), "")

    def test_existing_ten_minute_clock_tolerance_is_preserved(self):
        self.assertEqual(u.parse_metar_datetime_utc(report("171930"), NOW).hour, 19)

    def test_month_year_and_leap_day_rollover(self):
        for now, token, expected in (
            (datetime(2026, 11, 1, 0, 5, tzinfo=timezone.utc), "312354", "2026-10-31T23:54:00Z"),
            (datetime(2027, 1, 1, 0, 5, tzinfo=timezone.utc), "312354", "2026-12-31T23:54:00Z"),
            (datetime(2028, 3, 1, 0, 5, tzinfo=timezone.utc), "292354", "2028-02-29T23:54:00Z"),
        ):
            with self.subTest(token=token, now=now):
                self.assertEqual(u.zulu_iso(u.parse_metar_datetime_utc(report(token), now)), expected)

    def test_correction_before_station_is_normalized(self):
        corrected = report().replace("METAR KMEM", "METAR COR KMEM")
        self.assertEqual(u.choose_latest_metar_report(corrected, NOW), report(extra="COR "))

    def test_correction_and_speci_win_equal_timestamp_in_both_orders(self):
        for preferred in (report(extra="COR "), report(kind="SPECI")):
            for lines in ([report(), preferred], [preferred, report()]):
                self.assertEqual(u.choose_latest_metar_report("\n".join(lines), NOW), preferred)

    def test_corrected_cache_is_not_replaced_by_uncorrected_live_same_time(self):
        selected = u.select_metar_observation(report(), cache(report(extra="COR ")), NOW)
        self.assertTrue(selected["usedLastGood"])
        self.assertEqual(selected["report"], report(extra="COR "))

    def test_live_correction_replaces_cached_original_same_time(self):
        selected = u.select_metar_observation(report(extra="COR "), cache(), NOW, "AWC")
        self.assertFalse(selected["usedLastGood"])
        self.assertEqual(selected["report"], report(extra="COR "))

    def test_actual_1854_to_1754_regression_keeps_original_timestamp(self):
        selected = u.select_metar_observation(report("171754"), cache(metarSelectedSource="NWS_NOAA"), NOW, "AWC")
        self.assertEqual(selected["report"], report())
        self.assertEqual(u.zulu_iso(selected["observed"]), "2026-10-17T18:54:00Z")
        self.assertTrue(selected["usedLastGood"])
        self.assertEqual(selected["selectedSource"], "LAST_KNOWN_GOOD")
        self.assertEqual(selected["originalSource"], "NWS_NOAA")
        self.assertEqual(selected["reason"], "LIVE_REGRESSION")

    def test_newer_live_observation_replaces_cache(self):
        selected = u.select_metar_observation(report(), cache(report("171754"), "2026-10-17T17:54:00Z"), NOW, "AWC")
        self.assertFalse(selected["usedLastGood"])
        self.assertEqual(selected["originalSource"], "AWC")

    def test_empty_live_retains_cache_and_reason(self):
        selected = u.select_metar_observation("", cache(), NOW)
        self.assertTrue(selected["usedLastGood"])
        self.assertEqual(selected["reason"], "FETCH_FAILED")

    def test_stale_cache_keeps_original_age_and_warning(self):
        selected = u.select_metar_observation("", cache(report("171654"), "2026-10-17T16:54:00Z"), NOW)
        age = u.source_age_minutes(selected["observed"], NOW)
        self.assertEqual(age, 152)
        self.assertEqual(u.freshness_status("USED_LAST_GOOD", age, 55, 75), "STALE_LAST_GOOD")

    def test_month_old_cache_is_never_redated_even_if_live_replays_same_text(self):
        previous = cache(observed="2026-09-17T18:54:00Z")
        for live in ("", report()):
            selected = u.select_metar_observation(live, previous, NOW, "AWC")
            self.assertEqual(u.zulu_iso(selected["observed"]), "2026-09-17T18:54:00Z")
            self.assertGreater(u.source_age_minutes(selected["observed"], NOW), 40000)

    def test_matching_old_replay_cannot_hide_newer_report_in_same_response(self):
        previous = cache(observed="2026-09-17T18:54:00Z")
        newer = report("171754")
        for lines in ([report(), newer], [newer, report()]):
            self.assertEqual(u.choose_latest_metar_report("\n".join(lines), NOW, previous), newer)

    def test_legacy_cache_uses_its_own_update_date(self):
        previous = {"metar": report(), "allFeedsUpdatedZ": "2026-09-17 19:05Z"}
        self.assertEqual(u.zulu_iso(u.cached_metar_observed_datetime(previous, NOW)), "2026-09-17T18:54:00Z")

    def test_unknown_inconsistent_or_future_cache_date_cannot_win(self):
        invalid = (
            {"metar": report()},
            cache(observed="2026-10-17T19:54:00Z"),
            cache(report("172054"), "2026-10-17T20:54:00Z"),
            cache(report().replace("KMEM", "KBNA")),
        )
        for previous in invalid:
            with self.subTest(previous=previous):
                selected = u.select_metar_observation(report("171754"), previous, NOW, "AWC")
                self.assertFalse(selected["usedLastGood"])
                self.assertEqual(selected["report"], report("171754"))

    def test_original_provenance_survives_repeated_fallback(self):
        previous = cache(metarSelectedSource="LAST_KNOWN_GOOD", metarOriginalSource="NWS_NOAA")
        self.assertEqual(u.select_metar_observation("", previous, NOW)["originalSource"], "NWS_NOAA")

    def test_all_failed_sources_and_unusable_cache_stay_unavailable(self):
        selected = u.select_metar_observation("bad", {}, NOW)
        self.assertEqual(selected["report"], "")
        self.assertIsNone(selected["observed"])
        self.assertEqual(selected["selectedSource"], "NONE")
        self.assertEqual(selected["reason"], "FETCH_FAILED")


class MetarEndpointTests(unittest.TestCase):
    def setUp(self):
        self.urls = [f"https://aviationweather.gov/api/data/metar?option={i}" for i in range(4)] + ["https://tgftp.nws.noaa.gov/data/observations/metar/stations/KMEM.TXT"]

    def test_stale_first_response_does_not_block_newer_noaa_fallback(self):
        diagnostics = {}
        with mock.patch.object(u, "fetch_url", side_effect=[report("171754")] * 4 + [report().removeprefix("METAR ")]) as fetch:
            selected = u.fetch_current_metar(self.urls, NOW, diagnostics)
        self.assertEqual(selected, report())
        self.assertEqual(diagnostics["selectedSource"], "NWS_NOAA")
        self.assertEqual(diagnostics["candidateCount"], 5)
        self.assertEqual(fetch.call_args_list, [mock.call(url, attempts=1, timeout_seconds=10) for url in self.urls])

    def test_invalid_empty_future_and_wrong_station_sources_do_not_stop_fallback(self):
        with mock.patch.object(u, "fetch_url", side_effect=["<html>error</html>", "", report("172054"), report().replace("KMEM", "KBNA"), report()]):
            self.assertEqual(u.fetch_current_metar(self.urls, NOW), report())

    def test_timeout_does_not_block_later_sources(self):
        with mock.patch.object(u, "fetch_url", side_effect=[TimeoutError("test"), "", "", "", report()]):
            self.assertEqual(u.fetch_current_metar(self.urls, NOW), report())

    def test_matching_old_replay_cannot_hide_newer_report_from_another_endpoint(self):
        previous = cache(observed="2026-09-17T18:54:00Z")
        newer = report("171754")
        diagnostics = {}
        with mock.patch.object(u, "fetch_url", side_effect=[report()] * 4 + [newer]):
            selected = u.fetch_current_metar(self.urls, NOW, diagnostics, previous)
        self.assertEqual(selected, newer)
        self.assertEqual(diagnostics["selectedSource"], "NWS_NOAA")
        final = u.select_metar_observation(selected, previous, NOW, "NWS_NOAA")
        self.assertEqual(u.zulu_iso(final["observed"]), "2026-10-17T17:54:00Z")
        self.assertFalse(final["usedLastGood"])

    def test_provider_order_is_stable_at_equal_time_and_correction_can_override(self):
        diagnostics = {}
        with mock.patch.object(u, "fetch_url", return_value=report()):
            u.fetch_current_metar(self.urls, NOW, diagnostics)
        self.assertEqual(diagnostics["selectedSource"], "AWC")
        with mock.patch.object(u, "fetch_url", side_effect=[report()] * 4 + [report(extra="COR ")]):
            selected = u.fetch_current_metar(self.urls, NOW, diagnostics)
        self.assertEqual(selected, report(extra="COR "))
        self.assertEqual(diagnostics["selectedSource"], "NWS_NOAA")

    def test_newest_cache_wins_across_locations_with_its_provenance(self):
        older_local = cache(report("171754"), "2026-10-17T17:54:00Z", metarSelectedSource="AWC")
        newer_repo = cache(metarSelectedSource="NWS_NOAA")
        with mock.patch.object(u, "load_json_file", side_effect=[older_local, {}, newer_repo]):
            selected = u.load_previous_weather()
        self.assertEqual(selected["metar"], report())
        self.assertEqual(selected["metarObservedZ"], newer_repo["metarObservedZ"])
        self.assertEqual(selected["metarSelectedSource"], "NWS_NOAA")
        self.assertEqual(u.select_metar_observation("", selected, NOW)["originalSource"], "NWS_NOAA")

    def test_generator_uses_selected_full_timestamp_and_preserves_thresholds(self):
        source = inspect.getsource(u.build_weather_json)
        self.assertIn('metar_observed_dt = metar_selection["observed"]', source)
        self.assertNotIn("metar_observed_dt = parse_metar_datetime_utc(metar, now_z)", source)
        self.assertIn("freshness_status(metar_fetch_status, metar_age_minutes, 55, 75)", source)

    def test_generator_publishes_retained_report_age_and_provenance_without_redating(self):
        fixture = json.loads((Path(__file__).parent / "weather.json").read_text(encoding="utf-8"))
        fixture.update(cache(report(), "2026-09-17T18:54:00Z", metarSelectedSource="NWS_NOAA"))

        class FixedDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 17, 19, 25, 41, tzinfo=timezone.utc)

        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(u, "datetime", FixedDatetime))
            for name, value in {
                "load_previous_weather": fixture,
                "load_trend_history": [],
                "fetch_current_metar": "",
                "fetch_first_nonempty": fixture["taf"],
                "fetch_current_atis": fixture["atisText"],
                "fetch_ahas_bwc": fixture,
                "fetch_mil_notams": fixture,
            }.items():
                stack.enter_context(mock.patch.object(u, name, return_value=value))
            for name in ("snapshot_current_weather_before_overwrite", "maintain_bwc_history_safely", "maintain_atis_history_safely", "save_last_good_weather", "save_repo_last_good_weather", "save_trend_history"):
                stack.enter_context(mock.patch.object(u, name))
            stack.enter_context(mock.patch.object(u, "fetch_url", side_effect=AssertionError("unexpected network call")))
            stack.enter_context(mock.patch("builtins.print"))
            writer = stack.enter_context(mock.patch.object(u, "write_weather_json"))
            u.build_weather_json()
        payload = writer.call_args.args[1]
        self.assertEqual(payload["metarObservedZ"], "2026-09-17T18:54:00Z")
        self.assertGreater(payload["metarAgeMinutes"], 40000)
        self.assertEqual(payload["metarFetchStatus"], "STALE_LAST_GOOD")
        self.assertTrue(payload["lastKnownGoodUsed"]["metar"])
        self.assertEqual(payload["metarSelectedSource"], "LAST_KNOWN_GOOD")
        self.assertEqual(payload["metarOriginalSource"], "NWS_NOAA")


if __name__ == "__main__":
    unittest.main()
