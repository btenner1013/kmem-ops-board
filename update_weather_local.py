import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html import unescape
from http.cookiejar import CookieJar


# Force UTF-8 output so Windows Task Scheduler logs do not crash on arrows like → ↑ ↓.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


REPO_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_CACHE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", REPO_DIR), "KMEMOpsBoard")
REPO_LAST_GOOD_WEATHER_PATH = os.path.join(REPO_DIR, "weather_last_good.json")
LAST_GOOD_WEATHER_PATH = os.path.join(LOCAL_CACHE_DIR, "weather_last_good.json")
TREND_HISTORY_PATH = os.path.join(LOCAL_CACHE_DIR, "weather_trend_history.json")
TREND_LOOKBACK_HOURS = 3

NMS_MIL_NOTAMS_SCRIPT_PATH = os.path.join(REPO_DIR, "nms_kmem_mil_notams_test.py")
NMS_MIL_NOTAMS_OUTPUT_PATH = os.path.join(REPO_DIR, "nms_kmem_mil_notams_output.json")
NMS_MIL_NOTAMS_TIMEOUT_SECONDS = 120


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


def fetch_url(url):
    try:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0"
            }
        )

        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8", errors="ignore")

    except Exception as error:
        print(f"Fetch failed for {url}: {error}")
        return ""


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


def load_previous_weather():
    """
    Prefer the local last-known-good cache over repo weather.json.

    This prevents a weak GitHub/manual fallback weather.json from becoming the only
    backup source after git reset --hard origin/main.
    """
    cached = load_json_file(LAST_GOOD_WEATHER_PATH)

    if cached:
        print(f"Loaded last-known-good cache: {LAST_GOOD_WEATHER_PATH}")
        return cached

    repo_last_good = load_json_file(REPO_LAST_GOOD_WEATHER_PATH)

    if repo_last_good:
        print(f"Loaded repo last-known-good backup: {REPO_LAST_GOOD_WEATHER_PATH}")
        return repo_last_good

    weather_path = os.path.join(REPO_DIR, "weather.json")
    repo_weather = load_json_file(weather_path)

    if repo_weather:
        print("Loaded previous weather.json from repo.")

    return repo_weather


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


def phonetic_for_letter(letter):
    if not letter or letter == "--":
        return "--"

    return PHONETIC_ALPHABET.get(letter.upper(), letter.upper())


def parse_arr_runways(atis_text):
    txt = (atis_text or "").upper()

    patterns = [
        r"SIMUL VISUAL APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"VISUAL APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"SIMUL ILS APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"ILS APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"ILS APCH IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"APCHS IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)",
        r"APCH IN USE RY\s+(.+?)(?:\.| SIMUL| NOTICE| RWY| RY |$)"
    ]

    for pattern in patterns:
        match = re.search(pattern, txt)
        if match:
            return normalize_rwy_list(match.group(1))

    return "--"


