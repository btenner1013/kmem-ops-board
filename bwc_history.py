"""Failure-safe rolling history for live USAHAS AHAS risk at KMEM.

The operational board labels this product ``BWC``, but the stored value is the
USAHAS ``AHASRISK`` field.  This module deliberately accepts the *direct*
``fetch_ahas_bwc`` result before any last-known-good substitution.  It never
queries historical services and never seeds from ``weather.json``.

History is represented as a compact, oldest-first sequence of state and unknown
runs.  Repeated confirmations extend a state run, provenance changes split a
run, and observations separated by more than the continuity horizon are divided
by an explicit unknown interval.  File maintenance is optional and non-throwing
so a history problem cannot prevent the weather producer from publishing its
current operational data.
"""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional


SCHEMA_VERSION = 1
DEFAULT_STATION = "KMEM"
DEFAULT_PRODUCT = "USAHAS_AHAS_RISK"
DEFAULT_RETENTION_DAYS = 365
DEFAULT_CONTINUITY_MINUTES = 90
DEFAULT_SOURCE_AREA_TYPE = "ICAO"
DEFAULT_SOURCE_AREA_NAME = "MEMPHIS INTL"
DEFAULT_SOURCE_TIMESTAMP_FIELD = "DateTime"

DIRECT_FETCH_STATUS = "PARSED_DIRECT_XML"
KNOWN_STATES = frozenset({"LOW", "MODERATE", "SEVERE"})
NO_DATA_VALUES = frozenset({"", "--", "NA", "N/A", "NO DATA", "NO_DATA", "NODATA"})
FUTURE_TOLERANCE = timedelta(minutes=2)
MAX_LIVE_OBSERVATION_AGE = timedelta(minutes=DEFAULT_CONTINUITY_MINUTES)

_UTC_TIMESTAMP_RE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})[ T]"
    r"(?P<time>\d{2}:\d{2}:\d{2})"
    r"(?P<fraction>\.\d{1,6})?"
    r"(?P<zone>Z|\+00:00)?$"
)

_STATE_START_REASONS = frozenset(
    {
        "ARCHIVE_START",
        "ARCHIVE_RECOVERY",
        "STATE_CHANGE",
        "BASIS_CHANGE",
        "COVERAGE_RESUMED",
        "STATE_AFTER_GAP",
        "RETENTION_CARRY_IN",
    }
)


class BwcHistoryError(ValueError):
    """Base class for archive validation failures."""


class BwcHistoryFormatError(BwcHistoryError):
    """The archive uses schema v1 but its contents are malformed."""


class UnsupportedBwcHistorySchema(BwcHistoryError):
    """The archive was produced by a newer or otherwise unsupported schema."""


@dataclass(frozen=True)
class BwcHistoryMergeResult:
    """Result of a pure, deterministic in-memory archive merge."""

    archive: dict[str, Any]
    changed: bool
    appended: int = 0
    extended: int = 0
    unknown_added: int = 0
    pruned: int = 0
    clipped: int = 0
    rejected: int = 0
    duplicates: int = 0
    conflicts: int = 0
    out_of_order: int = 0
    warning: str = ""


@dataclass(frozen=True)
class BwcHistoryUpdateResult:
    """Non-throwing result returned by :func:`maintain_bwc_history`."""

    success: bool
    changed: bool
    archive: dict[str, Any]
    appended: int = 0
    extended: int = 0
    unknown_added: int = 0
    pruned: int = 0
    clipped: int = 0
    rejected: int = 0
    duplicates: int = 0
    conflicts: int = 0
    out_of_order: int = 0
    warning: str = ""
    error: str = ""


@dataclass(frozen=True)
class BwcCandidateValidation:
    """Canonical interpretation of one direct USAHAS response."""

    accepted: bool
    kind: str = ""
    observation: Optional[dict[str, Any]] = None
    reason: str = ""


def parse_ahas_utc(value: Any) -> Optional[datetime]:
    """Strictly parse the AHAS ``DateTime`` form as UTC.

    USAHAS currently emits a bare ``YYYY-MM-DD HH:MM:SS.sss`` value even though
    the product and board present it as Zulu.  That exact bare form, canonical
    ``Z``, and explicit ``+00:00`` are accepted.  Local offsets and loose ISO
    variants are rejected so host timezone can never affect archive chronology.
    """

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return None
        return value.astimezone(timezone.utc)

    text = str(value or "").strip()
    match = _UTC_TIMESTAMP_RE.fullmatch(text)
    if not match:
        return None

    normalized = f"{match.group('date')}T{match.group('time')}"
    if match.group("fraction"):
        normalized += match.group("fraction")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc)


def _as_aware_utc(value: Any) -> Optional[datetime]:
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    return value.astimezone(timezone.utc)


def _zulu(value: datetime) -> str:
    utc_value = value.astimezone(timezone.utc)
    base = utc_value.strftime("%Y-%m-%dT%H:%M:%S")
    if utc_value.microsecond:
        fraction = f"{utc_value.microsecond:06d}".rstrip("0")
        return f"{base}.{fraction}Z"
    return f"{base}Z"


