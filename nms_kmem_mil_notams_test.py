#!/usr/bin/env python3
"""
KMEM MIL NOTAM/FICON NMS pull.

Reads credentials from:
  NMS_CLIENT_ID
  NMS_CLIENT_SECRET

Optional non-Windows urllib-fallback testing override (never used on Windows):
  NMS_ALLOW_INSECURE_SSL_FALLBACK=1

Run:
  set NMS_CLIENT_ID=YOUR_KEY_HERE
  set NMS_CLIENT_SECRET=YOUR_SECRET_HERE
  py nms_kmem_mil_notams_test.py

Writes:
  nms_kmem_mil_notams_output.json

Does not modify weather.json or GitHub.
"""

import base64
import html
import json
import os
import re
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    HTTPSHandler,
    ProxyHandler,
    Request,
    build_opener,
    urlopen,
)
from urllib.error import HTTPError, URLError
from xml.etree import ElementTree as ET

AUTH_URL = "https://api-staging.cgifederal-aim.com/v1/auth/token"
BASE_URL = "https://api-staging.cgifederal-aim.com/nmsapi/v1"
LOCATION = "KMEM"
OUTPUT_FILE = "nms_kmem_mil_notams_output.json"

# Production default: do not silently bypass TLS verification.
# This legacy opt-in applies only to the portable non-Windows urllib fallback.
# All Windows transports always use verified TLS and fail closed on certificate
# or TLS errors.
ALLOW_INSECURE_SSL_FALLBACK = os.environ.get(
    "NMS_ALLOW_INSECURE_SSL_FALLBACK",
    "0"
).strip().lower() in {"1", "true", "yes", "on"}

# NMS staging showed a rate limit around 1 request/sec.
REQUEST_DELAY_SECONDS = 1.25
MAX_RETRIES = 2
# Budgets are sized for PRIMARY's congested shared Wi-Fi, measured 2026-09-11:
# a lossy link needs 3-4 SYN retries (about 15 s) to open a socket, and the
# KMEM location pull is ~300 KB of AIXM that the service does not compress, so
# 40 s only fit it above ~7.5 KB/s. NMS's documented 30-second limit is
# server-side processing; transferring the finished body to a slow client is
# bounded here instead. Every stage remains a hard deadline and fails closed.
TOKEN_CONNECT_TIMEOUT_SECONDS = 20
TOKEN_TOTAL_TIMEOUT_SECONDS = 35
TOKEN_PROCESS_TIMEOUT_SECONDS = 40
NOTAMS_CONNECT_TIMEOUT_SECONDS = 20
NOTAMS_TOTAL_TIMEOUT_SECONDS = 120
NOTAMS_PROCESS_TIMEOUT_SECONDS = 130
# Backward-compatible names retain the tighter TOKEN policy. Production calls
# select the explicit TOKEN/NOTAMS policy before entering a transport.
URLLIB_TOTAL_TIMEOUT_SECONDS = TOKEN_TOTAL_TIMEOUT_SECONDS
TRANSIENT_HTTP_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}

# Windows production prefers OS curl, then the checked-in PowerShell transport
# using the interactive task user's Windows system-proxy settings. Both child
# processes have hard deadlines below the updater's parent timeout.
CURL_CONNECT_TIMEOUT_SECONDS = TOKEN_CONNECT_TIMEOUT_SECONDS
CURL_TOTAL_TIMEOUT_SECONDS = TOKEN_TOTAL_TIMEOUT_SECONDS
CURL_PROCESS_TIMEOUT_SECONDS = TOKEN_PROCESS_TIMEOUT_SECONDS
CURL_MAX_RETRIES = 2
# Only availability/framing failures may cross from curl to the independently
# verified PowerShell transport. TLS, certificate, trust-store, client-certificate,
# and pinning failures intentionally remain terminal instead of trying a transport
# with potentially different validation behavior.
# Exit 28 crosses only when safe curl timing does not prove the TLS/request phase;
# a proven upstream-response timeout is handled terminally before this set.
CURL_CROSS_TRANSPORT_EXIT_CODES = {2, 5, 6, 7, 18, 28, 52, 55, 56, 92, 95, 96}
CURL_HTTP_STATUS_MARKER = "__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:"
CURL_TIMING_MARKER = "__KMEM_NMS_CURL_TIMING_5A92D4E7__:"
CURL_STATUS_RE = re.compile(
    rb"(?:\r?\n)__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:([0-9]{3})\r?\n?\Z"
)
CURL_TIMED_STATUS_RE = re.compile(
    rb"(?:\r?\n)__KMEM_NMS_CURL_TIMING_5A92D4E7__:"
    rb"([0-9]+(?:\.[0-9]+)?),([0-9]+(?:\.[0-9]+)?)\r?\n"
    rb"__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:([0-9]{3})\r?\n?\Z"
)
CURL_DIAGNOSTIC_LIMIT = 1024
TRANSPORT_PIPE_DRAIN_TIMEOUT_SECONDS = 3
TRANSPORT_TREE_KILL_TIMEOUT_SECONDS = 5
POWERSHELL_TOTAL_TIMEOUT_SECONDS = TOKEN_TOTAL_TIMEOUT_SECONDS
POWERSHELL_PROCESS_TIMEOUT_SECONDS = TOKEN_PROCESS_TIMEOUT_SECONDS
POWERSHELL_MAX_RETRIES = 2
PYTHON_CHILD_TOTAL_TIMEOUT_SECONDS = 25
PYTHON_CHILD_PROCESS_TIMEOUT_SECONDS = 30
PYTHON_CHILD_MAX_RETRIES = 2
PYTHON_CHILD_RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024
PYTHON_RUNTIME_TOTAL_TIMEOUT_SECONDS = 25
PYTHON_RUNTIME_MAX_RETRIES = 2
PYTHON_RUNTIME_RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024
NMS_API_HOST = "api-staging.cgifederal-aim.com"
POWERSHELL_SYSTEM_PROXY_SCRIPT_PATH = os.path.realpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "nms_windows_system_proxy.ps1",
    )
)
LAST_HTTP_TRANSPORT = "NOT_USED"
LAST_PROCESS_BOUNDARY = "NOT_USED"
LAST_REQUEST_STAGE = "NOT_USED"
LAST_SYSTEM_PROXY_ROUTE = "NOT_USED"
LAST_TRANSPORT_REASON = "NOT_USED"
SAFE_REQUEST_STAGES = {"TOKEN", "NOTAMS", "NOT_USED"}
SAFE_SYSTEM_PROXY_ROUTES = {"DIRECT", "SYSTEM_PROXY", "NOT_USED"}
SAFE_TRANSPORT_REASONS = {
    "NONE",
    "CONFIGURATION",
    "DNS",
    "PROXY_ROUTE",
    "CONNECTION",
    "TIMEOUT",
    "UPSTREAM_RESPONSE_TIMEOUT",
    "TLS_SECURITY",
    "RESPONSE_TOO_LARGE",
    "UNCLASSIFIED",
    "NOT_USED",
}
SAFE_FAILURE_CATEGORIES = {
    "AUTH_HTTP",
    "RATE_LIMIT",
    "UPSTREAM_HTTP",
    "UPSTREAM_RESPONSE_TIMEOUT",
    "TLS_SECURITY",
    "PROXY_AUTH",
    "TRANSPORT_COMPATIBILITY",
    "TRANSPORT_UNAVAILABLE",
    "PROCESS_LAUNCH",
    "RESPONSE_PARSE",
    "CONFIGURATION",
    "OS_ERROR",
    "UNCLASSIFIED",
}


class NmsTransportError(RuntimeError):
    """A curl process/protocol failure that may use another verified transport."""


class NmsCompatibilityError(NmsTransportError):
    """A local transport command is incompatible with its fixed invocation."""


class NmsUpstreamResponseTimeout(RuntimeError):
    """A request timed out after verified TLS, so it must not be replayed."""


def helper_failure_category(error):
    """Map a failed helper run to a credential-free operational category."""
    text = str(error).casefold()
    if isinstance(error, SystemExit):
        return "CONFIGURATION"
    if isinstance(error, NmsUpstreamResponseTimeout):
        return "UPSTREAM_RESPONSE_TIMEOUT"
    if "http 401" in text or "http 403" in text:
        return "AUTH_HTTP"
    if "http 407" in text:
        return "PROXY_AUTH"
    if "http 429" in text:
        return "RATE_LIMIT"
    if re.search(r"\bhttp 5\d\d\b", text):
        return "UPSTREAM_HTTP"
    if any(term in text for term in ("certificate", "ssl", "tls", "trust")):
        return "TLS_SECURITY"
    if re.search(r"\bcurl exit 2\b", text):
        return "TRANSPORT_COMPATIBILITY"
    if isinstance(error, NmsCompatibilityError):
        return "TRANSPORT_COMPATIBILITY"
    if "process launch" in text:
        return "PROCESS_LAUNCH"
    if isinstance(error, NmsTransportError):
        return "TRANSPORT_UNAVAILABLE"
    if re.search(
        r"\btransport (?:dns|proxy_route|connection|timeout)\b",
        text,
    ):
        return "TRANSPORT_UNAVAILABLE"
    if any(
        term in text
        for term in (
            "could not connect",
            "failed to connect",
            "sending the request",
            "name or service not known",
            "timeout",
            "timed out",
        )
    ):
        return "TRANSPORT_UNAVAILABLE"
    if isinstance(error, (json.JSONDecodeError, ET.ParseError)) or any(
        term in text for term in ("malformed xml", "no complete aixm", "incomplete page")
    ):
        return "RESPONSE_PARSE"
    if isinstance(error, OSError):
        return "OS_ERROR"
    return "UNCLASSIFIED"

BULK_CLASSIFICATION_ALIASES = {
    "DOM": "DOM",
    "DOMESTIC": "DOM",
    "FICON": "DOM",
    "SNOW": "DOM",
    "MIL": "MIL",
    "MILITARY": "MIL",
    "INTL": "INTL",
    "INTERNATIONAL": "INTL",
    "FDC": "FDC",
}
BULK_OPERATIONAL_CLASSIFICATIONS = {"DOM", "MIL", "INTL"}
BULK_CONTINUATION_KEYS = {
    "continuationtoken",
    "cursor",
    "hasmore",
    "next",
    "nextcursor",
    "nextpage",
}
BULK_TOTAL_KEYS = {"count", "recordcount", "total", "totalcount", "totalrecords"}
BULK_SIMPLE_NUMBER_RE = re.compile(
    r"^\s*![A-Z0-9]{3,4}\s+(\d{1,2})/(\d{3,4})\b",
    re.IGNORECASE,
)
BULK_ALIAS_CLASSIFICATIONS = {"DOM", "INTL"}
BULK_ALIAS_PREFERENCE = {"DOM": 0, "INTL": 1}


def utc_now_z():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def ssl_context(insecure=False):
    return ssl._create_unverified_context() if insecure else ssl.create_default_context()


def resolve_request_stage(request_stage=None, method=None, url=None):
    """Resolve an explicit stage, or infer it from the fixed endpoint path."""
    if request_stage is not None:
        stage = str(request_stage).strip().upper()
    else:
        normalized_method = str(method or "").strip().upper()
        path = urlsplit(str(url or "")).path.rstrip("/").casefold()
        if normalized_method == "GET" and path.endswith("/notams"):
            stage = "NOTAMS"
        elif normalized_method == "POST" and path.endswith("/token"):
            stage = "TOKEN"
        else:
            # Preserve the historic tight default for isolated/generic callers.
            stage = "TOKEN"
    if stage not in {"TOKEN", "NOTAMS"}:
        raise ValueError("invalid NMS request stage")
    return stage