def parse_dep_runways(atis_text):
    txt = (atis_text or "").upper()

    patterns = [
        r"DEPG RWYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPG RYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEP RWYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPARTING RWYS?\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"SIMUL DEPS IN USE RY\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPS IN USE RY\s+(.+?)(?:\.| NOTICE| RWY| RY |$)",
        r"DEPARTURES IN USE RY\s+(.+?)(?:\.| NOTICE| RWY| RY |$)"
    ]

    for pattern in patterns:
        match = re.search(pattern, txt)
        if match:
            return normalize_rwy_list(match.group(1))

    return "--"


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
            text = f"RCR/RCC {code} GOOD"
            severity = "good"
        elif lowest == 4:
            text = f"RCR/RCC {code} CAUTION"
            severity = "caution"
        else:
            text = f"RCR/RCC {code} POOR"
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
                "rcrText": f"RCR/RCC CAUTION / {label}",
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
                "rcrText": "RCR/RCC MENTIONED - REVIEW ATIS",
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
    Primary RCR/RCC source for the board.

    Uses FAA/NMS FICON NOTAM text, not ATIS, because ATIS wording varies.
    Board rule:
      - no runway FICON found: DRY
      - all runway codes are 6/6/6: DRY
      - otherwise show the worst runway code found
    """
    records = []

    for item in ficon_notams or []:
        if isinstance(item, dict):
            text = " ".join([
                str(item.get("number") or ""),
                str(item.get("text") or ""),
                str(item.get("displayText") or "")
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

    text = f"RCC {code}"
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

    if re.search(r"\b36[LCR]?\b", combined):
        return "NORTH ↑"

    if re.search(r"\b18[LCR]?\b", combined):
        return "SOUTH ↓"

    if re.search(r"\b09\b", combined):
        return "EAST →"

    if re.search(r"\b27\b", combined):
        return "WEST ←"

    return "--"


def parse_altimeter(metar):
    match = re.search(r"\bA(\d{4})\b", metar or "")

    if not match:
        return None

    raw = match.group(1)
    return int(raw) / 100.0


def parse_visibility_sm(metar):
    txt = metar or ""

    match = re.search(r"\bP?(\d{1,2})SM\b", txt)
    if match:
        return float(match.group(1))

    match = re.search(r"\b(\d+)\s+(\d+)/(\d+)SM\b", txt)
    if match:
        whole = float(match.group(1))
        numerator = float(match.group(2))
        denominator = float(match.group(3))
        return whole + numerator / denominator

    match = re.search(r"\b(\d+)/(\d+)SM\b", txt)
    if match:
        numerator = float(match.group(1))
        denominator = float(match.group(2))
        return numerator / denominator

    return None


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

def parse_atis_visibility_sm(atis_text):
    txt = atis_observation_scan_text(atis_text)

    patterns = [
        r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(P?\d{1,2})(?:\s*SM)?\b",
        r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(\d+)\s+(\d+)/(\d+)(?:\s*SM)?\b",
        r"\bVIS(?:IBILITY)?\s+(?:IS\s+)?(\d+)/(\d+)(?:\s*SM)?\b"
    ]

    whole_frac = re.search(patterns[1], txt)
    if whole_frac:
        return float(whole_frac.group(1)) + float(whole_frac.group(2)) / float(whole_frac.group(3))

    frac = re.search(patterns[2], txt)
    if frac:
        return float(frac.group(1)) / float(frac.group(2))

    whole = re.search(patterns[0], txt)
    if whole:
        token = whole.group(1).replace("P", "")
        try:
            return float(token)
        except Exception:
            return None

    # ATIS commonly includes raw METAR-style visibility in the broadcast, e.g. 10SM or P6SM.
    match = re.search(r"\bP?(\d{1,2})SM\b", txt)
    if match:
        return float(match.group(1))

    match = re.search(r"\b(\d+)\s+(\d+)/(\d+)SM\b", txt)
    if match:
        return float(match.group(1)) + float(match.group(2)) / float(match.group(3))

    match = re.search(r"\b(\d+)/(\d+)SM\b", txt)
    if match:
        return float(match.group(1)) / float(match.group(2))

    return None

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
      - Visibility: use the lower/more restrictive value; if within 1 SM, ATIS wins.
      - Ceiling: use the lower/more restrictive value; if within 500 FT, ATIS wins.
      - Temp/dewpoint: prefer ATIS when valid; METAR is backup.

    The selected values feed both the display and the trend history, so trends follow
    the value the board is actually showing regardless of source.
    """
    metar_altimeter = parse_altimeter(metar)
    metar_visibility_sm = parse_visibility_sm(metar)
    metar_ceiling_ft = parse_ceiling_ft(metar)
    metar_wind = parse_wind(metar)
    metar_temp_c, metar_dewpoint_c = parse_temp_dewpoint(metar)

    atis_available = is_good_atis(atis_text) and atis_fetch_status in {"OK", "USED_LAST_GOOD"}

    atis_obs_text = atis_observation_scan_text(atis_text) if atis_available else ""

    atis_altimeter = parse_atis_altimeter(atis_obs_text) if atis_available else None
    atis_visibility_sm = parse_atis_visibility_sm(atis_obs_text) if atis_available else None
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
        # Lower visibility is more restrictive. If almost equal, use ATIS.
        if atis_value is not None and metar_value is not None:
            if abs(float(atis_value) - float(metar_value)) <= 1.0:
                field_sources["visibility"] = "ATIS"
                return atis_value
            if float(atis_value) < float(metar_value):
                field_sources["visibility"] = "ATIS"
                return atis_value
            field_sources["visibility"] = "METAR"
            return metar_value

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
        "ceilingFt": ceiling_ft,
        "windData": wind_data,
        "tempC": temp_c,
        "dewpointC": dewpoint_c,
        "metarAltimeter": metar_altimeter,
        "metarVisibilitySm": metar_visibility_sm,
        "metarCeilingFt": metar_ceiling_ft,
        "metarWindData": metar_wind,
        "metarTempC": metar_temp_c,
        "metarDewpointC": metar_dewpoint_c,
        "atisAltimeter": atis_altimeter,
        "atisVisibilitySm": atis_visibility_sm,
        "atisCeilingFt": atis_ceiling_ft,
        "atisWindData": atis_wind,
        "atisTempC": atis_temp_c,
        "atisDewpointC": atis_dewpoint_c
    }

