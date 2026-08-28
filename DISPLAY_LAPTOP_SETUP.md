# KMEM Ops Board — Display Laptop Setup

This package runs the board locally on a Windows display laptop, refreshes its data every 10 minutes, and can open Microsoft Edge in kiosk mode after sign-in.

The updater uses only the Python standard library. No `pip` packages are required.

## 1. Install the required software

Install these applications on the new laptop:

1. **Python 3 for Windows**  
   Download from <https://www.python.org/downloads/windows/>. During installation, enable **Add python.exe to PATH** and install the Python Launcher (`py`).
2. **Git for Windows**  
   Download from <https://git-scm.com/download/win>.
3. **GitHub CLI**  
   Download from <https://cli.github.com/>. This securely supplies Git credentials for scheduled pushes.
4. **Microsoft Edge**  
   Edge is normally included with Windows and is used for kiosk/full-screen display.

Restart Windows after installing the software so Task Scheduler receives the updated PATH.

## 2. Copy the project

Extract or copy the complete `kmem-ops-board` folder to a permanent location. A recommended location is:

```text
C:\KMEM-Ops-Board\kmem-ops-board
```

Do not move or rename the folder after installing the scheduled tasks. If it is moved later, rerun `install_display_tasks.ps1`.

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

If GitHub CLI is not authenticated, follow its normal secure browser prompt. The
installer then validates push permission, proves one controlled update and fresh
PRIMARY heartbeat, and installs the local server/PRIMARY updater/display tasks.
Wait for:

```text
KMEM PRIMARY INSTALL COMPLETE
```

GitHub authentication remains machine-local and is never included in the package.

## 6. GitHub authentication details

The updater commits `weather.json` and `radar.gif` and pushes them to GitHub Pages. Open PowerShell and run:

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

## 7. Optional manual update test

Open Command Prompt in the copied project folder and run:

```cmd
run_kmem_update.bat PRIMARY
```

Review:

```text
%LOCALAPPDATA%\KMEMOpsBoard\logs\updater.log
```

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

The installer inventories existing updater tasks first and stops without making
changes if it finds a conflicting or same-name task. Inspect any legacy task;
do not enable or repoint it implicitly. Use `-ReplaceExisting` only after an
intentional same-name replacement has been reviewed.

This creates:

| Scheduled task | Purpose |
|---|---|
| `KMEM Ops Board - Local Server` | Hosts the board at `http://localhost:8765/` after sign-in |
| `KMEM Ops Board - Weather Update` | Refreshes weather, radar, and FAA NOTAM data every 10 minutes |
| `KMEM Ops Board - Display` | Opens Edge in kiosk mode 20 seconds after sign-in |

The tasks run as the signed-in Windows user. Keep that user signed in so GitHub credentials and the display session are available.

To install the server and updater without automatically opening Edge:

```powershell
.\install_display_tasks.ps1 -SkipDisplayLaunch
```

## 9. Final display setup

1. Restart the laptop.
2. Sign in to the Windows account used during setup.
3. Wait about 20 seconds.
4. Confirm Edge opens the local board full-screen.
5. Press `F11` if normal browser full screen is preferred over kiosk mode.
6. Press `Alt+F4` to exit the kiosk display.

Useful local URLs:

```text
http://localhost:8765/
http://localhost:8765/display_control.html
http://localhost:8765/control.html
```

## Troubleshooting

### The board does not open

Run `run_kmem_server.bat` manually. If `py` is not recognized, reinstall Python with the launcher and PATH options enabled.

### The board opens but data does not refresh

Run `run_kmem_update.bat PRIMARY`, then inspect `%LOCALAPPDATA%\KMEMOpsBoard\logs\updater.log`. Also confirm internet access and `gh auth status`.

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

Inspect and remove or disable the old tasks deliberately, then run
`install_display_tasks.ps1` from the new location. The installer will not
silently replace old task paths.

## Security notes

- The FAA client secret stays only in `nms_credentials_local.bat`.
- GitHub credentials are stored by GitHub CLI/Windows Credential Manager, not in this folder.
- The local web server listens only on `127.0.0.1`, so other computers on the network cannot browse it.
- Do not copy local updater logs when they may contain operational troubleshooting data.
