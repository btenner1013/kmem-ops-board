"""Safe rolling history storage for genuinely observed KMEM D-ATIS reports.

This module is deliberately independent of the operational weather producer.  The
caller remains responsible for fetching reports and for applying the operational
ATIS validity rules.  History accepts only candidates explicitly marked as live,
and an optional validator lets the updater reuse its existing ``is_good_atis``
semantics without importing the updater here.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional


SCHEMA_VERSION = 1
DEFAULT_STATION = "KMEM"
DEFAULT_RETENTION_HOURS = 96
FUTURE_TOLERANCE = timedelta(minutes=10)


@dataclass(frozen=True)
class ArchiveMergeResult:
    """Result of a pure in-memory archive merge."""

    archive: dict[str, Any]
    changed: bool
    appended: int
    deduplicated: int
    pruned: int
    rejected: int
    warning: str = ""


@dataclass(frozen=True)
class ArchiveUpdateResult:
    """Non-throwing result returned by :func:`maintain_atis_history`."""

    success: bool
    changed: bool
    archive: dict[str, Any]
    appended: int = 0
    deduplicated: int = 0
    pruned: int = 0
    rejected: int = 0
    warning: str = ""
    error: str = ""


Validator = Callable[[str], bool]


def _as_utc(value: Any) -> Optional[datetime]:
    """Parse an aware datetime/ISO value and return a UTC datetime."""

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


def _clean_raw(value: Any) -> str:
    """Keep the report wording intact while removing transport whitespace noise."""

    text = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()


def _normalize_body(raw: str, station: str) -> str:
    """Return a conservative provider-independent broadcast comparison body."""

    text = _clean_raw(raw).upper()
    alias = station[1:] if len(station) == 4 and station.startswith("K") else station
    if alias and alias != station:
        text = re.sub(
            rf"\b{re.escape(alias)}\s+"
            r"(?=(?:(?:ARR(?:IVAL)?|DEP(?:ARTURE)?)\s+)?ATIS\b)",
            f"{station} ",
            text,
        )
    text = re.sub(r"\bINFORMATION\b", "INFO", text)
    text = re.sub(
        rf"\b{re.escape(station)}\s+(?:ARR(?:IVAL)?|DEP(?:ARTURE)?)\s+ATIS\b",
        f"{station} ATIS",
        text,
    )
    return text.rstrip(" .=")


def _normalize_station(value: Any) -> str:
    station = str(value or "").strip().upper()
    return station if re.fullmatch(r"[A-Z0-9]{4}", station) else ""


def _normalize_letter(value: Any) -> str:
    letter = str(value or "").strip().upper()
    return letter if re.fullmatch(r"[A-Z]", letter) else ""


def _normalize_variant(value: Any) -> str:
    variant = re.sub(r"[^A-Z]", "", str(value or "").upper())
    if variant in {"ARR", "ARRIVAL", "ARRIVALS"}:
        return "ARR"
    if variant in {"DEP", "DEPARTURE", "DEPARTURES"}:
        return "DEP"
    if variant in {"BOTH", "COMBINED", "COMBINATION", "ATIS", ""}:
        return "COMBINED"
    return "OTHER"


def _normalize_sources(candidate: Mapping[str, Any]) -> list[str]:
    values: list[Any] = []
    raw_sources = candidate.get("sources")
    if isinstance(raw_sources, str):
        values.append(raw_sources)
    elif isinstance(raw_sources, Iterable):
        values.extend(raw_sources)
    if candidate.get("source"):
        values.append(candidate.get("source"))

    normalized = {
        re.sub(r"\s+", "_", str(value).strip().upper())
        for value in values
        if str(value or "").strip()
    }
    return sorted(normalized)


def _header_details(raw: str, station: str) -> tuple[str, str, str]:
    """Return (letter, HHMM, header variant) for a station ATIS header."""

    alias = station[1:] if len(station) == 4 and station.startswith("K") else station
    station_tokens = sorted({station, alias}, key=len, reverse=True)
    station_pattern = "|".join(re.escape(token) for token in station_tokens if token)
    match = re.search(
        rf"\b(?:{station_pattern})\s+"
        r"(?:(ARR(?:IVAL)?|DEP(?:ARTURE)?)\s+)?"
        r"ATIS\s+INFO(?:RMATION)?\s+([A-Z])\D{0,12}(\d{4})Z\b",
        raw.upper(),
    )
    if not match:
        return "", "", ""
    header_variant = _normalize_variant(match.group(1)) if match.group(1) else ""
    return match.group(2), match.group(3), header_variant


def _basic_report_valid(raw: str, station: str, letter: str, observed: datetime) -> bool:
    if len(raw) < 40:
        return False
    header_letter, header_hhmm, _ = _header_details(raw, station)
    if header_letter != letter or header_hhmm != observed.strftime("%H%M"):
        return False
    handoff_letters = re.findall(
        r"\bADVS?\s+YOU\s+HAVE\s+(?:INFO|INFORMATION)\s+([A-Z])\b",
        raw.upper(),
    )
    return not handoff_letters or handoff_letters[-1] == letter


def _normalize_record(
    candidate: Mapping[str, Any],
    *,
    now_z: datetime,
    station: str,
    validator: Optional[Validator],
    require_live: bool,
) -> Optional[dict[str, Any]]:
    if not isinstance(candidate, Mapping):
        return None
    if require_live:
        if candidate.get("isLive") is not True:
            return None
        if candidate.get("isFallback") is True or candidate.get("fallback") is True:
            return None

    candidate_station = _normalize_station(candidate.get("station") or station)
    if candidate_station != station:
        return None

    observed = _as_utc(candidate.get("observedZ"))
    if observed is None or observed > now_z + FUTURE_TOLERANCE:
        return None

    raw = _clean_raw(candidate.get("raw"))
    header_letter, _, header_variant = _header_details(raw, station)
    letter = _normalize_letter(candidate.get("letter") or header_letter)
    if not letter or not _basic_report_valid(raw, station, letter, observed):
        return None

    if validator is not None:
        try:
            if not validator(raw):
                return None
        except Exception:
            return None

    first_seen = _as_utc(candidate.get("firstSeenZ")) or now_z
    if first_seen > now_z + FUTURE_TOLERANCE:
        first_seen = now_z

    explicit_variant = _normalize_variant(candidate.get("variant"))
    variant = header_variant or explicit_variant

    return {
        "station": station,
        "observedZ": _zulu(observed),
        "letter": letter,
        "variant": variant,
        "raw": raw,
        "firstSeenZ": _zulu(first_seen),
        "sources": _normalize_sources(candidate),
    }


def _base_identity(record: Mapping[str, Any]) -> tuple[str, str, str, str]:
    station = str(record["station"])
    return (
        station,
        str(record["observedZ"]),
        str(record["letter"]),
        _normalize_body(str(record["raw"]), station),
    )


def _record_identity(record: Mapping[str, Any]) -> tuple[str, str, str, str, str]:
    return _base_identity(record) + (str(record["variant"]),)


def _merge_record_group(records: list[dict[str, Any]], variant: str) -> dict[str, Any]:
    exemplar = min(records, key=lambda item: (item["raw"].casefold(), item["raw"]))
    first_seen = min(_as_utc(item["firstSeenZ"]) for item in records)
    sources = sorted({source for item in records for source in item["sources"]})
    return {
        "station": exemplar["station"],
        "observedZ": exemplar["observedZ"],
        "letter": exemplar["letter"],
        "variant": variant,
        "raw": exemplar["raw"],
        "firstSeenZ": _zulu(first_seen),
        "sources": sources,
    }


def _deduplicate_records(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Merge provider duplicates while never collapsing ARR into DEP."""

    bases: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    for record in records:
        bases.setdefault(_base_identity(record), []).append(record)

    merged: list[dict[str, Any]] = []
    for base in sorted(bases):
        group = bases[base]
        by_variant: dict[str, list[dict[str, Any]]] = {}
        for record in group:
            by_variant.setdefault(record["variant"], []).append(record)

        specific = [variant for variant in ("ARR", "DEP") if variant in by_variant]
        generic = by_variant.pop("COMBINED", []) + by_variant.pop("OTHER", [])
        if generic and len(specific) == 1:
            by_variant[specific[0]].extend(generic)
        elif generic:
            generic_variant = (
                "COMBINED"
                if any(item["variant"] == "COMBINED" for item in generic)
                else "OTHER"
            )
            by_variant[generic_variant] = generic

        for variant in sorted(by_variant):
            merged.append(_merge_record_group(by_variant[variant], variant))

    deduplicated = max(0, len(records) - len(merged))
    return merged, deduplicated


