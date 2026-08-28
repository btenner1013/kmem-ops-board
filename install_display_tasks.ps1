[CmdletBinding()]
param(
    [string]$TaskPrefix = "KMEM Ops Board",
    [switch]$SkipDisplayLaunch,
    [switch]$ReplaceExisting,
    [switch]$AcknowledgeExistingUpdaterTasks,
    [switch]$SkipInitialStart,
    [ValidateRange(1, 60)]
    [int]$InitialUpdaterDelayMinutes = 1
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

$plannedTaskNames = @(
    "$TaskPrefix - Local Server",
    "$TaskPrefix - Weather Update"
)
if (-not $SkipDisplayLaunch) {
    $plannedTaskNames += "$TaskPrefix - Display"
}

$existingPlanned = @($plannedTaskNames | ForEach-Object {
    Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue
})
if ($existingPlanned.Count -gt 0 -and -not $ReplaceExisting) {
    $names = ($existingPlanned | ForEach-Object TaskName) -join ", "
    throw "Existing task(s) found: $names. No changes were made. Inspect them, then use -ReplaceExisting only if replacement is intended."
}

$otherUpdaterTasks = @(
    Get-ScheduledTask | Where-Object {
        $_.TaskName -notin $plannedTaskNames -and
        @($_.Actions | Where-Object {
            ("{0} {1}" -f $_.Execute, $_.Arguments) -match '(?i)(run_kmem_update\.bat|update_weather_local\.py|kmem_updater\.py)'
        }).Count -gt 0
    }
)
if ($otherUpdaterTasks.Count -gt 0 -and -not $AcknowledgeExistingUpdaterTasks) {
    $names = ($otherUpdaterTasks | ForEach-Object TaskName) -join ", "
    throw "Other updater task(s) found: $names. Inspect them first; no changes were made."
}

function Register-KmemTask {
    param(
        [string]$Name,
        $Action,
        $Trigger,
        $Settings,
        [string]$Description
    )
    $parameters = @{
        TaskName = $Name
        Action = $Action
        Trigger = $Trigger
        Principal = $principal
        Settings = $Settings
        Description = $Description
    }
    if ($ReplaceExisting) {
        Write-Warning "Replacing explicitly approved task '$Name'."
        $parameters.Force = $true
    }
    Register-ScheduledTask @parameters | Out-Null
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$serverSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)
$updaterSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)
$displaySettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

$serverAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$serverBat`"`"" -WorkingDirectory $projectDir
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
Register-KmemTask `
    -Name "$TaskPrefix - Local Server" `
    -Action $serverAction `
    -Trigger $serverTrigger `
    -Settings $serverSettings `
    -Description "Hosts the KMEM Ops Board at http://localhost:8765/ after sign-in."

$updateAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c `"`"$updateBat`" PRIMARY`"" -WorkingDirectory $projectDir
$updateTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($InitialUpdaterDelayMinutes)) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)
Register-KmemTask `
    -Name "$TaskPrefix - Weather Update" `
    -Action $updateAction `
    -Trigger $updateTrigger `
    -Settings $updaterSettings `
    -Description "Refreshes KMEM data every 10 minutes as the lease-protected PRIMARY updater."

if (-not $SkipDisplayLaunch) {
    $displayAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$displayBat`"`"" -WorkingDirectory $projectDir
    $displayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $displayTrigger.Delay = "PT20S"
    Register-KmemTask `
        -Name "$TaskPrefix - Display" `
        -Action $displayAction `
        -Trigger $displayTrigger `
        -Settings $displaySettings `
        -Description "Opens the local KMEM Ops Board in Microsoft Edge kiosk mode after sign-in."
}

if (-not $SkipInitialStart) {
    Start-ScheduledTask -TaskName "$TaskPrefix - Local Server"
    Start-ScheduledTask -TaskName "$TaskPrefix - Weather Update"
}

Write-Host ""
Write-Host "KMEM display tasks installed successfully." -ForegroundColor Green
Write-Host "Local board: http://localhost:8765/"
Write-Host "Updater interval: 10 minutes"
Write-Host "Task Scheduler folder: Task Scheduler Library"
Write-Host ""
Write-Host "Restart or sign out/in to test the automatic display launch."
