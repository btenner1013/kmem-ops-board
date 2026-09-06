#!/usr/bin/env python3
"""Focused contracts for generator publication and scheduled runtimes."""

import ast
import io
import inspect
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError

import update_weather_local as updater
import kmem_updater
import nms_kmem_mil_notams_test as nms


REPO_DIR = Path(__file__).resolve().parent


def _http_error(code, body=b"temporary failure"):
    return HTTPError(
        "https://nms.example.test/resource",
        code,
        "test error",
        {},
        io.BytesIO(body),
    )


def _http_response(body=b"ok"):
    response = mock.MagicMock()
    response.__enter__.return_value = response
    response.__exit__.return_value = False
    response.read.return_value = body
    return response


class WeatherGeneratorContractTests(unittest.TestCase):
    def test_bwc_history_failure_is_isolated_from_operational_weather(self):
        candidate = {
            "bwcFetchStatus": "PARSED_DIRECT_XML",
            "bwcAhasRisk": "LOW",
            "bwcUpdatedZ": "2026-08-30 03:12:00.000",
            "bwcBasedOn": "NEXRAD",
            "bwcSource": "AHAS",
        }

        def failing_maintainer(*_args, **_kwargs):
            raise OSError("archive unavailable")

        with mock.patch("builtins.print") as output:
            result = updater.maintain_bwc_history_safely(
                candidate,
                updater.datetime(2026, 8, 30, 3, 15, tzinfo=updater.timezone.utc),
                failing_maintainer,
            )

        self.assertIsNone(result)
        self.assertTrue(
            any(
                "BWC history maintenance failed safely" in str(call)
                for call in output.call_args_list
            )
        )

    def test_weather_build_maintains_bwc_history_from_direct_pre_fallback_candidate(self):
        source = inspect.getsource(updater.build_weather_json)
        self.assertIn("ahas_direct_candidate = fetch_ahas_bwc(now_z)", source)
        self.assertIn("ahas_data = ahas_direct_candidate", source)
        self.assertIn(
            "maintain_bwc_history_safely(ahas_direct_candidate, now_z)",
            source,
        )
        self.assertLess(
            source.index("write_weather_json(weather_path, data)"),
            source.index("maintain_bwc_history_safely(ahas_direct_candidate, now_z)"),
        )

    def test_runway_resolution_uses_a_fresh_post_notam_fetch_decision_clock(self):
        source = inspect.getsource(updater.build_weather_json)
        fetch = "mil_notam_data = fetch_mil_notams(previous_data)"
        decision_clock = "notam_decision_now_z = datetime.now(timezone.utc)"
        resolution = (
            "closed_runways = resolve_closed_runways(\n"
            "        atis_ops,\n"
            "        mil_notam_data,\n"
            "        notam_decision_now_z,\n"
            "    )"
        )

        self.assertIn(fetch, source)
        self.assertIn(decision_clock, source)
        self.assertIn(resolution, source)
        self.assertLess(source.index(fetch), source.index(decision_clock))
        self.assertLess(source.index(decision_clock), source.index(resolution))

    def test_weather_write_failure_is_fatal_and_stops_optional_generation(self):
        with (
            mock.patch.object(
                updater,
                "build_weather_json",
                side_effect=RuntimeError("weather write failed"),
            ),
            mock.patch.object(updater, "maintain_taf_current_safely") as maintain_taf,
            mock.patch.object(updater, "download_radar_gif") as download_radar,
        ):
            with self.assertRaisesRegex(RuntimeError, "weather write failed"):
                updater.generate_once()

        maintain_taf.assert_not_called()
        download_radar.assert_not_called()

    def test_generate_only_entrypoint_returns_nonzero_on_primary_failure(self):
        with (
            mock.patch.object(updater.sys, "argv", ["update_weather_local.py", "--generate-only"]),
            mock.patch.object(
                updater,
                "generate_once",
                side_effect=RuntimeError("weather write failed"),
            ),
            mock.patch("builtins.print"),
        ):
            with self.assertRaises(SystemExit) as caught:
                updater.main()

        self.assertEqual(caught.exception.code, 1)

    def test_weather_writer_surfaces_the_underlying_write_error(self):
        with mock.patch("builtins.open", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "Failed to write weather.json") as caught:
                updater.write_weather_json("weather.json", {"ok": True})

        self.assertIsInstance(caught.exception.__cause__, OSError)

    def test_weather_writer_emits_valid_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "weather.json"
            updater.write_weather_json(path, {"ok": True})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"ok": True})

    def test_public_weather_payload_has_no_machine_local_cache_paths(self):
        tree = ast.parse(inspect.getsource(updater.build_weather_json))
        strings = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        self.assertNotIn("lastKnownGoodCachePath", strings)
        self.assertNotIn("trendHistoryPath", strings)

    def test_tracked_weather_payload_has_no_machine_local_identity_or_paths(self):
        payload = json.loads((REPO_DIR / "weather.json").read_text(encoding="utf-8"))
        serialized = json.dumps(payload).casefold()

        self.assertNotIn("lastKnownGoodCachePath", payload)
        self.assertNotIn("trendHistoryPath", payload)
        self.assertNotIn("c:\\\\users\\\\", serialized)
        self.assertNotIn("\\\\appdata\\\\", serialized)
        self.assertEqual(
            payload["workflowMetadata"]["lastWorkflowActor"],
            "KMEM_PRIMARY_UPDATER",
        )

    @unittest.skipUnless(os.name == "nt", "Windows no-window NMS child contract")
    def test_nested_nms_process_is_hidden_and_decoded_deterministically(self):
        completed = subprocess.CompletedProcess(["nms"], 1, "diagnostic", "warning")
        with (
            mock.patch.dict(
                os.environ,
                {"NMS_CLIENT_ID": "test-id", "NMS_CLIENT_SECRET": "test-secret"},
                clear=False,
            ),
            mock.patch.object(updater.os.path, "exists", return_value=True),
            mock.patch.object(updater.subprocess, "run", return_value=completed) as run,
            mock.patch("builtins.print"),
        ):
            updater.fetch_mil_notams({})

        kwargs = run.call_args.kwargs
        self.assertEqual(
            kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW,
            subprocess.CREATE_NO_WINDOW,
        )
        self.assertEqual(kwargs["encoding"], "utf-8")
        self.assertEqual(kwargs["errors"], "backslashreplace")

    def test_nested_nms_process_uses_full_scan_budget_and_unbuffered_output(self):
        completed = subprocess.CompletedProcess(["nms"], 1, "diagnostic", "warning")
        with (
            mock.patch.dict(
                os.environ,
                {"NMS_CLIENT_ID": "test-id", "NMS_CLIENT_SECRET": "test-secret"},
                clear=False,
            ),
            mock.patch.object(updater.os.path, "exists", return_value=True),
            mock.patch.object(updater.subprocess, "run", return_value=completed) as run,
            mock.patch("builtins.print"),
        ):
            updater.fetch_mil_notams({})

        command = run.call_args.args[0]
        self.assertEqual(command[:2], [updater.sys.executable, "-u"])
        self.assertEqual(command[2], updater.NMS_MIL_NOTAMS_SCRIPT_PATH)
        self.assertEqual(updater.NMS_MIL_NOTAMS_TIMEOUT_SECONDS, 5 * 60)
        self.assertEqual(run.call_args.kwargs["timeout"], 5 * 60)
        self.assertLess(
            updater.NMS_MIL_NOTAMS_TIMEOUT_SECONDS,
            kmem_updater.GENERATOR_TIMEOUT_SECONDS,
        )

    def test_nms_timeout_logs_bounded_partial_diagnostics_and_keeps_cache_untrusted(self):
        diagnostic_limit = updater.NMS_MIL_NOTAMS_TIMEOUT_LOG_TAIL_CHARS
        expired = subprocess.TimeoutExpired(
            cmd=[updater.sys.executable, "-u", updater.NMS_MIL_NOTAMS_SCRIPT_PATH],
            timeout=updater.NMS_MIL_NOTAMS_TIMEOUT_SECONDS,
            output=(
                b"DROP-OLD-STDOUT\n"
                + (b"x" * (diagnostic_limit + 100))
                + b"\nPulling 09/047... test-secret invalid=\xff\n"
            ),
            stderr=(
                b"DROP-OLD-STDERR\n"
                + (b"y" * (diagnostic_limit + 100))
                + b"\nHTTP 503 retry exhausted invalid=\xfe\n"
            ),
        )
        previous = {
            "milNotamCount": 1,
            "milNotamStatus": "1 ACTIVE",
            "milNotamScrollText": "09/047 RWY 18C/36C CLSD",
            "milNotams": [],
            "milNotamSource": "FAA_NMS_STAGING",
            "milNotamUpdatedZ": "2026-09-06 17:38:38Z",
            "milNotamRawStatus": "Success",
            "runwayClosureNotams": [
                {
                    "number": "09/047",
                    "text": "RWY 18C/36C CLSD",
                    "effectiveStart": "202609061700",
                    "effectiveEnd": "202609062300",
                }
            ],
        }

        with (
            mock.patch.dict(
                os.environ,
                {"NMS_CLIENT_ID": "test-id", "NMS_CLIENT_SECRET": "test-secret"},
                clear=False,
            ),
            mock.patch.object(updater.os.path, "exists", return_value=True),
            mock.patch.object(updater.subprocess, "run", side_effect=expired),
            mock.patch("builtins.print") as output,
        ):
            result = updater.fetch_mil_notams(previous)

        printed = "\n".join(
            " ".join(str(argument) for argument in call.args)
            for call in output.call_args_list
        )
        self.assertIn("Pulling 09/047... [REDACTED] invalid=\\xff", printed)
        self.assertIn("HTTP 503 retry exhausted invalid=\\xfe", printed)
        self.assertIn("[REDACTED]", printed)
        self.assertNotIn("test-secret", printed)
        self.assertNotIn("DROP-OLD-STDOUT", printed)
        self.assertNotIn("DROP-OLD-STDERR", printed)
        self.assertLessEqual(
            len(printed),
            (diagnostic_limit * 2) + 1000,
            "timeout diagnostics must stay bounded",
        )

        self.assertEqual(result["milNotamFetchStatus"], "TIMEOUT")
        self.assertEqual(result["milNotamRawStatus"], "Success")
        self.assertEqual(result["milNotamUpdatedZ"], "2026-09-06 17:38:38Z")
        self.assertEqual(result["runwayClosureNotamCount"], 1)
        self.assertEqual(result["runwayClosureNotams"][0]["number"], "09/047")

        decision_time = updater.datetime(
            2026,
            9,
            6,
            20,
            0,
            tzinfo=updater.timezone.utc,
        )
        self.assertEqual(
            updater.classify_notam_feed(result, decision_time)["status"],
            "ERROR",
        )
        self.assertEqual(
            updater.resolve_closed_runways(
                {"sourceIsCurrent": False},
                result,
                decision_time,
            ),
            "UNKNOWN",
        )

    def test_nms_timeout_without_captured_streams_falls_back_without_crashing(self):
        expired = subprocess.TimeoutExpired(
            cmd=[updater.sys.executable, "-u", updater.NMS_MIL_NOTAMS_SCRIPT_PATH],
            timeout=updater.NMS_MIL_NOTAMS_TIMEOUT_SECONDS,
        )
        previous = {
            "milNotamCount": 0,
            "milNotamStatus": "NONE ACTIVE",
            "milNotams": [],
            "milNotamUpdatedZ": "2026-09-06 17:38:38Z",
            "milNotamRawStatus": "Success",
        }

        with (
            mock.patch.dict(
                os.environ,
                {"NMS_CLIENT_ID": "test-id", "NMS_CLIENT_SECRET": "test-secret"},
                clear=False,
            ),
            mock.patch.object(updater.os.path, "exists", return_value=True),
            mock.patch.object(updater.subprocess, "run", side_effect=expired),
            mock.patch("builtins.print") as output,
        ):
            result = updater.fetch_mil_notams(previous)

        self.assertEqual(result["milNotamFetchStatus"], "TIMEOUT")
        printed = "\n".join(str(call) for call in output.call_args_list)
        self.assertIn("NMS script timed out", printed)

    def test_failed_nms_process_logs_only_bounded_redacted_output(self):
        diagnostic_limit = updater.NMS_MIL_NOTAMS_TIMEOUT_LOG_TAIL_CHARS
        completed = subprocess.CompletedProcess(
            ["nms"],
            1,
            "DROP-OLD\n" + ("x" * (diagnostic_limit + 100)) + "\ntest-secret",
            "HTTP 503 from test-id",
        )
        with (
            mock.patch.dict(
                os.environ,
                {"NMS_CLIENT_ID": "test-id", "NMS_CLIENT_SECRET": "test-secret"},
                clear=False,
            ),
            mock.patch.object(updater.os.path, "exists", return_value=True),
            mock.patch.object(updater.subprocess, "run", return_value=completed),
            mock.patch("builtins.print") as output,
        ):
            result = updater.fetch_mil_notams({})

        printed = "\n".join(
            " ".join(str(argument) for argument in call.args)
            for call in output.call_args_list
        )
        self.assertEqual(result["milNotamFetchStatus"], "SCRIPT_FAILED")
        self.assertNotIn("DROP-OLD", printed)
        self.assertNotIn("test-secret", printed)
        self.assertNotIn("test-id", printed)
        self.assertGreaterEqual(printed.count("[REDACTED]"), 2)
        self.assertLessEqual(
            len(printed),
            (diagnostic_limit * 2) + 1000,
            "completed-process diagnostics must stay bounded",
        )

    def test_successful_complete_nms_output_remains_authoritative(self):
        completed = subprocess.CompletedProcess(["nms"], 0, "complete", "")
        raw = {
            "source": "FAA_NMS_STAGING",
            "status": "Success",
            "generatedZ": "2026-09-06 20:00:00Z",
            "milNotams": [],
            "runwayClosureNotams": [
                {
                    "number": "09/047",
                    "text": "RWY 18C/36C CLSD",
                    "effectiveStart": "202609061700",
                    "effectiveEnd": "202609062300",
                }
            ],
        }
        with (
            mock.patch.dict(
                os.environ,
                {"NMS_CLIENT_ID": "test-id", "NMS_CLIENT_SECRET": "test-secret"},
                clear=False,
            ),
            mock.patch.object(updater.os.path, "exists", return_value=True),
            mock.patch.object(updater.subprocess, "run", return_value=completed),
            mock.patch.object(updater, "load_json_file", return_value=raw),
            mock.patch("builtins.print"),
        ):
            result = updater.fetch_mil_notams({})

        self.assertEqual(result["milNotamFetchStatus"], "OK")
        self.assertEqual(result["milNotamRawStatus"], "Success")
        self.assertEqual(result["milNotamUpdatedZ"], "2026-09-06 20:00:00Z")
        self.assertEqual(result["runwayClosureNotamCount"], 1)

    def test_nms_full_candidate_scan_contract_is_preserved(self):
        source = inspect.getsource(nms.main)
        self.assertIn("MAX_RECENT_LOCAL_DETAIL_SCAN = 50", source)
        self.assertIn("mil_candidates + explicit_ficon_candidates", source)
        self.assertIn("+ explicit_runway_closure_candidates + recent_local_candidates", source)
        self.assertIn("for item in sorted(candidates", source)