def _normalize_station(value: Any) -> str:
    station = str(value or "").strip().upper()
    return station if re.fullmatch(r"[A-Z0-9]{4}", station) else ""


def _normalize_token(value: Any, *, fallback: str = "UNKNOWN") -> str:
    token = re.sub(r"\s+", " ", str(value or "").strip().upper())
    if not token or token in {"--", "N/A", "NA", "NO DATA"}:
        return fallback
    return token


def classify_basis(value: Any) -> tuple[str, str]:
    """Return canonical USAHAS basis and observed/model provenance class."""

    basis = _normalize_token(value)
    if basis == "NEXRAD":
        return basis, "OBSERVED_OPERATIONAL"
    if basis in {"SOAR", "NEXBAM", "BAM"}:
        return basis, "MODEL_OPERATIONAL"
    return basis, "UNKNOWN_OPERATIONAL"


def _candidate_is_fallback(candidate: Mapping[str, Any]) -> bool:
    if any(
        candidate.get(key) is True
        for key in ("isFallback", "fallback", "lastKnownGood", "isLastKnownGood")
    ):
        return True
    last_known = candidate.get("lastKnownGoodUsed")
    if isinstance(last_known, Mapping) and last_known.get("ahas") is True:
        return True
    return False


def validate_live_bwc_candidate(
    candidate: Any,
    *,
    now_z: datetime,
    station: str = DEFAULT_STATION,
) -> BwcCandidateValidation:
    """Validate and canonicalize a direct pre-fallback ``fetch_ahas_bwc`` result.

    A direct ``NO DATA`` row is accepted as ``kind='NO_DATA'`` so an established
    archive can represent unknown coverage.  It can never start an archive and
    is never normalized to a known ``NONE`` state.
    """

    now = _as_aware_utc(now_z)
    normalized_station = _normalize_station(station)
    if now is None:
        return BwcCandidateValidation(False, reason="now_z must be timezone-aware")
    if not normalized_station:
        return BwcCandidateValidation(False, reason="station must be a four-character identifier")
    if not isinstance(candidate, Mapping) or not candidate:
        return BwcCandidateValidation(False, reason="no direct USAHAS candidate")
    if candidate.get("bwcFetchStatus") != DIRECT_FETCH_STATUS:
        return BwcCandidateValidation(False, reason="candidate was not parsed from direct USAHAS XML")
    if _candidate_is_fallback(candidate):
        return BwcCandidateValidation(False, reason="last-known-good/fallback candidate is ineligible")

    candidate_station = _normalize_station(candidate.get("station") or normalized_station)
    if candidate_station != normalized_station:
        return BwcCandidateValidation(False, reason="candidate station does not match archive station")

    source = _normalize_token(candidate.get("bwcSource") or "AHAS")
    if source not in {"AHAS", "USAHAS"}:
        return BwcCandidateValidation(False, reason="candidate source is not USAHAS/AHAS")

    observed = parse_ahas_utc(candidate.get("bwcUpdatedZ"))
    if observed is None:
        return BwcCandidateValidation(False, reason="source DateTime is not strict UTC/AHAS format")
    if observed > now + FUTURE_TOLERANCE:
        return BwcCandidateValidation(False, reason="source DateTime is implausibly in the future")
    if observed < now - MAX_LIVE_OBSERVATION_AGE:
        return BwcCandidateValidation(False, reason="source DateTime is too old for a live result")

    raw_value = candidate.get("bwcAhasRisk")
    if raw_value is None:
        raw_value = candidate.get("rawAhasRisk")
    raw_risk = re.sub(r"\s+", " ", str(raw_value or "").strip().upper())
    basis, basis_class = classify_basis(candidate.get("bwcBasedOn"))
    common = {
        "station": normalized_station,
        "sourceObservedZ": _zulu(observed),
        "source": "USAHAS",
        "basis": basis,
        "basisClass": basis_class,
    }

    if raw_risk in KNOWN_STATES:
        return BwcCandidateValidation(
            True,
            kind="STATE",
            observation={**common, "state": raw_risk, "rawAhasRisk": raw_risk},
        )
    if raw_risk in NO_DATA_VALUES:
        return BwcCandidateValidation(
            True,
            kind="NO_DATA",
            observation={**common, "rawAhasRisk": "NO DATA"},
        )
    return BwcCandidateValidation(
        False,
        reason=f"raw AHASRISK is not a historical state: {raw_risk or '<missing>'}",
    )


def _empty_archive(
    station: str,
    retention_days: int,
    continuity_minutes: int,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "station": station,
        "product": DEFAULT_PRODUCT,
        "sourceArea": {
            "type": DEFAULT_SOURCE_AREA_TYPE,
            "name": DEFAULT_SOURCE_AREA_NAME,
        },
        "sourceTimestampField": DEFAULT_SOURCE_TIMESTAMP_FIELD,
        "retentionDays": retention_days,
        "continuityMinutes": continuity_minutes,
        "collectionStartedZ": "",
        "archiveUpdatedZ": "",
        "runs": [],
    }


