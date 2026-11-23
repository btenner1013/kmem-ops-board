"""Independent UTC gate tests, including real compare-and-swap against local Git."""
import unittest
from datetime import timedelta
from email.message import Message
from email.utils import format_datetime
from unittest import mock
from urllib.error import URLError

import kmem_updater as updater
import test_kmem_updater as fixtures


def github_clock(*, age="0", omit_date=False, duplicated_date=False, unavailable=False):
    """Fake HTTPS Date endpoint; never makes an external request."""
    def opened(req, *, timeout):
        if unavailable:
            raise URLError("proxy diagnostic that must not be propagated")
        if req.get_method() != "HEAD" or not req.full_url.startswith(updater.HOST_CLOCK_CHECK_URL + "?"):
            raise AssertionError("Clock must use the canonical HTTPS endpoint and a nonce")
        if timeout != updater.HOST_CLOCK_CHECK_TIMEOUT_SECONDS:
            raise AssertionError("Clock requires a bounded network timeout")
        headers = Message()
        if not omit_date:
            headers["Date"] = format_datetime(fixtures.FIXED_NOW, usegmt=True)
        if duplicated_date:
            headers["Date"] = format_datetime(fixtures.FIXED_NOW, usegmt=True)
        if age is not None:
            headers["Age"] = age
        response = mock.MagicMock(status=200, headers=headers)
        response.geturl.return_value = req.full_url
        response.__enter__.return_value = response
        return response

    return mock.patch.object(updater.urllib.request, "build_opener",
                             return_value=mock.Mock(open=opened))


class HostClockVerificationTests(unittest.TestCase):
    def test_accepts_fresh_https_utc_with_or_without_age(self):
        for age in ("0", None):
            with self.subTest(age=age), github_clock(age=age):
                updater.verify_host_clock(lambda: fixtures.FIXED_NOW)

    def test_rejects_both_directions_of_hour_skew(self):
        for hours in (1, -1):
            with self.subTest(hours=hours), github_clock():
                with self.assertRaises(updater.GitSafetyError) as raised:
                    updater.verify_host_clock(lambda: fixtures.FIXED_NOW + timedelta(hours=hours))
                self.assertEqual(raised.exception.code, "HOST_CLOCK_SKEW")

    def test_rejects_missing_cached_ambiguous_or_unreachable_time(self):
        for options in ({"omit_date": True}, {"age": "120"},
                        {"duplicated_date": True}, {"unavailable": True}):
            with self.subTest(options=options), github_clock(**options):
                with self.assertRaises(updater.GitSafetyError) as raised:
                    updater.verify_host_clock(lambda: fixtures.FIXED_NOW)
                self.assertEqual(raised.exception.code, "HOST_CLOCK_UNVERIFIED")
                self.assertNotIn("proxy diagnostic", str(raised.exception))

    def test_rejects_wall_step_during_probe_even_with_healthy_end_time(self):
        wall = iter((fixtures.FIXED_NOW - timedelta(seconds=20), fixtures.FIXED_NOW))
        with github_clock(), self.assertRaises(updater.GitSafetyError) as raised:
            updater.verify_host_clock(lambda: next(wall))
        self.assertEqual(raised.exception.code, "HOST_CLOCK_CHANGED")


class HostClockMutationTests(fixtures.GitFixture):
    def coordinator(self, role="PRIMARY", *, hours=0, forced=False, offset=None):
        repo = updater.GitRepository(self.primary, fetch_attempts=1)
        return updater.UpdaterCoordinator(
            repo, role, self.runtime, force_failover=forced,
            now_fn=lambda: fixtures.FIXED_NOW + timedelta(hours=hours if offset is None else offset[0]),
        )

    def remote_sha(self):
        return fixtures.run_git(self.origin, "rev-parse", "main").stdout.strip()

    def test_bad_clock_blocks_primary_regular_backup_and_forced_backup(self):
        before = self.remote_sha()
        for role, forced, hours, method in (
            ("PRIMARY", False, -1, "run_once"),
            ("BACKUP", False, 1, "run_once"),
            ("BACKUP", True, 1, "acquire_lease"),
        ):
            with self.subTest(role=role, forced=forced), github_clock():
                c = self.coordinator(role, hours=hours, forced=forced)
                with self.assertRaises(updater.GitSafetyError) as raised:
                    getattr(c, method)()
                self.assertEqual(raised.exception.code, "HOST_CLOCK_SKEW")
                self.assertEqual(self.remote_sha(), before)

    def test_unavailable_time_blocks_status_only_publish(self):
        before = self.remote_sha()
        with github_clock(unavailable=True):
            c = self.coordinator()
            with self.assertRaises(updater.GitSafetyError) as raised:
                c.publish_code_sync_blocked(updater.GitSafetyError("DIRTY_WORKTREE", "test"))
            self.assertEqual(raised.exception.code, "HOST_CLOCK_UNVERIFIED")
        self.assertEqual(self.remote_sha(), before)

    def test_healthy_time_yields_weather_and_atomic_release(self):
        with github_clock():
            c = self.coordinator()
            self.assertEqual(c.run_once(), 0)
        status = c.repo.read_json("origin/main", updater.STATUS_FILE)
        lease = c.repo.read_json("origin/main", updater.LEASE_FILE)
        self.assertEqual(status["updateStatus"], "OK")
        self.assertEqual(lease["state"], "RELEASED")
        self.assertEqual(lease["releasedUtc"], status["heartbeatUtc"])

    def test_mid_generation_time_step_or_unavailable_does_not_publish(self):
        for reason in ("HOST_CLOCK_CHANGED", "HOST_CLOCK_UNVERIFIED"):
            with self.subTest(reason=reason):
                # Reset fixture to the remote tip after an expected open lease.
                c = self.coordinator()
                c.repo.sync()
                acquired = updater.active_lease("PRIMARY", self.remote_sha(), fixtures.FIXED_NOW)
                owned = updater.LeaseOwnership(acquired, self.remote_sha(), self.remote_sha(),
                                               c._new_scratch("origin/main"))
                before = self.remote_sha()
                c.clock_anchor = fixtures.FIXED_NOW, updater.time.monotonic()
                original = c._run_generator

                def generator(scratch):
                    result = original(scratch)
                    if reason == "HOST_CLOCK_CHANGED":
                        c.now_fn = lambda: fixtures.FIXED_NOW + timedelta(hours=1)
                    return result

                try:
                    with github_clock(unavailable=(reason == "HOST_CLOCK_UNVERIFIED")), mock.patch.object(
                        c, "_run_generator", side_effect=generator,
                    ), self.assertRaises(updater.GitSafetyError) as raised:
                        c.publish_owned_cycle(owned, fixtures.FIXED_NOW)
                    self.assertEqual(raised.exception.code, reason)
                    self.assertEqual(self.remote_sha(), before)
                finally:
                    owned.scratch.close()


if __name__ == "__main__":
    unittest.main()
