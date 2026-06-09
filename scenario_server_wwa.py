#!/usr/bin/env python3
# KMEM Ops Board private scenario server.
#
# Runs your current index.html locally and intercepts /weather.json
# with fake scenario data. It does not modify your real weather.json
# and does not push to GitHub.

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

PORT = 8765

def load_live_goes_fields():
    """
    For scenario tests, use the current GOES URLs that update_weather_local.py
    already wrote into weather.json. This prevents stale hardcoded GOES links.
    """
    defaults = {
        "goesSector": "GOES19 SMV",
        "goesSectorPage": "https://www.star.nesdis.noaa.gov/goes/sector.php?sat=G19&sector=smv&src=nav",    }

    try:
        weather_path = Path(__file__).with_name("weather.json")

        if not weather_path.exists():
            return defaults

        live = json.loads(weather_path.read_text(encoding="utf-8"))

        glm = str(live.get("goesGlmGifUrl", "")).strip()
        b13 = str(live.get("goesBand13GifUrl", "")).strip()

        if glm.startswith("https://cdn.star.nesdis.noaa.gov/GOES19/") and glm.endswith(".gif"):
            defaults["goesGlmGifUrl"] = glm

        if b13.startswith("https://cdn.star.nesdis.noaa.gov/GOES19/") and b13.endswith(".gif"):
            defaults["goesBand13GifUrl"] = b13

        defaults["goesFetchStatus"] = "SCENARIO_FROM_WEATHER_JSON"
        defaults["goesSector"] = live.get("goesSector", defaults["goesSector"])
        defaults["goesSectorPage"] = live.get("goesSectorPage", defaults["goesSectorPage"])
        return defaults

    except Exception as error:
        print("Scenario GOES load failed; using fallback GOES URLs:", error)
        return defaults


SCENARIOS = [
    "normal",
    "metar_atis_warn",
    "feed_partial_bad",
    "lightning_vcts",
    "lightning_ts_field",
    "taf_ts_window",
    "severe_ops",
    "ifr_low_ceiling",
    "atis_wind_preferred",
    "atis_more_restrictive_vis",
    "metar_more_restrictive_vis",
    "atis_more_restrictive_ceiling",
    "metar_more_restrictive_ceiling",
    "atis_ltg_dsnt_ne",
    "atis_ltg_dsnt_all_quads",
    "atis_ts_beats_taf",
    "metar_fzra_beats_taf_ts",
    "wwa_watch_only",
    "wwa_warning_auto_close",
    "wwa_warning_manual_only",
    "wwa_cancelled_last_strike_45min",
    "wwa_last_strike_expired_61min",
    "wwa_warning_and_manual_active",
]