class NmsHttpRetryTests(unittest.TestCase):
    def test_transient_http_statuses_retry_then_succeed_with_bounded_backoff(self):
        for status in (408, 425, 429, 500, 502, 503, 504):
            with self.subTest(status=status):
                with (
                    mock.patch.object(nms, "ALLOW_INSECURE_SSL_FALLBACK", False),
                    mock.patch.object(
                        nms,
                        "urlopen",
                        side_effect=[_http_error(status), _http_response(b"recovered")],
                    ) as urlopen,
                    mock.patch.object(nms.time, "sleep") as sleep,
                    mock.patch("builtins.print"),
                ):
                    result = nms.http_request(
                        "GET",
                        "https://nms.example.test/resource",
                        timeout=7,
                    )

                self.assertEqual(result, b"recovered")
                self.assertEqual(urlopen.call_count, 2)
                sleep.assert_called_once_with(nms.REQUEST_DELAY_SECONDS + 1.0)
                self.assertTrue(
                    all(call.kwargs["timeout"] == 7 for call in urlopen.call_args_list)
                )

    def test_transient_http_retries_stop_at_max_attempts(self):
        failures = [_http_error(503) for _ in range(nms.MAX_RETRIES)]
        with (
            mock.patch.object(nms, "ALLOW_INSECURE_SSL_FALLBACK", False),
            mock.patch.object(nms, "urlopen", side_effect=failures) as urlopen,
            mock.patch.object(nms.time, "sleep") as sleep,
            mock.patch("builtins.print"),
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                nms.http_request("GET", "https://nms.example.test/resource")

        self.assertEqual(urlopen.call_count, nms.MAX_RETRIES)
        self.assertEqual(
            [call.args[0] for call in sleep.call_args_list],
            [
                nms.REQUEST_DELAY_SECONDS * attempt + 1.0
                for attempt in range(1, nms.MAX_RETRIES)
            ],
        )

    def test_url_and_socket_timeouts_retry_with_bounded_attempts(self):
        transient_errors = (
            URLError("temporary DNS failure"),
            TimeoutError("socket timed out"),
        )
        for transient in transient_errors:
            with self.subTest(error=type(transient).__name__):
                with (
                    mock.patch.object(nms, "ALLOW_INSECURE_SSL_FALLBACK", False),
                    mock.patch.object(
                        nms,
                        "urlopen",
                        side_effect=[transient, _http_response(b"recovered")],
                    ) as urlopen,
                    mock.patch.object(nms.time, "sleep") as sleep,
                    mock.patch("builtins.print"),
                ):
                    result = nms.http_request(
                        "GET",
                        "https://nms.example.test/resource",
                    )

                self.assertEqual(result, b"recovered")
                self.assertEqual(urlopen.call_count, 2)
                sleep.assert_called_once_with(nms.REQUEST_DELAY_SECONDS + 1.0)

    def test_network_errors_stop_at_max_attempts(self):
        factories = (
            lambda attempt: URLError(f"temporary network failure {attempt}"),
            lambda attempt: TimeoutError(f"socket timeout {attempt}"),
        )
        for factory in factories:
            failures = [factory(attempt) for attempt in range(nms.MAX_RETRIES)]
            with self.subTest(error=type(failures[0]).__name__):
                with (
                    mock.patch.object(nms, "ALLOW_INSECURE_SSL_FALLBACK", False),
                    mock.patch.object(nms, "urlopen", side_effect=failures) as urlopen,
                    mock.patch.object(nms.time, "sleep") as sleep,
                    mock.patch("builtins.print"),
                ):
                    with self.assertRaises((URLError, TimeoutError, RuntimeError)):
                        nms.http_request("GET", "https://nms.example.test/resource")

                self.assertEqual(urlopen.call_count, nms.MAX_RETRIES)
                self.assertEqual(
                    [call.args[0] for call in sleep.call_args_list],
                    [
                        nms.REQUEST_DELAY_SECONDS * attempt + 1.0
                        for attempt in range(1, nms.MAX_RETRIES)
                    ],
                )

    def test_non_transient_client_errors_fail_immediately(self):
        for status in (400, 401, 403, 404):
            with self.subTest(status=status):
                with (
                    mock.patch.object(nms, "ALLOW_INSECURE_SSL_FALLBACK", False),
                    mock.patch.object(nms, "urlopen", side_effect=_http_error(status)) as urlopen,
                    mock.patch.object(nms.time, "sleep") as sleep,
                ):
                    with self.assertRaisesRegex(RuntimeError, f"HTTP {status}"):
                        nms.http_request("GET", "https://nms.example.test/resource")

                self.assertEqual(urlopen.call_count, 1)
                sleep.assert_not_called()


class SchedulerContractTests(unittest.TestCase):
    def test_backend_cadence_remains_exactly_ten_minutes(self):
        self.assertEqual(kmem_updater.DEFAULT_INTERVAL_SECONDS, 600)
        daemon = (REPO_DIR / "run_kmem_daemon.bat").read_text(encoding="utf-8")
        installer = (REPO_DIR / "install_updater_task.ps1").read_text(encoding="utf-8")
        self.assertIn('--daemon --interval 600 --role "%ROLE%"', daemon)
        self.assertIn("-RepetitionInterval (New-TimeSpan -Minutes 10)", installer)

    def test_display_installer_uses_role_specific_runtime_limits(self):
        script = (REPO_DIR / "install_display_tasks.ps1").read_text(encoding="utf-8")
        server = script.split("$serverSettings =", 1)[1].split("$updaterSettings =", 1)[0]
        updater_settings = script.split("$updaterSettings =", 1)[1].split("$displaySettings =", 1)[0]
        display = script.split("$displaySettings =", 1)[1].split("$serverAction =", 1)[0]

        self.assertIn("-ExecutionTimeLimit ([TimeSpan]::Zero)", server)
        self.assertIn("-ExecutionTimeLimit (New-TimeSpan -Minutes 30)", updater_settings)
        self.assertIn("-ExecutionTimeLimit (New-TimeSpan -Minutes 5)", display)
        self.assertIn("-RepetitionInterval (New-TimeSpan -Minutes 10)", script)
        self.assertIn("-Settings $serverSettings", script)
        self.assertIn("-Settings $updaterSettings", script)
        self.assertIn("-Settings $displaySettings", script)

    def test_hosted_only_is_default_and_local_display_requires_explicit_opt_in(self):
        registrar = (REPO_DIR / "install_display_tasks.ps1").read_text(encoding="utf-8")
        installer = (REPO_DIR / "install_primary_display.ps1").read_text(encoding="utf-8")
        wrapper = (REPO_DIR / "INSTALL KMEM DISPLAY - PRIMARY.cmd").read_text(
            encoding="utf-8"
        )

        self.assertIn('$plannedTaskNames = @(\n    "$TaskPrefix - Weather Update"\n)', registrar)
        self.assertIn("$installLocalServer = $EnableLocalDisplay -or $SkipDisplayLaunch", registrar)
        self.assertIn("$installDisplay = $EnableLocalDisplay", registrar)
        self.assertIn('if ($installLocalServer) {\n    $plannedTaskNames += "$TaskPrefix - Local Server"', registrar)
        self.assertIn('if ($installDisplay) {\n    $plannedTaskNames += "$TaskPrefix - Display"', registrar)
        self.assertNotIn('"$TaskPrefix - Display Watchdog"', registrar)
        self.assertIn('$desiredTaskNames = @("$taskPrefix - Weather Update")', installer)
        self.assertIn("if ($EnableLocalDisplay)", installer)
        self.assertIn("-EnableLocalDisplay:$EnableLocalDisplay", installer)
        self.assertIn("Local server/display tasks:", installer)
        self.assertIn('if /I "%~1"=="--local-display"', wrapper)
        self.assertIn("-EnableLocalDisplay", wrapper)

    def test_scheduled_update_uses_hidden_launcher_and_preserves_task_policy(self):
        registrar = (REPO_DIR / "install_display_tasks.ps1").read_text(encoding="utf-8")
        updater_installer = (REPO_DIR / "install_updater_task.ps1").read_text(
            encoding="utf-8"
        )
        hidden_ps = (REPO_DIR / "run_kmem_update_hidden.ps1").read_text(encoding="utf-8")
        hidden_vbs = (REPO_DIR / "run_kmem_update_hidden.vbs").read_text(encoding="utf-8")

        for script in (registrar, updater_installer):
            self.assertIn("run_kmem_update_hidden.vbs", script)
            self.assertIn("wscript.exe", script)
            self.assertIn("//B //NoLogo", script)
            self.assertIn("-RepetitionInterval (New-TimeSpan -Minutes 10)", script)
            self.assertIn("-MultipleInstances IgnoreNew", script)
        self.assertIn('"$hiddenUpdateVbs`" PRIMARY"', registrar)
        self.assertIn("CreateNoWindow = $true", hidden_ps)
        self.assertIn("RedirectStandardOutput = $true", hidden_ps)
        self.assertIn("RedirectStandardError = $true", hidden_ps)
        self.assertIn("scheduled-updater.log", hidden_ps)
        self.assertIn("shell.Run(command, 0, True)", hidden_vbs)
        self.assertIn("WScript.Quit exitCode", hidden_vbs)

    def test_manual_workflow_has_bounded_job_runtime(self):
        workflow = (REPO_DIR / ".github" / "workflows" / "update-weather.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("timeout-minutes: 25", workflow)

    def test_primary_display_installer_has_safe_check_and_full_install_paths(self):
        script = (REPO_DIR / "install_primary_display.ps1").read_text(encoding="utf-8")
        wrapper = (REPO_DIR / "INSTALL KMEM DISPLAY - PRIMARY.cmd").read_text(
            encoding="utf-8"
        )
        support = (REPO_DIR / "primary_install_support.py").read_text(encoding="utf-8")

        self.assertIn('if /I "%~1"=="--check"', wrapper)
        self.assertIn("-CheckOnly", wrapper)
        self.assertIn("goto usage", wrapper)
        for dependency in ("py.exe", "git.exe", "gh.exe"):
            self.assertIn(dependency, script)
        self.assertIn("Microsoft\\Edge", script)
        self.assertIn("if ($EnableLocalDisplay)", script)
        self.assertIn("nms_credentials_local.bat", script)
        self.assertIn("gh.exe auth login", script)
        self.assertIn("gh.exe auth setup-git", script)
        self.assertIn(".permissions.push", script)
        self.assertIn("Get-ScheduledTask", script)
        self.assertIn("Disable-ScheduledTask", script)
        self.assertIn("Stop-ScheduledTask", script)
        self.assertIn("Unregister-ScheduledTask", script)
        self.assertIn("Test-ExactEntrypointToken", script)
        self.assertIn("Get-SemanticEntrypoints", script)
        self.assertIn("Test-PrimaryUpdaterRole", script)
        self.assertIn("Get-TaskInventory", script)
        self.assertIn("$executeName = [IO.Path]::GetFileName($executeText)", script)
        self.assertIn("[IO.File]::Exists($executeText)", script)
        self.assertIn("$isDevicePath -or $isUncPath", script)
        self.assertIn("[IO.DriveType]::Network", script)
        self.assertIn("Treat it as unrecognized", script)
        self.assertIn('"run_kmem_server.ps1"', script)
        self.assertIn('-(?:Command|EncodedCommand)\\b', script)
        self.assertIn("(?i)^\\s*", script)
        self.assertIn("-WindowStyle\\s+Hidden", script)
        self.assertIn("-ExecutionPolicy\\s+Bypass", script)
        self.assertIn("$semanticMatches = @()", script)
        self.assertNotIn("$matches = @()", script)
        self.assertIn("$fact.ActionCount -eq 1", script)
        self.assertIn("$protectedConflicts", script)
        self.assertIn("$ambiguousEntrypointTasks", script)
        self.assertIn("run_kmem_update.bat", script)
        self.assertIn("& $runUpdate PRIMARY --require-owned-cycle", script)
        self.assertIn("PRIMARY HOST STATUS: VALID", support)
        self.assertIn("GitRepository(repo, expected_remote=CANONICAL_REPOSITORY).sync()", support)

        check_exit = script.index("KMEM PRIMARY INSTALL CHECK PASSED")
        disable = script.index("Disable-ScheduledTask")
        install = script.index("& $displayInstaller")
        controlled_update = script.index("& $runUpdate PRIMARY")
        self.assertLess(check_exit, disable)
        self.assertLess(check_exit, install)
        self.assertLess(check_exit, controlled_update)
        self.assertLess(controlled_update, disable)
        self.assertLess(disable, install)
        self.assertIn("Export-ScheduledTask", script)
        self.assertIn("Register-ScheduledTask", script)
        self.assertIn("cannot be safely replaced automatically", script)
        self.assertIn("$pushPermissionExit", script)
        self.assertIn("KMEM Ops Board Maintainer", script)
        self.assertIn("http://127.0.0.1:8765/", script)
        self.assertIn("<title>\\s*KMEM Ops Board", script)

    def test_nested_windows_children_use_no_window_process_flags(self):
        updater_source = (REPO_DIR / "kmem_updater.py").read_text(encoding="utf-8")
        git_source = (REPO_DIR / "updater_git.py").read_text(encoding="utf-8")
        generator_source = (REPO_DIR / "update_weather_local.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('getattr(subprocess, "CREATE_NO_WINDOW", 0)', updater_source)
        self.assertIn('platform_options["creationflags"] = getattr(', git_source)
        self.assertIn('platform_options["creationflags"] = getattr(', generator_source)

    @unittest.skipUnless(os.name == "nt", "PowerShell classifier test is Windows-only")
    def test_primary_task_classifier_regressions(self):
        powershell = (
            Path(os.environ["SystemRoot"])
            / "System32"
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        )
        completed = subprocess.run(
            [
                str(powershell),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(REPO_DIR / "test_primary_task_classifier.ps1"),
            ],
            cwd=REPO_DIR,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertIn("PRIMARY TASK CLASSIFIER TESTS:", completed.stdout)

    @unittest.skipUnless(os.name == "nt", "PowerShell hidden launcher test is Windows-only")
    def test_hidden_updater_launcher_regressions(self):
        powershell = (
            Path(os.environ["SystemRoot"])
            / "System32"
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        )
        completed = subprocess.run(
            [
                str(powershell),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(REPO_DIR / "test_hidden_updater_launcher.ps1"),
            ],
            cwd=REPO_DIR,
            text=True,
            capture_output=True,
            timeout=45,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertIn("HIDDEN UPDATER LAUNCHER TESTS:", completed.stdout)

    @unittest.skipUnless(os.name == "nt", "PowerShell task registration test is Windows-only")
    def test_display_task_registration_regressions(self):
        powershell = (
            Path(os.environ["SystemRoot"])
            / "System32"
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        )
        completed = subprocess.run(
            [
                str(powershell),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(REPO_DIR / "test_display_task_registration.ps1"),
            ],
            cwd=REPO_DIR,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertIn("DISPLAY TASK REGISTRATION TESTS:", completed.stdout)

    def test_ready_package_metadata_is_ignored_and_task_cadence_is_unchanged(self):
        ignore = (REPO_DIR / ".gitignore").read_text(encoding="utf-8")
        installer = (REPO_DIR / "install_display_tasks.ps1").read_text(encoding="utf-8")
        for filename in (
            "/KMEM_PACKAGE_INFO.txt",
            "/START HERE - INSTALL KMEM DISPLAY.txt",
            "/CONTROLLED PACKAGE - DO NOT SHARE.txt",
        ):
            self.assertIn(filename, ignore)
        self.assertIn("[int]$InitialUpdaterDelayMinutes = 1", installer)
        self.assertIn("-RepetitionInterval (New-TimeSpan -Minutes 10)", installer)
        self.assertIn("if (-not $SkipInitialStart)", installer)
        snapshot = (REPO_DIR / "create_backup_snapshot.ps1").read_text(encoding="utf-8")
        self.assertIn('"run_kmem_update_hidden.vbs"', snapshot)
        self.assertIn('"run_kmem_update_hidden.ps1"', snapshot)


if __name__ == "__main__":
    unittest.main(verbosity=2)
