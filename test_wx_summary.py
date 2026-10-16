#!/usr/bin/env python3
"""Regression contracts for the legacy WX-alert summary, not a TAF outlook."""

from datetime import datetime, timezone
import unittest
from unittest import mock

import update_weather_local as updater


NOW = datetime(2026, 10, 16, 18, 0, tzinfo=timezone.utc)
CLEAR_METAR = "METAR KMEM 161753Z 19007KT 10SM FEW090 22/12 A2992"
TAF_HEADER = "TAF KMEM 161720Z 1618/1724 "
CLEAR_TAF = TAF_HEADER + "19007KT P6SM FEW090"


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


class WeatherAlertSummaryTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(updater, "datetime", FrozenDatetime)
        patcher.start()
        self.addCleanup(patcher.stop)

    def assert_no_alert_summary(self, taf, metar=CLEAR_METAR):
        alerts = updater.detect_weather_alerts(metar, taf)
        self.assertEqual(alerts, [])
        self.assertEqual(
            updater.summarize_weather_alerts(alerts),
            {
                "wxAlertText": "NONE",
                "wxAlertLogText": "NONE",
                "wxAlertVisible": False,
                "wxPrimaryAlert": None,
                "wxSecondaryAlert": None,
                "wxAlertTone": "none",
                "wxAlertFlash": False,
                "wxAlertPulse": False,
                "tafTrend": "WX ALERT | NONE",
            },
        )

    def test_empty_alert_list_has_no_category_or_forecast_horizon_claim(self):
        self.assertEqual(
            updater.summarize_weather_alerts([])["tafTrend"],
            "WX ALERT | NONE",
        )

    def test_reported_fm_broken_and_overcast_regression(self):
        # The reported 161720Z TAF's FM170600 BKN025 OVC035 can produce no
        # weather-code alert, but that does not establish VFR for 24 hours.
        self.assert_no_alert_summary(
            CLEAR_TAF + " FM170600 19010KT P6SM BKN025 OVC035"
        )

    def test_ceilings_and_visibility_do_not_turn_no_wx_alert_into_vfr(self):
        for conditions in (
            "P6SM FEW090",  # Even a clear group does not prove 24h coverage.
            "P6SM BKN030",
            "P6SM BKN025 OVC035",
            "P6SM OVC005",
            "P6SM VV002",
            "5SM SCT050",
            "2SM SCT050",
            "1/2SM SCT050",
            "M1/4SM VV002",
        ):
            with self.subTest(conditions=conditions):
                self.assert_no_alert_summary(TAF_HEADER + "19007KT " + conditions)

    def test_fm_tempo_and_probability_groups_do_not_imply_vfr(self):
        for change in (
            "FM170600 19010KT P6SM BKN025 OVC035",
            "TEMPO 1706/1710 BKN008",
            "PROB30 1706/1710 BKN008",
            "PROB40 1706/1710 2SM",
            "PROB30 TEMPO 1706/1710 1/2SM OVC002",
        ):
            with self.subTest(change=change):
                self.assert_no_alert_summary(CLEAR_TAF + " " + change)

    def test_missing_invalid_expired_or_short_taf_cannot_claim_24h_vfr(self):
        for taf in (
            "",
            "TAF UNAVAILABLE",
            "TAF FETCH ERROR",
            "TAF KMEM 161720Z NIL",
            "TAF KMEM 161720Z 1618/1724 CNL",
            "TAF KMEM 161100Z 1612/1618 19007KT P6SM SCT050",
            "TAF KMEM 161720Z 1618/1706 19007KT P6SM SCT050",
            "TAF KMEM 161720Z 1618/1718 19007KT P6SM SCT050",
            CLEAR_TAF,
        ):
            with self.subTest(taf=taf):
                self.assert_no_alert_summary(taf)

    def test_expired_hazard_does_not_create_a_vfr_outlook(self):
        # At the validity end, the selector correctly removes the expired
        # hazard. That empty result says nothing about future flight category.
        self.assert_no_alert_summary(
            "TAF KMEM 161100Z 1612/1618 19007KT 2SM TSRA BKN008CB"
        )

    def test_24h_boundary_does_not_change_the_legacy_alert_contract(self):
        # The existing selector includes later TAF hazards too; tafTrend must
        # remain an alias of that selected alert, not assert a 24h outlook.
        for marker in ("FM171700", "FM171800", "FM171900"):
            with self.subTest(marker=marker):
                alerts = updater.detect_weather_alerts(
                    CLEAR_METAR,
                    CLEAR_TAF + f" {marker} 19010KT P6SM TSRA BKN045CB",
                )
                self.assertEqual(len(alerts), 1)
                self.assertEqual(alerts[0]["code"], "TSRA")
                self.assertEqual(alerts[0]["sources"], ["TAF"])
                self.assertEqual(
                    updater.summarize_weather_alerts(alerts)["tafTrend"],
                    "WX ALERT | " + alerts[0]["displayText"],
                )

    def test_selected_alert_output_and_input_remain_unchanged(self):
        primary = {
            "displayText": "⛈️ TSRA OBS",
            "text": "TSRA OBS",
            "displayTone": "red",
            "flash": True,
            "pulse": False,
        }
        original = dict(primary)
        self.assertEqual(
            updater.summarize_weather_alerts([primary]),
            {
                "wxAlertText": primary["displayText"],
                "wxAlertLogText": primary["text"],
                "wxAlertVisible": True,
                "wxPrimaryAlert": primary,
                "wxSecondaryAlert": None,
                "wxAlertTone": "red",
                "wxAlertFlash": True,
                "wxAlertPulse": False,
                "tafTrend": "WX ALERT | " + primary["displayText"],
            },
        )
        self.assertEqual(primary, original)


if __name__ == "__main__":
    unittest.main()
