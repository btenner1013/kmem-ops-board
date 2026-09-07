#!/usr/bin/env python3
"""
KMEM MIL NOTAM/FICON NMS pull.

Reads credentials from:
  NMS_CLIENT_ID
  NMS_CLIENT_SECRET

Optional local-only urllib-fallback testing override (never used by curl):
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
import ssl
import subprocess
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
# This legacy opt-in applies only to the no-curl urllib fallback. Windows curl
# always uses verified TLS and fails closed on every certificate/TLS error.
ALLOW_INSECURE_SSL_FALLBACK = os.environ.get(
    "NMS_ALLOW_INSECURE_SSL_FALLBACK",
    "0"
).strip().lower() in {"1", "true", "yes", "on"}

# NMS staging showed a rate limit around 1 request/sec.
REQUEST_DELAY_SECONDS = 1.25
MAX_RETRIES = 2
URLLIB_TOTAL_TIMEOUT_SECONDS = 25
TRANSIENT_HTTP_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}

# Windows production uses the OS curl transport because urllib can remain blocked
# inside a socket call long enough to consume the updater's five-minute child
# budget. Every curl process has both curl-native and parent-enforced limits.
CURL_CONNECT_TIMEOUT_SECONDS = 8
CURL_TOTAL_TIMEOUT_SECONDS = 25
CURL_PROCESS_TIMEOUT_SECONDS = 30
CURL_MAX_RETRIES = 2
CURL_TRANSIENT_EXIT_CODES = {5, 6, 7, 18, 28, 52, 55, 56, 92, 95, 96}
CURL_HTTP_STATUS_MARKER = "__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:"
CURL_STATUS_RE = re.compile(
    rb"(?:\r?\n)__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:([0-9]{3})\r?\n?\Z"
)
CURL_DIAGNOSTIC_LIMIT = 1024

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


def windows_curl_path():
    """Return only the trusted Windows system curl, never a PATH shadow."""
    if os.name != "nt":
        return None

    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if not system_root or not os.path.isabs(system_root):
        return None

    system_root = os.path.abspath(system_root)
    candidates = []
    if os.environ.get("PROCESSOR_ARCHITEW6432"):
        # A 32-bit Python process uses Sysnative to bypass System32 redirection.
        candidates.append(os.path.join(system_root, "Sysnative", "curl.exe"))
    candidates.append(os.path.join(system_root, "System32", "curl.exe"))

    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def curl_header_stdin(headers=None):
    """Build curl's stdin header file after rejecting header injection."""
    lines = []
    for name, value in (headers or {}).items():
        header_name = str(name).strip()
        header_value = str(value)
        if not re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+", header_name):
            raise ValueError("invalid HTTP header name")
        if any(character in header_value for character in ("\x00", "\r", "\n")):
            raise ValueError("invalid HTTP header value")
        lines.append(f"{header_name}: {header_value}")
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
    platform_options = {}
    if os.name == "nt":
        platform_options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    child_environment = os.environ.copy()
    child_environment.pop("NMS_CLIENT_ID", None)
    child_environment.pop("NMS_CLIENT_SECRET", None)

    try:
        completed = subprocess.run(
            command,
            input=header_input,
            capture_output=True,
            timeout=CURL_PROCESS_TIMEOUT_SECONDS,
            check=False,
            shell=False,
            env=child_environment,
            **platform_options,
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


def curl_result_is_transient(result):
    status = result.get("status")
    return (
        status in TRANSIENT_HTTP_STATUS_CODES
        or result.get("returncode") in CURL_TRANSIENT_EXIT_CODES
    )


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
        result = run_curl_attempt(curl_path, method, url, headers, body)
        if curl_result_is_success(result):
            return result["body"]

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


def http_request(method, url, headers=None, body=None, timeout=45):
    """Select bounded Windows curl, otherwise retain the urllib fallback."""
    curl_path = windows_curl_path()
    if curl_path:
        return curl_http_request(curl_path, method, url, headers, body)
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
    main()
