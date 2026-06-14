#!/usr/bin/env python3
"""
WX alert test suite for KMEM Ops Board.
Tests: source labels, hazard ranking, TAF timing, edge cases.
Run: python test_wx_alerts.py
"""
import sys
from datetime import datetime, timezone, timedelta

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")
import update_weather_local as u

PASS = 0
FAIL = 0

def check(name, got, expected):
    global PASS, FAIL
    ok = got == expected
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        print(f"           got: {got!r}")
        print(f"      expected: {expected!r}")
        FAIL += 1
    else:
        PASS += 1

def check_contains(name, got, substring):
    ok = bool(got) and substring in got
    global PASS, FAIL
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        print(f"           got: {got!r}")
        print(f"  must contain: {substring!r}")
        FAIL += 1
    else:
        PASS += 1

def f(alerts, field="text"):
    return alerts[0].get(field) if alerts else None

# ── Dynamic time helpers ────────────────────────────────────────────────────
now = datetime.now(timezone.utc)

def ddhh(offset_hours=0):
    dt = now + timedelta(hours=offset_hours)
    return f"{dt.day:02d}{dt.hour:02d}"

# TAF issue time and 30-hour valid window
ISSUE = f"{now.day:02d}{now.hour:02d}00Z"
VSTART = ddhh(-2)   # started 2hr ago → PREVAILING is firmly active
VEND   = ddhh(28)   # 28hr valid window

def taf(*groups):
    """Build a TAF string. Each group is a raw string like 'FM141300 ...'."""
    base = f"TAF KMEM {ISSUE} {VSTART}/{VEND} {groups[0]}"
    return base + "".join(f" {g}" for g in groups[1:])

# ── Standard test inputs ────────────────────────────────────────────────────
METAR_CLEAR = f"METAR KMEM {now.day:02d}{now.hour:02d}00Z 19007KT 10SM FEW090 22/22 A2992 RMK AO2"
METAR_RA    = f"METAR KMEM {now.day:02d}{now.hour:02d}00Z 19007KT 10SM -RA FEW008 BKN090 22/22 A2992 RMK AO2"
METAR_SHRA  = f"METAR KMEM {now.day:02d}{now.hour:02d}00Z 19007KT 10SM -SHRA FEW008 BKN090 22/22 A2992 RMK AO2"
METAR_TSRA  = f"METAR KMEM {now.day:02d}{now.hour:02d}00Z 19007KT 10SM TSRA SCT040CB BKN090 22/22 A2992 RMK AO2"
METAR_FZRA  = f"METAR KMEM {now.day:02d}{now.hour:02d}00Z 19007KT 10SM FZRA BKN040 05/05 A2980 RMK AO2"

ATIS_CLEAR  = f"MEM ATIS INFO X {now.day:02d}{now.hour:02d}Z. 19007KT 10SM FEW090 22/22 A2992 RMK AO2"
ATIS_RA     = f"MEM ATIS INFO X {now.day:02d}{now.hour:02d}Z. 19007KT 10SM -RA FEW008 BKN090 22/22 A2992"
ATIS_TSRA   = f"MEM ATIS INFO X {now.day:02d}{now.hour:02d}Z. 19007KT 10SM TSRA SCT040CB BKN090 22/22 A2992"

TAF_CLEAR        = taf(f"19007KT P6SM FEW090", f"FM{ddhh(6)} 23009KT P6SM SCT040")
TAF_VCTS_ACTIVE  = taf(f"18009KT P6SM VCTS BKN045CB", f"FM{ddhh(6)} 23009KT P6SM SCT040")
TAF_SHRA_ACTIVE  = taf(f"18009KT P6SM -SHRA SCT020 BKN045", f"FM{ddhh(6)} 23009KT P6SM SCT040")
TAF_TSRA_ACTIVE  = taf(f"18009KT P6SM TSRA SCT040CB BKN090", f"FM{ddhh(6)} 23009KT P6SM SCT040")
# VCTS starting ~2hr from now (bucket=1, timing_penalty=5)
TAF_VCTS_NEAR    = taf(f"19007KT P6SM FEW090", f"FM{ddhh(2)} P6SM VCTS BKN045CB", f"FM{ddhh(8)} 23009KT P6SM SCT040")