def _required_utc(value: Any, field: str) -> tuple[datetime, str]:
    parsed = parse_ahas_utc(value)
    if parsed is None:
        raise BwcHistoryFormatError(f"{field} is not a valid UTC timestamp")
    return parsed, _zulu(parsed)


def _optional_utc(value: Any, field: str) -> tuple[Optional[datetime], str]:
    if value in (None, ""):
        return None, ""
    return _required_utc(value, field)


def _normalize_state_observations(
    run: Mapping[str, Any],
    *,
    start: datetime,
    start_reason: str,
    first: datetime,
    first_z: str,
    last: datetime,
    last_z: str,
) -> list[str]:
    """Return the exact source timestamps retained for one STATE run.

    Schema-v1 archives created before point evidence was retained contain only
    the first and last exact source timestamps plus an aggregate confirmation
    count.  Preserve those exact endpoints during normalization, but never
    manufacture timestamps for compressed interior confirmations.
    """

    if "observationsZ" not in run:
        stored = [first_z] if first == last else [first_z, last_z]
    else:
        stored = run["observationsZ"]
    if not isinstance(stored, list):
        raise BwcHistoryFormatError("STATE.observationsZ must be a list")

    normalized: list[str] = []
    observation_times: list[datetime] = []
    previous: Optional[datetime] = None
    for index, value in enumerate(stored):
        observed, observed_z = _required_utc(
            value, f"STATE.observationsZ[{index}]"
        )
        if previous is not None and observed <= previous:
            raise BwcHistoryFormatError(
                "STATE.observationsZ must be strictly increasing"
            )
        normalized.append(observed_z)
        observation_times.append(observed)
        previous = observed

    if start_reason == "RETENTION_CARRY_IN":
        if last < start:
            if normalized:
                raise BwcHistoryFormatError(
                    "STATE.observationsZ conflicts with aged-out carry-in bounds"
                )
            return []
        if (
            not normalized
            or normalized[-1] != last_z
            or any(observed < start or observed > last for observed in observation_times)
        ):
            raise BwcHistoryFormatError(
                "STATE.observationsZ conflicts with retained observation bounds"
            )
        return normalized

    if not normalized or normalized[0] != first_z or normalized[-1] != last_z:
        raise BwcHistoryFormatError(
            "STATE.observationsZ endpoints conflict with observation bounds"
        )
    return normalized


def _normalize_state_run(run: Mapping[str, Any], continuity: timedelta) -> dict[str, Any]:
    state = str(run.get("state") or "").strip().upper()
    raw_risk = str(run.get("rawAhasRisk") or "").strip().upper()
    if state not in KNOWN_STATES or raw_risk != state:
        raise BwcHistoryFormatError("STATE run has an invalid state/rawAhasRisk")

    start, start_z = _required_utc(run.get("startZ"), "STATE.startZ")
    first, first_z = _required_utc(run.get("firstObservedZ"), "STATE.firstObservedZ")
    last, last_z = _required_utc(run.get("lastObservedZ"), "STATE.lastObservedZ")
    first_recorded, first_recorded_z = _required_utc(
        run.get("firstRecordedZ"), "STATE.firstRecordedZ"
    )
    last_recorded, last_recorded_z = _required_utc(
        run.get("lastRecordedZ"), "STATE.lastRecordedZ"
    )
    if first > last or first_recorded > last_recorded:
        raise BwcHistoryFormatError("STATE run timestamps are reversed")

    start_reason = str(run.get("startReason") or "").strip().upper()
    if start_reason not in _STATE_START_REASONS:
        raise BwcHistoryFormatError("STATE.startReason is unsupported")
    if start > last and (
        start_reason != "RETENTION_CARRY_IN" or start > last + continuity
    ):
        raise BwcHistoryFormatError("STATE start exceeds its usable observation coverage")

    try:
        confirmation_count = int(run.get("confirmationCount"))
    except (TypeError, ValueError) as error:
        raise BwcHistoryFormatError("STATE.confirmationCount is invalid") from error
    if confirmation_count < 1:
        raise BwcHistoryFormatError("STATE.confirmationCount must be positive")

    observations_z = _normalize_state_observations(
        run,
        start=start,
        start_reason=start_reason,
        first=first,
        first_z=first_z,
        last=last,
        last_z=last_z,
    )

    basis, basis_class = classify_basis(run.get("basis"))
    stored_basis_class = str(run.get("basisClass") or "").strip().upper()
    if stored_basis_class and stored_basis_class != basis_class:
        raise BwcHistoryFormatError("STATE basisClass conflicts with basis")
    if _normalize_token(run.get("source"), fallback="") != "USAHAS":
        raise BwcHistoryFormatError("STATE.source must be USAHAS")

    normalized = {
        "kind": "STATE",
        "state": state,
        "rawAhasRisk": raw_risk,
        "startZ": start_z,
        "firstObservedZ": first_z,
        "lastObservedZ": last_z,
        "observationsZ": observations_z,
        "firstRecordedZ": first_recorded_z,
        "lastRecordedZ": last_recorded_z,
        "confirmationCount": confirmation_count,
        "startReason": start_reason,
        "source": "USAHAS",
        "basis": basis,
        "basisClass": basis_class,
    }
    if start_reason == "RETENTION_CARRY_IN":
        original = str(run.get("originalStartReason") or "").strip().upper()
        if original and original not in _STATE_START_REASONS:
            raise BwcHistoryFormatError("STATE.originalStartReason is unsupported")
        if original:
            normalized["originalStartReason"] = original
    return normalized