def zstamp(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%MZ")

def iso_z(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def metar_time(dt):
    return dt.astimezone(timezone.utc).strftime("%d%H%MZ")

def atis_text(letter, dt, wind="13007KT", vis="10SM", sky="FEW250", tempdp="25/15", alt="A3015"):
    hhmm = dt.astimezone(timezone.utc).strftime("%H%M")
    return (
        f"MEM ATIS INFO {letter} {hhmm}Z. {wind} {vis} {sky} {tempdp} {alt} "
        "SIMUL VISUAL APCHS IN USE RY 18L, 18R. SIMUL DEPS IN USE RY 18C. "
        "BIRD ACTIVITY RPTD IN THE VC OF THE ARPT. ADVS YOU HAVE INFO " + letter + "."
    )

def base_weather(now):
    metar_dt = now - timedelta(minutes=18)
    atis_dt = now - timedelta(minutes=18)
    ahas_dt = now - timedelta(minutes=8)
    live_goes = load_live_goes_fields()
    taf_issue = now - timedelta(minutes=30)

    return {
        "metar": f"METAR KMEM {metar_time(metar_dt)} 13007KT 10SM FEW250 25/15 A3015 RMK AO2 SLP204 T02500150 $",
        "taf": f"TAF KMEM {metar_time(taf_issue)} 0403/0506 13006KT P6SM SCT250 \n  FM041500 15008KT P6SM SCT250",
        "atisText": atis_text("E", atis_dt),
        "atisLetter": "E",
        "atisPhonetic": "ECHO",
        "atisDisplay": "ECHO",

        "metarFetchStatus": "OK",
        "tafFetchStatus": "OK",
        "atisFetchStatus": "OK",
        "lastKnownGoodUsed": {"metar": False, "taf": False, "atis": False, "ahas": False},

        "trendLookbackHours": 3,
        "trendReferenceSource": "SCENARIO_LAB",
        "trendReferenceTimestampZ": iso_z(now - timedelta(hours=3)),
        "trendSampleCount": 12,

        "obsSource": "MIXED",
        "obsFieldSources": {
            "wind": "METAR",
            "tempDp": "ATIS",
            "altimeter": "METAR",
            "visibility": "METAR",
            "ceiling": "NONE"
        },

        "arrRunways": "18L / 18R",
        "depRunways": "18C",
        "closedRunways": "NONE",
        "flow": "SOUTH ↓",
        "rcrText": "DRY / NONE RPTD",
        "rcrCode": "--",
        "rcrSeverity": "good",
        "rcrSource": "SCENARIO",
        "rcrVisible": True,
        "rcrRaw": "--",

        "altimeter": "30.15",
        "altimeterRaw": 30.15,
        "altimeterTrend": "→",
        "altimeterTrendText": "STEADY",
        "ceilingFt": None,
        "ceilingDisplay": "UNL",
        "ceilingTrend": "→",
        "ceilingTrendText": "STEADY",
        "visibilitySm": 10.0,
        "visibilityDisplay": "10 SM",
        "visibilityTrend": "→",
        "visibilityTrendText": "STEADY",

        "windRaw": "13007KT",
        "windDisplay": "13007KT",
        "windDirDeg": 130,
        "windSpeedKt": 7,
        "windGustKt": None,
        "windArrow": "↖",
        "windArrowMeaning": "ARROW SHOWS WHERE WIND IS BLOWING TOWARD",
        "windTrend": "►",
        "windTrendText": "STEADY",
        "windTrendClass": "steady",

        "tempC": 25,
        "dewpointC": 15,
        "tempDpDisplay": "25/15",
        "tempTrend": "►",
        "tempTrendText": "STEADY",
        "dewpointTrend": "►",
        "dewpointTrendText": "STEADY",

        "lightning": "NONE",
        "lightningSeverity": "none",
        "lightningTone": "green",
        "lightningFlash": False,
        "lightningPulse": False,
        "lightningSource": "NONE",
        "lightningLogText": "Scenario: no METAR/ATIS/TAF lightning or thunder cues.",

        "wxAlerts": [],
        "wxAlertText": "NONE",
        "wxAlertLogText": "NONE",
        "wxAlertVisible": False,
        "wxPrimaryAlert": None,
        "wxSecondaryAlert": None,
        "wxAlertTone": "none",
        "wxAlertFlash": False,
        "wxAlertPulse": False,
        "tafTrend": "VFR NEXT 24 HRS",

        "afwFetchStatus": "SCENARIO",
        "afwUpdatedZ": iso_z(now),
        "afwWwaItems": [],
        "afwWwaDisplayLines": [],
        "afwWwaSourceUrl": "SCENARIO",
        "afwLightningLastStrike": None,
        "afwLightningDisplay": "",
        "afwLightningDisplayWindowMinutes": 60,
        "autoLightningClosureActive": False,
        "autoLightningClosureReason": "",
        "autoLightningClosureUpdatedZ": None,

        "goesSector": live_goes["goesSector"],
        "goesSectorPage": live_goes["goesSectorPage"],
        "bwc": "MODERATE",
        "bwcSource": "AHAS",
        "bwcUpdatedZ": ahas_dt.strftime("%Y-%m-%d %H:%M:%S.000"),
        "bwcNexrad": "MODERATE",
        "bwcSoarRisk": "LOW",
        "bwcBamRisk": "MODERATE",
        "bwcAhasRisk": "MODERATE",
        "bwcBasedOn": "NEXRAD",
        "bwcFetchStatus": "PARSED_DIRECT_XML",

        "milNotamCount": 0,
        "milNotamStatus": "PLACEHOLDER",
        "milNotamSource": "PLACEHOLDER_ONLY",
        "milNotamUpdatedZ": zstamp(now),
        "milNotamScrollText": "FAA NMS API PENDING",
        "milNotams": [],

        "allFeedsUpdatedZ": zstamp(now),
        "workflowMetadata": {
            "lastWorkflowEvent": "scenario_lab",
            "lastWorkflowActor": "local_test",
            "lastWorkflowName": "KMEM Scenario Lab",
            "lastWorkflowRunNumber": "LOCAL",
            "lastWorkflowRunId": "LOCAL",
            "lastWorkflowTimestampZ": iso_z(now)
        }
    }

def apply_wwa_watch_only(data, now):
    start = now - timedelta(minutes=20)
    end = now + timedelta(hours=2)
    data["afwFetchStatus"] = "OK"
    data["afwUpdatedZ"] = iso_z(now)
    data["afwWwaDisplayLines"] = [
        f"🟡 LTG ≤5NM WATCH {start.strftime('%H%MZ')}-{end.strftime('%H%MZ')}"
    ]
    data["afwWwaItems"] = [
        {
            "wwaType": "WATCH",
            "iwwcId": "06-006",
            "phenomGroup": "Lightning",
            "status": "OPEN",
            "startTime": iso_z(start),
            "endTime": iso_z(end)
        }
    ]
    data["autoLightningClosureActive"] = False
    data["lightning"] = "WWA LTG WATCH"
    data["lightningSeverity"] = "watch"
    data["lightningTone"] = "yellow"
    data["lightningFlash"] = False
    data["lightningPulse"] = True
    data["lightningSource"] = "AFW_WWA_SCENARIO"
    data["lightningLogText"] = "Scenario: active WWA lightning watch only. Expect WWA below TAF and no closure banner."
    return data


def apply_wwa_warning_with_strike(data, now, age_minutes=4, distance_nm=3.3, auto_close=True):
    strike_time = now - timedelta(minutes=age_minutes)
    start = now - timedelta(minutes=15)
    end = now + timedelta(minutes=45)
    data["afwFetchStatus"] = "OK"
    data["afwUpdatedZ"] = iso_z(now)
    data["afwWwaDisplayLines"] = [
        f"🔴 LTG ≤5NM WARNING {start.strftime('%H%MZ')}-{end.strftime('%H%MZ')}"
    ]
    data["afwWwaItems"] = [
        {
            "wwaType": "WARNING",
            "iwwcId": "06-007",
            "phenomGroup": "Lightning",
            "status": "OPEN",
            "startTime": iso_z(start),
            "endTime": iso_z(end)
        }
    ]
    data["afwLightningLastStrike"] = {
        "distanceNm": distance_nm,
        "minutesAgo": age_minutes,
        "observationTime": iso_z(strike_time),
        "within5Nm": distance_nm <= 5,
        "matchedCriteriaCompletely": True
    }
    data["afwLightningDisplay"] = f"⚡ {distance_nm:.1f} NM\n{age_minutes} MIN AGO"
    data["lightning"] = data["afwLightningDisplay"]
    strike_red = distance_nm <= 5 and age_minutes < 30
    data["lightningSeverity"] = "alert" if strike_red else "near"
    data["lightningTone"] = "red" if strike_red else "yellow"
    data["lightningFlash"] = strike_red
    data["lightningPulse"] = not strike_red
    data["lightningSource"] = "AFW_WWA_VERIFICATION_SCENARIO"
    data["lightningLogText"] = "Scenario: active WWA lightning warning with verified KMEM lightning strike."
    # Scenario assumes this is an active AFW lightning-within-5NM WARNING.
    # Auto closure follows the warning product, not raw strike distance.
    data["autoLightningClosureActive"] = bool(auto_close)
    data["autoLightningClosureReason"] = "AFW_ACTIVE_LIGHTNING_WITHIN_5_WARNING" if data["autoLightningClosureActive"] else ""
    data["autoLightningClosureUpdatedZ"] = iso_z(strike_time) if data["autoLightningClosureActive"] else None
    return data


def apply_cancelled_last_strike(data, now, age_minutes):
    strike_time = now - timedelta(minutes=age_minutes)
    data["afwFetchStatus"] = "OK"
    data["afwUpdatedZ"] = iso_z(now)
    data["afwWwaDisplayLines"] = []
    data["afwWwaItems"] = []
    data["autoLightningClosureActive"] = False
    data["autoLightningClosureReason"] = ""
    data["autoLightningClosureUpdatedZ"] = None

    if age_minutes <= 60:
        data["afwLightningLastStrike"] = {
            "distanceNm": 4.2,
            "minutesAgo": age_minutes,
            "observationTime": iso_z(strike_time),
            "within5Nm": True,
            "matchedCriteriaCompletely": True
        }
        data["afwLightningDisplay"] = f"⚡ 4.2 NM\n{age_minutes} MIN AGO"
        data["lightning"] = data["afwLightningDisplay"]
        data["lightningSeverity"] = "near"
        data["lightningTone"] = "yellow"
        data["lightningFlash"] = False
        data["lightningPulse"] = True
        data["lightningSource"] = "AFW_WWA_RECENT_STRIKE_SCENARIO"
        data["lightningLogText"] = "Scenario: WWA cancelled/no longer active, but last KMEM strike is still inside the 60-minute display window."
    else:
        data["afwLightningLastStrike"] = None
        data["afwLightningDisplay"] = ""
        data["lightning"] = "NONE"
        data["lightningSeverity"] = "none"
        data["lightningTone"] = "green"
        data["lightningFlash"] = False
        data["lightningPulse"] = False
        data["lightningSource"] = "NONE"
        data["lightningLogText"] = "Scenario: last KMEM strike is older than 60 minutes. Expect fallback to NONE or ATIS/METAR."
    return data


def scenario_weather(name):
    now = datetime.now(timezone.utc)
    data = base_weather(now)

    if name == "normal":
        return data

    if name == "metar_atis_warn":
        old = now - timedelta(minutes=66)
        data["metar"] = f"METAR KMEM {metar_time(old)} 13007KT 10SM FEW250 25/15 A3015 RMK AO2 SCENARIO WARN"
        data["atisText"] = atis_text("W", old)
        data["atisLetter"] = "W"
        data["atisPhonetic"] = "WHISKEY"
        data["atisDisplay"] = "WHISKEY"
        return data

    if name == "feed_partial_bad":
        data["metar"] = "METAR unavailable - SCENARIO TEST"
        data["metarFetchStatus"] = "BAD"
        return data

    if name == "lightning_vcts":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=8))} 13007KT 10SM VCTS FEW035 SCT250 25/15 A3015 RMK AO2 SCENARIO VCTS"
        data["lightning"] = "⚡ VCTS APPROX 5-10 NM"
        data["lightningSeverity"] = "near"
        data["lightningTone"] = "yellow"
        data["lightningFlash"] = False
        data["lightningPulse"] = True
        data["lightningSource"] = "METAR"
        data["lightningLogText"] = "Scenario: METAR VCTS. Expect yellow pulsing LIGHTNING box."
        return data

    if name == "lightning_ts_field":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=6))} 18012G22KT 4SM TSRA BKN025CB OVC050 24/21 A2992 RMK AO2 SCENARIO TSRA"
        data["visibilityDisplay"] = "4 SM"
        data["visibilitySm"] = 4.0
        data["visibilityTrendText"] = "DECREASING"
        data["ceilingDisplay"] = "2500 FT"
        data["ceilingFt"] = 2500
        data["ceilingTrendText"] = "LOWERING"
        data["windDisplay"] = "18012G22KT"
        data["windArrow"] = "↑"
        data["windTrendClass"] = "worsening"
        data["windTrendText"] = "INCREASING"
        data["lightning"] = "⛈️ TS OVER FIELD"
        data["lightningSeverity"] = "alert"
        data["lightningTone"] = "red"
        data["lightningFlash"] = True
        data["lightningPulse"] = False
        data["lightningSource"] = "METAR"
        data["lightningLogText"] = "Scenario: METAR TSRA. Expect red flashing LIGHTNING box."
        data["wxAlertVisible"] = True
        data["wxAlertText"] = "⛈️ TSRA ACTIVE NOW"
        data["wxAlertTone"] = "red"
        data["wxAlertFlash"] = True
        data["wxAlertPulse"] = False
        data["wxAlertLogText"] = "Scenario: active METAR thunderstorm rain."
        data["tafTrend"] = "TSRA ACTIVE NOW"
        return data

    if name == "taf_ts_window":
        data["taf"] = f"TAF KMEM {metar_time(now - timedelta(minutes=20))} 0403/0506 13006KT P6SM SCT250 \n  FM040500 15008KT P6SM SCT250 \n  TEMPO 0418/0422 4SM TSRA BKN030CB"
        # Future TAF thunder should NOT populate the current LIGHTNING box.
        # It should show in WX ALERT / TAF TREND only.
        data["lightning"] = "NONE"
        data["lightningSeverity"] = "none"
        data["lightningTone"] = "green"
        data["lightningFlash"] = False
        data["lightningPulse"] = False
        data["lightningSource"] = "NONE"
        data["lightningLogText"] = "Scenario: TAF thunderstorm window. Current LIGHTNING remains NONE; future risk appears in WX ALERT."
        data["wxAlertVisible"] = True
        data["wxAlertText"] = "⛈️ TS POSSIBLE 18-22Z"
        data["wxAlertTone"] = "yellow"
        data["wxAlertFlash"] = False
        data["wxAlertPulse"] = True
        data["wxAlertLogText"] = "Scenario: future TAF thunderstorm hazard with valid window."
        data["tafTrend"] = "⛈️ TS POSSIBLE 18-22Z"
        return data

    if name == "atis_wind_preferred":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=10))} 18005KT 10SM FEW250 25/15 A3015 RMK AO2 SCENARIO METAR WIND"
        data["atisText"] = atis_text("A", now - timedelta(minutes=9), wind="21012G20KT", vis="10SM", sky="FEW250", tempdp="25/15", alt="A3015")
        data["atisLetter"] = "A"
        data["atisPhonetic"] = "ALFA"
        data["atisDisplay"] = "ALFA"
        data["obsFieldSources"]["wind"] = "ATIS"
        data["windRaw"] = "21012G20KT"
        data["windDisplay"] = "21012G20KT"
        data["windDirDeg"] = 210
        data["windSpeedKt"] = 12
        data["windGustKt"] = 20
        data["windArrow"] = "↗"
        data["windTrendText"] = "INCREASING"
        data["windTrendClass"] = "worsening"
        return data

    if name == "atis_more_restrictive_vis":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=10))} 18005KT 10SM SCT250 25/15 A3015 RMK AO2 SCENARIO METAR VFR"
        data["atisText"] = atis_text("B", now - timedelta(minutes=9), wind="18005KT", vis="VIS 5SM", sky="SCT250", tempdp="25/15", alt="A3015")
        data["atisLetter"] = "B"
        data["atisPhonetic"] = "BRAVO"
        data["atisDisplay"] = "BRAVO"
        data["obsFieldSources"]["visibility"] = "ATIS"
        data["visibilitySm"] = 5.0
        data["visibilityDisplay"] = "5 SM"
        data["tafTrend"] = "ATIS VIS MORE RESTRICTIVE"
        return data

    if name == "metar_more_restrictive_vis":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=10))} 18005KT 2SM SCT250 25/15 A3015 RMK AO2 SCENARIO METAR IFR VIS"
        data["atisText"] = atis_text("C", now - timedelta(minutes=9), wind="18005KT", vis="VIS 10SM", sky="SCT250", tempdp="25/15", alt="A3015")
        data["atisLetter"] = "C"
        data["atisPhonetic"] = "CHARLIE"
        data["atisDisplay"] = "CHARLIE"
        data["obsFieldSources"]["visibility"] = "METAR"
        data["visibilitySm"] = 2.0
        data["visibilityDisplay"] = "2 SM"
        data["tafTrend"] = "METAR VIS MORE RESTRICTIVE"
        return data

    if name == "atis_more_restrictive_ceiling":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=10))} 18005KT 10SM SCT250 25/15 A3015 RMK AO2 SCENARIO METAR VFR"
        data["atisText"] = atis_text("D", now - timedelta(minutes=9), wind="18005KT", vis="10SM", sky="OVC020", tempdp="25/15", alt="A3015")
        data["atisLetter"] = "D"
        data["atisPhonetic"] = "DELTA"
        data["atisDisplay"] = "DELTA"
        data["obsFieldSources"]["ceiling"] = "ATIS"
        data["ceilingFt"] = 2000
        data["ceilingDisplay"] = "2000 FT"
        data["tafTrend"] = "ATIS CEILING MORE RESTRICTIVE"
        return data

    if name == "metar_more_restrictive_ceiling":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=10))} 18005KT 10SM OVC006 25/15 A3015 RMK AO2 SCENARIO METAR IFR CEILING"
        data["atisText"] = atis_text("F", now - timedelta(minutes=9), wind="18005KT", vis="10SM", sky="BKN250", tempdp="25/15", alt="A3015")
        data["atisLetter"] = "F"
        data["atisPhonetic"] = "FOXTROT"
        data["atisDisplay"] = "FOXTROT"
        data["obsFieldSources"]["ceiling"] = "METAR"
        data["ceilingFt"] = 600
        data["ceilingDisplay"] = "600 FT"
        data["tafTrend"] = "METAR CEILING MORE RESTRICTIVE"
        return data

    if name == "atis_ltg_dsnt_ne":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=8))} 18005KT 10SM FEW250 25/15 A3015 RMK AO2 SCENARIO METAR CLEAN"
        data["atisText"] = atis_text("G", now - timedelta(minutes=7)) + " LTG DSNT NE."
        data["atisLetter"] = "G"
        data["atisPhonetic"] = "GOLF"
        data["atisDisplay"] = "GOLF"
        data["lightning"] = "⚡ DSNT NE 10-30 NM"
        data["lightningSeverity"] = "distant"
        data["lightningTone"] = "yellow"
        data["lightningFlash"] = False
        data["lightningPulse"] = True
        data["lightningSource"] = "ATIS"
        data["lightningLogText"] = "Scenario: ATIS LTG DSNT NE. Expect yellow pulsing LIGHTNING box."
        return data

    if name == "atis_ltg_dsnt_all_quads":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=8))} 18005KT 10SM FEW250 25/15 A3015 RMK AO2 SCENARIO METAR CLEAN"
        data["atisText"] = atis_text("H", now - timedelta(minutes=7)) + " LTG DSNT ALL QUADRANTS."
        data["atisLetter"] = "H"
        data["atisPhonetic"] = "HOTEL"
        data["atisDisplay"] = "HOTEL"
        data["lightning"] = "⚡ DSNT ALL QUADS 10-30 NM"
        data["lightningSeverity"] = "distant"
        data["lightningTone"] = "yellow"
        data["lightningFlash"] = False
        data["lightningPulse"] = True
        data["lightningSource"] = "ATIS"
        data["lightningLogText"] = "Scenario: ATIS LTG DSNT all quadrants. Expect yellow pulsing LIGHTNING box."
        return data

    if name == "atis_ts_beats_taf":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=8))} 18005KT 10SM FEW250 25/15 A3015 RMK AO2 SCENARIO METAR CLEAN"
        data["atisText"] = atis_text("I", now - timedelta(minutes=7)) + " THUNDERSTORM OVER FIELD."
        data["atisLetter"] = "I"
        data["atisPhonetic"] = "INDIA"
        data["atisDisplay"] = "INDIA"
        data["taf"] = f"TAF KMEM {metar_time(now - timedelta(minutes=20))} 0403/0506 13006KT P6SM SCT250 TEMPO 0418/0422 4SM TSRA BKN030CB"
        data["lightning"] = "⛈️ TS OVER FIELD"
        data["lightningSeverity"] = "active_field"
        data["lightningTone"] = "red"
        data["lightningFlash"] = True
        data["lightningPulse"] = False
        data["lightningSource"] = "ATIS"
        data["wxAlertVisible"] = True
        data["wxAlertText"] = "⛈️ THUNDERSTORM RAIN IN ATIS"
        data["wxAlertTone"] = "red"
        data["wxAlertFlash"] = True
        data["wxAlertPulse"] = False
        data["tafTrend"] = "WX ALERT | ⛈️ THUNDERSTORM RAIN IN ATIS"
        return data

    if name == "metar_fzra_beats_taf_ts":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=8))} 18005KT 3SM FZRA OVC008 01/M01 A3001 RMK AO2 SCENARIO FZRA"
        data["atisText"] = atis_text("J", now - timedelta(minutes=7), wind="18005KT", vis="10SM", sky="BKN250", tempdp="02/M01", alt="A3001")
        data["atisLetter"] = "J"
        data["atisPhonetic"] = "JULIETT"
        data["atisDisplay"] = "JULIETT"
        data["taf"] = f"TAF KMEM {metar_time(now - timedelta(minutes=20))} 0403/0506 13006KT P6SM SCT250 TEMPO 0418/0422 4SM TSRA BKN030CB"
        data["visibilitySm"] = 3.0
        data["visibilityDisplay"] = "3 SM"
        data["ceilingFt"] = 800
        data["ceilingDisplay"] = "800 FT"
        data["wxAlertVisible"] = True
        data["wxAlertText"] = "🧊 FREEZING RAIN IN METAR"
        data["wxAlertTone"] = "red"
        data["wxAlertFlash"] = True
        data["wxAlertPulse"] = False
        data["tafTrend"] = "WX ALERT | 🧊 FREEZING RAIN IN METAR"
        return data

    if name == "severe_ops":
        data["closedRunways"] = "9 / 27"
        data["rcrText"] = "3 / 3 / 3 WET"
        data["rcrCode"] = "3/3/3"
        data["rcrSeverity"] = "poor"
        data["bwc"] = "SEVERE"
        data["bwcNexrad"] = "SEVERE"
        data["bwcAhasRisk"] = "SEVERE"
        data["bwcBamRisk"] = "SEVERE"
        data["bwcUpdatedZ"] = (now - timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S.000")
        data["wxAlertVisible"] = True
        data["wxAlertText"] = "⚠️ OPS HAZARD TEST"
        data["wxAlertTone"] = "red"
        data["wxAlertFlash"] = True
        data["wxAlertPulse"] = False
        data["wxAlertLogText"] = "Scenario: BWC severe, closed runway, poor RCR. Expect multiple red flashing boxes."
        return data

    if name == "ifr_low_ceiling":
        data["metar"] = f"METAR KMEM {metar_time(now - timedelta(minutes=12))} 09008KT 2SM BR OVC006 18/17 A3002 RMK AO2 SCENARIO IFR"
        data["visibilityDisplay"] = "2 SM"
        data["visibilitySm"] = 2.0
        data["visibilityTrendText"] = "DECREASING"
        data["ceilingDisplay"] = "600 FT"
        data["ceilingFt"] = 600
        data["ceilingTrendText"] = "LOWERING"
        data["tafTrend"] = "IFR EXPECTED"
        return data


    if name == "wwa_watch_only":
        # Expected: WWA appears below TAF with 🟡. No flight-line-closed overlay.
        return apply_wwa_watch_only(data, now)

    if name == "wwa_warning_auto_close":
        # Expected: WWA appears below TAF with 🔴, LIGHTNING box shows x NM / x MIN AGO,
        # and auto closure overlay appears if manual_alert.json has auto mode enabled.
        return apply_wwa_warning_with_strike(data, now, age_minutes=4, distance_nm=3.3, auto_close=True)

    if name == "wwa_warning_manual_only":
        # Expected: WWA and LIGHTNING box show, but no auto closure overlay if manual_alert.json is set to MANUAL_ONLY.
        # This scenario still sets autoLightningClosureActive true; the board should suppress it when the control file says manual only.
        return apply_wwa_warning_with_strike(data, now, age_minutes=8, distance_nm=4.8, auto_close=True)

    if name == "wwa_cancelled_last_strike_45min":
        # Expected: no WWA below TAF and no auto closure overlay, but LIGHTNING box keeps last strike for awareness.
        return apply_cancelled_last_strike(data, now, age_minutes=45)

    if name == "wwa_last_strike_expired_61min":
        # Expected: no WWA below TAF, no auto closure overlay, LIGHTNING falls back to NONE.
        return apply_cancelled_last_strike(data, now, age_minutes=61)

    if name == "wwa_warning_and_manual_active":
        # Expected: same weather as auto closure. To verify manual trumps auto, separately activate manual alert.
        return apply_wwa_warning_with_strike(data, now, age_minutes=2, distance_nm=2.1, auto_close=True)


    raise ValueError("Unknown scenario: " + name)

class ScenarioHandler(SimpleHTTPRequestHandler):
    selected_scenario = "normal"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path in ("/weather.json", "/weather"):
            payload = scenario_weather(self.selected_scenario)
            body = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/scenarios":
            body = ("\n".join(SCENARIOS) + "\n").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path in ("", "/"):
            self.path = "/index.html"

        return super().do_GET()

def main():
    parser = argparse.ArgumentParser(description="Private KMEM Ops Board scenario server")
    parser.add_argument("scenario", choices=SCENARIOS, nargs="?", default="normal")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    if not Path("index.html").exists():
        print("ERROR: Run this from your kmem-ops-board repo folder where index.html exists.")
        sys.exit(1)

    ScenarioHandler.selected_scenario = args.scenario

    print()
    print("KMEM Ops Board private scenario server")
    print("--------------------------------------")
    print("Scenario:", args.scenario)
    print(f"URL:      http://localhost:{args.port}")
    print()
    print("Available scenarios:")
    for s in SCENARIOS:
        print(" ", s)
    print()
    print("Switch scenario: Ctrl+C, then rerun with another scenario name.")
    print("This server does NOT modify weather.json and does NOT push to GitHub.")
    print()

    httpd = ThreadingHTTPServer(("localhost", args.port), ScenarioHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")

if __name__ == "__main__":
    main()
