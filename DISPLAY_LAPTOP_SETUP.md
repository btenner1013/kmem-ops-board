# KMEM Ops Board — Display Laptop Setup

This package installs a Windows PRIMARY updater that refreshes the hosted board
every 10 minutes. Hosted-only is the default: the installer keeps one Weather
Update task whose launcher runs hidden and does not install a localhost server
or kiosk task. Automatic localhost serving and Microsoft Edge kiosk launch
remain available as an explicit local-display opt-in.

The updater uses only the Python standard library. No `pip` packages are required.

## 1. Install the required software

Install these applications on the new laptop:

1. **Python 3 for Windows**  
   Download from <https://www.python.org/downloads/windows/>. During installation, enable **Add python.exe to PATH** and install the Python Launcher (`py`).
2. **Git for Windows**  
   Download from <https://git-scm.com/download/win>.
3. **GitHub CLI**  
   Download from <https://cli.github.com/>. This securely supplies Git credentials for scheduled pushes.
4. **Microsoft Edge (optional)**
   Edge is required only for the explicit automatic local-display/kiosk opt-in.
   Any current browser can open the hosted board.

Restart Windows after installing the software so Task Scheduler receives the updated PATH.

## 2. Copy the project

Extract or copy the complete `kmem-ops-board` folder to a permanent location. A recommended location is:

```text
C:\KMEM-Ops-Board\kmem-ops-board
```

Do not move or rename the folder after installing the scheduled task. The safe
classifier deliberately refuses to delete a task whose action still targets a
different checkout. If the folder was moved, restore the original path or
inspect and remove the old KMEM task deliberately before installing from the new
location.

## 3. Confirm the controlled credential file

The controlled ready-to-install Desktop/USB package includes the working local
`nms_credentials_local.bat`. It is ignored and untracked by Git. Do not share,
upload, email, or publicly distribute that controlled package.

A normal public Git clone intentionally does **not** include the working secret;
in that case an authorized maintainer must supply the ignored local file before
installation. Never paste the credential into support messages or commit it.

## 4. Run the installation check

From the copied permanent folder, run:

```cmd
"INSTALL KMEM DISPLAY - PRIMARY.cmd" --check
```

This validates prerequisites, the Git checkout, NMS credentials and a NOTAM read,
and inventories KMEM scheduled tasks. It may fetch/fast-forward `main`, but it does
not change Task Scheduler and does not run a weather update.

## 5. Install PRIMARY

Right-click and run as Administrator:

```cmd
"INSTALL KMEM DISPLAY - PRIMARY.cmd"
```

This is the exact hosted-only installation and reconciliation command. If the
installer lists positively identified existing KMEM tasks, review them and type
exactly `REPLACE KMEM TASKS` when prompted. It removes only recognized obsolete
KMEM local-server/display tasks and installs one
`KMEM Ops Board - Weather Update` task with a hidden/background launcher.

If GitHub CLI is not authenticated, follow its normal secure browser prompt. The
installer then validates push permission and proves one controlled update and
fresh PRIMARY heartbeat before changing tasks. Wait for:

```text
KMEM PRIMARY UPDATER INSTALL COMPLETE
```

The normal display URL is:

```text
https://btenner1013.github.io/kmem-ops-board/
```

The hosted board and its automatic browser refresh do not depend on
`run_kmem_server.bat` or any local server process.

To install the automatic localhost server and Edge kiosk tasks as well, use the
explicit opt-in instead:

```cmd
"INSTALL KMEM DISPLAY - PRIMARY.cmd" --local-display
```

GitHub authentication remains machine- and Windows-account-local and is never
included in the package.

## 6. GitHub authentication details

The updater commits `weather.json` and `radar.gif` and pushes them to GitHub
Pages. Sign in to the Windows account that will run the scheduled task, then open
PowerShell as that same account and run:

```powershell
gh auth login -h github.com
gh auth setup-git
```

Choose:

- GitHub.com
- HTTPS
- Login with a web browser

The one-click installer performs these commands only when authentication is
missing or needs configuration. To verify manually:

```powershell
gh auth status
```

The authenticated account must have write access to:

```text
https://github.com/btenner1013/kmem-ops-board
```

The scheduled task uses an interactive principal and the GitHub credentials of
that Windows account. Keep the account signed in; hosted-only mode removes the
local kiosk, but it does not turn the updater into a signed-out system service.

## 7. Optional manual update test

Open Command Prompt in the copied project folder and run:

