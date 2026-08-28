"""Safe same-origin snapshot of current worldwide TAF products.

The browser cannot read the official Aviation Weather Center (AWC) API or NWS
text files directly because those services do not permit cross-origin browser
requests.  This supplemental module lets the existing ten-minute updater mirror
the official AWC complete-current TAF cache into a small, stable JSON artifact.

It is intentionally independent of ``weather.json`` and the operational KMEM
weather path.  Fetch, validation, or write failures are returned as diagnostics;
they never raise into the caller and never replace a previously usable snapshot.
"""

from __future__ import annotations

import gzip
import io
import json
import os
import re
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional


SCHEMA_VERSION = 1
SOURCE_POLICY = "NOAA_AWC_COMPLETE_CURRENT_CACHE"
AWC_CURRENT_TAF_CACHE_URL = (
    "https://aviationweather.gov/data/cache/tafs.cache.xml.gz"
)
DEFAULT_TIMEOUT_SECONDS = 30
MIN_COMPLETE_REPORTS = 500
MIN_PREVIOUS_COVERAGE_PERCENT = 90
MAX_COMPRESSED_BYTES = 10 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024
FUTURE_ISSUE_TOLERANCE = timedelta(minutes=15)
MAX_VALIDITY_DURATION = timedelta(hours=48)
MAX_PREVALID_ISSUE_LEAD = timedelta(hours=12)
MAX_FUTURE_VALID_START = timedelta(hours=6)

