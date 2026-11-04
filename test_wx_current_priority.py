#!/usr/bin/env python3
"""Current observed WX must not be displaced by a more severe TAF hazard."""

from datetime import datetime, timezone
import unittest
from unittest import mock

import update_weather_local as updater


NOW = datetime(2026, 11, 3, 22, 48, tzinfo=timezone.utc)
METAR = "SPECI KMEM 032226Z 17011KT 5SM -RA SCT031 BKN055 OVC065 22/18 A2989 RMK AO2 RAB13"
ATIS = "MEM ATIS INFO J 2226Z SPECIAL. 17011KT 5SM -RA SCT031 BKN055 OVC065 22/18 A2989. ILS APCH IN USE RY 18C."
CLEAR = "METAR KMEM 032226Z 17011KT 10SM SCT031 BKN055 22/18 A2989"
TAF = (
    "TAF KMEM 032101Z 0321/0424 16014G24KT P6SM SCT025 OVC045 "
    "TEMPO 0321/0324 BKN025 "
    "FM040000 18012G22KT 5SM -SHRA VCTS SCT008 OVC015CB "
    "TEMPO 0400/0404 5SM -TSRA OVC015CB "
    "FM040400 20007KT P6SM VCSH BKN015 "
    "FM041000 24005KT P6SM BKN015 FM041700 27007KT P6SM BKN025"
)


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


class CurrentWeatherPriorityTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(updater, "datetime", FrozenDatetime)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_mist_and_br_use_identical_code_text_and_effects(self):
        clear = "METAR KMEM 032226Z 17011KT 10SM SCT031 22/18 A2989"
        for observation in ("MIST", "BR"):
            atis = f"MEM ATIS INFO J 2226Z. 17011KT 5SM {observation} SCT031 22/18 A2989. ILS APCH IN USE RY 18C."
            alert = updater.detect_weather_alerts(clear, "", atis)[0]
            self.assertEqual(alert["code"], "BR")
            self.assertEqual(alert["text"], "BR ATIS")
            self.assertEqual((alert["displayTone"], alert["flash"], alert["pulse"]), ("blue", False, False))
        metar_br = clear.replace("10SM", "5SM BR")
        alert = updater.detect_weather_alerts(metar_br, "")[0]
        self.assertEqual(alert["text"], "BR METAR")
        # Neither source is absolute: a stronger current hazard wins.
        for metar, atis, source in (
            (metar_br, "MEM ATIS INFO J 2226Z. 5SM TSRA BKN030.", "ATIS"),
            (clear.replace("10SM", "5SM TSRA"), "MEM ATIS INFO J 2226Z. 5SM MIST BKN030.", "METAR"),
        ):
            alert = updater.detect_weather_alerts(metar, "", atis)[0]
            self.assertEqual(alert["code"], "TSRA")
            self.assertEqual(alert["sources"], [source])

    def test_reported_live_case_current_rain_beats_midnight_thunder(self):
        alerts = updater.detect_weather_alerts(METAR, TAF, ATIS)
        self.assertEqual(len(alerts), 2)
        self.assertEqual(alerts[0]["code"], "-RA")
        self.assertEqual(alerts[0]["sources"], ["ATIS", "METAR"])
        self.assertEqual(alerts[0]["text"], "-RA ATIS")
        summary = updater.summarize_weather_alerts(alerts)
        self.assertEqual(summary["wxAlertText"], "🌧️ -RA ATIS → ⛈️ -TSRA PSBL 04 NOV 00-04Z")
        self.assertEqual(summary["wxAlertTone"], "blue")
        self.assertFalse(summary["wxAlertFlash"])
        self.assertFalse(summary["wxAlertPulse"])
        self.assertEqual(summary["wxSecondaryAlert"]["sources"], ["TAF"])
        self.assertEqual(summary["wxSecondaryAlert"]["text"], "-TSRA PSBL 04 NOV 00-04Z")

    def test_same_code_shows_once_but_retains_possible_window(self):
        taf = "TAF KMEM 032101Z 0321/0424 17010KT P6SM SCT040 FM040000 18010KT 5SM -RA BKN015"
        alerts = updater.detect_weather_alerts(METAR, taf, ATIS)
        summary = updater.summarize_weather_alerts(alerts)
        self.assertEqual(summary["wxAlertText"].count("-RA"), 1)
        self.assertIn(" → PSBL 04 NOV 00-24Z", summary["wxAlertText"])
        self.assertEqual(summary["wxSecondaryAlert"]["code"], "-RA")
        self.assertEqual(summary["wxSecondaryAlert"]["sources"], ["TAF"])
        self.assertIn("PSBL", summary["wxAlertLogText"])

    def test_distinct_intensity_codes_are_not_deduplicated(self):
        taf = "TAF KMEM 032101Z 0321/0424 17010KT P6SM SCT040 FM040000 18010KT 3SM +RA BKN015"
        summary = updater.summarize_weather_alerts(updater.detect_weather_alerts(METAR, taf, ATIS))
        self.assertIn("-RA ATIS", summary["wxAlertText"])
        self.assertIn("+RA PSBL", summary["wxAlertText"])

    def test_current_source_is_not_relabeled_now_or_redated(self):
        # Retained reports remain METAR; freshness/observation time belongs to
        # the existing feed-age fields, not an invented NOW assertion.
        old_metar = METAR.replace("032226Z", "031226Z")
        summary = updater.summarize_weather_alerts(updater.detect_weather_alerts(old_metar, TAF))
        self.assertEqual(summary["wxPrimaryAlert"]["text"], "-RA METAR")
        self.assertNotIn("NOW", summary["wxPrimaryAlert"]["text"])
        self.assertEqual(summary["wxSecondaryAlert"]["tafStartIso"], "2026-11-04T00:00:00Z")

    def test_future_hazard_severity_cannot_override_current_rain(self):
        for code in ("VCTS", "-TSRA", "+TSRA", "FZRA", "VA", "FC"):
            with self.subTest(code=code):
                taf = (
                    "TAF KMEM 032101Z 0321/0424 17010KT P6SM SCT040 "
                    f"FM040000 18010KT 3SM {code} BKN015"
                )
                alert = updater.detect_weather_alerts(METAR, taf)[0]
                self.assertEqual(alert["code"], "-RA")
                self.assertEqual(alert["sources"], ["METAR"])
                self.assertEqual(alert["text"], "-RA METAR")

    def test_active_taf_window_is_still_forecast_not_observation(self):
        taf = "TAF KMEM 032101Z 0321/0424 17010KT 3SM +TSRA BKN015CB"
        alert = updater.detect_weather_alerts(METAR, taf, ATIS)[0]
        self.assertEqual(alert["code"], "-RA")
        self.assertEqual(alert["sources"], ["ATIS", "METAR"])

    def test_at_is_only_current_weather_still_wins(self):
        alert = updater.detect_weather_alerts(CLEAR, TAF, ATIS)[0]
        self.assertEqual(alert["text"], "-RA ATIS")
        self.assertEqual(alert["sources"], ["ATIS"])

    def test_more_restrictive_metar_is_not_hidden_by_atis(self):
        for code in ("TSRA", "FZRA", "+RA"):
            with self.subTest(code=code):
                alert = updater.detect_weather_alerts(METAR.replace("-RA", code), TAF, ATIS)[0]
                self.assertEqual(alert["code"], code)
                self.assertEqual(alert["sources"], ["METAR"])
                self.assertEqual(alert["text"], f"{code} METAR")

    def test_current_rain_intensity_precedes_source_preference(self):
        for metar_code, atis_code, expected_code, expected_source in (
            ("RA", "-RA", "RA", "METAR"),
            ("-RA", "RA", "RA", "ATIS"),
            ("RA", "+RA", "+RA", "ATIS"),
            ("+RA", "RA", "+RA", "METAR"),
        ):
            with self.subTest(metar=metar_code, atis=atis_code):
                alerts = updater.detect_weather_alerts(METAR.replace("-RA", metar_code), TAF, ATIS.replace("-RA", atis_code))
                self.assertEqual(alerts[0]["code"], expected_code)
                self.assertEqual(alerts[0]["sources"], [expected_source])
                self.assertEqual(alerts[0]["text"], f"{expected_code} {expected_source}")
                self.assertEqual(alerts[1]["sources"], ["TAF"])

    def test_current_thunder_keeps_red_flash(self):
        alert = updater.detect_weather_alerts(METAR.replace("-RA", "TSRA"), TAF, ATIS)[0]
        self.assertEqual(alert["displayTone"], "red")
        self.assertTrue(alert["flash"])

    def test_existing_color_and_motion_scheme_is_unchanged(self):
        for code, category, observed, possible in (
            ("-RA", "rain", ("blue", False, False), ("blue", False, False)),
            ("RA", "rain", ("blue", False, False), ("blue", False, False)),
            ("BR", "mist", ("blue", False, False), ("blue", False, False)),
            ("+RA", "rain", ("yellow", False, True), ("yellow", False, True)),
            ("SN", "snow", ("yellow", False, True), ("yellow", False, True)),
            ("FG", "fog", ("yellow", False, True), ("yellow", False, True)),
            ("TSRA", "thunder", ("red", True, False), ("yellow", False, True)),
            ("VCTS", "thunder", ("red", True, False), ("yellow", False, True)),
            ("FZRA", "freezing", ("red", True, False), ("yellow", False, True)),
            ("FZFG", "fog", ("red", True, False), ("yellow", False, True)),
            ("LLWS", "wind_shear", ("red", True, False), ("yellow", False, True)),
            ("VA", "ash", ("red", True, False), ("yellow", False, True)),
        ):
            for source, expected in (("ATIS", observed), ("METAR", observed), ("TAF", possible)):
                with self.subTest(code=code, source=source):
                    result = updater.classify_alert(code, [source], category)
                    self.assertEqual(result[1:4], expected)

    def test_when_current_weather_clears_forecast_returns_unchanged(self):
        alert = updater.detect_weather_alerts(CLEAR, TAF)[0]
        self.assertEqual(alert["code"], "-TSRA")
        self.assertEqual(alert["sources"], ["TAF"])
        self.assertEqual(alert["text"], "-TSRA PSBL 04 NOV 00-04Z")
        self.assertEqual(alert["displayTone"], "yellow")
        self.assertTrue(alert["pulse"])

    def test_expired_forecast_is_not_resurrected_after_current_clears(self):
        expired = "TAF KMEM 031700Z 0318/0322 17010KT 3SM TSRA BKN015CB"
        self.assertEqual(updater.detect_weather_alerts(CLEAR, expired), [])

    def test_missing_forecast_does_not_hide_current_weather(self):
        self.assertEqual(updater.detect_weather_alerts(METAR, "", ATIS)[0]["text"], "-RA ATIS")


if __name__ == "__main__":
    unittest.main()
