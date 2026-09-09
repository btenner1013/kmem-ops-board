"""Read-only, failure-isolated host-health history for the KMEM updater.

The updater's lease and heartbeat logic remains authoritative.  This module
only converts already-published status/lease evidence into a compact rolling
archive for display.  It never acquires a lease, changes a threshold, or makes
an ownership decision.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional


SCHEMA_VERSION = 1
DEFAULT_RETENTION_DAYS = 365
DEFAULT_EXACT_HISTORY_DAYS = 2
DEFAULT_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_STORED_ROWS = 25_000
HOST_ROLES = ("PRIMARY", "BACKUP")
CRITICAL_EXACT_EVENT_TYPES = frozenset(
    {
        "ACTIVE_PRIMARY",
        "ACTIVE_BACKUP",
        "PRIMARY_STALE",
        "PRIMARY_UNAVAILABLE",
        "PRIMARY_ERROR",
        "PRIMARY_RECOVERED",
        "BACKUP_STALE",
        "BACKUP_UNAVAILABLE",
        "BACKUP_ERROR",
        "BACKUP_RECOVERED",
        "BACKUP_TAKEOVER",
        "PRIMARY_HANDOFF",
        "PRIMARY_HANDOFF_COMPLETE",
        "PRIMARY_HANDOFF_FAILED",
        "PRIMARY_HANDOFF_INCOMPLETE",
        "BOARD_PUBLISH_GAP",
        "BOARD_PUBLISH_RECOVERED",
        "LEASE_ACQUIRED",
        "LEASE_RELEASED",
        "LEASE_EXPIRED",
    }
)


class HostHealthHistoryError(ValueError):
    """An existing host-health archive is unsafe to extend."""


def _as_utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("now_z must be timezone-aware")
    return value.astimezone(timezone.utc)


def _parse_utc(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _zulu(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _minutes_between(start: datetime, end: datetime) -> float:
    return max(0.0, (end - start).total_seconds() / 60.0)


def _empty_host(role: str) -> dict[str, Any]:
    return {
        "role": role,
        "healthState": "UNKNOWN",
        "roleState": "NOT_OBSERVED",
        "reason": "NO_RETAINED_HEARTBEAT",
        "heartbeatAgeMinutes": None,
        "lastObservedHealthState": "UNKNOWN",
        "lastHeartbeatUtc": None,
        "lastSuccessfulUpdaterRunUtc": None,
        "lastSuccessfulPushUtc": None,
        "lastKnownSourceSha": None,
        "lastError": None,
        "taskState": "UNKNOWN",
        "evidenceUpdatedUtc": None,
    }


def _empty_archive(
    retention_days: int,
    healthy_minutes: float,
    failover_minutes: float,
    board_gap_minutes: float,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "retentionDays": retention_days,
        "exactHistoryDays": DEFAULT_EXACT_HISTORY_DAYS,
        "exactHistoryStartUtc": None,
        "summarizedThroughUtc": None,
        "summaryCoverageStartUtc": None,
        "retentionBoundaryGap": None,
        "archiveStartedUtc": None,
        "coverageStartUtc": None,
        "updatedUtc": None,
        "partialHistory": True,
        "thresholds": {
            "healthyMinutes": healthy_minutes,
            "failoverMinutes": failover_minutes,
            "boardGapMinutes": board_gap_minutes,
        },
        "hosts": {role: _empty_host(role) for role in HOST_ROLES},
        "current": {
            "publisher": {
                "role": "UNKNOWN",
                "sinceUtc": None,
                "sinceTimestampBasis": "NO_DATA",
                "lastSuccessfulPublishUtc": None,
                "lastSuccessfulPushUtc": None,
                "reason": "NO_VALID_PUBLISHER",
                "rootCauseKnown": False,
            },
            "boardDelivery": {
                "state": "UNKNOWN",
                "lastSuccessfulPublishUtc": None,
                "publisher": "UNKNOWN",
                "ageMinutes": None,
                "reason": "NO_SUCCESSFUL_BOARD_PUBLISH",
            },
            "lease": {
                "state": "UNKNOWN",
                "activeOwner": None,
                "lastOwner": None,
                "acquiredUtc": None,
                "expiresUtc": None,
                "releasedUtc": None,
                "observedUtc": None,
            },
        },
        "intervals": [],
        "events": [],
        "dailySummaries": [],
        "storagePolicy": {
            "mode": "EXACT_RECENT_WITH_UTC_DAILY_AGGREGATES",
            "exactHistoryDays": DEFAULT_EXACT_HISTORY_DAYS,
            "aggregateTimeBasis": "UTC",
            "criticalEventTypesRetainedExact": sorted(CRITICAL_EXACT_EVENT_TYPES),
        },
    }


def _normalize_archive(
    existing: Any,
    *,
    retention_days: int,
    healthy_minutes: float,
    failover_minutes: float,
    board_gap_minutes: float,
) -> dict[str, Any]:
    if existing in (None, {}):
        return _empty_archive(retention_days, healthy_minutes, failover_minutes, board_gap_minutes)
    if not isinstance(existing, Mapping):
        raise HostHealthHistoryError("host-health archive root is not an object")
    if existing.get("schemaVersion") != SCHEMA_VERSION:
        raise HostHealthHistoryError("host-health archive schemaVersion is unsupported")
    if not isinstance(existing.get("hosts"), Mapping):
        raise HostHealthHistoryError("host-health hosts are missing")
    if not isinstance(existing.get("current"), Mapping):
        raise HostHealthHistoryError("host-health current state is missing")
    if not isinstance(existing.get("intervals"), list) or not isinstance(existing.get("events"), list):
        raise HostHealthHistoryError("host-health history collections are malformed")
    if "dailySummaries" in existing and not isinstance(existing.get("dailySummaries"), list):
        raise HostHealthHistoryError("host-health daily summaries are malformed")

    archive = copy.deepcopy(dict(existing))
    archive["retentionDays"] = retention_days
    archive.setdefault("dailySummaries", [])
    archive.setdefault("exactHistoryDays", DEFAULT_EXACT_HISTORY_DAYS)
    archive.setdefault("exactHistoryStartUtc", None)
    archive.setdefault("summarizedThroughUtc", None)
    archive.setdefault("summaryCoverageStartUtc", None)
    archive.setdefault("retentionBoundaryGap", None)
    archive.setdefault(
        "storagePolicy",
        {
            "mode": "EXACT_RECENT_WITH_UTC_DAILY_AGGREGATES",
            "exactHistoryDays": DEFAULT_EXACT_HISTORY_DAYS,
            "aggregateTimeBasis": "UTC",
            "criticalEventTypesRetainedExact": sorted(CRITICAL_EXACT_EVENT_TYPES),
        },
    )
    archive["thresholds"] = {
        "healthyMinutes": healthy_minutes,
        "failoverMinutes": failover_minutes,
        "boardGapMinutes": board_gap_minutes,
    }
    hosts = archive["hosts"]
    for role in HOST_ROLES:
        if not isinstance(hosts.get(role), Mapping):
            hosts[role] = _empty_host(role)
        else:
            canonical = _empty_host(role)
            canonical.update(copy.deepcopy(dict(hosts[role])))
            canonical["role"] = role
            hosts[role] = canonical
    return archive


def _status_role(status: Any) -> str:
    if not isinstance(status, Mapping):
        return "UNKNOWN"
    role = str(status.get("activeRole") or "").strip().upper()
    return role if role in HOST_ROLES else "UNKNOWN"


def _status_time(status: Any) -> Optional[datetime]:
    if not isinstance(status, Mapping):
        return None
    return _parse_utc(status.get("heartbeatUtc"))


def _source_sha(status: Mapping[str, Any]) -> Optional[str]:
    for key in ("runningCodeSha", "runningSha", "originMainSha"):
        value = str(status.get(key) or "").strip()
        if value:
            return value
    return None


def _capture_host_evidence(archive: dict[str, Any], status: Mapping[str, Any], observed: datetime) -> str:
    role = _status_role(status)
    if role not in HOST_ROLES:
        return "UNKNOWN"
    host = archive["hosts"][role]
    heartbeat = _parse_utc(status.get("heartbeatUtc"))
    host.update(
        {
            "lastHeartbeatUtc": _zulu(heartbeat) if heartbeat is not None else None,
            "lastSuccessfulUpdaterRunUtc": (
                _zulu(value) if (value := _parse_utc(status.get("lastSuccessfulUpdateUtc"))) else None
            ),
            "lastSuccessfulPushUtc": (
                _zulu(value) if (value := _parse_utc(status.get("lastSuccessfulPushUtc"))) else None
            ),
            "lastKnownSourceSha": _source_sha(status),
            "lastError": str(status.get("lastError") or "").strip() or None,
            "evidenceUpdatedUtc": _zulu(observed),
        }
    )
    host["_lastUpdateStatus"] = str(status.get("updateStatus") or "").strip().upper()
    return role


def _classify_host(
    host: Mapping[str, Any],
    now: datetime,
    healthy: float,
    failover: float,
) -> tuple[str, str, Optional[float]]:
    heartbeat = _parse_utc(host.get("lastHeartbeatUtc"))
    if heartbeat is None:
        return "UNKNOWN", "NO_RETAINED_HEARTBEAT", None
    raw_age = (now - heartbeat).total_seconds() / 60.0
    if raw_age < 0:
        return "UNAVAILABLE", "FUTURE_HEARTBEAT", None
    age = max(0.0, raw_age)
    if age > failover:
        return "STALE", "HEARTBEAT_EXCEEDED_FAILOVER_THRESHOLD", age
    if str(host.get("_lastUpdateStatus") or "").upper() == "ERROR" or host.get("lastError"):
        return "ERROR", str(host.get("lastError") or "UPDATER_ERROR"), age
    if age > healthy:
        return "DELAYED", "HEARTBEAT_EXCEEDED_HEALTHY_THRESHOLD", age
    return "HEALTHY", "HEARTBEAT_CURRENT", age


def _board_state(
    status: Mapping[str, Any],
    now: datetime,
    healthy: float,
    board_gap: float,
) -> dict[str, Any]:
    role = _status_role(status)
    published = _parse_utc(status.get("lastSuccessfulUpdateUtc"))
    if published is None or published > now:
        return {
            "state": "UNKNOWN",
            "lastSuccessfulPublishUtc": None if published is None else _zulu(published),
            "publisher": role,
            "ageMinutes": None,
            "reason": "NO_SUCCESSFUL_BOARD_PUBLISH" if published is None else "FUTURE_PUBLISH_TIMESTAMP",
        }
    age = _minutes_between(published, now)
    gap = age > board_gap
    delayed = age > healthy
    if not delayed:
        state, reason = "CONTINUOUS", "BOARD_PUBLISH_CURRENT"
    elif not gap:
        state, reason = "DELAYED", "BOARD_PUBLISH_DELAYED"
    else:
        state, reason = "GAP", "BOARD_PUBLISH_EXCEEDED_GAP_THRESHOLD"
    return {
        "state": state,
        "lastSuccessfulPublishUtc": _zulu(published),
        "publisher": role,
        "ageMinutes": round(age, 3),
        "reason": reason,
    }


def _event(
    event_type: str,
    timestamp: datetime,
    *,
    host: Optional[str] = None,
    reason: str,
    publisher: Optional[str] = None,
    source_sha: Optional[str] = None,
    timestamp_basis: str = "FIRST_OBSERVED_CLASSIFICATION",
    certainty: str = "FIRST_OBSERVED",
    lease_owner: Optional[str] = None,
) -> dict[str, Any]:
    return {
        "eventType": event_type,
        "timestampUtc": _zulu(timestamp),
        "host": host,
        "reason": reason,
        "publisher": publisher,
        "sourceSha": source_sha,
        "timestampBasis": timestamp_basis,
        "timestampCertainty": certainty,
        "leaseOwner": lease_owner,
    }


def _append_event_once(archive: dict[str, Any], value: dict[str, Any]) -> None:
    identity = (
        value.get("eventType"),
        value.get("timestampUtc"),
        value.get("host"),
        value.get("publisher"),
    )
    if any(
        (item.get("eventType"), item.get("timestampUtc"), item.get("host"), item.get("publisher"))
        == identity
        for item in archive["events"]
        if isinstance(item, Mapping)
    ):
        return
    archive["events"].append(value)


def _set_interval(
    archive: dict[str, Any],
    *,
    track: str,
    state: str,
    timestamp: datetime,
    reason: str,
    source_sha: Optional[str] = None,
    timestamp_basis: str = "FIRST_OBSERVED_CLASSIFICATION",
    certainty: str = "FIRST_OBSERVED",
) -> bool:
    intervals = archive["intervals"]
    active = next(
        (
            item
            for item in reversed(intervals)
            if isinstance(item, Mapping) and item.get("track") == track and item.get("endUtc") is None
        ),
        None,
    )
    if active is not None and active.get("state") == state:
        return False
    timestamp_z = _zulu(timestamp)
    if active is not None:
        active["endUtc"] = timestamp_z
        active["endTimestampBasis"] = timestamp_basis
        active["endTimestampCertainty"] = certainty
    intervals.append(
        {
            "track": track,
            "host": track if track in HOST_ROLES else None,
            "state": state,
            "startUtc": timestamp_z,
            "endUtc": None,
            "reason": reason,
            "sourceSha": source_sha,
            "startTimestampBasis": timestamp_basis,
            "startTimestampCertainty": certainty,
        }
    )
    return True


def _normalize_lease(lease: Any, observed: datetime) -> dict[str, Any]:
    if not isinstance(lease, Mapping):
        return {
            "state": "UNKNOWN",
            "activeOwner": None,
            "lastOwner": None,
            "acquiredUtc": None,
            "expiresUtc": None,
            "releasedUtc": None,
            "observedUtc": _zulu(observed),
        }
    state = str(lease.get("state") or "UNKNOWN").strip().upper()
    owner = str(lease.get("owner") or "").strip().upper()
    if owner not in HOST_ROLES:
        owner = None
    return {
        "state": state,
        "activeOwner": owner if state == "ACTIVE" else None,
        "lastOwner": owner,
        "acquiredUtc": _zulu(value) if (value := _parse_utc(lease.get("acquiredUtc"))) else None,
        "expiresUtc": _zulu(value) if (value := _parse_utc(lease.get("expiresUtc"))) else None,
        "releasedUtc": _zulu(value) if (value := _parse_utc(lease.get("releasedUtc"))) else None,
        "observedUtc": _zulu(observed),
    }


def _publisher_reason(role: str, hosts: Mapping[str, Mapping[str, Any]]) -> tuple[str, bool]:
    if role == "PRIMARY":
        return "PREFERRED_PRIMARY_PUBLISHING", False
    if role == "BACKUP":
        primary_state = str(hosts["PRIMARY"].get("healthState") or "UNKNOWN")
        retained_primary_state = str(
            hosts["PRIMARY"].get("lastObservedHealthState") or "UNKNOWN"
        )
        if primary_state == "STALE":
            return "PRIMARY_HEARTBEAT_STALE", False
        if retained_primary_state == "STALE":
            return "PRIMARY_HEARTBEAT_STALE", False
        if primary_state in {"ERROR", "UNAVAILABLE"}:
            return f"PRIMARY_{primary_state}", False
        return "PRIMARY_HEALTH_UNKNOWN", False
    return "NO_VALID_PUBLISHER", False


def _advance_silence_boundaries(
    archive: dict[str, Any],
    until: datetime,
    *,
    healthy_minutes: float,
    failover_minutes: float,
    board_gap_minutes: float,
) -> None:
    """Insert deterministic threshold crossings missed while no host published.

    These are derived from retained source timestamps plus the existing
    configured thresholds.  They are not represented as new heartbeats and are
    explicitly marked as threshold-derived evidence.
    """

    last_archive_update = _parse_utc(archive.get("updatedUtc"))
    publisher = str(archive.get("current", {}).get("publisher", {}).get("role") or "UNKNOWN")
    if publisher not in HOST_ROLES or last_archive_update is None:
        return

    host = archive["hosts"][publisher]
    heartbeat = _parse_utc(host.get("lastHeartbeatUtc"))
    source_sha = host.get("lastKnownSourceSha")
    if heartbeat is not None:
        for minutes, state, reason, basis in (
            (
                healthy_minutes,
                "DELAYED",
                "HEARTBEAT_EXCEEDED_HEALTHY_THRESHOLD",
                "HEALTHY_THRESHOLD_DERIVED",
            ),
            (
                failover_minutes,
                "STALE",
                "HEARTBEAT_EXCEEDED_FAILOVER_THRESHOLD",
                "FAILOVER_THRESHOLD_DERIVED",
            ),
        ):
            boundary = heartbeat + timedelta(minutes=minutes, seconds=1)
            if not (last_archive_update < boundary < until):
                continue
            changed = _set_interval(
                archive,
                track=publisher,
                state=state,
                timestamp=boundary,
                reason=reason,
                source_sha=source_sha,
                timestamp_basis=basis,
                certainty="DERIVED_FROM_HEARTBEAT_AND_CONFIGURED_THRESHOLD",
            )
            if changed:
                host["healthState"] = state
                host["lastObservedHealthState"] = state
                host["reason"] = reason
                host["heartbeatAgeMinutes"] = minutes
                _append_event_once(
                    archive,
                    _event(
                        f"{publisher}_{state}",
                        boundary,
                        host=publisher,
                        reason=reason,
                        publisher=publisher,
                        source_sha=source_sha,
                        timestamp_basis=basis,
                        certainty="DERIVED_FROM_HEARTBEAT_AND_CONFIGURED_THRESHOLD",
                    ),
                )

    successful_publish = _parse_utc(
        archive.get("current", {}).get("boardDelivery", {}).get("lastSuccessfulPublishUtc")
    )
    if successful_publish is None:
        return
    for minutes, state, reason, basis in (
        (
            healthy_minutes,
            "DELAYED",
            "BOARD_PUBLISH_DELAYED",
            "BOARD_PUBLISH_DELAY_THRESHOLD_DERIVED",
        ),
        (
            board_gap_minutes,
            "GAP",
            "BOARD_PUBLISH_EXCEEDED_GAP_THRESHOLD",
            "BOARD_PUBLISH_GAP_THRESHOLD_DERIVED",
        ),
    ):
        boundary = successful_publish + timedelta(minutes=minutes, seconds=1)
        if not (last_archive_update < boundary < until):
            continue
        changed = _set_interval(
            archive,
            track="BOARD_DELIVERY",
            state=state,
            timestamp=boundary,
            reason=reason,
            source_sha=source_sha,
            timestamp_basis=basis,
            certainty="DERIVED_FROM_PUBLISH_TIMESTAMPS_AND_THRESHOLD",
        )
        if changed:
            event_type = "BOARD_PUBLISH_GAP" if state == "GAP" else "BOARD_DELAYED"
            _append_event_once(
                archive,
                _event(
                    event_type,
                    boundary,
                    reason=reason,
                    publisher=publisher,
                    source_sha=source_sha,
                    timestamp_basis=basis,
                    certainty="DERIVED_FROM_PUBLISH_TIMESTAMPS_AND_THRESHOLD",
                ),
            )
            archive["current"]["boardDelivery"].update(
                {
                    "state": state,
                    "ageMinutes": minutes,
                    "reason": reason,
                }
            )


def _mark_archive_observation_gap(
    archive: dict[str, Any],
    *,
    last_observed: datetime,
    resumed: datetime,
) -> None:
    """Represent an unsupported telemetry span without inventing an outage.

    A published ``host_status.json`` may advance even when this optional
    archive failed to write.  If more than one normal observation window is
    absent, the latest retained status proves the state only at its own
    heartbeat; it cannot prove that the board stopped publishing throughout
    the intervening span.  Close the known intervals one second after their
    last exact observation, mark the unsupported span UNKNOWN, and resume from
    the exact published status timestamp.
    """

    gap_start = last_observed + timedelta(seconds=1)
    if gap_start >= resumed:
        return
    reason = "HOST_HEALTH_TELEMETRY_OBSERVATION_GAP"
    basis = "ARCHIVE_OBSERVATION_GAP_BOUNDARY"
    certainty = "DERIVED_FROM_ARCHIVE_AND_PUBLISHED_STATUS_TIMESTAMPS"

    for role in HOST_ROLES:
        host = archive["hosts"][role]
        _set_interval(
            archive,
            track=role,
            state="UNKNOWN",
            timestamp=gap_start,
            reason=reason,
            source_sha=host.get("lastKnownSourceSha"),
            timestamp_basis=basis,
            certainty=certainty,
        )
        host["healthState"] = "UNKNOWN"
        host["roleState"] = "TELEMETRY_NOT_OBSERVED"
        host["reason"] = reason
        host["heartbeatAgeMinutes"] = None

    previous_current = archive.get("current", {})
    previous_publisher_snapshot = previous_current.get("publisher", {})
    previous_publisher = str(previous_publisher_snapshot.get("role") or "UNKNOWN")
    previous_board = previous_current.get("boardDelivery", {})
    previous_lease = previous_current.get("lease", {})
    _set_interval(
        archive,
        track="PUBLISHER",
        state="UNKNOWN",
        timestamp=gap_start,
        reason=reason,
        timestamp_basis=basis,
        certainty=certainty,
    )
    _set_interval(
        archive,
        track="BOARD_DELIVERY",
        state="UNKNOWN",
        timestamp=gap_start,
        reason=reason,
        timestamp_basis=basis,
        certainty=certainty,
    )
    archive["current"] = {
        "publisher": {
            "role": "UNKNOWN",
            "sinceUtc": _zulu(gap_start),
            "sinceTimestampBasis": basis,
            "lastSuccessfulPublishUtc": previous_board.get("lastSuccessfulPublishUtc"),
            "lastSuccessfulPushUtc": previous_publisher_snapshot.get("lastSuccessfulPushUtc"),
            "reason": reason,
            "rootCauseKnown": False,
        },
        "boardDelivery": {
            "state": "UNKNOWN",
            "lastSuccessfulPublishUtc": previous_board.get("lastSuccessfulPublishUtc"),
            "publisher": previous_publisher,
            "ageMinutes": None,
            "reason": reason,
        },
        "lease": copy.deepcopy(dict(previous_lease)) if isinstance(previous_lease, Mapping) else {},
    }
    _append_event_once(
        archive,
        _event(
            "ARCHIVE_OBSERVATION_GAP",
            gap_start,
            reason=reason,
            publisher=previous_publisher if previous_publisher in HOST_ROLES else None,
            timestamp_basis=basis,
            certainty=certainty,
        ),
    )
    _append_event_once(
        archive,
        _event(
            "ARCHIVE_OBSERVATION_RESUMED",
            resumed,
            reason="PUBLISHED_HOST_STATUS_EVIDENCE_RESUMED",
            timestamp_basis="PUBLISHED_HEARTBEAT_UTC",
            certainty="EXACT_SOURCE_TIMESTAMP",
        ),
    )


def _apply_observation(
    archive: dict[str, Any],
    status: Mapping[str, Any],
    observed: datetime,
    *,
    healthy_minutes: float,
    failover_minutes: float,
    board_gap_minutes: float,
    lease: Any = None,
    timestamp_basis: str = "PUBLISHED_HEARTBEAT_UTC",
    timestamp_certainty: str = "EXACT_SOURCE_TIMESTAMP",
) -> None:
    previous_publisher = str(archive["current"]["publisher"].get("role") or "UNKNOWN")
    publisher = _capture_host_evidence(archive, status, observed)
    source_sha = _source_sha(status)

    for role in HOST_ROLES:
        host = archive["hosts"][role]
        observed_state, observed_reason, age = _classify_host(
            host,
            observed,
            healthy_minutes,
            failover_minutes,
        )
        if role == publisher:
            state, reason = observed_state, observed_reason
            role_state = "ACTIVE_PUBLISHER"
            host["lastObservedHealthState"] = observed_state
        elif role == "PRIMARY" and publisher == "BACKUP":
            # PRIMARY is the preferred publisher.  Its retained heartbeat age
            # is precisely the evidence used to explain a BACKUP takeover, so
            # preserve that classification until PRIMARY publishes recovery.
            state, reason = observed_state, observed_reason
            role_state = "PREFERRED_HOST_NOT_PUBLISHING"
            host["lastObservedHealthState"] = observed_state
        else:
            # The shared host_status document is the active publisher's
            # heartbeat, not an independent standby heartbeat.  An old former-
            # publisher timestamp is useful retained evidence, but cannot prove
            # whether an intentionally idle standby is currently healthy.
            state, reason = "UNKNOWN", "INACTIVE_HOST_HEALTH_NOT_OBSERVED"
            role_state = "STANDBY_NOT_OBSERVED"
        host["healthState"] = state
        host["roleState"] = role_state
        host["reason"] = reason
        host["heartbeatAgeMinutes"] = None if age is None else round(age, 3)
        previous_host_interval = next(
            (
                item
                for item in reversed(archive["intervals"])
                if item.get("track") == role and item.get("endUtc") is None
            ),
            None,
        )
        previous_host_state = (previous_host_interval or {}).get("state")
        changed = _set_interval(
            archive,
            track=role,
            state=state,
            timestamp=observed,
            reason=reason,
            source_sha=host.get("lastKnownSourceSha"),
            timestamp_basis=timestamp_basis,
            certainty=timestamp_certainty,
        )
        if changed:
            event_type = f"{role}_{state}"
            if state == "HEALTHY" and previous_host_state == "DELAYED":
                event_type = f"{role}_DELAY_RECOVERED"
            elif state == "HEALTHY" and previous_host_state in {
                "STALE",
                "ERROR",
                "UNAVAILABLE",
            }:
                event_type = f"{role}_RECOVERED"
            _append_event_once(
                archive,
                _event(
                    event_type,
                    observed,
                    host=role,
                    reason=reason,
                    publisher=publisher,
                    source_sha=host.get("lastKnownSourceSha"),
                    timestamp_basis=timestamp_basis,
                    certainty=timestamp_certainty,
                ),
            )

    publisher_reason, root_cause_known = _publisher_reason(publisher, archive["hosts"])
    publisher_timestamp = observed
    publisher_timestamp_basis = "PUBLISHED_HEARTBEAT_UTC"
    publisher_timestamp_certainty = "EXACT_SOURCE_TIMESTAMP"
    normalized_lease = _normalize_lease(lease, observed)
    acquired = _parse_utc(normalized_lease.get("acquiredUtc"))
    publisher_is_transition = (
        previous_publisher in HOST_ROLES
        and publisher in HOST_ROLES
        and previous_publisher != publisher
    )
    if publisher_is_transition:
        publisher_timestamp_basis = "FIRST_OBSERVED_PUBLISHER_CHANGE"
        publisher_timestamp_certainty = "FIRST_OBSERVED"
    if (
        publisher_is_transition
        and normalized_lease.get("lastOwner") == publisher
        and acquired is not None
        and acquired <= observed
    ):
        publisher_timestamp = acquired
        publisher_timestamp_basis = "LEASE_ACQUIRED_UTC"
        publisher_timestamp_certainty = "EXACT_SOURCE_TIMESTAMP"
    publisher_changed = _set_interval(
        archive,
        track="PUBLISHER",
        state=publisher,
        timestamp=publisher_timestamp,
        reason=publisher_reason,
        source_sha=source_sha,
        timestamp_basis=publisher_timestamp_basis,
        certainty=publisher_timestamp_certainty,
    )
    if publisher_changed:
        _append_event_once(
            archive,
            _event(
                f"ACTIVE_{publisher}",
                publisher_timestamp,
                reason=publisher_reason,
                publisher=publisher,
                source_sha=source_sha,
                timestamp_basis=publisher_timestamp_basis,
                certainty=publisher_timestamp_certainty,
            ),
        )
        if previous_publisher in HOST_ROLES and publisher in HOST_ROLES and previous_publisher != publisher:
            transition_type = "BACKUP_TAKEOVER" if publisher == "BACKUP" else "PRIMARY_HANDOFF"
            _append_event_once(
                archive,
                _event(
                    transition_type,
                    publisher_timestamp,
                    host=publisher,
                    reason=publisher_reason,
                    publisher=publisher,
                    source_sha=source_sha,
                    timestamp_basis=publisher_timestamp_basis,
                    certainty=publisher_timestamp_certainty,
                    lease_owner=normalized_lease.get("lastOwner"),
                ),
            )

    board = _board_state(
        status,
        observed,
        healthy_minutes,
        board_gap_minutes,
    )
    previous_board = str(archive["current"]["boardDelivery"].get("state") or "UNKNOWN")
    board_changed = _set_interval(
        archive,
        track="BOARD_DELIVERY",
        state=board["state"],
        timestamp=observed,
        reason=board["reason"],
        source_sha=source_sha,
        timestamp_basis=timestamp_basis,
        certainty=timestamp_certainty,
    )
    if board_changed:
        if board["state"] == "GAP":
            event_type = "BOARD_PUBLISH_GAP"
        elif board["state"] == "CONTINUOUS" and previous_board == "GAP":
            event_type = "BOARD_PUBLISH_RECOVERED"
        elif board["state"] == "CONTINUOUS" and previous_board == "DELAYED":
            event_type = "BOARD_DELAY_RECOVERED"
        else:
            event_type = f"BOARD_{board['state']}"
        _append_event_once(
            archive,
            _event(
                event_type,
                observed,
                reason=board["reason"],
                publisher=publisher,
                source_sha=source_sha,
                timestamp_basis=timestamp_basis,
                certainty=timestamp_certainty,
            ),
        )

    publisher_interval = next(
        (
            item
            for item in reversed(archive["intervals"])
            if item.get("track") == "PUBLISHER" and item.get("endUtc") is None
        ),
        None,
    )
    archive["current"] = {
        "publisher": {
            "role": publisher,
            "sinceUtc": (publisher_interval or {}).get("startUtc"),
            "sinceTimestampBasis": (publisher_interval or {}).get("startTimestampBasis", "NO_DATA"),
            "lastSuccessfulPublishUtc": board["lastSuccessfulPublishUtc"],
            "lastSuccessfulPushUtc": (
                _zulu(value) if (value := _parse_utc(status.get("lastSuccessfulPushUtc"))) else None
            ),
            "reason": publisher_reason,
            "rootCauseKnown": root_cause_known,
        },
        "boardDelivery": board,
        "lease": _normalize_lease(lease, observed),
    }


def _prune(archive: dict[str, Any], now: datetime, retention_days: int) -> None:
    cutoff = now - timedelta(days=retention_days)
    cutoff_z = _zulu(cutoff)
    retained_intervals = []
    for item in archive["intervals"]:
        if not isinstance(item, Mapping):
            continue
        start = _parse_utc(item.get("startUtc"))
        end = _parse_utc(item.get("endUtc"))
        if start is None or (end is not None and end <= cutoff):
            continue
        retained = copy.deepcopy(dict(item))
        if start < cutoff:
            retained["startUtc"] = cutoff_z
            retained["startClippedByRetention"] = True
            retained["startTimestampBasis"] = "RETENTION_BOUNDARY"
            retained["startTimestampCertainty"] = "CLIPPED"
        retained_intervals.append(retained)
    archive["intervals"] = retained_intervals
    archive["events"] = [
        copy.deepcopy(dict(item))
        for item in archive["events"]
        if isinstance(item, Mapping)
        and (timestamp := _parse_utc(item.get("timestampUtc"))) is not None
        and timestamp >= cutoff
    ]
    retained_summaries = []
    for item in archive.get("dailySummaries", []):
        if not isinstance(item, Mapping):
            continue
        day_start = _parse_utc(item.get("dayStartUtc"))
        # A daily aggregate cannot be sliced truthfully once its ordered source
        # intervals have been discarded.  Drop the whole boundary UTC day
        # rather than retaining or prorating any duration before the cutoff.
        if day_start is None or day_start < cutoff:
            continue
        retained_summaries.append(copy.deepcopy(dict(item)))
    archive["dailySummaries"] = retained_summaries

    started = _parse_utc(archive.get("archiveStartedUtc"))
    archive["coverageStartUtc"] = _zulu(max(started, cutoff)) if started is not None else None
    archive["partialHistory"] = started is None or started > cutoff


def _utc_day_start(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def _new_daily_summary(day_start: datetime) -> dict[str, Any]:
    day_end = day_start + timedelta(days=1)
    return {
        "dateUtc": day_start.date().isoformat(),
        "dayStartUtc": _zulu(day_start),
        "dayEndUtc": _zulu(day_end),
        "coverageStartUtc": None,
        "coverageEndUtc": None,
        "coverageSeconds": 0,
        "knownCoverageSeconds": 0,
        "partialCoverage": True,
        "tracks": {},
        "eventCounts": {},
        "sourceIntervalCount": 0,
        "sourceEventCount": 0,
        "aggregation": {
            "timeBasis": "UTC",
            "timestampBasis": "EXACT_INTERVAL_BOUNDARIES_SPLIT_AT_UTC_DAY",
            "provenance": "DERIVED_FROM_EXACT_INTERVALS_AND_EVENTS",
        },
    }


def _daily_summary(
    summaries: dict[str, dict[str, Any]],
    day_start: datetime,
) -> dict[str, Any]:
    key = day_start.date().isoformat()
    summary = summaries.get(key)
    if summary is None:
        summary = _new_daily_summary(day_start)
        summaries[key] = summary
    return summary


def _record_daily_duration(
    summaries: dict[str, dict[str, Any]],
    *,
    track: str,
    state: str,
    start: datetime,
    end: datetime,
) -> None:
    cursor = start
    while cursor < end:
        day_start = _utc_day_start(cursor)
        segment_end = min(end, day_start + timedelta(days=1))
        seconds = int(round((segment_end - cursor).total_seconds()))
        if seconds > 0:
            summary = _daily_summary(summaries, day_start)
            track_summary = summary["tracks"].setdefault(
                track,
                {
                    "durationsSeconds": {},
                    "observedSeconds": 0,
                    "knownSeconds": 0,
                },
            )
            durations = track_summary["durationsSeconds"]
            durations[state] = int(durations.get(state, 0)) + seconds
            summary["sourceIntervalCount"] = int(summary.get("sourceIntervalCount", 0)) + 1
            prior_start = _parse_utc(summary.get("coverageStartUtc"))
            prior_end = _parse_utc(summary.get("coverageEndUtc"))
            summary["coverageStartUtc"] = _zulu(min(prior_start, cursor) if prior_start else cursor)
            summary["coverageEndUtc"] = _zulu(
                max(prior_end, segment_end) if prior_end else segment_end
            )
        cursor = segment_end


def _record_daily_event(
    summaries: dict[str, dict[str, Any]],
    event: Mapping[str, Any],
    timestamp: datetime,
) -> None:
    summary = _daily_summary(summaries, _utc_day_start(timestamp))
    event_type = str(event.get("eventType") or "UNKNOWN_EVENT").strip().upper()
    counts = summary["eventCounts"]
    counts[event_type] = int(counts.get(event_type, 0)) + 1
    summary["sourceEventCount"] = int(summary.get("sourceEventCount", 0)) + 1


def _finalize_daily_summaries(summaries: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    finalized = []
    for key in sorted(summaries):
        summary = summaries[key]
        observed_by_track = []
        known_by_track = []
        tracks = summary.setdefault("tracks", {})
        for track in (*HOST_ROLES, "PUBLISHER", "BOARD_DELIVERY"):
            tracks.setdefault(
                track,
                {
                    "durationsSeconds": {},
                    "observedSeconds": 0,
                    "knownSeconds": 0,
                },
            )
        for track_summary in tracks.values():
            durations = track_summary.get("durationsSeconds", {})
            observed = sum(
                max(0, int(value))
                for value in durations.values()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            )
            known = sum(
                max(0, int(value))
                for state, value in durations.items()
                if state != "UNKNOWN"
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
            )
            track_summary["observedSeconds"] = observed
            track_summary["knownSeconds"] = known
            observed_by_track.append(observed)
            known_by_track.append(known)
        coverage = max(observed_by_track, default=0)
        summary["coverageSeconds"] = coverage
        summary["knownCoverageSeconds"] = max(known_by_track, default=0)
        summary["partialCoverage"] = (
            coverage < 24 * 60 * 60
            or any(value < coverage for value in observed_by_track)
        )
        finalized.append(summary)
    return finalized


def _refresh_coverage_metadata(
    archive: dict[str, Any],
    now: datetime,
    retention_days: int,
) -> None:
    rolling_cutoff = now - timedelta(days=retention_days)
    started = _parse_utc(archive.get("archiveStartedUtc"))
    candidates = [
        value
        for value in (
            *(
                _parse_utc(item.get("coverageStartUtc"))
                for item in archive.get("dailySummaries", [])
                if isinstance(item, Mapping)
            ),
            *(
                _parse_utc(item.get("startUtc"))
                for item in archive.get("intervals", [])
                if isinstance(item, Mapping)
            ),
        )
        if value is not None
    ]
    effective_start = min(candidates) if candidates else None
    archive["coverageStartUtc"] = _zulu(effective_start) if effective_start else None
    archive["partialHistory"] = (
        started is None
        or started > rolling_cutoff
        or effective_start is None
        or effective_start > rolling_cutoff
    )
    if (
        started is not None
        and started <= rolling_cutoff
        and effective_start is not None
        and effective_start > rolling_cutoff
    ):
        archive["retentionBoundaryGap"] = {
            "startUtc": _zulu(rolling_cutoff),
            "endUtc": _zulu(effective_start),
            "reason": "PARTIAL_UTC_DAY_DROPPED_AFTER_DAILY_AGGREGATION",
            "timestampBasis": "ROLLING_RETENTION_BOUNDARY_TO_NEXT_RETAINED_COVERAGE",
            "timestampCertainty": "EXPLICITLY_UNAVAILABLE_AFTER_AGGREGATION",
        }
    else:
        archive["retentionBoundaryGap"] = None


def _event_requires_exact_retention(event_type: str) -> bool:
    normalized = event_type.strip().upper()
    return normalized in CRITICAL_EXACT_EVENT_TYPES or (
        "HANDOFF" in normalized and ("FAIL" in normalized or "INCOMPLETE" in normalized)
    )


def _compact_history(
    archive: dict[str, Any],
    now: datetime,
    *,
    exact_history_days: int,
) -> None:
    if not isinstance(exact_history_days, int) or exact_history_days <= 0:
        raise ValueError("exact_history_days must be a positive integer")
    exact_cutoff = _utc_day_start(now) - timedelta(days=exact_history_days)
    summaries = {
        str(item.get("dateUtc")): copy.deepcopy(dict(item))
        for item in archive.get("dailySummaries", [])
        if isinstance(item, Mapping) and str(item.get("dateUtc") or "").strip()
    }

    retained_intervals = []
    for item in archive["intervals"]:
        if not isinstance(item, Mapping):
            continue
        start = _parse_utc(item.get("startUtc"))
        end = _parse_utc(item.get("endUtc"))
        if start is None:
            continue
        aggregate_end = min(end or exact_cutoff, exact_cutoff)
        if start < aggregate_end:
            _record_daily_duration(
                summaries,
                track=str(item.get("track") or "UNKNOWN"),
                state=str(item.get("state") or "UNKNOWN"),
                start=start,
                end=aggregate_end,
            )
        if end is None or end > exact_cutoff:
            retained = copy.deepcopy(dict(item))
            if start < exact_cutoff:
                retained["startUtc"] = _zulu(exact_cutoff)
                retained["startTimestampBasis"] = "EXACT_HISTORY_WINDOW_BOUNDARY"
                retained["startTimestampCertainty"] = "CLIPPED_AFTER_DAILY_AGGREGATION"
            retained_intervals.append(retained)
    archive["intervals"] = retained_intervals

    retained_events = []
    for item in archive["events"]:
        if not isinstance(item, Mapping):
            continue
        timestamp = _parse_utc(item.get("timestampUtc"))
        if timestamp is None:
            continue
        retained = copy.deepcopy(dict(item))
        if timestamp < exact_cutoff:
            if not bool(item.get("includedInDailySummary")):
                _record_daily_event(summaries, item, timestamp)
            if not _event_requires_exact_retention(str(item.get("eventType") or "")):
                continue
            retained["includedInDailySummary"] = True
        retained_events.append(retained)
    archive["events"] = retained_events
    archive["dailySummaries"] = _finalize_daily_summaries(summaries)
    archive["exactHistoryDays"] = exact_history_days
    archive["exactHistoryStartUtc"] = _zulu(exact_cutoff)
    archive["summarizedThroughUtc"] = _zulu(exact_cutoff)
    archive["summaryCoverageStartUtc"] = (
        archive["dailySummaries"][0]["dayStartUtc"] if archive["dailySummaries"] else None
    )
    archive["storagePolicy"] = {
        "mode": "EXACT_RECENT_WITH_UTC_DAILY_AGGREGATES",
        "exactHistoryDays": exact_history_days,
        "aggregateTimeBasis": "UTC",
        "criticalEventTypesRetainedExact": sorted(CRITICAL_EXACT_EVENT_TYPES),
        "criticalEventsAlsoCountedInDailySummaries": True,
    }


def compact_host_health_history(
    archive: Mapping[str, Any],
    *,
    now_z: datetime,
    exact_history_days: int = DEFAULT_EXACT_HISTORY_DAYS,
) -> dict[str, Any]:
    """Return a compact copy with recent exact rows and older UTC summaries."""

    if not isinstance(archive, Mapping):
        raise ValueError("host-health archive must be an object")
    compacted = copy.deepcopy(dict(archive))
    if compacted.get("schemaVersion") != SCHEMA_VERSION:
        raise HostHealthHistoryError("host-health archive schemaVersion is unsupported")
    if not isinstance(compacted.get("intervals"), list) or not isinstance(
        compacted.get("events"), list
    ):
        raise HostHealthHistoryError("host-health history collections are malformed")
    compacted.setdefault("dailySummaries", [])
    now = _as_utc(now_z)
    retention_days = int(compacted.get("retentionDays") or DEFAULT_RETENTION_DAYS)
    _prune(compacted, now, retention_days)
    _compact_history(compacted, now, exact_history_days=exact_history_days)
    _prune(compacted, now, retention_days)
    _refresh_coverage_metadata(compacted, now, retention_days)
    compacted["summaryCoverageStartUtc"] = (
        compacted["dailySummaries"][0]["dayStartUtc"]
        if compacted["dailySummaries"]
        else None
    )
    compacted["events"].sort(key=lambda item: item["timestampUtc"])
    compacted["intervals"].sort(key=lambda item: (item["startUtc"], item["track"]))
    return compacted


def host_health_storage_usage(archive: Mapping[str, Any]) -> dict[str, int]:
    """Measure a conservative Windows-safe indented JSON payload size."""

    serialized = json.dumps(archive, indent=2) + "\n"
    utf8_bytes = len(serialized.encode("utf-8"))
    return {
        # ``Path.write_text`` may translate LF to CRLF on the updater hosts.
        # Count the possible CR byte for every newline so the pre-write guard
        # never underestimates the final Git blob.
        "serializedBytes": utf8_bytes + serialized.count("\n"),
        "rowCount": (
            len(archive.get("intervals", []))
            + len(archive.get("events", []))
            + len(archive.get("dailySummaries", []))
        ),
    }


def validate_host_health_storage_budget(
    archive: Mapping[str, Any],
    *,
    max_serialized_bytes: int = DEFAULT_MAX_SERIALIZED_BYTES,
    max_rows: int = DEFAULT_MAX_STORED_ROWS,
) -> dict[str, int]:
    """Fail closed for telemetry size only; callers isolate this exception."""

    usage = host_health_storage_usage(archive)
    if usage["serializedBytes"] > max_serialized_bytes:
        raise HostHealthHistoryError(
            "host-health archive exceeds serialized-byte safety budget "
            f"({usage['serializedBytes']} > {max_serialized_bytes})"
        )
    if usage["rowCount"] > max_rows:
        raise HostHealthHistoryError(
            "host-health archive exceeds stored-row safety budget "
            f"({usage['rowCount']} > {max_rows})"
        )
    return usage


def update_host_health_history(
    existing_archive: Any,
    *,
    previous_status: Any,
    current_status: Mapping[str, Any],
    lease: Any,
    now_z: datetime,
    healthy_minutes: float,
    failover_minutes: float,
    board_gap_minutes: float,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    exact_history_days: int = DEFAULT_EXACT_HISTORY_DAYS,
    observation_timestamp_basis: str = "PUBLISHED_HEARTBEAT_UTC",
    observation_timestamp_certainty: str = "EXACT_SOURCE_TIMESTAMP",
) -> dict[str, Any]:
    """Merge one owned publication into a compact, truthful health archive.

    ``healthy_minutes`` and ``failover_minutes`` are required inputs so this
    observer uses the coordinator's existing thresholds rather than owning a
    second set of failover constants.
    """

    now = _as_utc(now_z)
    if healthy_minutes <= 0 or failover_minutes <= healthy_minutes:
        raise ValueError("host-health thresholds are invalid")
    if board_gap_minutes <= failover_minutes:
        raise ValueError("board publish gap threshold must exceed failover threshold")
    if not isinstance(retention_days, int) or retention_days <= 0:
        raise ValueError("retention_days must be a positive integer")
    if not isinstance(exact_history_days, int) or not 0 < exact_history_days < retention_days:
        raise ValueError("exact_history_days must be a positive value below retention_days")
    if not isinstance(current_status, Mapping):
        raise ValueError("current_status must be an object")
    current_time = _status_time(current_status)
    if current_time is None or current_time > now + timedelta(minutes=2):
        raise ValueError("current_status heartbeat is missing, malformed, or future-dated")

    archive = _normalize_archive(
        existing_archive,
        retention_days=retention_days,
        healthy_minutes=healthy_minutes,
        failover_minutes=failover_minutes,
        board_gap_minutes=board_gap_minutes,
    )

    updated = _parse_utc(archive.get("updatedUtc"))
    observations: list[tuple[Mapping[str, Any], datetime, Any, str, str, bool]] = []
    if isinstance(previous_status, Mapping):
        prior_time = _status_time(previous_status)
        if (
            prior_time is not None
            and prior_time < current_time
            and (updated is None or prior_time > updated)
            and prior_time >= now - timedelta(days=retention_days)
        ):
            unsupported_gap = (
                updated is not None
                and prior_time - updated > timedelta(minutes=healthy_minutes)
            )
            observations.append(
                (
                    previous_status,
                    prior_time,
                    None,
                    "PUBLISHED_HEARTBEAT_UTC",
                    "EXACT_SOURCE_TIMESTAMP",
                    unsupported_gap,
                )
            )
    observations.append(
        (
            current_status,
            now,
            lease,
            observation_timestamp_basis,
            observation_timestamp_certainty,
            False,
        )
    )

    applied = False
    for (
        status,
        observed,
        observation_lease,
        timestamp_basis,
        timestamp_certainty,
        unsupported_gap,
    ) in observations:
        if updated is not None and observed <= updated:
            continue
        if unsupported_gap and updated is not None:
            _mark_archive_observation_gap(
                archive,
                last_observed=updated,
                resumed=observed,
            )
        else:
            _advance_silence_boundaries(
                archive,
                observed,
                healthy_minutes=healthy_minutes,
                failover_minutes=failover_minutes,
                board_gap_minutes=board_gap_minutes,
            )
        if archive.get("archiveStartedUtc") is None:
            archive["archiveStartedUtc"] = _zulu(observed)
            _append_event_once(
                archive,
                _event(
                    "ARCHIVE_STARTED",
                    observed,
                    reason="HOST_HEALTH_COLLECTION_STARTED",
                    timestamp_basis="PUBLISHED_HEARTBEAT_UTC",
                    certainty="EXACT_SOURCE_TIMESTAMP",
                ),
            )
        _apply_observation(
            archive,
            status,
            observed,
            healthy_minutes=healthy_minutes,
            failover_minutes=failover_minutes,
            board_gap_minutes=board_gap_minutes,
            lease=observation_lease,
            timestamp_basis=timestamp_basis,
            timestamp_certainty=timestamp_certainty,
        )
        updated = observed
        archive["updatedUtc"] = _zulu(observed)
        applied = True

    if applied:
        archive["updatedUtc"] = _zulu(updated or now)
    elif updated is None or now >= updated:
        # The current lease is useful display evidence even when a duplicate
        # status is replayed; it does not create an event or interval.
        archive["current"]["lease"] = _normalize_lease(lease, now)

    _prune(archive, now, retention_days)
    _compact_history(archive, now, exact_history_days=exact_history_days)
    _prune(archive, now, retention_days)
    _refresh_coverage_metadata(archive, now, retention_days)
    archive["summaryCoverageStartUtc"] = (
        archive["dailySummaries"][0]["dayStartUtc"] if archive["dailySummaries"] else None
    )
    for host in archive["hosts"].values():
        host.pop("_lastUpdateStatus", None)
    archive["events"].sort(key=lambda item: item["timestampUtc"])
    archive["intervals"].sort(key=lambda item: (item["startUtc"], item["track"]))
    return archive


def build_host_health_history_from_evidence(
    observations: list[Mapping[str, Any]],
    *,
    healthy_minutes: float,
    failover_minutes: float,
    board_gap_minutes: float,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    exact_history_days: int = DEFAULT_EXACT_HISTORY_DAYS,
) -> dict[str, Any]:
    """Build a seed archive from explicitly timestamped retained evidence.

    Each item requires ``observedUtc`` and ``status`` and may include ``lease``.
    This helper performs no Git inspection and invents no observations.  It is
    intended for a one-time, reviewed seed made from authoritative status/lease
    timestamps; normal updater cycles call :func:`update_host_health_history`.
    """

    ordered: list[tuple[datetime, Mapping[str, Any]]] = []
    for item in observations:
        if not isinstance(item, Mapping) or not isinstance(item.get("status"), Mapping):
            raise ValueError("each host-health observation requires a status object")
        observed = _parse_utc(item.get("observedUtc"))
        if observed is None:
            raise ValueError("each host-health observation requires a UTC observedUtc")
        ordered.append((observed, item))
    ordered.sort(key=lambda value: value[0])
    if any(ordered[index][0] == ordered[index - 1][0] for index in range(1, len(ordered))):
        raise ValueError("host-health evidence timestamps must be unique")

    archive: Any = None
    for observed, item in ordered:
        archive = update_host_health_history(
            archive,
            previous_status=None,
            current_status=item["status"],
            lease=item.get("lease"),
            now_z=observed,
            healthy_minutes=healthy_minutes,
            failover_minutes=failover_minutes,
            board_gap_minutes=board_gap_minutes,
            retention_days=retention_days,
            exact_history_days=exact_history_days,
            observation_timestamp_basis=str(
                item.get("timestampBasis") or "PUBLISHED_HEARTBEAT_UTC"
            ),
            observation_timestamp_certainty=str(
                item.get("timestampCertainty") or "EXACT_SOURCE_TIMESTAMP"
            ),
        )
    return archive or _empty_archive(
        retention_days,
        healthy_minutes,
        failover_minutes,
        board_gap_minutes,
    )
