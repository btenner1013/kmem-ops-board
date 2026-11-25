"""Regression for WX ALERT timing across consecutive prevailing TAF groups."""

from datetime import datetime, timezone
from unittest import TestCase, mock

import update_weather_local as updater


NOW = datetime(2026, 11, 25, 16, 38, tzinfo=timezone.utc)
METAR = "METAR KMEM 251554Z 01007KT 9SM -RA SCT070 OVC080 04/02 A3021"
ATIS = "MEM ATIS INFO M 1554Z. 01007KT 9SM -RA SCT070 OVC080 04/02 A3021."
TAF = (
    "TAF KMEM 251449Z 2515/2618 01009KT 6SM -RA SCT035 OVC050 "
    "FM251700 01010KT 4SM -RA BR OVC008 "
    "FM261100 33010KT 6SM BR OVC007 "
    "FM261500 31012G21KT P6SM OVC009"
)


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


class TafAlertContinuityTests(TestCase):
    def summary(self, taf):
        with mock.patch.object(updater, "datetime", FrozenDatetime):
            return updater.summarize_weather_alerts(updater.detect_weather_alerts(METAR, taf, ATIS))

    def test_photo_case_continues_through_fm_with_a_ceiling_change(self):
        result = self.summary(TAF)
        self.assertEqual(result["wxAlertText"], "🌧️ -RA ATIS → PSBL NOW-26 NOV 11Z")
        self.assertEqual(result["wxSecondaryAlert"]["tafStartIso"], "2026-11-25T15:00:00Z")
        self.assertEqual(result["wxSecondaryAlert"]["tafEndIso"], "2026-11-26T11:00:00Z")

    def test_does_not_join_across_a_dry_prevailing_group(self):
        taf = TAF.replace("FM251700 01010KT 4SM -RA BR OVC008",
                          "FM251700 01010KT P6SM OVC008 FM251900 01010KT 4SM -RA BR OVC008")
        self.assertEqual(self.summary(taf)["wxSecondaryAlert"]["tafWindow"], "NOW-17Z")

    def test_temporary_rain_does_not_extend_the_prevailing_window(self):
        taf = TAF.replace("FM251700 01010KT 4SM -RA BR OVC008",
                          "FM251700 01010KT P6SM OVC008 TEMPO 2517/2519 4SM -RA OVC008")
        self.assertEqual(self.summary(taf)["wxSecondaryAlert"]["tafWindow"], "NOW-17Z")