def parse_ceiling_ft(metar):
    txt = metar or ""
    ceilings = []

    for layer_type, height in re.findall(r"\b(BKN|OVC|VV)(\d{3})\b", txt):
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
        "squall"
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


def taf_window_display_from_token(window_token):
    token = (window_token or "").upper().strip()

    if re.match(r"^\d{4}/\d{4}$", token):
        return f"{token[2:4]}-{token[7:9]}Z"

    if re.match(r"^FM\d{6}$", token):
        return f"FM {token[4:6]}Z"

    return ""


def taf_window_sort_key(window_token, fallback_order=999):
    token = (window_token or "").upper().strip()

    if re.match(r"^\d{4}/\d{4}$", token):
        return int(token[0:2]) * 24 + int(token[2:4])

    if re.match(r"^FM\d{6}$", token):
        return int(token[2:4]) * 24 + int(token[4:6])

    return 100000 + fallback_order


def split_taf_groups_for_windows(taf):
    text = re.sub(r"\s+", " ", (taf or "").upper()).strip()

    if not text or "UNAVAILABLE" in text or "ERROR" in text or "FAILED" in text:
        return []

    groups = []
    main_valid_match = re.search(r"\b(\d{4}/\d{4})\b", text)
    main_valid = main_valid_match.group(1) if main_valid_match else ""
    markers = list(re.finditer(r"\b(FM\d{6}|TEMPO|BECMG|PROB30|PROB40)\b", text))

    if main_valid_match:
        base_start = main_valid_match.end()
        base_end = markers[0].start() if markers else len(text)
        base_text = text[base_start:base_end]
        groups.append({
            "tafGroupType": "PREVAILING",
            "tafWindowToken": main_valid,
            "tafWindow": taf_window_display_from_token(main_valid),
            "tafStartKey": taf_window_sort_key(main_valid, 0),
            "tafGroupText": base_text.strip()
        })

    for idx, marker in enumerate(markers):
        marker_text = marker.group(1)
        next_start = markers[idx + 1].start() if idx + 1 < len(markers) else len(text)
        group_text = text[marker.start():next_start].strip()
        window_token = ""

        if marker_text.startswith("FM"):
            window_token = marker_text
        else:
            window_match = re.search(r"\b(\d{4}/\d{4})\b", group_text)
            if window_match:
                window_token = window_match.group(1)
            else:
                window_token = main_valid

        groups.append({
            "tafGroupType": marker_text if not marker_text.startswith("FM") else "FM",
            "tafWindowToken": window_token,
            "tafWindow": taf_window_display_from_token(window_token),
            "tafStartKey": taf_window_sort_key(window_token, idx + 1),
            "tafGroupText": group_text
        })

    return groups


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
        "SHRA": ["RAIN SHOWERS", "SHOWERS"],
        "-SHRA": ["LIGHT RAIN SHOWERS"],
        "VCSH": ["SHOWERS VICINITY", "SHOWERS IN THE VICINITY"],
        "+DZ": ["HEAVY DRIZZLE"],
        "DZ": ["DRIZZLE"],
        "-DZ": ["LIGHT DRIZZLE"],
        "FU": ["SMOKE"],
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
        {"code": "+SHRA", "label": "HEAVY RAIN SHOWERS", "emoji": "🌦️", "category": "shower"},
        {"code": "SHRA", "label": "RAIN SHOWERS", "emoji": "🌦️", "category": "shower"},
        {"code": "-SHRA", "label": "LIGHT RAIN SHOWERS", "emoji": "🌦️", "category": "shower"},
        {"code": "VCSH", "label": "SHOWERS VICINITY", "emoji": "🌦️", "category": "shower"},
        {"code": "+DZ", "label": "HEAVY DRIZZLE", "emoji": "🌧️", "category": "drizzle"},
        {"code": "DZ", "label": "DRIZZLE", "emoji": "🌧️", "category": "drizzle"},
        {"code": "-DZ", "label": "LIGHT DRIZZLE", "emoji": "🌧️", "category": "drizzle"},

        {"code": "FU", "label": "SMOKE", "emoji": "🔥", "category": "smoke"},
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
        severity, display_tone, flash, pulse, priority = classify_alert(
            code,
            [source],
            check["category"]
        )
        text = f"{check['label']} IN {source}"
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
            "displayText": f"{check['emoji']} {text}".strip(),
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
            text = f"{check['label']} POSSIBLE {window}".strip()
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
                "tafGroupType": group.get("tafGroupType", "")
            })

    current_alerts = [
        alert for alert in alerts
        if set(alert.get("sources", [])).intersection({"ATIS", "METAR"})
    ]
    taf_alerts = [alert for alert in alerts if "TAF" in alert.get("sources", [])]

    def current_sort_key(alert):
        sources = set(alert.get("sources", []))
        source_tie = 0 if "ATIS" in sources else 1
        return (alert.get("priority", 99), source_tie)

    current_alerts.sort(key=current_sort_key)
    taf_alerts.sort(key=lambda item: (item.get("tafStartKey", 999999), item.get("priority", 99)))

    if current_alerts:
        return current_alerts[:1]

    if taf_alerts:
        return taf_alerts[:1]

    return []

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


