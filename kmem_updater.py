#!/usr/bin/env python3
"""Lease-aware PRIMARY/BACKUP coordinator for the KMEM Ops Board updater."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable, Optional

from updater_git import (
    CANONICAL_REPOSITORY,
    GitRepository,
    GitSafetyError,
    LocalLockUnavailable,
    LocalProcessLock,
    ScratchClone,
    cleanup_stale_scratch_clones,
    default_runtime_root,
    read_local_lock_metadata,
)


REPO_DIR = Path(__file__).resolve().parent
ROLES = {"PRIMARY", "BACKUP"}
HOST_HEALTHY_MINUTES = 15
HOST_FAILOVER_MINUTES = 25
LEASE_MINUTES = 20
BACKUP_HANDOFF_MINUTES = 12
BACKUP_HANDOFF_MAX_WAIT_SECONDS = 3 * 60
LEASE_ATTEMPTS = 3
FINAL_PUSH_ATTEMPTS = 2
DEFAULT_INTERVAL_SECONDS = 600
GENERATOR_TIMEOUT_SECONDS = 17 * 60
WORKER_TIMEOUT_SECONDS = 25 * 60
RESTART_AFTER_SYNC_EXIT = 75
REQUIRED_OWNED_CYCLE_SKIPPED_EXIT = 76
STATUS_FILE = "host_status.json"
LEASE_FILE = "updater_lease.json"
GENERATED_FILES = (
    "weather.json",
    "radar.gif",
    "atis_history.json",
    "taf_current.json",
    STATUS_FILE,
    LEASE_FILE,
)
REQUIRED_WEATHER_DIAGNOSTICS = (
    "atisSelectedSource",
    "atisSourcePolicy",
    "atisSourcesChecked",
    "atisLiveCandidateCount",
    "atisLiveCandidates",
)
WEATHER_TIMESTAMP_MAX_AGE_MINUTES = (GENERATOR_TIMEOUT_SECONDS / 60.0) + 2.0
SYNC_BLOCKING_ERRORS = {
    "DIRTY_WORKTREE",
    "LOCAL_AHEAD",
    "DIVERGED_HISTORY",
    "GIT_OPERATION_IN_PROGRESS",
    "FAST_FORWARD_FAILED",
}

LOGGER = logging.getLogger("kmem-updater")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_utc(value) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def display_age_minutes(age_minutes: float) -> int:
    if age_minutes <= 0:
        return 0
    whole = int(age_minutes)
    return whole if age_minutes == whole else whole + 1


def _windows_descendant_pids(root_pid: int) -> list[int]:
    """Snapshot descendant PIDs before terminating a Windows process tree."""
    if os.name != "nt":
        return []

    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = (
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        )

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_snapshot = kernel32.CreateToolhelp32Snapshot
    create_snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    create_snapshot.restype = wintypes.HANDLE
    process_first = kernel32.Process32FirstW
    process_first.argtypes = (wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W))
    process_first.restype = wintypes.BOOL
    process_next = kernel32.Process32NextW
    process_next.argtypes = (wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W))
    process_next.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL

    snapshot = create_snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if snapshot == wintypes.HANDLE(-1).value:
        return []
    parents: dict[int, int] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not process_first(snapshot, ctypes.byref(entry)):
            return []
        while True:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            if not process_next(snapshot, ctypes.byref(entry)):
                break
    finally:
        close_handle(snapshot)

    depths: dict[int, int] = {int(root_pid): 0}
    changed = True
    while changed:
        changed = False
        for pid, parent_pid in parents.items():
            if pid not in depths and parent_pid in depths:
                depths[pid] = depths[parent_pid] + 1
                changed = True
    return sorted(
        (pid for pid in depths if pid != int(root_pid)),
        key=lambda pid: depths[pid],
        reverse=True,
    )


def _windows_terminate_pid(pid: int) -> None:
    """Terminate a Windows PID directly when taskkill is unavailable/restricted."""
    if os.name != "nt":
        return

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    open_process = kernel32.OpenProcess
    open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    open_process.restype = wintypes.HANDLE
    terminate_process = kernel32.TerminateProcess
    terminate_process.argtypes = (wintypes.HANDLE, wintypes.UINT)
    terminate_process.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL

    handle = open_process(0x0001, False, int(pid))  # PROCESS_TERMINATE
    if not handle:
        return
    try:
        terminate_process(handle, 1)
    finally:
        close_handle(handle)


def _terminate_process_tree(process: subprocess.Popen) -> None:
    """Terminate one updater child and its descendants before releasing locks or scratch."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        descendant_pids = set(_windows_descendant_pids(process.pid))
        # Stop the direct child first so it cannot create another descendant
        # while the slower system tree-termination command is starting.
        try:
            process.kill()
        except OSError:
            pass
        descendant_pids.update(_windows_descendant_pids(process.pid))
        for descendant_pid in tuple(descendant_pids):
            _windows_terminate_pid(descendant_pid)
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        # Some restricted Windows job environments report success after killing
        # only the direct child. Re-snapshot to close the timeout/snapshot race,
        # then terminate every observed descendant explicitly as well.
        for _ in range(3):
            descendant_pids.update(_windows_descendant_pids(process.pid))
            for descendant_pid in tuple(descendant_pids):
                _windows_terminate_pid(descendant_pid)
                try:
                    subprocess.run(
                        ["taskkill", "/PID", str(descendant_pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        timeout=5,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass


def run_bounded_process(
    command: list[str],
    *,
    timeout: float,
    cwd: Optional[Path] = None,
    env: Optional[dict[str, str]] = None,
    capture_output: bool = False,
) -> subprocess.CompletedProcess:
    kwargs = {
        "cwd": str(cwd) if cwd is not None else None,
        "env": env,
        "text": True,
        "stdout": subprocess.PIPE if capture_output else None,
        "stderr": subprocess.PIPE if capture_output else None,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            _terminate_process_tree(process)
            stdout, stderr = "", ""
        raise subprocess.TimeoutExpired(
            command,
            timeout,
            output=stdout or getattr(error, "output", None),
            stderr=stderr or getattr(error, "stderr", None),
        ) from error
    except BaseException:
        _terminate_process_tree(process)
        try:
            process.wait(timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def _published_weather_contains_local_identity(value, key: str = "") -> bool:
    if isinstance(value, dict):
        return any(
            _published_weather_contains_local_identity(child, str(child_key))
            for child_key, child in value.items()
        )
    if isinstance(value, list):
        return any(_published_weather_contains_local_identity(child, key) for child in value)
    if not isinstance(value, str):
        return False
    text = value.strip()
    if key.lower().endswith("path") and (
        re.match(r"^[A-Za-z]:[\\/]", text) or text.startswith(("/home/", "/Users/"))
    ):
        return True
    return bool(
        re.search(r"(?i)[A-Za-z]:\\Users\\", text)
        or re.search(r"(?i)(?:^|\s)/(?:home|Users)/[^/\s]+", text)
    )


@dataclass(frozen=True)
class HeartbeatState:
    state: str
    age_minutes: Optional[float]
    role: str
    reason: str = ""

    @property
    def display_age(self) -> Optional[int]:
        if self.age_minutes is None:
            return None
        return display_age_minutes(self.age_minutes)


def classify_host_heartbeat(status: Optional[dict], now: datetime) -> HeartbeatState:
    """Classify a published heartbeat without conflating it with feed freshness."""
    if not isinstance(status, dict):
        return HeartbeatState("UNAVAILABLE", None, "NONE", "MISSING")

    role = str(status.get("activeRole") or "NONE").strip().upper()
    if role not in ROLES:
        role = "NONE"
    if role == "NONE":
        return HeartbeatState("UNAVAILABLE", None, role, "INVALID_ROLE")
    heartbeat = parse_utc(status.get("heartbeatUtc"))
    if heartbeat is None:
        return HeartbeatState("UNAVAILABLE", None, role, "MALFORMED")

    age = (now.astimezone(timezone.utc) - heartbeat).total_seconds() / 60.0
    if age < 0:
        return HeartbeatState("UNAVAILABLE", None, role, "FUTURE")

    sync_status = str(status.get("codeSyncStatus") or "").strip().upper()
    if age <= HOST_FAILOVER_MINUTES and "BLOCKED" in sync_status:
        return HeartbeatState("CODE_SYNC_BLOCKED", age, role, sync_status)
    if age <= HOST_HEALTHY_MINUTES:
        return HeartbeatState("OK", age, role)
    if age <= HOST_FAILOVER_MINUTES:
        return HeartbeatState("DELAYED", age, role)
    return HeartbeatState("NO_HEARTBEAT", age, role)


def classify_lease_state(lease: Optional[dict], now: datetime) -> str:
    if not isinstance(lease, dict):
        return "FREE"
    state = str(lease.get("state") or "").strip().upper()
    if state == "RELEASED":
        return "FREE"
    if not state:
        return "INVALID"
    if state != "ACTIVE":
        return "INVALID"
    expires = parse_utc(lease.get("expiresUtc"))
    if expires is not None and expires <= now.astimezone(timezone.utc):
        return "EXPIRED"
    if str(lease.get("owner") or "").strip().upper() not in ROLES:
        return "INVALID"
    if not str(lease.get("leaseId") or "").strip():
        return "INVALID"
    acquired = parse_utc(lease.get("acquiredUtc"))
    if expires is None or acquired is None or expires <= acquired:
        return "INVALID"
    if expires - acquired > timedelta(minutes=LEASE_MINUTES + 2):
        return "INVALID"
    return "ACTIVE" if expires > now.astimezone(timezone.utc) else "EXPIRED"


def lease_is_active(lease: Optional[dict], now: datetime) -> bool:
    return classify_lease_state(lease, now) == "ACTIVE"


def active_lease(role: str, base_sha: str, now: datetime, lease_id: Optional[str] = None) -> dict:
    acquired = now.astimezone(timezone.utc)
    return {
        "schemaVersion": 1,
        "state": "ACTIVE",
        "owner": role,
        "leaseId": lease_id or uuid.uuid4().hex,
        "acquiredUtc": format_utc(acquired),
        "expiresUtc": format_utc(acquired + timedelta(minutes=LEASE_MINUTES)),
        "baseSha": base_sha,
    }


def released_lease(lease: dict, completed: datetime) -> dict:
    result = dict(lease)
    result["state"] = "RELEASED"
    result["releasedUtc"] = format_utc(completed)
    result["expiresUtc"] = format_utc(completed)
    return result


def configure_logging(runtime_root: Path) -> None:
    if LOGGER.handlers:
        return
    LOGGER.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)sZ %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%S")
    formatter.converter = time.gmtime

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    LOGGER.addHandler(console)

    log_dir = runtime_root.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(
        log_dir / "updater.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    LOGGER.addHandler(file_handler)


def _redact_sensitive_output(value: object, environment: dict[str, str]) -> str:
    text = str(value or "")
    sensitive_values = {
        str(secret)
        for name, secret in environment.items()
        if re.search(r"(?:SECRET|TOKEN|PASSWORD|PASSCODE|CLIENT_ID)", name, re.IGNORECASE)
        and len(str(secret or "")) >= 4
    }
    for secret in sorted(sensitive_values, key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    return text


def _log_generator_output(result: subprocess.CompletedProcess, environment: dict[str, str]) -> None:
    for stream_name, level, value in (
        ("STDOUT", logging.INFO, result.stdout),
        ("STDERR", logging.WARNING, result.stderr),
    ):
        redacted = _redact_sensitive_output(value, environment)
        for line in redacted.splitlines():
            if line.strip():
                LOGGER.log(level, "GENERATOR %s %s", stream_name, line[:4000])


def short_sha(value: str) -> str:
    return (value or "--")[:12]


def atomic_write_json(path: Path, value: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_local_json(path: Path) -> Optional[dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


class BackupObservation:
    """Require a grace period before takeover when no timestamp is trustworthy."""

    def __init__(self, path: Path):
        self.path = path

    def reset(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def unknown_is_eligible(self, now: datetime) -> bool:
        existing = read_local_json(self.path)
        first = parse_utc((existing or {}).get("firstUnhealthyUtc"))
        if first is None or first > now:
            atomic_write_json(
                self.path,
                {"schemaVersion": 1, "firstUnhealthyUtc": format_utc(now)},
            )
            return False
        return (now - first).total_seconds() / 60.0 > HOST_FAILOVER_MINUTES


class InvalidLeaseObservation:
    """Fail closed briefly, then recover one unchanged malformed lease atomically."""

    def __init__(self, path: Path):
        self.path = path

    def reset(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def unchanged_is_recoverable(self, fingerprint: str, now: datetime) -> bool:
        existing = read_local_json(self.path) or {}
        first = parse_utc(existing.get("firstObservedUtc"))
        same_value = str(existing.get("fingerprint") or "") == fingerprint
        if not same_value or first is None or first > now:
            atomic_write_json(
                self.path,
                {
                    "schemaVersion": 1,
                    "fingerprint": fingerprint,
                    "firstObservedUtc": format_utc(now),
                },
            )
            return False
        return (now - first).total_seconds() / 60.0 > LEASE_MINUTES


@dataclass
class LeaseOwnership:
    lease: dict
    lease_sha: str
    code_sha: str
    scratch: ScratchClone


class UpdaterCoordinator:
    def __init__(
        self,
        repo: GitRepository,
        role: str,
        runtime_root: Path,
        *,
        force_failover: bool = False,
        require_owned_cycle: bool = False,
        now_fn: Callable[[], datetime] = utc_now,
        sleep_fn: Callable[[float], None] = time.sleep,
        python_executable: str = sys.executable,
    ):
        self.repo = repo
        self.role = role
        self.runtime_root = runtime_root
        self.force_failover = force_failover
        self.require_owned_cycle = require_owned_cycle
        self.now_fn = now_fn
        self.sleep_fn = sleep_fn
        self.python_executable = python_executable
        self.observation = BackupObservation(runtime_root.parent / "backup-observation.json")
        self.invalid_lease_observation = InvalidLeaseObservation(
            runtime_root.parent / "invalid-lease-observation.json"
        )

    def skipped_cycle_result(self) -> int:
        return REQUIRED_OWNED_CYCLE_SKIPPED_EXIT if self.require_owned_cycle else 0

    def _read_lease_document(self, ref: str) -> tuple[str, Optional[dict], str]:
        result = self.repo.run(["show", f"{ref}:{LEASE_FILE}"], check=False)
        raw = result.stdout if result.returncode == 0 else ""
        if result.returncode != 0:
            kind = "MISSING"
            value = None
            fingerprint_source = kind
        else:
            try:
                parsed = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                parsed = None
            if isinstance(parsed, dict):
                kind = "VALID"
                value = parsed
                fingerprint_source = json.dumps(parsed, sort_keys=True, separators=(",", ":"))
            else:
                kind = "MALFORMED"
                value = None
                fingerprint_source = f"{kind}:{raw}"
        observed_ref_sha = self.repo.sha(ref)
        fingerprint = hashlib.sha256(
            f"{observed_ref_sha}:{fingerprint_source}".encode("utf-8")
        ).hexdigest()
        return kind, value, fingerprint

    def _lease_replacement_allowed(self, ref: str) -> tuple[bool, Optional[dict], str]:
        kind, lease, fingerprint = self._read_lease_document(ref)
        now = self.now_fn()
        if kind == "VALID":
            state = classify_lease_state(lease, now)
            if state in {"FREE", "EXPIRED"}:
                self.invalid_lease_observation.reset()
                return True, lease, state
            if state == "ACTIVE":
                self.invalid_lease_observation.reset()
                return False, lease, state
        else:
            state = kind

        recoverable = self.invalid_lease_observation.unchanged_is_recoverable(
            fingerprint,
            now,
        )
        if recoverable:
            LOGGER.warning(
                "Unchanged untrusted remote lease completed %s-minute quarantine; atomic recovery is eligible.",
                LEASE_MINUTES,
            )
            return True, lease, f"{state}_QUARANTINE_EXPIRED"
        return False, lease, state

    def _backup_should_run(self, status: Optional[dict]) -> bool:
        if self.force_failover:
            LOGGER.warning("FORCE FAILOVER REQUESTED - heartbeat preference bypassed; Git push remains normal.")
            return True

        state = classify_host_heartbeat(status, self.now_fn())
        age = "--" if state.display_age is None else f"{state.display_age}M"
        LOGGER.info("PRIMARY heartbeat state=%s age=%s", state.state, age)

        if state.role == "BACKUP" and state.age_minutes is not None:
            self.observation.reset()
            if state.age_minutes <= BACKUP_HANDOFF_MINUTES:
                LOGGER.info(
                    "Recent BACKUP heartbeat - waiting through %s-minute PRIMARY handoff window.",
                    BACKUP_HANDOFF_MINUTES,
                )
                return False
            LOGGER.info("PRIMARY did not resume during handoff window; BACKUP remains eligible.")
            return True
        if state.role == "PRIMARY" and state.state in {"OK", "CODE_SYNC_BLOCKED"}:
            self.observation.reset()
            LOGGER.info("PRIMARY HEALTHY - BACKUP NOT REQUIRED")
            return False
        if state.role == "PRIMARY" and state.state == "DELAYED":
            self.observation.reset()
            LOGGER.info("PRIMARY DELAYED - BACKUP WAITS")
            return False
        if state.role == "PRIMARY" and state.state == "NO_HEARTBEAT":
            return True

        eligible = self.observation.unknown_is_eligible(self.now_fn())
        if not eligible:
            LOGGER.info("PRIMARY heartbeat unavailable - starting/continuing 25-minute observation grace.")
        return eligible

    def _backup_handoff_wait_seconds(self, status: Optional[dict]) -> Optional[float]:
        if self.force_failover:
            return None
        state = classify_host_heartbeat(status, self.now_fn())
        if state.role != "BACKUP" or state.age_minutes is None:
            return None
        remaining = ((BACKUP_HANDOFF_MINUTES - state.age_minutes) * 60.0) + 1.0
        if 0 < remaining <= BACKUP_HANDOFF_MAX_WAIT_SECONDS:
            return remaining
        return None

    def _new_scratch(self, ref: str) -> ScratchClone:
        scratch = self.repo.make_scratch_clone(ref, self.runtime_root)
        try:
            scratch.run(["config", "user.name", "KMEM Ops Board Updater"])
            scratch.run(["config", "user.email", "kmem-updater@users.noreply.github.com"])
            return scratch
        except Exception:
            scratch.close()
            raise

    def acquire_lease(self) -> Optional[LeaseOwnership]:
        for attempt in range(1, LEASE_ATTEMPTS + 1):
            self.repo.fetch()
            local_sha = self.repo.sha("HEAD")
            origin_sha = self.repo.sha("origin/main")
            if local_sha != origin_sha:
                replacement_allowed, moved_lease, moved_state = self._lease_replacement_allowed(
                    "origin/main"
                )
                if not replacement_allowed:
                    owner = str((moved_lease or {}).get("owner") or "UNKNOWN").upper()
                    LOGGER.info("Remote lease blocks acquisition state=%s owner=%s.", moved_state, owner)
                    return None
                raise GitSafetyError(
                    "RESTART_REQUIRED",
                    "origin/main moved after code sync; restart with the newest code.",
                )

            status = self.repo.read_json("origin/main", STATUS_FILE)
            if self.role == "BACKUP" and not self._backup_should_run(status):
                return None

            replacement_allowed, current_lease, current_lease_state = self._lease_replacement_allowed(
                "origin/main"
            )
            if not replacement_allowed:
                owner = str((current_lease or {}).get("owner") or "UNKNOWN").upper()
                LOGGER.info(
                    "Remote lease blocks acquisition state=%s owner=%s; this cycle exits.",
                    current_lease_state,
                    owner,
                )
                return None

            lease = active_lease(self.role, origin_sha, self.now_fn())
            scratch = self._new_scratch("origin/main")
            accepted = False
            try:
                scratch.write_json(LEASE_FILE, lease)
                changed = scratch.status_paths()
                if changed != {LEASE_FILE}:
                    raise GitSafetyError(
                        "LEASE_SCOPE_VIOLATION",
                        f"Lease candidate changed unexpected paths: {sorted(changed)}",
                    )
                lease_sha = scratch.commit(
                    [LEASE_FILE],
                    f"KMEM updater lease {self.role} {format_utc(self.now_fn())}",
                )
                if not lease_sha:
                    raise GitSafetyError("LEASE_COMMIT_FAILED", "Lease candidate produced no commit.")
                push_ok = scratch.push_main()
                if not push_ok:
                    self.repo.fetch()
                    remote_sha = self.repo.sha("origin/main")
                    remote_lease = self.repo.read_json("origin/main", LEASE_FILE)
                    exact_owner = (
                        isinstance(remote_lease, dict)
                        and classify_lease_state(remote_lease, self.now_fn()) == "ACTIVE"
                        and str(remote_lease.get("owner") or "").upper() == self.role
                        and str(remote_lease.get("leaseId") or "") == str(lease.get("leaseId") or "")
                    )
                    lease_is_ancestor = (
                        remote_sha == lease_sha
                        or self.repo.is_ancestor(lease_sha, remote_sha)
                    )
                    source_unchanged = (
                        remote_sha == lease_sha
                        or self.repo.changed_paths(lease_sha, remote_sha).issubset(set(GENERATED_FILES))
                    )
                    push_ok = exact_owner and lease_is_ancestor and source_unchanged
                if push_ok:
                    accepted = True
                    LOGGER.info(
                        "Remote lease acquired role=%s sha=%s duration=%sM",
                        self.role,
                        short_sha(lease_sha),
                        LEASE_MINUTES,
                    )
                    return LeaseOwnership(lease, lease_sha, origin_sha, scratch)
                LOGGER.info("Lease push lost remote race attempt=%s/%s", attempt, LEASE_ATTEMPTS)
            finally:
                if not accepted:
                    scratch.close()

        raise GitSafetyError("LEASE_RETRY_EXHAUSTED", "Remote lease retries were exhausted.")

    def _run_generator(self, scratch: ScratchClone) -> tuple[bool, str]:
        LOGGER.info("Generation started role=%s", self.role)
        generator_env = os.environ.copy()
        generator_env.pop("KMEM_COORDINATED_WORKER_TOKEN", None)
        generator_env["KMEM_UPDATER_ROLE"] = self.role
        weather_path = scratch.path / "weather.json"
        try:
            previous_weather = weather_path.read_bytes()
        except OSError:
            previous_weather = None
        try:
            result = run_bounded_process(
                [self.python_executable, "update_weather_local.py", "--generate-only"],
                cwd=scratch.path,
                env=generator_env,
                capture_output=True,
                timeout=GENERATOR_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            LOGGER.error("Generation timed out after %s seconds.", GENERATOR_TIMEOUT_SECONDS)
            return False, "WEATHER_GENERATION_TIMEOUT"
        except OSError:
            LOGGER.error("Generation process could not be started.")
            return False, "WEATHER_GENERATOR_LAUNCH_FAILED"
        _log_generator_output(result, generator_env)
        LOGGER.info("Generation completed returnCode=%s", result.returncode)
        if result.returncode != 0:
            return False, "WEATHER_GENERATION_FAILED"

        try:
            current_weather = weather_path.read_bytes()
            parsed_weather = json.loads(current_weather.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return False, "WEATHER_ARTIFACT_INVALID"
        if previous_weather is not None and current_weather == previous_weather:
            return False, "WEATHER_ARTIFACT_UNCHANGED"
        if not isinstance(parsed_weather, dict) or not str(parsed_weather.get("allFeedsUpdatedZ") or "").strip():
            return False, "WEATHER_ARTIFACT_INVALID"
        if any(key not in parsed_weather for key in REQUIRED_WEATHER_DIAGNOSTICS):
            return False, "WEATHER_DIAGNOSTICS_MISSING"
        generated_at = parse_utc(parsed_weather.get("allFeedsUpdatedZ"))
        generated_age = (
            (self.now_fn() - generated_at).total_seconds() / 60.0
            if generated_at is not None
            else None
        )
        if (
            generated_age is None
            or generated_age < -2.0
            or generated_age > WEATHER_TIMESTAMP_MAX_AGE_MINUTES
        ):
            return False, "WEATHER_TIMESTAMP_INVALID"

        selected_source = parsed_weather.get("atisSelectedSource")
        source_policy = parsed_weather.get("atisSourcePolicy")
        sources_checked = parsed_weather.get("atisSourcesChecked")
        candidate_count = parsed_weather.get("atisLiveCandidateCount")
        candidates = parsed_weather.get("atisLiveCandidates")
        diagnostics_valid = (
            isinstance(selected_source, str)
            and bool(selected_source.strip())
            and isinstance(source_policy, str)
            and bool(source_policy.strip())
            and isinstance(sources_checked, list)
            and all(isinstance(source, str) and source.strip() for source in sources_checked)
            and isinstance(candidate_count, int)
            and not isinstance(candidate_count, bool)
            and candidate_count >= 0
            and isinstance(candidates, list)
            and all(isinstance(candidate, dict) for candidate in candidates)
            and candidate_count == len(candidates)
        )
        if not diagnostics_valid:
            return False, "WEATHER_DIAGNOSTICS_INVALID"

        metadata = parsed_weather.get("workflowMetadata")
        if not isinstance(metadata, dict):
            return False, "WEATHER_METADATA_INVALID"
        metadata_timestamp = parse_utc(metadata.get("lastWorkflowTimestampZ"))
        metadata_age = (
            (self.now_fn() - metadata_timestamp).total_seconds() / 60.0
            if metadata_timestamp is not None
            else None
        )
        actor = str(metadata.get("lastWorkflowActor") or "")
        if (
            actor != f"KMEM_{self.role}_UPDATER"
            or metadata_age is None
            or metadata_age < -2.0
            or metadata_age > WEATHER_TIMESTAMP_MAX_AGE_MINUTES
        ):
            return False, "WEATHER_METADATA_INVALID"
        if _published_weather_contains_local_identity(parsed_weather):
            return False, "WEATHER_PII_DETECTED"
        return True, ""

    def _status_payload(
        self,
        *,
        run_started: datetime,
        completed: datetime,
        code_sha: str,
        origin_sha: str,
        publish_base_sha: str,
        generation_ok: bool,
        error_code: str,
        previous_status: Optional[dict] = None,
    ) -> dict:
        timestamp = format_utc(completed)
        previous_success = (previous_status or {}).get("lastSuccessfulUpdateUtc")
        return {
            "schemaVersion": 1,
            "activeRole": self.role,
            "heartbeatUtc": timestamp,
            "lastSuccessfulUpdateUtc": timestamp if generation_ok else previous_success,
            "runStartedUtc": format_utc(run_started),
            "runCompletedUtc": timestamp,
            "internetStatus": "OK",
            "githubStatus": "OK",
            "codeSyncStatus": "CURRENT",
            "runningSha": code_sha,
            "originMainSha": origin_sha,
            "runningCodeSha": code_sha,
            "originTipObservedSha": origin_sha,
            "publishBaseSha": publish_base_sha,
            "shaObservedPhase": "PRE_LEASE_CODE_SYNC",
            "updateStatus": "OK" if generation_ok else "ERROR",
            "lastSuccessfulPushUtc": timestamp,
            "lastError": None if generation_ok else error_code,
        }

    def _remote_move_is_retryable(self, expected_sha: str, lease_id: str) -> tuple[bool, str]:
        self.repo.fetch()
        remote_sha = self.repo.sha("origin/main")
        if remote_sha == expected_sha:
            return True, remote_sha
        if not self.repo.is_ancestor(expected_sha, remote_sha):
            return False, remote_sha
        changed = self.repo.changed_paths(expected_sha, remote_sha)
        if not changed.issubset(set(GENERATED_FILES)):
            LOGGER.error("Remote source changed during updater lease; publication stopped.")
            return False, remote_sha
        remote_lease = self.repo.read_json("origin/main", LEASE_FILE)
        owns_remote = (
            isinstance(remote_lease, dict)
            and str(remote_lease.get("state") or "").upper() == "ACTIVE"
            and str(remote_lease.get("leaseId") or "") == lease_id
            and str(remote_lease.get("owner") or "").upper() == self.role
        )
        return owns_remote, remote_sha

    def publish_code_sync_blocked(self, error: GitSafetyError) -> bool:
        """Publish a truthful status-only heartbeat for a safely diagnosed sync block."""
        if error.code not in SYNC_BLOCKING_ERRORS:
            return False

        for attempt in range(1, FINAL_PUSH_ATTEMPTS + 1):
            self.repo.fetch()
            kind, lease, _fingerprint = self._read_lease_document("origin/main")
            lease_state = classify_lease_state(lease, self.now_fn()) if kind == "VALID" else kind
            if kind != "VALID" or lease_state not in {"FREE", "EXPIRED"}:
                LOGGER.info("Code-sync status publication skipped while remote lease is unavailable or occupied.")
                return False

            origin_sha = self.repo.sha("origin/main")
            running_sha = self.repo.sha("HEAD")
            scratch = self._new_scratch("origin/main")
            try:
                previous = scratch.read_json("HEAD", STATUS_FILE) or {}
                now = self.now_fn()
                payload = {
                    "schemaVersion": 1,
                    "activeRole": self.role,
                    "heartbeatUtc": format_utc(now),
                    "lastSuccessfulUpdateUtc": previous.get("lastSuccessfulUpdateUtc"),
                    "runStartedUtc": format_utc(now),
                    "runCompletedUtc": format_utc(now),
                    "internetStatus": "OK",
                    "githubStatus": "OK",
                    "codeSyncStatus": f"BLOCKED_{error.code}",
                    "runningSha": running_sha,
                    "originMainSha": origin_sha,
                    "runningCodeSha": running_sha,
                    "originTipObservedSha": origin_sha,
                    "publishBaseSha": origin_sha,
                    "shaObservedPhase": "SYNC_BLOCK",
                    "updateStatus": "ERROR",
                    "lastSuccessfulPushUtc": format_utc(now),
                    "lastError": error.code,
                }
                scratch.write_json(STATUS_FILE, payload)
                if scratch.status_paths() != {STATUS_FILE}:
                    raise GitSafetyError(
                        "STATUS_SCOPE_VIOLATION",
                        "Code-sync status candidate changed an unexpected path.",
                    )
                status_sha = scratch.commit(
                    [STATUS_FILE],
                    f"KMEM updater code sync blocked {format_utc(now)} [{self.role}]",
                )
                if not status_sha:
                    return True
                if scratch.push_main():
                    LOGGER.info("Code-sync blocked status published code=%s", error.code)
                    return True
                fetched = scratch.run(
                    ["fetch", "--no-tags", "origin", "main"],
                    check=False,
                )
                if fetched.returncode == 0:
                    remote_sha = scratch.sha("origin/main")
                    ancestry = scratch.run(
                        ["merge-base", "--is-ancestor", status_sha, remote_sha],
                        check=False,
                    )
                    remote_status = scratch.read_json("origin/main", STATUS_FILE) or {}
                    accepted = (
                        (remote_sha == status_sha or ancestry.returncode == 0)
                        and str(remote_status.get("activeRole") or "").upper() == self.role
                        and str(remote_status.get("codeSyncStatus") or "").upper()
                        == f"BLOCKED_{error.code}"
                    )
                    if accepted:
                        LOGGER.info(
                            "Code-sync blocked status push confirmed after ambiguous transport result."
                        )
                        return True
            finally:
                scratch.close()
            LOGGER.info(
                "Code-sync status push lost remote race attempt=%s/%s",
                attempt,
                FINAL_PUSH_ATTEMPTS,
            )
        return False

    def publish_owned_cycle(self, ownership: LeaseOwnership, run_started: datetime) -> bool:
        expected_sha = ownership.lease_sha
        scratch = ownership.scratch
        lease_id = str(ownership.lease["leaseId"])
        generation_ok = False
        error_code = ""

        for attempt in range(1, FINAL_PUSH_ATTEMPTS + 1):
            if scratch.closed:
                scratch = self._new_scratch("origin/main")
                ownership.scratch = scratch

            generation_ok, error_code = self._run_generator(scratch)
            changed = scratch.status_paths()
            deleted_output = scratch.run(
                ["diff", "--name-only", "--diff-filter=D", "--"],
                check=False,
            )
            deleted = {
                line.strip().replace("\\", "/")
                for line in deleted_output.stdout.splitlines()
                if line.strip()
            }
            unexpected = changed.difference(GENERATED_FILES)
            if unexpected or deleted:
                generation_ok = False
                error_code = "GENERATED_FILE_DELETION" if deleted else "GENERATED_SCOPE_VIOLATION"
                LOGGER.error("Generator output violated the generated-file contract; publication stopped.")
                scratch.close()
                self.repo.fetch()
                scratch = self._new_scratch(expected_sha)
                ownership.scratch = scratch

            retryable, remote_sha = self._remote_move_is_retryable(expected_sha, lease_id)
            if remote_sha != expected_sha:
                scratch.close()
                if not retryable or attempt >= FINAL_PUSH_ATTEMPTS:
                    raise GitSafetyError(
                        "REMOTE_MOVED_DURING_RUN",
                        "origin/main moved during generation; no generated data was pushed.",
                    )
                expected_sha = remote_sha
                LOGGER.info("Expected generated-only remote movement; regenerating once.")
                continue

            now = self.now_fn()
            if not lease_is_active(ownership.lease, now):
                scratch.close()
                raise GitSafetyError("LEASE_EXPIRED", "Lease expired before final publication.")

            if not generation_ok:
                scratch.close()
                scratch = self._new_scratch(expected_sha)
                ownership.scratch = scratch

            previous_status = scratch.read_json("HEAD", STATUS_FILE)
            scratch.write_json(LEASE_FILE, released_lease(ownership.lease, now))
            scratch.write_json(
                STATUS_FILE,
                self._status_payload(
                    run_started=run_started,
                    completed=now,
                    code_sha=ownership.code_sha,
                    origin_sha=ownership.code_sha,
                    publish_base_sha=expected_sha,
                    generation_ok=generation_ok,
                    error_code=error_code,
                    previous_status=previous_status,
                ),
            )

            changed = scratch.status_paths()
            unexpected = changed.difference(GENERATED_FILES)
            if unexpected:
                scratch.close()
                raise GitSafetyError(
                    "PUBLISH_SCOPE_VIOLATION",
                    f"Updater candidate changed unexpected paths: {sorted(unexpected)}",
                )

            paths = [path for path in GENERATED_FILES if path in changed]
            final_sha = scratch.commit(
                paths,
                f"KMEM weather update {format_utc(now)} [{self.role}]",
            )
            if not final_sha:
                scratch.close()
                raise GitSafetyError("FINAL_COMMIT_FAILED", "Final updater candidate produced no commit.")

            push_ok = scratch.push_main()
            if not push_ok:
                fetched = scratch.run(
                    ["fetch", "--no-tags", "origin", "main"],
                    check=False,
                )
                if fetched.returncode == 0:
                    remote_after_push = scratch.sha("origin/main")
                    ancestry = scratch.run(
                        ["merge-base", "--is-ancestor", final_sha, remote_after_push],
                        check=False,
                    )
                    push_ok = remote_after_push == final_sha or ancestry.returncode == 0
            if push_ok:
                LOGGER.info("Generated update pushed sha=%s", short_sha(final_sha))
                scratch.close()
                self.repo.fetch()
                outcome = self.repo.sync(already_fetched=True)
                LOGGER.info("Maintained checkout sync=%s", outcome.status)
                return generation_ok

            LOGGER.info("Final push lost remote race attempt=%s/%s", attempt, FINAL_PUSH_ATTEMPTS)
            scratch.close()
            retryable, remote_sha = self._remote_move_is_retryable(expected_sha, lease_id)
            if not retryable or attempt >= FINAL_PUSH_ATTEMPTS:
                raise GitSafetyError(
                    "FINAL_PUSH_REJECTED",
                    "Final push was rejected; maintained checkout remains clean.",
                )
            expected_sha = remote_sha

        return False

    def run_once(self) -> int:
        run_started = self.now_fn()
        LOGGER.info("Cycle start role=%s", self.role)

        self.repo.validate()
        self.repo.fetch()
        if self.role == "BACKUP":
            status = self.repo.read_json("origin/main", STATUS_FILE)
            lease = self.repo.read_json("origin/main", LEASE_FILE)
            if lease_is_active(lease, self.now_fn()):
                LOGGER.info("Active remote lease found; BACKUP exits.")
                return self.skipped_cycle_result()
            if not self._backup_should_run(status):
                wait_seconds = self._backup_handoff_wait_seconds(status)
                if wait_seconds is None:
                    return self.skipped_cycle_result()
                LOGGER.info(
                    "BACKUP handoff recheck scheduled in %s seconds.",
                    int(wait_seconds),
                )
                self.sleep_fn(wait_seconds)
                self.repo.fetch()
                lease = self.repo.read_json("origin/main", LEASE_FILE)
                if lease_is_active(lease, self.now_fn()):
                    LOGGER.info("Active remote lease found after handoff wait; BACKUP exits.")
                    return self.skipped_cycle_result()
                status = self.repo.read_json("origin/main", STATUS_FILE)
                if not self._backup_should_run(status):
                    return self.skipped_cycle_result()

        outcome = self.repo.sync(already_fetched=True)
        LOGGER.info(
            "Code sync=%s local=%s origin=%s",
            outcome.status,
            short_sha(outcome.local_sha),
            short_sha(outcome.origin_sha),
        )
        if outcome.advanced:
            LOGGER.info("Code fast-forwarded; restarting to load the synchronized coordinator.")
            return RESTART_AFTER_SYNC_EXIT

        try:
            ownership = self.acquire_lease()
        except GitSafetyError as error:
            if error.code == "RESTART_REQUIRED":
                return RESTART_AFTER_SYNC_EXIT
            raise
        if ownership is None:
            return self.skipped_cycle_result()
        try:
            success = self.publish_owned_cycle(ownership, run_started)
            return 0 if success else 1
        finally:
            ownership.scratch.close()


def parse_role(value: Optional[str]) -> str:
    role = str(value or "").strip().upper()
    if role not in ROLES:
        raise ValueError("Updater role must be explicitly set to PRIMARY or BACKUP.")
    return role


def worker_authorization_path(lock_path: Path) -> Path:
    return lock_path.with_name("coordinated-worker.json")


def write_worker_authorization(path: Path, role: str, token: str, lock_id: str) -> None:
    if not lock_id:
        raise RuntimeError("Coordinated worker authorization requires a live lock ID.")
    atomic_write_json(
        path,
        {
            "schemaVersion": 1,
            "role": role,
            "parentProcessId": os.getpid(),
            "lockId": lock_id,
            "tokenSha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "authorizedEpoch": int(time.time()),
        },
    )


def clear_worker_authorization(path: Path) -> None:
    path.unlink(missing_ok=True)


def coordinated_worker_is_authorized(lock_path: Path, role: str, token: str) -> bool:
    if not token:
        return False
    authorization = read_local_json(worker_authorization_path(lock_path)) or {}
    lock_metadata = read_local_lock_metadata(lock_path)
    authorized_epoch = authorization.get("authorizedEpoch")
    try:
        authorization_age = time.time() - float(authorized_epoch)
    except (TypeError, ValueError):
        return False
    expected_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    if (
        authorization.get("schemaVersion") != 1
        or lock_metadata.get("schemaVersion") != 1
        or authorization.get("role") != role
        or lock_metadata.get("role") != role
        or authorization.get("parentProcessId") != os.getppid()
        or lock_metadata.get("processId") != os.getppid()
        or not authorization.get("lockId")
        or authorization.get("lockId") != lock_metadata.get("lockId")
        or authorization.get("tokenSha256") != expected_hash
        or authorization_age < -5
        or authorization_age > 60
    ):
        return False

    probe = LocalProcessLock(lock_path, role=role)
    try:
        probe.acquire()
    except LocalLockUnavailable:
        return True
    else:
        probe.release()
        return False


def run_single(args) -> int:
    role = parse_role(args.role or os.environ.get("KMEM_UPDATER_ROLE"))
    if args.force_failover and role != "BACKUP":
        raise ValueError("--force-failover is valid only for BACKUP role.")

    runtime_root = default_runtime_root()
    configure_logging(runtime_root)
    lock_path = runtime_root.parent / "updater.lock"
    repo = GitRepository(REPO_DIR, expected_remote=CANONICAL_REPOSITORY)
    coordinator = UpdaterCoordinator(
        repo,
        role,
        runtime_root,
        force_failover=args.force_failover,
        require_owned_cycle=args.require_owned_cycle,
    )

    def execute_cycle() -> int:
        try:
            return coordinator.run_once()
        except GitSafetyError as error:
            try:
                coordinator.publish_code_sync_blocked(error)
            except GitSafetyError as status_error:
                LOGGER.error("Code-sync status publication failed code=%s", status_error.code)
            raise

    if args.coordinated_worker:
        worker_token = os.environ.get("KMEM_COORDINATED_WORKER_TOKEN", "")
        if not coordinated_worker_is_authorized(lock_path, role, worker_token):
            raise ValueError("Coordinated worker mode requires its authorizing lock-holding parent.")
        try:
            return execute_cycle()
        except GitSafetyError as error:
            LOGGER.error("Cycle stopped code=%s", error.code)
            return 2

    try:
        with LocalProcessLock(lock_path, role=role) as updater_lock:
            cleanup_stale_scratch_clones(runtime_root, max_age_seconds=0)
            result = execute_cycle()
            reloads = 0
            while result == RESTART_AFTER_SYNC_EXIT and reloads < 2:
                reloads += 1
                worker_env = os.environ.copy()
                worker_token = uuid.uuid4().hex
                worker_env["KMEM_COORDINATED_WORKER_TOKEN"] = worker_token
                command = [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--role",
                    role,
                    "--coordinated-worker",
                ]
                if args.force_failover:
                    command.append("--force-failover")
                if args.require_owned_cycle:
                    command.append("--require-owned-cycle")
                try:
                    write_worker_authorization(
                        worker_authorization_path(lock_path),
                        role,
                        worker_token,
                        str(updater_lock.lock_id or ""),
                    )
                    result = run_bounded_process(
                        command,
                        env=worker_env,
                        timeout=WORKER_TIMEOUT_SECONDS,
                    ).returncode
                except subprocess.TimeoutExpired:
                    LOGGER.error("Coordinated updater worker timed out.")
                    return 2
                except OSError:
                    LOGGER.error("Coordinated updater worker could not be started.")
                    return 2
                finally:
                    try:
                        clear_worker_authorization(worker_authorization_path(lock_path))
                    except (OSError, RuntimeError):
                        LOGGER.warning("Coordinated worker authorization metadata could not be cleared.")
            if result == RESTART_AFTER_SYNC_EXIT:
                LOGGER.error("Code changed repeatedly; next scheduled cycle will retry.")
                return 2
            return result
    except LocalLockUnavailable as error:
        LOGGER.info("Cycle skipped: %s", error)
        return REQUIRED_OWNED_CYCLE_SKIPPED_EXIT if args.require_owned_cycle else 0
    except GitSafetyError as error:
        LOGGER.error("Cycle stopped code=%s", error.code)
        return 2


def daemon_loop(args) -> int:
    interval = max(60, int(args.interval))
    role = parse_role(args.role or os.environ.get("KMEM_UPDATER_ROLE"))
    while True:
        cycle_start = time.monotonic()
        command = [sys.executable, str(Path(__file__).resolve()), "--role", role]
        if args.force_failover:
            command.append("--force-failover")
        if args.require_owned_cycle:
            command.append("--require-owned-cycle")
        try:
            result = run_bounded_process(command, timeout=WORKER_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            LOGGER.error("Daemon child cycle timed out.")
            result = subprocess.CompletedProcess(command, 2)
        except OSError:
            LOGGER.error("Daemon child cycle could not be started.")
            result = subprocess.CompletedProcess(command, 2)
        elapsed = time.monotonic() - cycle_start
        delay = max(1.0, interval - elapsed)
        try:
            time.sleep(delay)
        except KeyboardInterrupt:
            return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="KMEM safe updater coordinator")
    parser.add_argument("--role", choices=sorted(ROLES), help="Explicit local updater role")
    parser.add_argument(
        "--force-failover",
        action="store_true",
        help="BACKUP only: attempt standby takeover despite heartbeat (never force-pushes)",
    )
    parser.add_argument("--daemon", action="store_true", help="Run a child cycle every interval")
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
        help="Daemon interval seconds (default 600)",
    )
    parser.add_argument("--coordinated-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--require-owned-cycle", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        return daemon_loop(args) if args.daemon else run_single(args)
    except ValueError as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
