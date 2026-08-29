[CmdletBinding()]
param(
    [string]$TaskPrefix = "KMEM Ops Board",
    [switch]$EnableLocalDisplay,
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
$hiddenUpdateVbs = Join-Path $projectDir "run_kmem_update_hidden.vbs"
$hiddenUpdatePowerShell = Join-Path $projectDir "run_kmem_update_hidden.ps1"

$installLocalServer = $EnableLocalDisplay -or $SkipDisplayLaunch
$installDisplay = $EnableLocalDisplay
if ($EnableLocalDisplay -and $SkipDisplayLaunch) {
    throw "-EnableLocalDisplay and the legacy -SkipDisplayLaunch switch cannot be combined."
}
if ($SkipDisplayLaunch) {
    Write-Warning "Legacy local-server-only mode was explicitly enabled with -SkipDisplayLaunch. Hosted-only mode is now the default."
}

$requiredFiles = @($updateBat, $hiddenUpdateVbs, $hiddenUpdatePowerShell)
if ($installLocalServer) {
    $requiredFiles += $serverBat
}
if ($installDisplay) {
    $requiredFiles += $displayBat
}
foreach ($requiredFile in $requiredFiles) {
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
    "$TaskPrefix - Weather Update"
)
if ($installLocalServer) {
    $plannedTaskNames += "$TaskPrefix - Local Server"
}
if ($installDisplay) {
    $plannedTaskNames += "$TaskPrefix - Display"
}

$existingPlanned = @($plannedTaskNames | ForEach-Object {
    Get-ScheduledTask -TaskName $_ -TaskPath "\" -ErrorAction SilentlyContinue
})
if ($existingPlanned.Count -gt 0 -and -not $ReplaceExisting) {
    $names = ($existingPlanned | ForEach-Object TaskName) -join ", "
    throw "Existing task(s) found: $names. No changes were made. Inspect them, then use -ReplaceExisting only if replacement is intended."
}

$otherUpdaterTasks = @(
    Get-ScheduledTask | Where-Object {
        $task = $_
        -not ($task.TaskPath -eq "\" -and $task.TaskName -in $plannedTaskNames) -and
        @($task.Actions | Where-Object {
            $executeProperty = $_.PSObject.Properties["Execute"]
            $argumentsProperty = $_.PSObject.Properties["Arguments"]
            $executeText = if ($null -ne $executeProperty) { [string]$executeProperty.Value } else { "" }
            $argumentsText = if ($null -ne $argumentsProperty) { [string]$argumentsProperty.Value } else { "" }
            ("{0} {1}" -f $executeText, $argumentsText) -match '(?i)(run_kmem_update_hidden\.(?:vbs|ps1)|run_kmem_update\.bat|update_weather_local\.py|kmem_updater\.py)'
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
        TaskPath = "\"
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

$wscriptPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) "wscript.exe"
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    throw "Windows Script Host was not found: $wscriptPath"
}
$updateAction = New-ScheduledTaskAction `
    -Execute $wscriptPath `
    -Argument "//B //NoLogo `"$hiddenUpdateVbs`" PRIMARY" `
    -WorkingDirectory $projectDir
$updateTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($InitialUpdaterDelayMinutes)) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)
Register-KmemTask `
    -Name "$TaskPrefix - Weather Update" `
    -Action $updateAction `
    -Trigger $updateTrigger `
    -Settings $updaterSettings `
    -Description "Silently refreshes the hosted KMEM board every 10 minutes as the lease-protected PRIMARY updater."

if ($installLocalServer) {
    $serverAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$serverBat`"`"" -WorkingDirectory $projectDir
    $serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    Register-KmemTask `
        -Name "$TaskPrefix - Local Server" `
        -Action $serverAction `
        -Trigger $serverTrigger `
        -Settings $serverSettings `
        -Description "Hosts the KMEM Ops Board at http://localhost:8765/ after sign-in."

    if ($installDisplay) {
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
}

if (-not $SkipInitialStart) {
    Start-ScheduledTask -TaskName "$TaskPrefix - Weather Update" -TaskPath "\"
    if ($installLocalServer) {
        Start-ScheduledTask -TaskName "$TaskPrefix - Local Server" -TaskPath "\"
    }
}

Write-Host ""
Write-Host "KMEM PRIMARY updater task installed successfully." -ForegroundColor Green
Write-Host "Install mode: $(if ($installDisplay) { 'LOCAL DISPLAY OPT-IN' } elseif ($installLocalServer) { 'LEGACY LOCAL SERVER OPT-IN' } else { 'HOSTED-ONLY PRIMARY UPDATER' })"
Write-Host "Hosted board: https://btenner1013.github.io/kmem-ops-board/"
Write-Host "Local server task: $(if ($installLocalServer) { 'INSTALLED' } else { 'NOT INSTALLED' })"
Write-Host "Local display task: $(if ($installDisplay) { 'INSTALLED' } else { 'NOT INSTALLED' })"
Write-Host "Updater interval: 10 minutes"
Write-Host "Task Scheduler folder: Task Scheduler Library"
