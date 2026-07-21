# KMEM Ops Board

Lightweight local/GitHub Pages display board for KMEM Airfield Management situational awareness.

> **FOR REFERENCE ONLY**  
> This board is a supplemental display aid. It does not replace official ATIS, METAR/TAF, NOTAM, AHAS/BAM/BWC, NMS, GDSS, FAA, command, or locally approved operational sources.

---

## Primary URLs

### Live GitHub Pages board

```text
https://btenner1013.github.io/kmem-ops-board/
```

Cache-buster example:

```text
https://btenner1013.github.io/kmem-ops-board/?v=prod
```

### Local board test

From the repo folder:

```cmd
py -m http.server 8765
```

Open:

```text
http://localhost:8765/
```

### Display control page

```text
https://btenner1013.github.io/kmem-ops-board/display_control.html
```

Local:

```text
http://localhost:8765/display_control.html
```

---

## Production file map

### Public/tracked files

```text
index.html                         Main board display
display_control.html               Local/browser display tuning controls
control.html                       Manual/local control page
manual_alert.json                  Manual alert/default state file
weather.json                       Current board data pushed to GitHub Pages
update_weather_local.py            Main local updater
nms_kmem_mil_notams_test.py        FAA NMS staging pull/export helper
run_kmem_update.bat                Windows Task Scheduler entry point
README.md                          This file
.github/workflows/update-weather.yml
.gitignore
```

### Local/ignored files

These are intentionally **not** committed:

```text
nms_credentials_local.bat          Local NMS credentials helper
local_update_log.txt               Scheduled update log
logs/                              Local logs
nms_kmem_mil_notams_output.json    NMS helper output/debug file
weather_last_good.json             Repo-local last-good safety copy
```

---


## Manual-only lightning control

The control page is manual-only. It provides these actions:

```text
LIGHTNING WITHIN 5 NM - FLT LINE CLOSED
CLEAR MANUAL ALERT
```

There is no external weather-warning pull, no external lightning verification, and no automatic lightning closure logic in this package. The manual alert remains active until an authorized user clears it through the PIN-protected Cloudflare Worker. Do not commit PINs, tokens, cookies, GitHub tokens, NMS credentials, or local credential files.

## Automatic & Scheduled Update Flows

The board updates without requiring Windows Task Scheduler using either of the following approaches:

### Method 1: Serverless GitHub Actions Cloud Scheduler (Recommended - 24/7 Serverless)

The repository includes a GitHub Actions workflow (`.github/workflows/update-weather.yml`) configured to run automatically every 15 minutes in the cloud.

- **No local PC required:** Runs completely on GitHub's cloud runners.
- **NMS Credentials:** To enable FAA NMS MIL NOTAM pulls in GitHub Actions:
  1. Go to your GitHub Repository -> **Settings** -> **Secrets and variables** -> **Actions**.
  2. Add `NMS_CLIENT_ID` and `NMS_CLIENT_SECRET` as Repository Secrets.
- **Manual Trigger:** You can also trigger an instant update anytime from the GitHub **Actions** tab by selecting **KMEM Weather Update** -> **Run workflow**.

### Method 2: Local Continuous Daemon Script (Non-Task Scheduler)

If you prefer to run updates locally from your computer without Windows Task Scheduler:

1. Double-click `run_kmem_daemon.bat` or run:
   ```cmd
   cd /d C:\Users\btenn\Documents\KMEM-Ops-Board-Local\kmem-ops-board
   call nms_credentials_local.bat
   py update_weather_local.py --daemon
   ```
2. The process runs continuously in a background loop, executing an update every 10 minutes (or `--interval 300` for 5 minutes).
3. Stop it anytime by pressing `Ctrl + C`.

---

## Single-Pass Manual Update


From Command Prompt:

```cmd
cd /d C:\Users\btenn\Documents\KMEM-Ops-Board-Local\kmem-ops-board
call nms_credentials_local.bat
py update_weather_local.py
```

Verify:

```cmd
git status
git log --oneline -5
```

Expected:

```text
nothing to commit, working tree clean
```

