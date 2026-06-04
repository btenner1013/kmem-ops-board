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


def load_previous_weather():
    weather_path = os.path.join(REPO_DIR, "weather.json")

    try:
        with open(weather_path, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return {}


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
        if "METAR" in source_set:
            return "active", "red", True, False, 10
        return "forecast", "yellow", False, True, 30

    if code in heavy_precip_codes:
        if "METAR" in source_set:
            return "active", "yellow", False, True, 35
        return "forecast", "yellow", False, True, 40

    if category == "snow":
        if "METAR" in source_set:
            return "active", "yellow", False, True, 35
        return "forecast", "yellow", False, True, 45

    if category == "fog":
        if code == "FZFG":
            if "METAR" in source_set:
                return "active", "red", True, False, 15
            return "forecast", "yellow", False, True, 30

        if "METAR" in source_set:
            return "active", "yellow", False, True, 40
        return "forecast", "yellow", False, True, 50

    if category in info_categories:
        if "METAR" in source_set:
            return "info", "blue", False, False, 60
        return "forecast_info", "blue", False, False, 70

    if "METAR" in source_set:
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


def detect_weather_alerts(metar, taf):
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

    sources = [
        ("METAR", metar or ""),
        ("TAF", taf or "")
    ]

    alerts = []
    seen_codes = set()

    for check in checks:
        code = check["code"]
        found_sources = []

        for source_name, source_text in sources:
            if weather_code_present(source_text, code):
                found_sources.append(source_name)

        if found_sources and code not in seen_codes:
            seen_codes.add(code)

            severity, display_tone, flash, pulse, priority = classify_alert(
                code,
                found_sources,
                check["category"]
            )

            text = alert_text_for(check["label"], found_sources)
            display_text = f"{check['emoji']} {text}".strip()

            alerts.append({
                "code": code,
                "label": check["label"],
                "emoji": check["emoji"],
                "category": check["category"],
                "sources": found_sources,
                "severity": severity,
                "displayTone": display_tone,
                "flash": flash,
                "pulse": pulse,
                "priority": priority,
                "text": text,
                "displayText": display_text
            })

    alerts.sort(key=lambda item: item.get("priority", 99))

    return alerts


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
    secondary = alerts[1] if len(alerts) > 1 else None

    display_parts = [primary["displayText"]]

    if secondary:
        display_parts.append(f"NEXT: {secondary['displayText']}")

    wx_alert_text = " | ".join(display_parts)
    wx_alert_log_text = " | ".join(
        alert["text"] for alert in alerts[:3]
    )

    return {
        "wxAlertText": wx_alert_text,
        "wxAlertLogText": wx_alert_log_text,
        "wxAlertVisible": True,
        "wxPrimaryAlert": primary,
        "wxSecondaryAlert": secondary,
        "wxAlertTone": primary.get("displayTone", "yellow"),
        "wxAlertFlash": bool(primary.get("flash", False)),
        "wxAlertPulse": bool(primary.get("pulse", False)),
        "tafTrend": f"WX ALERT | {wx_alert_text}"
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
    print("Syncing local repo before update...")

    run_cmd(["git", "fetch", "origin"], allow_fail=True)
    run_cmd(["git", "reset", "--hard", "origin/main"])


def build_weather_json():
    print("Fetching KMEM weather data...")

    previous_data = load_previous_weather()

    metar = fetch_url(
        "https://aviationweather.gov/api/data/metar?ids=KMEM&format=raw&taf=false"
    ).strip()

    taf = fetch_url(
        "https://aviationweather.gov/api/data/taf?ids=KMEM&format=raw"
    ).strip()

    atis_html = fetch_url(
        "https://atisrelay.com/datis/KMEM"
    )

    atis_raw = html_to_text(atis_html)

    if len(atis_raw) < 40 or ("KMEM" not in atis_raw.upper() and "MEM" not in atis_raw.upper()):
        atis_text = "D-ATIS unavailable"
    else:
        atis_text = re.sub(r"\s+", " ", atis_raw).strip()[:1500]

    atis_letter = parse_atis_letter(atis_text)
    atis_phonetic = phonetic_for_letter(atis_letter)
    atis_display = atis_phonetic if atis_phonetic != "--" else atis_letter

    arr_runways = parse_arr_runways(atis_text)
    dep_runways = parse_dep_runways(atis_text)
    closed_runways = parse_closed_runways(atis_text)
    flow = determine_flow(arr_runways, dep_runways)
    rcr_data = parse_rcr_rcc(atis_text)

    altimeter = parse_altimeter(metar)
    visibility_sm = parse_visibility_sm(metar)
    ceiling_ft = parse_ceiling_ft(metar)

    previous_altimeter = parse_previous_numeric(previous_data, "altimeterRaw", parse_altimeter)
    previous_visibility_sm = parse_previous_numeric(previous_data, "visibilitySm", parse_visibility_sm)
    previous_ceiling_ft = parse_previous_numeric(previous_data, "ceilingFt", parse_ceiling_ft)

    wind_data = parse_wind(metar)
    temp_c, dewpoint_c = parse_temp_dewpoint(metar)

    previous_wind_speed = parse_previous_numeric(previous_data, "windSpeedKt")
    previous_wind_gust = parse_previous_numeric(previous_data, "windGustKt")
    previous_temp_c = parse_previous_numeric(previous_data, "tempC")
    previous_dewpoint_c = parse_previous_numeric(previous_data, "dewpointC")

    wind_trend_arrow, wind_trend_text, wind_trend_class = wind_trend(
        wind_data["windSpeedKt"],
        wind_data["windGustKt"],
        previous_wind_speed,
        previous_wind_gust
    )

    temp_trend, temp_trend_text = numeric_trend_with_threshold(temp_c, previous_temp_c, 1.0)
    dewpoint_trend, dewpoint_trend_text = numeric_trend_with_threshold(dewpoint_c, previous_dewpoint_c, 1.0)

    altimeter_trend = trend_symbol(altimeter, previous_altimeter)
    visibility_trend = trend_symbol(visibility_sm, previous_visibility_sm)
    ceiling_trend = trend_symbol(ceiling_ft, previous_ceiling_ft)

    wx_alerts = detect_weather_alerts(metar, taf)
    wx_summary = summarize_weather_alerts(wx_alerts)

    now_z = datetime.now(timezone.utc)
    ahas_data = fetch_ahas_bwc(now_z)

    data = {
        "metar": metar or "METAR unavailable",
        "taf": taf or "TAF unavailable",
        "atisText": atis_text,

        "atisLetter": atis_letter,
        "atisPhonetic": atis_phonetic,
        "atisDisplay": atis_display,

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

        "lightning": "NONE",

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

    with open(weather_path, "w", encoding="utf-8") as file:
        json.dump(data, file, indent=2)

    print("weather.json updated.")
    print("DATA UPDATED:", data["allFeedsUpdatedZ"])
    print("ATIS:", data["atisLetter"], data["atisPhonetic"])
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
    print("METAR:", data["metar"])
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