# ── Test sections ───────────────────────────────────────────────────────────
print("=" * 62)
print("KMEM OPS BOARD — WX ALERT TEST SUITE")
print(f"Now: {now.strftime('%Y-%m-%d %H:%MZ')}")
print("=" * 62)

# 1. No hazards ──────────────────────────────────────────────────────────────
print("\n[1] No hazards — expect empty list")
check("Clear METAR + Clear TAF",         u.detect_weather_alerts(METAR_CLEAR, TAF_CLEAR), [])
check("Clear METAR + Clear TAF + ATIS",  u.detect_weather_alerts(METAR_CLEAR, TAF_CLEAR, ATIS_CLEAR), [])
check("Empty inputs",                    u.detect_weather_alerts("", "", ""), [])

# 2. Source labels ───────────────────────────────────────────────────────────
print("\n[2] Source labels")
alerts = u.detect_weather_alerts(METAR_RA, TAF_CLEAR)
check("-RA METAR only  → '-RA OBS'",   f(alerts), "-RA OBS")
check("-RA METAR only  → sources METAR", f(alerts, "sources"), ["METAR"])

alerts = u.detect_weather_alerts(METAR_RA, TAF_CLEAR, ATIS_RA)
check("-RA ATIS+METAR  → '-RA ATIS'",  f(alerts), "-RA ATIS")
check("-RA ATIS+METAR  → sources ATIS+METAR", f(alerts, "sources"), ["ATIS", "METAR"])

alerts = u.detect_weather_alerts(METAR_CLEAR, TAF_CLEAR, ATIS_RA)
check("-RA ATIS only   → '-RA ATIS'",  f(alerts), "-RA ATIS")

alerts = u.detect_weather_alerts(METAR_TSRA, TAF_CLEAR, ATIS_TSRA)
check("TSRA ATIS+METAR → 'TSRA ATIS'", f(alerts), "TSRA ATIS")

alerts = u.detect_weather_alerts(METAR_FZRA, TAF_CLEAR)
check("FZRA METAR only → 'FZRA OBS'",  f(alerts), "FZRA OBS")

# 3. TAF labels (PSBL + time window) ────────────────────────────────────────
print("\n[3] TAF labels — expect code PSBL <window>")
alerts = u.detect_weather_alerts(METAR_CLEAR, TAF_VCTS_ACTIVE)
check("VCTS active TAF → code VCTS",         f(alerts, "code"), "VCTS")
check_contains("VCTS active TAF → text PSBL", f(alerts), "PSBL")
check_contains("VCTS active TAF → text NOW",  f(alerts), "NOW")
check("VCTS active TAF → sources TAF",        f(alerts, "sources"), ["TAF"])

alerts = u.detect_weather_alerts(METAR_CLEAR, TAF_SHRA_ACTIVE)
check("-SHRA active TAF → code -SHRA",        f(alerts, "code"), "-SHRA")
check_contains("-SHRA active TAF → text PSBL", f(alerts), "PSBL")

alerts = u.detect_weather_alerts(METAR_CLEAR, TAF_TSRA_ACTIVE)
check("TSRA active TAF → code TSRA",           f(alerts, "code"), "TSRA")
check_contains("TSRA active TAF → text PSBL",  f(alerts), "PSBL")

# 4. Ranking — most restrictive wins ────────────────────────────────────────
print("\n[4] Ranking — most restrictive wins")

# High-impact TAF beats info-tier current
alerts = u.detect_weather_alerts(METAR_RA, TAF_VCTS_ACTIVE, ATIS_RA)
check("VCTS active TAF (pri=30) beats -RA current (pri=60)",
      f(alerts, "code"), "VCTS")

