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
import ssl
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
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
URLLIB_TOTAL_TIMEOUT_SECONDS = 25
TRANSIENT_HTTP_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}

# Windows production prefers OS curl, then pinned Windows PowerShell/HttpClient,
# because urllib DNS/TLS calls can outlive a socket timeout. Every Windows
# transport process has both native and parent-enforced limits.
CURL_CONNECT_TIMEOUT_SECONDS = 8
CURL_TOTAL_TIMEOUT_SECONDS = 25
CURL_PROCESS_TIMEOUT_SECONDS = 30
CURL_MAX_RETRIES = 2
# Only availability/framing failures may cross from curl to the independently
# verified PowerShell transport. TLS, certificate, trust-store, client-certificate,
# and pinning failures intentionally remain terminal instead of trying a transport
# with potentially different validation behavior.
CURL_CROSS_TRANSPORT_EXIT_CODES = {2, 5, 6, 7, 18, 28, 52, 55, 56, 92, 95, 96}
CURL_HTTP_STATUS_MARKER = "__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:"
CURL_STATUS_RE = re.compile(
    rb"(?:\r?\n)__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:([0-9]{3})\r?\n?\Z"
)
CURL_DIAGNOSTIC_LIMIT = 1024
TRANSPORT_PIPE_DRAIN_TIMEOUT_SECONDS = 3
TRANSPORT_TREE_KILL_TIMEOUT_SECONDS = 5
POWERSHELL_TOTAL_TIMEOUT_SECONDS = 25
POWERSHELL_PROCESS_TIMEOUT_SECONDS = 30
POWERSHELL_MAX_RETRIES = 2
PYTHON_CHILD_TOTAL_TIMEOUT_SECONDS = 25
PYTHON_CHILD_PROCESS_TIMEOUT_SECONDS = 30
PYTHON_CHILD_MAX_RETRIES = 2
PYTHON_CHILD_RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024
LAST_HTTP_TRANSPORT = "NOT_USED"
LAST_PROCESS_BOUNDARY = "NOT_USED"
SAFE_FAILURE_CATEGORIES = {
    "AUTH_HTTP",
    "RATE_LIMIT",
    "UPSTREAM_HTTP",
    "TLS_SECURITY",
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


def helper_failure_category(error):
    """Map a failed helper run to a credential-free operational category."""
    text = str(error).casefold()
    if isinstance(error, SystemExit):
        return "CONFIGURATION"
    if "http 401" in text or "http 403" in text:
        return "AUTH_HTTP"
    if "http 429" in text:
        return "RATE_LIMIT"
    if re.search(r"\bhttp 5\d\d\b", text):
        return "UPSTREAM_HTTP"
    if any(term in text for term in ("certificate", "ssl", "tls", "trust")):
        return "TLS_SECURITY"
    if "curl exit 2" in text:
        return "TRANSPORT_COMPATIBILITY"
    if isinstance(error, NmsTransportError):
        return "TRANSPORT_UNAVAILABLE"
    if any(
        term in text
        for term in (
            "could not connect",
            "failed to connect",
            "sending the request",
            "name or service not known",
            "timed out",
        )
    ):
        return "TRANSPORT_UNAVAILABLE"
    if "process launch" in text:
        return "PROCESS_LAUNCH"
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


def urllib_http_request(method, url, headers=None, body=None, timeout=45):
    """Portable verified-TLS fallback used when Windows curl is unavailable."""
    req = Request(url=url, data=body, headers=headers or {}, method=method)
    timeout = min(float(timeout), URLLIB_TOTAL_TIMEOUT_SECONDS)
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


def curl_request_command(curl_path, method, url, body=None):
    """Build a secret-free curl argv with explicit HTTPS and time limits."""
    normalized_method = str(method or "GET").strip().upper()
    if not re.fullmatch(r"[A-Z]+", normalized_method):
        raise ValueError("invalid HTTP method")
    if not str(url).lower().startswith("https://"):
        raise ValueError("NMS curl transport requires HTTPS")

    command = [
        curl_path,
        "--disable",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--connect-timeout",
        str(CURL_CONNECT_TIMEOUT_SECONDS),
        "--max-time",
        str(CURL_TOTAL_TIMEOUT_SECONDS),
        "--request",
        normalized_method,
        "--url",
        str(url),
        "--write-out",
        f"\\n{CURL_HTTP_STATUS_MARKER}%{{http_code}}\\n",
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
    raw = stdout or b""
    status_match = CURL_STATUS_RE.search(raw)
    if not status_match:
        return None, b""
    return int(status_match.group(1)), raw[:status_match.start()]


def run_curl_attempt(curl_path, method, url, headers=None, body=None):
    """Run one bounded curl process and return transport metadata."""
    command = curl_request_command(curl_path, method, url, body)
    header_input = curl_header_stdin(headers)

    child_environment = os.environ.copy()
    child_environment.pop("NMS_CLIENT_ID", None)
    child_environment.pop("NMS_CLIENT_SECRET", None)

    try:
        completed = run_bounded_transport_process(
            command,
            input=header_input,
            timeout=CURL_PROCESS_TIMEOUT_SECONDS,
            env=child_environment,
        )
    except subprocess.TimeoutExpired:
        return {
            "returncode": 28,
            "status": None,
            "body": b"",
            "diagnostic": "curl process exceeded its hard timeout",
        }

    stderr = completed.stderr or b""
    status, response_body = split_curl_response(completed.stdout)
    return {
        "returncode": completed.returncode,
        "status": status,
        "body": response_body,
        "diagnostic": curl_diagnostics(stderr, headers),
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
    return return_code in CURL_CROSS_TRANSPORT_EXIT_CODES


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


def curl_http_request(curl_path, method, url, headers=None, body=None):
    """Use bounded verified-TLS Windows curl attempts and fail closed."""
    for attempt in range(1, CURL_MAX_RETRIES + 1):
        try:
            result = run_curl_attempt(curl_path, method, url, headers, body)
        except OSError as error:
            raise NmsTransportError(
                "NMS curl request failed (process launch error): no diagnostic text"
            ) from error
        if curl_result_is_success(result):
            return result["body"]

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


POWERSHELL_HTTP_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$client = $null
$message = $null
$response = $null
try {
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $requestJson = [Console]::In.ReadToEnd()
    $request = $requestJson | ConvertFrom-Json
    $uri = [Uri]([string]$request.url)
    if ($uri.Scheme -ne 'https') { throw 'NMS transport requires HTTPS' }

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.CheckCertificateRevocationList = $true
    $client = New-Object System.Net.Http.HttpClient -ArgumentList @($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(__TIMEOUT_SECONDS__)
    $method = New-Object System.Net.Http.HttpMethod -ArgumentList @([string]$request.method)
    $message = New-Object System.Net.Http.HttpRequestMessage -ArgumentList @($method, $uri)

    if ([bool]$request.hasBody) {
        $bodyBytes = [Convert]::FromBase64String([string]$request.bodyBase64)
        $message.Content = New-Object System.Net.Http.ByteArrayContent -ArgumentList @(,$bodyBytes)
    }

    foreach ($property in $request.headers.PSObject.Properties) {
        $name = [string]$property.Name
        $value = [string]$property.Value
        if ($name -ieq 'Content-Type') {
            if ($null -eq $message.Content) {
                $message.Content = New-Object System.Net.Http.ByteArrayContent -ArgumentList @(,[byte[]]@())
            }
            [void]$message.Content.Headers.TryAddWithoutValidation($name, $value)
        } else {
            [void]$message.Headers.TryAddWithoutValidation($name, $value)
        }
    }

    $response = $client.SendAsync(
        $message,
        [System.Net.Http.HttpCompletionOption]::ResponseContentRead
    ).GetAwaiter().GetResult()
    $responseBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $output = [Console]::OpenStandardOutput()
    if ($responseBytes.Length -gt 0) {
        $output.Write($responseBytes, 0, $responseBytes.Length)
    }
    $statusText = "`n__STATUS_MARKER__$([int]$response.StatusCode)`n"
    $statusBytes = [Text.Encoding]::ASCII.GetBytes($statusText)
    $output.Write($statusBytes, 0, $statusBytes.Length)
    $output.Flush()
} catch [System.Threading.Tasks.TaskCanceledException] {
    [Console]::Error.WriteLine('NMS PowerShell HTTP request timed out')
    exit 28
} catch [System.TimeoutException] {
    [Console]::Error.WriteLine('NMS PowerShell HTTP request timed out')
    exit 28
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $message) { $message.Dispose() }
    if ($null -ne $client) { $client.Dispose() }
}
"""


def powershell_http_script():
    """Return a fixed, credential-free HttpClient script for Windows fallback."""
    return (
        POWERSHELL_HTTP_SCRIPT
        .replace("__TIMEOUT_SECONDS__", str(POWERSHELL_TOTAL_TIMEOUT_SECONDS))
        .replace("__STATUS_MARKER__", CURL_HTTP_STATUS_MARKER)
    )


def powershell_request_command(powershell_path):
    """Build secret-free argv for the pinned Windows PowerShell executable."""
    encoded_script = base64.b64encode(
        powershell_http_script().encode("utf-16-le")
    ).decode("ascii")
    return [
        powershell_path,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded_script,
    ]


def powershell_request_stdin(method, url, headers=None, body=None):
    """Serialize the request, including authorization, only to child stdin."""
    normalized_method = str(method or "GET").strip().upper()
    if not re.fullmatch(r"[A-Z]+", normalized_method):
        raise ValueError("invalid HTTP method")
    if not str(url).lower().startswith("https://"):
        raise ValueError("NMS PowerShell transport requires HTTPS")

    body_bytes = None
    if body is not None:
        body_bytes = body if isinstance(body, bytes) else str(body).encode("utf-8")
        if body_bytes != b"grant_type=client_credentials":
            raise ValueError("unexpected NMS PowerShell request body")

    payload = {
        "method": normalized_method,
        "url": str(url),
        "headers": validated_http_headers(headers),
        "hasBody": body_bytes is not None,
        "bodyBase64": base64.b64encode(body_bytes or b"").decode("ascii"),
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def run_powershell_attempt(powershell_path, method, url, headers=None, body=None):
    """Run one bounded verified-TLS Windows HttpClient request."""
    command = powershell_request_command(powershell_path)
    request_input = powershell_request_stdin(method, url, headers, body)
    child_environment = os.environ.copy()
    child_environment.pop("NMS_CLIENT_ID", None)
    child_environment.pop("NMS_CLIENT_SECRET", None)

    try:
        completed = run_bounded_transport_process(
            command,
            input=request_input,
            timeout=POWERSHELL_PROCESS_TIMEOUT_SECONDS,
            env=child_environment,
        )
    except subprocess.TimeoutExpired:
        return {
            "returncode": 28,
            "status": None,
            "body": b"",
            "diagnostic": "PowerShell HTTP process exceeded its hard timeout",
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


def powershell_http_request(powershell_path, method, url, headers=None, body=None):
    """Use bounded verified-TLS Windows HttpClient attempts and fail closed."""
    for attempt in range(1, POWERSHELL_MAX_RETRIES + 1):
        try:
            result = run_powershell_attempt(
                powershell_path,
                method,
                url,
                headers,
                body,
            )
        except OSError as error:
            raise NmsTransportError(
                "NMS PowerShell HTTP request failed "
                "(process launch error): no diagnostic text"
            ) from error
        if curl_result_is_success(result):
            return result["body"]

        transient = (
            result.get("status") in TRANSIENT_HTTP_STATUS_CODES
            or result.get("returncode") == 28
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
            result.get("returncode") == 2 and result.get("status") is None
        )
        powershell_framing_failure = (
            result.get("returncode") == 0
            and not isinstance(result.get("status"), int)
        )
        if powershell_compatibility_failure or powershell_framing_failure:
            error_type = (
                NmsCompatibilityError
                if powershell_compatibility_failure
                else NmsTransportError
            )
            raise error_type(
                curl_failure_message(result).replace(
                    "NMS curl",
                    "NMS PowerShell HTTP",
                )
            )

        raise RuntimeError(
            curl_failure_message(result).replace("NMS curl", "NMS PowerShell HTTP")
        )

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


def record_http_transport(name):
    """Emit only a safe enum so partial timeout logs identify the chosen path."""
    global LAST_HTTP_TRANSPORT
    LAST_HTTP_TRANSPORT = name
    print(f"NMS HTTP transport: {name}")


def http_request(method, url, headers=None, body=None, timeout=45):
    """Select bounded verified Windows transports, then portable urllib."""
    curl_path = windows_curl_path()
    if curl_path:
        record_http_transport("WINDOWS_CURL")
        try:
            return curl_http_request(curl_path, method, url, headers, body)
        except NmsTransportError:
            # PRIMARY's pinned curl and PowerShell have both repeatedly failed
            # before producing an HTTP response. The isolated child uses the
            # same verified TLS policy without another unreliable host-tool hop.
            record_http_transport("WINDOWS_CURL_TO_PYTHON")
            return python_child_http_request(
                method,
                url,
                headers,
                body,
            )

    powershell_path = windows_powershell_path()
    if powershell_path:
        record_http_transport("WINDOWS_POWERSHELL")
        try:
            return powershell_http_request(
                powershell_path,
                method,
                url,
                headers,
                body,
            )
        except NmsTransportError:
            record_http_transport("WINDOWS_POWERSHELL_TO_PYTHON")
            return python_child_http_request(
                method,
                url,
                headers,
                body,
            )

    if os.name == "nt":
        record_http_transport("WINDOWS_PYTHON")
        return python_child_http_request(method, url, headers, body)

    record_http_transport("PORTABLE_URLLIB")
    return urllib_http_request(method, url, headers, body, timeout)


def get_token(client_id, client_secret):
    auth = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")

    raw = http_request(
        "POST",
        AUTH_URL,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body=b"grant_type=client_credentials",
    )

    data = json.loads(raw.decode("utf-8"))
    token = data.get("access_token")

    if not token:
        raise RuntimeError(f"Token response missing access_token: {data}")

    print(f"NMS token OK. status={data.get('status')}; expires_in={data.get('expires_in')} sec")
    return token


def nms_get_json(path, token, query=None, response_format=None):
    url = BASE_URL + path

    if query:
        url += "?" + urlencode(query)

    headers = {"Authorization": f"Bearer {token}"}

    if response_format:
        headers["nmsResponseFormat"] = response_format

    raw = http_request("GET", url, headers=headers)
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