def format_taf_window(window_token, prefix=""):
    if not window_token:
        return ""

    if re.match(r"^\d{4}/\d{4}$", window_token):
        start_hh = window_token[2:4]
        end_hh = window_token[7:9]
        return f"{start_hh}-{end_hh}Z"

    if re.match(r"^FM\d{6}$", window_token):
        hh = window_token[4:6]
        return f"FM {hh}Z"

    return ""


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

    return "METAR" in text and "KMEM" in text and re.search(r"\b\d{6}Z\b", text) is not None


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

    return parse_atis_letter(text) != "--"


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
        str(item.get("text") or ""),
        str(item.get("displayText") or ""),
        str(item.get("rawText") or ""),
        str(item.get("plainLanguage") or ""),
        str(item.get("description") or "")
    ]).strip()


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

def normalize_runway_closure_notams(raw, previous_data=None):
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

    normalized = []
    seen = set()

    for items in candidate_lists:
        if not isinstance(items, list):
            continue

        for item in items:
            if not isinstance(item, dict):
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
        return previous

    return []


def normalize_mil_notams_output(raw, fetch_status="OK"):
    raw = raw or {}
    items = raw.get("milNotams") or raw.get("items") or []

    if not isinstance(items, list):
        items = []

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

    count = raw.get("milNotamCount")

    if count is None:
        count = raw.get("count")

    try:
        count = int(count)
    except Exception:
        count = len(normalized_items)

    scroll_text = str(raw.get("milNotamScrollText") or "").strip()

    if not scroll_text:
        scroll_text = summarize_mil_notams_for_scroll(normalized_items)

    if count > 0:
        status = raw.get("milNotamStatus") or f"{count} ACTIVE"
    else:
        status = raw.get("milNotamStatus") or "NONE ACTIVE"

    return {
        "milNotamCount": count,
        "milNotamStatus": status,
        "milNotamSource": raw.get("source") or "FAA_NMS_STAGING",
        "milNotamUpdatedZ": raw.get("generatedZ") or raw.get("updated_at_z") or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"),
        "milNotamScrollText": scroll_text,
        "milNotams": normalized_items,
        "milNotamFetchStatus": fetch_status,
        "milNotamRawStatus": raw.get("status") or "UNKNOWN",
        "ficonNotams": raw.get("ficonNotams") or [],
        "ficonNotamCount": raw.get("ficonNotamCount") or len(raw.get("ficonNotams") or []),
        "runwayClosureNotams": normalize_runway_closure_notams(raw),
        "runwayClosureNotamCount": len(normalize_runway_closure_notams(raw))
    }


