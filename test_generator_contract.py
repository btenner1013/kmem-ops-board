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


if __name__ == "__main__":
    unittest.main(verbosity=2)
