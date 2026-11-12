"""AHAS transport and retained-observation regression tests (no network)."""

import hashlib
import io
import inspect
import json
import os
import subprocess
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
    def test_windows_directory_comes_from_winapi_not_mutable_environment(self):
        source = inspect.getsource(u._windows_directory_path)
        self.assertIn("GetWindowsDirectoryW", source)
        self.assertNotIn("os.environ", source)

    def test_windows_system_curl_path_uses_only_sysnative_or_system32(self):
        sysnative = os.path.abspath(r"C:\Windows\Sysnative\curl.exe")
        system32 = os.path.abspath(r"C:\Windows\System32\curl.exe")

        with mock.patch.object(
            u,
            "_windows_directory_path",
            return_value=os.path.abspath(r"C:\Windows"),
        ), mock.patch.dict(
            u.os.environ,
            {
                "SystemRoot": r"C:\untrusted-absolute-root",
                "WINDIR": r"C:\untrusted-absolute-root",
                "PATH": r"C:\untrusted-path-shadow",
            },
            clear=False,
        ), mock.patch.object(
            u.os.path,
            "isfile",
            side_effect=lambda path: os.path.abspath(path) == sysnative,
        ) as isfile:
            self.assertEqual(u.windows_system_curl_path(), sysnative)
        checked = [os.path.abspath(call.args[0]) for call in isfile.call_args_list]
        self.assertEqual(checked, [sysnative])
        self.assertTrue(all("untrusted-path-shadow" not in path for path in checked))

        with mock.patch.object(
            u,
            "_windows_directory_path",
            return_value=os.path.abspath(r"C:\Windows"),
        ), mock.patch.object(
            u.os.path,
            "isfile",
            side_effect=lambda path: os.path.abspath(path) == system32,
        ) as isfile:
            self.assertEqual(u.windows_system_curl_path(), system32)
        checked = [os.path.abspath(call.args[0]) for call in isfile.call_args_list]
        self.assertEqual(checked, [sysnative, system32])

        with mock.patch.object(u, "_windows_directory_path", return_value=None), mock.patch.object(
            u.os.path,
            "isfile",
        ) as isfile:
            self.assertIsNone(u.windows_system_curl_path())
            isfile.assert_not_called()

    def test_windows_trust_fetch_is_https_only_bounded_and_uses_no_bypass_flags(self):
        route = u.build_ahas_risk_routes(NOW)[0]
        system_curl = os.path.abspath(r"C:\Windows\System32\curl.exe")
        diagnostics = {}

        def completed_fetch(command, **_kwargs):
            output_index = command.index("--output") + 1
            Path(command[output_index]).write_bytes(XML.encode("utf-8"))
            return subprocess.CompletedProcess(
                command,
                0,
                "KMEM_AHAS_HTTP_STATUS:200",
                "",
            )

        with mock.patch.object(
            u,
            "windows_system_curl_path",
            return_value=system_curl,
        ) as locate, mock.patch.object(
            u,
            "run_bounded_process",
            side_effect=completed_fetch,
        ) as run, mock.patch.dict(
            u.os.environ,
            {
                "CURL_CA_BUNDLE": r"C:\untrusted\ca.pem",
                "SSL_CERT_FILE": r"C:\untrusted\ca.pem",
                "SSL_CERT_DIR": r"C:\untrusted\certs",
                "REQUESTS_CA_BUNDLE": r"C:\untrusted\requests.pem",
                "CURL_SSL_BACKEND": "untrusted-backend",
            },
            clear=False,
        ):
            body = u.fetch_ahas_risk_with_windows_trust(
                route,
                diagnostics=diagnostics,
                timeout=7.5,
            )

        self.assertEqual(body, XML)
        self.assertEqual(diagnostics, {"error": "NONE"})
        locate.assert_called_once_with()
        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertEqual(os.path.abspath(command[0]), system_curl)
        self.assertEqual(command.count(route["url"]), 1)
        self.assertTrue(run.call_args.kwargs.get("capture_output"))
        self.assertGreater(run.call_args.kwargs["timeout"], 0)
        self.assertLessEqual(run.call_args.kwargs["timeout"], 7.5)
        child_environment = run.call_args.kwargs["env"]
        self.assertTrue({
            "CURL_CA_BUNDLE",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "REQUESTS_CA_BUNDLE",
            "CURL_SSL_BACKEND",
        }.isdisjoint(key.upper() for key in child_environment))

        lowered = [str(part).lower() for part in command]
        forbidden = {
            "-k",
            "--insecure",
            "-l",
            "--location",
            "--location-trusted",
            "--cacert",
            "--capath",
        }
        self.assertTrue(forbidden.isdisjoint(lowered), command)
        self.assertIn("--max-time", lowered)
        self.assertIn("--max-filesize", lowered)
        self.assertIn("--max-redirs", lowered)
        self.assertEqual(command[lowered.index("--max-redirs") + 1], "0")
        max_size_index = lowered.index("--max-filesize")
        self.assertEqual(int(command[max_size_index + 1]), u.AHAS_RESPONSE_MAX_BYTES)

    def test_windows_trust_fetch_rejects_unapproved_routes_and_oversize_output(self):
        route = u.build_ahas_risk_routes(NOW)[0]
        system_curl = os.path.abspath(r"C:\Windows\System32\curl.exe")
        unapproved = dict(route, url=route["url"].replace("https://", "http://"))
        diagnostics = {}
        with mock.patch.object(u, "run_bounded_process") as run:
            self.assertEqual(
                u.fetch_ahas_risk_with_windows_trust(
                    unapproved,
                    diagnostics=diagnostics,
                ),
                "",
            )
        run.assert_not_called()
        self.assertNotEqual(diagnostics.get("error"), "NONE")

        oversized = "x" * (u.AHAS_RESPONSE_MAX_BYTES + 1)

        def completed_oversize(command, **_kwargs):
            output_index = command.index("--output") + 1
            Path(command[output_index]).write_text(oversized, encoding="utf-8")
            return subprocess.CompletedProcess(
                command,
                0,
                "KMEM_AHAS_HTTP_STATUS:200",
                "",
            )

        diagnostics = {}
        with mock.patch.object(
            u,
            "windows_system_curl_path",
            return_value=system_curl,
        ), mock.patch.object(
            u,
            "run_bounded_process",
            side_effect=completed_oversize,
        ):
            self.assertEqual(
                u.fetch_ahas_risk_with_windows_trust(
                    route,
                    diagnostics=diagnostics,
                ),
                "",
            )
        self.assertEqual(diagnostics, {"error": "RESPONSE_TOO_LARGE"})

    def test_windows_trust_recovers_only_approved_python_tls_failures(self):
        eligible = (
            "TLS_CERTIFICATE_ISSUER_UNAVAILABLE",
            "TLS_CERTIFICATE_CHAIN_UNVERIFIED",
            "TLS_CERTIFICATE_INVALID",
            "TLS_HANDSHAKE_FAILED",
        )
        for category in eligible:
            def python_failure(_opener, _url, diagnostics=None, **_kwargs):
                diagnostics["error"] = category
                return ""

            def windows_success(_route, diagnostics=None, **_kwargs):
                diagnostics["error"] = "NONE"
                return XML

            with self.subTest(category=category), mock.patch.object(
                u,
                "fetch_with_opener",
                side_effect=python_failure,
            ), mock.patch.object(
                u,
                "windows_system_curl_path",
                return_value=os.path.abspath(r"C:\Windows\System32\curl.exe"),
            ), mock.patch.object(
                u,
                "fetch_ahas_risk_with_windows_trust",
                side_effect=windows_success,
            ) as windows, mock.patch.object(
                u,
                "fetch_ahas_risk_with_emergency_pin",
            ) as emergency:
                result = u.fetch_ahas_bwc(NOW)

            self.assertEqual(result["bwc"], "LOW")
            self.assertEqual(result["bwcFetchStatus"], "PARSED_WINDOWS_SCHANNEL_TLS")
            self.assertEqual(
                result["bwcTransportSecurity"],
                "WINDOWS_SCHANNEL_CA_VERIFIED_TLS",
            )
            self.assertEqual(result["bwcRetrievalTransport"], "WINDOWS_CURL_SCHANNEL")
            self.assertEqual(result["bwcRetrievalRoute"], "WWW_GET")
            self.assertEqual(result["bwcPrimaryFetchError"], category)
            self.assertTrue(result["bwcLiveValidated"])
            windows.assert_called()
            emergency.assert_not_called()

    def test_windows_trust_is_not_used_for_other_failure_categories(self):
        ineligible = (
            "DNS_FAILURE",
            "TIMEOUT",
            "TLS_CERTIFICATE_NOT_YET_VALID",
            "TLS_CERTIFICATE_SELF_SIGNED",
            "TLS_CERTIFICATE_SELF_SIGNED_CHAIN",
            "TLS_CERTIFICATE_HOSTNAME_MISMATCH",
            "TLS_CERTIFICATE_EXPIRED",
        )
        for category in ineligible:
            def python_failure(_opener, _url, diagnostics=None, **_kwargs):
                diagnostics["error"] = category
                return ""

            def pinned_success(_url, _now_z, diagnostics=None, **_kwargs):
                diagnostics["error"] = "NONE"
                return XML

            with self.subTest(category=category), mock.patch.object(
                u,
                "fetch_with_opener",
                side_effect=python_failure,
            ), mock.patch.object(
                u,
                "fetch_ahas_risk_with_windows_trust",
            ) as windows, mock.patch.object(
                u,
                "fetch_ahas_risk_with_emergency_pin",
                side_effect=pinned_success,
            ) as emergency:
                result = u.fetch_ahas_bwc(NOW)

            windows.assert_not_called()
            if category == "TLS_CERTIFICATE_EXPIRED":
                emergency.assert_called()
                self.assertEqual(result["bwcFetchStatus"], "PARSED_PINNED_EXPIRED_TLS")
            else:
                emergency.assert_not_called()
                self.assertEqual(result["bwcFetchStatus"], "RISK_ENDPOINT_FAILED")

    def test_windows_trust_precedes_expired_pin_and_payload_is_still_validated(self):
        python_errors = iter((
            "TLS_CERTIFICATE_ISSUER_UNAVAILABLE",
            "TLS_CERTIFICATE_EXPIRED",
        ))

        def python_failure(_opener, _url, diagnostics=None, **_kwargs):
            diagnostics["error"] = next(python_errors)
            return ""

        def windows_success(_route, diagnostics=None, **_kwargs):
            diagnostics["error"] = "NONE"
            return XML

        with mock.patch.object(
            u,
            "fetch_with_opener",
            side_effect=python_failure,
        ), mock.patch.object(
            u,
            "windows_system_curl_path",
            return_value=os.path.abspath(r"C:\Windows\System32\curl.exe"),
        ), mock.patch.object(
            u,
            "fetch_ahas_risk_with_windows_trust",
            side_effect=windows_success,
        ) as windows, mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
        ) as emergency:
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(result["bwcFetchStatus"], "PARSED_WINDOWS_SCHANNEL_TLS")
        windows.assert_called()
        emergency.assert_not_called()

        def issuer_failure(_opener, _url, diagnostics=None, **_kwargs):
            diagnostics["error"] = "TLS_CERTIFICATE_ISSUER_UNAVAILABLE"
            return ""

        def invalid_windows_payload(_route, diagnostics=None, **_kwargs):
            diagnostics["error"] = "NONE"
            return XML.replace("MEMPHIS INTL", "NASHVILLE INTL")

        with mock.patch.object(
            u,
            "fetch_with_opener",
            side_effect=issuer_failure,
        ), mock.patch.object(
            u,
            "windows_system_curl_path",
            return_value=os.path.abspath(r"C:\Windows\System32\curl.exe"),
        ), mock.patch.object(
            u,
            "fetch_ahas_risk_with_windows_trust",
            side_effect=invalid_windows_payload,
        ), mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
        ) as emergency:
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(result["bwc"], "PENDING")
        self.assertEqual(result["bwcFetchStatus"], "INVALID_RISK_PAYLOAD")
        self.assertEqual(result["bwcFetchError"], "RISK_SEGMENT_MISMATCH")
        self.assertFalse(result["bwcLiveValidated"])
        emergency.assert_not_called()

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
        self.assertEqual(result["bwcRetrievalRoute"], "WWW_GET")
        self.assertEqual(result["bwcRetrievalAttempts"], 1)
        self.assertTrue(result["bwcLiveValidated"])
        self.assertEqual(fetch.call_count, 1)
        self.assertTrue(all(call.args[1].startswith("https://www.usahas.com/") for call in fetch.call_args_list))
        emergency.assert_not_called()

    def test_official_form_post_recovers_after_primary_get_failure(self):
        calls = []

        def fetch(_opener, url, diagnostics=None, form_data=None, **_kwargs):
            calls.append((url, form_data))
            diagnostics["error"] = "NONE"
            if form_data is None:
                diagnostics["error"] = "HTTP_500"
                return ""
            return XML

        with mock.patch.object(u, "fetch_with_opener", side_effect=fetch):
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(len(calls), 2)
        self.assertIsNone(calls[0][1])
        self.assertIsNotNone(calls[1][1])
        self.assertEqual(result["bwcRetrievalRoute"], "WWW_POST")
        self.assertEqual(result["bwcFetchStatus"], "PARSED_DIRECT_XML")

    def test_bare_host_recovers_after_www_host_layer_failure(self):
        calls = []

        def fetch(_opener, url, diagnostics=None, **_kwargs):
            calls.append(url)
            diagnostics["error"] = "NONE"
            if "www.usahas.com" in url:
                diagnostics["error"] = "DNS_FAILURE"
                return ""
            return XML

        with mock.patch.object(u, "fetch_with_opener", side_effect=fetch):
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(len(calls), 2, "same-host POST is skipped for DNS failure")
        self.assertIn("www.usahas.com", calls[0])
        self.assertIn("https://usahas.com/", calls[1])
        self.assertEqual(result["bwcRetrievalRoute"], "BARE_GET")

    def test_bare_form_post_recovers_after_www_and_bare_get_failures(self):
        calls = []

        def fetch(_opener, url, diagnostics=None, form_data=None, **_kwargs):
            calls.append((url, form_data))
            diagnostics["error"] = "NONE"
            if "www.usahas.com" in url:
                diagnostics["error"] = "DNS_FAILURE"
                return ""
            if form_data is None:
                diagnostics["error"] = "HTTP_500"
                return ""
            return XML

        with mock.patch.object(u, "fetch_with_opener", side_effect=fetch):
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(len(calls), 3)
        self.assertIsNone(calls[1][1])
        self.assertIsNotNone(calls[2][1])
        self.assertEqual(result["bwcRetrievalRoute"], "BARE_POST")

    def test_pinned_form_post_recovers_after_invalid_pinned_get(self):
        pinned_calls = []

        def expired(_opener, _url, diagnostics=None, **_kwargs):
            diagnostics["error"] = "TLS_CERTIFICATE_EXPIRED"
            return ""

        def pinned(_url, _now_z, diagnostics=None, form_data=None, **_kwargs):
            pinned_calls.append(form_data)
            diagnostics["error"] = "NONE"
            return XML if form_data is not None else "<html>maintenance</html>"

        with mock.patch.object(u, "fetch_with_opener", side_effect=expired), mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
            side_effect=pinned,
        ):
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(len(pinned_calls), 2)
        self.assertIsNone(pinned_calls[0])
        self.assertIsNotNone(pinned_calls[1])
        self.assertEqual(result["bwcRetrievalRoute"], "WWW_POST")
        self.assertEqual(result["bwcFetchStatus"], "PARSED_PINNED_EXPIRED_TLS")

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
                "windows_system_curl_path",
                return_value=None,
            ), mock.patch.object(
                u,
                "fetch_ahas_risk_with_emergency_pin",
            ) as emergency:
                result = u.fetch_ahas_bwc(NOW)
                self.assertEqual(result["bwcFetchStatus"], "RISK_ENDPOINT_FAILED")
                self.assertEqual(result["bwcFetchError"], category)
                expected_calls = 4 if category == "TIMEOUT" else 2
                self.assertEqual(fetch.call_count, expected_calls)
                emergency.assert_not_called()

    def test_empty_secure_response_remains_failed(self):
        with mock.patch.object(u, "fetch_with_opener", return_value="") as fetch:
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "RISK_ENDPOINT_FAILED")
        self.assertEqual(result["bwc"], "PENDING")
        self.assertEqual(fetch.call_count, 4)

    def test_invalid_xml_is_not_a_success(self):
        with mock.patch.object(u, "fetch_with_opener", return_value="<html>maintenance</html>"):
            result = u.fetch_ahas_bwc(NOW)
        self.assertEqual(result["bwcFetchStatus"], "INVALID_RISK_PAYLOAD")
        self.assertEqual(result["bwcFetchError"], "RISK_SEGMENT_MISMATCH")
        self.assertEqual(result["bwc"], "PENDING")

    def test_expiry_uses_fixed_pinned_https_path_and_marks_transport(self):
        normal_routes = []
        pinned_routes = []

        def expired(_opener, url, diagnostics=None, **_kwargs):
            normal_routes.append(url)
            diagnostics["error"] = "TLS_CERTIFICATE_EXPIRED"
            return ""

        def pinned(url, _now_z, diagnostics=None, form_data=None, **_kwargs):
            pinned_routes.append((url, form_data))
            diagnostics["error"] = "NONE"
            return XML

        with mock.patch.object(u, "fetch_with_opener", side_effect=expired), mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
            side_effect=pinned,
        ):
            result = u.fetch_ahas_bwc(NOW)

        self.assertEqual(len(normal_routes), 2, "certificate failures skip same-host POST")
        self.assertEqual(len(pinned_routes), 1)
        self.assertEqual(result["bwc"], "LOW")
        self.assertEqual(result["bwcFetchStatus"], "PARSED_PINNED_EXPIRED_TLS")
        self.assertEqual(result["bwcFetchError"], "NONE")
        self.assertEqual(result["bwcPrimaryFetchError"], "TLS_CERTIFICATE_EXPIRED")
        self.assertEqual(result["bwcTransportSecurity"], "TLS_PINNED_EXPIRED_LEAF")
        self.assertEqual(result["bwcRetrievalRoute"], "WWW_GET")
        self.assertEqual(result["bwcRetrievalAttempts"], 3)
        self.assertTrue(result["bwcLiveValidated"])

    def test_emergency_pin_has_exact_scope_and_hard_deadline(self):
        self.assertTrue(u.is_allowed_ahas_emergency_risk_url(RISK_URL))
        rejected = (
            RISK_URL.replace("https://", "http://"),
            RISK_URL.replace("www.usahas.com", "www.usahas.com.example.test"),
            RISK_URL.replace("GetAHASRisk", "OtherMethod"),
            RISK_URL + "&extra=1",
            RISK_URL.replace("MEMPHIS%20INTL", "NASHVILLE%20INTL"),
            RISK_URL.replace("www.usahas.com", "www.usahas.com:444"),
        )
        for url in rejected:
            with self.subTest(url=url):
                self.assertFalse(u.is_allowed_ahas_emergency_risk_url(url))

        bare_url = RISK_URL.replace("www.usahas.com", "usahas.com")
        self.assertTrue(u.is_allowed_ahas_emergency_risk_url(bare_url))
        post_url, encoded = RISK_URL.split("?", 1)
        self.assertTrue(
            u.is_allowed_ahas_emergency_risk_request(
                post_url,
                "POST",
                encoded.encode("ascii"),
            )
        )
        self.assertFalse(
            u.is_allowed_ahas_emergency_risk_request(
                post_url,
                "POST",
                (encoded + "&extra=1").encode("ascii"),
            )
        )
        self.assertFalse(
            u.is_allowed_ahas_emergency_risk_request(
                post_url,
                "POST",
                (encoded + "&Type=ICAO").encode("ascii"),
            )
        )
        self.assertFalse(u.is_allowed_ahas_emergency_risk_request(post_url, "PUT", encoded))

        bad_post = u.urllib.request.Request(
            post_url,
            data=encoded.encode("ascii"),
            headers={"Content-Type": "application/json"},
        )
        handler = u.AhasPinnedHTTPSHandler(u.AHAS_EMERGENCY_LEAF_SHA256)
        with self.assertRaises(u.urllib.error.URLError):
            handler.https_open(bad_post)

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

        def pin_mismatch(_url, _now_z, diagnostics=None, form_data=None, **_kwargs):
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

    def test_form_fallback_builds_exact_post_body_and_content_type(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size=None):
                return XML.encode("utf-8")

        route = u.build_ahas_risk_routes(NOW)[1]
        opener = mock.Mock()
        opener.open.return_value = Response()
        diagnostics = {}
        body = u.fetch_with_opener(
            opener,
            route["url"],
            diagnostics,
            max_bytes=u.AHAS_RESPONSE_MAX_BYTES,
            form_data=route["formData"],
        )

        request = opener.open.call_args.args[0]
        self.assertEqual(body, XML)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            request.get_header("Content-type"),
            "application/x-www-form-urlencoded",
        )
        self.assertTrue(
            u.is_allowed_ahas_emergency_risk_request(
                request.full_url,
                request.get_method(),
                request.data,
            )
        )

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

    def test_live_no_data_never_becomes_a_green_none_risk(self):
        no_data_xml = XML.replace(
            "<AHASRISK>LOW</AHASRISK>",
            "<AHASRISK>NO DATA</AHASRISK>",
        )
        with mock.patch.object(u, "fetch_with_opener", return_value=no_data_xml):
            direct = u.fetch_ahas_bwc(NOW)

        self.assertEqual(direct["bwc"], "PENDING")
        self.assertEqual(direct["bwcAhasRisk"], "NO DATA")
        self.assertTrue(direct["bwcLiveValidated"])

        payload = self.build_payload(direct)
        self.assertEqual(payload["bwc"], "SEVERE")
        self.assertEqual(payload["bwcFetchStatus"], "USED_LAST_GOOD")
        self.assertTrue(payload["lastKnownGoodUsed"]["ahas"])
        self.assertEqual(payload["bwcLatestAttemptStatus"], "PARSED_DIRECT_XML")
        self.assertTrue(payload["bwcLatestAttemptLiveValidated"])

    def test_pinned_recovery_publishes_current_validated_value(self):
        def expired(_opener, _url, diagnostics=None, **_kwargs):
            diagnostics["error"] = "TLS_CERTIFICATE_EXPIRED"
            return ""

        def pinned(_url, _now_z, diagnostics=None, form_data=None, **_kwargs):
            diagnostics["error"] = "NONE"
            return XML

        with mock.patch.object(u, "fetch_with_opener", side_effect=expired), mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
            side_effect=pinned,
        ):
            direct = u.fetch_ahas_bwc(NOW)
        payload = self.build_payload(direct)
        self.assertEqual(payload["bwc"], "LOW")
        self.assertEqual(payload["bwcUpdatedZ"], "2026-11-11 12:18:00.000")
        self.assertFalse(payload["lastKnownGoodUsed"]["ahas"])
        self.assertEqual(
            payload["bwcFetchStatus"],
            "PARSED_DIRECT_XML",
            "legacy open displays must turn AHAS green without reloading index.html",
        )
        self.assertEqual(payload["bwcLatestAttemptStatus"], "PARSED_PINNED_EXPIRED_TLS")
        self.assertEqual(payload["bwcTransportSecurity"], "TLS_PINNED_EXPIRED_LEAF")
        self.assertTrue(payload["bwcLiveValidated"])
        self.assertEqual(payload["bwcRetrievalRoute"], "WWW_GET")
        self.assertEqual(payload["bwcLatestAttemptPrimaryError"], "TLS_CERTIFICATE_EXPIRED")

    def test_windows_trust_recovery_keeps_legacy_display_success_and_exact_provenance(self):
        def issuer_failure(_opener, _url, diagnostics=None, **_kwargs):
            diagnostics["error"] = "TLS_CERTIFICATE_ISSUER_UNAVAILABLE"
            return ""

        def windows_success(_route, diagnostics=None, **_kwargs):
            diagnostics["error"] = "NONE"
            return XML

        with mock.patch.object(
            u,
            "fetch_with_opener",
            side_effect=issuer_failure,
        ), mock.patch.object(
            u,
            "windows_system_curl_path",
            return_value=os.path.abspath(r"C:\Windows\System32\curl.exe"),
        ), mock.patch.object(
            u,
            "fetch_ahas_risk_with_windows_trust",
            side_effect=windows_success,
        ), mock.patch.object(
            u,
            "fetch_ahas_risk_with_emergency_pin",
        ) as emergency:
            direct = u.fetch_ahas_bwc(NOW)

        payload = self.build_payload(direct)
        self.assertEqual(payload["bwc"], "LOW")
        self.assertEqual(payload["bwcFetchStatus"], "PARSED_DIRECT_XML")
        self.assertEqual(
            payload["bwcLatestAttemptStatus"],
            "PARSED_WINDOWS_SCHANNEL_TLS",
        )
        self.assertEqual(
            payload["bwcTransportSecurity"],
            "WINDOWS_SCHANNEL_CA_VERIFIED_TLS",
        )
        self.assertEqual(payload["bwcRetrievalTransport"], "WINDOWS_CURL_SCHANNEL")
        self.assertFalse(payload["lastKnownGoodUsed"]["ahas"])
        self.assertTrue(payload["bwcLiveValidated"])
        emergency.assert_not_called()


if __name__ == "__main__":
    unittest.main()
