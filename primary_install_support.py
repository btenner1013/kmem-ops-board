#!/usr/bin/env python3
"""Secret-safe validation helpers for the PRIMARY display installer."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from updater_git import CANONICAL_REPOSITORY, GitRepository, GitSafetyError


CREDENTIAL_NAME = "nms_credentials_local.bat"
REQUIRED_CREDENTIAL_KEYS = ("NMS_CLIENT_ID", "NMS_CLIENT_SECRET")
OPTIONAL_CREDENTIAL_KEYS = ("NMS_ALLOW_INSECURE_SSL_FALLBACK",)
PLACEHOLDER_RE = re.compile(
    r"(<|>|placeholder|change.?me|your[_ -]|example|replace[_ -]|"
    r"client[_ -]?id$|client[_ -]?secret$)",
    re.IGNORECASE,
)
QUOTED_SET_RE = re.compile(
    r'^set\s+"(NMS_CLIENT_ID|NMS_CLIENT_SECRET|NMS_ALLOW_INSECURE_SSL_FALLBACK)=([^"\r\n]+)"$',
    re.IGNORECASE,
)
PLAIN_SET_RE = re.compile(
    r"^set\s+(NMS_CLIENT_ID|NMS_CLIENT_SECRET|NMS_ALLOW_INSECURE_SSL_FALLBACK)=([^\r\n]+)$",
    re.IGNORECASE,
)
SAFE_REM_RE = re.compile(r"^rem(?: [A-Za-z0-9 .,/:;_'~-]*)?$", re.IGNORECASE)
SAFE_CREDENTIAL_VALUE_RE = re.compile(r"^[A-Za-z0-9._~-]+$")
ALLOWED_PACKAGED_GIT_CONFIG_RE = re.compile(
    r"^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase)|"
    r"remote\.origin\.(?:url|fetch)|branch\.main\.(?:remote|merge)|user\.(?:name|email))$",
    re.IGNORECASE,
)
GITHUB_TOKEN_RE = re.compile(
    rb"(?i)(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|authorization\s*=)"
)


class InstallValidationError(RuntimeError):
    """A safe, user-facing installer validation failure."""


def parse_credential_file(path: Path) -> dict[str, str]:
    candidate = Path(path)
    if candidate.is_symlink():
        raise InstallValidationError("The exact local NMS credential file is missing or unsafe.")
    path = candidate.resolve()
    if path.name != CREDENTIAL_NAME or not path.is_file():
        raise InstallValidationError("The exact local NMS credential file is missing or unsafe.")

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or re.fullmatch(r"@?echo\s+off", line, re.IGNORECASE):
            continue
        if SAFE_REM_RE.fullmatch(line):
            continue
        match = QUOTED_SET_RE.fullmatch(line) or PLAIN_SET_RE.fullmatch(line)
        if not match:
            raise InstallValidationError("The NMS credential file contains an unexpected command.")
        if raw_line != line:
            raise InstallValidationError("The NMS credential file contains ambiguous whitespace.")
        key = match.group(1).upper()
        value = match.group(2)
        if key in values:
            raise InstallValidationError("The NMS credential file contains a duplicate definition.")
        if not SAFE_CREDENTIAL_VALUE_RE.fullmatch(value):
            raise InstallValidationError("The NMS credential file contains an unsafe value.")
        if PLACEHOLDER_RE.search(value):
            raise InstallValidationError("The NMS credential file contains a blank or placeholder value.")
        values[key] = value

    missing = [key for key in REQUIRED_CREDENTIAL_KEYS if not values.get(key)]
    if missing:
        raise InstallValidationError("The NMS credential file is missing a required definition.")
    return values


def run_git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"},
    )


def iter_reachable_git_objects(repo: Path):
    listed = run_git(repo, "rev-list", "--objects", "--all")
    if listed.returncode != 0:
        raise InstallValidationError("Unable to inspect reachable Git history for secrets.")
    object_ids = list(
        dict.fromkeys(
            line.split(None, 1)[0]
            for line in listed.stdout.splitlines()
            if line.strip()
        )
    )
    process = subprocess.Popen(
        ["git", "-C", str(repo), "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"},
    )
    if process.stdin is None or process.stdout is None:
        process.kill()
        raise InstallValidationError("Unable to inspect reachable Git history for secrets.")
    try:
        for object_id in object_ids:
            process.stdin.write(object_id.encode("ascii") + b"\n")
            process.stdin.flush()
            header = process.stdout.readline()
            parts = header.rstrip(b"\n").split()
            if len(parts) != 3 or parts[1] == b"missing":
                raise InstallValidationError("Unable to inspect reachable Git history for secrets.")
            try:
                size = int(parts[2])
            except ValueError:
                raise InstallValidationError("Unable to inspect reachable Git history for secrets.") from None
            payload = process.stdout.read(size)
            terminator = process.stdout.read(1)
            if len(payload) != size or terminator != b"\n":
                raise InstallValidationError("Unable to inspect reachable Git history for secrets.")
            yield payload
        process.stdin.close()
        if process.wait(timeout=30) != 0:
            raise InstallValidationError("Unable to inspect reachable Git history for secrets.")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def ensure_credentials_absent_from_git(repo: Path, values: dict[str, str]) -> None:
    secret_values = tuple(values[key].encode("utf-8") for key in REQUIRED_CREDENTIAL_KEYS)
    tracked = run_git(repo, "ls-files", "-z")
    if tracked.returncode != 0:
        raise InstallValidationError("Unable to inspect tracked files for local credentials.")
    for relative_name in tracked.stdout.split("\0"):
        if not relative_name:
            continue
        relative = Path(relative_name)
        if relative.is_absolute() or ".." in relative.parts:
            raise InstallValidationError("Git reported an unsafe tracked path.")
        target = repo / relative
        if target.is_symlink():
            payload = os.readlink(target).encode("utf-8", errors="surrogateescape")
        else:
            payload = target.read_bytes()
        if any(secret in payload for secret in secret_values):
            raise InstallValidationError("An actual NMS credential value appears in a tracked file.")

    for payload in iter_reachable_git_objects(repo):
        if any(secret in payload for secret in secret_values):
            raise InstallValidationError("An actual NMS credential value appears in reachable Git history.")


def ensure_no_packaged_git_credentials(repo: Path) -> None:
    remotes = run_git(repo, "remote")
    if remotes.returncode != 0 or set(remotes.stdout.split()) != {"origin"}:
        raise InstallValidationError("The checkout must contain only the canonical origin remote.")
    configured = run_git(repo, "config", "--local", "--name-only", "--get-regexp", ".*")
    if configured.returncode not in (0, 1):
        raise InstallValidationError("Unable to inspect local Git configuration.")
    if any(
        not ALLOWED_PACKAGED_GIT_CONFIG_RE.fullmatch(line.strip())
        for line in configured.stdout.splitlines()
        if line.strip()
    ):
        raise InstallValidationError("The checkout contains unexpected machine-specific Git configuration.")

    git_dir_result = run_git(repo, "rev-parse", "--absolute-git-dir")
    if git_dir_result.returncode != 0 or not git_dir_result.stdout.strip():
        raise InstallValidationError("Unable to inspect local Git metadata.")
    config_path = Path(git_dir_result.stdout.strip()) / "config"
    if GITHUB_TOKEN_RE.search(config_path.read_bytes()):
        raise InstallValidationError("The checkout contains embedded GitHub authentication material.")


def validate_local_package(repo: Path) -> None:
    repo = repo.resolve()
    credential_path = repo / CREDENTIAL_NAME
    values = parse_credential_file(credential_path)

    git_repo = GitRepository(repo, expected_remote=CANONICAL_REPOSITORY)
    git_repo.validate()
    git_repo.require_clean()

    ignored = run_git(repo, "check-ignore", "--quiet", "--", CREDENTIAL_NAME)
    if ignored.returncode != 0:
        raise InstallValidationError("The local NMS credential file is not Git-ignored.")
    tracked = run_git(repo, "ls-files", "--error-unmatch", "--", CREDENTIAL_NAME)
    if tracked.returncode == 0:
        raise InstallValidationError("The local NMS credential file is tracked by Git.")
    if tracked.returncode not in (1,):
        raise InstallValidationError("Unable to prove that the local NMS credential file is untracked.")
    ensure_credentials_absent_from_git(repo, values)
    ensure_no_packaged_git_credentials(repo)


def safe_sync(repo: Path) -> None:
    validate_local_package(repo)
    outcome = GitRepository(repo, expected_remote=CANONICAL_REPOSITORY).sync()
    print(f"SYNC STATUS: {outcome.status}")
    print(f"SYNC ADVANCED: {'YES' if outcome.advanced else 'NO'}")


def validate_nms(repo: Path) -> None:
    values = parse_credential_file(repo.resolve() / CREDENTIAL_NAME)
    for key in REQUIRED_CREDENTIAL_KEYS + OPTIONAL_CREDENTIAL_KEYS:
        if key in values:
            os.environ[key] = values[key]

    try:
        import nms_kmem_mil_notams_test as nms

        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            token = nms.get_token(values["NMS_CLIENT_ID"], values["NMS_CLIENT_SECRET"])
            time.sleep(nms.REQUEST_DELAY_SECONDS)
            checklist_response = nms.nms_get_json(
                "/notams/checklist",
                token,
                query={"location": nms.LOCATION},
            )
        rows = checklist_response.get("data", {}).get("checklist")
        if not isinstance(rows, list) or not rows:
            raise InstallValidationError("The NMS checklist response was unavailable.")
        candidates = [row for row in rows if isinstance(row, dict) and row.get("number")]
        if not candidates:
            raise InstallValidationError("The NMS checklist contained no retrievable record.")

        detail_ok = False
        for candidate in candidates[:3]:
            time.sleep(nms.REQUEST_DELAY_SECONDS)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                detail_response = nms.nms_get_json(
                    "/notams",
                    token,
                    query={"location": nms.LOCATION, "notamNumber": candidate["number"]},
                    response_format="AIXM",
                )
            aixm = detail_response.get("data", {}).get("aixm")
            if isinstance(aixm, list) and aixm:
                detail_ok = True
                break
        if not detail_ok:
            raise InstallValidationError("The NMS NOTAM detail response was unavailable.")
    except InstallValidationError:
        raise
    except Exception as error:
        raise InstallValidationError(
            f"NMS authentication or NOTAM retrieval failed ({type(error).__name__})."
        ) from None

    print("NMS CREDENTIALS: VALID")
    print("NMS NOTAM RETRIEVAL: VALID")


def parse_utc(value: object) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise InstallValidationError("PRIMARY host status contains a missing timestamp.")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise InstallValidationError("PRIMARY host status contains a malformed timestamp.") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def verify_primary_status(repo: Path, since: datetime) -> None:
    repo = repo.resolve()
    try:
        status = json.loads((repo / "host_status.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise InstallValidationError("PRIMARY host status is missing or malformed.") from None
    if not isinstance(status, dict) or status.get("schemaVersion") != 1:
        raise InstallValidationError("PRIMARY host status schema is invalid.")
    expected = {
        "activeRole": "PRIMARY",
        "codeSyncStatus": "CURRENT",
        "updateStatus": "OK",
        "githubStatus": "OK",
    }
    for key, value in expected.items():
        if str(status.get(key) or "").upper() != value:
            raise InstallValidationError(f"PRIMARY host status did not report {key}={value}.")

    now = datetime.now(timezone.utc)
    tolerance = timedelta(minutes=1)
    for key in (
        "runStartedUtc",
        "heartbeatUtc",
        "runCompletedUtc",
        "lastSuccessfulUpdateUtc",
        "lastSuccessfulPushUtc",
    ):
        stamp = parse_utc(status.get(key))
        if stamp < since - tolerance or stamp > now + tolerance:
            raise InstallValidationError("PRIMARY host status was not produced by this install run.")
        if now - stamp > timedelta(minutes=15):
            raise InstallValidationError("PRIMARY host status is outside the healthy heartbeat window.")

    code_sha = str(status.get("runningSha") or "")
    head_sha = run_git(repo, "rev-parse", "HEAD").stdout.strip()
    if not code_sha or not head_sha:
        raise InstallValidationError("PRIMARY host status is missing Git revision diagnostics.")
    ancestry = run_git(repo, "merge-base", "--is-ancestor", code_sha, head_sha)
    if ancestry.returncode != 0:
        raise InstallValidationError("PRIMARY running code SHA is not in the installed history.")
    GitRepository(repo, expected_remote=CANONICAL_REPOSITORY).require_clean()
    print("PRIMARY HOST STATUS: VALID")


def main() -> int:
    parser = argparse.ArgumentParser(description="KMEM PRIMARY installer support")
    parser.add_argument("command", choices=("validate-package", "sync", "validate-nms", "verify-status"))
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--since", help="UTC ISO timestamp for verify-status")
    args = parser.parse_args()
    try:
        if args.command == "validate-package":
            validate_local_package(args.repo)
            print("LOCAL PACKAGE: VALID")
        elif args.command == "sync":
            safe_sync(args.repo)
        elif args.command == "validate-nms":
            validate_nms(args.repo)
        else:
            if not args.since:
                raise InstallValidationError("verify-status requires --since.")
            verify_primary_status(args.repo, parse_utc(args.since))
    except (InstallValidationError, GitSafetyError, OSError) as error:
        print(f"INSTALL CHECK FAILED: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