def transport_timeout_policy(request_stage):
    """Return the fixed bounded policy for one allowlisted NMS request stage."""
    stage = resolve_request_stage(request_stage)
    if stage == "TOKEN":
        return {
            "connect": TOKEN_CONNECT_TIMEOUT_SECONDS,
            "total": TOKEN_TOTAL_TIMEOUT_SECONDS,
            "process": TOKEN_PROCESS_TIMEOUT_SECONDS,
        }
    if stage == "NOTAMS":
        return {
            "connect": NOTAMS_CONNECT_TIMEOUT_SECONDS,
            "total": NOTAMS_TOTAL_TIMEOUT_SECONDS,
            "process": NOTAMS_PROCESS_TIMEOUT_SECONDS,
        }
    raise AssertionError("unreachable NMS request stage")


def retry_wait_seconds(attempt):
    return REQUEST_DELAY_SECONDS * attempt + 1.0


def raise_or_retry_http_error(exc, attempt):
    error_text = exc.read().decode("utf-8", errors="replace")

    if exc.code in TRANSIENT_HTTP_STATUS_CODES and attempt < MAX_RETRIES:
        wait = retry_wait_seconds(attempt)
        print(
            f"HTTP {exc.code} transient response. "
            f"Waiting {wait:.1f} sec then retrying..."
        )
        time.sleep(wait)
        return

    raise RuntimeError(f"HTTP {exc.code}: {error_text}") from exc


def urllib_http_request(
    method,
    url,
    headers=None,
    body=None,
    timeout=45,
    *,
    request_stage=None,
):
    """Portable verified-TLS fallback used when Windows curl is unavailable."""
    request_stage = resolve_request_stage(request_stage, method, url)
    req = Request(url=url, data=body, headers=headers or {}, method=method)
    timeout = min(
        float(timeout),
        transport_timeout_policy(request_stage)["total"],
    )
    if timeout <= 0:
        raise ValueError("urllib request timeout must be positive")

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=timeout, context=ssl_context(False)) as resp:
                return resp.read()

        except HTTPError as exc:
            raise_or_retry_http_error(exc, attempt)
            continue

        except (ssl.SSLError, URLError, TimeoutError) as exc:
            request_error = exc

            if ALLOW_INSECURE_SSL_FALLBACK:
                print(f"Normal SSL failed or was blocked: {exc}")
                print("Trying temporary insecure SSL fallback for NMS test...")

                try:
                    with urlopen(req, timeout=timeout, context=ssl_context(True)) as resp:
                        return resp.read()
                except HTTPError as fallback_http_error:
                    raise_or_retry_http_error(fallback_http_error, attempt)
                    continue
                except (ssl.SSLError, URLError, TimeoutError) as fallback_error:
                    request_error = fallback_error

            if attempt < MAX_RETRIES:
                wait = retry_wait_seconds(attempt)
                print(
                    f"Transient NMS network error: {request_error}. "
                    f"Waiting {wait:.1f} sec then retrying..."
                )
                time.sleep(wait)
                continue

            raise RuntimeError(
                f"NMS network request failed after {MAX_RETRIES} attempts: "
                f"{request_error}"
            ) from request_error

    raise RuntimeError("Request failed after retries.")


def windows_system_paths(*relative_parts):
    """Return trusted System32/Sysnative candidates, never PATH/cwd matches."""
    if os.name != "nt":
        return []

    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if not system_root or not os.path.isabs(system_root):
        return []

    system_root = os.path.abspath(system_root)
    candidates = []
    if os.environ.get("PROCESSOR_ARCHITEW6432"):
        # A 32-bit Python process uses Sysnative to bypass System32 redirection.
        candidates.append(os.path.join(system_root, "Sysnative", *relative_parts))
    candidates.append(os.path.join(system_root, "System32", *relative_parts))
    return candidates


def first_existing_windows_system_path(*relative_parts):
    for candidate in windows_system_paths(*relative_parts):
        if os.path.isfile(candidate):
            return candidate
    return None


def windows_curl_path():
    """Return only the trusted Windows system curl, never a PATH shadow."""
    return first_existing_windows_system_path("curl.exe")


def windows_powershell_path():
    """Return pinned Windows PowerShell for the no-system-curl fallback."""
    return first_existing_windows_system_path(
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    )


def windows_taskkill_path():
    """Return pinned taskkill used to terminate timed-out transport trees."""
    return first_existing_windows_system_path("taskkill.exe")


def windows_descendant_pids(root_pid):
    """Return a deepest-first snapshot of descendants of one Windows PID."""
    if os.name != "nt":
        return []

    import ctypes
    from ctypes import wintypes

    class ProcessEntry32W(ctypes.Structure):
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
    process_first.argtypes = (wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W))
    process_first.restype = wintypes.BOOL
    process_next = kernel32.Process32NextW
    process_next.argtypes = (wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W))
    process_next.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL

    snapshot = create_snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if snapshot == wintypes.HANDLE(-1).value:
        return []

    parents = {}
    try:
        entry = ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(ProcessEntry32W)
        if not process_first(snapshot, ctypes.byref(entry)):
            return []
        while True:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            if not process_next(snapshot, ctypes.byref(entry)):
                break
    finally:
        close_handle(snapshot)

    depths = {int(root_pid): 0}
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


def windows_terminate_pid(pid):
    """Directly terminate a Windows PID when tree termination is restricted."""
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