def _normalize_unknown_run(run: Mapping[str, Any]) -> dict[str, Any]:
    start, start_z = _required_utc(run.get("startZ"), "UNKNOWN.startZ")
    end, end_z = _optional_utc(run.get("endZ"), "UNKNOWN.endZ")
    if end is not None and end <= start:
        raise BwcHistoryFormatError("UNKNOWN interval must end after it starts")

    reason = str(run.get("reason") or "").strip().upper()
    if reason not in {"COVERAGE_GAP", "SOURCE_NO_DATA"}:
        raise BwcHistoryFormatError("UNKNOWN.reason is unsupported")

    first, first_z = _optional_utc(run.get("firstObservedZ"), "UNKNOWN.firstObservedZ")
    last, last_z = _optional_utc(run.get("lastObservedZ"), "UNKNOWN.lastObservedZ")
    first_recorded, first_recorded_z = _optional_utc(
        run.get("firstRecordedZ"), "UNKNOWN.firstRecordedZ"
    )
    last_recorded, last_recorded_z = _optional_utc(
        run.get("lastRecordedZ"), "UNKNOWN.lastRecordedZ"
    )
    try:
        confirmation_count = int(run.get("confirmationCount", 0))
    except (TypeError, ValueError) as error:
        raise BwcHistoryFormatError("UNKNOWN.confirmationCount is invalid") from error
    evidence_values = (first, last, first_recorded, last_recorded)
    if reason == "COVERAGE_GAP":
        if confirmation_count != 0 or any(value is not None for value in evidence_values):
            raise BwcHistoryFormatError(
                "UNKNOWN COVERAGE_GAP must not claim observation evidence"
            )
    elif confirmation_count < 1 or any(value is None for value in evidence_values):
        raise BwcHistoryFormatError("UNKNOWN SOURCE_NO_DATA evidence is incomplete")
    else:
        if first > last or first_recorded > last_recorded:
            raise BwcHistoryFormatError("UNKNOWN observation timestamps are reversed")
    if _normalize_token(run.get("source"), fallback="") != "USAHAS":
        raise BwcHistoryFormatError("UNKNOWN.source must be USAHAS")

    normalized = {
        "kind": "UNKNOWN",
        "startZ": start_z,
        "endZ": end_z,
        "reason": reason,
        "source": "USAHAS",
        "firstObservedZ": first_z,
        "lastObservedZ": last_z,
        "firstRecordedZ": first_recorded_z,
        "lastRecordedZ": last_recorded_z,
        "confirmationCount": confirmation_count,
    }
    if run.get("carryIn") is True:
        normalized["carryIn"] = True
    return normalized


