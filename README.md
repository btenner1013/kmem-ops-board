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

### Flight Plan Tool

```text
https://btenner1013.github.io/kmem-ops-board/flight-plan.html
```

Local:

```text
http://localhost:8765/flight-plan.html
```

The globe control on the main board opens the tool in a separate tab. Manual
entry always starts blank. DD Form 1801 imports are parsed in the browser from
AcroForm data or the embedded PDF text layer; the PDF and flight-plan data are
not uploaded or persisted. V1 has no OCR, filing, EUROCONTROL, IFPS, RAD, or
live-airspace integration. Route validation is a conservative local formatting
helper only.

The browser importer uses a locally vendored Apache-2.0 PDF.js distribution in
`vendor/pdfjs/`, so the tool remains compatible with static GitHub Pages
hosting and does not need a third-party PDF-processing service.

Run the dependency-free flight-plan tests with Node.js:

```powershell
npm run test:flight-plan
```

To include the private real-PDF integration fixture without committing it to
the public repository:

```powershell
$env:DD1801_TEST_PDF = "C:\path\to\electronic-dd1801.pdf"
npm run test:flight-plan
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
host_status.json                   Generic updater heartbeat/status
updater_lease.json                 Remote PRIMARY/BACKUP ownership lease
update_weather_local.py            Generation-only weather engine
kmem_updater.py                    Safe sync/lease/heartbeat coordinator
updater_git.py                     Fast-forward-only Git and local lock helpers
nms_kmem_mil_notams_test.py        FAA NMS staging pull/export helper
run_kmem_update.bat                Windows Task Scheduler entry point
install_updater_task.ps1           PRIMARY/BACKUP task installer
create_backup_snapshot.ps1         Validated portable recovery snapshot tool
README.md                          This file
.github/workflows/update-weather.yml
.gitignore
```

### Local/ignored files

These are intentionally **not** committed:

```text
nms_credentials_local.bat          Local NMS credentials helper
%LOCALAPPDATA%\KMEMOpsBoard\logs   Bounded rotating updater logs
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

## Scheduled update flow

Windows Task Scheduler runs every 10 minutes:

```text
run_kmem_update.bat PRIMARY
```

The wrapper and coordinator:

```text
1. Require an explicit generic PRIMARY or BACKUP role.
2. Acquire a recoverable same-host operating-system lock.
3. Verify the expected repository, main branch, and clean checkout.
4. Fetch origin/main with bounded retries and fast-forward only when strictly behind.
5. Acquire an atomic 20-minute remote lease with a normal Git push.
6. Generate approved artifacts in an isolated scratch checkout.
7. Publish host_status.json, release the lease, and push normally.
8. Fast-forward the maintained checkout to the accepted result.
```

No updater path uses pull, rebase, reset, stash, clean, force-push, or `git add .`.
A rejected lease or data push cannot leave maintained `main` ahead or dirty because
raceable commits exist only in the disposable scratch checkout.
Git commands are non-interactive and time-bounded; scratch authentication is
scrubbed before verified cleanup. A safely diagnosed dirty/ahead/diverged sync
can publish only `host_status.json`, never generated weather data.

PRIMARY is preferred. BACKUP performs only a Git fetch/status check while the
PRIMARY heartbeat is at most 15 minutes old, waits from over 15 through 25
minutes, and becomes eligible to acquire a lease only after 25 minutes. Missing
or malformed heartbeat data must be observed locally for the same grace period.
An active lease always blocks both roles. The 10-minute backend cadence is
unchanged.

After BACKUP completes, it yields a 12-minute handoff window so PRIMARY gets the
next scheduled opportunity after the lease is released. If PRIMARY does not
return, BACKUP becomes eligible again. An invalid or malformed lease fails closed
for one 20-minute local quarantine; only the same unchanged value can then be
replaced through the normal atomic push race. A parseable expired lease is
recoverable immediately. The 20-minute lease covers observed normal cycles of
roughly 80–103 seconds while the generator itself is bounded below lease expiry.

Install a role-specific task only after inspecting existing updater tasks:

```cmd
"Install Primary Updater Task.cmd"
"Install Backup Updater Task.cmd"
```

The installer stops when it finds an existing updater task. It never silently
repoints, enables, or replaces one. An intentional same-name replacement needs
the explicit `-ReplaceExisting` PowerShell switch. `KMEM Backup Update Now.cmd`
runs the same standby checks manually; `--force-failover` bypasses heartbeat
preference only and never changes Git push semantics.

For a complete display-laptop PRIMARY installation, the preferred entrypoint is:

```cmd
"INSTALL KMEM DISPLAY - PRIMARY.cmd" --check
"INSTALL KMEM DISPLAY - PRIMARY.cmd"
```

The check mode validates Python, Git, GitHub CLI, Edge, the ignored local NMS
credential file, canonical `main`, GitHub push permission when already signed in,
NMS authentication/NOTAM read access, and existing KMEM task inventory. It may
perform a bounded fetch and strict fast-forward, but it never registers, disables,
replaces, or starts a task and never runs a weather update. The full installer
uses GitHub CLI's browser login only when required, proves one controlled
lease-protected update and fresh PRIMARY heartbeat before changing tasks, installs
the server/PRIMARY updater/display tasks, and then starts the local server/display.
It never embeds GitHub credentials.

Alternatively, run the coordinator continuously without changing the 600-second cadence:

```cmd
cd /d "%USERPROFILE%\Documents\KMEM-Ops-Board-Local\kmem-ops-board"
call nms_credentials_local.bat
run_kmem_daemon.bat PRIMARY
```

The generation engine:

```text
1. Pulls/parses weather sources.
2. Runs the NMS helper for MIL NOTAM/FICON/RWY closure display data.
3. Builds weather.json.
4. Saves local and repo last-good backups when data passes quality checks.
5. Returns control to the lease-aware coordinator for scoped publication.
```

### D-ATIS source selection

The updater checks two provider families on every cycle:

- ATIS.info's direct JSON API, with DATIS Clowd retained as a mirror/endpoint fallback.
- ATIS Relay's public KMEM page, requested with a cache-busting query value.

Every parseable report is compared before selection. The newest ATIS header time wins;
when two providers publish revisions with the same header time, forward information-letter
progression (for example `Z` to `A`) wins before configured source order. A persisted
last-known-good report is also compared by its full resolved UTC timestamp so an old cached
report cannot outrank a current report merely because its `HHMMZ` value is later on the clock.
If the local, repository backup, and current `weather.json` caches disagree, the newest
persisted ATIS timestamp wins while other fields retain their normal cache priority.

`weather.json` records the selection policy, providers checked, candidate identities/times,
and selected provider in the `atisSource*`, `atisLiveCandidate*`, and `atisSelectedSource`
fields for troubleshooting.

### Host heartbeat

The board loads `host_status.json` independently from `weather.json`. Its compact
footer state is `HOST OK [PRIMARY|BACKUP]` through 15 minutes, `HOST DELAYED`
through 25 minutes, then `HOST NO HEARTBEAT`. A recent blocked sync can display
`HOST CODE SYNC BLOCKED`. Host status does not alter `DATA STALE` or any METAR,
TAF, ATIS, AHAS, or NOTAM feed classification. Published role names and status
contain no hostname, username, address, credential, token, or local path.

The first deployment still requires one manual sync and task/role setup on the
display laptop, and one initial maintained-checkout/task setup on any optional
home BACKUP. Self-update cannot install itself on a machine still running old code.

---

## Single-Pass Manual Update


From Command Prompt:

```cmd
cd /d "%USERPROFILE%\Documents\KMEM-Ops-Board-Local\kmem-ops-board"
call run_kmem_update.bat PRIMARY
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

