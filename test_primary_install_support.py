#!/usr/bin/env python3
"""Focused contracts for the controlled PRIMARY deployment package."""

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import nms_kmem_mil_notams_test as nms
import primary_install_support as support


VALID_ID = "unit-test-id-12345"
VALID_SECRET = "unit-test-secret-67890"


class CredentialFileTests(unittest.TestCase):
    def write_file(self, root, content, name=support.CREDENTIAL_NAME):
        path = Path(root) / name
        path.write_text(content, encoding="utf-8")
        return path

    def test_valid_batch_file_is_parsed_without_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write_file(
                temporary,
                '@echo off\nset "NMS_CLIENT_ID=%s"\nset "NMS_CLIENT_SECRET=%s"\n'
                % (VALID_ID, VALID_SECRET),
            )
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                values = support.parse_credential_file(path)

        self.assertEqual(values["NMS_CLIENT_ID"], VALID_ID)
        self.assertEqual(values["NMS_CLIENT_SECRET"], VALID_SECRET)
        self.assertEqual(output.getvalue(), "")

    def test_placeholder_duplicate_and_unexpected_commands_are_rejected(self):
        cases = (
            '@echo off\nset "NMS_CLIENT_ID=YOUR_CLIENT_ID"\nset "NMS_CLIENT_SECRET=secret-value"\n',
            '@echo off\nset "NMS_CLIENT_ID=first"\nset "NMS_CLIENT_ID=second"\nset "NMS_CLIENT_SECRET=secret-value"\n',
            '@echo off\nset "NMS_CLIENT_ID=client-value"\nset "NMS_CLIENT_SECRET=secret-value"\ncurl example.invalid\n',
            '@echo off & echo unexpected\nset "NMS_CLIENT_ID=client-value"\nset "NMS_CLIENT_SECRET=secret-value"\n',
            '@echo off\nrem safe-looking & echo unexpected\nset "NMS_CLIENT_ID=client-value"\nset "NMS_CLIENT_SECRET=secret-value"\n',
            '@echo off\nset NMS_CLIENT_ID=client-value&unexpected\nset "NMS_CLIENT_SECRET=secret-value"\n',
            '@echo off\nset "NMS_CLIENT_ID=client-value&unexpected"\nset "NMS_CLIENT_SECRET=secret-value"\n',
        )
        for content in cases:
            with self.subTest(content=content.splitlines()[-1]):
                with tempfile.TemporaryDirectory() as temporary:
                    path = self.write_file(temporary, content)
                    with self.assertRaises(support.InstallValidationError):
                        support.parse_credential_file(path)

    def test_safe_plain_set_form_is_parsed_exactly(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write_file(
                temporary,
                "@echo off\nset NMS_CLIENT_ID=%s\nset NMS_CLIENT_SECRET=%s\n"
                % (VALID_ID, VALID_SECRET),
            )
            values = support.parse_credential_file(path)

        self.assertEqual(values["NMS_CLIENT_ID"], VALID_ID)
        self.assertEqual(values["NMS_CLIENT_SECRET"], VALID_SECRET)

    def test_exact_filename_is_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write_file(
                temporary,
                'set "NMS_CLIENT_ID=client-value"\nset "NMS_CLIENT_SECRET=secret-value"\n',
                name="other.bat",
            )
            with self.assertRaises(support.InstallValidationError):
                support.parse_credential_file(path)

    def test_actual_credential_values_are_rejected_in_tracked_content_without_echo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "tracked.txt").write_text(
                "prefix " + VALID_SECRET + " suffix",
                encoding="utf-8",
            )
            values = {
                "NMS_CLIENT_ID": VALID_ID,
                "NMS_CLIENT_SECRET": VALID_SECRET,
            }
            listed = mock.Mock(returncode=0, stdout="tracked.txt\0")
            with (
                mock.patch.object(support, "run_git", return_value=listed),
                mock.patch.object(support, "iter_reachable_git_objects", return_value=()),
                self.assertRaises(support.InstallValidationError) as caught,
            ):
                support.ensure_credentials_absent_from_git(root, values)

        message = str(caught.exception)
        self.assertNotIn(VALID_ID, message)
        self.assertNotIn(VALID_SECRET, message)

    def test_actual_credential_values_are_rejected_in_reachable_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            values = {
                "NMS_CLIENT_ID": VALID_ID,
                "NMS_CLIENT_SECRET": VALID_SECRET,
            }
            listed = mock.Mock(returncode=0, stdout="")
            with (
                mock.patch.object(support, "run_git", return_value=listed),
                mock.patch.object(
                    support,
                    "iter_reachable_git_objects",
                    return_value=(b"historical " + VALID_ID.encode("utf-8"),),
                ),
                self.assertRaises(support.InstallValidationError) as caught,
            ):
                support.ensure_credentials_absent_from_git(root, values)

        message = str(caught.exception)
        self.assertNotIn(VALID_ID, message)
        self.assertNotIn(VALID_SECRET, message)


class NmsValidationTests(unittest.TestCase):
    def test_live_probe_uses_auth_checklist_and_detail_without_secret_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            credential = Path(temporary) / support.CREDENTIAL_NAME
            credential.write_text(
                '@echo off\nset "NMS_CLIENT_ID=%s"\nset "NMS_CLIENT_SECRET=%s"\n'
                % (VALID_ID, VALID_SECRET),
                encoding="utf-8",
            )
            responses = [
                {"data": {"checklist": [{"number": "TEST/001"}]}},
                {"data": {"aixm": ["safe-test-record"]}},
            ]
            output = io.StringIO()
            with (
                mock.patch.object(nms, "get_token", return_value="unit-test-token") as get_token,
                mock.patch.object(nms, "nms_get_json", side_effect=responses) as get_json,
                mock.patch.object(support.time, "sleep"),
                mock.patch.dict(os.environ, {}, clear=False),
                contextlib.redirect_stdout(output),
            ):
                support.validate_nms(Path(temporary))

        rendered = output.getvalue()
        self.assertIn("NMS CREDENTIALS: VALID", rendered)
        self.assertIn("NMS NOTAM RETRIEVAL: VALID", rendered)
        self.assertNotIn(VALID_ID, rendered)
        self.assertNotIn(VALID_SECRET, rendered)
        self.assertNotIn("unit-test-token", rendered)
        get_token.assert_called_once_with(VALID_ID, VALID_SECRET)
        self.assertEqual(get_json.call_count, 2)

    def test_live_probe_redacts_provider_error_details(self):
        with tempfile.TemporaryDirectory() as temporary:
            credential = Path(temporary) / support.CREDENTIAL_NAME
            credential.write_text(
                '@echo off\nset "NMS_CLIENT_ID=%s"\nset "NMS_CLIENT_SECRET=%s"\n'
                % (VALID_ID, VALID_SECRET),
                encoding="utf-8",
            )
            with mock.patch.object(
                nms,
                "get_token",
                side_effect=RuntimeError("provider response included unit-test-secret-67890"),
            ):
                with self.assertRaisesRegex(
                    support.InstallValidationError,
                    r"failed \(RuntimeError\)",
                ) as caught:
                    support.validate_nms(Path(temporary))

        self.assertNotIn(VALID_SECRET, str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