def previous_mil_notams_or_default(previous_data, fetch_status="NO_DATA"):
    previous_data = previous_data or {}

    if "milNotams" in previous_data or "milNotamCount" in previous_data:
        return {
            "milNotamCount": use_previous_field(previous_data, "milNotamCount", 0),
            "milNotamStatus": use_previous_field(previous_data, "milNotamStatus", "LAST KNOWN"),
            "milNotamSource": use_previous_field(previous_data, "milNotamSource", "FAA_NMS_STAGING"),
            "milNotamUpdatedZ": use_previous_field(previous_data, "milNotamUpdatedZ", "--"),
            "milNotamScrollText": use_previous_field(previous_data, "milNotamScrollText", ""),
            "milNotams": use_previous_field(previous_data, "milNotams", []),
            "milNotamFetchStatus": fetch_status,
            "milNotamRawStatus": use_previous_field(previous_data, "milNotamRawStatus", "LAST_GOOD"),
            "ficonNotams": use_previous_field(previous_data, "ficonNotams", []),
            "ficonNotamCount": use_previous_field(previous_data, "ficonNotamCount", 0),
            "runwayClosureNotams": use_previous_field(previous_data, "runwayClosureNotams", []),
            "runwayClosureNotamCount": use_previous_field(previous_data, "runwayClosureNotamCount", 0)
        }

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
        "runwayClosureNotamCount": 0
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
        and is_good_bwc(data)
    )

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

    metar_current = fetch_url(
        "https://aviationweather.gov/api/data/metar?ids=KMEM&format=raw&taf=false"
    ).strip()

    taf_current = fetch_url(
        "https://aviationweather.gov/api/data/taf?ids=KMEM&format=raw"
    ).strip()

    atis_html = fetch_url(
        "https://atisrelay.com/datis/KMEM"
    )

    atis_raw = html_to_text(atis_html)

    if len(atis_raw) < 40 or ("KMEM" not in atis_raw.upper() and "MEM" not in atis_raw.upper()):
        atis_current = "D-ATIS unavailable"
    else:
        atis_current = re.sub(r"\s+", " ", atis_raw).strip()[:1500]

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

    if is_good_atis(atis_current):
        atis_text = atis_current
    elif is_good_atis(previous_data.get("atisText", "")):
        atis_text = previous_data.get("atisText", "")
        atis_fetch_status = "USED_LAST_GOOD"
        last_known_good_used["atis"] = True
        print("D-ATIS fetch failed; using last-known-good D-ATIS.")
    else:
        atis_text = "D-ATIS unavailable"
        atis_fetch_status = "FAILED_NO_LAST_GOOD"
        print("D-ATIS fetch failed; no valid last-known-good D-ATIS available.")

    atis_letter = parse_atis_letter(atis_text)
    atis_phonetic = phonetic_for_letter(atis_letter)
    atis_display = atis_phonetic if atis_phonetic != "--" else atis_letter

    arr_runways = parse_arr_runways(atis_text)
    dep_runways = parse_dep_runways(atis_text)
    closed_runways = parse_closed_runways(atis_text)
    flow = determine_flow(arr_runways, dep_runways)
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

    wx_alerts = detect_weather_alerts(metar, taf, atis_text)
    wx_summary = summarize_weather_alerts(wx_alerts)
    lightning_summary = build_lightning_summary(metar, taf, atis_text)

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
    print("RCR/RCC:", rcr_data["rcrText"], "SOURCE:", rcr_data["rcrSource"], "SEVERITY:", rcr_data["rcrSeverity"])

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
        "metarCeilingFt": best_obs["metarCeilingFt"],
        "atisAltimeterRaw": best_obs["atisAltimeter"],
        "atisVisibilitySm": best_obs["atisVisibilitySm"],
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
        "visibilityDisplay": format_visibility(visibility_sm),
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

    with open(weather_path, "w", encoding="utf-8") as file:
        json.dump(data, file, indent=2)

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
    print("ATIS:", data["atisLetter"], data["atisPhonetic"])
    print("OBS SOURCE:", data["obsSource"], data["obsFieldSources"])
    print("TREND REF:", data["trendReferenceSource"], data["trendReferenceTimestampZ"], "SAMPLES:", data["trendSampleCount"])
    print("ARR RWY:", data["arrRunways"])
    print("DEP RWY:", data["depRunways"])
    print("RWY CLSD:", data["closedRunways"])
    print("RCR/RCC:", data["rcrText"], "SEVERITY:", data["rcrSeverity"])
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
    print("LIGHTNING:", data["lightning"], "SOURCE:", data["lightningSource"], "TONE:", data["lightningTone"])
    print("METAR:", data["metar"])
    print("FETCH STATUS:", "METAR", data["metarFetchStatus"], "TAF", data["tafFetchStatus"], "ATIS", data["atisFetchStatus"], "LKG", data["lastKnownGoodUsed"])
    print("Trigger:", data["workflowMetadata"]["lastWorkflowEvent"])


def git_commit_and_push():
    print("Committing and pushing weather.json...")

    run_cmd(["git", "add", "weather.json"])

    diff_result = run_cmd(["git", "diff", "--cached", "--quiet"], allow_fail=True)

    if diff_result.returncode == 0:
        print("No staged weather.json changes to commit.")
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%MZ")

    run_cmd(["git", "commit", "-m", f"Local KMEM weather update {timestamp}"])
    run_cmd(["git", "push", "origin", "main"])

    print("Pushed weather.json to GitHub.")


def main():
    try:
        sync_repo_before_update()
        build_weather_json()
        git_commit_and_push()
        print("Local update complete.")

    except Exception as error:
        print("LOCAL UPDATE FAILED:", error)
        sys.exit(1)


if __name__ == "__main__":
    main()