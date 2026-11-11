"""AHAS transport and retained-observation regression tests (no network)."""

import hashlib
import io
import inspect
import json
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import update_weather_local as u


NOW = datetime(2026, 11, 11, 12, 20, tzinfo=timezone.utc)
XML = """<result><Segment>MEMPHIS INTL</Segment>
<DateTime>2026-11-11 12:18:00.000</DateTime>
<NEXRADRISK>LOW</NEXRADRISK><SOARRISK>LOW</SOARRISK>
<BAMRISK>MODERATE</BAMRISK><AHASRISK>LOW</AHASRISK>
<BasedON>NEXRAD</BasedON><TIDepth>9999</TIDepth></result>"""
RISK_URL = (
    "https://www.usahas.com/webservices/Fluffy_AHAS2025.asmx/GetAHASRisk"
    "?Type=ICAO&Area=%27MEMPHIS%20INTL%27&iMonth=11&iDay=11&iHour=12"
)


class AhasRetrievalTests(unittest.TestCase):
    def test_diagnostics_categorize_expiry_without_exposing_exception_text(self):
        error = u.ssl.SSLCertVerificationError("secret-token user@private.example /private/path")
        error.verify_code = 10
        diagnostics = {}
        opener = mock.Mock()
        opener.open.side_effect = u.urllib.error.URLError(error)
        with mock.patch("builtins.print"):
            self.assertEqual(u.fetch_with_opener(opener, "https://www.usahas.com/", diagnostics), "")
        self.assertEqual(diagnostics, {"error": "TLS_CERTIFICATE_EXPIRED"})
        self.assertEqual(u.sanitized_ahas_error(Exception("secret-token")), "UNKNOWN_ERROR")

    def test_diagnostics_only_emit_fixed_categories_or_http_status(self):
        http_error = u.urllib.error.HTTPError(
            "https://secret.example",
            503,
            "secret",
            {},
            io.BytesIO(b""),
        )
        errors = [
            (http_error, "HTTP_503"),
            (u.urllib.error.URLError(u.socket.gaierror("secret")), "DNS_FAILURE"),
            (TimeoutError("secret"), "TIMEOUT"),
            (ConnectionRefusedError("secret"), "CONNECTION_REFUSED"),
            (u.ssl.SSLError("secret"), "TLS_HANDSHAKE_FAILED"),
        ]
        for error, category in errors:
            with self.subTest(category=category):
                self.assertEqual(u.sanitized_ahas_error(error), category)
        http_error.close()

    def test_actual_expiry_is_published_as_current_error_not_cached_error(self):
        error = u.ssl.SSLCertVerificationError("do-not-publish-this")
        error.verify_code = 10
        opener = mock.Mock()
        opener.open.side_effect = u.urllib.error.URLError(error)
        with mock.patch.object(u.urllib.request, "build_opener", return_value=opener), mock.patch.object(
            u,
            "ahas_emergency_now_z",
            return_value=NOW,
        ), mock.patch("builtins.print"):
            failed = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(failed)
        self.assertEqual(payload["bwcLatestAttemptError"], "TLS_CERTIFICATE_EXPIRED")
        self.assertEqual(payload["bwcFetchStatus"], "USED_LAST_GOOD")
        self.assertNotIn("do-not-publish-this", json.dumps(payload))

    def test_redirects_cannot_downgrade_or_leave_ahas(self):
        handler = u.AhasHttpsRedirectHandler()
        request = u.urllib.request.Request("https://www.usahas.com/print.aspx")
        for target in ("http://www.usahas.com/print.aspx", "https://other.example.test/", "https://www.usahas.com.example.test/"):
            with self.subTest(target=target), self.assertRaises(u.urllib.error.URLError):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        allowed = handler.redirect_request(request, None, 302, "Found", {}, "https://usahas.com/print.aspx")
        self.assertEqual(allowed.full_url, "https://usahas.com/print.aspx")
        with mock.patch.object(u, "fetch_with_opener", return_value=XML) as fetch:
            u.fetch_ahas_bwc(NOW)
        self.assertTrue(any(isinstance(h, u.AhasHttpsRedirectHandler) for h in fetch.call_args.args[0].handlers))

        emergency = u.AhasPinnedRiskRedirectHandler()
        emergency_request = u.urllib.request.Request(RISK_URL)
        with self.assertRaises(u.urllib.error.URLError):
            emergency.redirect_request(
                emergency_request,
                None,
                302,
                "Found",
                {},
                RISK_URL,
            )

    def test_verified_risk_service_succeeds_without_print_page_preflight(self):
        with mock.patch.object(u, "fetch_with_opener", return_value=XML) as fetch, mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
        ) as emergency:
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "PARSED_DIRECT_XML")
        self.assertEqual(result["bwcUpdatedZ"], "2026-11-11 12:18:00.000")
        self.assertEqual(result["bwc"], "LOW")
        self.assertEqual(result["bwcTransportSecurity"], "CA_VERIFIED_TLS")
        self.assertEqual(fetch.call_count, 1)
        self.assertTrue(all(call.args[1].startswith("https://www.usahas.com/") for call in fetch.call_args_list))
        emergency.assert_not_called()

    def test_non_expiry_failure_never_invokes_emergency_pin(self):
        for category in (
            "DNS_FAILURE",
            "TIMEOUT",
            "TLS_CERTIFICATE_HOSTNAME_MISMATCH",
            "TLS_HANDSHAKE_FAILED",
        ):
            def fail(_opener, _url, diagnostics=None, **_kwargs):
                diagnostics["error"] = category
                return ""

            with self.subTest(category=category), mock.patch.object(
                u,
                "fetch_with_opener",
                side_effect=fail,
            ) as fetch, mock.patch.object(
                u,
                "fetch_ahas_risk_with_emergency_pin",
            ) as emergency:
                result = u.fetch_ahas_bwc(NOW)
                self.assertEqual(result["bwcFetchStatus"], "RISK_ENDPOINT_FAILED")
                self.assertEqual(result["bwcFetchError"], category)
                self.assertEqual(fetch.call_count, 1)
                emergency.assert_not_called()

    def test_empty_secure_response_remains_failed(self):
        with mock.patch.object(u, "fetch_with_opener", return_value="") as fetch:
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "RISK_ENDPOINT_FAILED")
        self.assertEqual(result["bwc"], "PENDING")
        self.assertEqual(fetch.call_count, 1)

    def test_invalid_xml_is_not_a_success(self):
        with mock.patch.object(u, "fetch_with_opener", return_value="<html>maintenance</html>"):
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "INVALID_RISK_PAYLOAD")
        self.assertEqual(result["bwcFetchError"], "RISK_SEGMENT_MISMATCH")
        self.assertEqual(result["bwc"], "PENDING")

    def test_expiry_uses_fixed_pinned_https_path_and_marks_transport(self):
        calls = []

        def fetch(_opener, _url, diagnostics=None, max_bytes=None):
            calls.append(max_bytes)
            diagnostics["error"] = "NONE"
            if max_bytes is None:
                diagnostics["error"] = "TLS_CERTIFICATE_EXPIRED"
                return ""
            return XML

        with mock.patch.object(u, "fetch_with_opener", side_effect=fetch), mock.patch.object(
            u,
            "ahas_emergency_now_z",
            return_value=NOW,
        ):
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(calls, [None, 256 * 1024])
        self.assertEqual(result["bwc"], "LOW")
        self.assertEqual(result["bwcFetchStatus"], "PARSED_PINNED_EXPIRED_TLS")
        self.assertEqual(result["bwcFetchError"], "NONE")
        self.assertEqual(result["bwcPrimaryFetchError"], "TLS_CERTIFICATE_EXPIRED")
        self.assertEqual(result["bwcTransportSecurity"], "TLS_PINNED_EXPIRED_LEAF")

    def test_emergency_pin_has_exact_scope_and_hard_deadline(self):
        self.assertTrue(u.is_allowed_ahas_emergency_risk_url(RISK_URL))
        rejected = (
            RISK_URL.replace("https://", "http://"),
            RISK_URL.replace("www.usahas.com", "usahas.com"),
            RISK_URL.replace("www.usahas.com", "www.usahas.com.example.test"),
            RISK_URL.replace("GetAHASRisk", "OtherMethod"),
            RISK_URL + "&extra=1",
            RISK_URL.replace("MEMPHIS%20INTL", "NASHVILLE%20INTL"),
            RISK_URL.replace("www.usahas.com", "www.usahas.com:444"),
        )
        for url in rejected:
            with self.subTest(url=url):
                self.assertFalse(u.is_allowed_ahas_emergency_risk_url(url))

        diagnostics = {}
        with mock.patch.object(u.urllib.request, "build_opener") as build:
            body = u.fetch_ahas_risk_with_emergency_pin(
                RISK_URL,
                u.AHAS_EMERGENCY_PIN_DEADLINE_Z,
                diagnostics,
            )
        self.assertEqual(body, "")
        self.assertEqual(diagnostics, {"error": "EMERGENCY_PIN_WINDOW_CLOSED"})
        build.assert_not_called()

        diagnostics = {}
        with mock.patch.object(
            u,
            "ahas_emergency_now_z",
            return_value=u.AHAS_EMERGENCY_PIN_DEADLINE_Z,
        ), mock.patch.object(u.urllib.request, "build_opener") as build:
            body = u.fetch_ahas_risk_with_emergency_pin(RISK_URL, NOW, diagnostics)
        self.assertEqual(body, "")
        self.assertEqual(diagnostics, {"error": "EMERGENCY_PIN_WINDOW_CLOSED"})
        build.assert_not_called()

    def test_expired_primary_after_pin_deadline_fails_closed(self):
        after_deadline = u.AHAS_EMERGENCY_PIN_DEADLINE_Z + timedelta(seconds=1)

        def expired(_opener, _url, diagnostics=None, **_kwargs):
            diagnostics["error"] = "TLS_CERTIFICATE_EXPIRED"
            return ""

        with mock.patch.object(u, "fetch_with_opener", side_effect=expired):
            result = u.fetch_ahas_bwc(after_deadline)
        self.assertEqual(result["bwcFetchStatus"], "RISK_ENDPOINT_FAILED")
        self.assertEqual(result["bwcFetchError"], "EMERGENCY_PIN_WINDOW_CLOSED")

    def test_pin_failure_retains_last_good_and_publishes_fixed_error(self):
        def expired(_opener, _url, diagnostics=None, **_kwargs):
            diagnostics["error"] = "TLS_CERTIFICATE_EXPIRED"
            return ""

        def pin_mismatch(_url, _now_z, diagnostics=None):
            diagnostics["error"] = "TLS_CERTIFICATE_PIN_MISMATCH"
            return ""

        with mock.patch.object(u, "fetch_with_opener", side_effect=expired), mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
            side_effect=pin_mismatch,
        ):
            failed = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(failed)
        self.assertEqual(payload["bwc"], "SEVERE")
        self.assertEqual(payload["bwcUpdatedZ"], "2026-11-10 23:54:00.000")
        self.assertTrue(payload["lastKnownGoodUsed"]["ahas"])
        self.assertEqual(payload["bwcFetchStatus"], "USED_LAST_GOOD")
        self.assertEqual(payload["bwcLatestAttemptStatus"], "RISK_ENDPOINT_FAILED")
        self.assertEqual(payload["bwcLatestAttemptError"], "TLS_CERTIFICATE_PIN_MISMATCH")

    def test_same_socket_certificate_pin_accepts_match_and_rejects_mismatch(self):
        certificate = b"known AHAS leaf DER"
        fingerprint = hashlib.sha256(certificate).hexdigest().upper()

        class FakeSocket:
            def __init__(self):
                self.closed = False

            def getpeercert(self, binary_form=False):
                return certificate if binary_form else {}

            def close(self):
                self.closed = True

        def connect(connection):
            connection.sock = FakeSocket()

        matching = u.AhasPinnedHTTPSConnection(
            "www.usahas.com",
            expected_fingerprints={fingerprint},
        )
        with mock.patch.object(u.http.client.HTTPSConnection, "connect", autospec=True, side_effect=connect):
            matching.connect()
        self.assertFalse(matching.sock.closed)

        mismatched = u.AhasPinnedHTTPSConnection(
            "www.usahas.com",
            expected_fingerprints={"0" * 64},
        )
        with mock.patch.object(u.http.client.HTTPSConnection, "connect", autospec=True, side_effect=connect):
            with self.assertRaises(u.AhasCertificatePinError):
                mismatched.connect()
        self.assertIsNone(mismatched.sock)
        self.assertEqual(
            u.sanitized_ahas_error(u.urllib.error.URLError(u.AhasCertificatePinError("secret"))),
            "TLS_CERTIFICATE_PIN_MISMATCH",
        )

    def test_emergency_response_size_is_bounded(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, size=None):
                return b"x" * size

        opener = mock.Mock()
        opener.open.return_value = Response()
        diagnostics = {}
        self.assertEqual(
            u.fetch_with_opener(opener, RISK_URL, diagnostics, max_bytes=8),
            "",
        )
        self.assertEqual(diagnostics, {"error": "RESPONSE_TOO_LARGE"})

        error_body = io.BytesIO(b"x" * 100)
        http_error = u.urllib.error.HTTPError(RISK_URL, 503, "failure", {}, error_body)
        opener.open.side_effect = http_error
        diagnostics = {}
        with mock.patch("builtins.print"):
            self.assertEqual(
                u.fetch_with_opener(opener, RISK_URL, diagnostics, max_bytes=8),
                "",
            )
        self.assertEqual(error_body.tell(), 9)
        self.assertEqual(diagnostics, {"error": "HTTP_503"})
        http_error.close()

    def test_payload_requires_kmem_current_time_and_explicit_risks(self):
        cases = {
            "RISK_SEGMENT_MISMATCH": XML.replace("MEMPHIS INTL", "NASHVILLE INTL"),
            "RISK_TIMESTAMP_STALE": XML.replace("2026-11-11 12:18:00.000", "2026-11-11 10:49:59.000"),
            "RISK_TIMESTAMP_FUTURE": XML.replace("2026-11-11 12:18:00.000", "2026-11-11 12:22:01.000"),
            "RISK_TIMESTAMP_INVALID": XML.replace("2026-11-11 12:18:00.000", "tomorrow-ish"),
            "RISK_VALUE_INVALID": XML.replace("<AHASRISK>LOW</AHASRISK>", "<AHASRISK></AHASRISK>"),
        }
        for expected, xml_text in cases.items():
            with self.subTest(expected=expected):
                self.assertEqual(u.validate_ahas_risk_payload(xml_text, NOW), expected)
                with mock.patch.object(u, "fetch_with_opener", return_value=xml_text):
                    result = u.fetch_ahas_bwc(NOW)
                self.assertEqual(result["bwcFetchStatus"], "INVALID_RISK_PAYLOAD")
                self.assertEqual(result["bwcFetchError"], expected)
                self.assertEqual(result["bwc"], "PENDING")

    def test_no_plain_http_fallback_and_expiry_is_the_only_pin_trigger(self):
        import ssl
        opener = mock.Mock()
        opener.open.side_effect = ssl.SSLCertVerificationError("certificate rejected")
        with mock.patch("builtins.print"):
            self.assertEqual(u.fetch_with_opener(opener, "https://www.usahas.com/"), "")
        self.assertEqual(opener.open.call_count, 1)
        source = inspect.getsource(u.fetch_ahas_bwc) + inspect.getsource(u.fetch_ahas_risk_with_emergency_pin)
        self.assertNotIn("http://", source)
        self.assertNotIn("_create_unverified_context", source)
        self.assertIn('== "TLS_CERTIFICATE_EXPIRED"', source)

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
        with mock.patch.object(u, "fetch_with_opener", return_value=XML):
            direct = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(direct)
        self.assertEqual(payload["bwc"], "LOW")
        self.assertEqual(payload["bwcUpdatedZ"], "2026-11-11 12:18:00.000")
        self.assertFalse(payload["lastKnownGoodUsed"]["ahas"])
        self.assertEqual(payload["bwcFetchStatus"], "PARSED_DIRECT_XML")
        self.assertEqual(payload["bwcLatestAttemptStatus"], "PARSED_DIRECT_XML")

    def test_pinned_recovery_publishes_current_value_with_visible_warning_status(self):
        def fetch(_opener, _url, diagnostics=None, max_bytes=None):
            diagnostics["error"] = "NONE"
            if max_bytes is None:
                diagnostics["error"] = "TLS_CERTIFICATE_EXPIRED"
                return ""
            return XML

        with mock.patch.object(u, "fetch_with_opener", side_effect=fetch), mock.patch.object(
            u,
            "ahas_emergency_now_z",
            return_value=NOW,
        ):
            direct = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(direct)
        self.assertEqual(payload["bwc"], "LOW")
        self.assertEqual(payload["bwcUpdatedZ"], "2026-11-11 12:18:00.000")
        self.assertFalse(payload["lastKnownGoodUsed"]["ahas"])
        self.assertEqual(payload["bwcFetchStatus"], "PARSED_PINNED_EXPIRED_TLS")
        self.assertEqual(payload["bwcLatestAttemptStatus"], "PARSED_PINNED_EXPIRED_TLS")
        self.assertEqual(payload["bwcTransportSecurity"], "TLS_PINNED_EXPIRED_LEAF")
        self.assertEqual(payload["bwcLatestAttemptPrimaryError"], "TLS_CERTIFICATE_EXPIRED")


if __name__ == "__main__":
    unittest.main()