def _normalize_archive(
    existing_archive: Any,
    *,
    station: str,
    retention_days: int,
    continuity_minutes: int,
) -> dict[str, Any]:
    if existing_archive in (None, {}):
        return _empty_archive(station, retention_days, continuity_minutes)
    if not isinstance(existing_archive, Mapping):
        raise BwcHistoryFormatError("archive root is not an object")

    version = existing_archive.get("schemaVersion")
    if version != SCHEMA_VERSION:
        if isinstance(version, int) and version > SCHEMA_VERSION:
            raise UnsupportedBwcHistorySchema(
                f"BWC history schema {version} is newer than supported schema {SCHEMA_VERSION}"
            )
        raise BwcHistoryFormatError("archive schemaVersion is missing or unsupported")
    if _normalize_station(existing_archive.get("station")) != station:
        raise BwcHistoryFormatError("archive station does not match")
    if existing_archive.get("product") != DEFAULT_PRODUCT:
        raise BwcHistoryFormatError("archive product does not match")

    source_area = existing_archive.get("sourceArea")
    if not isinstance(source_area, Mapping):
        raise BwcHistoryFormatError("archive sourceArea is invalid")
    if (
        str(source_area.get("type") or "").strip().upper() != DEFAULT_SOURCE_AREA_TYPE
        or str(source_area.get("name") or "").strip().upper()
        != DEFAULT_SOURCE_AREA_NAME
    ):
        raise BwcHistoryFormatError("archive sourceArea does not match")
    if existing_archive.get("sourceTimestampField") != DEFAULT_SOURCE_TIMESTAMP_FIELD:
        raise BwcHistoryFormatError("archive sourceTimestampField does not match")

    runs_value = existing_archive.get("runs")
    if not isinstance(runs_value, list):
        raise BwcHistoryFormatError("archive runs is not a list")

    continuity = timedelta(minutes=continuity_minutes)
    runs: list[dict[str, Any]] = []
    for index, raw_run in enumerate(runs_value):
        if not isinstance(raw_run, Mapping):
            raise BwcHistoryFormatError(f"archive run {index} is not an object")
        kind = str(raw_run.get("kind") or "").strip().upper()
        if kind == "STATE":
            runs.append(_normalize_state_run(raw_run, continuity))
        elif kind == "UNKNOWN":
            runs.append(_normalize_unknown_run(raw_run))
        else:
            raise BwcHistoryFormatError(f"archive run {index} has unsupported kind")

    runs.sort(
        key=lambda run: (
            parse_ahas_utc(run["startZ"]),
            0 if run["kind"] == "UNKNOWN" else 1,
        )
    )
    for index, run in enumerate(runs[:-1]):
        next_run = runs[index + 1]
        if parse_ahas_utc(run["startZ"]) == parse_ahas_utc(next_run["startZ"]):
            raise BwcHistoryFormatError("archive runs have ambiguous start timestamps")
        if run["kind"] == "UNKNOWN" and not run["endZ"]:
            raise BwcHistoryFormatError("only the final UNKNOWN interval may be open")
        if run["kind"] == "UNKNOWN" and parse_ahas_utc(run["endZ"]) > parse_ahas_utc(
            next_run["startZ"]
        ):
            raise BwcHistoryFormatError("UNKNOWN interval overlaps a later run")

    collection_started, collection_started_z = _optional_utc(
        existing_archive.get("collectionStartedZ"), "collectionStartedZ"
    )
    archive_updated, archive_updated_z = _optional_utc(
        existing_archive.get("archiveUpdatedZ"), "archiveUpdatedZ"
    )
    if runs and collection_started is None:
        recorded_values = [
            parse_ahas_utc(run.get("firstRecordedZ"))
            for run in runs
            if run.get("firstRecordedZ")
        ]
        recorded_values = [value for value in recorded_values if value is not None]
        if not recorded_values:
            raise BwcHistoryFormatError("archive with runs lacks collectionStartedZ")
        collection_started = min(recorded_values)
        collection_started_z = _zulu(collection_started)
    if runs and archive_updated is None:
        recorded_values = [
            parse_ahas_utc(run.get("lastRecordedZ"))
            for run in runs
            if run.get("lastRecordedZ")
        ]
        recorded_values = [value for value in recorded_values if value is not None]
        if not recorded_values:
            raise BwcHistoryFormatError("archive with runs lacks archiveUpdatedZ")
        archive_updated_z = _zulu(max(recorded_values))

    return {
        "schemaVersion": SCHEMA_VERSION,
        "station": station,
        "product": DEFAULT_PRODUCT,
        "sourceArea": {
            "type": DEFAULT_SOURCE_AREA_TYPE,
            "name": DEFAULT_SOURCE_AREA_NAME,
        },
        "sourceTimestampField": DEFAULT_SOURCE_TIMESTAMP_FIELD,
        "retentionDays": retention_days,
        "continuityMinutes": continuity_minutes,
        "collectionStartedZ": collection_started_z,
        "archiveUpdatedZ": archive_updated_z,
        "runs": runs,
    }


def _new_state_run(
    observation: Mapping[str, Any], recorded_z: str, start_reason: str
) -> dict[str, Any]:
    observed_z = str(observation["sourceObservedZ"])
    return {
        "kind": "STATE",
        "state": observation["state"],
        "rawAhasRisk": observation["rawAhasRisk"],
        "startZ": observed_z,
        "firstObservedZ": observed_z,
        "lastObservedZ": observed_z,
        "observationsZ": [observed_z],
        "firstRecordedZ": recorded_z,
        "lastRecordedZ": recorded_z,
        "confirmationCount": 1,
        "startReason": start_reason,
        "source": "USAHAS",
        "basis": observation["basis"],
        "basisClass": observation["basisClass"],
    }


def _new_unknown_run(
    *,
    start_z: str,
    end_z: str,
    reason: str,
    observation_z: str = "",
    recorded_z: str = "",
) -> dict[str, Any]:
    has_evidence = bool(observation_z)
    return {
        "kind": "UNKNOWN",
        "startZ": start_z,
        "endZ": end_z,
        "reason": reason,
        "source": "USAHAS",
        "firstObservedZ": observation_z,
        "lastObservedZ": observation_z,
        "firstRecordedZ": recorded_z if has_evidence else "",
        "lastRecordedZ": recorded_z if has_evidence else "",
        "confirmationCount": 1 if has_evidence else 0,
    }