def _sort_records(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    # Chronology is driven by full UTC timestamps and first-seen time.  Letter is
    # only a deterministic final tie-break and never determines Z -> A chronology.
    return sorted(
        records,
        key=lambda item: (
            _as_utc(item["observedZ"]),
            _as_utc(item["firstSeenZ"]),
            item["variant"],
            item["letter"],
            _normalize_body(item["raw"], item["station"]),
        ),
        reverse=True,
    )


def _empty_archive(station: str, retention_hours: int) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "station": station,
        "retentionHours": retention_hours,
        "archiveStartedZ": "",
        "records": [],
    }


def merge_atis_history(
    existing_archive: Any,
    live_candidates: Iterable[Mapping[str, Any]],
    *,
    now_z: datetime,
    validator: Optional[Validator] = None,
    station: str = DEFAULT_STATION,
    retention_hours: int = DEFAULT_RETENTION_HOURS,
) -> ArchiveMergeResult:
    """Purely merge live candidates into a canonical rolling archive.

    Candidates must be explicitly marked ``isLive: True``.  Existing records do
    not need that transient marker.  The inclusive retention boundary is based on
    each report's resolved full UTC observation timestamp.
    """

    now = _as_utc(now_z)
    normalized_station = _normalize_station(station)
    if now is None:
        raise ValueError("now_z must be timezone-aware")
    if not normalized_station:
        raise ValueError("station must be a four-character ICAO identifier")
    if not isinstance(retention_hours, int) or retention_hours <= 0:
        raise ValueError("retention_hours must be a positive integer")

    archive_is_mapping = isinstance(existing_archive, Mapping)
    existing = existing_archive if archive_is_mapping else {}
    warnings: list[str] = []
    if existing_archive not in ({}, None) and not archive_is_mapping:
        warnings.append("archive root was not an object; recovered from an empty archive")

    raw_existing_records = existing.get("records", []) if archive_is_mapping else []
    if not isinstance(raw_existing_records, list):
        warnings.append("archive records was not a list; recovered from an empty record set")
        raw_existing_records = []

    normalized_existing: list[dict[str, Any]] = []
    invalid_existing = 0
    for record in raw_existing_records:
        normalized = _normalize_record(
            record,
            now_z=now,
            station=normalized_station,
            validator=validator,
            require_live=False,
        )
        if normalized is None:
            invalid_existing += 1
        else:
            normalized_existing.append(normalized)
    if invalid_existing:
        warnings.append(f"discarded {invalid_existing} malformed archived record(s)")

    normalized_live: list[dict[str, Any]] = []
    rejected = 0
    for candidate in live_candidates or []:
        normalized = _normalize_record(
            candidate,
            now_z=now,
            station=normalized_station,
            validator=validator,
            require_live=True,
        )
        if normalized is None:
            rejected += 1
        else:
            normalized_live.append(normalized)

    cutoff = now - timedelta(hours=retention_hours)
    combined = normalized_existing + normalized_live
    retained: list[dict[str, Any]] = []
    pruned = 0
    for record in combined:
        observed = _as_utc(record["observedZ"])
        if observed is not None and observed >= cutoff:  # inclusive boundary
            retained.append(record)
        else:
            pruned += 1

    existing_distinct, _ = _deduplicate_records(
        [
            record
            for record in normalized_existing
            if (_as_utc(record["observedZ"]) or datetime.min.replace(tzinfo=timezone.utc))
            >= cutoff
        ]
    )
    existing_identities = {_record_identity(record) for record in existing_distinct}

    deduplicated_records, deduplicated = _deduplicate_records(retained)
    sorted_records = _sort_records(deduplicated_records)
    appended = sum(
        1 for record in sorted_records if _record_identity(record) not in existing_identities
    )

    prior_start = _as_utc(existing.get("archiveStartedZ")) if archive_is_mapping else None
    first_seen_values = [
        _as_utc(record["firstSeenZ"])
        for record in sorted_records
        if _as_utc(record["firstSeenZ"]) is not None
    ]
    start_candidates = ([prior_start] if prior_start is not None else []) + first_seen_values
    archive_start = min(start_candidates) if start_candidates else None

    archive = {
        "schemaVersion": SCHEMA_VERSION,
        "station": normalized_station,
        "retentionHours": retention_hours,
        "archiveStartedZ": _zulu(archive_start) if archive_start else "",
        "records": sorted_records,
    }
    changed = dict(existing) != archive if archive_is_mapping else bool(sorted_records)
    return ArchiveMergeResult(
        archive=archive,
        changed=changed,
        appended=appended,
        deduplicated=deduplicated,
        pruned=pruned,
        rejected=rejected,
        warning="; ".join(warnings),
    )