Before editing code, require a clean checkout and inspect remote movement:

```cmd
cd /d "%USERPROFILE%\Documents\KMEM-Ops-Board-Local\kmem-ops-board"
git status
git fetch origin main
git log --oneline --left-right HEAD...origin/main
```

After editing/testing:

```cmd
git add <only the reviewed files>
git commit -m "Describe change here"
git fetch origin main
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
cd /d "%USERPROFILE%\Documents\KMEM-Ops-Board-Local\kmem-ops-board"
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

Check the bounded local updater log:

```cmd
type "%LOCALAPPDATA%\KMEMOpsBoard\logs\updater.log"
```

Run a manual update:

```cmd
call run_kmem_update.bat PRIMARY
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

### NOTAM feed freshness and runway trust

`milNotamUpdatedZ` is the last authoritative NMS check time, not an individual
NOTAM effective time. The footer and CAO use the same classifier:

```text
0-30 minutes       NOTAMS OK / green CAO
over 30-60 minutes NOTAMS WARN / yellow CAO
over 60 minutes    NOTAMS STALE / red CAO
FAILED/FAILURE/ERROR/TIMEOUT/NO_OUTPUT status       NOTAMS ERROR / red CAO
other non-current/missing/malformed/future state    NOTAMS UNAVAILABLE / gray CAO
```

Effective active and future NOTAM records remain displayed when the feed is
stale. NOTAMC action records and their cancelled targets remain hidden; NOTAMR
replacement records remain visible while their superseded targets remain
hidden. When usable ATIS is unavailable, RWY CLSD may trust a current NOTAM
feed through the 60-minute WARN boundary. STALE, ERROR, and UNAVAILABLE NOTAM
states produce `RWY CLSD UNKNOWN` rather than treating an old absence of closure
records as newly verified.

## Recovery snapshots

After a release is tested, pushed, synchronized, and clean, create a tracked-file
portable snapshot with `create_backup_snapshot.ps1`. The tool accepts only these
two exact targets:

```text
%USERPROFILE%\Desktop\KMEM Ops Board Portable
E:\KMEM-Ops-Board-Shop-Display
```

It fetches and verifies the canonical origin/main first, pins the archive to that
validated SHA, then rejects drive/Desktop roots, overlapping source/destination
trees, Git checkouts, nested checkouts, reparse-point ancestors or descendants,
and destinations referenced by Scheduled Tasks. A nonblocking per-target mutex
prevents concurrent validation/replacement races. It uses `git archive`, so
`.git`, credentials, logs, caches, uploaded PDFs, untracked local configuration,
and other development artifacts are excluded.
Replacement requires `-Replace`; validate first with `-DryRun` and pin the source
with `-ExpectedSourceSha`. Each successful copy includes
`KMEM_BACKUP_VERSION.txt` with the authoritative SHA. Replacement stages and
verifies a complete-tree SHA-256 inventory inside the approved target, preserves
the previous contents until final verification, and rolls them back on failure.
If rollback cannot be fully verified, the transaction and its journal are
retained at the exact target for inspection rather than deleting recovery data.

An old clean Git-based recovery package on the exact USB target remains blocked
by default. After verifying that it is inactive, use
`-AllowVerifiedUsbRecoveryCheckout` together with `-Replace`. That narrow override
still requires removable media, one clean canonical `main` checkout whose SHA is
an ancestor of the release, the exact legacy `site\.git` package layout, available
Scheduled Task inspection, and no task or KMEM-process reference. Both fetch and
push remotes must match the canonical repository. It is never valid for the
Desktop target.

These are recovery snapshots, not updater identities. Do not point Task Scheduler
at them. In particular, a target containing the active development checkout must
remain untouched; use a separate maintained Git checkout for an active BACKUP.

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
