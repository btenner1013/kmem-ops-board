import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import time
from datetime import datetime, timezone, timedelta
from html import unescape
from http.cookiejar import CookieJar


# Force UTF-8 output so Windows Task Scheduler logs do not crash on arrows like → ↑ ↓.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


REPO_DIR = os.path.dirname(os.path.abspath(__file__))
RADAR_GIF_URL = "https://radar.weather.gov/ridge/standard/KNQA_loop.gif"
RADAR_GIF_PATH = os.path.join(REPO_DIR, "radar.gif")
ATIS_HISTORY_PATH = os.path.join(REPO_DIR, "atis_history.json")
ATIS_HISTORY_RETENTION_HOURS = 96
TAF_CURRENT_PATH = os.path.join(REPO_DIR, "taf_current.json")
LOCAL_CACHE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", REPO_DIR), "KMEMOpsBoard")
REPO_LAST_GOOD_WEATHER_PATH = os.path.join(REPO_DIR, "weather_last_good.json")
LAST_GOOD_WEATHER_PATH = os.path.join(LOCAL_CACHE_DIR, "weather_last_good.json")
TREND_HISTORY_PATH = os.path.join(LOCAL_CACHE_DIR, "weather_trend_history.json")
TREND_LOOKBACK_HOURS = 3

NMS_MIL_NOTAMS_SCRIPT_PATH = os.path.join(REPO_DIR, "nms_kmem_mil_notams_test.py")
NMS_MIL_NOTAMS_OUTPUT_PATH = os.path.join(REPO_DIR, "nms_kmem_mil_notams_output.json")
NMS_MIL_NOTAMS_TIMEOUT_SECONDS = 120

# ATIS.info is the direct API. DATIS Clowd currently mirrors/redirects to that
# same provider and remains as an endpoint fallback. ATIS Relay is fetched
# separately below and supplies the independent second provider family.
ATIS_JSON_API_URL_TEMPLATES = (
    "https://atis.info/api/{icao}",
    "https://datis.clowd.io/api/{icao}",
)
ATIS_PROVIDER_NAMES = ("ATIS_INFO_API", "ATIS_RELAY")


MEM_RUNWAY_PAIRS = [
    "9/27",
    "18L/36R",
    "18C/36C",
    "18R/36L"
]

PHONETIC_ALPHABET = {
    "A": "ALFA",
    "B": "BRAVO",
    "C": "CHARLIE",
    "D": "DELTA",
    "E": "ECHO",
    "F": "FOXTROT",
    "G": "GOLF",
    "H": "HOTEL",
    "I": "INDIA",
    "J": "JULIETT",
    "K": "KILO",
    "L": "LIMA",
    "M": "MIKE",
    "N": "NOVEMBER",
    "O": "OSCAR",
    "P": "PAPA",
    "Q": "QUEBEC",
    "R": "ROMEO",
    "S": "SIERRA",
    "T": "TANGO",
    "U": "UNIFORM",
    "V": "VICTOR",
    "W": "WHISKEY",
    "X": "XRAY",
    "Y": "YANKEE",
    "Z": "ZULU"
}


def log_trend(symbol):
    if symbol == "↑":
        return "UP"
    if symbol == "↓":
        return "DOWN"
    if symbol == "→":
        return "STEADY"
    return "UNKNOWN"


def run_cmd(command, allow_fail=False):
    print("Running:", " ".join(command))

    result = subprocess.run(
        command,
        cwd=REPO_DIR,
        text=True,
        capture_output=True
    )

    if result.stdout:
        print(result.stdout.strip())

    if result.stderr:
        print(result.stderr.strip())

    if result.returncode != 0 and not allow_fail:
        raise RuntimeError(f"Command failed: {' '.join(command)}")

    return result


def fetch_url(url, attempts=2, retry_delay_seconds=1.0, timeout_seconds=30):
    """Fetch text with a light retry so one transient HTTP 500/network hiccup does not
    immediately force the board into last-known-good weather.
    """
    last_error = None

    for attempt in range(1, max(1, attempts) + 1):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "text/html,application/json,text/plain,*/*",
                    "Cache-Control": "no-cache, no-store, max-age=0",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
            )

            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                return response.read().decode("utf-8", errors="ignore")

        except Exception as error:
            last_error = error
            if attempt < max(1, attempts):
                print(f"Fetch attempt {attempt} failed for {url}: {error}; retrying...")
                try:
                    time.sleep(float(retry_delay_seconds))
                except Exception:
                    pass
            else:
                print(f"Fetch failed for {url}: {error}")

    return ""


def fetch_first_nonempty(urls, label):
    """Try multiple equivalent/public URLs before falling back to last-known-good."""
    for url in urls:
        text = fetch_url(url)
        if text and text.strip():
            print(f"{label} fetch OK from {url}")
            return text
    print(f"{label} fetch failed for all configured URLs.")
    return ""


def choose_latest_metar_report(raw_text, now_z=None):
    """Return the newest METAR/SPECI line from an AWC raw response.

    AWC may return SPECI during rapidly changing weather. Treat SPECI as the current
    METAR observation source for this board. If multiple observations are returned,
    choose the newest parsed observation time rather than blindly taking a stale line.
    """
    raw = (raw_text or "").replace("\r", "\n")
    candidates = []

    for line in raw.split("\n"):
        report = re.sub(r"\s+", " ", line).strip()
        if not report:
            continue
        if is_good_metar(report):
            observed = parse_metar_datetime_utc(report, now_z)
            candidates.append((observed or datetime.min.replace(tzinfo=timezone.utc), report))

    if candidates:
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

    report = re.sub(r"\s+", " ", (raw_text or "")).strip()
    return report if is_good_metar(report) else ""


def relaxed_text_unescape(text):
    """Decode common HTML/JSON escape layers used by public ATIS pages."""
    value = str(text or "")

    for _ in range(2):
        value = unescape(value)
        try:
            value = urllib.parse.unquote(value)
        except Exception:
            pass

        value = (
            value.replace("\\n", " ")
            .replace("\\r", " ")
            .replace("\\t", " ")
            .replace('\\"', '"')
            .replace("\\/", "/")
        )

        def repl(match):
            try:
                return chr(int(match.group(1), 16))
            except Exception:
                return match.group(0)

        value = re.sub(r"\\u([0-9a-fA-F]{4})", repl, value)

    return value


def normalize_atis_candidate(candidate):
    text = relaxed_text_unescape(candidate)
    text = html_to_text(text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.strip(" \\\"'`.,;:")

    if not text:
        return ""

    # If the source begins with only INFO S 0554Z..., make it look like the
    # normal MEM ATIS wording used by the rest of the parser.
    if re.match(r"(?i)^INFO(?:RMATION)?\s+[A-Z]\s+\d{4}Z\b", text):
        text = "MEM ATIS " + text

    # Cut obvious trailing page/app boilerplate after the ATIS handoff wording.
    match = re.search(
        r"(?i)\bADVS?\s+YOU\s+HAVE\s+(?:INFO|INFORMATION)\s+[A-Z]\.?",
        text
    )
    if not match:
        match = re.search(
            r"(?i)\bADVS?\s+YOU\s+HAVE\s+(?:INFO|INFORMATION)\s+[A-Z]\.?",
            text
        )
    if match:
        text = text[:match.end()]

    return text[:2500]


def extract_atis_text(raw_text):
    """Extract a usable ATIS broadcast from raw HTML, JSON, or plain text.

    atis.info may serve a browser page or embedded app data; atisrelay serves
    HTML/text. This keeps the fetcher source-agnostic and returns one normalized
    ATIS string for downstream parsing.
    """
    raw = relaxed_text_unescape(raw_text)
    search_spaces = [raw, html_to_text(raw)]

    patterns = [
        r"(?is)\b(?:(?:KMEM|MEM)\s+)?(?:(?:ARR(?:IVAL)?|DEP(?:ARTURE)?)\s+)?ATIS\s+INFO(?:RMATION)?\s+[A-Z]\b.{20,2500}?\bADVS?\s+YOU\s+HAVE\s+(?:INFO|INFORMATION)\s+[A-Z]\.?",
        r"(?is)\b(?:(?:KMEM|MEM)\s+)?(?:(?:ARR(?:IVAL)?|DEP(?:ARTURE)?)\s+)?ATIS\s+INFO(?:RMATION)?\s+[A-Z]\s+\d{4}Z\b.{20,2500}",
        r"(?is)\bINFO(?:RMATION)?\s+[A-Z]\s+\d{4}Z\b.{20,2500}?\bADVS?\s+YOU\s+HAVE\s+(?:INFO|INFORMATION)\s+[A-Z]\.?",
        r"(?is)\bINFO(?:RMATION)?\s+[A-Z]\s+\d{4}Z\b.{20,2500}",
    ]

    for space in search_spaces:
        for pattern in patterns:
            match = re.search(pattern, space or "")
            if match:
                candidate = normalize_atis_candidate(match.group(0))
                if candidate and is_good_atis(candidate):
                    return candidate

    candidate = normalize_atis_candidate(raw)
    if candidate and is_good_atis(candidate):
        return candidate

    candidate = normalize_atis_candidate(html_to_text(raw))
    if candidate and is_good_atis(candidate):
        return candidate

    return "D-ATIS unavailable"


def atis_text_from_html(atis_html):
    return extract_atis_text(atis_html)


def normalize_atis_variant_hint(value):
    variant = re.sub(r"[^A-Z]", "", str(value or "").upper())
    if variant in {"ARR", "ARRIVAL", "ARRIVALS"}:
        return "ARR"
    if variant in {"DEP", "DEPARTURE", "DEPARTURES"}:
        return "DEP"
    if variant in {"ATIS", "BOTH", "COMBINED", "COMBINATION"}:
        return "COMBINED"
    return ""


def _atis_candidates_from_json(data, metadata=None):
    """Return every valid ATIS string found in a structured API response."""
    fields = {"atis", "datis", "text", "atistext", "message", "body", "data", "report"}
    candidates = []

    def walk(value, inherited_variant=""):
        if isinstance(value, dict):
            local_variant = normalize_atis_variant_hint(
                value.get("type") or value.get("variant")
            ) or inherited_variant
            for key, child in value.items():
                if str(key).lower() in fields and isinstance(child, str):
                    candidate = extract_atis_text(child)
                    if is_good_atis(candidate) and candidate not in candidates:
                        candidates.append(candidate)
                    if metadata is not None and is_good_atis(candidate):
                        variant = local_variant or parse_atis_variant(candidate)
                        metadata.setdefault(candidate, set()).add(variant)
                elif isinstance(child, (dict, list)):
                    walk(child, local_variant)
        elif isinstance(value, list):
            for child in value:
                walk(child, inherited_variant)

    walk(data)
    return candidates


def fetch_atis_info_api_candidates(icao="KMEM", metadata=None):
    """Fetch all parseable reports from structured D-ATIS API sources.

    A provider can briefly return more than one report or regress to an older
    cached report.  Returning all candidates lets the caller compare the ATIS
    header timestamps instead of accepting the first parseable string.
    """
    candidates = [template.format(icao=icao) for template in ATIS_JSON_API_URL_TEMPLATES]
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    reports = []
    for url in candidates:
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read().decode("utf-8", errors="ignore")
        except Exception as err:
            print(f"D-ATIS JSON API miss {url}: {err}")
            continue
        if not raw or not raw.strip():
            print(f"D-ATIS JSON API empty response from {url}; trying next.")
            continue
        print(f"D-ATIS JSON API response from {url}: {raw[:200]}")
        try:
            data = json.loads(raw)
        except Exception:
            data = None
        if data is not None:
            found_metadata = {}
            found = _atis_candidates_from_json(data, found_metadata)
            if found:
                print(f"D-ATIS fetch found {len(found)} report(s) in D-ATIS JSON API ({url})")
                for candidate in found:
                    if candidate not in reports:
                        reports.append(candidate)
                    if metadata is not None:
                        metadata.setdefault(candidate, set()).update(
                            found_metadata.get(candidate) or {parse_atis_variant(candidate)}
                        )
            else:
                print(f"D-ATIS JSON API JSON at {url} had no recognized ATIS field; trying next.")
            continue
        candidate = extract_atis_text(raw)
        if is_good_atis(candidate):
            print(f"D-ATIS fetch OK from D-ATIS JSON API plain-text ({url})")
            if candidate not in reports:
                reports.append(candidate)
            if metadata is not None:
                metadata.setdefault(candidate, set()).add(parse_atis_variant(candidate))
        else:
            print(f"D-ATIS JSON API plain-text at {url} did not contain valid ATIS; trying next.")
    return reports


def fetch_atis_info_api(icao="KMEM", now_z=None):
    """Compatibility wrapper returning the newest structured API report."""
    return choose_latest_atis_report(fetch_atis_info_api_candidates(icao), now_z, default="")


def fetch_current_atis(
    urls,
    now_z=None,
    known_observed_times=None,
    diagnostics=None,
    live_candidates=None,
):
    """Fetch every configured ATIS source and return the newest valid report."""
    reports = []
    report_sources = {}
    report_variants = {}

    if live_candidates is not None:
        live_candidates.clear()

    def add_report(report, source, variants=None):
        report = extract_atis_text(report)
        if not is_good_atis(report):
            return
        if report not in reports:
            reports.append(report)
        report_sources.setdefault(report, set()).add(source)
        header_variant = parse_atis_variant(report)
        variant_hints = set(variants or []) if not isinstance(variants, str) else {variants}
        normalized_hints = {
            normalize_atis_variant_hint(variant)
            for variant in variant_hints
            if normalize_atis_variant_hint(variant)
        }
        if header_variant != "COMBINED":
            normalized_hints = {header_variant}
        report_variants.setdefault(report, set()).update(normalized_hints or {"COMBINED"})

    try:
        api_metadata = {}
        api_reports = fetch_atis_info_api_candidates("KMEM", metadata=api_metadata)
    except Exception as err:
        # Each provider family is independent. A timeout or parser failure in one
        # must not prevent a current report from the other family from winning.
        print(f"D-ATIS JSON API provider failed: {err}")
        api_reports = []
    for report in api_reports:
        add_report(report, "ATIS_INFO_API", api_metadata.get(report))

    if not api_reports:
        print("D-ATIS JSON API: no valid ATIS returned; trying remaining sources.")

    for url in urls:
        if "atis.info" in url:
            print(f"D-ATIS skipping JS-rendered page {url} (use API instead).")
            continue
        # ATIS has multiple independent sources; one unavailable relay must not
        # stall the entire ten-minute update cycle for repeated 30-second waits.
        try:
            raw = fetch_url(url, attempts=1, timeout_seconds=10)
        except Exception as err:
            print(f"D-ATIS relay provider failed for {url}: {err}")
            continue
        if not raw or not raw.strip():
            continue
        atis_text = atis_text_from_html(raw)
        if is_good_atis(atis_text):
            print(f"D-ATIS fetch OK from {url}")
            add_report(atis_text, "ATIS_RELAY")
        else:
            print(f"D-ATIS fetch from {url} did not contain valid ATIS text; trying next source.")

    selected = choose_latest_atis_report(
        reports,
        now_z,
        known_observed_times=known_observed_times,
    )

    if live_candidates is not None:
        for report in reports:
            observed = resolve_atis_observed_datetime(report, now_z, known_observed_times)
            for variant in sorted(report_variants.get(report) or {"COMBINED"}):
                live_candidates.append({
                    "isLive": True,
                    "isFallback": False,
                    "station": "KMEM",
                    "observedZ": zulu_iso(observed),
                    "letter": parse_atis_letter(report),
                    "variant": variant,
                    "raw": report,
                    "sources": sorted(report_sources.get(report, set())),
                })

    if diagnostics is not None:
        candidate_details = []
        for report in reports:
            observed = resolve_atis_observed_datetime(report, now_z, known_observed_times)
            candidate_details.append({
                "identity": atis_report_identity(report),
                "observedZ": zulu_iso(observed),
                "sources": sorted(report_sources.get(report, set())),
            })
        diagnostics.clear()
        diagnostics.update({
            "policy": "NEWEST_HEADER_TIME",
            "sourcesChecked": list(ATIS_PROVIDER_NAMES),
            "endpointsChecked": [
                template.format(icao="KMEM")
                for template in ATIS_JSON_API_URL_TEMPLATES
            ] + list(urls),
            "candidateCount": len(reports),
            "candidates": candidate_details,
            "selectedSources": sorted(report_sources.get(selected, set())),
        })

    if is_good_atis(selected):
        observed = resolve_atis_observed_datetime(selected, now_z, known_observed_times)
        selected_sources = "+".join(sorted(report_sources.get(selected, set()))) or "UNKNOWN"
        print(
            f"D-ATIS selected newest of {len(reports)} report(s): "
            f"{zulu_iso(observed) or 'TIME UNKNOWN'} via {selected_sources}"
        )
        return selected

    print("D-ATIS fetch failed for all configured URLs.")
    return "D-ATIS unavailable"


def fetch_with_opener(opener, url):
    try:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://www.usahas.com/print.aspx",
                "X-Requested-With": "XMLHttpRequest"
            }
        )

        with opener.open(request, timeout=30) as response:
            return response.read().decode("utf-8", errors="ignore")

    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="ignore")
        print(f"AHAS HTTP error {error.code}: {body[:500]}")
        return ""

    except Exception as error:
        print(f"AHAS fetch failed for {url}: {error}")
        return ""


def html_to_text(html):
    html = re.sub(r"(?is)<script.*?</script>", " ", html)
    html = re.sub(r"(?is)<style.*?</style>", " ", html)
    html = re.sub(r"(?is)<[^>]+>", " ", html)
    text = unescape(html)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def load_json_file(path):
    try:
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return {}


def cached_atis_observed_datetime(data):
    """Return a cache's persisted ATIS time without re-dating an old report."""
    if not isinstance(data, dict):
        return None

    report = data.get("atisText", "")
    if not is_good_atis(report):
        return None

    observed = parse_z_datetime(data.get("atisObservedZ", ""))
    if observed:
        return observed

    # Older cache files may predate atisObservedZ. Anchor their HHMMZ header to
    # the file's own update time, never to today's date.
    cache_updated = parse_z_datetime(
        data.get("allFeedsUpdatedZ", "") or data.get("lastUpdatedZ", "")
    )
    if cache_updated:
        return parse_atis_datetime_utc(report, cache_updated)
    return None


def load_previous_weather():
    """
    Load the preferred weather cache, then overlay the newest cached ATIS.

    This prevents a weak GitHub/manual fallback weather.json from becoming the only
    backup source after git reset --hard origin/main. Location priority continues
    to govern the other weather fields, but it must not make an older cached ATIS
    beat a newer one with a persisted observation time.
    """
    weather_path = os.path.join(REPO_DIR, "weather.json")
    sources = [
        ("LOCAL_LAST_GOOD", LAST_GOOD_WEATHER_PATH),
        ("REPO_LAST_GOOD", REPO_LAST_GOOD_WEATHER_PATH),
        ("REPO_WEATHER", weather_path),
    ]
    loaded = []

    for priority, (source_name, path) in enumerate(sources):
        data = load_json_file(path)
        if data:
            loaded.append((priority, source_name, path, data))

    if not loaded:
        return {}

    _, base_source, base_path, base_data = loaded[0]
    previous = dict(base_data)
    print(f"Loaded preferred previous weather cache ({base_source}): {base_path}")

    atis_candidates = []
    for priority, source_name, path, data in loaded:
        report = data.get("atisText", "")
        if not is_good_atis(report):
            continue
        observed = cached_atis_observed_datetime(data)
        atis_candidates.append((observed, priority, source_name, path, data))

    if atis_candidates:
        # A known full timestamp beats an unknown one; time beats location
        # priority; location priority is retained only as the final tie-break.
        oldest = datetime.min.replace(tzinfo=timezone.utc)
        selected = max(
            atis_candidates,
            key=lambda item: (item[0] is not None, item[0] or oldest, -item[1]),
        )
        observed, _, atis_source, atis_path, atis_data = selected
        previous["atisText"] = atis_data.get("atisText", "")
        previous["atisObservedZ"] = zulu_iso(observed) or atis_data.get("atisObservedZ", "")
        previous["atisReportIdentity"] = (
            atis_data.get("atisReportIdentity")
            or atis_report_identity(previous["atisText"])
        )
        print(
            f"Selected newest cached D-ATIS from {atis_source}: {atis_path} "
            f"({previous['atisObservedZ'] or 'TIME UNKNOWN'})"
        )

    return previous


def save_last_good_weather(data):
    try:
        os.makedirs(LOCAL_CACHE_DIR, exist_ok=True)

        with open(LAST_GOOD_WEATHER_PATH, "w", encoding="utf-8") as file:
            json.dump(data, file, indent=2)

        print(f"Last-known-good cache saved: {LAST_GOOD_WEATHER_PATH}")
    except Exception as error:
        print("Unable to save last-known-good cache:", error)


def save_repo_last_good_weather(data, reason=""):
    """
    Saves a repo-local last-good copy.

    This file is intentionally separate from weather.json so a bad or partial update
    does not erase the most recent known-good operational data. Keep it ignored by Git.
    """
    try:
        if not isinstance(data, dict) or not data:
            print("Repo last-good backup skipped: no valid data object.")
            return False

        if not should_save_last_good(data):
            print("Repo last-good backup skipped: current data did not pass quality checks.")
            return False

        with open(REPO_LAST_GOOD_WEATHER_PATH, "w", encoding="utf-8") as file:
            json.dump(data, file, indent=2)

        suffix = f" ({reason})" if reason else ""
        print(f"Repo last-good backup saved: {REPO_LAST_GOOD_WEATHER_PATH}{suffix}")
        return True

    except Exception as error:
        print("Unable to save repo last-good backup:", error)
        return False


def snapshot_current_weather_before_overwrite(weather_path):
    """
    Before writing a new weather.json, copy the current valid weather.json to
    weather_last_good.json. This protects against bad JSON writes, partial updates,
    and source hiccups during the next update cycle.
    """
    current_data = load_json_file(weather_path)

    if not current_data:
        print("Repo last-good pre-write snapshot skipped: current weather.json missing or invalid.")
        return False

    return save_repo_last_good_weather(current_data, "pre-write snapshot")