# VCTS near-future (bucket=1, penalty=5 → effective 35) still beats -RA (60)
alerts = u.detect_weather_alerts(METAR_RA, TAF_VCTS_NEAR, ATIS_RA)
check("VCTS near-future TAF (pri=35) beats -RA current (pri=60)",
      f(alerts, "code"), "VCTS")

# Same tier: -SHRA TAF (pri=70) loses to -RA current (pri=60)
alerts = u.detect_weather_alerts(METAR_RA, TAF_SHRA_ACTIVE, ATIS_RA)
check("-RA current (pri=60) beats -SHRA active TAF (pri=70) — same tier, observed wins",
      f(alerts, "code"), "-RA")

# High-impact current beats high-impact TAF
alerts = u.detect_weather_alerts(METAR_TSRA, TAF_VCTS_ACTIVE, ATIS_TSRA)
check("TSRA current (pri=10) beats VCTS active TAF (pri=30)",
      f(alerts, "code"), "TSRA")

# TSRA in ATIS only beats -RA in METAR (ATIS wins within current sources)
alerts = u.detect_weather_alerts(METAR_RA, TAF_CLEAR, ATIS_TSRA)
check("TSRA in ATIS (pri=10) beats -RA in METAR (pri=60)",
      f(alerts, "code"), "TSRA")

# FZRA current (pri=35 heavy precip) beats -RA current (pri=60)
alerts = u.detect_weather_alerts(METAR_FZRA, TAF_CLEAR, ATIS_RA)
check("FZRA current (pri=35) beats -RA ATIS (pri=60)",
      f(alerts, "code"), "FZRA")

# 5. Priority values ─────────────────────────────────────────────────────────
print("\n[5] Priority values")
for metar, label, expected_pri in [
    (METAR_TSRA,  "TSRA current (thunder)",      10),
    (METAR_FZRA,  "FZRA current (freezing)",     10),  # high_impact, same as thunder
    (METAR_RA,    "-RA current (info rain)",      60),
    (METAR_SHRA,  "-SHRA current (info shower)",  60),
]:
    alerts = u.detect_weather_alerts(metar, TAF_CLEAR)
    check(f"{label} priority={expected_pri}", f(alerts, "priority"), expected_pri)

# VCTS TAF priority
alerts = u.detect_weather_alerts(METAR_CLEAR, TAF_VCTS_ACTIVE)
check("VCTS TAF (high-impact forecast) priority=30", f(alerts, "priority"), 30)

# -SHRA TAF priority
alerts = u.detect_weather_alerts(METAR_CLEAR, TAF_SHRA_ACTIVE)
check("-SHRA TAF (info forecast) priority=70", f(alerts, "priority"), 70)

# 6. Display tone / flash ────────────────────────────────────────────────────
print("\n[6] Display tones")
alerts = u.detect_weather_alerts(METAR_TSRA, TAF_CLEAR, ATIS_TSRA)
check("TSRA current → tone red",   f(alerts, "displayTone"), "red")
check("TSRA current → flash True", f(alerts, "flash"),       True)

alerts = u.detect_weather_alerts(METAR_FZRA, TAF_CLEAR)
check("FZRA current → tone red (high_impact/freezing)", f(alerts, "displayTone"), "red")

alerts = u.detect_weather_alerts(METAR_RA, TAF_CLEAR, ATIS_RA)
check("-RA current → tone blue",    f(alerts, "displayTone"), "blue")

alerts = u.detect_weather_alerts(METAR_CLEAR, TAF_VCTS_ACTIVE)
check("VCTS TAF → tone yellow + pulse", f(alerts, "displayTone"), "yellow")

# ── Summary ──────────────────────────────────────────────────────────────────
print()
print("=" * 62)
print(f"RESULTS: {PASS} passed, {FAIL} failed")
print("=" * 62)
sys.exit(0 if FAIL == 0 else 1)
