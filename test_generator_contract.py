#!/usr/bin/env python3
"""Focused contracts for generator publication and scheduled runtimes."""

import ast
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import update_weather_local as updater
import kmem_updater


REPO_DIR = Path(__file__).resolve().parent


class WeatherGeneratorContractTests(unittest.TestCase):
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
        for dependency in ("py.exe", "git.exe", "gh.exe", "Microsoft\\Edge"):
            self.assertIn(dependency, script)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