def parse_z_datetime(value):
    if not value:
        return None

    text = str(value).strip()

    for fmt in [
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%SZ",
        "%Y-%m-%d %H:%MZ"
    ]:
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except Exception:
            pass

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def parse_notam_datetime(value):
    if not value:
        return None

    text = str(value).strip().upper()

    if not text or text in {"UFN", "FURTHER NOTICE", "UNTIL FURTHER NOTICE"}:
        return None

    compact = re.search(r"\b(\d{12}|\d{10})\b", text)
    if compact:
        token = compact.group(1)
        if len(token) == 10:
            token = "20" + token
        try:
            return datetime.strptime(token, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        except Exception:
            pass

    month_map = {
        "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4,
        "MAY": 5, "JUN": 6, "JUL": 7, "AUG": 8,
        "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12
    }

    def month_notam_datetime(day, month, year, hhmm):
        if month not in month_map:
            return None
        year = int(year)
        hour = int(hhmm[:2])
        minute = int(hhmm[2:4])
        if year < 1900 or year > 2100 or hour > 23 or minute > 59:
            return None
        return datetime(year, month_map[month], int(day), hour, minute, tzinfo=timezone.utc)

    m = re.search(r"\b(\d{1,2})\s+([A-Z]{3})\s+(\d{4})\s+(\d{4})Z?\b", text)
    if m:
        try:
            parsed = month_notam_datetime(m.group(1), m.group(2), m.group(3), m.group(4))
            if parsed:
                return parsed
        except Exception:
            pass

    m = re.search(r"\b(\d{1,2})\s+([A-Z]{3})\s+(\d{4})Z?(?:\s+(\d{4}))?\b", text)
    if m:
        try:
            parsed = month_notam_datetime(m.group(1), m.group(2), m.group(4) or datetime.now(timezone.utc).year, m.group(3))
            if parsed:
                return parsed
        except Exception:
            pass

    return parse_z_datetime(text)


def notam_is_current(item, now_z=None):
    now_z = now_z or datetime.now(timezone.utc)

    if not isinstance(item, dict):
        return True

    start = parse_notam_datetime(
        item.get("effectiveStart")
        or item.get("start")
        or item.get("validFrom")
        or item.get("effectiveFrom")
    )
    end = parse_notam_datetime(
        item.get("effectiveEnd")
        or item.get("end")
        or item.get("validTo")
        or item.get("effectiveTo")
    )

    if start and now_z < start:
        return False

    if end and now_z >= end:
        return False

    return True




def zulu_iso(dt):
    """Return a stable UTC ISO string for weather source timestamps."""
    if not dt:
        return ""
    try:
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def source_age_minutes(observed_dt, now_z=None):
    """Return source age in whole minutes, or None when the source time is unknown."""
    if not observed_dt:
        return None
    now_z = now_z or datetime.now(timezone.utc)
    try:
        age = (now_z - observed_dt.astimezone(timezone.utc)).total_seconds() / 60.0
        # A small negative age can happen around source clock skew; clamp it.
        if age < 0 and age > -10:
            age = 0
        return int(round(age))
    except Exception:
        return None


def freshness_status(fetch_status, age_minutes, warn_minutes, stale_minutes):
    """
    Separate "fetch worked" from "source content is current."  A stale source should
    not remain OK just because the HTTP request succeeded.
    """
    status = (fetch_status or "FAILED").upper()

    if status.startswith("FAILED"):
        return status

    if age_minutes is None:
        if status == "USED_LAST_GOOD":
            return "LAST_GOOD_TIME_UNKNOWN"
        if status == "OK":
            return "SOURCE_TIME_UNKNOWN"
        return status

    if age_minutes >= stale_minutes:
        if status == "USED_LAST_GOOD":
            return "STALE_LAST_GOOD"
        return "STALE_SOURCE"

    if age_minutes >= warn_minutes:
        if status == "USED_LAST_GOOD":
            return "WARN_LAST_GOOD"
        return "WARN_SOURCE"

    return status


def parse_metar_datetime_utc(metar_text, now_z=None):
    """
    Parse a METAR observation time from DDHHMMZ and infer the month/year from now.
    Example: METAR KMEM 110033Z ...
    """
    if not metar_text:
        return None

    now_z = now_z or datetime.now(timezone.utc)
    text = str(metar_text).upper()
    match = re.search(r"\b(?:METAR\s+|SPECI\s+)?[A-Z]{4}\s+(\d{2})(\d{2})(\d{2})Z\b", text)
    if not match:
        match = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", text)
    if not match:
        return None

    day = int(match.group(1))
    hour = int(match.group(2))
    minute = int(match.group(3))

    # Try current month first, then nearby month boundaries.
    candidates = []
    for month_offset in (0, -1, 1):
        year = now_z.year
        month = now_z.month + month_offset
        if month < 1:
            month = 12
            year -= 1
        elif month > 12:
            month = 1
            year += 1
        try:
            candidates.append(datetime(year, month, day, hour, minute, tzinfo=timezone.utc))
        except ValueError:
            pass

    if not candidates:
        return None

    # Prefer the candidate closest to now, with a bias against future times.
    not_future = [c for c in candidates if c <= now_z + timedelta(minutes=10)]
    if not_future:
        return max(not_future)
    return min(candidates, key=lambda c: abs((c - now_z).total_seconds()))


def parse_atis_datetime_utc(atis_text, now_z=None):
    """
    Parse a D-ATIS observation/update time from HHMMZ style tokens. ATIS text often
    lacks the UTC day, so infer the most recent plausible time.
    """
    if not atis_text:
        return None

    now_z = now_z or datetime.now(timezone.utc)
    text = str(atis_text).upper()

    # Only accept a time tied to the ATIS header/update wording.  A generic HHMMZ
    # fallback can mistake a NOTAM or laser-event time later in the broadcast for
    # the report time and make an old ATIS look current.
    patterns = [
        r"\b(?:(?:KMEM|MEM)\s+)?(?:(?:ARR(?:IVAL)?|DEP(?:ARTURE)?)\s+)?ATIS\s+INFO(?:RMATION)?\s+[A-Z]\D{0,12}\b(\d{2})(\d{2})Z\b",
        r"\bINFO(?:RMATION)?\s+[A-Z]\D{0,12}\b(\d{2})(\d{2})Z\b",
        r"\b(?:ATIS\s+)?(?:UPDATED|UPDATE|OBS|OBSERVATION|TIME)\D{0,12}\b(\d{2})(\d{2})Z\b",
    ]

    candidates = []
    for pattern in patterns:
        for h, m in re.findall(pattern, text):
            hour = int(h)
            minute = int(m)
            if hour > 23 or minute > 59:
                continue

            for day_offset in (0, -1, 1):
                base = now_z + timedelta(days=day_offset)
                try:
                    dt = datetime(base.year, base.month, base.day, hour, minute, tzinfo=timezone.utc)
                    candidates.append(dt)
                except ValueError:
                    pass
        if candidates:
            break

    if not candidates:
        return None

    plausible = [c for c in candidates if c <= now_z + timedelta(minutes=10)]
    if plausible:
        return max(plausible)
    return min(candidates, key=lambda c: abs((c - now_z).total_seconds()))


def atis_report_identity(atis_text):
    """Return a stable letter/header-time identity across source formatting changes."""
    text = str(atis_text or "").upper()
    letter = parse_atis_letter(text)
    if letter == "--":
        return ""

    patterns = [
        r"\b(?:(?:KMEM|MEM)\s+)?(?:(?:ARR(?:IVAL)?|DEP(?:ARTURE)?)\s+)?ATIS\s+INFO(?:RMATION)?\s+[A-Z]\D{0,12}\b(\d{4})Z\b",
        r"\bINFO(?:RMATION)?\s+[A-Z]\D{0,12}\b(\d{4})Z\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return f"{letter}:{match.group(1)}Z"
    return ""


def _known_atis_observed_times(known_observed_times):
    """Normalize report-text keys and persisted full UTC timestamps."""
    normalized = {}
    for raw_report, raw_observed in (known_observed_times or {}).items():
        report = extract_atis_text(raw_report)
        if not is_good_atis(report):
            continue
        observed = raw_observed if isinstance(raw_observed, datetime) else parse_z_datetime(raw_observed)
        if observed:
            identity = atis_report_identity(report)
            normalized[identity or report] = observed.astimezone(timezone.utc)
    return normalized


def resolve_atis_observed_datetime(atis_text, now_z=None, known_observed_times=None):
    """Resolve an ATIS time without re-dating an unchanged cached report."""
    report = extract_atis_text(atis_text)
    known = _known_atis_observed_times(known_observed_times)
    identity = atis_report_identity(report)
    known_key = identity or report
    if known_key in known:
        return known[known_key]
    return parse_atis_datetime_utc(report, now_z)


def choose_latest_atis_report(
    candidates,
    now_z=None,
    default="D-ATIS unavailable",
    known_observed_times=None,
):
    """Choose the newest valid ATIS by its header timestamp.

    A report with a known header time always outranks one whose only times
    appear in operational notices. At equal header times, advance through the
    ATIS information-letter sequence relative to the persisted report before
    using source order as the final tie-breaker.
    """
    now_z = now_z or datetime.now(timezone.utc)
    valid = []
    seen = set()
    known = _known_atis_observed_times(known_observed_times)

    known_letters = []
    for known_identity, known_observed in known.items():
        match = re.match(r"^([A-Z]):\d{4}Z$", str(known_identity).upper())
        if match:
            known_letters.append((known_observed, match.group(1)))
    reference_observed, reference_letter = max(
        known_letters,
        default=(None, ""),
        key=lambda item: item[0] or datetime.min.replace(tzinfo=timezone.utc),
    )

    def letter_progress_score(candidate, observed):
        if not reference_letter or not reference_observed or not observed:
            return None
        # The alphabet wraps every 26 revisions. A persisted report that is many
        # hours old cannot reliably establish whether an equal-time letter moved
        # forward or wrapped, so use provider priority instead in that case.
        if abs(observed - reference_observed) > timedelta(hours=6):
            return None
        letter = parse_atis_letter(candidate)
        if letter == "--":
            return None
        distance = (ord(letter) - ord(reference_letter)) % 26
        # Treat up to half the alphabet as forward progress; values beyond that
        # are more plausibly an older provider lagging one or more revisions.
        return distance if distance <= 13 else distance - 26

    for source_order, raw_candidate in enumerate(candidates or []):
        candidate = extract_atis_text(raw_candidate)
        if not is_good_atis(candidate) or candidate in seen:
            continue
        seen.add(candidate)
        identity = atis_report_identity(candidate)
        observed = known.get(identity or candidate) or parse_atis_datetime_utc(candidate, now_z)
        valid.append((observed, source_order, candidate))

    if not valid:
        return default

    timed = [item for item in valid if item[0] is not None]
    if timed:
        newest_observed = max(item[0] for item in timed)
        newest_letters = {
            parse_atis_letter(item[2])
            for item in timed
            if item[0] == newest_observed and parse_atis_letter(item[2]) != "--"
        }

        def unanchored_letter_score(candidate):
            """Order a small equal-time revision cluster without a cache anchor."""
            letter = parse_atis_letter(candidate)
            if letter == "--" or len(newest_letters) < 2:
                return 0
            score = 0
            for other in newest_letters:
                if other == letter:
                    continue
                distance = (ord(letter) - ord(other)) % 26
                score += distance if distance <= 13 else distance - 26
            return score

        def revision_score(item):
            anchored = letter_progress_score(item[2], item[0])
            return anchored if anchored is not None else unanchored_letter_score(item[2])

        # Prefer the earliest configured source only when time and letter
        # progression both tie.
        return max(
            timed,
            key=lambda item: (item[0], revision_score(item), -item[1]),
        )[2]

    return min(valid, key=lambda item: item[1])[2]


def load_trend_history():
    history = load_json_file(TREND_HISTORY_PATH)

    if not isinstance(history, list):
        return []

    return history


def save_trend_history(history):
    try:
        os.makedirs(LOCAL_CACHE_DIR, exist_ok=True)

        with open(TREND_HISTORY_PATH, "w", encoding="utf-8") as file:
            json.dump(history, file, indent=2)

        print(f"Trend history saved: {TREND_HISTORY_PATH}")
    except Exception as error:
        print("Unable to save trend history:", error)


def as_number(value):
    if isinstance(value, (int, float)):
        return float(value)

    if isinstance(value, str):
        try:
            return float(value.replace("FT", "").replace("SM", "").strip())
        except Exception:
            return None

    return None


def build_trend_sample(timestamp_z, altimeter, visibility_sm, ceiling_ft, wind_data, temp_c, dewpoint_c):
    return {
        "timestampZ": timestamp_z.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "altimeterRaw": altimeter,
        "visibilitySm": visibility_sm,
        "ceilingFt": ceiling_ft,
        "windSpeedKt": wind_data.get("windSpeedKt") if wind_data else None,
        "windGustKt": wind_data.get("windGustKt") if wind_data else None,
        "tempC": temp_c,
        "dewpointC": dewpoint_c
    }


def prune_and_append_trend_sample(history, sample, now_z):
    cutoff_seconds = (TREND_LOOKBACK_HOURS * 60 * 60) + (30 * 60)
    cleaned = []

    for item in history:
        ts = parse_z_datetime(item.get("timestampZ"))
        if not ts:
            continue

        if (now_z - ts).total_seconds() <= cutoff_seconds:
            cleaned.append(item)

    cleaned.append(sample)

    # Keep the file small even if the updater runs more often later.
    return cleaned[-80:]


def choose_trend_reference_sample(history, now_z):
    cutoff = now_z.timestamp() - (TREND_LOOKBACK_HOURS * 60 * 60)
    candidates = []

    for item in history:
        ts = parse_z_datetime(item.get("timestampZ"))
        if not ts:
            continue

        # Use the oldest available sample inside the last 3 hours.
        if ts.timestamp() >= cutoff and ts < now_z:
            candidates.append((ts, item))

    if not candidates:
        return None

    candidates.sort(key=lambda pair: pair[0])
    return candidates[0][1]


def reference_numeric(reference_sample, previous_data, key, fallback_parser=None):
    if reference_sample and key in reference_sample:
        value = as_number(reference_sample.get(key))
        if value is not None:
            return value

    return parse_previous_numeric(previous_data, key, fallback_parser)


def trend_symbol_threshold(current, previous, threshold):
    if current is None or previous is None:
        return "→"

    delta = float(current) - float(previous)

    if abs(delta) < threshold:
        return "→"

    if delta > 0:
        return "↑"

    return "↓"


def visibility_category_value(value):
    if value is None:
        return None

    if value < 1:
        return 0
    if value < 3:
        return 1
    if value <= 5:
        return 2
    return 3


def ceiling_category_value(value):
    # Treat unlimited/no ceiling as best category for trend purposes.
    if value is None:
        return 3

    if value < 500:
        return 0
    if value < 1000:
        return 1
    if value <= 3000:
        return 2
    return 3


def visibility_trend_meaningful(current, previous):
    if current is None or previous is None:
        return "→"

    current_cat = visibility_category_value(current)
    previous_cat = visibility_category_value(previous)

    if current_cat != previous_cat:
        return "↑" if current_cat > previous_cat else "↓"

    return trend_symbol_threshold(current, previous, 1.0)


def ceiling_trend_meaningful(current, previous):
    if current is None and previous is None:
        return "→"

    current_cat = ceiling_category_value(current)
    previous_cat = ceiling_category_value(previous)

    if current_cat != previous_cat:
        return "↑" if current_cat > previous_cat else "↓"

    # Unlimited vs high VFR ceiling should not bounce the display.
    if current is None or previous is None:
        return "→"

    return trend_symbol_threshold(current, previous, 500.0)


def normalize_rwy_list(text):
    if not text:
        return "--"

    matches = re.findall(r"\b\d{1,2}[LCR]?\b", text.upper())

    if not matches:
        return "--"

    return " / ".join(matches)


def parse_runway_clauses(atis_text, patterns):
    """Collect and de-duplicate runways from every matching ATIS clause.

    Memphis broadcasts can state a simultaneous departure set and then append a
    separate departure-runway clause.  Returning after the first regex match
    silently dropped one of those sets.
    """
    text = (atis_text or "").upper()
    matches = []

    for pattern_order, pattern in enumerate(patterns):
        for match in re.finditer(pattern, text):
            matches.append((match.start(), pattern_order, match.group(1)))

    runways = []
    for _start, _pattern_order, clause in sorted(matches):
        for runway in re.findall(r"\b\d{1,2}[LCR]?\b", clause.upper()):
            if runway not in runways:
                runways.append(runway)

    return " / ".join(runways) if runways else "--"


def parse_atis_letter(atis_text):
    txt = (atis_text or "").upper()

    patterns = [
        r"\bATIS\s+INFO(?:RMATION)?\s+([A-Z])\b",
        r"\bINFO(?:RMATION)?\s+([A-Z])\b",
        r"\bADVS YOU HAVE INFO\s+([A-Z])\b"
    ]

    for pattern in patterns:
        match = re.search(pattern, txt)
        if match:
            return match.group(1)

    return "--"


def parse_atis_variant(atis_text):
    text = (atis_text or "").upper()
    if re.search(r"\b(?:KMEM|MEM)\s+ARR(?:IVAL)?\s+ATIS\b", text):
        return "ARR"
    if re.search(r"\b(?:KMEM|MEM)\s+DEP(?:ARTURE)?\s+ATIS\b", text):
        return "DEP"
    return "COMBINED"


def phonetic_for_letter(letter):
    if not letter or letter == "--":
        return "--"

    return PHONETIC_ALPHABET.get(letter.upper(), letter.upper())


def parse_arr_runways(atis_text):
    patterns = [
        r"SIMUL VISUAL APCH IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"SIMUL VISUAL APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"VISUAL APCH IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"VISUAL APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"SIMUL ILS APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"ILS APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"ILS APCH IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"APCH IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)"
    ]
    return parse_runway_clauses(atis_text, patterns)


def parse_dep_runways(atis_text):
    patterns = [
        r"DEPG RWYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPG RYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEP RWYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPARTING RWYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"SIMUL DEPS IN USE RY\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPS IN USE RY\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPARTURES IN USE RY\s+(.+?)(?:\.| NOTICE| RWY| RY |$)"
    ]
    return parse_runway_clauses(atis_text, patterns)


def parse_closed_runways(atis_text):
    txt = (atis_text or "").upper()
    txt = txt.replace("RUNWAY", "RWY")
    closed = []

    patterns = [
        r"\bRWYS?\s+([0-9LCR,\s/AND-]+?)\s+(?:CLSD|CLOSED)\b",
        r"\bRYS?\s+([0-9LCR,\s/AND-]+?)\s+(?:CLSD|CLOSED)\b"
    ]

    for pattern in patterns:
        for match in re.finditer(pattern, txt):
            group = normalize_rwy_list(match.group(1))
            if group != "--":
                closed.append(group)

    if not closed:
        return "NONE"

    unique = []
    for item in closed:
        if item not in unique:
            unique.append(item)

    return " / ".join(unique).replace(" /  / ", " / ")


def parse_rcr_rcc(atis_text):
    txt = (atis_text or "").upper()
    compact = re.sub(r"\s+", " ", txt)

    result = {
        "rcrText": "DRY / NONE RPTD",
        "rcrCode": "--",
        "rcrSeverity": "good",
        "rcrSource": "ATIS_SCAN",
        "rcrVisible": True,
        "rcrRaw": "--"
    }

    severe_patterns = [
        (r"\bBRAKING\s+NIL\b", "BRAKING NIL"),
        (r"\bNIL\s+BRAKING\b", "NIL BRAKING"),
        (r"\bBRAKING\s+ACTION\s+NIL\b", "BRAKING ACTION NIL"),
        (r"\bBRAKING\s+ACTION\s+POOR\b", "BRAKING ACTION POOR"),
        (r"\bPOOR\s+BRAKING\b", "POOR BRAKING"),
        (r"\bICE\b", "ICE"),
        (r"\bSLUSH\b", "SLUSH"),
        (r"\bWET\s+SNOW\b", "WET SNOW"),
        (r"\bSTANDING\s+WATER\b", "STANDING WATER"),
        (r"\bCONTAMINATED\b", "CONTAMINATED")
    ]

    for pattern, label in severe_patterns:
        if re.search(pattern, compact):
            result.update({
                "rcrText": f"CONTAMINATED / {label}",
                "rcrCode": "--",
                "rcrSeverity": "poor",
                "rcrRaw": label
            })
            return result

    code_match = re.search(r"\b([0-6])\s*/\s*([0-6])\s*/\s*([0-6])\b", compact)

    if code_match:
        code = f"{code_match.group(1)}/{code_match.group(2)}/{code_match.group(3)}"
        values = [
            int(code_match.group(1)),
            int(code_match.group(2)),
            int(code_match.group(3))
        ]
        lowest = min(values)

        start = max(0, code_match.start() - 45)
        end = min(len(compact), code_match.end() + 60)
        raw_context = compact[start:end].strip()

        if lowest == 6:
            text = "DRY"
            severity = "good"
        elif lowest == 5:
            text = f"RSC/RCR {code} GOOD"
            severity = "good"
        elif lowest == 4:
            text = f"RSC/RCR {code} CAUTION"
            severity = "caution"
        else:
            text = f"RSC/RCR {code} POOR"
            severity = "poor"

        result.update({
            "rcrText": text,
            "rcrCode": code,
            "rcrSeverity": severity,
            "rcrRaw": raw_context
        })
        return result

    dry_patterns = [
        r"\bRWY(?:S)?\s+(?:ARE\s+)?DRY\b",
        r"\bRUNWAY(?:S)?\s+(?:ARE\s+)?DRY\b",
        r"\bDRY\s+RUNWAY\b",
        r"\bDRY\s+RWY\b"
    ]

    for pattern in dry_patterns:
        if re.search(pattern, compact):
            result.update({
                "rcrText": "DRY",
                "rcrCode": "DRY",
                "rcrSeverity": "good",
                "rcrRaw": "DRY"
            })
            return result

    caution_patterns = [
        (r"\bBRAKING\s+ACTION\s+MEDIUM\b", "BRAKING ACTION MEDIUM"),
        (r"\bMEDIUM\s+BRAKING\b", "MEDIUM BRAKING"),
        (r"\bBRAKING\s+ACTION\s+FAIR\b", "BRAKING ACTION FAIR"),
        (r"\bWET\s+RUNWAY\b", "WET RUNWAY"),
        (r"\bWET\s+RWY\b", "WET RWY"),
        (r"\bRWY\s+WET\b", "RWY WET"),
        (r"\bRUNWAY\s+WET\b", "RUNWAY WET"),
        (r"\bPATCHY\s+WET\b", "PATCHY WET")
    ]

    for pattern, label in caution_patterns:
        if re.search(pattern, compact):
            result.update({
                "rcrText": f"RSC/RCR CAUTION / {label}",
                "rcrCode": "--",
                "rcrSeverity": "caution",
                "rcrRaw": label
            })
            return result

    generic_report_patterns = [
        (r"\bRCR\b", "RCR"),
        (r"\bRCC\b", "RCC"),
        (r"\bRWYCC\b", "RWYCC"),
        (r"\bFICON\b", "FICON"),
        (r"\bRUNWAY\s+CONDITION\s+CODE\b", "RUNWAY CONDITION CODE"),
        (r"\bBRAKING\s+ACTION\b", "BRAKING ACTION")
    ]

    for pattern, label in generic_report_patterns:
        if re.search(pattern, compact):
            result.update({
                "rcrText": "RSC/RCR MENTIONED - REVIEW ATIS",
                "rcrCode": "--",
                "rcrSeverity": "caution",
                "rcrRaw": label
            })
            return result

    return result



def default_rcr_rcc(source="NOTAM_FICON"):
    return {
        "rcrText": "DRY",
        "rcrCode": "DRY",
        "rcrSeverity": "good",
        "rcrSource": source,
        "rcrVisible": True,
        "rcrRaw": "--"
    }


def parse_rcr_rcc_from_ficon_notams(ficon_notams):
    """
    Primary RSC/RCR source for the board.

    Uses FAA/NMS FICON NOTAM text, not ATIS, because ATIS wording varies.
    Board rule:
      - no current runway FICON found: DRY
      - current runway 6/6/6: DRY
      - future/expired and non-runway FICON ignored
      - otherwise show the worst current runway code found
    """
    records = []
    now_z = datetime.now(timezone.utc)

    for item in ficon_notams or []:
        if isinstance(item, dict) and not notam_is_current(item, now_z):
            continue

        if isinstance(item, dict):
            text = " ".join([
                str(item.get("number") or ""),
                str(item.get("text") or ""),
                str(item.get("displayText") or ""),
                str(item.get("rawText") or "")
            ])
        else:
            text = str(item)

        compact = re.sub(r"\s+", " ", text.upper()).strip()

        for match in re.finditer(r"\bRWY\s+(\d{1,2}[LCR]?)\s+FICON\s+([0-6])\s*/\s*([0-6])\s*/\s*([0-6])\b([^.]*)", compact):
            runway = match.group(1)
            code = f"{match.group(2)}/{match.group(3)}/{match.group(4)}"
            values = [int(match.group(2)), int(match.group(3)), int(match.group(4))]
            lowest = min(values)

            tail = match.group(5) or ""
            condition = ""

            condition_keywords = [
                "WET SNOW", "DRY SNOW", "COMPACTED SNOW", "STANDING WATER",
                "SLUSH", "ICE", "WET", "DRY"
            ]

            for keyword in condition_keywords:
                if re.search(rf"\b{re.escape(keyword)}\b", tail):
                    condition = keyword
                    break

            records.append({
                "runway": runway,
                "code": code,
                "values": values,
                "lowest": lowest,
                "condition": condition,
                "raw": compact
            })

    if not records:
        return default_rcr_rcc("NOTAM_FICON_NONE")

    # If every runway is clean 6/6/6, keep the board simple.
    if all(record["code"] == "6/6/6" for record in records):
        return default_rcr_rcc("NOTAM_FICON_666")

    # Worst = lowest individual code first, then lowest total code.
    worst = sorted(records, key=lambda r: (r["lowest"], sum(r["values"])))[0]

    code = worst["code"]
    lowest = worst["lowest"]
    condition = worst["condition"]

    if lowest >= 5:
        severity = "good"
    elif lowest == 4:
        severity = "caution"
    else:
        severity = "poor"

    text = f"RSC/RCR {code}"
    if condition and condition != "DRY":
        text += f" {condition}"

    return {
        "rcrText": text,
        "rcrCode": code,
        "rcrSeverity": severity,
        "rcrSource": "NOTAM_FICON",
        "rcrVisible": True,
        "rcrRaw": worst["raw"]
    }


def determine_flow(arr, dep):
    combined = (arr + " " + dep).upper()
    flow_families = []

    for pattern, display in [
        (r"\b36[LCR]?\b", "NORTH ↑"),
        (r"\b18[LCR]?\b", "SOUTH ↓"),
        (r"\b0?9[LCR]?\b", "EAST →"),
        (r"\b27[LCR]?\b", "WEST ←"),
    ]:
        if re.search(pattern, combined):
            flow_families.append(display)

    if not flow_families:
        return "--"
    if len(flow_families) > 1:
        return "MIXED"
    return flow_families[0]


def parse_atis_operations(atis_text, atis_fetch_status="OK"):
    """Parse ATIS operational fields and suppress them when source age is unsafe."""
    reported_letter = parse_atis_letter(atis_text)
    reported_phonetic = phonetic_for_letter(reported_letter)
    reported_arr_runways = parse_arr_runways(atis_text)
    reported_dep_runways = parse_dep_runways(atis_text)
    reported_closed_runways = parse_closed_runways(atis_text)
    reported_flow = determine_flow(reported_arr_runways, reported_dep_runways)

    status = (atis_fetch_status or "FAILED").upper()
    source_is_current = status in {"OK", "USED_LAST_GOOD"}
    stale_closed_display = "ATIS STALE" if is_good_atis(atis_text) else "--"

    return {
        "atisLetter": reported_letter if source_is_current else "--",
        "atisPhonetic": reported_phonetic if source_is_current else "--",
        "atisDisplay": reported_phonetic if source_is_current and reported_phonetic != "--" else "--",
        "arrRunways": reported_arr_runways if source_is_current else "--",
        "depRunways": reported_dep_runways if source_is_current else "--",
        "closedRunways": reported_closed_runways if source_is_current else stale_closed_display,
        "flow": reported_flow if source_is_current else "--",
        "reportedLetter": reported_letter,
        "reportedPhonetic": reported_phonetic,
        "reportedArrRunways": reported_arr_runways,
        "reportedDepRunways": reported_dep_runways,
        "reportedClosedRunways": reported_closed_runways,
        "reportedFlow": reported_flow,
        "sourceIsCurrent": source_is_current,
    }


def parse_altimeter(metar):
    match = re.search(r"\bA(\d{4})\b", metar or "")

    if not match:
        return None

    raw = match.group(1)
    return int(raw) / 100.0


def parse_visibility_sm(metar):
    txt = metar or ""

    match = re.search(r"\b(\d+)\s+(\d+)/(\d+)SM\b", txt)
    if match:
        whole = float(match.group(1))
        numerator = float(match.group(2))
        denominator = float(match.group(3))
        return whole + numerator / denominator

    match = re.search(r"\bM?(\d+)/(\d+)SM\b", txt)
    if match:
        numerator = float(match.group(1))
        denominator = float(match.group(2))
        return numerator / denominator

    match = re.search(r"\bP?(\d{1,2})SM\b", txt)
    if match:
        return float(match.group(1))

    return None


def visibility_display_from_parts(whole=None, numerator=None, denominator=None, prefix=""):
    prefix = (prefix or "").upper()
    lead = "M" if prefix == "M" else "P" if prefix == "P" else ""

    if whole is not None and numerator is not None and denominator is not None:
        return f"{lead}{int(whole)} {int(numerator)}/{int(denominator)} SM"

    if numerator is not None and denominator is not None:
        return f"{lead}{int(numerator)}/{int(denominator)} SM"

    if whole is not None:
        return f"{lead}{int(whole)} SM"

    return ""


def parse_metar_visibility_display(metar):
    txt = metar or ""

    match = re.search(r"\b(\d+)\s+(\d+)/(\d+)SM\b", txt)
    if match:
        return visibility_display_from_parts(match.group(1), match.group(2), match.group(3))

    match = re.search(r"\b(M?)(\d+)/(\d+)SM\b", txt)
    if match:
        return visibility_display_from_parts(None, match.group(2), match.group(3), match.group(1))

    match = re.search(r"\b(P?)(\d{1,2})SM\b", txt)
    if match:
        return visibility_display_from_parts(match.group(2), None, None, match.group(1))

    return ""


def parse_wind(metar):
    txt = metar or ""

    # Standard METAR wind token examples: 13007KT, 18012G22KT, VRB04KT, 00000KT
    match = re.search(r"\b(?P<dir>\d{3}|VRB)(?P<speed>\d{2,3})(?:G(?P<gust>\d{2,3}))?KT\b", txt.upper())

    if not match:
        return {
            "windRaw": "--",
            "windDisplay": "--",
            "windDirDeg": None,
            "windSpeedKt": None,
            "windGustKt": None,
            "windArrow": "",
            "windArrowMeaning": "NO WIND DATA"
        }

    raw = match.group(0)
    direction = match.group("dir")
    speed = int(match.group("speed"))
    gust = int(match.group("gust")) if match.group("gust") else None

    if direction == "000" and speed == 0:
        return {
            "windRaw": raw,
            "windDisplay": "CALM",
            "windDirDeg": None,
            "windSpeedKt": speed,
            "windGustKt": gust,
            "windArrow": "",
            "windArrowMeaning": "CALM"
        }

    if direction == "VRB":
        return {
            "windRaw": raw,
            "windDisplay": raw,
            "windDirDeg": None,
            "windSpeedKt": speed,
            "windGustKt": gust,
            "windArrow": "",
            "windArrowMeaning": "VARIABLE"
        }

    direction_degrees = int(direction)

    return {
        "windRaw": raw,
        "windDisplay": raw,
        "windDirDeg": direction_degrees,
        "windSpeedKt": speed,
        "windGustKt": gust,
        "windArrow": wind_blowing_to_arrow(direction_degrees),
        "windArrowMeaning": "ARROW SHOWS WHERE WIND IS BLOWING TOWARD"
    }


def wind_blowing_to_arrow(from_degrees):
    if from_degrees is None:
        return ""

    # Aviation wind direction is where wind comes FROM.
    # Board arrow shows where wind is blowing TO, so rotate 180 degrees.
    to_degrees = (float(from_degrees) + 180.0) % 360.0

    sectors = [
        ("↑", 337.5, 360.0),
        ("↑", 0.0, 22.5),
        ("↗", 22.5, 67.5),
        ("→", 67.5, 112.5),
        ("↘", 112.5, 157.5),
        ("↓", 157.5, 202.5),
        ("↙", 202.5, 247.5),
        ("←", 247.5, 292.5),
        ("↖", 292.5, 337.5)
    ]

    for arrow, start, end in sectors:
        if start <= to_degrees < end:
            return arrow

    return "↑"


def wind_trend(current_speed, current_gust, previous_speed, previous_gust):
    if current_speed is None or previous_speed is None:
        return "►", "STEADY", "steady"

    current_peak = max([value for value in [current_speed, current_gust] if value is not None])
    previous_peak = max([value for value in [previous_speed, previous_gust] if value is not None])

    delta = current_peak - previous_peak

    # Avoid noisy one/two knot changes. Gust changes are included in peak wind.
    if abs(delta) < 3:
        return "►", "STEADY", "steady"

    if delta > 0:
        # More wind is generally more operational concern.
        return "▲", "INCREASING", "worsening"

    return "▼", "DECREASING", "improving"


def parse_temp_dewpoint(metar):
    txt = metar or ""

    # METAR temperature/dewpoint group examples: 27/13, M02/M05, 03/M01
    matches = re.findall(r"\b(M?\d{2})/(M?\d{2})\b", txt.upper())

    if not matches:
        return None, None

    temp_token, dew_token = matches[-1]

    def decode(token):
        if token.startswith("M"):
            return -int(token[1:])
        return int(token)

    return decode(temp_token), decode(dew_token)


def format_temp_value(value):
    if value is None:
        return "--"

    if value < 0:
        return f"M{abs(value):02d}"

    return f"{value:02d}"


def format_temp_dp(temp_c, dewpoint_c):
    if temp_c is None or dewpoint_c is None:
        return "--"

    return f"{format_temp_value(temp_c)}/{format_temp_value(dewpoint_c)}"


def numeric_trend_with_threshold(current, previous, threshold=1.0):
    if current is None or previous is None:
        return "►", "STEADY"

    delta = float(current) - float(previous)

    if abs(delta) < threshold:
        return "►", "STEADY"

    if delta > 0:
        return "▲", "RISING"

    return "▼", "FALLING"


def atis_observation_scan_text(atis_text):
    """Return the likely operational ATIS broadcast/weather section.

    ATIS relay pages can include boilerplate, NOTAMS/frequencies, and a copied
    METAR detail block after the broadcast. This helper keeps ATIS parsing focused
    on the broadcast portion used by crews.
    """
    text = re.sub(r"\s+", " ", (atis_text or "").upper()).strip()

    if not text or text_is_bad(text):
        return ""

    stop_markers = [
        " NOTICE: INFO FROM FAA SWIM",
        " NOTICE TO AIRMEN",
        " NOTAM ",
        " NOTAMS ",
        " LOADING FREQUENCIES",
        " FREQUENCIES ",
        " TEXT FOR ATIS ",
        " SEND KMEM "
    ]

    end = len(text)
    for marker in stop_markers:
        marker_idx = text.find(marker)
        if marker_idx != -1:
            end = min(end, marker_idx)

    text = text[:end].strip()

    start_candidates = []
    for marker in ["MEM ATIS INFO", "KMEM ATIS INFO", "ATIS INFO"]:
        marker_idx = text.find(marker)
        if marker_idx != -1:
            start_candidates.append(marker_idx)

    if start_candidates:
        text = text[min(start_candidates):]

    return text

def parse_atis_altimeter(atis_text):
    txt = atis_observation_scan_text(atis_text)

    match = re.search(r"\bALTIMETER\s+(\d{2}\.\d{2})\b", txt)
    if match:
        return float(match.group(1))

    match = re.search(r"\bALTIMETER\s+(\d{4})\b", txt)
    if match:
        raw = match.group(1)
        return int(raw) / 100.0

    # ATIS often includes standard weather string format, e.g. A3000.
    match = re.search(r"\bA(\d{4})\b", txt)
    if match:
        return int(match.group(1)) / 100.0

    return None

def atis_visibility_scan_text(atis_text):
    txt = atis_observation_scan_text(atis_text)
    return re.sub(
        r"\b(?:TWR|TOWER)\s+VIS(?:IBILITY)?\s+(?:\d+\s+\d+/\d+|M?\d+/\d+|P?\d{1,2})(?:\s*SM)?\b",
        " ",
        txt
    )


def parse_atis_visibility_sm(atis_text):
    txt = atis_visibility_scan_text(atis_text)

    patterns = [
        r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(\d+)\s+(\d+)/(\d+)(?:\s*SM)?\b",
        r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?M?(\d+)/(\d+)(?:\s*SM)?\b",
        r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(P?\d{1,2})(?:\s*SM)?\b"
    ]

    whole_frac = re.search(patterns[0], txt)
    if whole_frac:
        return float(whole_frac.group(1)) + float(whole_frac.group(2)) / float(whole_frac.group(3))

    frac = re.search(patterns[1], txt)
    if frac:
        return float(frac.group(1)) / float(frac.group(2))

    whole = re.search(patterns[2], txt)
    if whole:
        token = whole.group(1).replace("P", "")
        try:
            return float(token)
        except Exception:
            return None

    # ATIS commonly includes raw METAR-style visibility in the broadcast, e.g. 10SM or P6SM.
    match = re.search(r"\b(\d+)\s+(\d+)/(\d+)SM\b", txt)
    if match:
        return float(match.group(1)) + float(match.group(2)) / float(match.group(3))

    match = re.search(r"\bM?(\d+)/(\d+)SM\b", txt)
    if match:
        return float(match.group(1)) / float(match.group(2))

    match = re.search(r"\bP?(\d{1,2})SM\b", txt)
    if match:
        return float(match.group(1))

    return None


def parse_atis_visibility_display(atis_text):
    txt = atis_visibility_scan_text(atis_text)

    match = re.search(r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(\d+)\s+(\d+)/(\d+)(?:\s*SM)?\b", txt)
    if match:
        return visibility_display_from_parts(match.group(1), match.group(2), match.group(3))

    match = re.search(r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(M?)(\d+)/(\d+)(?:\s*SM)?\b", txt)
    if match:
        return visibility_display_from_parts(None, match.group(2), match.group(3), match.group(1))

    match = re.search(r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(P?)(\d{1,2})(?:\s*SM)?\b", txt)
    if match:
        return visibility_display_from_parts(match.group(2), None, None, match.group(1))

    return parse_metar_visibility_display(txt)


def parse_atis_wind(atis_text):
    txt = atis_observation_scan_text(atis_text)

    # D-ATIS text often says: WIND 130 AT 07, WIND 13007KT, WIND VRB AT 04, or WIND CALM.
    if re.search(r"\bWIND\s+CALM\b", txt):
        return {
            "windRaw": "00000KT",
            "windDisplay": "CALM",
            "windDirDeg": None,
            "windSpeedKt": 0,
            "windGustKt": None,
            "windArrow": "",
            "windArrowMeaning": "CALM"
        }

    standard = re.search(r"\bWIND\s+((?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT)\b", txt)
    if standard:
        return parse_wind(standard.group(1))

    bare_standard = re.search(r"\b((?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT)\b", txt)
    if bare_standard:
        return parse_wind(bare_standard.group(1))

    spoken = re.search(
        r"\bWIND\s+(?P<dir>\d{3}|VRB)\s+(?:AT\s+)?(?P<speed>\d{1,3})(?:\s*(?:G|GUST|GUSTS)\s*(?P<gust>\d{1,3}))?\b",
        txt
    )

    if not spoken:
        return None

    direction = spoken.group("dir")
    speed = int(spoken.group("speed"))
    gust = int(spoken.group("gust")) if spoken.group("gust") else None

    if direction == "VRB":
        raw = f"VRB{speed:02d}" + (f"G{gust:02d}" if gust is not None else "") + "KT"
        return {
            "windRaw": raw,
            "windDisplay": raw,
            "windDirDeg": None,
            "windSpeedKt": speed,
            "windGustKt": gust,
            "windArrow": "",
            "windArrowMeaning": "VARIABLE"
        }

    direction_degrees = int(direction)
    raw = f"{direction}{speed:02d}" + (f"G{gust:02d}" if gust is not None else "") + "KT"

    return {
        "windRaw": raw,
        "windDisplay": raw,
        "windDirDeg": direction_degrees,
        "windSpeedKt": speed,
        "windGustKt": gust,
        "windArrow": wind_blowing_to_arrow(direction_degrees),
        "windArrowMeaning": "ARROW SHOWS WHERE WIND IS BLOWING TOWARD"
    }


def parse_atis_temp_dewpoint(atis_text):
    txt = atis_observation_scan_text(atis_text)

    patterns = [
        r"\bTEMP(?:ERATURE)?\s+(M?\d{1,2})\s+(?:DEW(?:POINT|\s+POINT)?|DP)\s+(M?\d{1,2})\b",
        r"\bTEMP(?:ERATURE)?\s+(M?\d{1,2})\s*/\s*(M?\d{1,2})\b",
        r"\b(M?\d{1,2})\s*/\s*(M?\d{1,2})\b"
    ]

    # Preserve minus values written as M05.
    for pattern in patterns:
        match = re.search(pattern, txt)
        if match:
            def decode(token):
                token = str(token).upper()
                if token.startswith("M"):
                    return -int(token[1:])
                return int(token)

            if "M?" in pattern:
                return decode(match.group(1)), decode(match.group(2))

            # First pattern did not capture the M prefix separately. Fall back to positive only.
            return int(match.group(1)), int(match.group(2))

    return None, None


def parse_best_observation_values(metar, atis_text, atis_fetch_status):
    """
    Select the operational current observation values for the board.

    Final rule set:
      - Wind: use the more restrictive current wind between ATIS and METAR.
        Higher gust wins first; if gusts are close, higher sustained speed wins;
        if still close, ATIS wins.
      - Altimeter: prefer ATIS when valid; METAR is backup.
      - Visibility: use the lower/more restrictive ATIS/METAR prevailing value.
        If effectively equal, ATIS wins. Preserve the selected source's fraction
        style for display, such as 1 1/2 SM or 1/4 SM.
      - Ceiling: use the lower/more restrictive value; if within 500 FT, ATIS wins.
      - Temp/dewpoint: prefer ATIS when valid; METAR is backup.

    The selected values feed both the display and the trend history, so trends follow
    the value the board is actually showing regardless of source.
    """
    metar_altimeter = parse_altimeter(metar)
    metar_visibility_sm = parse_visibility_sm(metar)
    metar_visibility_display = parse_metar_visibility_display(metar)
    metar_ceiling_ft = parse_ceiling_ft(metar)
    metar_wind = parse_wind(metar)
    metar_temp_c, metar_dewpoint_c = parse_temp_dewpoint(metar)

    atis_available = is_good_atis(atis_text) and atis_fetch_status in {"OK", "USED_LAST_GOOD"}

    atis_obs_text = atis_observation_scan_text(atis_text) if atis_available else ""

    atis_altimeter = parse_atis_altimeter(atis_obs_text) if atis_available else None
    atis_visibility_sm = parse_atis_visibility_sm(atis_obs_text) if atis_available else None
    atis_visibility_display = parse_atis_visibility_display(atis_obs_text) if atis_available else ""
    atis_ceiling_ft = parse_ceiling_ft(atis_obs_text) if atis_available else None
    atis_wind = parse_atis_wind(atis_obs_text) if atis_available else None
    atis_temp_c, atis_dewpoint_c = parse_atis_temp_dewpoint(atis_obs_text) if atis_available else (None, None)

    field_sources = {}

    def valid_wind(wind):
        return bool(wind and wind.get("windDisplay") not in {None, "", "--"})

    def choose_altimeter(atis_value, metar_value):
        # Crews hear/use ATIS altimeter; METAR is backup.
        if atis_value is not None:
            field_sources["altimeter"] = "ATIS"
            return atis_value
        field_sources["altimeter"] = "METAR" if metar_value is not None else "NONE"
        return metar_value

    def choose_visibility(atis_value, metar_value):
        # Lower visibility is more restrictive. TWR VIS is stripped before ATIS
        # parsing, so only ATIS/METAR prevailing visibility can drive the board.
        if atis_value is not None and metar_value is not None:
            if float(atis_value) < float(metar_value) - 0.05:
                field_sources["visibility"] = "ATIS"
                return atis_value
            if float(metar_value) < float(atis_value) - 0.05:
                field_sources["visibility"] = "METAR"
                return metar_value
            field_sources["visibility"] = "ATIS"
            return atis_value

        if atis_value is not None:
            field_sources["visibility"] = "ATIS"
            return atis_value

        field_sources["visibility"] = "METAR" if metar_value is not None else "NONE"
        return metar_value

    def choose_ceiling(atis_value, metar_value):
        # A missing ceiling means unlimited/no reported ceiling and is less restrictive.
        if atis_value is not None and metar_value is not None:
            if abs(int(atis_value) - int(metar_value)) <= 500:
                field_sources["ceiling"] = "ATIS"
                return atis_value
            if int(atis_value) < int(metar_value):
                field_sources["ceiling"] = "ATIS"
                return atis_value
            field_sources["ceiling"] = "METAR"
            return metar_value

        if atis_value is not None:
            field_sources["ceiling"] = "ATIS"
            return atis_value

        field_sources["ceiling"] = "METAR" if metar_value is not None else "NONE"
        return metar_value

    def choose_wind(atis_value, metar_value):
        if valid_wind(atis_value) and valid_wind(metar_value):
            atis_gust = atis_value.get("windGustKt") if atis_value.get("windGustKt") is not None else atis_value.get("windSpeedKt")
            metar_gust = metar_value.get("windGustKt") if metar_value.get("windGustKt") is not None else metar_value.get("windSpeedKt")
            atis_speed = atis_value.get("windSpeedKt")
            metar_speed = metar_value.get("windSpeedKt")

            if atis_gust is not None and metar_gust is not None and abs(float(atis_gust) - float(metar_gust)) > 5:
                if float(atis_gust) > float(metar_gust):
                    field_sources["wind"] = "ATIS"
                    return atis_value
                field_sources["wind"] = "METAR"
                return metar_value

            if atis_speed is not None and metar_speed is not None and abs(float(atis_speed) - float(metar_speed)) > 3:
                if float(atis_speed) > float(metar_speed):
                    field_sources["wind"] = "ATIS"
                    return atis_value
                field_sources["wind"] = "METAR"
                return metar_value

            field_sources["wind"] = "ATIS"
            return atis_value

        if valid_wind(atis_value):
            field_sources["wind"] = "ATIS"
            return atis_value

        if valid_wind(metar_value):
            field_sources["wind"] = "METAR"
            return metar_value

        field_sources["wind"] = "NONE"
        return metar_value or atis_value or {
            "windRaw": "--",
            "windDisplay": "--",
            "windDirDeg": None,
            "windSpeedKt": None,
            "windGustKt": None,
            "windArrow": "",
            "windArrowMeaning": "UNKNOWN"
        }

    wind_data = choose_wind(atis_wind, metar_wind)

    temp_source = "ATIS" if atis_temp_c is not None and atis_dewpoint_c is not None else "METAR"
    temp_c = atis_temp_c if temp_source == "ATIS" else metar_temp_c
    dewpoint_c = atis_dewpoint_c if temp_source == "ATIS" else metar_dewpoint_c
    field_sources["tempDp"] = temp_source if temp_c is not None and dewpoint_c is not None else "NONE"

    altimeter = choose_altimeter(atis_altimeter, metar_altimeter)
    visibility_sm = choose_visibility(atis_visibility_sm, metar_visibility_sm)
    ceiling_ft = choose_ceiling(atis_ceiling_ft, metar_ceiling_ft)

    visibility_source = field_sources.get("visibility")
    if visibility_source == "ATIS":
        visibility_display = atis_visibility_display or format_visibility(visibility_sm)
    elif visibility_source == "METAR":
        visibility_display = metar_visibility_display or format_visibility(visibility_sm)
    else:
        visibility_display = format_visibility(visibility_sm)

    observation_source = "ATIS" if any(source == "ATIS" for source in field_sources.values()) else "METAR"
    if "ATIS" in field_sources.values() and "METAR" in field_sources.values():
        observation_source = "MIXED"
    if all(source == "NONE" for source in field_sources.values()):
        observation_source = "NONE"

    return {
        "obsSource": observation_source,
        "obsFieldSources": field_sources,
        "altimeter": altimeter,
        "visibilitySm": visibility_sm,
        "visibilityDisplay": visibility_display,
        "ceilingFt": ceiling_ft,
        "windData": wind_data,
        "tempC": temp_c,
        "dewpointC": dewpoint_c,
        "metarAltimeter": metar_altimeter,
        "metarVisibilitySm": metar_visibility_sm,
        "metarVisibilityDisplay": metar_visibility_display,
        "metarCeilingFt": metar_ceiling_ft,
        "metarWindData": metar_wind,
        "metarTempC": metar_temp_c,
        "metarDewpointC": metar_dewpoint_c,
        "atisAltimeter": atis_altimeter,
        "atisVisibilitySm": atis_visibility_sm,
        "atisVisibilityDisplay": atis_visibility_display,
        "atisCeilingFt": atis_ceiling_ft,
        "atisWindData": atis_wind,
        "atisTempC": atis_temp_c,
        "atisDewpointC": atis_dewpoint_c
    }

def parse_ceiling_ft(metar):
    txt = metar or ""
    ceilings = []

    # Ceiling is the lowest BKN/OVC/VV layer. Convective suffixes such as
    # BKN075CB and BKN050TCU still count as ceiling layers.
    for layer_type, height in re.findall(r"\b(BKN|OVC|VV)(\d{3})(?:CB|TCU)?\b", txt):
        ceilings.append(int(height) * 100)

    if not ceilings:
        return None

    return min(ceilings)


def format_altimeter(value):
    if value is None:
        return "--"

    return f"{value:.2f}"


def format_visibility(value):
    if value is None:
        return "--"

    if value >= 10:
        return "10 SM"

    if float(value).is_integer():
        return f"{int(value)} SM"

    return f"{value:.1f} SM"


def format_ceiling(value):
    if value is None:
        return "UNL"

    return f"{value} FT"


def trend_symbol(current, previous):
    if current is None or previous is None:
        return "→"

    if current > previous:
        return "↑"

    if current < previous:
        return "↓"

    return "→"


def trend_text(symbol):
    if symbol == "↑":
        return "RISING"

    if symbol == "↓":
        return "FALLING"

    return "STEADY"


def parse_previous_numeric(previous_data, key, fallback_parser=None):
    if not previous_data:
        return None

    value = previous_data.get(key)

    if isinstance(value, (int, float)):
        return float(value)

    if isinstance(value, str):
        try:
            cleaned = value.replace("FT", "").replace("SM", "").strip()
            return float(cleaned)
        except Exception:
            pass

    if fallback_parser:
        try:
            return fallback_parser(previous_data.get("metar", ""))
        except Exception:
            return None

    return None


def normalize_weather_token(token):
    token = token.upper().strip()
    token = token.strip(".,;:()[]{}")
    token = token.replace("=", "")
    return token


def weather_code_present(source_text, code):
    text = (source_text or "").upper()
    tokens = [normalize_weather_token(token) for token in text.split()]

    for token in tokens:
        if not token:
            continue

        if code == "LLWS":
            if token == "LLWS":
                return True
            if re.match(r"^WS\d{3}/", token):
                return True

        if token == code:
            return True

    return False


VA_CODES = {"VA"}
CONVECTIVE_CODES = {"+TSRA", "TSRA", "-TSRA", "TS", "VCTS", "FC"}


def is_va_convective_pair(alert_a, alert_b):
    code_a = (alert_a.get("code") or "").upper()
    code_b = (alert_b.get("code") or "").upper()
    return (
        (code_a in VA_CODES and code_b in CONVECTIVE_CODES)
        or (code_b in VA_CODES and code_a in CONVECTIVE_CODES)
    )


def alert_code_component(alert):
    emoji = (alert.get("emoji") or "").strip()
    code = (alert.get("code") or "").strip()
    return f"{emoji} {code}".strip() if code else (alert.get("displayText") or "").strip()


def visible_alert_sources(sources):
    order = ["ATIS", "METAR", "TAF"]
    normalized = []

    for source in sources or []:
        label = str(source or "").upper().strip()
        if label == "SPECI":
            label = "METAR"
        if label and label not in normalized:
            normalized.append(label)

    normalized.sort(key=lambda item: order.index(item) if item in order else len(order))
    return normalized


def visible_alert_source_text(sources):
    labels = [label for label in visible_alert_sources(sources) if label in {"ATIS", "METAR"}]
    return "/".join(labels) if labels else "CURRENT"


def combine_simultaneous_alerts(alerts, window=None):
    if not alerts:
        return None

    alerts = sorted(alerts, key=lambda alert: (0 if (alert.get("code") or "").upper() in VA_CODES else 1, taf_hazard_rank(alert.get("code"))))
    first = dict(alerts[0])
    seen = set()
    codes = []
    components = []

    for alert in alerts:
        code = (alert.get("code") or "").upper()
        if code in seen:
            continue
        seen.add(code)
        codes.append(code)
        component = alert_code_component(alert)
        if component:
            components.append(component)

    display_base = " / ".join(components) if components else first.get("displayText", "")
    code_text = " / ".join(codes)
    if window:
        first["text"] = f"{code_text} PSBL {window}".strip()
        first["displayText"] = f"{display_base} PSBL {window}".strip()
        first["tafWindow"] = window
    else:
        sources = visible_alert_sources(src for alert in alerts for src in alert.get("sources", []))
        source_suffix = "ATIS" if "ATIS" in sources else "OBS"
        first["text"] = f"{code_text} {source_suffix}".strip()
        first["displayText"] = f"{display_base} {source_suffix}".strip()

    first["code"] = "/".join(codes)
    first["label"] = " / ".join(alert.get("label", "") for alert in alerts if alert.get("label"))
    first["sources"] = visible_alert_sources(src for alert in alerts for src in alert.get("sources", []))
    first["displayTone"] = "red" if any(alert.get("displayTone") == "red" for alert in alerts) else first.get("displayTone", "yellow")
    first["flash"] = any(bool(alert.get("flash")) for alert in alerts)
    first["pulse"] = any(bool(alert.get("pulse")) for alert in alerts)
    first["priority"] = min(alert.get("priority", 99) for alert in alerts)
    return first


def classify_alert(code, sources, category):
    source_set = set(sources)
    current_source = bool(source_set.intersection({"METAR", "ATIS"}))

    high_impact_categories = {
        "thunder",
        "freezing",
        "ice",
        "hail",
        "wind_shear",
        "tornado",
        "squall",
        "ash"
    }

    heavy_precip_codes = {
        "+RA",
        "+SHRA",
        "+DZ",
        "+SN"
    }

    info_categories = {
        "rain",
        "drizzle",
        "shower",
        "mist",
        "haze"
    }

    if category in high_impact_categories:
        if current_source:
            return "active", "red", True, False, 10
        return "forecast", "yellow", False, True, 30

    if code in heavy_precip_codes:
        if current_source:
            return "active", "yellow", False, True, 35
        return "forecast", "yellow", False, True, 40

    if category == "snow":
        if current_source:
            return "active", "yellow", False, True, 35
        return "forecast", "yellow", False, True, 45

    if category == "fog":
        if code == "FZFG":
            if current_source:
                return "active", "red", True, False, 15
            return "forecast", "yellow", False, True, 30

        if current_source:
            return "active", "yellow", False, True, 40
        return "forecast", "yellow", False, True, 50

    if category in info_categories:
        if current_source:
            return "info", "blue", False, False, 60
        return "forecast_info", "blue", False, False, 70

    if current_source:
        return "active", "yellow", False, True, 50

    return "forecast", "yellow", False, True, 60

def alert_text_for(label, sources):
    source_set = set(sources)

    if "METAR" in source_set and "TAF" in source_set:
        return f"{label} IN METAR / TAF"

    if "METAR" in source_set:
        return f"{label} IN METAR"

    if "TAF" in source_set:
        return f"{label} POSSIBLE IN TAF"

    return label


TAF_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def parse_taf_issue_datetime_utc(taf_text, now_z=None):
    """Parse TAF issue time from DDHHMMZ and infer month/year from current UTC."""
    now_z = now_z or datetime.now(timezone.utc)
    text = str(taf_text or "").upper()
    match = re.search(r"\bTAF(?:\s+AMD|\s+COR)?\s+[A-Z]{4}\s+(\d{2})(\d{2})(\d{2})Z\b", text)
    if not match:
        match = re.search(r"\b[A-Z]{4}\s+(\d{2})(\d{2})(\d{2})Z\s+\d{4}/\d{4}\b", text)
    if not match:
        return now_z

    day = int(match.group(1))
    hour = int(match.group(2))
    minute = int(match.group(3))

    candidates = []
    for month_offset in (0, -1, 1):
        year = now_z.year
        month = now_z.month + month_offset
        if month < 1:
            month = 12
            year -= 1
        elif month > 12:
            month = 1
            year += 1
        try:
            candidates.append(datetime(year, month, day, hour, minute, tzinfo=timezone.utc))
        except ValueError:
            pass

    plausible = [c for c in candidates if c <= now_z + timedelta(hours=36)]
    if plausible:
        return min(plausible, key=lambda c: abs((c - now_z).total_seconds()))
    return now_z


def taf_token_start_datetime(window_token, taf_issue_dt=None):
    """Return the start datetime for a TAF window token such as 1208/1213 or FM120800."""
    token = (window_token or "").upper().strip()
    taf_issue_dt = taf_issue_dt or datetime.now(timezone.utc)

    if re.match(r"^\d{4}/\d{4}$", token):
        day = int(token[0:2])
        hour = int(token[2:4])
    elif re.match(r"^FM\d{6}$", token):
        day = int(token[2:4])
        hour = int(token[4:6])
    else:
        return None

    candidates = []
    for month_offset in (0, -1, 1):
        year = taf_issue_dt.year
        month = taf_issue_dt.month + month_offset
        if month < 1:
            month = 12
            year -= 1
        elif month > 12:
            month = 1
            year += 1
        try:
            candidates.append(datetime(year, month, day, hour, tzinfo=timezone.utc))
        except ValueError:
            pass

    if not candidates:
        return None

    # TAF windows are DDHH-based.  Around the issue time the valid-period start can
    # be a little before the issue timestamp, so choose the nearest same/nearby
    # calendar candidate instead of forcing it after issue time.
    return min(candidates, key=lambda c: abs((c - taf_issue_dt).total_seconds()))


def taf_token_end_datetime(window_token, taf_issue_dt=None):
    """Return the end datetime for a TAF DDHH/DDHH valid window token."""
    token = (window_token or "").upper().strip()
    taf_issue_dt = taf_issue_dt or datetime.now(timezone.utc)
    if not re.match(r"^\d{4}/\d{4}$", token):
        return None

    start_dt = taf_token_start_datetime(token, taf_issue_dt)
    if not start_dt:
        return None

    end_day = int(token[5:7])
    end_hour = int(token[7:9])

    candidates = []
    for month_offset in (0, -1, 1):
        year = taf_issue_dt.year
        month = taf_issue_dt.month + month_offset
        if month < 1:
            month = 12
            year -= 1
        elif month > 12:
            month = 1
            year += 1
        try:
            if end_hour == 24:
                candidates.append(datetime(year, month, end_day, 0, tzinfo=timezone.utc) + timedelta(days=1))
            else:
                candidates.append(datetime(year, month, end_day, end_hour, tzinfo=timezone.utc))
        except ValueError:
            pass

    if not candidates:
        return None

    # Pick the first end candidate after the start. This handles month rollovers.
    after_start = [c for c in candidates if c > start_dt]
    if after_start:
        return min(after_start, key=lambda c: (c - start_dt).total_seconds())

    # Fallback for malformed edge cases.
    return min(candidates, key=lambda c: abs((c - start_dt).total_seconds()))


def taf_alert_window_time_text(window_token):
    token = (window_token or "").upper().strip()
    if re.match(r"^\d{4}/\d{4}$", token):
        return f"{token[2:4]}-{token[7:9]}Z"
    if re.match(r"^FM\d{6}$", token):
        return f"{token[4:6]}Z"
    return ""


def taf_window_display_from_datetimes(start_dt, end_dt=None, current_utc_dt=None):
    """
    Format TAF alert windows from real UTC datetimes.

    Active (start passed, not yet ended): NOW-10Z / NOW-15 JUN 03Z
    Same current UTC date: 09-18Z
    Different UTC date: 12 JUN 09-18Z
    Cross-midnight: 14 JUN 22Z-15 JUN 03Z

    If no end is known, use 09Z rather than FM 09Z.
    """
    if not start_dt:
        return ""

    current_utc_dt = current_utc_dt or datetime.now(timezone.utc)
    is_active = start_dt <= current_utc_dt and (end_dt is None or end_dt > current_utc_dt)
    start_hh = f"{start_dt.hour:02d}"

    if end_dt and end_dt > start_dt:
        is_midnight_rollover = (
            end_dt.hour == 0 and end_dt.minute == 0 and end_dt.second == 0
            and end_dt.date() == (start_dt + timedelta(days=1)).date()
        )
        if is_midnight_rollover:
            if is_active:
                return "NOW-24Z"
            base = f"{start_hh}-24Z"
            if start_dt.date() != current_utc_dt.date():
                return f"{start_dt.day:02d} {TAF_MONTHS[start_dt.month - 1]} {base}"
            return base
        if end_dt.date() != start_dt.date():
            end_str = f"{end_dt.day:02d} {TAF_MONTHS[end_dt.month - 1]} {end_dt.hour:02d}Z"
            if is_active:
                return f"NOW-{end_str}"
            return (
                f"{start_dt.day:02d} {TAF_MONTHS[start_dt.month - 1]} {start_hh}Z-{end_str}"
            )
        if is_active:
            return f"NOW-{end_dt.hour:02d}Z"
        base = f"{start_hh}-{end_dt.hour:02d}Z"
    else:
        if is_active:
            return "NOW"
        base = f"{start_hh}Z"

    if start_dt.date() != current_utc_dt.date():
        return f"{start_dt.day:02d} {TAF_MONTHS[start_dt.month - 1]} {base}"

    return base


def taf_window_display_from_token(window_token, taf_issue_dt=None, current_utc_dt=None, end_dt=None):
    """
    Format TAF-derived WX alert windows.

    Same current UTC date: 08-13Z
    Different UTC date: 12 JUN 08-13Z
    """
    token = (window_token or "").upper().strip()
    taf_issue_dt = taf_issue_dt or datetime.now(timezone.utc)
    current_utc_dt = current_utc_dt or datetime.now(timezone.utc)

    start_dt = taf_token_start_datetime(token, taf_issue_dt)
    if not start_dt:
        return ""

    if end_dt is None and re.match(r"^\d{4}/\d{4}$", token):
        end_dt = taf_token_end_datetime(token, taf_issue_dt)

    return taf_window_display_from_datetimes(start_dt, end_dt, current_utc_dt)


def taf_window_sort_key(window_token, fallback_order=999):
    token = (window_token or "").upper().strip()

    if re.match(r"^\d{4}/\d{4}$", token):
        return int(token[0:2]) * 24 + int(token[2:4])

    if re.match(r"^FM\d{6}$", token):
        return int(token[2:4]) * 24 + int(token[4:6])

    return 100000 + fallback_order


def iso_z(dt):
    if not dt:
        return ""
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso_z(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def split_taf_groups_for_windows(taf):
    current_utc_dt = datetime.now(timezone.utc)
    taf_issue_dt = parse_taf_issue_datetime_utc(taf, current_utc_dt)
    text = re.sub(r"\s+", " ", (taf or "").upper()).strip()

    if not text or "UNAVAILABLE" in text or "ERROR" in text or "FAILED" in text:
        return []

    groups = []
    main_valid_match = re.search(r"\b(\d{4}/\d{4})\b", text)
    main_valid = main_valid_match.group(1) if main_valid_match else ""
    main_start_dt = taf_token_start_datetime(main_valid, taf_issue_dt) if main_valid else None
    main_end_dt = taf_token_end_datetime(main_valid, taf_issue_dt) if main_valid else None

    markers = list(re.finditer(r"\b(FM\d{6}|TEMPO|BECMG|PROB30|PROB40)\b", text))

    def next_fm_start_datetime(after_idx):
        for later in markers[after_idx + 1:]:
            token = later.group(1)
            if token.startswith("FM"):
                return taf_token_start_datetime(token, taf_issue_dt)
        return None

    if main_valid_match:
        base_start = main_valid_match.end()
        base_end = markers[0].start() if markers else len(text)
        base_text = text[base_start:base_end]
        # PREVAILING conditions last until the first FM group takes over, not the full TAF end.
        first_fm_dt = next((
            taf_token_start_datetime(m.group(1), taf_issue_dt)
            for m in markers if m.group(1).startswith("FM")
        ), None)
        prevailing_end_dt = first_fm_dt or main_end_dt
        groups.append({
            "tafGroupType": "PREVAILING",
            "tafWindowToken": main_valid,
            "tafWindow": taf_window_display_from_datetimes(main_start_dt, prevailing_end_dt, current_utc_dt),
            "tafStartKey": taf_window_sort_key(main_valid, 0),
            "tafStartIso": iso_z(main_start_dt),
            "tafEndIso": iso_z(prevailing_end_dt),
            "tafGroupText": base_text.strip()
        })

    for idx, marker in enumerate(markers):
        marker_text = marker.group(1)
        next_start = markers[idx + 1].start() if idx + 1 < len(markers) else len(text)
        group_text = text[marker.start():next_start].strip()
        window_token = ""
        start_dt = None
        end_dt = None

        if marker_text.startswith("FM"):
            window_token = marker_text
            start_dt = taf_token_start_datetime(marker_text, taf_issue_dt)
            # FM prevailing groups last until the next FM group or the TAF valid end.
            # TEMPO/PROB groups inside that period do not terminate the prevailing FM condition.
            next_fm_dt = next_fm_start_datetime(idx)
            end_dt = next_fm_dt or main_end_dt
            display_end_dt = next_fm_dt
        else:
            window_match = re.search(r"\b(\d{4}/\d{4})\b", group_text)
            if window_match:
                window_token = window_match.group(1)
            else:
                window_token = main_valid
            start_dt = taf_token_start_datetime(window_token, taf_issue_dt)
            end_dt = taf_token_end_datetime(window_token, taf_issue_dt)
            display_end_dt = end_dt

        groups.append({
            "tafGroupType": marker_text if not marker_text.startswith("FM") else "FM",
            "tafWindowToken": window_token,
            "tafWindow": taf_window_display_from_datetimes(start_dt, display_end_dt, current_utc_dt),
            "tafStartKey": taf_window_sort_key(window_token, idx + 1),
            "tafStartIso": iso_z(start_dt),
            "tafEndIso": iso_z(end_dt),
            "tafGroupText": group_text
        })

    return groups


def merge_adjacent_taf_fm_alerts(taf_alerts, current_utc_dt=None):
    """Merge adjacent FM groups with the same TAF weather code so display is not just '09Z'."""
    current_utc_dt = current_utc_dt or datetime.now(timezone.utc)
    fm_alerts = []
    other_alerts = []

    for alert in taf_alerts:
        if alert.get("tafGroupType") == "FM" and alert.get("tafStartIso") and alert.get("tafEndIso"):
            fm_alerts.append(dict(alert))
        else:
            other_alerts.append(alert)

    grouped = {}
    for alert in fm_alerts:
        key = (alert.get("code"), alert.get("category"), alert.get("displayTone"))
        grouped.setdefault(key, []).append(alert)

    merged = []
    for key, items in grouped.items():
        items.sort(key=lambda a: parse_iso_z(a.get("tafStartIso")) or datetime.max.replace(tzinfo=timezone.utc))
        current = None
        current_start = None
        current_end = None

        for item in items:
            start = parse_iso_z(item.get("tafStartIso"))
            end = parse_iso_z(item.get("tafEndIso"))
            if not start or not end:
                merged.append(item)
                continue

            if current is None:
                current = dict(item)
                current_start = start
                current_end = end
                continue

            # Merge contiguous or overlapping FM periods of the same code.
            if start <= current_end + timedelta(minutes=1):
                if end > current_end:
                    current_end = end
            else:
                current["tafStartIso"] = iso_z(current_start)
                current["tafEndIso"] = iso_z(current_end)
                current["tafWindow"] = taf_window_display_from_datetimes(current_start, current_end, current_utc_dt)
                current["text"] = f"{current['code']} PSBL {current['tafWindow']}".strip()
                current["displayText"] = f"{current.get('emoji','')} {current['text']}".strip()
                merged.append(current)
                current = dict(item)
                current_start = start
                current_end = end

        if current is not None:
            current["tafStartIso"] = iso_z(current_start)
            current["tafEndIso"] = iso_z(current_end)
            current["tafWindow"] = taf_window_display_from_datetimes(current_start, current_end, current_utc_dt)
            current["text"] = f"{current['code']} PSBL {current['tafWindow']}".strip()
            current["displayText"] = f"{current.get('emoji','')} {current['text']}".strip()
            merged.append(current)

    return other_alerts + merged


def taf_hazard_rank(code):
    code = (code or "").upper()
    ranks = {
        "VA": 1,
        "+FZRA": 1,
        "FZRA": 1,
        "-FZRA": 1,
        "+FZDZ": 1,
        "FZDZ": 1,
        "-FZDZ": 1,
        "PL": 1,
        "+TSRA": 2,
        "TSRA": 3,
        "-TSRA": 4,
        "VCTS": 5,
        "TS": 5,
        "FC": 1,
        "FU": 6,
        "+RA": 7,
        "+SHRA": 7,
        "RA": 8,
        "SHRA": 8,
        "-RA": 9,
        "-SHRA": 9,
        "FG": 10,
        "BR": 10,
    }
    return ranks.get(code, 20)


def taf_timing_bucket(alert, now_z):
    start = parse_iso_z(alert.get("tafStartIso"))
    end = parse_iso_z(alert.get("tafEndIso"))

    if end and end <= now_z:
        return None

    if start and end and start <= now_z < end:
        return 0

    if not start:
        return 5

    hours_until = (start - now_z).total_seconds() / 3600.0
    if hours_until <= 0:
        return 0
    if hours_until <= 3:
        return 1
    if hours_until <= 6:
        return 2
    if hours_until <= 12:
        return 3
    return 4


def taf_alerts_overlap_or_close(a, b, close_hours=2.0):
    a_start = parse_iso_z(a.get("tafStartIso"))
    a_end = parse_iso_z(a.get("tafEndIso")) or a_start
    b_start = parse_iso_z(b.get("tafStartIso"))
    b_end = parse_iso_z(b.get("tafEndIso")) or b_start

    if not a_start or not b_start:
        return False

    if a_end and b_end and a_start < b_end and b_start < a_end:
        return True

    return abs((a_start - b_start).total_seconds()) <= close_hours * 3600.0


def taf_alerts_overlap(a, b):
    a_start = parse_iso_z(a.get("tafStartIso"))
    a_end = parse_iso_z(a.get("tafEndIso")) or a_start
    b_start = parse_iso_z(b.get("tafStartIso"))
    b_end = parse_iso_z(b.get("tafEndIso")) or b_start

    if not a_start or not b_start or not a_end or not b_end:
        return False

    return a_start < b_end and b_start < a_end


def overlapping_taf_window(alerts, now_z):
    starts = [parse_iso_z(alert.get("tafStartIso")) for alert in alerts]
    ends = [parse_iso_z(alert.get("tafEndIso")) for alert in alerts]
    starts = [dt for dt in starts if dt]
    ends = [dt for dt in ends if dt]

    if not starts or not ends:
        return alerts[0].get("tafWindow", "") if alerts else ""

    start = max(starts)
    end = min(ends)
    if end <= start:
        return alerts[0].get("tafWindow", "") if alerts else ""

    return taf_window_display_from_datetimes(start, end, now_z)


def select_taf_alert(taf_alerts, now_z=None):
    now_z = now_z or datetime.now(timezone.utc)
    candidates = []

    for alert in taf_alerts:
        bucket = taf_timing_bucket(alert, now_z)
        if bucket is None:
            continue
        item = dict(alert)
        item["_tafBucket"] = bucket
        item["_tafStartDt"] = parse_iso_z(item.get("tafStartIso")) or datetime.max.replace(tzinfo=timezone.utc)
        item["_tafHazardRank"] = taf_hazard_rank(item.get("code"))
        candidates.append(item)

    if not candidates:
        return None

    bucket = min(item["_tafBucket"] for item in candidates)
    bucket_items = [item for item in candidates if item["_tafBucket"] == bucket]

    # If the current best active (bucket-0) alerts are lower-severity than a
    # near-term candidate starting within 3 hours (bucket 1), promote that
    # candidate into the pool. This prevents active VCTS from hiding an imminent
    # -TSRA that starts in under 3 hours.
    if bucket == 0:
        best_rank_in_bucket0 = min(item["_tafHazardRank"] for item in bucket_items)
        near_term_upgrades = [
            item for item in candidates
            if item["_tafBucket"] == 1 and item["_tafHazardRank"] < best_rank_in_bucket0
        ]
        if near_term_upgrades:
            bucket_items = bucket_items + near_term_upgrades

    earliest = min(bucket_items, key=lambda item: item["_tafStartDt"])

    if bucket >= 4:
        # Beyond 12 hours: earliest start wins regardless of hazard level.
        # A PROB30 thunderstorm at hour 18 should not override shower activity at hour 12
        # just because it's more severe — show what comes first operationally.
        selected = earliest
    else:
        close_items = [
            item for item in bucket_items
            if item is earliest or taf_alerts_overlap_or_close(item, earliest)
        ]
        if close_items:
            selected = min(close_items, key=lambda item: (item["_tafHazardRank"], item["_tafStartDt"]))
        else:
            selected = earliest

    simultaneous = [selected]
    for item in bucket_items:
        if item is selected:
            continue
        if is_va_convective_pair(selected, item) and taf_alerts_overlap(selected, item):
            simultaneous.append(item)

    for key in ["_tafBucket", "_tafStartDt", "_tafHazardRank"]:
        for item in simultaneous:
            item.pop(key, None)

    if len(simultaneous) > 1:
        window = overlapping_taf_window(simultaneous, now_z)
        return combine_simultaneous_alerts(simultaneous, window)

    return selected


def select_current_alert(current_alerts):
    if not current_alerts:
        return None

    va_convective = [
        alert for alert in current_alerts
        if (alert.get("code") or "").upper() in VA_CODES.union(CONVECTIVE_CODES)
    ]

    has_va = any((alert.get("code") or "").upper() in VA_CODES for alert in va_convective)
    has_convective = any((alert.get("code") or "").upper() in CONVECTIVE_CODES for alert in va_convective)

    if has_va and has_convective:
        return combine_simultaneous_alerts(va_convective)

    selected = current_alerts[0]
    selected_code = (selected.get("code") or "").upper()
    same_code = [
        alert for alert in current_alerts
        if (alert.get("code") or "").upper() == selected_code
        and set(alert.get("sources", [])).intersection({"ATIS", "METAR", "SPECI"})
    ]

    if len(same_code) > 1:
        return combine_simultaneous_alerts(same_code)

    return selected


def atis_weather_alert_scan_text(atis_text):
    """Return the operational ATIS portion for current hazard scanning."""
    return atis_observation_scan_text(atis_text)

def atis_plain_weather_present(source_text, code):
    """Recognize common spoken/plain-English ATIS hazard phrases in addition to METAR codes."""
    text = re.sub(r"\s+", " ", (source_text or "").upper()).strip()

    phrase_map = {
        "+TSRA": ["HEAVY THUNDERSTORM RAIN"],
        "TSRA": ["THUNDERSTORM RAIN", "THUNDERSTORMS WITH RAIN"],
        "-TSRA": ["LIGHT THUNDERSTORM RAIN"],
        "TS": ["THUNDERSTORM"],
        "VCTS": ["THUNDERSTORM VICINITY", "THUNDERSTORM IN THE VICINITY", "THUNDERSTORMS IN THE VICINITY", "TS IN THE VICINITY"],
        "+FZRA": ["HEAVY FREEZING RAIN"],
        "FZRA": ["FREEZING RAIN"],
        "-FZRA": ["LIGHT FREEZING RAIN"],
        "+FZDZ": ["HEAVY FREEZING DRIZZLE"],
        "FZDZ": ["FREEZING DRIZZLE"],
        "-FZDZ": ["LIGHT FREEZING DRIZZLE"],
        "FZFG": ["FREEZING FOG"],
        "PL": ["ICE PELLETS"],
        "GR": ["HAIL"],
        "GS": ["SMALL HAIL", "SNOW PELLETS"],
        "+SN": ["HEAVY SNOW"],
        "SN": ["SNOW"],
        "-SN": ["LIGHT SNOW"],
        "SG": ["SNOW GRAINS"],
        "+RA": ["HEAVY RAIN"],
        "RA": [" RAIN"],
        "-RA": ["LIGHT RAIN"],
        "+SHRA": ["HEAVY RAIN SHOWERS"],
        "-SHRA": ["LIGHT RAIN SHOWERS"],
        "SHRA": ["RAIN SHOWERS", "SHOWERS"],
        "VCSH": ["SHOWERS VICINITY", "SHOWERS IN THE VICINITY"],
        "+DZ": ["HEAVY DRIZZLE"],
        "DZ": ["DRIZZLE"],
        "-DZ": ["LIGHT DRIZZLE"],
        "VA": ["VOLCANIC ASH"],
        "HZ": ["HAZE"],
        "FG": ["FOG"],
        "BR": ["MIST"],
        "SQ": ["SQUALL"],
        "FC": ["FUNNEL", "TORNADO", "WATERSPOUT"],
        "LLWS": ["LOW LEVEL WIND SHEAR", "LOW-LEVEL WIND SHEAR", "LLWS"]
    }

    for phrase in phrase_map.get(code, []):
        if phrase.startswith(" "):
            if phrase in f" {text}":
                return True
        elif phrase in text:
            return True

    return False

def detect_weather_alerts(metar, taf, atis_text=""):
    checks = [
        {"code": "+TSRA", "label": "HEAVY THUNDERSTORM RAIN", "emoji": "⛈️", "category": "thunder"},
        {"code": "TSRA", "label": "THUNDERSTORM RAIN", "emoji": "⛈️", "category": "thunder"},
        {"code": "-TSRA", "label": "LIGHT THUNDERSTORM RAIN", "emoji": "⛈️", "category": "thunder"},
        {"code": "TS", "label": "THUNDERSTORM", "emoji": "⛈️", "category": "thunder"},
        {"code": "VCTS", "label": "THUNDERSTORM VICINITY", "emoji": "⛈️", "category": "thunder"},

        {"code": "+FZRA", "label": "HEAVY FREEZING RAIN", "emoji": "🧊", "category": "freezing"},
        {"code": "FZRA", "label": "FREEZING RAIN", "emoji": "🧊", "category": "freezing"},
        {"code": "-FZRA", "label": "LIGHT FREEZING RAIN", "emoji": "🧊", "category": "freezing"},
        {"code": "+FZDZ", "label": "HEAVY FREEZING DRIZZLE", "emoji": "🧊", "category": "freezing"},
        {"code": "FZDZ", "label": "FREEZING DRIZZLE", "emoji": "🧊", "category": "freezing"},
        {"code": "-FZDZ", "label": "LIGHT FREEZING DRIZZLE", "emoji": "🧊", "category": "freezing"},
        {"code": "FZFG", "label": "FREEZING FOG", "emoji": "🌫️", "category": "fog"},

        {"code": "PL", "label": "ICE PELLETS", "emoji": "🧊", "category": "ice"},
        {"code": "GR", "label": "HAIL", "emoji": "🧊", "category": "hail"},
        {"code": "GS", "label": "SMALL HAIL / SNOW PELLETS", "emoji": "🧊", "category": "hail"},

        {"code": "+SN", "label": "HEAVY SNOW", "emoji": "❄️", "category": "snow"},
        {"code": "SN", "label": "SNOW", "emoji": "❄️", "category": "snow"},
        {"code": "-SN", "label": "LIGHT SNOW", "emoji": "❄️", "category": "snow"},
        {"code": "SG", "label": "SNOW GRAINS", "emoji": "❄️", "category": "snow"},

        {"code": "+RA", "label": "HEAVY RAIN", "emoji": "🌧️", "category": "rain"},
        {"code": "RA", "label": "RAIN", "emoji": "🌧️", "category": "rain"},
        {"code": "-RA", "label": "LIGHT RAIN", "emoji": "🌧️", "category": "rain"},
        {"code": "+SHRA", "label": "HEAVY RAIN SHOWERS", "emoji": "🌧️", "category": "shower"},
        {"code": "-SHRA", "label": "LIGHT RAIN SHOWERS", "emoji": "🌧️", "category": "shower"},
        {"code": "SHRA", "label": "RAIN SHOWERS", "emoji": "🌧️", "category": "shower"},
        {"code": "VCSH", "label": "SHOWERS VICINITY", "emoji": "🌧️", "category": "shower"},
        {"code": "+DZ", "label": "HEAVY DRIZZLE", "emoji": "🌧️", "category": "drizzle"},
        {"code": "DZ", "label": "DRIZZLE", "emoji": "🌧️", "category": "drizzle"},
        {"code": "-DZ", "label": "LIGHT DRIZZLE", "emoji": "🌧️", "category": "drizzle"},

        {"code": "FU", "label": "SMOKE", "emoji": "\U0001F4A8", "category": "smoke"},
        {"code": "VA", "label": "VOLCANIC ASH", "emoji": "🌋", "category": "ash"},
        {"code": "HZ", "label": "HAZE", "emoji": "🌫️", "category": "haze"},
        {"code": "FG", "label": "FOG", "emoji": "🌫️", "category": "fog"},
        {"code": "BR", "label": "MIST", "emoji": "🌫️", "category": "mist"},

        {"code": "SQ", "label": "SQUALL", "emoji": "💨", "category": "squall"},
        {"code": "FC", "label": "FUNNEL/TORNADO/WATERSPOUT", "emoji": "🌪️", "category": "tornado"},
        {"code": "LLWS", "label": "LOW LEVEL WIND SHEAR", "emoji": "💨", "category": "wind_shear"}
    ]

    alerts = []
    current_seen = set()
    taf_seen_by_group = set()
    atis_scan_text = atis_weather_alert_scan_text(atis_text)

    def add_current_alert(check, source):
        code = check["code"]
        source_label = visible_alert_source_text([source])
        severity, display_tone, flash, pulse, priority = classify_alert(
            code,
            [source],
            check["category"]
        )
        raw_display_codes = {
            "+TSRA", "TSRA", "-TSRA", "TS", "VCTS", "FC",
            "+FZRA", "FZRA", "-FZRA", "+FZDZ", "FZDZ", "-FZDZ",
            "PL", "GR", "GS", "+RA", "RA", "-RA", "+SHRA", "SHRA", "-SHRA",
            "FU", "VA"
        }
        base_text = code if code in raw_display_codes else check["label"]
        source_suffix = "ATIS" if source == "ATIS" else "OBS"
        text = f"{base_text} {source_suffix}"
        display_text = f"{check['emoji']} {text}".strip()
        alerts.append({
            "code": code,
            "label": check["label"],
            "emoji": check["emoji"],
            "category": check["category"],
            "sources": [source],
            "severity": severity,
            "displayTone": display_tone,
            "flash": flash,
            "pulse": pulse,
            "priority": priority,
            "text": text,
            "displayText": display_text,
            "tafWindow": "",
            "tafStartKey": -1,
            "tafGroupType": ""
        })

    # ATIS and METAR are both current-condition sources. If the same hazard appears
    # in both, keep both candidates and let tie-breaking favor ATIS.
    for source, source_text in [("ATIS", atis_scan_text), ("METAR", metar or "")]:
        for check in checks:
            code = check["code"]
            key = (source, code)
            if key in current_seen:
                continue
            present = weather_code_present(source_text, code)
            if source == "ATIS":
                present = present or atis_plain_weather_present(source_text, code)

            if present:
                current_seen.add(key)
                add_current_alert(check, source)

    taf_groups = split_taf_groups_for_windows(taf)

    for group_idx, group in enumerate(taf_groups):
        group_text = group.get("tafGroupText", "")
        if not group_text:
            continue

        for check in checks:
            code = check["code"]
            key = (group_idx, code)
            if key in taf_seen_by_group:
                continue

            if not weather_code_present(group_text, code):
                continue

            taf_seen_by_group.add(key)
            severity, display_tone, flash, pulse, priority = classify_alert(
                code,
                ["TAF"],
                check["category"]
            )
            window = group.get("tafWindow", "")
            # TAF-derived WX ALERT text should use the raw aviation weather code,
            # not a long plain-English label. Examples:
            #   🌧️ -SHRA PSBL 08-13Z
            #   🌧️ -SHRA PSBL 12 JUN 08-13Z
            # Current METAR/ATIS alerts still use the longer label/source wording.
            text = f"{code} PSBL {window}".strip()
            alerts.append({
                "code": code,
                "label": check["label"],
                "emoji": check["emoji"],
                "category": check["category"],
                "sources": ["TAF"],
                "severity": severity,
                "displayTone": display_tone,
                "flash": flash,
                "pulse": pulse,
                "priority": priority,
                "text": text,
                "displayText": f"{check['emoji']} {text}".strip(),
                "tafWindow": window,
                "tafStartKey": group.get("tafStartKey", 999999),
                "tafGroupType": group.get("tafGroupType", ""),
                "tafStartIso": group.get("tafStartIso", ""),
                "tafEndIso": group.get("tafEndIso", "")
            })

    current_alerts = [
        alert for alert in alerts
        if set(alert.get("sources", [])).intersection({"ATIS", "METAR"})
    ]
    taf_alerts = [alert for alert in alerts if "TAF" in alert.get("sources", [])]
    now_z = datetime.now(timezone.utc)
    taf_alerts = merge_adjacent_taf_fm_alerts(taf_alerts, now_z)

    def current_sort_key(alert):
        sources = set(alert.get("sources", []))
        source_tie = 0 if "ATIS" in sources else 1
        return (alert.get("priority", 99), taf_hazard_rank(alert.get("code")), source_tie)

    current_alerts.sort(key=current_sort_key)
    selected_current_alert = select_current_alert(current_alerts)
    selected_taf_alert = select_taf_alert(taf_alerts, now_z)

    if not selected_current_alert and not selected_taf_alert:
        return []
    if not selected_current_alert:
        return [selected_taf_alert]
    if not selected_taf_alert:
        return [selected_current_alert]

    # Both exist — most restrictive wins across all sources.
    # Active TAF (bucket 0) competes at natural priority; future TAF gets a
    # timing penalty so current observations beat near-future forecasts.
    # ATIS > METAR > TAF as a tiebreaker when scores are equal.
    def _alert_score(alert, is_taf):
        sources = set(alert.get("sources", []))
        if is_taf:
            bucket = taf_timing_bucket(alert, now_z) or 0
            timing_penalty = bucket * 5
            source_tie = 2
        else:
            timing_penalty = 0
            source_tie = 0 if "ATIS" in sources else 1
        return (
            alert.get("priority", 99) + timing_penalty,
            taf_hazard_rank(alert.get("code")),
            source_tie
        )

    c_score = _alert_score(selected_current_alert, False)
    t_score = _alert_score(selected_taf_alert, True)
    return [selected_current_alert if c_score <= t_score else selected_taf_alert]

def summarize_weather_alerts(alerts):
    if not alerts:
        return {
            "wxAlertText": "NONE",
            "wxAlertLogText": "NONE",
            "wxAlertVisible": False,
            "wxPrimaryAlert": None,
            "wxSecondaryAlert": None,
            "wxAlertTone": "none",
            "wxAlertFlash": False,
            "wxAlertPulse": False,
            "tafTrend": "VFR NEXT 24 HRS"
        }

    primary = alerts[0]
    wx_alert_text = primary["displayText"]
    wx_alert_log_text = primary["text"]

    return {
        "wxAlertText": wx_alert_text,
        "wxAlertLogText": wx_alert_log_text,
        "wxAlertVisible": True,
        "wxPrimaryAlert": primary,
        "wxSecondaryAlert": None,
        "wxAlertTone": primary.get("displayTone", "yellow"),
        "wxAlertFlash": bool(primary.get("flash", False)),
        "wxAlertPulse": bool(primary.get("pulse", False)),
        "tafTrend": f"WX ALERT | {wx_alert_text}"
    }


LIGHTNING_DIRECTIONS = {
    "N", "NE", "E", "SE", "S", "SW", "W", "NW",
    "ALQDS", "ALL", "QUADS", "ALLQUADS"
}


def normalize_lightning_direction(direction):
    """
    Normalize lightning direction text from METAR/ATIS.

    Supports normal quadrants plus ATIS/METAR hyphenated ranges:
      NE-SW, SW-W, NE-SW, N-E, etc.
    """
    text = (direction or "").upper().strip()
    text = text.replace("ALL QUADRANTS", "ALQDS")
    text = text.replace("ALL QUADS", "ALQDS")
    text = text.replace("ALLQDS", "ALQDS")
    text = text.replace("ALLQUADS", "ALQDS")
    text = text.replace(" QUADRANTS", " QUADS")
    text = re.sub(r"\bAND\b", " ", text)
    text = re.sub(r"[,;]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    if not text:
        return ""

    if "ALQDS" in text or (re.search(r"\bALL\b", text) and re.search(r"\b(QUADS|QUADRANTS)\b", text)):
        return "ALL QUADS"

    valid = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"}

    # Preserve hyphenated direction ranges as displayed by ATIS/METAR.
    # Examples: NE-SW, SW-W, N-E.
    ranges = []
    for match in re.finditer(r"\b(N|NE|E|SE|S|SW|W|NW)\s*-\s*(N|NE|E|SE|S|SW|W|NW)\b", text):
        item = f"{match.group(1)}-{match.group(2)}"
        if item not in ranges:
            ranges.append(item)

    if ranges:
        return "/".join(ranges)

    # Treat slashes as separators only after preserving hyphenated ranges.
    text = re.sub(r"[/]+", " ", text)

    parts = []
    for token in text.split():
        token = token.strip(".,;:()[]{}")
        if token in {"ALL", "QUADS", "QUADRANTS", "ALLQUADS"}:
            return "ALL QUADS"
        if token in valid and token not in parts:
            parts.append(token)

    if not parts:
        return ""

    return "/".join(parts)

def extract_metar_ltg_dsnt_direction(metar):
    text = (metar or "").upper()

    # Direct regex catches METAR remarks like:
    #   LTGIC DSNT NE-SW
    #   LTG DSNT SW-W
    #   LTGCG DSNT N
    match = re.search(
        r"\bLTG[A-Z]*\s+DSNT\s+((?:N|NE|E|SE|S|SW|W|NW)(?:\s*-\s*(?:N|NE|E|SE|S|SW|W|NW))?(?:\s+(?:AND\s+)?(?:N|NE|E|SE|S|SW|W|NW)(?:\s*-\s*(?:N|NE|E|SE|S|SW|W|NW))?)*)\b",
        text
    )

    if match:
        direction = normalize_lightning_direction(match.group(1))
        if direction:
            return direction

    tokens = [token.strip(".,;:()[]{}=") for token in text.split()]

    for idx, token in enumerate(tokens):
        # METAR remarks commonly use LTG, LTGIC, LTGCG, LTGCC, etc.
        # Treat any LTG* token followed by DSNT as distant lightning.
        if token.startswith("LTG") and idx + 1 < len(tokens) and tokens[idx + 1] == "DSNT":
            collected = []

            for follow in tokens[idx + 2:idx + 8]:
                clean = follow.strip(".,;:()[]{}=")

                if re.match(r"^(N|NE|E|SE|S|SW|W|NW)-(N|NE|E|SE|S|SW|W|NW)$", clean):
                    collected.append(clean)
                    continue

                if clean in LIGHTNING_DIRECTIONS or clean in {"ALL", "QUADS", "QUADRANTS", "ALLQUADS", "AND"}:
                    collected.append(clean)
                else:
                    break

            direction = normalize_lightning_direction(" ".join(collected))
            return direction or ""

    return ""

def has_metar_field_thunder(metar):
    text = (metar or "").upper()

    # Avoid scanning the entire remarks for random words. Look for aviation weather tokens.
    thunder_codes = ["+TSRA", "TSRA", "-TSRA", "TS", "TSGR", "TSGS"]

    for code in thunder_codes:
        if weather_code_present(text, code):
            return True

    return False


def has_metar_vcts(metar):
    return weather_code_present(metar or "", "VCTS")


def extract_atis_ltg_direction(atis_text):
    text = (atis_text or "").upper()

    # Common ATIS/METAR variants:
    #   OCNL LTGIC DSNT SW-W
    #   LTG DSNT NE-SW
    #   LIGHTNING DISTANT SW
    patterns = [
        r"\bLTG[A-Z]*\s+DSNT\s+((?:N|NE|E|SE|S|SW|W|NW)(?:\s*-\s*(?:N|NE|E|SE|S|SW|W|NW))?(?:\s+(?:AND\s+)?(?:N|NE|E|SE|S|SW|W|NW)(?:\s*-\s*(?:N|NE|E|SE|S|SW|W|NW))?)*)\b",
        r"\bLIGHTNING\s+DISTANT\s+((?:N|NE|E|SE|S|SW|W|NW)(?:\s*-\s*(?:N|NE|E|SE|S|SW|W|NW))?)\b",
        r"\bDISTANT\s+LIGHTNING\s+((?:N|NE|E|SE|S|SW|W|NW)(?:\s*-\s*(?:N|NE|E|SE|S|SW|W|NW))?)\b"
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            direction = normalize_lightning_direction(match.group(1))
            if direction:
                return direction

    if (
        "LIGHTNING DISTANT" in text
        or "DISTANT LIGHTNING" in text
        or re.search(r"\bLTG[A-Z]*\s+DSNT\b", text)
    ):
        return ""

    return ""

def has_atis_vicinity_thunder(atis_text):
    text = (atis_text or "").upper()
    return (
        "VCTS" in text
        or "VICINITY THUNDER" in text
        or "THUNDERSTORMS IN THE VICINITY" in text
        or "THUNDERSTORM IN THE VICINITY" in text
    )


def has_atis_field_thunder(atis_text):
    text = (atis_text or "").upper()

    if has_atis_vicinity_thunder(text):
        return False

    return (
        "TSRA" in text
        or "THUNDERSTORM RAIN" in text
        or "THUNDERSTORM OVER" in text
        or "THUNDERSTORM AT" in text
        or "THUNDERSTORM ON" in text
    )


def taf_group_has_thunder(group_text):
    text = (group_text or "").upper()
    return any(
        weather_code_present(text, code)
        for code in ["+TSRA", "TSRA", "-TSRA", "VCTS", "TS", "TSGR", "TSGS"]
    )


def format_taf_window(window_token, prefix="", taf_issue_dt=None, current_utc_dt=None):
    if not window_token:
        return ""
    return taf_window_display_from_token(window_token, taf_issue_dt, current_utc_dt)


def find_taf_thunder_window(taf):
    text = re.sub(r"\s+", " ", (taf or "").upper()).strip()

    if not text or text_is_bad(text):
        return ""

    # Main prevailing TAF valid period before first change group.
    main_valid_match = re.search(r"\b(\d{4}/\d{4})\b", text)
    main_valid = main_valid_match.group(1) if main_valid_match else ""

    markers = list(re.finditer(r"\b(FM\d{6}|TEMPO|BECMG|PROB30|PROB40)\b", text))

    # Check base prevailing section first.
    if main_valid_match:
        base_start = main_valid_match.end()
        base_end = markers[0].start() if markers else len(text)
        base_group = text[base_start:base_end]

        if taf_group_has_thunder(base_group):
            return format_taf_window(main_valid)

    for idx, marker in enumerate(markers):
        marker_text = marker.group(1)
        next_start = markers[idx + 1].start() if idx + 1 < len(markers) else len(text)
        group_text = text[marker.start():next_start]

        if not taf_group_has_thunder(group_text):
            continue

        if marker_text.startswith("FM"):
            return format_taf_window(marker_text)

        # TEMPO/BECMG/PROB groups should have DDHH/DDHH after the keyword.
        window_match = re.search(r"\b(\d{4}/\d{4})\b", group_text)
        if window_match:
            return format_taf_window(window_match.group(1))

        if main_valid:
            return format_taf_window(main_valid)

        return ""

    return ""


def build_lightning_summary(metar, taf, atis_text):
    """Build current/near-current lightning status only.

    LIGHTNING box rule:
      - Use current ATIS/METAR only.
      - TAF thunder never activates LIGHTNING.
      - TAF thunder remains a WX ALERT / TAF TREND item with a time window.
      - Highest severity wins; equal severity favors ATIS.
    """
    candidates = []

    def add_candidate(rank, source, lightning, severity, tone, flash, pulse, log_text):
        candidates.append({
            "rank": rank,
            "sourceTie": 0 if source == "ATIS" else 1,
            "lightning": lightning,
            "lightningSeverity": severity,
            "lightningTone": tone,
            "lightningFlash": flash,
            "lightningPulse": pulse,
            "lightningSource": source,
            "lightningLogText": log_text
        })

    if has_metar_field_thunder(metar):
        add_candidate(
            3,
            "METAR",
            "⛈️ TS OVER FIELD",
            "active_field",
            "red",
            True,
            False,
            "METAR thunderstorm over/near field."
        )

    if has_metar_vcts(metar):
        add_candidate(
            2,
            "METAR",
            "⚡ VCTS 5-10 NM",
            "vicinity",
            "yellow",
            False,
            True,
            "METAR VCTS. 5-10 NM."
        )

    metar_dsnt_dir = extract_metar_ltg_dsnt_direction(metar)
    if metar_dsnt_dir:
        add_candidate(
            1,
            "METAR",
            f"⚡ DSNT {metar_dsnt_dir} 10-30 NM",
            "distant",
            "yellow",
            False,
            True,
            f"METAR LTG DSNT {metar_dsnt_dir}. 10-30 NM."
        )

    if has_atis_field_thunder(atis_text):
        add_candidate(
            3,
            "ATIS",
            "⛈️ TS OVER FIELD",
            "active_field",
            "red",
            True,
            False,
            "ATIS thunderstorm wording."
        )

    if has_atis_vicinity_thunder(atis_text):
        add_candidate(
            2,
            "ATIS",
            "⚡ VCTS 5-10 NM",
            "vicinity",
            "yellow",
            False,
            True,
            "ATIS vicinity thunderstorm wording."
        )

    atis_dsnt_dir = extract_atis_ltg_direction(atis_text)
    if atis_dsnt_dir:
        add_candidate(
            1,
            "ATIS",
            f"⚡ DSNT {atis_dsnt_dir} 10-30 NM",
            "distant",
            "yellow",
            False,
            True,
            f"ATIS distant lightning {atis_dsnt_dir}. 10-30 NM."
        )

    if candidates:
        candidates.sort(key=lambda item: (-item["rank"], item["sourceTie"]))
        selected = candidates[0].copy()
        selected.pop("rank", None)
        selected.pop("sourceTie", None)
        return selected

    return {
        "lightning": "NONE",
        "lightningSeverity": "none",
        "lightningTone": "green",
        "lightningFlash": False,
        "lightningPulse": False,
        "lightningSource": "NONE",
        "lightningLogText": "No current METAR/ATIS lightning or thunder cues. TAF thunder belongs in WX ALERT / TAF TREND."
    }

def get_xml_tag(xml_text, tag_name):
    pattern = rf"<{tag_name}>(.*?)</{tag_name}>"
    match = re.search(pattern, xml_text, re.IGNORECASE | re.DOTALL)

    if not match:
        return "--"

    value = unescape(match.group(1))
    value = re.sub(r"\s+", " ", value).strip()

    return value if value else "--"


def normalize_bwc_risk(raw_value, parsed_ok):
    value = (raw_value or "").strip().upper()

    if value in {"LOW", "MODERATE", "SEVERE", "NONE"}:
        return value

    if value == "HIGH":
        return "SEVERE"

    if parsed_ok and value in {"--", "", "NA", "N/A", "NO DATA"}:
        return "NONE"

    return "PENDING"


def fetch_ahas_bwc(now_z):
    month = now_z.month
    day = now_z.day
    hour = f"{now_z.hour:02d}"

    print_url = (
        "https://www.usahas.com/print.aspx"
        f"?month={month}"
        f"&day={day}"
        f"&hour={hour}"
        "&type=ICAO"
        "&NAME=MEMPHIS%20INTL"
        "&Button=default"
    )

    risk_url = (
        "https://www.usahas.com/webservices/Fluffy_AHAS2025.asmx/GetAHASRisk"
        "?Type=ICAO"
        "&Area=%27MEMPHIS%20INTL%27"
        f"&iMonth={month}"
        f"&iDay={day}"
        f"&iHour={hour}"
    )

    result = {
        "bwc": "PENDING",
        "bwcSource": "AHAS",
        "bwcUpdatedZ": "--",
        "bwcNexrad": "--",
        "bwcSoarRisk": "--",
        "bwcBamRisk": "--",
        "bwcAhasRisk": "--",
        "bwcBasedOn": "--",
        "bwcHeight100FtAgl": "--",
        "bwcUrl": print_url,
        "bwcRiskUrl": risk_url,
        "bwcFetchStatus": "NOT_STARTED"
    }

    try:
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )

        print_page = fetch_with_opener(opener, print_url)

        if not print_page:
            result["bwcFetchStatus"] = "PRINT_PAGE_FAILED"
            return result

        xml_text = fetch_with_opener(opener, risk_url)

        if not xml_text:
            result["bwcFetchStatus"] = "RISK_ENDPOINT_FAILED"
            return result

        date_time = get_xml_tag(xml_text, "DateTime")
        nexrad_risk = get_xml_tag(xml_text, "NEXRADRISK").upper()
        soar_risk = get_xml_tag(xml_text, "SOARRISK").upper()
        bam_risk = get_xml_tag(xml_text, "BAMRISK").upper()
        ahas_risk = get_xml_tag(xml_text, "AHASRISK").upper()
        based_on = get_xml_tag(xml_text, "BasedOn").upper()
        ti_depth = get_xml_tag(xml_text, "TIDepth").upper()
        segment = get_xml_tag(xml_text, "Segment").upper()

        parsed_ok = segment != "--" or ahas_risk != "--" or based_on != "--"

        if not parsed_ok:
            result["bwcFetchStatus"] = "NO_RESULT_ROW"
            return result

        bwc_value = normalize_bwc_risk(ahas_risk, parsed_ok)

        result.update({
            "bwc": bwc_value,
            "bwcSource": "AHAS",
            "bwcUpdatedZ": date_time,
            "bwcNexrad": nexrad_risk,
            "bwcSoarRisk": soar_risk,
            "bwcBamRisk": bam_risk,
            "bwcAhasRisk": ahas_risk,
            "bwcBasedOn": based_on,
            "bwcHeight100FtAgl": ti_depth,
            "bwcUrl": print_url,
            "bwcRiskUrl": risk_url,
            "bwcFetchStatus": "PARSED_DIRECT_XML"
        })

        return result

    except Exception as error:
        print("AHAS parse failed:", error)
        result["bwcFetchStatus"] = "ERROR"
        return result


def sync_repo_before_update():
    """
    Production safety:
      Scheduled updater must not run "git reset --hard origin/main".
      Code updates should be pulled manually so local uncommitted work is not erased.
    """
    print("Scheduled update: repo auto-reset disabled. Code updates are manual.")
    return

def text_is_bad(value):
    text = (value or "").upper().strip()

    if not text:
        return True

    bad_markers = [
        "UNAVAILABLE",
        "ERROR",
        "FAILED",
        "PENDING",
        "NO DATA"
    ]

    return any(marker in text for marker in bad_markers)


def is_good_metar(metar):
    text = (metar or "").upper().strip()

    if text_is_bad(text):
        return False

    # A SPECI is a current aviation observation and should be treated as the METAR
    # source for this board. Rejecting SPECI caused valid special observations to be
    # ignored, which could leave the display on stale last-known-good METAR data.
    return (
        re.search(r"\b(?:METAR|SPECI)\s+KMEM\b", text) is not None
        and re.search(r"\b\d{6}Z\b", text) is not None
    )


def is_good_taf(taf):
    text = (taf or "").upper().strip()

    if text_is_bad(text):
        return False

    return "TAF" in text and "KMEM" in text and re.search(r"\b\d{4}/\d{4}\b", text) is not None


def is_good_atis(atis_text):
    text = (atis_text or "").upper().strip()

    if text_is_bad(text):
        return False

    if len(text) < 40:
        return False

    if "KMEM" not in text and "MEM" not in text:
        return False

    identity = atis_report_identity(text)
    if not identity:
        return False

    header_letter = identity[0]
    handoff_letters = re.findall(
        r"\bADVS?\s+YOU\s+HAVE\s+(?:INFO|INFORMATION)\s+([A-Z])\b",
        text,
    )
    if handoff_letters and handoff_letters[-1] != header_letter:
        return False

    # A plausible header alone is not a usable observation. Require enough
    # weather/operations structure to prevent a newer corrupt provider payload
    # from displacing an older, complete ATIS.
    weather_signals = [
        re.search(r"\b(?:\d{3}|VRB)\d{2}(?:G\d{2})?KT\b", text),
        re.search(r"\b(?:P?\d+(?:\s+\d+/\d+)?|\d+/\d+)SM\b", text),
        re.search(r"\bA\d{4}\b", text),
        re.search(r"\b(?:SKC|CLR|FEW|SCT|BKN|OVC|VV)\d{3}\b", text),
        re.search(r"\bM?\d{2}/M?\d{2}\b", text),
    ]
    weather_count = sum(signal is not None for signal in weather_signals)
    operations_present = re.search(
        r"\b(?:APCH|APPROACH|LANDING|DEPARTING|DEPG|RWY|RY)\b",
        text,
    ) is not None

    return weather_count >= 2 or (weather_count >= 1 and operations_present)


def is_good_bwc(data):
    bwc = (data or {}).get("bwc", "").upper()
    updated = (data or {}).get("bwcUpdatedZ", "")

    if bwc not in {"NONE", "LOW", "MODERATE", "SEVERE"}:
        return False

    if not updated or updated == "--":
        return False

    return True


def use_previous_field(previous_data, key, default=""):
    value = (previous_data or {}).get(key, default)

    if value is None:
        return default

    return value


def summarize_mil_notams_for_scroll(items):
    parts = []

    for item in items or []:
        number = str(item.get("number") or item.get("id") or "UNKNOWN").strip()
        display_text = str(
            item.get("displayText")
            or item.get("text")
            or item.get("plainLanguage")
            or ""
        ).strip()

        if number and display_text:
            parts.append(f"{number} {display_text}")
        elif number:
            parts.append(number)
        elif display_text:
            parts.append(display_text)

    return "  |  ".join(parts)




def normalize_notam_time_for_export(value):
    """
    Keep NMS effective times in a consistent compact string.
    Returns 12-digit YYYYMMDDHHMM when possible so the board can display:
      202606081300 -> 08 JUN 1300Z
    """
    if value is None:
        return ""

    text = str(value).strip().upper()

    if not text:
        return ""

    if text in ("UFN", "FURTHER NOTICE", "UNTIL FURTHER NOTICE"):
        return "UFN"

    # Already compact FAA/NMS style.
    if re.match(r"^\d{12}$", text):
        return text

    # YYMMDDHHMM -> YYYYMMDDHHMM. Assume 20xx for current NOTAMs.
    if re.match(r"^\d{10}$", text):
        return "20" + text

    # DAIP/PDF style: 08 JUN 13:00 2026
    month_map = {
        "JAN": "01", "FEB": "02", "MAR": "03", "APR": "04",
        "MAY": "05", "JUN": "06", "JUL": "07", "AUG": "08",
        "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12"
    }
    m = re.search(r"\b(\d{1,2})\s+([A-Z]{3})\s+(\d{2}):(\d{2})\s+(\d{4})\b", text)
    if m and m.group(2) in month_map:
        return f"{m.group(5)}{month_map[m.group(2)]}{int(m.group(1)):02d}{m.group(3)}{m.group(4)}"

    parsed = parse_z_datetime(text)

    if parsed:
        return parsed.strftime("%Y%m%d%H%M")

    # ISO without Z or with milliseconds.
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
        return parsed.strftime("%Y%m%d%H%M")
    except Exception:
        pass

    return text

def notam_text_blob(item):
    if not isinstance(item, dict):
        return str(item or "")

    return " ".join([
        str(item.get("fullText") or ""),
        str(item.get("notamText") or ""),
        str(item.get("text") or ""),
        str(item.get("displayText") or ""),
        str(item.get("rawText") or ""),
        str(item.get("message") or ""),
        str(item.get("body") or ""),
        str(item.get("plainLanguage") or ""),
        str(item.get("description") or "")
    ]).strip()


NOTAMC_RE = re.compile(r"\bNOTAM\s*C\b", re.IGNORECASE)
NOTAMC_TARGET_RE = re.compile(
    r"\bNOTAM\s*C\b\s*(?:OF\s+)?"
    r"((?:[A-Z]\s*\d{1,4}\s*/\s*\d{2})|(?:\d{1,2}\s*/\s*\d{3}))\b",
    re.IGNORECASE
)
NOTAMR_RE = re.compile(r"\bNOTAM\s*R\b", re.IGNORECASE)
NOTAMR_TARGET_RE = re.compile(
    r"\bNOTAM\s*R\b\s*(?:OF\s+)?"
    r"((?:[A-Z]\s*\d{1,4}\s*/\s*\d{2})|(?:\d{1,2}\s*/\s*\d{3}))\b",
    re.IGNORECASE
)
NOTAM_SERIES_NUMBER_RE = re.compile(
    r"\b([A-Z])\s*(\d{1,4})\s*/\s*(\d{2})\b",
    re.IGNORECASE
)
NOTAM_LOCAL_NUMBER_RE = re.compile(r"\b(\d{1,2})\s*/\s*(\d{3})\b")
NOTAM_COLLECTION_KEYS = (
    "milNotams", "items", "ficonNotams", "runwayClosureNotams",
    "rwyClosureNotams", "closureNotams", "constructionStatusNotams",
    "constructionNotams", "airfieldStatusNotams", "taxiRestrictionNotams",
    "taxiRouteRestrictionNotams", "taxiRouteNotams", "airportNotams",
    "allNotams", "notams"
)


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


def notam_record_number(item):
    if not isinstance(item, dict):
        return canonical_notam_number(item)

    return canonical_notam_number(
        item.get("number")
        or item.get("id")
        or item.get("notamNumber")
        or item.get("accountId")
        or item.get("notamId")
    )


def is_notam_cancellation(item):
    """True when the record is a NOTAMC cancellation message."""
    if isinstance(item, dict):
        type_value = str(
            item.get("notamType")
            or item.get("action")
            or item.get("operation")
            or ""
        ).strip().upper()

        if type_value in {"C", "NOTAMC", "CANCEL", "CANCELED", "CANCELLED", "CANCELLATION"}:
            return True

    return bool(NOTAMC_RE.search(notam_text_blob(item)))


def notam_cancellation_target(item):
    """Return the NOTAM identifier named immediately after NOTAMC, if present."""
    if isinstance(item, dict):
        for key in (
            "cancelsNotam", "cancelledNotam", "canceledNotam",
            "cancellationTarget", "cancelTarget"
        ):
            target = canonical_notam_number(item.get(key))
            if target:
                return target

    match = NOTAMC_TARGET_RE.search(notam_text_blob(item))

    if not match:
        return ""

    return canonical_notam_number(match.group(1))


def is_notam_replacement(item):
    """True when the record is a NOTAMR replacement message."""
    if isinstance(item, dict):
        type_value = str(
            item.get("notamType")
            or item.get("action")
            or item.get("operation")
            or ""
        ).strip().upper()

        if type_value in {"R", "NOTAMR", "REPLACE", "REPLACED", "REPLACEMENT"}:
            return True

    return bool(NOTAMR_RE.search(notam_text_blob(item)))


def notam_replacement_target(item):
    """Return the NOTAM identifier named immediately after NOTAMR, if present."""
    if isinstance(item, dict):
        for key in (
            "replacesNotam", "replacedNotam", "replacementTarget",
            "replaceTarget", "previousNotam"
        ):
            target = canonical_notam_number(item.get(key))
            if target:
                return target

    match = NOTAMR_TARGET_RE.search(notam_text_blob(item))

    if not match:
        return ""

    return canonical_notam_number(match.group(1))


def notam_inactive_target(item):
    """Return the target made inactive by a NOTAMC or NOTAMR action."""
    return notam_cancellation_target(item) or notam_replacement_target(item)


def collect_inactive_notam_targets(raw):
    targets = set()

    if not isinstance(raw, dict):
        return targets

    for key in NOTAM_COLLECTION_KEYS:
        items = raw.get(key)

        if not isinstance(items, list):
            continue

        for item in items:
            target = notam_inactive_target(item)
            if target:
                targets.add(target)

    return targets


def filter_inactive_notam_records(items, inactive_numbers=None):
    """Hide NOTAMC actions plus every cancelled or superseded record."""
    records = list(items or []) if isinstance(items, list) else []
    inactive = {
        canonical_notam_number(value)
        for value in (inactive_numbers or [])
        if canonical_notam_number(value)
    }

    for item in records:
        target = notam_inactive_target(item)
        if target:
            inactive.add(target)

    return [
        item
        for item in records
        if not is_notam_cancellation(item)
        and (not notam_record_number(item) or notam_record_number(item) not in inactive)
    ]


def is_runway_closure_notam_text(text):
    """
    True runway closure only.

    Excludes taxiway closures that merely mention a runway as a boundary, e.g.
    "TWY V BTN TWY V3 AND TWY S, TWY C BTN TWY V AND RWY 09/27 CLSD".
    """
    compact = re.sub(r"\s+", " ", str(text or "").upper()).strip()

    if not compact:
        return False

    segments = [s.strip() for s in re.split(r"\.\s+|;\s+", compact) if s.strip()]

    for segment in segments:
        if "CLSD" not in segment and "CLOSED" not in segment:
            continue

        first_twy = segment.find("TWY")
        first_rwy = segment.find("RWY")

        # Taxiway closure segment first = not a runway closure display item.
        if first_twy != -1 and (first_rwy == -1 or first_twy < first_rwy):
            continue

        if re.search(r"\bRWY\s+\d{1,2}[LCR]?(?:\s*/\s*\d{1,2}[LCR]?|\s*,\s*\d{1,2}[LCR]?)*\s+(?:CLSD|CLOSED)\b", segment):
            return True

    return False

def compact_runway_closure_text_for_export(text):
    raw = re.sub(r"\s+", " ", str(text or "")).strip()
    raw = re.sub(r"\s*CREATED:\s*.*$", "", raw, flags=re.I).strip()

    segments = [s.strip() for s in re.split(r"\.\s+|;\s+", raw) if s.strip()]

    for segment in segments:
        upper = segment.upper()

        if "CLSD" not in upper and "CLOSED" not in upper:
            continue

        first_twy = upper.find("TWY")
        first_rwy = upper.find("RWY")

        # Exclude taxiway closures that mention a runway boundary.
        if first_twy != -1 and (first_rwy == -1 or first_twy < first_rwy):
            continue

        match = re.search(
            r"\bRWY\s+\d{1,2}[LCR]?(?:\s*/\s*\d{1,2}[LCR]?|\s*,\s*\d{1,2}[LCR]?)*\s+(?:CLSD|CLOSED)\b",
            segment,
            flags=re.I
        )

        if match:
            return re.sub(r"\s+", " ", match.group(0)).strip()

    return ""

def normalize_runway_closure_notams(raw, previous_data=None, inactive_numbers=None):
    """
    Normalizes runway-closure NOTAMs exported by the NMS script.

    Display-only export. This does not affect ATIS-driven runway/flow data blocks.
    """
    raw = raw or {}

    candidate_lists = [
        raw.get("runwayClosureNotams"),
        raw.get("rwyClosureNotams"),
        raw.get("closureNotams"),
        raw.get("airportNotams"),
        raw.get("allNotams"),
        raw.get("notams"),
        raw.get("items")
    ]

    inactive_numbers = set(inactive_numbers or collect_inactive_notam_targets(raw))
    normalized = []
    seen = set()

    for items in candidate_lists:
        if not isinstance(items, list):
            continue

        for item in items:
            if not isinstance(item, dict):
                continue

            if is_notam_cancellation(item) or notam_record_number(item) in inactive_numbers:
                continue

            text_blob = notam_text_blob(item)

            if not is_runway_closure_notam_text(text_blob):
                continue

            number = str(item.get("number") or item.get("id") or item.get("notamNumber") or "UNKNOWN").strip()
            raw_text = str(item.get("rawText") or item.get("text") or item.get("displayText") or text_blob).strip()
            text = compact_runway_closure_text_for_export(raw_text)

            if not text:
                continue

            effective_start = normalize_notam_time_for_export(
                item.get("effectiveStart")
                or item.get("start")
                or item.get("startTime")
                or item.get("validFrom")
                or item.get("effectiveFrom")
                or item.get("begin")
            )

            effective_end = normalize_notam_time_for_export(
                item.get("effectiveEnd")
                or item.get("end")
                or item.get("endTime")
                or item.get("validTo")
                or item.get("effectiveTo")
            )

            key = (number, text, effective_start, effective_end)

            if key in seen:
                continue

            seen.add(key)

            normalized.append({
                "number": number,
                "classification": item.get("classification") or "RWY_CLOSURE",
                "severity": item.get("severity") or "red",
                "text": text,
                "displayText": text,
                "effectiveStart": effective_start,
                "effectiveEnd": effective_end,
                "lastUpdated": item.get("lastUpdated") or item.get("updated") or "",
                "source": item.get("source") or raw.get("source") or "FAA_NMS_STAGING",
                "rawText": raw_text
            })

    if normalized:
        return normalized

    previous_data = previous_data or {}

    previous = previous_data.get("runwayClosureNotams")

    if isinstance(previous, list):
        return filter_inactive_notam_records(previous, inactive_numbers)

    return []


def normalize_status_notams(
    raw,
    key_names,
    classification,
    fallback_predicate=None,
    inactive_numbers=None
):
    raw = raw or {}
    inactive_numbers = set(inactive_numbers or collect_inactive_notam_targets(raw))
    normalized = []
    seen = set()

    candidate_lists = [(raw.get(key), True) for key in key_names]

    if fallback_predicate:
        candidate_lists.extend([
            (raw.get("airportNotams"), False),
            (raw.get("allNotams"), False),
            (raw.get("notams"), False),
            (raw.get("items"), False)
        ])

    for items, explicit_list in candidate_lists:
        if not isinstance(items, list):
            continue

        for item in items:
            if not isinstance(item, dict):
                continue

            if is_notam_cancellation(item) or notam_record_number(item) in inactive_numbers:
                continue

            text_blob = notam_text_blob(item)
            if fallback_predicate and not explicit_list and not fallback_predicate(text_blob):
                continue

            number = str(item.get("number") or item.get("id") or item.get("notamNumber") or "UNKNOWN").strip()
            raw_text = str(item.get("rawText") or item.get("text") or item.get("displayText") or text_blob).strip()
            display_text = str(item.get("displayText") or item.get("text") or raw_text).strip()

            effective_start = normalize_notam_time_for_export(
                item.get("effectiveStart")
                or item.get("start")
                or item.get("startTime")
                or item.get("validFrom")
                or item.get("effectiveFrom")
                or item.get("begin")
            )

            effective_end = normalize_notam_time_for_export(
                item.get("effectiveEnd")
                or item.get("end")
                or item.get("endTime")
                or item.get("validTo")
                or item.get("effectiveTo")
            )

            key = (number, raw_text, effective_start, effective_end, classification)

            if key in seen:
                continue

            seen.add(key)

            normalized.append({
                "number": number,
                "classification": item.get("classification") or classification,
                "severity": item.get("severity") or "amber",
                "text": raw_text,
                "displayText": display_text,
                "effectiveStart": effective_start,
                "effectiveEnd": effective_end,
                "lastUpdated": item.get("lastUpdated") or item.get("updated") or "",
                "source": item.get("source") or raw.get("source") or "FAA_NMS_STAGING",
                "rawText": raw_text
            })

    return normalized


def is_construction_status_notam_text(text):
    compact = re.sub(r"\s+", " ", str(text or "").upper()).strip()
    if not compact or "FICON" in compact:
        return False
    padded = f" {compact} "
    return any(term in padded for term in [
        " WIP ", " WORK IN PROGRESS", " CONSTRUCTION", " CONST ",
        " MAINT", " MAINTENANCE", " MARKING", " MARKINGS",
        " MOWING", " SPRAYING", " WEEDING", " REPAIR",
        " PAVEMENT WORK", " WORK AREA"
    ])


def is_taxi_restriction_notam_text(text):
    compact = re.sub(r"\s+", " ", str(text or "").upper()).strip()
    if not compact or "FICON" in compact:
        return False
    surface_hit = re.search(r"\b(TWY|TAXIWAY|TAXILANE|RAMP|APRON|GATE|MOVEMENT AREA|MOVEMENT-AREA)\b", compact)
    restriction_hit = re.search(r"\b(CLSD|CLOSED|RESTRICT|RESTRICTED|RESTR|UNAVBL|NOT AVBL|TAXI ROUTE|ROUTE)\b", compact)
    return bool(surface_hit and restriction_hit)


def normalize_mil_notams_output(raw, fetch_status="OK"):
    raw = raw or {}
    inactive_numbers = collect_inactive_notam_targets(raw)
    items = raw.get("milNotams") or raw.get("items") or []

    if not isinstance(items, list):
        items = []

    items = filter_inactive_notam_records(items, inactive_numbers)

    normalized_items = []

    for item in items:
        if not isinstance(item, dict):
            continue

        number = str(item.get("number") or item.get("id") or "UNKNOWN").strip()
        text = str(item.get("text") or item.get("displayText") or "").strip()
        display_text = str(item.get("displayText") or text).strip()
        severity = str(item.get("severity") or "amber").strip().lower()

        normalized_items.append({
            "number": number,
            "classification": item.get("classification") or item.get("type") or "MIL",
            "severity": severity,
            "text": text,
            "displayText": display_text,
            "effectiveStart": item.get("effectiveStart") or item.get("start") or "",
            "effectiveEnd": item.get("effectiveEnd") or item.get("end") or "",
            "lastUpdated": item.get("lastUpdated") or item.get("updated") or "",
            "source": item.get("source") or raw.get("source") or "FAA_NMS_STAGING"
        })

    # The source totals and prebuilt crawl can still include inactive records.
    # Recompute all three from the sanitized records instead of trusting them.
    count = len(normalized_items)
    scroll_text = summarize_mil_notams_for_scroll(normalized_items)
    status = f"{count} ACTIVE" if count else "NONE ACTIVE"

    ficon_notams = filter_inactive_notam_records(raw.get("ficonNotams") or [], inactive_numbers)
    runway_closure_notams = normalize_runway_closure_notams(
        raw,
        inactive_numbers=inactive_numbers
    )
    construction_status_notams = normalize_status_notams(
        raw,
        ["constructionStatusNotams", "constructionNotams", "airfieldStatusNotams"],
        "CONST_AFLD_STATUS",
        is_construction_status_notam_text,
        inactive_numbers
    )
    taxi_restriction_notams = normalize_status_notams(
        raw,
        ["taxiRestrictionNotams", "taxiRouteRestrictionNotams", "taxiRouteNotams"],
        "TAXI_ROUTE_RESTR",
        is_taxi_restriction_notam_text,
        inactive_numbers
    )

    return {
        "milNotamCount": count,
        "milNotamStatus": status,
        "milNotamSource": raw.get("source") or "FAA_NMS_STAGING",
        "milNotamUpdatedZ": raw.get("generatedZ") or raw.get("updated_at_z") or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"),
        "milNotamScrollText": scroll_text,
        "milNotams": normalized_items,
        "milNotamFetchStatus": fetch_status,
        "milNotamRawStatus": raw.get("status") or "UNKNOWN",
        "ficonNotams": ficon_notams,
        "ficonNotamCount": len(ficon_notams),
        "runwayClosureNotams": runway_closure_notams,
        "runwayClosureNotamCount": len(runway_closure_notams),
        "constructionStatusNotams": construction_status_notams,
        "constructionStatusNotamCount": len(construction_status_notams),
        "taxiRestrictionNotams": taxi_restriction_notams,
        "taxiRestrictionNotamCount": len(taxi_restriction_notams)
    }


def previous_mil_notams_or_default(previous_data, fetch_status="NO_DATA"):
    previous_data = previous_data or {}

    if "milNotams" in previous_data or "milNotamCount" in previous_data:
        previous_raw = {
            "source": use_previous_field(previous_data, "milNotamSource", "FAA_NMS_STAGING"),
            "generatedZ": use_previous_field(previous_data, "milNotamUpdatedZ", "--"),
            "status": use_previous_field(previous_data, "milNotamRawStatus", "LAST_GOOD"),
            "milNotams": use_previous_field(previous_data, "milNotams", []),
            "ficonNotams": use_previous_field(previous_data, "ficonNotams", []),
            "runwayClosureNotams": use_previous_field(previous_data, "runwayClosureNotams", []),
            "constructionStatusNotams": use_previous_field(previous_data, "constructionStatusNotams", []),
            "taxiRestrictionNotams": use_previous_field(previous_data, "taxiRestrictionNotams", [])
        }
        return normalize_mil_notams_output(previous_raw, fetch_status)

    return {
        "milNotamCount": 0,
        "milNotamStatus": "NMS NOT CHECKED",
        "milNotamSource": "FAA_NMS_STAGING",
        "milNotamUpdatedZ": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"),
        "milNotamScrollText": "",
        "milNotams": [],
        "milNotamFetchStatus": fetch_status,
        "milNotamRawStatus": "NO_PREVIOUS_DATA",
        "ficonNotams": [],
        "ficonNotamCount": 0,
        "runwayClosureNotams": [],
        "runwayClosureNotamCount": 0,
        "constructionStatusNotams": [],
        "constructionStatusNotamCount": 0,
        "taxiRestrictionNotams": [],
        "taxiRestrictionNotamCount": 0
    }


def fetch_mil_notams(previous_data):
    """
    Runs the working FAA NMS KMEM MIL NOTAM test script and merges its JSON output.

    This is intentionally non-fatal. If NMS credentials are missing, NMS rate-limits,
    or the script fails, the weather board still updates and uses the previous MIL
    NOTAM block when available.
    """

    client_id = os.environ.get("NMS_CLIENT_ID", "").strip()
    client_secret = os.environ.get("NMS_CLIENT_SECRET", "").strip()

    if not client_id or not client_secret:
        print("MIL NOTAMS: NMS_CLIENT_ID/NMS_CLIENT_SECRET not set; using previous MIL NOTAM data if available.")
        return previous_mil_notams_or_default(previous_data, "NO_CREDENTIALS")

    if not os.path.exists(NMS_MIL_NOTAMS_SCRIPT_PATH):
        print(f"MIL NOTAMS: script missing: {NMS_MIL_NOTAMS_SCRIPT_PATH}")
        return previous_mil_notams_or_default(previous_data, "NO_NMS_SCRIPT")

    try:
        print("MIL NOTAMS: running FAA NMS pull...")

        result = subprocess.run(
            [sys.executable, NMS_MIL_NOTAMS_SCRIPT_PATH],
            cwd=REPO_DIR,
            text=True,
            capture_output=True,
            timeout=NMS_MIL_NOTAMS_TIMEOUT_SECONDS
        )

        if result.stdout:
            print(result.stdout.strip())

        if result.stderr:
            print(result.stderr.strip())

        if result.returncode != 0:
            print(f"MIL NOTAMS: NMS script returned {result.returncode}; using previous data if available.")
            return previous_mil_notams_or_default(previous_data, "SCRIPT_FAILED")

        raw = load_json_file(NMS_MIL_NOTAMS_OUTPUT_PATH)

        if not raw:
            print("MIL NOTAMS: output JSON missing or empty; using previous data if available.")
            return previous_mil_notams_or_default(previous_data, "NO_OUTPUT_JSON")

        mil_data = normalize_mil_notams_output(raw, "OK")
        print("MIL NOTAMS:", mil_data["milNotamStatus"], "SOURCE:", mil_data["milNotamSource"])
        return mil_data

    except subprocess.TimeoutExpired:
        print("MIL NOTAMS: NMS script timed out; using previous data if available.")
        return previous_mil_notams_or_default(previous_data, "TIMEOUT")

    except Exception as error:
        print("MIL NOTAMS: failed:", error)
        return previous_mil_notams_or_default(previous_data, "ERROR")




def should_save_last_good(data):
    return (
        is_good_metar(data.get("metar", ""))
        and is_good_taf(data.get("taf", ""))
        and is_good_atis(data.get("atisText", ""))
        and data.get("metarFetchStatus") == "OK"
        and data.get("atisFetchStatus") == "OK"
        and data.get("tafFetchStatus") in {"OK", "USED_LAST_GOOD"}
    )


def maintain_atis_history_safely(live_candidates, now_z, maintainer=None):
    """Maintain supplemental ATIS history without risking operational output."""
    try:
        if maintainer is None:
            from atis_history import maintain_atis_history

            maintainer = maintain_atis_history
        result = maintainer(
            ATIS_HISTORY_PATH,
            live_candidates,
            now_z=now_z,
            validator=is_good_atis,
            station="KMEM",
            retention_hours=ATIS_HISTORY_RETENTION_HOURS,
        )
        if not result.success:
            print(f"ATIS history maintenance failed safely: {result.error or 'unknown error'}")
        elif result.changed:
            print(
                "ATIS history updated:",
                f"appended={result.appended}",
                f"deduplicated={result.deduplicated}",
                f"pruned={result.pruned}",
                f"rejected={result.rejected}",
            )
        else:
            print(
                "ATIS history unchanged:",
                f"deduplicated={result.deduplicated}",
                f"pruned={result.pruned}",
                f"rejected={result.rejected}",
            )
        if result.warning:
            print(f"ATIS history warning: {result.warning}")
        return result
    except Exception as error:
        print(f"ATIS history maintenance failed safely: {error}")
        return None


def maintain_taf_current_safely(now_z=None, maintainer=None):
    """Maintain the supplemental current-TAF snapshot without operational impact."""
    try:
        if maintainer is None:
            from taf_current import maintain_taf_current

            maintainer = maintain_taf_current
        result = maintainer(
            TAF_CURRENT_PATH,
            now_z=now_z or datetime.now(timezone.utc),
        )
        if not result.success:
            print(
                "Current TAF snapshot maintenance failed safely:",
                result.error or "unknown error",
            )
        elif result.changed:
            print(
                "Current TAF snapshot updated:",
                f"reports={result.report_count}",
                f"rejected={result.rejected}",
            )
        else:
            print(
                "Current TAF snapshot unchanged:",
                f"reports={result.report_count}",
                f"rejected={result.rejected}",
            )
        if result.warning:
            print(f"Current TAF snapshot warning: {result.warning}")
        return result
    except Exception as error:
        print(f"Current TAF snapshot maintenance failed safely: {error}")
        return None


def build_weather_json():
    print("Fetching KMEM weather data...")

    previous_data = load_previous_weather()
    last_known_good_used = {
        "metar": False,
        "taf": False,
        "atis": False,
        "ahas": False
    }

    metar_fetch_status = "OK"
    taf_fetch_status = "OK"
    atis_fetch_status = "OK"

    now_z = datetime.now(timezone.utc)
    trend_history = load_trend_history()
    trend_reference_sample = choose_trend_reference_sample(trend_history, now_z)

    cache_buster = int(now_z.timestamp())

    metar_raw = fetch_first_nonempty(
        [
            f"https://aviationweather.gov/api/data/metar?ids=KMEM&format=raw&hours=6&taf=false&_={cache_buster}",
            f"https://aviationweather.gov/api/data/metar?ids=KMEM&format=raw&taf=false&_={cache_buster}",
            "https://aviationweather.gov/api/data/metar?ids=KMEM&format=raw&hours=6&taf=false",
            "https://aviationweather.gov/api/data/metar?ids=KMEM&format=raw&taf=false",
            "https://tgftp.nws.noaa.gov/data/observations/metar/stations/KMEM.TXT"
        ],
        "METAR"
    )
    metar_current = choose_latest_metar_report(metar_raw, now_z)

    taf_current = fetch_first_nonempty(
        [
            f"https://aviationweather.gov/api/data/taf?ids=KMEM&format=raw&_={cache_buster}",
            "https://aviationweather.gov/api/data/taf?ids=KMEM&format=raw"
        ],
        "TAF"
    ).strip()

    previous_atis = previous_data.get("atisText", "")
    previous_atis_observed = parse_z_datetime(previous_data.get("atisObservedZ", ""))
    known_atis_observed_times = (
        {previous_atis: previous_atis_observed}
        if is_good_atis(previous_atis) and previous_atis_observed
        else {}
    )

    atis_live_diagnostics = {}
    atis_history_candidates = []
    atis_current = fetch_current_atis(
        [
            f"https://atisrelay.com/datis/KMEM?_={cache_buster}",
        ],
        now_z=now_z,
        known_observed_times=known_atis_observed_times,
        diagnostics=atis_live_diagnostics,
        live_candidates=atis_history_candidates,
    )

    if is_good_metar(metar_current):
        metar = metar_current
    elif is_good_metar(previous_data.get("metar", "")):
        metar = previous_data.get("metar", "")
        metar_fetch_status = "USED_LAST_GOOD"
        last_known_good_used["metar"] = True
        print("METAR fetch failed; using last-known-good METAR.")
    else:
        metar = "METAR unavailable"
        metar_fetch_status = "FAILED_NO_LAST_GOOD"
        print("METAR fetch failed; no valid last-known-good METAR available.")

    if is_good_taf(taf_current):
        taf = taf_current
    elif is_good_taf(previous_data.get("taf", "")):
        taf = previous_data.get("taf", "")
        taf_fetch_status = "USED_LAST_GOOD"
        last_known_good_used["taf"] = True
        print("TAF fetch failed; using last-known-good TAF.")
    else:
        taf = "TAF unavailable"
        taf_fetch_status = "FAILED_NO_LAST_GOOD"
        print("TAF fetch failed; no valid last-known-good TAF available.")

    atis_text = choose_latest_atis_report(
        [atis_current, previous_atis],
        now_z,
        known_observed_times=known_atis_observed_times,
    )

    if is_good_atis(atis_text) and atis_text == atis_current:
        atis_selected_source = "+".join(atis_live_diagnostics.get("selectedSources") or []) or "LIVE_ATIS"
    elif is_good_atis(atis_text) and is_good_atis(previous_atis):
        atis_selected_source = "LAST_KNOWN_GOOD"
        atis_fetch_status = "USED_LAST_GOOD"
        last_known_good_used["atis"] = True
        if is_good_atis(atis_current):
            print("D-ATIS provider report regressed; keeping newer last-known-good D-ATIS.")
        else:
            print("D-ATIS fetch failed; using last-known-good D-ATIS.")
    else:
        atis_text = "D-ATIS unavailable"
        atis_selected_source = "NONE"
        atis_fetch_status = "FAILED_NO_LAST_GOOD"
        print("D-ATIS fetch failed; no valid last-known-good D-ATIS available.")

    metar_observed_dt = parse_metar_datetime_utc(metar, now_z)
    metar_age_minutes = source_age_minutes(metar_observed_dt, now_z)
    original_metar_fetch_status = metar_fetch_status
    metar_fetch_status = freshness_status(metar_fetch_status, metar_age_minutes, 55, 75)

    if metar_fetch_status != original_metar_fetch_status:
        print(f"METAR freshness warning: status {metar_fetch_status}; age {metar_age_minutes} min; observed {zulu_iso(metar_observed_dt) or 'UNKNOWN'}.")

    atis_observed_dt = resolve_atis_observed_datetime(
        atis_text,
        now_z,
        known_atis_observed_times,
    )
    atis_age_minutes = source_age_minutes(atis_observed_dt, now_z)
    original_atis_fetch_status = atis_fetch_status
    atis_fetch_status = freshness_status(atis_fetch_status, atis_age_minutes, 60, 90)

    if atis_fetch_status != original_atis_fetch_status:
        print(f"D-ATIS freshness warning: status {atis_fetch_status}; age {atis_age_minutes} min; observed {zulu_iso(atis_observed_dt) or 'UNKNOWN'}.")

    atis_ops = parse_atis_operations(atis_text, atis_fetch_status)
    atis_letter = atis_ops["atisLetter"]
    atis_phonetic = atis_ops["atisPhonetic"]
    atis_display = atis_ops["atisDisplay"]
    arr_runways = atis_ops["arrRunways"]
    dep_runways = atis_ops["depRunways"]
    closed_runways = atis_ops["closedRunways"]
    flow = atis_ops["flow"]
    current_atis_text = atis_text if atis_ops["sourceIsCurrent"] else ""
    rcr_data = default_rcr_rcc("NOTAM_FICON_PENDING")

    best_obs = parse_best_observation_values(metar, atis_text, atis_fetch_status)

    altimeter = best_obs["altimeter"]
    visibility_sm = best_obs["visibilitySm"]
    ceiling_ft = best_obs["ceilingFt"]
    wind_data = best_obs["windData"]
    temp_c = best_obs["tempC"]
    dewpoint_c = best_obs["dewpointC"]

    previous_altimeter = reference_numeric(trend_reference_sample, previous_data, "altimeterRaw", parse_altimeter)
    previous_visibility_sm = reference_numeric(trend_reference_sample, previous_data, "visibilitySm", parse_visibility_sm)
    previous_ceiling_ft = reference_numeric(trend_reference_sample, previous_data, "ceilingFt", parse_ceiling_ft)

    previous_wind_speed = reference_numeric(trend_reference_sample, previous_data, "windSpeedKt")
    previous_wind_gust = reference_numeric(trend_reference_sample, previous_data, "windGustKt")
    previous_temp_c = reference_numeric(trend_reference_sample, previous_data, "tempC")
    previous_dewpoint_c = reference_numeric(trend_reference_sample, previous_data, "dewpointC")

    wind_trend_arrow, wind_trend_text, wind_trend_class = wind_trend(
        wind_data["windSpeedKt"],
        wind_data["windGustKt"],
        previous_wind_speed,
        previous_wind_gust
    )

    temp_trend, temp_trend_text = numeric_trend_with_threshold(temp_c, previous_temp_c, 1.0)
    dewpoint_trend, dewpoint_trend_text = numeric_trend_with_threshold(dewpoint_c, previous_dewpoint_c, 1.0)

    altimeter_trend = trend_symbol_threshold(altimeter, previous_altimeter, 0.02)
    visibility_trend = visibility_trend_meaningful(visibility_sm, previous_visibility_sm)
    ceiling_trend = ceiling_trend_meaningful(ceiling_ft, previous_ceiling_ft)

    trend_reference_timestamp = trend_reference_sample.get("timestampZ") if trend_reference_sample else "LAST_GOOD_FALLBACK"
    trend_reference_source = "3HR_HISTORY" if trend_reference_sample else "LAST_GOOD_FALLBACK"

    wx_alerts = detect_weather_alerts(metar, taf, current_atis_text)
    wx_summary = summarize_weather_alerts(wx_alerts)
    lightning_summary = build_lightning_summary(metar, taf, current_atis_text)

    ahas_data = fetch_ahas_bwc(now_z)

    if not is_good_bwc(ahas_data):
        if is_good_bwc(previous_data):
            print("AHAS/BWC fetch failed; using last-known-good BWC.")
            last_known_good_used["ahas"] = True
            ahas_data = {
                "bwc": use_previous_field(previous_data, "bwc", "PENDING"),
                "bwcSource": use_previous_field(previous_data, "bwcSource", "AHAS"),
                "bwcUpdatedZ": use_previous_field(previous_data, "bwcUpdatedZ", "--"),
                "bwcNexrad": use_previous_field(previous_data, "bwcNexrad", "--"),
                "bwcSoarRisk": use_previous_field(previous_data, "bwcSoarRisk", "--"),
                "bwcBamRisk": use_previous_field(previous_data, "bwcBamRisk", "--"),
                "bwcAhasRisk": use_previous_field(previous_data, "bwcAhasRisk", "--"),
                "bwcBasedOn": use_previous_field(previous_data, "bwcBasedOn", "--"),
                "bwcHeight100FtAgl": use_previous_field(previous_data, "bwcHeight100FtAgl", "--"),
                "bwcUrl": use_previous_field(previous_data, "bwcUrl", "--"),
                "bwcRiskUrl": use_previous_field(previous_data, "bwcRiskUrl", "--"),
                "bwcFetchStatus": use_previous_field(previous_data, "bwcFetchStatus", "PARSED_DIRECT_XML")
            }
        else:
            print("AHAS/BWC fetch failed; no valid last-known-good BWC available.")

    mil_notam_data = fetch_mil_notams(previous_data)
    rcr_data = parse_rcr_rcc_from_ficon_notams(mil_notam_data.get("ficonNotams", []))
    print("RSC/RCR:", rcr_data["rcrText"], "SOURCE:", rcr_data["rcrSource"], "SEVERITY:", rcr_data["rcrSeverity"])

    data = {
        "metar": metar or "METAR unavailable",
        "taf": taf or "TAF unavailable",
        "atisText": atis_text,

        "atisLetter": atis_letter,
        "atisPhonetic": atis_phonetic,
        "atisDisplay": atis_display,

        "metarFetchStatus": metar_fetch_status,
        "tafFetchStatus": taf_fetch_status,
        "atisFetchStatus": atis_fetch_status,
        "metarObservedZ": zulu_iso(metar_observed_dt),
        "metarAgeMinutes": metar_age_minutes,
        "atisObservedZ": zulu_iso(atis_observed_dt),
        "atisAgeMinutes": atis_age_minutes,
        "atisReportIdentity": atis_report_identity(atis_text),
        "atisSelectedSource": atis_selected_source,
        "atisSourcePolicy": atis_live_diagnostics.get("policy") or "NEWEST_HEADER_TIME",
        "atisSourcesChecked": atis_live_diagnostics.get("sourcesChecked") or list(ATIS_PROVIDER_NAMES),
        "atisLiveCandidateCount": atis_live_diagnostics.get("candidateCount", 0),
        "atisLiveCandidates": atis_live_diagnostics.get("candidates") or [],
        "atisSourceIsCurrent": atis_ops["sourceIsCurrent"],
        "atisReportedLetter": atis_ops["reportedLetter"],
        "atisReportedPhonetic": atis_ops["reportedPhonetic"],
        "atisReportedArrRunways": atis_ops["reportedArrRunways"],
        "atisReportedDepRunways": atis_ops["reportedDepRunways"],
        "atisReportedClosedRunways": atis_ops["reportedClosedRunways"],
        "atisReportedFlow": atis_ops["reportedFlow"],
        "lastKnownGoodUsed": last_known_good_used,
        "lastKnownGoodCachePath": LAST_GOOD_WEATHER_PATH,
        "trendLookbackHours": TREND_LOOKBACK_HOURS,
        "trendReferenceSource": trend_reference_source,
        "trendReferenceTimestampZ": trend_reference_timestamp,
        "trendSampleCount": len(trend_history),
        "trendHistoryPath": TREND_HISTORY_PATH,

        "obsSource": best_obs["obsSource"],
        "obsFieldSources": best_obs["obsFieldSources"],
        "metarAltimeterRaw": best_obs["metarAltimeter"],
        "metarVisibilitySm": best_obs["metarVisibilitySm"],
        "metarVisibilityDisplay": best_obs["metarVisibilityDisplay"],
        "metarCeilingFt": best_obs["metarCeilingFt"],
        "atisAltimeterRaw": best_obs["atisAltimeter"],
        "atisVisibilitySm": best_obs["atisVisibilitySm"],
        "atisVisibilityDisplay": best_obs["atisVisibilityDisplay"],
        "atisCeilingFt": best_obs["atisCeilingFt"],

        "arrRunways": arr_runways,
        "depRunways": dep_runways,
        "closedRunways": closed_runways,
        "knownMemRunways": MEM_RUNWAY_PAIRS,

        "flow": flow,

        "rcrText": rcr_data["rcrText"],
        "rcrCode": rcr_data["rcrCode"],
        "rcrSeverity": rcr_data["rcrSeverity"],
        "rcrSource": rcr_data["rcrSource"],
        "rcrVisible": rcr_data["rcrVisible"],
        "rcrRaw": rcr_data["rcrRaw"],

        "altimeter": format_altimeter(altimeter),
        "altimeterRaw": altimeter,
        "altimeterTrend": altimeter_trend,
        "altimeterTrendText": trend_text(altimeter_trend),

        "ceilingFt": ceiling_ft,
        "ceilingDisplay": format_ceiling(ceiling_ft),
        "ceilingTrend": ceiling_trend,
        "ceilingTrendText": trend_text(ceiling_trend),

        "visibilitySm": visibility_sm,
        "visibilityDisplay": best_obs.get("visibilityDisplay") or format_visibility(visibility_sm),
        "visibilityTrend": visibility_trend,
        "visibilityTrendText": trend_text(visibility_trend),

        "windRaw": wind_data["windRaw"],
        "windDisplay": wind_data["windDisplay"],
        "windDirDeg": wind_data["windDirDeg"],
        "windSpeedKt": wind_data["windSpeedKt"],
        "windGustKt": wind_data["windGustKt"],
        "windArrow": wind_data["windArrow"],
        "windArrowMeaning": wind_data["windArrowMeaning"],
        "windTrend": wind_trend_arrow,
        "windTrendText": wind_trend_text,
        "windTrendClass": wind_trend_class,

        "tempC": temp_c,
        "dewpointC": dewpoint_c,
        "tempDpDisplay": format_temp_dp(temp_c, dewpoint_c),
        "tempTrend": temp_trend,
        "tempTrendText": temp_trend_text,
        "dewpointTrend": dewpoint_trend,
        "dewpointTrendText": dewpoint_trend_text,

        "lightning": lightning_summary["lightning"],
        "lightningSeverity": lightning_summary["lightningSeverity"],
        "lightningTone": lightning_summary["lightningTone"],
        "lightningFlash": lightning_summary["lightningFlash"],
        "lightningPulse": lightning_summary["lightningPulse"],
        "lightningSource": lightning_summary["lightningSource"],
        "lightningLogText": lightning_summary["lightningLogText"],

        "wxAlerts": wx_alerts,
        "wxAlertText": wx_summary["wxAlertText"],
        "wxAlertLogText": wx_summary["wxAlertLogText"],
        "wxAlertVisible": wx_summary["wxAlertVisible"],
        "wxPrimaryAlert": wx_summary["wxPrimaryAlert"],
        "wxSecondaryAlert": wx_summary["wxSecondaryAlert"],
        "wxAlertTone": wx_summary["wxAlertTone"],
        "wxAlertFlash": wx_summary["wxAlertFlash"],
        "wxAlertPulse": wx_summary["wxAlertPulse"],

        "tafTrend": wx_summary["tafTrend"],

        "bwc": ahas_data["bwc"],
        "bwcSource": ahas_data["bwcSource"],
        "bwcUpdatedZ": ahas_data["bwcUpdatedZ"],
        "bwcNexrad": ahas_data["bwcNexrad"],
        "bwcSoarRisk": ahas_data["bwcSoarRisk"],
        "bwcBamRisk": ahas_data["bwcBamRisk"],
        "bwcAhasRisk": ahas_data["bwcAhasRisk"],
        "bwcBasedOn": ahas_data["bwcBasedOn"],
        "bwcHeight100FtAgl": ahas_data["bwcHeight100FtAgl"],
        "bwcUrl": ahas_data["bwcUrl"],
        "bwcRiskUrl": ahas_data["bwcRiskUrl"],
        "bwcFetchStatus": ahas_data["bwcFetchStatus"],

        "milNotamCount": mil_notam_data["milNotamCount"],
        "milNotamStatus": mil_notam_data["milNotamStatus"],
        "milNotamSource": mil_notam_data["milNotamSource"],
        "milNotamUpdatedZ": mil_notam_data["milNotamUpdatedZ"],
        "milNotamScrollText": mil_notam_data["milNotamScrollText"],
        "milNotams": mil_notam_data["milNotams"],
        "milNotamFetchStatus": mil_notam_data["milNotamFetchStatus"],
        "milNotamRawStatus": mil_notam_data["milNotamRawStatus"],
        "ficonNotams": mil_notam_data.get("ficonNotams", []),
        "ficonNotamCount": mil_notam_data.get("ficonNotamCount", 0),
        "runwayClosureNotams": mil_notam_data.get("runwayClosureNotams", []),
        "runwayClosureNotamCount": mil_notam_data.get("runwayClosureNotamCount", 0),
        "constructionStatusNotams": mil_notam_data.get("constructionStatusNotams", []),
        "constructionStatusNotamCount": mil_notam_data.get("constructionStatusNotamCount", 0),
        "taxiRestrictionNotams": mil_notam_data.get("taxiRestrictionNotams", []),
        "taxiRestrictionNotamCount": mil_notam_data.get("taxiRestrictionNotamCount", 0),

        "allFeedsUpdatedZ": now_z.strftime("%Y-%m-%d %H:%MZ"),

        "workflowMetadata": {
            "lastWorkflowEvent": "local_windows_task",
            "lastWorkflowActor": os.environ.get("USERNAME", "local_user"),
            "lastWorkflowName": "Local Windows KMEM Updater",
            "lastWorkflowRunNumber": "LOCAL",
            "lastWorkflowRunId": "LOCAL",
            "lastWorkflowTimestampZ": now_z.strftime("%Y-%m-%d %H:%M:%SZ")
        }
    }

    weather_path = os.path.join(REPO_DIR, "weather.json")

    snapshot_current_weather_before_overwrite(weather_path)

    try:
        with open(weather_path, "w", encoding="utf-8") as file:
            json.dump(data, file, indent=2)
    except Exception as write_error:
        print(f"ERROR: Failed to write weather.json: {write_error}")
        return

    maintain_atis_history_safely(atis_history_candidates, now_z)

    if should_save_last_good(data):
        save_last_good_weather(data)
        save_repo_last_good_weather(data, "post-write current good data")
    else:
        print("Last-known-good cache not updated because one or more primary feeds are not valid.")

    trend_sample = build_trend_sample(now_z, altimeter, visibility_sm, ceiling_ft, wind_data, temp_c, dewpoint_c)
    updated_trend_history = prune_and_append_trend_sample(trend_history, trend_sample, now_z)
    save_trend_history(updated_trend_history)

    print("weather.json updated.")
    print("DATA UPDATED:", data["allFeedsUpdatedZ"])
    print("ATIS:", data["atisLetter"], data["atisPhonetic"], "AGE:", data.get("atisAgeMinutes"), "OBS:", data.get("atisObservedZ"))
    print("OBS SOURCE:", data["obsSource"], data["obsFieldSources"])
    print("TREND REF:", data["trendReferenceSource"], data["trendReferenceTimestampZ"], "SAMPLES:", data["trendSampleCount"])
    print("ARR RWY:", data["arrRunways"])
    print("DEP RWY:", data["depRunways"])
    print("RWY CLSD:", data["closedRunways"])
    print("RSC/RCR:", data["rcrText"], "SEVERITY:", data["rcrSeverity"])
    print("ALTIMETER:", data["altimeter"], log_trend(data["altimeterTrend"]))
    print("CEILING:", data["ceilingDisplay"], log_trend(data["ceilingTrend"]))
    print("VIS:", data["visibilityDisplay"], log_trend(data["visibilityTrend"]))
    print("WIND:", data["windDisplay"], data["windArrow"], data["windTrendText"], data["windTrendClass"])
    print("TEMP/DP:", data["tempDpDisplay"], "TEMP", data["tempTrendText"], "DP", data["dewpointTrendText"])
    print(
        "BWC:",
        data["bwc"],
        "AHAS:",
        data["bwcAhasRisk"],
        "BASED ON:",
        data["bwcBasedOn"],
        "STATUS:",
        data["bwcFetchStatus"]
    )
    print("WX ALERTS:", data["wxAlertLogText"])
    print("MIL NOTAMS:", data["milNotamStatus"], "STATUS:", data["milNotamFetchStatus"], "UPDATED:", data["milNotamUpdatedZ"])
    print("RWY CLOSURE NOTAMS:", data.get("runwayClosureNotamCount", 0))
    print("AFLD STATUS NOTAMS:", "CONST", data.get("constructionStatusNotamCount", 0), "TAXI", data.get("taxiRestrictionNotamCount", 0))
    print("LIGHTNING:", data["lightning"], "SOURCE:", data["lightningSource"], "TONE:", data["lightningTone"])
    print("METAR:", data["metar"], "AGE:", data.get("metarAgeMinutes"), "OBS:", data.get("metarObservedZ"))
    print("FETCH STATUS:", "METAR", data["metarFetchStatus"], "TAF", data["tafFetchStatus"], "ATIS", data["atisFetchStatus"], "LKG", data["lastKnownGoodUsed"])
    print("Trigger:", data["workflowMetadata"]["lastWorkflowEvent"])


def download_radar_gif():
    try:
        req = urllib.request.Request(
            RADAR_GIF_URL,
            headers={"User-Agent": "KMEM-OpsBoard/1.0"}
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
        if len(data) < 1000:
            print("Radar GIF unexpectedly small, skipping save.")
            return
        with open(RADAR_GIF_PATH, "wb") as f:
            f.write(data)
        print(f"Radar GIF saved ({len(data):,} bytes).")
    except Exception as e:
        print(f"Radar GIF download failed (keeping previous): {e}")


def git_commit_and_push():
    print("Committing and pushing...")

    if os.environ.get("GITHUB_ACTIONS") == "true":
        run_cmd(["git", "config", "user.name", "github-actions[bot]"], allow_fail=True)
        run_cmd(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"], allow_fail=True)

    run_cmd(["git", "add", "weather.json"])
    if os.path.exists(ATIS_HISTORY_PATH):
        run_cmd(["git", "add", "atis_history.json"])
    if os.path.exists(TAF_CURRENT_PATH):
        run_cmd(["git", "add", "taf_current.json"])
    if os.path.exists(RADAR_GIF_PATH):
        run_cmd(["git", "add", "radar.gif"])

    diff_result = run_cmd(["git", "diff", "--cached", "--quiet"], allow_fail=True)

    if diff_result.returncode == 0:
        print("No staged changes to commit.")
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%MZ")

    commit_res = run_cmd(["git", "commit", "-m", f"KMEM weather update {timestamp}"], allow_fail=True)
    if commit_res.returncode != 0:
        print("Git commit skipped or failed.")
        return

    push_res = run_cmd(["git", "push", "origin", "main"], allow_fail=True)
    if push_res.returncode == 0:
        print("Pushed weather.json to GitHub.")
    else:
        print("Git push failed; will retry on next update cycle.")


def run_loop(interval_seconds=600):
    print(f"Starting continuous KMEM Ops Board updater (interval: {interval_seconds}s)...")
    while True:
        cycle_start = time.time()
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
        print(f"\n==================================================")
        print(f"KMEM UPDATE CYCLE START: {now_str}")
        print(f"==================================================")

        try:
            sync_repo_before_update()
            build_weather_json()
            maintain_taf_current_safely()
            download_radar_gif()
            git_commit_and_push()
            print("Update cycle complete.")
        except Exception as error:
            print("UPDATE CYCLE FAILED:", error)

        elapsed = time.time() - cycle_start
        sleep_time = max(1.0, float(interval_seconds) - elapsed)
        print(f"Sleeping {sleep_time:.1f}s until next update cycle (Press Ctrl+C to stop)...")
        try:
            time.sleep(sleep_time)
        except KeyboardInterrupt:
            print("\nContinuous updater stopped by user.")
            sys.exit(0)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="KMEM Ops Board Weather Updater")
    parser.add_argument("--daemon", "--loop", action="store_true", help="Run continuously in a background loop")
    parser.add_argument("--interval", type=int, default=600, help="Interval in seconds between update cycles (default: 600)")
    args = parser.parse_args()

    if args.daemon:
        run_loop(interval_seconds=args.interval)
    else:
        try:
            sync_repo_before_update()
            build_weather_json()
            maintain_taf_current_safely()
            download_radar_gif()
            git_commit_and_push()
            print("Local update complete.")

        except Exception as error:
            print("LOCAL UPDATE FAILED:", error)
            sys.exit(1)


if __name__ == "__main__":
    main()

