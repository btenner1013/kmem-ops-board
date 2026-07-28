[CmdletBinding()]
param(
    [string]$TaskPrefix = "KMEM Ops Board",
    [switch]$SkipDisplayLaunch
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverBat = Join-Path $projectDir "run_kmem_server.bat"
$updateBat = Join-Path $projectDir "run_kmem_update.bat"
$displayBat = Join-Path $projectDir "launch_kmem_display.bat"

foreach ($requiredFile in @($serverBat, $updateBat, $displayBat)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required file is missing: $requiredFile"
    }
}

if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
    throw "Python Launcher was not found. Install Python 3 and select 'Add python.exe to PATH', then run this installer again."
}

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git was not found. Install Git for Windows, then run this installer again."
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

$serverAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$serverBat`"`"" -WorkingDirectory $projectDir
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
Register-ScheduledTask `
    -TaskName "$TaskPrefix - Local Server" `
    -Action $serverAction `
    -Trigger $serverTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Hosts the KMEM Ops Board at http://localhost:8765/ after sign-in." `
    -Force | Out-Null

$updateAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$updateBat`"`"" -WorkingDirectory $projectDir
$updateTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)
Register-ScheduledTask `
    -TaskName "$TaskPrefix - Weather Update" `
    -Action $updateAction `
    -Trigger $updateTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Refreshes KMEM weather, radar, and FAA NMS NOTAM data every 10 minutes." `
    -Force | Out-Null

if (-not $SkipDisplayLaunch) {
    $displayAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$displayBat`"`"" -WorkingDirectory $projectDir
    $displayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $displayTrigger.Delay = "PT20S"
    Register-ScheduledTask `
        -TaskName "$TaskPrefix - Display" `
        -Action $displayAction `
        -Trigger $displayTrigger `
        -Principal $principal `
        -Settings $settings `
        -Description "Opens the local KMEM Ops Board in Microsoft Edge kiosk mode after sign-in." `
        -Force | Out-Null
}

Start-ScheduledTask -TaskName "$TaskPrefix - Local Server"
Start-ScheduledTask -TaskName "$TaskPrefix - Weather Update"

Write-Host ""
Write-Host "KMEM display tasks installed successfully." -ForegroundColor Green
Write-Host "Local board: http://localhost:8765/"
Write-Host "Updater interval: 10 minutes"
Write-Host "Task Scheduler folder: Task Scheduler Library"
Write-Host ""
Write-Host "Restart or sign out/in to test the automatic display launch."