```cmd
run_kmem_update.bat PRIMARY
```

Review:

```text
%LOCALAPPDATA%\KMEMOpsBoard\logs\updater.log
%LOCALAPPDATA%\KMEMOpsBoard\logs\scheduled-updater.log
```

`updater.log` is the primary rotating updater log. Because the scheduled launch
is hidden and shows no console window, `scheduled-updater.log` also records its
captured output, exit code, and timeout result.

Confirm the log shows:

- weather data updated
- radar GIF saved
- FAA NMS token/pull succeeded
- Git push succeeded, or there were no new staged changes
- host_status.json identifies the generic PRIMARY role
- updater_lease.json was released after publication

If the FAA credentials are wrong or missing, the board will retain previous NOTAM data when available and label the feed status accordingly.

## 8. Advanced manual task installation

Open **PowerShell as Administrator**, change to the project folder, and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install_display_tasks.ps1
```

This raw command installs only the hidden hosted-board Weather Update task. It
inventories existing updater tasks first and stops without making changes if it
finds a conflicting or same-name task. Inspect any legacy task; do not enable or
repoint it implicitly. Use `-ReplaceExisting` only after an intentional same-name
replacement has been reviewed. Prefer the one-click installer in section 5 when
existing local-server/display tasks need safe reconciliation.

This creates:

| Scheduled task | Purpose |
|---|---|
| `KMEM Ops Board - Weather Update` | Default; silently refreshes and publishes hosted weather, radar, and FAA NOTAM data every 10 minutes |
| `KMEM Ops Board - Local Server` | Local-display opt-in only; hosts `http://localhost:8765/` after sign-in |
| `KMEM Ops Board - Display` | Local-display opt-in only; opens Edge in kiosk mode after sign-in |

The tasks run as the signed-in Windows user. Keep that user signed in so its
GitHub credentials remain available.

For the raw PowerShell equivalent of the local-display opt-in, run:

```powershell
.\install_display_tasks.ps1 -EnableLocalDisplay
```

## 9. Final display setup

1. Sign in to the same Windows account used during setup and leave it signed in.
2. Confirm `KMEM Ops Board - Weather Update` is enabled in Task Scheduler.
3. Open `https://btenner1013.github.io/kmem-ops-board/` in a current browser.
4. Bookmark the hosted URL or use normal browser full-screen mode as desired.

If `--local-display` was explicitly selected, restart or sign in again, wait
about 20 seconds, and confirm Edge opens the localhost board full-screen. Press
`F11` if normal browser full screen is preferred over kiosk mode and `Alt+F4` to
exit it.

The local server is still available without installing local-display tasks. Run
`run_kmem_server.bat` manually, leave its console open, and use:

```text
http://localhost:8765/
http://localhost:8765/display_control.html
http://localhost:8765/control.html
```

## Troubleshooting

### The board does not open

For the default mode, open
`https://btenner1013.github.io/kmem-ops-board/` and verify internet access. For
an optional local session, run `run_kmem_server.bat` manually. If `py` is not
recognized, reinstall Python with the launcher and PATH options enabled.

### The board opens but data does not refresh

Run `run_kmem_update.bat PRIMARY`, then inspect both
`%LOCALAPPDATA%\KMEMOpsBoard\logs\updater.log` and
`%LOCALAPPDATA%\KMEMOpsBoard\logs\scheduled-updater.log`. Also confirm internet
access and run `gh auth status` as the same signed-in Windows account used to
install the task.

### FAA NOTAM data is missing

Run:

```cmd
call nms_credentials_local.bat
py -3 nms_kmem_mil_notams_test.py
```

Check `nms_kmem_mil_notams_output.json` and the console message. Do not send the credential file or its contents with support logs.

### Task Scheduler shows failures

Open **Task Scheduler Library**, select the corresponding `KMEM Ops Board` task, and review **Last Run Result** and the **History** tab.

### The folder was moved

Restore the original installed path first, or deliberately inspect and remove
the old KMEM task before installing from the new location. The installer treats
an action that targets a different checkout as ambiguous and will stop instead
of deleting it.

## Security notes

- The FAA client secret stays only in `nms_credentials_local.bat`.
- GitHub credentials are stored by GitHub CLI/Windows Credential Manager, not in this folder.
- When started manually or through `--local-display`, the local web server listens
  only on `127.0.0.1`, so other computers on the network cannot browse it.
- Do not copy local updater logs when they may contain operational troubleshooting data.