def _last_state(runs: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    for run in reversed(runs):
        if run["kind"] == "STATE":
            return run
    return None


def _latest_observation(runs: list[dict[str, Any]]) -> tuple[Optional[datetime], str, Any]:
    latest: Optional[tuple[datetime, str, Any]] = None
    for run in runs:
        if run["kind"] == "STATE":
            observed = parse_ahas_utc(run["lastObservedZ"])
            payload: Any = (run["state"], run["basis"], run["basisClass"])
            kind = "STATE"
        elif run.get("lastObservedZ"):
            observed = parse_ahas_utc(run["lastObservedZ"])
            payload = "NO DATA"
            kind = "NO_DATA"
        else:
            continue
        if observed is not None and (latest is None or observed > latest[0]):
            latest = (observed, kind, payload)
    return latest if latest is not None else (None, "", None)


def _state_coverage_end(
    runs: list[dict[str, Any]], index: int, *, now: datetime, continuity: timedelta
) -> datetime:
    """Return the truthful end of a state's usable continuity coverage.

    The retained start may be clipped to the 365-day cutoff without inventing a
    source observation there.  A real observation just before the cutoff can
    still cover part of the retained window through the approved 90-minute
    horizon, bounded by the next run and by ``now``.
    """

    run = runs[index]
    coverage_end = min(parse_ahas_utc(run["lastObservedZ"]) + continuity, now)
    if index + 1 < len(runs):
        coverage_end = min(coverage_end, parse_ahas_utc(runs[index + 1]["startZ"]))
    return coverage_end


def _prune_runs(
    runs: list[dict[str, Any]],
    *,
    now: datetime,
    cutoff: datetime,
    continuity: timedelta,
) -> tuple[list[dict[str, Any]], int, int]:
    retained: list[dict[str, Any]] = []
    pruned = 0
    clipped = 0
    for index, original in enumerate(runs):
        run = copy.deepcopy(original)
        start = parse_ahas_utc(run["startZ"])
        if run["kind"] == "STATE":
            usable_end = _state_coverage_end(runs, index, now=now, continuity=continuity)
        else:
            usable_end = parse_ahas_utc(run["endZ"]) if run["endZ"] else now
        if usable_end < cutoff:
            pruned += 1
            continue
        if start < cutoff:
            run["startZ"] = _zulu(cutoff)
            clipped += 1
            if run["kind"] == "STATE":
                run["observationsZ"] = [
                    observed_z
                    for observed_z in run["observationsZ"]
                    if parse_ahas_utc(observed_z) >= cutoff
                ]
                if run["startReason"] != "RETENTION_CARRY_IN":
                    run["originalStartReason"] = run["startReason"]
                run["startReason"] = "RETENTION_CARRY_IN"
            else:
                run["carryIn"] = True
        retained.append(run)
    return retained, pruned, clipped


def merge_bwc_history(
    existing_archive: Any,
    direct_candidate: Any,
    *,
    now_z: datetime,
    station: str = DEFAULT_STATION,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    continuity_minutes: int = DEFAULT_CONTINUITY_MINUTES,
    initial_start_reason: str = "ARCHIVE_START",
) -> BwcHistoryMergeResult:
    """Purely merge one direct live USAHAS candidate into schema-v1 history."""

    now = _as_aware_utc(now_z)
    normalized_station = _normalize_station(station)
    if now is None:
        raise ValueError("now_z must be timezone-aware")
    if not normalized_station:
        raise ValueError("station must be a four-character identifier")
    if not isinstance(retention_days, int) or retention_days <= 0:
        raise ValueError("retention_days must be a positive integer")
    if not isinstance(continuity_minutes, int) or continuity_minutes <= 0:
        raise ValueError("continuity_minutes must be a positive integer")
    if initial_start_reason not in {"ARCHIVE_START", "ARCHIVE_RECOVERY"}:
        raise ValueError("initial_start_reason is invalid")

    canonical_existing = _normalize_archive(
        existing_archive,
        station=normalized_station,
        retention_days=retention_days,
        continuity_minutes=continuity_minutes,
    )
    archive = copy.deepcopy(canonical_existing)
    runs = archive["runs"]
    recorded_z = _zulu(now)
    continuity = timedelta(minutes=continuity_minutes)
    cutoff = now - timedelta(days=retention_days)
    warnings: list[str] = []

    appended = 0
    extended = 0
    unknown_added = 0
    rejected = 0
    duplicates = 0
    conflicts = 0
    out_of_order = 0

    validation = validate_live_bwc_candidate(
        direct_candidate, now_z=now, station=normalized_station
    )
    if validation.accepted:
        observation = validation.observation or {}
        observed = parse_ahas_utc(observation["sourceObservedZ"])
        latest_time, latest_kind, latest_payload = _latest_observation(runs)
        payload = (
            (observation.get("state"), observation["basis"], observation["basisClass"])
            if validation.kind == "STATE"
            else "NO DATA"
        )

        if latest_time is not None and observed < latest_time:
            rejected += 1
            out_of_order += 1
            warnings.append("rejected out-of-order USAHAS source timestamp")
        elif latest_time is not None and observed == latest_time:
            if validation.kind == latest_kind and payload == latest_payload:
                duplicates += 1
            else:
                rejected += 1
                conflicts += 1
                warnings.append("rejected conflicting USAHAS value for an accepted source timestamp")
        elif validation.kind == "NO_DATA":
            previous_state = _last_state(runs)
            if previous_state is None:
                rejected += 1
                warnings.append("NO DATA cannot start a BWC archive")
            elif runs and runs[-1]["kind"] == "UNKNOWN" and not runs[-1]["endZ"]:
                unknown = runs[-1]
                unknown["lastObservedZ"] = observation["sourceObservedZ"]
                unknown["lastRecordedZ"] = recorded_z
                unknown["confirmationCount"] += 1
                extended += 1
            else:
                prior_observed = parse_ahas_utc(previous_state["lastObservedZ"])
                horizon_end = prior_observed + continuity
                unknown_start = min(observed, horizon_end)
                runs.append(
                    _new_unknown_run(
                        start_z=_zulu(unknown_start),
                        end_z="",
                        reason="SOURCE_NO_DATA",
                        observation_z=observation["sourceObservedZ"],
                        recorded_z=recorded_z,
                    )
                )
                unknown_added += 1
        else:
            previous_state = _last_state(runs)
            if previous_state is None:
                start_reason = (
                    initial_start_reason
                    if not archive["collectionStartedZ"]
                    else "COVERAGE_RESUMED"
                )
                runs.append(_new_state_run(observation, recorded_z, start_reason))
                appended += 1
            elif runs and runs[-1]["kind"] == "UNKNOWN" and not runs[-1]["endZ"]:
                runs[-1]["endZ"] = observation["sourceObservedZ"]
                start_reason = (
                    "COVERAGE_RESUMED"
                    if observation["state"] == previous_state["state"]
                    else "STATE_AFTER_GAP"
                )
                runs.append(_new_state_run(observation, recorded_z, start_reason))
                appended += 1
            else:
                prior_observed = parse_ahas_utc(previous_state["lastObservedZ"])
                elapsed = observed - prior_observed
                same_state = observation["state"] == previous_state["state"]
                same_basis = (
                    observation["basis"] == previous_state["basis"]
                    and observation["basisClass"] == previous_state["basisClass"]
                )
                if elapsed > continuity:
                    gap_start = prior_observed + continuity
                    runs.append(
                        _new_unknown_run(
                            start_z=_zulu(gap_start),
                            end_z=observation["sourceObservedZ"],
                            reason="COVERAGE_GAP",
                        )
                    )
                    unknown_added += 1
                    start_reason = "COVERAGE_RESUMED" if same_state else "STATE_AFTER_GAP"
                    runs.append(_new_state_run(observation, recorded_z, start_reason))
                    appended += 1
                elif same_state and same_basis:
                    previous_state["lastObservedZ"] = observation["sourceObservedZ"]
                    previous_state["lastRecordedZ"] = recorded_z
                    previous_state["observationsZ"].append(
                        observation["sourceObservedZ"]
                    )
                    previous_state["confirmationCount"] += 1
                    extended += 1
                else:
                    start_reason = "BASIS_CHANGE" if same_state else "STATE_CHANGE"
                    runs.append(_new_state_run(observation, recorded_z, start_reason))
                    appended += 1
    elif direct_candidate not in (None, {}):
        rejected += 1
        warnings.append(validation.reason)

    pruned_runs, pruned, clipped = _prune_runs(
        runs, now=now, cutoff=cutoff, continuity=continuity
    )
    archive["runs"] = pruned_runs

    has_mutation = archive != canonical_existing
    if has_mutation:
        if not archive["collectionStartedZ"] and any(
            run["kind"] == "STATE" for run in archive["runs"]
        ):
            archive["collectionStartedZ"] = recorded_z
        archive["archiveUpdatedZ"] = recorded_z

    if existing_archive in (None, {}) and not archive["runs"]:
        changed = False
    else:
        changed = archive != canonical_existing or (
            isinstance(existing_archive, Mapping) and dict(existing_archive) != canonical_existing
        )
        if changed and archive == canonical_existing:
            archive["archiveUpdatedZ"] = recorded_z

    return BwcHistoryMergeResult(
        archive=archive,
        changed=changed,
        appended=appended,
        extended=extended,
        unknown_added=unknown_added,
        pruned=pruned,
        clipped=clipped,
        rejected=rejected,
        duplicates=duplicates,
        conflicts=conflicts,
        out_of_order=out_of_order,
        warning="; ".join(part for part in warnings if part),
    )


def load_bwc_history(path: os.PathLike[str] | str) -> tuple[Any, str, bool]:
    """Load raw JSON without raising, returning ``(value, warning, exists)``."""

    archive_path = Path(path)
    try:
        with archive_path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
    except FileNotFoundError:
        return {}, "", False
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return {}, f"unable to load BWC history: {error}", archive_path.exists()
    if not isinstance(value, dict):
        return value, "BWC history root is not an object", True
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


def _update_from_merge(
    merged: BwcHistoryMergeResult,
    *,
    success: bool,
    changed: bool,
    warning: str = "",
    error: str = "",
) -> BwcHistoryUpdateResult:
    return BwcHistoryUpdateResult(
        success=success,
        changed=changed,
        archive=merged.archive,
        appended=merged.appended,
        extended=merged.extended,
        unknown_added=merged.unknown_added,
        pruned=merged.pruned,
        clipped=merged.clipped,
        rejected=merged.rejected,
        duplicates=merged.duplicates,
        conflicts=merged.conflicts,
        out_of_order=merged.out_of_order,
        warning="; ".join(part for part in (warning, merged.warning) if part),
        error=error,
    )


def maintain_bwc_history(
    path: os.PathLike[str] | str,
    direct_candidate: Any,
    *,
    now_z: Optional[datetime] = None,
    station: str = DEFAULT_STATION,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    continuity_minutes: int = DEFAULT_CONTINUITY_MINUTES,
) -> BwcHistoryUpdateResult:
    """Safely update ``bwc_history.json`` without propagating any exception."""

    archive_path = Path(path)
    now = _as_aware_utc(now_z or datetime.now(timezone.utc))
    if now is None:
        return BwcHistoryUpdateResult(
            success=False,
            changed=False,
            archive={},
            error="BWC history merge failed safely: now_z must be timezone-aware",
        )

    raw_existing, load_warning, exists = load_bwc_history(archive_path)
    malformed = bool(load_warning)
    if malformed and load_warning.startswith("unable to load BWC history") and exists:
        # JSON/Unicode corruption can be recovered from a new truthful live
        # state.  A genuine filesystem read failure is different: do not risk
        # replacing bytes we could not inspect.
        try:
            archive_path.read_bytes()
        except OSError as error:
            return BwcHistoryUpdateResult(
                success=False,
                changed=False,
                archive={},
                warning=load_warning,
                error=f"BWC history read failed safely: {error}",
            )
    try:
        if malformed:
            if isinstance(raw_existing, Mapping):
                version = raw_existing.get("schemaVersion")
                if isinstance(version, int) and version > SCHEMA_VERSION:
                    raise UnsupportedBwcHistorySchema(
                        f"BWC history schema {version} is newer than supported schema {SCHEMA_VERSION}"
                    )
            raise BwcHistoryFormatError(load_warning)
        merged = merge_bwc_history(
            raw_existing,
            direct_candidate,
            now_z=now,
            station=station,
            retention_days=retention_days,
            continuity_minutes=continuity_minutes,
        )
    except UnsupportedBwcHistorySchema as error:
        return BwcHistoryUpdateResult(
            success=False,
            changed=False,
            archive=raw_existing if isinstance(raw_existing, dict) else {},
            warning=load_warning,
            error=f"BWC history schema rejected safely: {error}",
        )
    except BwcHistoryFormatError as error:
        recovery_warning = "; ".join(
            part for part in (load_warning, f"malformed BWC history: {error}") if part
        )
        try:
            recovered = merge_bwc_history(
                {},
                direct_candidate,
                now_z=now,
                station=station,
                retention_days=retention_days,
                continuity_minutes=continuity_minutes,
                initial_start_reason="ARCHIVE_RECOVERY",
            )
        except Exception as recovery_error:
            return BwcHistoryUpdateResult(
                success=False,
                changed=False,
                archive=raw_existing if isinstance(raw_existing, dict) else {},
                warning=recovery_warning,
                error=f"BWC history recovery failed safely: {recovery_error}",
            )
        if not any(run["kind"] == "STATE" for run in recovered.archive["runs"]):
            return _update_from_merge(
                recovered,
                success=False,
                changed=False,
                warning=recovery_warning,
                error="BWC history was malformed and no valid live state was available for recovery",
            )
        merged = recovered
        load_warning = recovery_warning
    except Exception as error:
        return BwcHistoryUpdateResult(
            success=False,
            changed=False,
            archive=raw_existing if isinstance(raw_existing, dict) else {},
            warning=load_warning,
            error=f"BWC history merge failed safely: {error}",
        )

    warning = "; ".join(part for part in (load_warning, merged.warning) if part)
    if not merged.changed:
        return _update_from_merge(
            merged, success=True, changed=False, warning=load_warning
        )

    # A missing optional archive starts only from a genuine known live state.
    if not exists and not any(run["kind"] == "STATE" for run in merged.archive["runs"]):
        return _update_from_merge(
            merged, success=True, changed=False, warning=load_warning
        )

    try:
        _atomic_write_json(archive_path, merged.archive)
    except Exception as error:
        return _update_from_merge(
            merged,
            success=False,
            changed=False,
            warning=load_warning,
            error=f"BWC history write failed safely: {error}",
        )

    return _update_from_merge(
        merged, success=True, changed=True, warning=load_warning
    )


__all__ = [
    "BwcCandidateValidation",
    "BwcHistoryFormatError",
    "BwcHistoryMergeResult",
    "BwcHistoryUpdateResult",
    "DEFAULT_CONTINUITY_MINUTES",
    "DEFAULT_PRODUCT",
    "DEFAULT_RETENTION_DAYS",
    "DEFAULT_STATION",
    "KNOWN_STATES",
    "SCHEMA_VERSION",
    "UnsupportedBwcHistorySchema",
    "classify_basis",
    "load_bwc_history",
    "maintain_bwc_history",
    "merge_bwc_history",
    "parse_ahas_utc",
    "validate_live_bwc_candidate",
]