def load_atis_history(path: os.PathLike[str] | str) -> tuple[dict[str, Any], str, bool]:
    """Load an archive without raising.

    Returns ``(archive, warning, exists)``. Missing files are normal. A malformed
    file returns an empty object plus a warning so a valid live report can safely
    begin a replacement archive.
    """

    archive_path = Path(path)
    try:
        with archive_path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
    except FileNotFoundError:
        return {}, "", False
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return {}, f"unable to load ATIS history: {error}", archive_path.exists()

    if not isinstance(value, dict):
        return {}, "ATIS history root is not an object", True
    return value, "", True


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


def maintain_atis_history(
    path: os.PathLike[str] | str,
    live_candidates: Iterable[Mapping[str, Any]],
    *,
    now_z: Optional[datetime] = None,
    validator: Optional[Validator] = None,
    station: str = DEFAULT_STATION,
    retention_hours: int = DEFAULT_RETENTION_HOURS,
) -> ArchiveUpdateResult:
    """Safely update an archive file, returning diagnostics instead of raising."""

    now = _as_utc(now_z or datetime.now(timezone.utc))
    archive_path = Path(path)
    existing, load_warning, exists = load_atis_history(archive_path)

    # An unreadable existing file is not safe to replace blindly. JSON/schema
    # corruption is recoverable because load_atis_history returned a readable path
    # with a precise warning; permission and other filesystem failures are surfaced.
    if load_warning.startswith("unable to load") and exists:
        try:
            archive_path.read_bytes()
        except OSError as error:
            return ArchiveUpdateResult(
                success=False,
                changed=False,
                archive=_empty_archive(_normalize_station(station) or station, retention_hours),
                warning=load_warning,
                error=f"ATIS history read failed safely: {error}",
            )

    try:
        merged = merge_atis_history(
            existing,
            live_candidates,
            now_z=now,
            validator=validator,
            station=station,
            retention_hours=retention_hours,
        )
    except Exception as error:
        return ArchiveUpdateResult(
            success=False,
            changed=False,
            archive=existing if isinstance(existing, dict) else {},
            warning=load_warning,
            error=f"ATIS history merge failed safely: {error}",
        )

    warning = "; ".join(part for part in (load_warning, merged.warning) if part)
    if not merged.changed:
        return ArchiveUpdateResult(
            success=True,
            changed=False,
            archive=merged.archive,
            appended=merged.appended,
            deduplicated=merged.deduplicated,
            pruned=merged.pruned,
            rejected=merged.rejected,
            warning=warning,
        )

    # Do not create an empty archive merely because the optional file is absent or
    # malformed. A genuine retained live observation is what starts the archive.
    if (not exists or load_warning) and not merged.archive["records"]:
        return ArchiveUpdateResult(
            success=True,
            changed=False,
            archive=merged.archive,
            appended=merged.appended,
            deduplicated=merged.deduplicated,
            pruned=merged.pruned,
            rejected=merged.rejected,
            warning=warning,
        )

    try:
        _atomic_write_json(archive_path, merged.archive)
    except Exception as error:
        return ArchiveUpdateResult(
            success=False,
            changed=False,
            archive=merged.archive,
            appended=merged.appended,
            deduplicated=merged.deduplicated,
            pruned=merged.pruned,
            rejected=merged.rejected,
            warning=warning,
            error=f"ATIS history write failed safely: {error}",
        )

    return ArchiveUpdateResult(
        success=True,
        changed=True,
        archive=merged.archive,
        appended=merged.appended,
        deduplicated=merged.deduplicated,
        pruned=merged.pruned,
        rejected=merged.rejected,
        warning=warning,
    )


def records_in_range(
    archive: Mapping[str, Any],
    *,
    start_z: datetime,
    end_z: datetime,
) -> list[dict[str, Any]]:
    """Return archive records in an inclusive UTC interval, newest first."""

    start = _as_utc(start_z)
    end = _as_utc(end_z)
    if start is None or end is None or start > end:
        return []
    records = archive.get("records", []) if isinstance(archive, Mapping) else []
    if not isinstance(records, list):
        return []
    selected = []
    for record in records:
        if not isinstance(record, Mapping):
            continue
        observed = _as_utc(record.get("observedZ"))
        if observed is not None and start <= observed <= end:
            selected.append(dict(record))
    return _sort_records(selected)


__all__ = [
    "ArchiveMergeResult",
    "ArchiveUpdateResult",
    "DEFAULT_RETENTION_HOURS",
    "DEFAULT_STATION",
    "SCHEMA_VERSION",
    "load_atis_history",
    "maintain_atis_history",
    "merge_atis_history",
    "records_in_range",
]
