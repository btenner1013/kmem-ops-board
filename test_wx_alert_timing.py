from datetime import datetime, timezone
import unittest
from unittest.mock import patch
import update_weather_local as wx

NOW = datetime(2026,11,25,21,30,tzinfo=timezone.utc)
class Fixed(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)

RAIN = "KMEM 252054Z 20010KT 5SM -RA OVC020 15/12 A2990"
CLEAR = RAIN.replace("-RA ","")
START = "TAF KMEM 252040Z 2521/2621 20010KT "

class TimingTests(unittest.TestCase):
    def select(self, taf, metar=RAIN, atis=""):
        with patch.object(wx, "datetime", Fixed):
            return wx.detect_weather_alerts(metar, START + taf, atis)
    def timing(self, text):
        alerts=self.select(text)
        self.assertEqual(len(alerts),1)
        return alerts[0]["forecastTiming"]
    def test_adjacent_cross_day(self):
        self.assertEqual(self.timing("5SM -RA OVC020 FM252300 4SM -RA OVC013 FM261117 P6SM OVC010"), "through 26 NOV 1117Z")
    def test_next_day_whole_hour(self):
        self.assertEqual(self.timing("5SM -RA OVC020 FM261100 P6SM OVC010"), "through 26 NOV 1100Z")
    def test_midnight(self):
        self.assertEqual(self.timing("5SM -RA OVC020 FM260000 P6SM OVC010"), "through 26 NOV 0000Z")
    def test_gap(self):
        self.assertEqual(self.timing("5SM -RA OVC020 FM252300 P6SM OVC010 FM260100 5SM -RA OVC020"),"through 23Z")
        self.assertEqual(self.timing("P6SM OVC020 FM252300 5SM -RA OVC020"),"")
    def test_tempo_is_not_prevailing_or_prob(self):
        self.assertEqual(self.timing("P6SM OVC020 TEMPO 2521/2523 5SM -RA OVC020"),"TEMPO 21–23Z")
        self.assertEqual(self.timing("P6SM OVC020 PROB30 TEMPO 2521/2523 5SM -RA OVC020"),"")
    def test_other_hazards_do_not_replace_current(self):
        alerts=self.select("2SM +TSRA OVC008CB")
        self.assertEqual((alerts[0]["code"],alerts[0]["forecastTiming"]),("-RA",""))
    def test_fallback_still_works(self):
        alerts=self.select("P6SM OVC020 FM252300 5SM -RA OVC020", CLEAR)
        self.assertEqual(alerts[0]["sources"],["TAF"])
        self.assertIn("PSBL",alerts[0]["displayText"])
if __name__ == "__main__":
    unittest.main()