def run_pinned_taskkill(pid):
    """Run the trusted Windows tree terminator with a bounded wait."""
    taskkill_path = windows_taskkill_path()
    if not taskkill_path:
        return
    killer = None
    try:
        killer = subprocess.Popen(
            [taskkill_path, "/PID", str(pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        killer.wait(timeout=TRANSPORT_TREE_KILL_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        if killer is not None:
            try:
                killer.kill()
            except OSError:
                pass
    finally:
        if killer is not None and killer.poll() is None:
            try:
                killer.kill()
            except OSError:
                pass
        if killer is not None:
            try:
                killer.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass


class WindowsTransportJob:
    """Own a Windows Job Object that kills every assigned descendant on close."""

    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

    def __init__(self, process):
        import ctypes
        from ctypes import wintypes

        class JobObjectBasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JobObjectExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JobObjectBasicLimitInformation),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        )
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = (
            wintypes.HANDLE,
            wintypes.HANDLE,
        )
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL

        self._kernel32 = kernel32
        self._handle = kernel32.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())

        limits = JobObjectExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = (
            self.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        if not kernel32.SetInformationJobObject(
            self._handle,
            self.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

        if not kernel32.AssignProcessToJobObject(
            self._handle,
            wintypes.HANDLE(int(process._handle)),
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def terminate(self):
        """Terminate every process still assigned to the job."""
        if not self._handle:
            return False
        return bool(self._kernel32.TerminateJobObject(self._handle, 1))

    def close(self):
        """Close the job; KILL_ON_JOB_CLOSE prevents orphan descendants."""
        if self._handle:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


def terminate_transport_process_tree(process, process_job=None):
    """Boundedly terminate a transport child and every Windows descendant."""
    if os.name == "nt":
        descendants = windows_descendant_pids(process.pid)
        def refresh_descendants(values):
            # Each fresh snapshot is already deepest-first. Put it ahead of
            # older observations so a newly spawned leaf is never processed
            # after its previously observed ancestor.
            ordered = []
            seen = set()
            for descendant_pid in [*values, *descendants]:
                if descendant_pid not in seen:
                    ordered.append(descendant_pid)
                    seen.add(descendant_pid)
            descendants[:] = ordered

        job_terminated = process_job is not None and process_job.terminate()
        if process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass
        refresh_descendants(windows_descendant_pids(process.pid))
        if not job_terminated:
            run_pinned_taskkill(process.pid)
            for descendant_pid in descendants:
                windows_terminate_pid(descendant_pid)
            # Close the snapshot/launch race without allowing cleanup to run
            # indefinitely in a restricted scheduled-task environment.
            for _ in range(2):
                refresh_descendants(windows_descendant_pids(process.pid))
                for descendant_pid in descendants:
                    windows_terminate_pid(descendant_pid)
        return

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            process.kill()
        except OSError:
            pass


def close_transport_pipes(process):
    """Close local pipe handles so a surviving descendant cannot block return."""
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(process, stream_name, None)
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass


def read_transport_capture(stream):
    """Read one seekable temporary capture after the direct child has exited."""
    stream.flush()
    stream.seek(0)
    return stream.read()


def cleanup_transport_descendants(process):
    """Remove descendants left behind after a direct fallback child exits."""
    if os.name != "nt":
        return
    for descendant_pid in windows_descendant_pids(process.pid):
        windows_terminate_pid(descendant_pid)


def record_process_boundary(name):
    """Record a safe process-containment enum for diagnostics/publication."""
    global LAST_PROCESS_BOUNDARY
    if name == "WINDOWS_DIRECT_BOUNDED" or LAST_PROCESS_BOUNDARY == "NOT_USED":
        LAST_PROCESS_BOUNDARY = name
    print(f"NMS process boundary: {name}")


def record_transport_reason(reason):
    """Publish one credential-free allowlisted transport outcome."""
    global LAST_TRANSPORT_REASON
    normalized = str(reason or "UNCLASSIFIED").strip().upper()
    LAST_TRANSPORT_REASON = (
        normalized if normalized in SAFE_TRANSPORT_REASONS else "UNCLASSIFIED"
    )
    print(f"NMS transport reason: {LAST_TRANSPORT_REASON}")


def run_bounded_transport_process(command, *, input, timeout, env):
    """Run a byte transport with a hard deadline and bounded tree cleanup."""
    platform_options = {}
    if os.name == "nt":
        platform_options["creationflags"] = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    else:
        platform_options["start_new_session"] = True

    # Seekable files avoid subprocess pipe-reader threads. A grandchild which
    # inherits an output handle therefore cannot make communicate()/close block
    # beyond the direct child's hard deadline.
    with tempfile.TemporaryFile() as stdout_capture, tempfile.TemporaryFile() as stderr_capture:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=stdout_capture,
            stderr=stderr_capture,
            shell=False,
            env=env,
            **platform_options,
        )
        process_job = None
        direct_fallback = False
        if os.name == "nt":
            try:
                process_job = WindowsTransportJob(process)
                record_process_boundary("WINDOWS_JOB_OBJECT")
            except OSError:
                # Task Scheduler may already place this process tree in a Job
                # which rejects nested assignment. The child is still bounded
                # by its native timeout, our direct deadline, pinned taskkill,
                # and explicit descendant termination.
                direct_fallback = True
                record_process_boundary("WINDOWS_DIRECT_BOUNDED")
            except BaseException:
                terminate_transport_process_tree(process)
                close_transport_pipes(process)
                try:
                    process.wait(timeout=TRANSPORT_PIPE_DRAIN_TIMEOUT_SECONDS)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                raise
        else:
            record_process_boundary("POSIX_PROCESS_GROUP")

        try:
            process.communicate(input=input, timeout=timeout)
            if direct_fallback:
                cleanup_transport_descendants(process)
            stdout = read_transport_capture(stdout_capture)
            stderr = read_transport_capture(stderr_capture)
        except subprocess.TimeoutExpired as error:
            terminate_transport_process_tree(process, process_job)
            try:
                process.wait(timeout=TRANSPORT_PIPE_DRAIN_TIMEOUT_SECONDS)
            except (OSError, subprocess.TimeoutExpired):
                terminate_transport_process_tree(process, process_job)
            stdout = read_transport_capture(stdout_capture)
            stderr = read_transport_capture(stderr_capture)
            close_transport_pipes(process)
            raise subprocess.TimeoutExpired(
                command,
                timeout,
                output=stdout,
                stderr=stderr,
            ) from error
        except BaseException:
            terminate_transport_process_tree(process, process_job)
            close_transport_pipes(process)
            try:
                process.wait(timeout=TRANSPORT_PIPE_DRAIN_TIMEOUT_SECONDS)
            except (OSError, subprocess.TimeoutExpired):
                pass
            raise
        finally:
            if process_job is not None:
                process_job.close()

        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def validated_http_headers(headers=None):
    """Normalize an HTTP header mapping while rejecting header injection."""
    normalized = {}
    for name, value in (headers or {}).items():
        header_name = str(name).strip()
        header_value = str(value)
        if not re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+", header_name):
            raise ValueError("invalid HTTP header name")
        if any(character in header_value for character in ("\x00", "\r", "\n")):
            raise ValueError("invalid HTTP header value")
        normalized[header_name] = header_value
    return normalized


def curl_header_stdin(headers=None):
    """Build curl's stdin header file after rejecting header injection."""
    lines = [
        f"{name}: {value}"
        for name, value in validated_http_headers(headers).items()
    ]
    return (("\n".join(lines) + "\n") if lines else "").encode("utf-8")


def curl_request_command(
    curl_path,
    method,
    url,
    body=None,
    *,
    request_stage=None,
):
    """Build a secret-free curl argv with explicit HTTPS and time limits."""
    normalized_method = str(method or "GET").strip().upper()
    if not re.fullmatch(r"[A-Z]+", normalized_method):
        raise ValueError("invalid HTTP method")
    if not str(url).lower().startswith("https://"):
        raise ValueError("NMS curl transport requires HTTPS")
    request_stage = resolve_request_stage(request_stage, normalized_method, url)
    timeout_policy = transport_timeout_policy(request_stage)

    command = [
        curl_path,
        "--disable",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--connect-timeout",
        str(timeout_policy["connect"]),
        "--max-time",
        str(timeout_policy["total"]),
        "--request",
        normalized_method,
        "--url",
        str(url),
        "--write-out",
        (
            f"\\n{CURL_TIMING_MARKER}"
            "%{time_appconnect},%{time_starttransfer}\\n"
            f"{CURL_HTTP_STATUS_MARKER}%{{http_code}}\\n"
        ),
        "--header",
        "@-",
    ]

    if body is not None:
        body_bytes = body if isinstance(body, bytes) else str(body).encode("utf-8")
        if body_bytes != b"grant_type=client_credentials":
            raise ValueError("unexpected NMS curl request body")
        # This fixed OAuth grant declaration contains no credential material.
        command.extend(["--data", "grant_type=client_credentials"])

    return command


def redact_authorization_diagnostics(text, headers=None):
    """Redact full Authorization values and their Basic/Bearer payloads."""
    secrets = set()
    for name, value in (headers or {}).items():
        if str(name).strip().lower() == "authorization" and value:
            authorization = str(value).strip()
            secrets.add(authorization)
            match = re.fullmatch(r"(?:Basic|Bearer)\s+(.+)", authorization, re.IGNORECASE)
            if match:
                secrets.add(match.group(1).strip())

    for secret in sorted(secrets, key=len, reverse=True):
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text


def curl_diagnostics(stderr, headers=None):
    """Return bounded curl diagnostics with authorization values redacted."""
    text = (stderr or b"").decode("utf-8", errors="backslashreplace")
    text = redact_authorization_diagnostics(text, headers)
    return text.strip()[-CURL_DIAGNOSTIC_LIMIT:]


def curl_http_body_diagnostic(body, headers=None):
    """Return a bounded/redacted body from a completed non-success HTTP reply."""
    text = (body or b"").decode("utf-8", errors="backslashreplace")
    text = redact_authorization_diagnostics(text, headers)
    return text.strip()[-CURL_DIAGNOSTIC_LIMIT:]


def split_curl_response(stdout):
    """Strip and return only curl's unique final stdout HTTP status marker."""
    status, body, _, _ = split_curl_response_metadata(stdout)
    return status, body


def split_curl_response_metadata(stdout):
    """Strip curl's final markers and return only numeric phase telemetry."""
    raw = stdout or b""
    timed_status_match = CURL_TIMED_STATUS_RE.search(raw)
    if timed_status_match:
        return (
            int(timed_status_match.group(3)),
            raw[:timed_status_match.start()],
            float(timed_status_match.group(1)),
            float(timed_status_match.group(2)),
        )
    status_match = CURL_STATUS_RE.search(raw)
    if not status_match:
        return None, b"", None, None
    return int(status_match.group(1)), raw[:status_match.start()], None, None


def run_curl_attempt(
    curl_path,
    method,
    url,
    headers=None,
    body=None,
    *,
    request_stage=None,
):
    """Run one bounded curl process and return transport metadata."""
    request_stage = resolve_request_stage(request_stage, method, url)
    timeout_policy = transport_timeout_policy(request_stage)
    command = curl_request_command(
        curl_path,
        method,
        url,
        body,
        request_stage=request_stage,
    )
    header_input = curl_header_stdin(headers)

    child_environment = os.environ.copy()
    child_environment.pop("NMS_CLIENT_ID", None)
    child_environment.pop("NMS_CLIENT_SECRET", None)

    try:
        completed = run_bounded_transport_process(
            command,
            input=header_input,
            timeout=timeout_policy["process"],
            env=child_environment,
        )
    except subprocess.TimeoutExpired:
        return {
            "returncode": 28,
            "status": None,
            "body": b"",
            "diagnostic": "curl process exceeded its hard timeout",
            "appConnectSeconds": None,
            "startTransferSeconds": None,
        }

    stderr = completed.stderr or b""
    (
        status,
        response_body,
        app_connect_seconds,
        start_transfer_seconds,
    ) = split_curl_response_metadata(completed.stdout)
    return {
        "returncode": completed.returncode,
        "status": status,
        "body": response_body,
        "diagnostic": curl_diagnostics(stderr, headers),
        "appConnectSeconds": app_connect_seconds,
        "startTransferSeconds": start_transfer_seconds,
        "httpBodyDiagnostic": (
            curl_http_body_diagnostic(response_body, headers)
            if completed.returncode == 0 and status is not None
            else ""
        ),
    }


def curl_result_is_success(result):
    status = result.get("status")
    return result.get("returncode") == 0 and status is not None and 200 <= status < 300


def curl_result_is_transport_failure(result):
    """Separate transport/protocol failures from completed HTTP responses."""
    status = result.get("status")
    return_code = result.get("returncode")
    if return_code == 0:
        return not isinstance(status, int) or not 100 <= status <= 599
    app_connect_seconds = result.get("appConnectSeconds")
    if (
        isinstance(app_connect_seconds, (int, float))
        and app_connect_seconds > 0
    ):
        # TLS completed, so these fixed requests may already have reached the
        # provider. Never replay a partial/empty/protocol-failed response on a
        # second transport.
        return False
    return return_code in CURL_CROSS_TRANSPORT_EXIT_CODES


def curl_result_is_upstream_response_timeout(result):
    """Identify a curl timeout only after verified TLS reached the request phase."""
    if result.get("returncode") != 28:
        return False
    app_connect_seconds = result.get("appConnectSeconds")
    # curl reports time_starttransfer as elapsed-to-failure on some timeout
    # paths, even when no response byte arrived. A positive TLS-completion time
    # is the reliable boundary: for these fixed HTTPS requests, curl has entered
    # the request/response phase and another transport must not replay it.
    return (
        isinstance(app_connect_seconds, (int, float))
        and app_connect_seconds > 0
    )


def curl_result_is_transient(result):
    status = result.get("status")
    return status in TRANSIENT_HTTP_STATUS_CODES


def curl_failure_message(result):
    status = result.get("status")
    if result.get("returncode") != 0:
        summary = f"curl exit {result.get('returncode')}"
    elif status is not None:
        summary = f"HTTP {status:03d}"
    else:
        summary = "missing HTTP status"
    details = []
    if result.get("diagnostic"):
        details.append(result["diagnostic"])
    if result.get("httpBodyDiagnostic"):
        details.append(result["httpBodyDiagnostic"])
    diagnostic = " | ".join(details) or "no diagnostic text"
    return f"NMS curl request failed ({summary}): {diagnostic}"


def curl_http_request(
    curl_path,
    method,
    url,
    headers=None,
    body=None,
    *,
    request_stage=None,
):
    """Use bounded verified-TLS Windows curl attempts and fail closed."""
    request_stage = resolve_request_stage(request_stage, method, url)
    for attempt in range(1, CURL_MAX_RETRIES + 1):
        try:
            result = run_curl_attempt(
                curl_path,
                method,
                url,
                headers,
                body,
                request_stage=request_stage,
            )
        except OSError as error:
            raise NmsTransportError(
                "NMS curl request failed (process launch error): no diagnostic text"
            ) from error
        if curl_result_is_success(result):
            return result["body"]

        if curl_result_is_upstream_response_timeout(result):
            record_transport_reason("UPSTREAM_RESPONSE_TIMEOUT")
            raise NmsUpstreamResponseTimeout(
                "NMS curl request failed (upstream response timeout)"
            )

        # A second verified Windows transport is safer and faster than retrying a
        # curl process which could not produce a complete HTTP response. Valid
        # HTTP errors remain owned by curl and never trigger provider replay.
        if curl_result_is_transport_failure(result):
            error_type = (
                NmsCompatibilityError
                if result.get("returncode") == 2
                else NmsTransportError
            )
            raise error_type(curl_failure_message(result))

        if curl_result_is_transient(result) and attempt < CURL_MAX_RETRIES:
            wait = retry_wait_seconds(attempt)
            print(
                f"Transient NMS curl failure (attempt {attempt}/{CURL_MAX_RETRIES}). "
                f"Waiting {wait:.1f} sec then retrying..."
            )
            time.sleep(wait)
            continue

        raise RuntimeError(curl_failure_message(result))

    raise RuntimeError("NMS curl request failed after bounded retries.")


def powershell_http_script():
    """Return the checked-in, credential-free system-proxy transport source."""
    with open(
        POWERSHELL_SYSTEM_PROXY_SCRIPT_PATH,
        "r",
        encoding="utf-8-sig",
    ) as script_file:
        return script_file.read()


def powershell_request_command(powershell_path):
    """Build secret-free argv for the pinned checked-in proxy transport."""
    script_path = POWERSHELL_SYSTEM_PROXY_SCRIPT_PATH
    expected_parent = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
    if (
        not os.path.isabs(script_path)
        or not os.path.isfile(script_path)
        or os.path.commonpath((expected_parent, script_path)) != expected_parent
    ):
        raise OSError("checked-in NMS PowerShell transport is unavailable")
    return [
        powershell_path,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script_path,
    ]


def powershell_request_stdin(
    method,
    url,
    headers=None,
    body=None,
    *,
    request_stage=None,
):
    """Serialize the request, including authorization, only to child stdin."""
    normalized_method = str(method or "GET").strip().upper()
    if normalized_method not in {"GET", "POST"}:
        raise ValueError("invalid HTTP method")

    parsed = urlsplit(str(url or ""))
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() != NMS_API_HOST
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.port not in (None, 443)
    ):
        raise ValueError("invalid NMS PowerShell destination")

    body_bytes = None
    if body is not None:
        body_bytes = body if isinstance(body, bytes) else str(body).encode("utf-8")
        if body_bytes != b"grant_type=client_credentials":
            raise ValueError("unexpected NMS PowerShell request body")

    expected_token_request = (
        parsed.path == "/v1/auth/token"
        and not parsed.query
        and normalized_method == "POST"
        and body_bytes is not None
    )
    expected_notam_request = (
        parsed.path == "/nmsapi/v1/notams"
        and parsed.query == "location=KMEM"
        and normalized_method == "GET"
        and body_bytes is None
    )
    if not (expected_token_request or expected_notam_request):
        raise ValueError("invalid NMS PowerShell endpoint contract")
    request_stage = resolve_request_stage(request_stage, normalized_method, url)
    expected_stage = "TOKEN" if expected_token_request else "NOTAMS"
    if request_stage != expected_stage:
        raise ValueError("invalid NMS PowerShell request stage")
    timeout_policy = transport_timeout_policy(request_stage)

    normalized_headers = validated_http_headers(headers)
    prohibited_headers = {
        "connection",
        "content-length",
        "host",
        "proxy-authorization",
        "transfer-encoding",
    }
    if any(name.casefold() in prohibited_headers for name in normalized_headers):
        raise ValueError("invalid NMS PowerShell headers")

    payload = {
        "method": normalized_method,
        "url": str(url),
        "requestStage": request_stage,
        "timeoutSeconds": timeout_policy["total"],
        "headers": normalized_headers,
        "hasBody": body_bytes is not None,
        "bodyBase64": base64.b64encode(body_bytes or b"").decode("ascii"),
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def run_powershell_attempt(
    powershell_path,
    method,
    url,
    headers=None,
    body=None,
    *,
    request_stage=None,
):
    """Run one bounded verified-TLS Windows HttpClient request."""
    request_stage = resolve_request_stage(request_stage, method, url)
    timeout_policy = transport_timeout_policy(request_stage)
    command = powershell_request_command(powershell_path)
    request_input = powershell_request_stdin(
        method,
        url,
        headers,
        body,
        request_stage=request_stage,
    )
    child_environment = os.environ.copy()
    child_environment.pop("NMS_CLIENT_ID", None)
    child_environment.pop("NMS_CLIENT_SECRET", None)

    try:
        completed = run_bounded_transport_process(
            command,
            input=request_input,
            timeout=timeout_policy["process"],
            env=child_environment,
        )
    except subprocess.TimeoutExpired as error:
        route, _ = powershell_safe_markers(getattr(error, "stderr", None))
        return {
            "returncode": 28,
            "status": None,
            "body": b"",
            "diagnostic": "NMS system proxy transport timed out",
            "proxyRoute": route,
            "transportReason": "TIMEOUT",
        }

    status, response_body = split_curl_response(completed.stdout)
    route, reason = powershell_safe_markers(completed.stderr)
    if completed.returncode == 0 and isinstance(status, int):
        reason = "NONE"
    return {
        "returncode": completed.returncode,
        "status": status,
        "body": response_body,
        "diagnostic": (
            f"system proxy route {route}; reason {reason}"
            if completed.returncode != 0
            else ""
        ),
        "proxyRoute": route,
        "transportReason": reason,
        # Proxy-generated HTTP bodies can contain internal route details. The
        # numeric status is sufficient for safe operational diagnosis.
        "httpBodyDiagnostic": "",
    }


def _last_allowlisted_marker(raw, label, allowed, default="NOT_USED"):
    """Return only the last exact safe enum emitted by a transport child."""
    if isinstance(raw, bytes):
        text = raw.decode("ascii", errors="ignore")
    else:
        text = str(raw or "")
    values = re.findall(
        rf"(?m)^{re.escape(label)}\s*([A-Z0-9_]+)\s*$",
        text,
    )
    return values[-1] if values and values[-1] in allowed else default


def powershell_safe_markers(stderr):
    """Extract credential-free route/failure telemetry from the fixed script."""
    route = _last_allowlisted_marker(
        stderr,
        "NMS system proxy route:",
        SAFE_SYSTEM_PROXY_ROUTES,
    )
    reason = _last_allowlisted_marker(
        stderr,
        "NMS system proxy reason:",
        SAFE_TRANSPORT_REASONS,
    )
    return route, reason


def record_system_proxy_result(result):
    """Publish only allowlisted system-proxy route and reason enums."""
    global LAST_SYSTEM_PROXY_ROUTE, LAST_TRANSPORT_REASON
    route = str(result.get("proxyRoute") or "NOT_USED").strip().upper()
    reason = str(result.get("transportReason") or "NOT_USED").strip().upper()
    LAST_SYSTEM_PROXY_ROUTE = (
        route if route in SAFE_SYSTEM_PROXY_ROUTES else "NOT_USED"
    )
    LAST_TRANSPORT_REASON = (
        reason if reason in SAFE_TRANSPORT_REASONS else "UNCLASSIFIED"
    )
    print(f"NMS system proxy route: {LAST_SYSTEM_PROXY_ROUTE}")
    print(f"NMS transport reason: {LAST_TRANSPORT_REASON}")


def powershell_failure_message(result):
    """Describe a PowerShell result without echoing request/exception details."""
    status = result.get("status")
    return_code = result.get("returncode")
    reason = result.get("transportReason") or "UNCLASSIFIED"
    if return_code == 0 and isinstance(status, int):
        return f"NMS PowerShell HTTP request failed (HTTP {status:03d})"
    if return_code == 2:
        summary = "transport compatibility"
    else:
        summary = f"transport {reason}"
    return f"NMS PowerShell HTTP request failed ({summary})"


def powershell_http_request(
    powershell_path,
    method,
    url,
    headers=None,
    body=None,
    *,
    request_stage=None,
):
    """Use bounded verified-TLS Windows HttpClient attempts and fail closed."""
    request_stage = resolve_request_stage(request_stage, method, url)
    for attempt in range(1, POWERSHELL_MAX_RETRIES + 1):
        try:
            result = run_powershell_attempt(
                powershell_path,
                method,
                url,
                headers,
                body,
                request_stage=request_stage,
            )
        except OSError as error:
            raise NmsTransportError(
                "NMS PowerShell HTTP request failed "
                "(process launch error): no diagnostic text"
            ) from error
        record_system_proxy_result(result)
        if curl_result_is_success(result):
            return result["body"]

        transient = (
            result.get("status") in TRANSIENT_HTTP_STATUS_CODES
            or (
                result.get("returncode") == 28
                and request_stage != "NOTAMS"
            )
        )
        if transient and attempt < POWERSHELL_MAX_RETRIES:
            wait = retry_wait_seconds(attempt)
            print(
                "Transient NMS PowerShell HTTP failure "
                f"(attempt {attempt}/{POWERSHELL_MAX_RETRIES}). "
                f"Waiting {wait:.1f} sec then retrying..."
            )
            time.sleep(wait)
            continue

        # PowerShell's own script maps network/TLS/timeouts to deliberate exit
        # codes. Only command-line compatibility (the PRIMARY's observed exit
        # 2) or a successful process with malformed framing may cross again.
        # Exhausted timeouts and every security/HTTP failure remain terminal.
        powershell_compatibility_failure = (
            result.get("returncode") == 2
            and result.get("status") is None
            and result.get("transportReason") == "NOT_USED"
        )
        powershell_framing_failure = (
            result.get("returncode") == 0
            and not isinstance(result.get("status"), int)
        )
        if (
            powershell_compatibility_failure
            or powershell_framing_failure
        ):
            error_type = (
                NmsCompatibilityError
                if powershell_compatibility_failure
                else NmsTransportError
            )
            raise error_type(powershell_failure_message(result))

        raise RuntimeError(powershell_failure_message(result))

    raise RuntimeError("NMS PowerShell HTTP request failed after bounded retries.")


PYTHON_CHILD_HTTP_SCRIPT = r"""
import base64
import http.client
import json
import re
import socket
import ssl
import sys
from urllib.parse import urlsplit

STATUS_MARKER = __STATUS_MARKER__
TOTAL_TIMEOUT_SECONDS = __TOTAL_TIMEOUT_SECONDS__
RESPONSE_LIMIT_BYTES = __RESPONSE_LIMIT_BYTES__
ALLOWED_HOST = "api-staging.cgifederal-aim.com"


def fail(category, returncode):
    # Emit a fixed credential-free enum, never exception/request text.
    sys.stderr.write("NMS Python child error: " + category + "\n")
    sys.stderr.flush()
    raise SystemExit(returncode)


try:
    raw_request = sys.stdin.buffer.read(RESPONSE_LIMIT_BYTES + 1)
    if len(raw_request) > RESPONSE_LIMIT_BYTES:
        fail("REQUEST_TOO_LARGE", 1)
    request = json.loads(raw_request.decode("utf-8"))
    method = str(request.get("method") or "").strip().upper()
    if method not in {"GET", "POST"}:
        fail("INVALID_METHOD", 1)

    parsed = urlsplit(str(request.get("url") or ""))
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() != ALLOWED_HOST
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.port not in (None, 443)
    ):
        fail("INVALID_DESTINATION", 1)

    headers = request.get("headers") or {}
    if not isinstance(headers, dict):
        fail("INVALID_HEADERS", 1)
    normalized_headers = {}
    for raw_name, raw_value in headers.items():
        name = str(raw_name).strip()
        value = str(raw_value)
        if (
            not re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+", name)
            or any(character in value for character in ("\x00", "\r", "\n"))
            or name.casefold() in {
                "connection",
                "content-length",
                "host",
                "proxy-authorization",
                "transfer-encoding",
            }
        ):
            fail("INVALID_HEADERS", 1)
        normalized_headers[name] = value

    has_body = bool(request.get("hasBody"))
    body = base64.b64decode(
        str(request.get("bodyBase64") or ""),
        validate=True,
    ) if has_body else None
    if body is not None and body != b"grant_type=client_credentials":
        fail("INVALID_BODY", 1)

    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    if hasattr(ssl, "TLSVersion"):
        context.minimum_version = ssl.TLSVersion.TLSv1_2

    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    connection = http.client.HTTPSConnection(
        parsed.hostname,
        port=parsed.port or 443,
        timeout=TOTAL_TIMEOUT_SECONDS,
        context=context,
    )
    try:
        connection.request(method, target, body=body, headers=normalized_headers)
        response = connection.getresponse()
        response_body = response.read(RESPONSE_LIMIT_BYTES + 1)
        if len(response_body) > RESPONSE_LIMIT_BYTES:
            fail("RESPONSE_TOO_LARGE", 1)
        status = int(response.status)
    finally:
        connection.close()

    output = sys.stdout.buffer
    if response_body:
        output.write(response_body)
    output.write(("\n" + STATUS_MARKER + "%03d\n" % status).encode("ascii"))
    output.flush()
except SystemExit:
    raise
except ssl.SSLCertVerificationError:
    fail("TLS_CERTIFICATE", 60)
except ssl.SSLError:
    fail("TLS_SECURITY", 35)
except (socket.timeout, TimeoutError):
    fail("TIMEOUT", 28)
except socket.gaierror:
    fail("DNS", 6)
except (ConnectionError, OSError):
    fail("CONNECTION", 7)
except (ValueError, TypeError, KeyError, json.JSONDecodeError):
    fail("INVALID_REQUEST", 1)
except BaseException:
    fail("UNCLASSIFIED", 1)
"""


def current_python_executable_path():
    """Resolve this runtime's pinned launcher without consulting PATH."""
    candidate = os.path.realpath(sys.executable)
    if os.path.isabs(candidate) and os.path.isfile(candidate):
        return candidate
    raise OSError("current Python interpreter has no pinned absolute launcher")


def python_child_request_command():
    """Build an isolated command using only this runtime's pinned launcher."""
    python_path = current_python_executable_path()
    child_script = (
        PYTHON_CHILD_HTTP_SCRIPT
        .replace("__STATUS_MARKER__", repr(CURL_HTTP_STATUS_MARKER))
        .replace(
            "__TOTAL_TIMEOUT_SECONDS__",
            repr(PYTHON_CHILD_TOTAL_TIMEOUT_SECONDS),
        )
        .replace(
            "__RESPONSE_LIMIT_BYTES__",
            repr(PYTHON_CHILD_RESPONSE_LIMIT_BYTES),
        )
    )
    return [python_path, "-I", "-u", "-c", child_script]


def _python_child_body_alias(body, data):
    """Resolve the urllib-style data alias without accepting ambiguity."""
    if data is None:
        return body
    if body is not None:
        body_bytes = body if isinstance(body, bytes) else str(body).encode("utf-8")
        data_bytes = data if isinstance(data, bytes) else str(data).encode("utf-8")
        if body_bytes != data_bytes:
            raise ValueError("body and data specify different request payloads")
    return data


def python_child_request_stdin(
    method,
    url,
    headers=None,
    body=None,
    *,
    data=None,
):
    """Serialize one validated NMS request only to isolated child stdin."""
    body = _python_child_body_alias(body, data)
    normalized_method = str(method or "GET").strip().upper()
    if normalized_method not in {"GET", "POST"}:
        raise ValueError("invalid HTTP method")
    if not str(url).lower().startswith("https://"):
        raise ValueError("NMS Python child transport requires HTTPS")

    body_bytes = None
    if body is not None:
        body_bytes = body if isinstance(body, bytes) else str(body).encode("utf-8")
        if body_bytes != b"grant_type=client_credentials":
            raise ValueError("unexpected NMS Python child request body")

    payload = {
        "method": normalized_method,
        "url": str(url),
        "headers": validated_http_headers(headers),
        "hasBody": body_bytes is not None,
        "bodyBase64": base64.b64encode(body_bytes or b"").decode("ascii"),
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def run_python_child_attempt(
    method,
    url,
    headers=None,
    body=None,
    *,
    data=None,
):
    """Run one hard-bounded verified-TLS request in an isolated Python child."""
    command = python_child_request_command()
    request_input = python_child_request_stdin(
        method,
        url,
        headers,
        body,
        data=data,
    )
    child_environment = os.environ.copy()
    for name in tuple(child_environment):
        normalized_name = name.upper()
        if normalized_name in {"NMS_CLIENT_ID", "NMS_CLIENT_SECRET"} or normalized_name.startswith("PYTHON"):
            child_environment.pop(name, None)

    try:
        completed = run_bounded_transport_process(
            command,
            input=request_input,
            timeout=PYTHON_CHILD_PROCESS_TIMEOUT_SECONDS,
            env=child_environment,
        )
    except subprocess.TimeoutExpired:
        return {
            "returncode": 28,
            "status": None,
            "body": b"",
            "diagnostic": "Python child HTTP process exceeded its hard timeout",
        }

    status, response_body = split_curl_response(completed.stdout)
    return {
        "returncode": completed.returncode,
        "status": status,
        "body": response_body,
        "diagnostic": curl_diagnostics(completed.stderr, headers),
        "httpBodyDiagnostic": (
            curl_http_body_diagnostic(response_body, headers)
            if completed.returncode == 0 and status is not None
            else ""
        ),
    }


def python_child_http_request(
    method,
    url,
    headers=None,
    body=None,
    timeout=45,
    *,
    data=None,
):
    """Use the isolated verified-TLS Python child as the final Windows path."""
    del timeout  # The child/native and parent-enforced limits are fixed safety caps.
    body = _python_child_body_alias(body, data)
    for attempt in range(1, PYTHON_CHILD_MAX_RETRIES + 1):
        try:
            result = run_python_child_attempt(
                method,
                url,
                headers,
                body,
            )
        except OSError as error:
            raise RuntimeError(
                "NMS Python child request failed "
                "(process launch error): no diagnostic text"
            ) from error
        if curl_result_is_success(result):
            return result["body"]

        transient = (
            result.get("status") in TRANSIENT_HTTP_STATUS_CODES
            or result.get("returncode") in {6, 7, 28}
        )
        if transient and attempt < PYTHON_CHILD_MAX_RETRIES:
            wait = retry_wait_seconds(attempt)
            print(
                "Transient NMS Python child HTTP failure "
                f"(attempt {attempt}/{PYTHON_CHILD_MAX_RETRIES}). "
                f"Waiting {wait:.1f} sec then retrying..."
            )
            time.sleep(wait)
            continue

        raise RuntimeError(
            curl_failure_message(result).replace(
                "NMS curl",
                "NMS Python child HTTP",
            )
        )

    raise RuntimeError("NMS Python child HTTP request failed after bounded retries.")


class NmsNoRedirectHandler(HTTPRedirectHandler):
    """Keep NMS authorization requests on the exact validated origin."""

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        del request, file_pointer, code, message, headers, new_url
        return None


def python_runtime_http_request(
    method,
    url,
    headers=None,
    body=None,
    timeout=45,
    *,
    data=None,
):
    """Use this already-bounded helper runtime for verified NMS HTTPS.

    The updater owns this helper process with a hard 300-second parent timeout, so
    no second Python launcher is needed.  That avoids both loader/runtime failures
    and transport timeouts observed in nested ``python.exe`` attempts.
    """
    del timeout  # Fixed native timeout plus the updater's hard helper boundary.
    body = _python_child_body_alias(body, data)
    normalized_method = str(method or "GET").strip().upper()
    if normalized_method not in {"GET", "POST"}:
        raise ValueError("invalid HTTP method")

    parsed = urlsplit(str(url or ""))
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() != NMS_API_HOST
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.port not in (None, 443)
    ):
        raise ValueError("invalid NMS Python runtime destination")

    normalized_headers = validated_http_headers(headers)
    prohibited_headers = {
        "connection",
        "content-length",
        "host",
        "proxy-authorization",
        "transfer-encoding",
    }
    if any(name.casefold() in prohibited_headers for name in normalized_headers):
        raise ValueError("invalid NMS Python runtime headers")

    body_bytes = None
    if body is not None:
        body_bytes = body if isinstance(body, bytes) else str(body).encode("utf-8")
        if body_bytes != b"grant_type=client_credentials":
            raise ValueError("unexpected NMS Python runtime request body")

    for attempt in range(1, PYTHON_RUNTIME_MAX_RETRIES + 1):
        transport_error = None
        transport_cause = None
        response_body = b""
        status = None
        context = ssl.create_default_context()
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        if hasattr(ssl, "TLSVersion"):
            context.minimum_version = ssl.TLSVersion.TLSv1_2

        request = Request(
            url=str(url),
            data=body_bytes,
            headers=normalized_headers,
            method=normalized_method,
        )
        opener = build_opener(
            ProxyHandler(),
            HTTPSHandler(context=context),
            NmsNoRedirectHandler(),
        )
        try:
            with opener.open(
                request,
                timeout=PYTHON_RUNTIME_TOTAL_TIMEOUT_SECONDS,
            ) as response:
                response_body = response.read(PYTHON_RUNTIME_RESPONSE_LIMIT_BYTES + 1)
                status = int(response.getcode())
        except HTTPError as error:
            response_body = error.read(PYTHON_RUNTIME_RESPONSE_LIMIT_BYTES + 1)
            status = int(error.code)
        except ssl.SSLCertVerificationError as error:
            raise RuntimeError(
                "NMS Python runtime HTTPS failed (TLS certificate verification)"
            ) from None
        except ssl.SSLError as error:
            raise RuntimeError(
                "NMS Python runtime HTTPS failed (TLS security)"
            ) from None
        except socket.gaierror as error:
            transport_error = NmsTransportError(
                "NMS Python runtime HTTPS failed (DNS unavailable)"
            )
            transport_cause = error
        except (socket.timeout, TimeoutError) as error:
            transport_error = NmsTransportError(
                "NMS Python runtime HTTPS failed (timed out)"
            )
            transport_cause = error
        except URLError as error:
            reason = getattr(error, "reason", None)
            if isinstance(reason, ssl.SSLCertVerificationError):
                raise RuntimeError(
                    "NMS Python runtime HTTPS failed (TLS certificate verification)"
                ) from error
            if isinstance(reason, ssl.SSLError):
                raise RuntimeError(
                    "NMS Python runtime HTTPS failed (TLS security)"
                ) from error
            transport_error = NmsTransportError(
                "NMS Python runtime HTTPS failed (system route unavailable)"
            )
            transport_cause = error
        except (ConnectionError, OSError) as error:
            transport_error = NmsTransportError(
                "NMS Python runtime HTTPS failed (connection unavailable)"
            )
            transport_cause = error
        if status is not None:
            if len(response_body) > PYTHON_RUNTIME_RESPONSE_LIMIT_BYTES:
                raise RuntimeError("NMS Python runtime HTTPS response is too large")
            if 200 <= status < 300:
                return response_body
            if status in TRANSIENT_HTTP_STATUS_CODES and attempt < PYTHON_RUNTIME_MAX_RETRIES:
                wait = retry_wait_seconds(attempt)
                print(
                    "Transient NMS Python runtime HTTP failure "
                    f"(attempt {attempt}/{PYTHON_RUNTIME_MAX_RETRIES}). "
                    f"Waiting {wait:.1f} sec then retrying..."
                )
                time.sleep(wait)
                continue
            diagnostic = curl_http_body_diagnostic(response_body, normalized_headers)
            detail = diagnostic or "no diagnostic text"
            raise RuntimeError(
                f"NMS Python runtime HTTP request failed (HTTP {status:03d}): {detail}"
            )
        if attempt < PYTHON_RUNTIME_MAX_RETRIES:
            wait = retry_wait_seconds(attempt)
            print(
                "Transient NMS Python runtime transport failure "
                f"(attempt {attempt}/{PYTHON_RUNTIME_MAX_RETRIES}). "
                f"Waiting {wait:.1f} sec then retrying..."
            )
            time.sleep(wait)
            continue
        raise transport_error from None

    raise NmsTransportError(
        "NMS Python runtime HTTPS failed after bounded retries"
    )


def record_http_transport(name):
    """Emit only a safe enum so partial timeout logs identify the chosen path."""
    global LAST_HTTP_TRANSPORT
    LAST_HTTP_TRANSPORT = name
    print(f"NMS HTTP transport: {name}")


def record_request_stage(name):
    """Record only the current allowlisted NMS request stage."""
    global LAST_REQUEST_STAGE, LAST_SYSTEM_PROXY_ROUTE, LAST_TRANSPORT_REASON
    normalized = str(name or "NOT_USED").strip().upper()
    LAST_REQUEST_STAGE = (
        normalized if normalized in SAFE_REQUEST_STAGES else "NOT_USED"
    )
    LAST_SYSTEM_PROXY_ROUTE = "NOT_USED"
    LAST_TRANSPORT_REASON = "NOT_USED"
    print(f"NMS request stage: {LAST_REQUEST_STAGE}")
    print("NMS system proxy route: NOT_USED")
    print("NMS transport reason: NOT_USED")


def http_request(
    method,
    url,
    headers=None,
    body=None,
    timeout=45,
    *,
    request_stage=None,
):
    """Select bounded verified Windows transports, then portable urllib."""
    request_stage = resolve_request_stage(request_stage, method, url)
    curl_path = windows_curl_path()
    if curl_path:
        record_http_transport("WINDOWS_CURL")
        try:
            return curl_http_request(
                curl_path,
                method,
                url,
                headers,
                body,
                request_stage=request_stage,
            )
        except NmsTransportError:
            # Curl produced no completed HTTP response. Use the checked-in
            # Windows system-proxy route so the interactive PRIMARY task can
            # honor its Internet Options/PAC and proxy credentials.
            powershell_path = windows_powershell_path()
            if powershell_path:
                record_http_transport("WINDOWS_CURL_TO_POWERSHELL")
                return powershell_http_request(
                    powershell_path,
                    method,
                    url,
                    headers,
                    body,
                    request_stage=request_stage,
                )

            record_http_transport("WINDOWS_NO_TRUSTED_TRANSPORT")
            raise NmsTransportError(
                "NMS Windows HTTPS failed (no trusted bounded fallback)"
            ) from None

    powershell_path = windows_powershell_path()
    if powershell_path:
        record_http_transport("WINDOWS_POWERSHELL")
        return powershell_http_request(
            powershell_path,
            method,
            url,
            headers,
            body,
            request_stage=request_stage,
        )

    if os.name == "nt":
        record_http_transport("WINDOWS_NO_TRUSTED_TRANSPORT")
        raise NmsTransportError(
            "NMS Windows HTTPS failed (no trusted bounded transport)"
        ) from None

    record_http_transport("PORTABLE_URLLIB")
    return urllib_http_request(
        method,
        url,
        headers,
        body,
        timeout,
        request_stage=request_stage,
    )


def get_token(client_id, client_secret):
    record_request_stage("TOKEN")
    auth = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")

    raw = http_request(
        "POST",
        AUTH_URL,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body=b"grant_type=client_credentials",
        request_stage="TOKEN",
    )

    data = json.loads(raw.decode("utf-8"))
    token = data.get("access_token")

    if not token:
        raise RuntimeError(f"Token response missing access_token: {data}")

    print(f"NMS token OK. status={data.get('status')}; expires_in={data.get('expires_in')} sec")
    return token


def nms_get_json(path, token, query=None, response_format=None):
    record_request_stage("NOTAMS")
    url = BASE_URL + path

    if query:
        url += "?" + urlencode(query)

    headers = {"Authorization": f"Bearer {token}"}

    if response_format:
        headers["nmsResponseFormat"] = response_format

    raw = http_request(
        "GET",
        url,
        headers=headers,
        request_stage="NOTAMS",
    )
    return json.loads(raw.decode("utf-8", errors="replace"))


def parse_xml(xml_text):
    return ET.fromstring(xml_text)


def elems(root, local_name):
    for elem in root.iter():
        if elem.tag.endswith("}" + local_name) or elem.tag == local_name:
            yield elem


def first_text(root, local_name):
    for elem in elems(root, local_name):
        if elem.text and elem.text.strip():
            return elem.text.strip()
    return None


def all_text(root, local_name):
    vals = []

    for elem in elems(root, local_name):
        if elem.text and elem.text.strip():
            vals.append(elem.text.strip())

    return vals


def extract_notam_number(root, fallback):
    series = first_text(root, "series")
    number = first_text(root, "number")
    year = first_text(root, "year")

    if series and number and year:
        if series.upper() == "M":
            return f"M{int(number):04d}/{str(year)[-2:]}"
        return f"{series}{number}/{str(year)[-2:]}"

    return fallback


def canonical_bulk_classification(root):
    """Return the stable NMS bulk class without guessing at unknown values."""
    classifications = all_text(root, "classification")

    if not classifications:
        raise RuntimeError("NMS bulk AIXM record is missing classification.")

    value = re.sub(r"[^A-Z]", "", classifications[-1].upper())
    classification = BULK_CLASSIFICATION_ALIASES.get(value)

    if not classification:
        raise RuntimeError(
            f"NMS bulk AIXM record has unsupported classification: {classifications[-1]!r}"
        )

    return classification


def canonical_bulk_notam_number(value):
    """Canonicalize operational and four-digit FDC local-style identifiers."""
    canonical = canonical_notam_number(value)

    if canonical:
        return canonical

    match = re.search(r"\b(\d{1,2})\s*/\s*(\d{4})\b", str(value or ""))
    return f"{int(match.group(1)):02d}/{match.group(2)}" if match else ""


def extract_bulk_notam_number(root, classification):
    """Resolve the record identifier without mistaking an action target for it."""
    # Domestic and FDC bulk AIXM omit the structured number fields.  Their own
    # identifier is the token immediately after the leading ``!MEM``/``!FDC`` in
    # simpleText.  The strict anchor prevents a later NOTAMC/NOTAMR target or a
    # date in the body from being mistaken for the current record number.
    if classification in {"DOM", "FDC"}:
        simple = first_text(root, "simpleText") or ""
        match = BULK_SIMPLE_NUMBER_RE.match(simple)

        if match:
            return f"{int(match.group(1)):02d}/{match.group(2)}"

        raise RuntimeError(
            f"NMS bulk {classification} AIXM record has no anchored local NOTAM number."
        )

    structured = canonical_bulk_notam_number(extract_notam_number(root, ""))

    if structured:
        return structured

    raise RuntimeError(
        f"NMS bulk {classification} AIXM record has no resolvable own NOTAM number."
    )


def extract_event_text(root):
    txt = first_text(root, "text")

    if txt:
        return re.sub(r"\s+", " ", txt).strip()

    simple = first_text(root, "simpleText")

    if simple and simple.upper() != "NOT AVAILABLE":
        return re.sub(r"\s+", " ", simple).strip()

    formatted = first_text(root, "formattedText")

    if formatted:
        cleaned = html.unescape(formatted)
        cleaned = re.sub(r"<[^>]+>", " ", cleaned)
        return re.sub(r"\s+", " ", cleaned).strip()

    return "TEXT NOT FOUND"


def severity(text):
    t = text.upper()

    if "ARFF STATUS RED" in t:
        return "red"

    if ("RWY" in t and ("CLSD" in t or "CLOSED" in t)) or "ARFF" in t:
        return "red"

    if any(k in t for k in ["INOP", "U/S", "DSN", "COMM", "MIL RAMP", "ILS", "PAPI", "RVR"]):
        return "amber"

    return "green"


def display_text(text):
    t = re.sub(r"\s+", " ", text.strip())
    t = t.replace("MIL RAMP MIL RAMP", "MIL RAMP")
    t = t.replace("UNTIL FURTHER NOTICE", "UFN")

    return t if len(t) <= 150 else t[:147].rstrip() + "..."


NOTAMC_RE = re.compile(r"\bNOTAM\s*C\b", re.IGNORECASE)
NOTAMC_TARGET_RE = re.compile(
    r"\bNOTAM\s*C\b\s*(?:OF\s+)?"
    r"((?:[A-Z]\s*\d{1,4}\s*/\s*\d{2})|(?:\d{1,2}\s*/\s*\d{3}))\b",
    re.IGNORECASE,
)
NOTAMR_RE = re.compile(r"\bNOTAM\s*R\b", re.IGNORECASE)
NOTAMR_TARGET_RE = re.compile(
    r"\bNOTAM\s*R\b\s*(?:OF\s+)?"
    r"((?:[A-Z]\s*\d{1,4}\s*/\s*\d{2})|(?:\d{1,2}\s*/\s*\d{3}))\b",
    re.IGNORECASE,
)
NOTAM_SERIES_NUMBER_RE = re.compile(
    r"\b([A-Z])\s*(\d{1,4})\s*/\s*(\d{2})\b",
    re.IGNORECASE,
)
NOTAM_LOCAL_NUMBER_RE = re.compile(r"\b(\d{1,2})\s*/\s*(\d{3})\b")


def canonical_notam_number(value):
    """Return a comparable M0030/26 or local 08/368 identifier."""
    text = str(value or "").upper()
    match = NOTAM_SERIES_NUMBER_RE.search(text)

    if match:
        return f"{match.group(1).upper()}{int(match.group(2)):04d}/{match.group(3)}"

    match = NOTAM_LOCAL_NUMBER_RE.search(text)

    if not match:
        return ""

    return f"{int(match.group(1)):02d}/{match.group(2)}"


def notam_record_text(record):
    if not isinstance(record, dict):
        return str(record or "")

    return " ".join(
        str(record.get(key) or "")
        for key in (
            "rawText", "fullText", "notamText", "text", "displayText",
            "message", "body", "description", "plainLanguage",
        )
    ).strip()


def is_notam_cancellation(record):
    """True when the record is a NOTAMC cancellation message."""
    if isinstance(record, dict):
        type_value = str(
            record.get("notamType")
            or record.get("action")
            or record.get("operation")
            or ""
        ).strip().upper()

        if type_value in {"C", "NOTAMC", "CANCEL", "CANCELED", "CANCELLED", "CANCELLATION"}:
            return True

    return bool(NOTAMC_RE.search(notam_record_text(record)))


def notam_cancellation_target(record):
    """Return the NOTAM identifier named immediately after NOTAMC, if present."""
    if isinstance(record, dict):
        for key in (
            "cancelsNotam", "cancelledNotam", "canceledNotam",
            "cancellationTarget", "cancelTarget",
        ):
            target = canonical_notam_number(record.get(key))
            if target:
                return target

    match = NOTAMC_TARGET_RE.search(notam_record_text(record))

    if not match:
        return ""

    return canonical_notam_number(match.group(1))


def is_notam_replacement(record):
    """True when the record is a NOTAMR replacement message."""
    if isinstance(record, dict):
        type_value = str(
            record.get("notamType")
            or record.get("action")
            or record.get("operation")
            or ""
        ).strip().upper()

        if type_value in {"R", "NOTAMR", "REPLACE", "REPLACED", "REPLACEMENT"}:
            return True

    return bool(NOTAMR_RE.search(notam_record_text(record)))


def notam_replacement_target(record):
    """Return the NOTAM identifier named immediately after NOTAMR, if present."""
    if isinstance(record, dict):
        for key in (
            "replacesNotam", "replacedNotam", "replacementTarget",
            "replaceTarget", "previousNotam",
        ):
            target = canonical_notam_number(record.get(key))
            if target:
                return target

    match = NOTAMR_TARGET_RE.search(notam_record_text(record))

    if not match:
        return ""

    return canonical_notam_number(match.group(1))


def notam_inactive_target(record):
    """Return the target made inactive by a NOTAMC or NOTAMR action."""
    return notam_cancellation_target(record) or notam_replacement_target(record)


def filter_inactive_notam_records(records, inactive_numbers=None):
    """Hide NOTAMC actions plus every cancelled or superseded record."""
    records = list(records or [])
    inactive = {
        canonical_notam_number(value)
        for value in (inactive_numbers or [])
        if canonical_notam_number(value)
    }

    for record in records:
        target = notam_inactive_target(record)
        if target:
            inactive.add(target)

    filtered = []

    for record in records:
        if is_notam_cancellation(record):
            continue

        number = canonical_notam_number(
            record.get("number") or record.get("id") or record.get("notamNumber")
            if isinstance(record, dict)
            else record
        )

        if number and number in inactive:
            continue

        filtered.append(record)

    return filtered




def is_runway_closure_text(text):
    """
    True runway closure only.

    Excludes taxiway-closure NOTAMs that merely mention a runway as a boundary, e.g.
    "TWY V BTN TWY V3 AND TWY S, TWY C BTN TWY V AND RWY 09/27 CLSD".
    """
    compact = re.sub(r"\s+", " ", str(text or "").upper()).strip()

    if not compact:
        return False

    # Check each sentence/segment independently.
    segments = [s.strip() for s in re.split(r"\.\s+|;\s+", compact) if s.strip()]

    for segment in segments:
        if "CLSD" not in segment and "CLOSED" not in segment:
            continue

        # If this segment is explicitly a taxiway closure, do not treat it as runway
        # closure just because it says "AND RWY 09/27".
        first_twy = segment.find("TWY")
        first_rwy = segment.find("RWY")

        if first_twy != -1 and (first_rwy == -1 or first_twy < first_rwy):
            continue

        # Require the closure object to be a runway/rwy expression.
        if re.search(r"^\s*RWY\s+\d{1,2}[LCR]?(?:\s*/\s*\d{1,2}[LCR]?|\s*,\s*\d{1,2}[LCR]?)*\s+(?:CLSD|CLOSED)\b", segment):
            return True

        if re.search(r"\bRWY\s+\d{1,2}[LCR]?(?:\s*/\s*\d{1,2}[LCR]?|\s*,\s*\d{1,2}[LCR]?)*\s+(?:CLSD|CLOSED)\b", segment):
            # Accept if there is no taxiway before the runway expression.
            rwy_match = re.search(r"\bRWY\s+\d{1,2}[LCR]?(?:\s*/\s*\d{1,2}[LCR]?|\s*,\s*\d{1,2}[LCR]?)*\s+(?:CLSD|CLOSED)\b", segment)
            if rwy_match and ("TWY" not in segment[:rwy_match.start()]):
                return True

    return False


def is_runway_closure_candidate(item):
    blob = " ".join(str(item.get(k, "")) for k in item.keys()).upper()
    compact = re.sub(r"\s+", " ", blob).strip()

    # Candidate only if metadata/text likely starts with a runway closure.
    # This intentionally avoids TWY closures that mention a runway as a boundary.
    return (
        bool(re.search(r"\bRWY\s+\d{1,2}[LCR]?(?:\s*/\s*\d{1,2}[LCR]?|\s*,\s*\d{1,2}[LCR]?)*\s+(?:CLSD|CLOSED)\b", compact))
        or str(item.get("type", "")).upper() in ("RUNWAY", "RWY")
    )


def clean_created_text(text):
    return re.sub(r"\s*CREATED:\s*.*$", "", str(text or ""), flags=re.I).strip()


def compact_runway_closure_display(text):
    raw = re.sub(r"\s+", " ", clean_created_text(text)).strip()
    segments = [s.strip() for s in re.split(r"\.\s+|;\s+", raw) if s.strip()]

    for segment in segments:
        segment_upper = segment.upper()

        if "CLSD" not in segment_upper and "CLOSED" not in segment_upper:
            continue

        first_twy = segment_upper.find("TWY")
        first_rwy = segment_upper.find("RWY")

        # Exclude taxiway closures that mention a runway as a boundary.
        if first_twy != -1 and (first_rwy == -1 or first_twy < first_rwy):
            continue

        match = re.search(r"\bRWY\s+\d{1,2}[LCR]?(?:\s*/\s*\d{1,2}[LCR]?|\s*,\s*\d{1,2}[LCR]?)*\s+(?:CLSD|CLOSED)\b", segment, flags=re.I)
        if match:
            return re.sub(r"\s+", " ", match.group(0)).strip()

    return ""


def is_construction_status_text(text):
    compact = re.sub(r"\s+", " ", str(text or "").upper()).strip()

    if not compact:
        return False

    if "FICON" in compact:
        return False

    status_terms = [
        " WIP ",
        " WORK IN PROGRESS",
        " CONSTRUCTION",
        " CONST ",
        " MAINT",
        " MAINTENANCE",
        " MARKING",
        " MARKINGS",
        " MOWING",
        " SPRAYING",
        " WEEDING",
        " REPAIR",
        " PAVEMENT WORK",
        " WORK AREA"
    ]

    padded = f" {compact} "
    return any(term in padded for term in status_terms)


def is_taxi_route_restriction_text(text):
    compact = re.sub(r"\s+", " ", str(text or "").upper()).strip()

    if not compact:
        return False

    if "FICON" in compact:
        return False

    surface_hit = re.search(r"\b(TWY|TAXIWAY|TAXILANE|RAMP|APRON|GATE|MOVEMENT AREA|MOVEMENT-AREA)\b", compact)
    restriction_hit = re.search(r"\b(CLSD|CLOSED|RESTRICT|RESTRICTED|RESTR|UNAVBL|NOT AVBL|TAXI ROUTE|ROUTE)\b", compact)

    if not surface_hit or not restriction_hit:
        return False

    # Runway closures are handled in their own section.
    if is_runway_closure_text(compact) and not re.search(r"\b(TWY|TAXIWAY|TAXILANE|RAMP|APRON|GATE)\b", compact):
        return False

    return True


def status_record(record, classification):
    item = dict(record)
    item["classification"] = classification
    item["rawText"] = item.get("rawText") or item.get("text") or ""
    return item


def normalize_notam_effective_compact(value):
    """
    Keep backend effective fields compact but consistent for display.
    Accepts:
      202604221406
      2604221406
      08 JUN 13:00 2026
      UFN / UNTIL FURTHER NOTICE
    Returns a compact string that index.html can render nicely.
    """
    if value is None:
        return ""

    text = str(value).strip().upper()

    if not text:
        return ""

    if text in ("UFN", "FURTHER NOTICE", "UNTIL FURTHER NOTICE"):
        return "UFN"

    # 08 JUN 13:00 2026 -> 08 JUN 1300Z
    m = re.search(r"\b(\d{1,2})\s+([A-Z]{3})\s+(\d{2}):(\d{2})\s+(\d{4})\b", text)
    if m:
        return f"{int(m.group(1)):02d} {m.group(2)} {m.group(3)}{m.group(4)}Z"

    # Already close enough: 08 JUN 1300Z
    m = re.search(r"\b(\d{1,2})\s+([A-Z]{3})\s+(\d{4})Z?\b", text)
    if m:
        return f"{int(m.group(1)):02d} {m.group(2)} {m.group(3)}Z"

    # 202604221406 or 2604221406; keep numeric for index display parser.
    m = re.search(r"\b(\d{12}|\d{10})\b", text)
    if m:
        return m.group(1)

    return text


def effective_range_from_text(text):
    """
    Extract effective start/end from full DAIP/NMS text when effectiveStart/effectiveEnd
    XML fields are missing.
    """
    raw = re.sub(r"\s+", " ", str(text or "")).strip().upper()

    if not raw:
        return "", ""

    # DAIP/PDF style: 08 JUN 13:00 2026 UNTIL 08 JUN 22:00 2026
    m = re.search(
        r"\b(\d{1,2}\s+[A-Z]{3}\s+\d{2}:\d{2}\s+\d{4})\s+UNTIL\s+"
        r"(\d{1,2}\s+[A-Z]{3}\s+\d{2}:\d{2}\s+\d{4}|UFN|FURTHER NOTICE|UNTIL FURTHER NOTICE)\b",
        raw
    )
    if m:
        return normalize_notam_effective_compact(m.group(1)), normalize_notam_effective_compact(m.group(2))

    # NMS compact style: 2606081300-2606082200 or 202606081300-202606082200
    m = re.search(r"\b(\d{10}|\d{12})\s*-\s*(\d{10}|\d{12}|UFN)\b", raw)
    if m:
        return normalize_notam_effective_compact(m.group(1)), normalize_notam_effective_compact(m.group(2))

    # UNTIL only fallback; leave start blank.
    m = re.search(
        r"\bUNTIL\s+(\d{1,2}\s+[A-Z]{3}\s+\d{2}:\d{2}\s+\d{4}|UFN|FURTHER NOTICE|UNTIL FURTHER NOTICE)\b",
        raw
    )
    if m:
        return "", normalize_notam_effective_compact(m.group(1))

    return "", ""


def apply_effective_fallback(record, txt):
    """
    Fill missing effectiveStart/effectiveEnd from NOTAM text. Keeps existing XML values
    when they are already provided.
    """
    start, end = effective_range_from_text(txt)

    if not record.get("effectiveStart") and start:
        record["effectiveStart"] = start

    if not record.get("effectiveEnd") and end:
        record["effectiveEnd"] = end

    return record


def validated_bulk_aixm_roots(response):
    """Validate a complete one-page location response and parse every AIXM item."""
    if not isinstance(response, dict) or str(response.get("status", "")).upper() != "SUCCESS":
        raise RuntimeError("NMS bulk location response did not report Success.")

    data = response.get("data")

    if not isinstance(data, dict):
        raise RuntimeError("NMS bulk location response is missing its data object.")

    aixm_list = data.get("aixm")

    if not isinstance(aixm_list, list) or not aixm_list:
        raise RuntimeError("NMS bulk location response has no complete AIXM list.")

    # The live location response is deliberately one unpaginated AIXM collection.
    # Refuse an incomplete page instead of publishing a plausible-looking subset.
    for container in (response, data):
        for key, value in container.items():
            normalized_key = re.sub(r"[^a-z]", "", str(key).lower())

            if normalized_key in BULK_CONTINUATION_KEYS and value:
                raise RuntimeError("NMS bulk location response requires pagination.")

            if normalized_key in BULK_TOTAL_KEYS:
                try:
                    advertised_total = int(value)
                except (TypeError, ValueError):
                    continue

                if advertised_total > len(aixm_list):
                    raise RuntimeError("NMS bulk location response is an incomplete page.")

    roots = []

    for index, xml_text in enumerate(aixm_list):
        if not isinstance(xml_text, str) or not xml_text.strip():
            raise RuntimeError(f"NMS bulk AIXM record {index} is empty or not text.")

        try:
            roots.append(parse_xml(xml_text))
        except ET.ParseError as exc:
            raise RuntimeError(f"NMS bulk AIXM record {index} is malformed XML.") from exc

    return roots


def bulk_record_from_root(root, classification):
    number = extract_bulk_notam_number(root, classification)
    txt = extract_event_text(root)

    if txt == "TEXT NOT FOUND":
        raise RuntimeError(f"NMS bulk record {number} has no usable event text.")

    classifications = all_text(root, "classification")
    last_updates = all_text(root, "lastUpdated")
    record = {
        "number": number,
        "classification": classifications[-1],
        "severity": severity(txt),
        "text": txt,
        "displayText": display_text(txt),
        "effectiveStart": first_text(root, "effectiveStart"),
        "effectiveEnd": first_text(root, "effectiveEnd"),
        "lastUpdated": last_updates[-1] if last_updates else None,
        "source": "FAA_NMS_STAGING",
    }
    return apply_effective_fallback(record, txt)


def bulk_semantic_signature(record):
    """Return the exact operational identity shared by DOM/INTL crossover views."""
    text = clean_created_text(record.get("text") or "")
    return (
        LOCATION,
        re.sub(r"\s+", " ", text).strip().upper(),
        normalize_notam_effective_compact(record.get("effectiveStart")),
        normalize_notam_effective_compact(record.get("effectiveEnd")),
    )


def preferred_bulk_record(records):
    """Prefer the local DOM representation, then the newest identical record."""
    preferred_rank = min(
        BULK_ALIAS_PREFERENCE.get(item[0], 2) for item in records
    )
    preferred = [
        item
        for item in records
        if BULK_ALIAS_PREFERENCE.get(item[0], 2) == preferred_rank
    ]
    return max(preferred, key=lambda item: str(item[1].get("lastUpdated") or ""))


def deduplicate_bulk_operational_records(records):
    """Collapse exact DOM/INTL aliases and return their number equivalence map."""
    by_number = {}
    duplicate_count = 0

    for classification, record in records:
        number = canonical_bulk_notam_number(record.get("number"))

        if not number:
            raise RuntimeError("NMS bulk response contains a record with no number.")

        signature = bulk_semantic_signature(record)
        prior = by_number.get(number)

        if prior:
            prior_classification, prior_record, prior_signature = prior

            if signature != prior_signature:
                raise RuntimeError(
                    f"NMS bulk response contains conflicting records for {number}."
                )

            by_number[number] = preferred_bulk_record(
                [(prior_classification, prior_record), (classification, record)]
            ) + (signature,)
            duplicate_count += 1
            continue

        by_number[number] = (classification, record, signature)

    unique_records = [
        (classification, record)
        for classification, record, _signature in by_number.values()
    ]
    semantic_groups = {}

    for classification, record in unique_records:
        if classification in BULK_ALIAS_CLASSIFICATIONS:
            semantic_groups.setdefault(bulk_semantic_signature(record), []).append(
                (classification, record)
            )

    alias_numbers = {}
    collapsed_numbers = set()

    for aliases in semantic_groups.values():
        domestic = [item for item in aliases if item[0] == "DOM"]
        international = [item for item in aliases if item[0] == "INTL"]

        if not domestic or not international:
            continue

        # More than one number from the same representation class with identical
        # text/times is ambiguous; do not guess that they are all crossover aliases.
        if len(domestic) != 1 or len(international) != 1:
            raise RuntimeError("NMS bulk response contains an ambiguous alias group.")

        numbers = {
            canonical_bulk_notam_number(item[1].get("number"))
            for item in aliases
        }
        for number in numbers:
            alias_numbers[number] = set(numbers)

        collapsed_numbers.add(
            canonical_bulk_notam_number(international[0][1].get("number"))
        )
        duplicate_count += 1

    deduplicated = [
        (classification, record)
        for classification, record in unique_records
        if canonical_bulk_notam_number(record.get("number")) not in collapsed_numbers
    ]
    return deduplicated, alias_numbers, duplicate_count


def expand_inactive_alias_numbers(inactive_numbers, alias_numbers):
    """Make an action against either crossover identifier suppress both views."""
    expanded = set()

    for value in inactive_numbers:
        number = canonical_bulk_notam_number(value)

        if number:
            expanded.add(number)
            expanded.update(alias_numbers.get(number, ()))

    return expanded


def local_number_key(item):
    number = str(item[1].get("number", "")) if isinstance(item, tuple) else str(item.get("number", ""))
    match = re.match(r"^(\d{1,2})/(\d{3})$", number)

    if not match:
        return (-1, -1)

    return (int(match.group(1)), int(match.group(2)))


def build_bulk_notam_result(response, generated_z=None):
    roots = validated_bulk_aixm_roots(response)
    complete_records = []

    # Build every returned record before selecting board categories.  A malformed
    # INTL or FDC record must not be silently skipped inside an otherwise plausible
    # Success response.
    for root in roots:
        classification = canonical_bulk_classification(root)
        complete_records.append(
            (classification, bulk_record_from_root(root, classification))
        )

    deduplicated_records, alias_numbers, alias_count = (
        deduplicate_bulk_operational_records(complete_records)
    )
    inactive_notam_numbers = set()

    # Collect every action from the complete response before filtering categories.
    # If an action targets either side of a DOM/INTL crossover pair, suppress both.
    for _classification, record in complete_records:
        if is_notam_cancellation(record):
            target = notam_cancellation_target(record)

            if target:
                inactive_notam_numbers.add(target)
                print(f"  Cancellation: {record['number']} cancels {target}")
            else:
                print(f"  Cancellation: {record['number']} has no parseable target")
        elif is_notam_replacement(record):
            target = notam_replacement_target(record)

            if target:
                inactive_notam_numbers.add(target)
                print(f"  Replacement: {record['number']} replaces {target}")
            else:
                print(f"  Replacement: {record['number']} has no parseable target")

    inactive_notam_numbers = expand_inactive_alias_numbers(
        inactive_notam_numbers,
        alias_numbers,
    )
    operational_records = [
        item
        for item in deduplicated_records
        if item[0] in BULK_OPERATIONAL_CLASSIFICATIONS
    ]
    operational_records.sort(key=local_number_key, reverse=True)

    notams = []
    ficon_notams = []
    runway_closure_notams = []
    construction_status_notams = []
    taxi_restriction_notams = []

    for classification, record in operational_records:
        txt = record["text"]

        if "FICON" in txt.upper():
            ficon_notams.append(record)

        if is_runway_closure_text(txt):
            closure_display = compact_runway_closure_display(txt)

            if closure_display:
                runway_record = dict(record)
                runway_record["classification"] = "RWY_CLOSURE"
                runway_record["severity"] = "red"
                runway_record["text"] = closure_display
                runway_record["displayText"] = closure_display
                runway_record["rawText"] = txt
                runway_closure_notams.append(runway_record)

        if is_construction_status_text(txt):
            construction_status_notams.append(status_record(record, "CONST_AFLD_STATUS"))

        if is_taxi_route_restriction_text(txt):
            taxi_restriction_notams.append(status_record(record, "TAXI_ROUTE_RESTR"))

        if classification == "MIL":
            notams.append(record)

    # Apply every action after the complete bulk scan, so cancellation/replacement
    # results remain independent of the API's record order.
    notams = filter_inactive_notam_records(notams, inactive_notam_numbers)
    ficon_notams = filter_inactive_notam_records(ficon_notams, inactive_notam_numbers)
    runway_closure_notams = filter_inactive_notam_records(runway_closure_notams, inactive_notam_numbers)
    construction_status_notams = filter_inactive_notam_records(construction_status_notams, inactive_notam_numbers)
    taxi_restriction_notams = filter_inactive_notam_records(taxi_restriction_notams, inactive_notam_numbers)

    return {
        "status": "Success",
        "generatedZ": generated_z or utc_now_z(),
        "location": LOCATION,
        "source": "FAA_NMS_STAGING",
        "httpTransport": LAST_HTTP_TRANSPORT,
        "processBoundary": LAST_PROCESS_BOUNDARY,
        "requestStage": LAST_REQUEST_STAGE,
        "systemProxyRoute": LAST_SYSTEM_PROXY_ROUTE,
        "transportReason": LAST_TRANSPORT_REASON,
        "milNotamCount": len(notams),
        "milNotamStatus": f"{len(notams)} ACTIVE" if notams else "NONE ACTIVE",
        "milNotamScrollText": "  |  ".join(
            f"{item['number']} {item['displayText']}" for item in notams
        ),
        "milNotams": notams,
        "ficonNotams": ficon_notams,
        "ficonNotamCount": len(ficon_notams),
        "runwayClosureNotams": runway_closure_notams,
        "runwayClosureNotamCount": len(runway_closure_notams),
        "constructionStatusNotams": construction_status_notams,
        "constructionStatusNotamCount": len(construction_status_notams),
        "taxiRestrictionNotams": taxi_restriction_notams,
        "taxiRestrictionNotamCount": len(taxi_restriction_notams),
        "detailScanMode": "NMS_AIXM_LOCATION_BULK",
        "bulkRecordsReturned": len(roots),
        "bulkRecordsParsed": len(complete_records),
        "bulkAliasRecordsCollapsed": alias_count,
        "detailRecordsScanned": len(complete_records),
        "operationalRecordsScanned": len(operational_records),
    }


def write_json_atomically(path, result):
    temporary_path = f"{path}.{os.getpid()}.{time.time_ns()}.tmp"

    try:
        with open(temporary_path, "w", encoding="utf-8") as output:
            json.dump(result, output, indent=2, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())

        os.replace(temporary_path, path)
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)


def main():
    client_id = os.environ.get("NMS_CLIENT_ID")
    client_secret = os.environ.get("NMS_CLIENT_SECRET")

    if not client_id or not client_secret:
        raise SystemExit(
            "Missing credentials. Run:\n"
            "  set NMS_CLIENT_ID=YOUR_KEY_HERE\n"
            "  set NMS_CLIENT_SECRET=YOUR_SECRET_HERE"
        )

    token = get_token(client_id, client_secret)
    print(f"Pulling complete AIXM location set for {LOCATION}...")
    time.sleep(REQUEST_DELAY_SECONDS)
    response = nms_get_json(
        "/notams",
        token,
        query={"location": LOCATION},
        response_format="AIXM",
    )
    result = build_bulk_notam_result(response)

    print(f"Bulk AIXM records returned: {result['bulkRecordsReturned']}")
    print(f"Bulk AIXM records parsed: {result['bulkRecordsParsed']}")
    print(f"Operational records after alias handling: {result['operationalRecordsScanned']}")
    write_json_atomically(OUTPUT_FILE, result)

    print()
    print("KMEM MIL NOTAM pull complete.")
    print(f"Status: {result['milNotamStatus']}")
    print(f"FICON: {result['ficonNotamCount']} records")
    print(f"RWY closures: {result['runwayClosureNotamCount']} records")
    print(f"Construction/status: {result['constructionStatusNotamCount']} records")
    print(f"Taxi restrictions: {result['taxiRestrictionNotamCount']} records")
    print(f"Wrote:  {OUTPUT_FILE}")
    print()

    for n in result["milNotams"]:
        print(f"{n['severity'].upper():5} {n['number']}: {n['displayText']}")

    for n in result["ficonNotams"]:
        print(f"FICON {n['number']}: {n['displayText']}")

    for n in result["runwayClosureNotams"]:
        eff_start = n.get("effectiveStart") or "UNK"
        eff_end = n.get("effectiveEnd") or "UFN"
        print(f"RWYCL {n['number']}: {n['displayText']} EFF {eff_start}-{eff_end}")

    for n in result["constructionStatusNotams"]:
        print(f"CONST {n['number']}: {n['displayText']}")

    for n in result["taxiRestrictionNotams"]:
        print(f"TAXI  {n['number']}: {n['displayText']}")


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        category = helper_failure_category(error)
        if category not in SAFE_FAILURE_CATEGORIES:
            category = "UNCLASSIFIED"
        print(f"NMS failure category: {category}", file=sys.stderr)
        raise
