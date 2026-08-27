#!/usr/bin/env python3
"""
KMEM MIL NOTAM/FICON NMS pull.

Reads credentials from:
  NMS_CLIENT_ID
  NMS_CLIENT_SECRET

Optional local-only testing override:
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
# If a trusted/local Windows certificate issue blocks NMS staging during testing,
# set NMS_ALLOW_INSECURE_SSL_FALLBACK=1 in nms_credentials_local.bat.
ALLOW_INSECURE_SSL_FALLBACK = os.environ.get(
    "NMS_ALLOW_INSECURE_SSL_FALLBACK",
    "0"
).strip().lower() in {"1", "true", "yes", "on"}

# NMS staging showed a rate limit around 1 request/sec.
REQUEST_DELAY_SECONDS = 1.25
MAX_RETRIES = 3


def utc_now_z():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def ssl_context(insecure=False):
    return ssl._create_unverified_context() if insecure else ssl.create_default_context()


def http_request(method, url, headers=None, body=None, timeout=45):
    req = Request(url=url, data=body, headers=headers or {}, method=method)

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=timeout, context=ssl_context(False)) as resp:
                return resp.read()

        except HTTPError as exc:
            error_text = exc.read().decode("utf-8", errors="replace")

            if exc.code == 429 and attempt < MAX_RETRIES:
                wait = REQUEST_DELAY_SECONDS * attempt + 1.0
                print(f"HTTP 429 rate limit. Waiting {wait:.1f} sec then retrying...")
                time.sleep(wait)
                continue

            raise RuntimeError(f"HTTP {exc.code}: {error_text}") from exc

        except (ssl.SSLError, URLError) as exc:
            if not ALLOW_INSECURE_SSL_FALLBACK:
                raise

            print(f"Normal SSL failed or was blocked: {exc}")
            print("Trying temporary insecure SSL fallback for NMS test...")

            try:
                with urlopen(req, timeout=timeout, context=ssl_context(True)) as resp:
                    return resp.read()
            except HTTPError as exc2:
                error_text = exc2.read().decode("utf-8", errors="replace")

                if exc2.code == 429 and attempt < MAX_RETRIES:
                    wait = REQUEST_DELAY_SECONDS * attempt + 1.0
                    print(f"HTTP 429 rate limit. Waiting {wait:.1f} sec then retrying...")
                    time.sleep(wait)
                    continue

                raise RuntimeError(f"HTTP {exc2.code}: {error_text}") from exc2

    raise RuntimeError("Request failed after retries.")


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

    print(f"Pulling checklist for {LOCATION}...")
    time.sleep(REQUEST_DELAY_SECONDS)

    checklist_resp = nms_get_json("/notams/checklist", token, query={"location": LOCATION})
    checklist = checklist_resp.get("data", {}).get("checklist", [])

    def is_mil_candidate(item):
        return str(item.get("classification", "")).upper() == "MILITARY"

    def is_ficon_candidate(item):
        blob = " ".join(str(item.get(k, "")) for k in item.keys()).upper()
        return (
            "FICON" in blob
            or "SNOW" in blob
            or str(item.get("classification", "")).upper() in ("SNOW", "FICON")
        )

    # Phase 59: do NOT brute-force every checklist detail record.
    # NMS checklist metadata can hide FICON wording, but active runway FICON NOTAMs are
    # normally recent local NOTAMs (for example 06/141-06/146). Pull MIL records plus
    # the newest local MEM records, then classify by full text. This keeps the update
    # usable for a 15-minute board cycle.

    MAX_RECENT_LOCAL_DETAIL_SCAN = 50

    def local_number_key(item):
        num = str(item.get("number", ""))
        match = re.match(r"^(\d{1,2})/(\d{3})$", num)
        if not match:
            return (-1, -1)
        return (int(match.group(1)), int(match.group(2)))

    mil_candidates = [item for item in checklist if is_mil_candidate(item) or str(item.get("number", "")).upper().startswith("M")]

    explicit_ficon_candidates = [item for item in checklist if is_ficon_candidate(item)]

    explicit_runway_closure_candidates = [item for item in checklist if is_runway_closure_candidate(item)]

    recent_local_candidates = sorted(
        [item for item in checklist if re.match(r"^\d{1,2}/\d{3}$", str(item.get("number", "")))],
        key=local_number_key,
        reverse=True
    )[:MAX_RECENT_LOCAL_DETAIL_SCAN]

    candidates_by_number = {}
    for item in mil_candidates + explicit_ficon_candidates + explicit_runway_closure_candidates + recent_local_candidates:
        num = str(item.get("number", ""))
        if num:
            candidates_by_number[num] = item

    candidates = list(candidates_by_number.values())

    print(f"Checklist records returned: {len(checklist)}")
    print(f"MIL candidates: {len(mil_candidates)}")
    print(f"Explicit FICON metadata candidates: {len(explicit_ficon_candidates)}")
    print(f"Explicit RWY closure metadata candidates: {len(explicit_runway_closure_candidates)}")
    print(f"Recent local records scanned for hidden FICON/RWY closures: {len(recent_local_candidates)}")
    print(f"Detail records to scan for MIL/FICON/AFLD status: {len(candidates)}")

    notams = []
    ficon_notams = []
    runway_closure_notams = []
    construction_status_notams = []
    taxi_restriction_notams = []
    inactive_notam_numbers = set()

    for item in sorted(candidates, key=local_number_key, reverse=True):
        time.sleep(REQUEST_DELAY_SECONDS)

        num = item.get("number")
        print(f"Pulling {num}...")

        detail = nms_get_json(
            "/notams",
            token,
            query={"location": LOCATION, "notamNumber": num},
            response_format="AIXM",
        )

        aixm_list = detail.get("data", {}).get("aixm", [])

        if not aixm_list:
            print(f"  No AIXM returned for {num}")
            continue

        root = parse_xml(aixm_list[0])
        txt = extract_event_text(root)
        classifications = all_text(root, "classification")
        last_updates = all_text(root, "lastUpdated")

        record = {
            "number": extract_notam_number(root, num),
            "classification": classifications[-1] if classifications else "MIL",
            "severity": severity(txt),
            "text": txt,
            "displayText": display_text(txt),
            "effectiveStart": first_text(root, "effectiveStart"),
            "effectiveEnd": first_text(root, "effectiveEnd"),
            "lastUpdated": last_updates[-1] if last_updates else item.get("lastUpdated"),
            "source": "FAA_NMS_STAGING",
        }

        record = apply_effective_fallback(record, txt)

        if is_notam_cancellation(record):
            cancellation_target = notam_cancellation_target(record)

            if cancellation_target:
                inactive_notam_numbers.add(cancellation_target)
                print(f"  Cancellation: {record['number']} cancels {cancellation_target}")
            else:
                print(f"  Cancellation: {record['number']} has no parseable target")
        elif is_notam_replacement(record):
            replacement_target = notam_replacement_target(record)

            if replacement_target:
                inactive_notam_numbers.add(replacement_target)
                print(f"  Replacement: {record['number']} replaces {replacement_target}")
            else:
                print(f"  Replacement: {record['number']} has no parseable target")

        txt_upper = txt.upper()

        # Keep runway/taxiway/apron FICON in the separate FICON list for RSC/RCR parsing.
        # Do not put FICON into the MIL NOTAM crawl.
        if "FICON" in txt_upper:
            ficon_notams.append(record)

        # Phase 85: export runway closure NOTAMs for display only.
        # This does not change ATIS-driven runway data block behavior.
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

        if str(record.get("classification", "")).upper() in ("MIL", "MILITARY") or record["number"].upper().startswith("M"):
            notams.append(record)

    # Apply every NOTAMC/NOTAMR target after the scan so action chains are
    # order-independent. NOTAMC action records are hidden; NOTAMR replacements
    # remain active unless a later action targets them.
    notams = filter_inactive_notam_records(notams, inactive_notam_numbers)
    ficon_notams = filter_inactive_notam_records(ficon_notams, inactive_notam_numbers)
    runway_closure_notams = filter_inactive_notam_records(runway_closure_notams, inactive_notam_numbers)
    construction_status_notams = filter_inactive_notam_records(construction_status_notams, inactive_notam_numbers)
    taxi_restriction_notams = filter_inactive_notam_records(taxi_restriction_notams, inactive_notam_numbers)

    result = {
        "status": "Success",
        "generatedZ": utc_now_z(),
        "location": LOCATION,
        "source": "FAA_NMS_STAGING",
        "milNotamCount": len(notams),
        "milNotamStatus": f"{len(notams)} ACTIVE" if notams else "NONE ACTIVE",
        "milNotamScrollText": "  |  ".join(
            f"{n['number']} {n['displayText']}" for n in notams
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
        "detailScanMode": "PHASE102_AFLD_STATUS_SCOPED",
        "detailRecordsScanned": len(candidates),
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print()
    print("KMEM MIL NOTAM pull complete.")
    print(f"Status: {result['milNotamStatus']}")
    print(f"FICON: {result['ficonNotamCount']} records")
    print(f"RWY closures: {result['runwayClosureNotamCount']} records")
    print(f"Construction/status: {result['constructionStatusNotamCount']} records")
    print(f"Taxi restrictions: {result['taxiRestrictionNotamCount']} records")
    print(f"Wrote:  {OUTPUT_FILE}")
    print()

    for n in notams:
        print(f"{n['severity'].upper():5} {n['number']}: {n['displayText']}")

    for n in ficon_notams:
        print(f"FICON {n['number']}: {n['displayText']}")

    for n in runway_closure_notams:
        eff_start = n.get("effectiveStart") or "UNK"
        eff_end = n.get("effectiveEnd") or "UFN"
        print(f"RWYCL {n['number']}: {n['displayText']} EFF {eff_start}-{eff_end}")

    for n in construction_status_notams:
        print(f"CONST {n['number']}: {n['displayText']}")

    for n in taxi_restriction_notams:
        print(f"TAXI  {n['number']}: {n['displayText']}")


if __name__ == "__main__":
    main()