---

## Manual code change workflow

Before editing code:

```cmd
cd /d C:\Users\btenn\Documents\KMEM-Ops-Board-Local\kmem-ops-board
git status
git pull --rebase origin main
```

After editing/testing:

```cmd
git add index.html display_control.html control.html update_weather_local.py nms_kmem_mil_notams_test.py run_kmem_update.bat README.md .gitignore
git commit -m "Describe change here"
git pull --rebase origin main
git push origin main
```

Then hard refresh the live board:

```text
https://btenner1013.github.io/kmem-ops-board/?v=NEW
```

or press:

```text
Ctrl + F5
```

---

## NMS / NOTAM testing

Run the NMS helper by itself:

```cmd
cd /d C:\Users\btenn\Documents\KMEM-Ops-Board-Local\kmem-ops-board
call nms_credentials_local.bat
py nms_kmem_mil_notams_test.py
```

Check for MIL, FICON, and runway closure outputs:

```cmd
findstr /i /c:"M0019" /c:"FICON" /c:"RWYCL" /c:"runwayClosureNotams" /c:"effectiveStart" /c:"effectiveEnd" nms_kmem_mil_notams_output.json
```

Expected runway closure display behavior:

```text
RWY CLOSURE NOTAMS

06/131
RWY 18R/36L CLSD
EFF 08 JUN 1300Z - 08 JUN 2200Z
```

Taxiway closures that only mention a runway as a boundary should not be listed under runway closure NOTAMs.

---

## Recovery checks

### Board looks stale

Check the local updater log:

```cmd
type local_update_log.txt
```

Run a manual update:

```cmd
call nms_credentials_local.bat
py update_weather_local.py
```

Then verify GitHub push:

```cmd
git log --oneline -5
git status
```

### GitHub Pages still shows old data

Try a cache-buster:

```text
https://btenner1013.github.io/kmem-ops-board/?v=999
```

Or hard refresh:

```text
Ctrl + F5
```

### NMS credentials issue

Check that this local file exists:

```text
nms_credentials_local.bat
```

It should remain ignored by Git. Do not commit it.

### Weather source failure

The updater should fall back to last-good data when available and label failed/stale feed states in `weather.json`.

Check:

```cmd
findstr /i /c:"FetchStatus" /c:"lastKnownGoodUsed" /c:"FAILED" /c:"USED_LAST_GOOD" weather.json
```

---

## Display notes

The board currently displays:

```text
Local/Zulu clocks
Flight category and ATIS letter
Altimeter, ceiling, visibility, wind, temperature/dewpoint
Arrival/departure runways and flow
ATIS-driven runway closure quick-look
Lightning / BWC / RCR-RCC
Compact WX alert
METAR / TAF raw text
Radar
MIL NOTAMs
Runway closure NOTAM display section
Feed status and refresh timer
```

### Runway data behavior

```text
ARR RWY / DEP RWY / FLOW: ATIS/current board logic
RWY CLSD block: existing quick-look closure logic
RWY CLOSURE NOTAMS section: display-only reference from NMS/local NOTAM scan
```

The runway closure NOTAM display does **not** automatically change ARR RWY, DEP RWY, FLOW, or the RWY CLSD data block.

### WX alert wording

Forecast/TAF items should read as possible:

```text
⛈️ -TSRA PSBL 19-23Z
⛈️ VCTS PSBL 18-24Z
🌧️ VCSH PSBL 00-06Z
```

Current METAR/ATIS hazards should read as active/current:

```text
⛈️ TSRA ACTIVE
⛈️ VCTS ACTIVE
🌧️ -RA ATIS
```

No hazard:

```text
NONE
```

---

## Production limitations

This board is useful as a visual reference, but it has limitations:

```text
Internet/source outages can delay or stale data.
ATIS relay text can vary and parsing may miss unusual phrasing.
GitHub Pages can cache old weather.json briefly.
Display controls are local/browser tuning, not operational source data.
NMS staging availability/credentials can affect NOTAM detail pulls.
```

Always verify operational decisions against official/approved sources.
