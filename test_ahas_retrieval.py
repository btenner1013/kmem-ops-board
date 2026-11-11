"""AHAS transport and retained-observation regression tests (no network)."""

import inspect
import json
import unittest
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import update_weather_local as u


NOW = datetime(2026, 11, 11, 12, 20, tzinfo=timezone.utc)
XML = """<result><Segment>MEMPHIS INTL</Segment>
<DateTime>2026-11-11 12:18:00.000</DateTime>
<NEXRADRISK>LOW</NEXRADRISK><SOARRISK>LOW</SOARRISK>
<BAMRISK>MODERATE</BAMRISK><AHASRISK>LOW</AHASRISK>
<BasedON>NEXRAD</BasedON><TIDepth>9999</TIDepth></result>"""


class AhasRetrievalTests(unittest.TestCase):
    def test_redirects_cannot_downgrade_or_leave_ahas(self):
        handler = u.AhasHttpsRedirectHandler()
        request = u.urllib.request.Request("https://www.usahas.com/print.aspx")
        for target in ("http://www.usahas.com/print.aspx", "https://other.example.test/", "https://www.usahas.com.example.test/"):
            with self.subTest(target=target), self.assertRaises(u.urllib.error.URLError):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        allowed = handler.redirect_request(request, None, 302, "Found", {}, "https://usahas.com/print.aspx")
        self.assertEqual(allowed.full_url, "https://usahas.com/print.aspx")
        with mock.patch.object(u, "fetch_with_opener", side_effect=["print", XML]) as fetch:
            u.fetch_ahas_bwc(NOW)
        self.assertTrue(any(isinstance(h, u.AhasHttpsRedirectHandler) for h in fetch.call_args.args[0].handlers))

    def test_risk_service_can_succeed_when_optional_print_page_fails(self):
        with mock.patch.object(u, "fetch_with_opener", side_effect=["", XML]) as fetch:
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "PARSED_DIRECT_XML")
        self.assertEqual(result["bwcUpdatedZ"], "2026-11-11 12:18:00.000")
        self.assertEqual(result["bwc"], "LOW")
        self.assertEqual(fetch.call_count, 2)
        self.assertTrue(all(call.args[1].startswith("https://www.usahas.com/") for call in fetch.call_args_list))

    def test_both_secure_endpoints_failing_remains_failed(self):
        with mock.patch.object(u, "fetch_with_opener", return_value="") as fetch:
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "RISK_ENDPOINT_FAILED")
        self.assertEqual(result["bwc"], "PENDING")
        self.assertEqual(fetch.call_count, 2)

    def test_invalid_xml_is_not_a_success(self):
        with mock.patch.object(u, "fetch_with_opener", side_effect=["print", "<html>maintenance</html>"]):
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "NO_RESULT_ROW")
        self.assertEqual(result["bwc"], "PENDING")

    def test_tls_errors_remain_failed_without_an_insecure_retry(self):
        import ssl
        opener = mock.Mock()
        opener.open.side_effect = ssl.SSLCertVerificationError("certificate rejected")
        with mock.patch("builtins.print"):
            self.assertEqual(u.fetch_with_opener(opener, "https://www.usahas.com/"), "")
        self.assertEqual(opener.open.call_count, 1)
        source = inspect.getsource(u.fetch_ahas_bwc) + inspect.getsource(u.fetch_with_opener)
        self.assertNotIn("http://", source)
        self.assertNotIn("CERT_NONE", source)
        self.assertNotIn("_create_unverified_context", source)

    def build_payload(self, direct, previous=None):
        fixture = json.loads((Path(__file__).parent / "weather.json").read_text(encoding="utf-8"))
        fixture.update({
            "bwc": "SEVERE", "bwcAhasRisk": "SEVERE", "bwcBasedOn": "NEXRAD",
            "bwcUpdatedZ": "2026-11-10 23:54:00.000", "bwcFetchStatus": "PARSED_DIRECT_XML",
        })
        if previous is not None:
            fixture.update(previous)

        class FixedDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 11, 11, 12, 20, tzinfo=timezone.utc)

        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(u, "datetime", FixedDatetime))
            for name, value in {
                "load_previous_weather": fixture,
                "load_trend_history": [],
                "fetch_current_metar": fixture["metar"],
                "fetch_first_nonempty": fixture["taf"],
                "fetch_current_atis": fixture["atisText"],
                "fetch_ahas_bwc": direct,
                "fetch_mil_notams": fixture,
            }.items():
                stack.enter_context(mock.patch.object(u, name, return_value=value))
            for name in ("snapshot_current_weather_before_overwrite", "maintain_bwc_history_safely", "maintain_atis_history_safely", "maintain_taf_current_safely", "save_last_good_weather", "save_repo_last_good_weather", "save_trend_history"):
                stack.enter_context(mock.patch.object(u, name))
            stack.enter_context(mock.patch.object(u, "fetch_url", side_effect=AssertionError("unexpected network call")))
            stack.enter_context(mock.patch("builtins.print"))
            writer = stack.enter_context(mock.patch.object(u, "write_weather_json"))
            u.build_weather_json()
        return writer.call_args.args[1]

    def test_generator_preserves_risk_time_and_reports_current_failure(self):
        with mock.patch.object(u, "fetch_with_opener", return_value=""):
            failed = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(failed)
        self.assertEqual(payload["bwc"], "SEVERE")
        self.assertEqual(payload["bwcUpdatedZ"], "2026-11-10 23:54:00.000")
        self.assertTrue(payload["lastKnownGoodUsed"]["ahas"])
        self.assertEqual(payload["bwcFetchStatus"], "USED_LAST_GOOD")
        self.assertEqual(payload["bwcLatestAttemptStatus"], "RISK_ENDPOINT_FAILED")
        self.assertEqual(payload["bwcLatestAttemptZ"], "2026-11-11T12:20:00Z")

    def test_repeated_failure_does_not_promote_a_cached_success(self):
        with mock.patch.object(u, "fetch_with_opener", return_value=""):
            failed = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(failed, {"bwcFetchStatus": "USED_LAST_GOOD"})
        self.assertEqual(payload["bwcFetchStatus"], "USED_LAST_GOOD")
        self.assertEqual(payload["bwcLatestAttemptStatus"], "RISK_ENDPOINT_FAILED")

    def test_recovery_replaces_cache_and_clears_last_known_flag(self):
        with mock.patch.object(u, "fetch_with_opener", side_effect=["print", XML]):
            direct = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(direct)
        self.assertEqual(payload["bwc"], "LOW")
        self.assertEqual(payload["bwcUpdatedZ"], "2026-11-11 12:18:00.000")
        self.assertFalse(payload["lastKnownGoodUsed"]["ahas"])
        self.assertEqual(payload["bwcFetchStatus"], "PARSED_DIRECT_XML")
        self.assertEqual(payload["bwcLatestAttemptStatus"], "PARSED_DIRECT_XML")


if __name__ == "__main__":
    unittest.main()