_STATION_RE = re.compile(r"^[A-Z]{4}$")
_TAF_HEADER_RE = re.compile(
    r"^\s*(?:TAF\s+)?(?:(AMD|COR)\s+)?"
    r"([A-Z]{4})\s+"
    r"(\d{2})(\d{2})(\d{2})Z\s+"
    r"(\d{2})(\d{2})/(\d{2})(\d{2})(?=\s|$)",
    re.IGNORECASE,
)
_TAF_VALIDITY_ONLY_HEADER_RE = re.compile(
    r"^\s*(?:TAF\s+)?(?:(AMD|COR)\s+)?"
    r"([A-Z]{4})\s+"
    r"(\d{2})(\d{2})/(\d{2})(\d{2})(?=\s|$)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class TafCacheParseResult:
    """Validated result of parsing one official AWC cache payload."""

    reports: tuple[dict[str, str], ...]
    seen: int
    accepted: int
    rejected: int


@dataclass(frozen=True)
class TafSnapshotUpdateResult:
    """Non-throwing result returned by :func:`maintain_taf_current`."""

    success: bool
    changed: bool
    report_count: int
    rejected: int = 0
    warning: str = ""
    error: str = ""


CacheFetcher = Callable[[], bytes]


def _as_utc(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return None
        return value.astimezone(timezone.utc)

    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _zulu(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _local_name(tag: str) -> str:
    return str(tag).rsplit("}", 1)[-1]


def _child_text(node: ET.Element, name: str) -> str:
    for child in node:
        if _local_name(child.tag) == name:
            return "" if child.text is None else child.text
    return ""


def _valid_group_matches(value: datetime, day: int, hour: int) -> bool:
    """Match a DDHH validity group, including ICAO's DD24 midnight form."""

    if not 1 <= day <= 31 or not 0 <= hour <= 24 or value.minute != 0:
        return False
    if hour < 24:
        return value.day == day and value.hour == hour
    previous_day = value - timedelta(days=1)
    return value.hour == 0 and previous_day.day == day


def _normalize_report(
    *,
    station_value: Any,
    raw_value: Any,
    issue_value: Any,
    valid_from_value: Any,
    valid_to_value: Any,
    now_z: datetime,
    require_current: bool = True,
) -> Optional[dict[str, str]]:
    station = str(station_value or "").strip().upper()
    raw = raw_value if isinstance(raw_value, str) else ""
    issue_time = _as_utc(issue_value)
    valid_from = _as_utc(valid_from_value)
    valid_to = _as_utc(valid_to_value)
    if (
        not _STATION_RE.fullmatch(station)
        or not raw
        or "\x00" in raw
        or issue_time is None
        or valid_from is None
        or valid_to is None
    ):
        return None

    header = _TAF_HEADER_RE.match(raw)
    header_has_issue_group = header is not None
    if header is None:
        # Some valid military TAFs in the official AWC cache omit DDHHMMZ and
        # start with the validity group. In that documented source shape, the
        # authoritative AWC issue_time remains mandatory while station and
        # validity are still checked against the raw header.
        header = _TAF_VALIDITY_ONLY_HEADER_RE.match(raw)
    if header is None or header.group(2).upper() != station:
        return None

    if header_has_issue_group:
        issue_day, issue_hour, issue_minute = map(int, header.group(3, 4, 5))
        valid_start_day, valid_start_hour = map(int, header.group(6, 7))
        valid_end_day, valid_end_hour = map(int, header.group(8, 9))
    else:
        issue_day = issue_hour = issue_minute = None
        valid_start_day, valid_start_hour = map(int, header.group(3, 4))
        valid_end_day, valid_end_hour = map(int, header.group(5, 6))
    if (
        (
            header_has_issue_group
            and (
                issue_time.day != issue_day
                or issue_time.hour != issue_hour
                or issue_time.minute != issue_minute
            )
        )
        or not _valid_group_matches(valid_from, valid_start_day, valid_start_hour)
        or not _valid_group_matches(valid_to, valid_end_day, valid_end_hour)
    ):
        return None

    validity_duration = valid_to - valid_from
    if (
        validity_duration <= timedelta(0)
        or validity_duration > MAX_VALIDITY_DURATION
        or issue_time > valid_to
        or issue_time < valid_from - MAX_PREVALID_ISSUE_LEAD
    ):
        return None

    if require_current and (
        issue_time > now_z + FUTURE_ISSUE_TOLERANCE
        or valid_to <= now_z
        or valid_from > now_z + MAX_FUTURE_VALID_START
    ):
        return None

    body = raw[header.end() :].strip().upper().rstrip("=").strip()
    if not body or body in {"NIL", "CNL", "CANCELLED", "CANCELED"}:
        return None

    return {
        "station": station,
        "issueTime": _zulu(issue_time),
        "validTimeFrom": _zulu(valid_from),
        "validTimeTo": _zulu(valid_to),
        "variant": str(header.group(1) or "").upper(),
        "raw": raw,
    }


def _variant_rank(value: str) -> int:
    return {"": 0, "AMD": 1, "COR": 2}.get(str(value or "").upper(), -1)


def _candidate_rank(report: Mapping[str, str]) -> tuple[Any, ...]:
    return (
        _as_utc(report.get("issueTime")) or datetime.min.replace(tzinfo=timezone.utc),
        _variant_rank(report.get("variant", "")),
        _as_utc(report.get("validTimeTo")) or datetime.min.replace(tzinfo=timezone.utc),
        str(report.get("raw") or ""),
    )


def _decompress_cache(payload: bytes) -> bytes:
    if not isinstance(payload, (bytes, bytearray)) or not payload:
        raise ValueError("AWC TAF cache was empty")
    if len(payload) > MAX_COMPRESSED_BYTES:
        raise ValueError("AWC TAF cache exceeded the compressed size limit")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(bytes(payload))) as stream:
            xml_bytes = stream.read(MAX_DECOMPRESSED_BYTES + 1)
    except (OSError, EOFError) as error:
        raise ValueError(f"AWC TAF cache was not valid gzip: {error}") from error
    if len(xml_bytes) > MAX_DECOMPRESSED_BYTES:
        raise ValueError("AWC TAF cache exceeded the decompressed size limit")
    if b"<!DOCTYPE" in xml_bytes.upper() or b"<!ENTITY" in xml_bytes.upper():
        raise ValueError("AWC TAF cache contained a prohibited document declaration")
    return xml_bytes


def parse_awc_current_taf_cache(
    payload: bytes,
    *,
    now_z: Optional[datetime] = None,
) -> TafCacheParseResult:
    """Parse and strictly validate the official complete-current AWC XML cache."""

    now = _as_utc(now_z or datetime.now(timezone.utc))
    if now is None:
        raise ValueError("now_z must be timezone-aware")

    xml_bytes = _decompress_cache(payload)
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as error:
        raise ValueError(f"AWC TAF cache XML was malformed: {error}") from error

    nodes = [node for node in root.iter() if _local_name(node.tag) == "TAF"]
    newest_by_station: dict[str, dict[str, str]] = {}
    accepted = 0
    rejected = 0

    for node in nodes:
        report = _normalize_report(
            station_value=_child_text(node, "station_id"),
            raw_value=_child_text(node, "raw_text"),
            issue_value=_child_text(node, "issue_time"),
            valid_from_value=_child_text(node, "valid_time_from"),
            valid_to_value=_child_text(node, "valid_time_to"),
            now_z=now,
        )
        if report is None:
            rejected += 1
            continue
        accepted += 1
        prior = newest_by_station.get(report["station"])
        if prior is None or _candidate_rank(report) > _candidate_rank(prior):
            newest_by_station[report["station"]] = report

    reports = tuple(
        sorted(
            newest_by_station.values(),
            key=lambda item: (
                item["station"],
                item["issueTime"],
                item["variant"],
                item["raw"],
            ),
        )
    )
    return TafCacheParseResult(
        reports=reports,
        seen=len(nodes),
        accepted=accepted,
        rejected=rejected,
    )


def build_taf_current_payload(
    reports: tuple[dict[str, str], ...] | list[dict[str, str]],
) -> dict[str, Any]:
    """Build the stable public artifact without a churn-only fetch timestamp."""

    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourcePolicy": SOURCE_POLICY,
        "reports": [dict(report) for report in reports],
    }


def fetch_awc_current_taf_cache(
    *,
    url: str = AWC_CURRENT_TAF_CACHE_URL,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> bytes:
    """Fetch the official complete-current cache with bounded memory usage."""

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "KMEM-OpsBoard/1.0 (current TAF snapshot)",
            "Accept": "application/octet-stream,application/gzip,*/*",
            "Accept-Encoding": "identity",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read(MAX_COMPRESSED_BYTES + 1)
    if len(payload) > MAX_COMPRESSED_BYTES:
        raise ValueError("AWC TAF cache exceeded the compressed size limit")
    return payload


def _load_existing(path: Path) -> tuple[dict[str, Any], str]:
    try:
        with path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
    except FileNotFoundError:
        return {}, ""
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return {}, f"unable to load current TAF snapshot: {error}"
    if not isinstance(value, dict):
        return {}, "current TAF snapshot root is not an object"
    return value, ""


def _existing_report_count(value: Mapping[str, Any]) -> int:
    reports = value.get("reports")
    if not isinstance(reports, list):
        return 0
    return sum(1 for report in reports if isinstance(report, Mapping))


def _atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        except OSError:
            pass


def maintain_taf_current(
    path: os.PathLike[str] | str,
    *,
    now_z: Optional[datetime] = None,
    fetcher: Optional[CacheFetcher] = None,
    minimum_report_count: int = MIN_COMPLETE_REPORTS,
) -> TafSnapshotUpdateResult:
    """Fetch and safely maintain the same-origin current-TAF snapshot.

    A failed, malformed, or suspiciously partial fetch never writes the target.
    When the semantic report set is unchanged, the existing file is not touched.
    """

    snapshot_path = Path(path)
    existing, load_warning = _load_existing(snapshot_path)
    prior_count = _existing_report_count(existing)
    now = _as_utc(now_z or datetime.now(timezone.utc))
    if now is None:
        return TafSnapshotUpdateResult(
            success=False,
            changed=False,
            report_count=prior_count,
            warning=load_warning,
            error="current TAF snapshot requires a timezone-aware now_z",
        )

    try:
        compressed = (fetcher or fetch_awc_current_taf_cache)()
        parsed = parse_awc_current_taf_cache(compressed, now_z=now)
        expected_minimum = max(1, int(minimum_report_count))
        if prior_count:
            expected_minimum = max(
                expected_minimum,
                (
                    prior_count * MIN_PREVIOUS_COVERAGE_PERCENT
                    + 99
                )
                // 100,
            )
        if len(parsed.reports) < expected_minimum:
            raise ValueError(
                "AWC TAF cache was suspiciously partial "
                f"({len(parsed.reports)} reports; expected at least {expected_minimum})"
            )
        if parsed.seen and parsed.accepted * 5 < parsed.seen * 4:
            raise ValueError(
                "AWC TAF cache validation rejected too many products "
                f"({parsed.rejected} of {parsed.seen})"
            )
        payload = build_taf_current_payload(parsed.reports)
    except Exception as error:
        return TafSnapshotUpdateResult(
            success=False,
            changed=False,
            report_count=prior_count,
            warning=load_warning,
            error=f"current TAF snapshot refresh failed safely: {error}",
        )

    warning_parts = [part for part in (load_warning,) if part]
    if parsed.rejected:
        warning_parts.append(
            f"rejected {parsed.rejected} malformed or non-current AWC TAF products"
        )
    warning = "; ".join(warning_parts)
    if existing == payload:
        return TafSnapshotUpdateResult(
            success=True,
            changed=False,
            report_count=len(parsed.reports),
            rejected=parsed.rejected,
            warning=warning,
        )

    try:
        _atomic_write_json(snapshot_path, payload)
    except Exception as error:
        return TafSnapshotUpdateResult(
            success=False,
            changed=False,
            report_count=prior_count,
            rejected=parsed.rejected,
            warning=warning,
            error=f"current TAF snapshot write failed safely: {error}",
        )

    return TafSnapshotUpdateResult(
        success=True,
        changed=True,
        report_count=len(parsed.reports),
        rejected=parsed.rejected,
        warning=warning,
    )
