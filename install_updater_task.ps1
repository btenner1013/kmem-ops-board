[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("PRIMARY", "BACKUP")]
    [string]$Role,

    [string]$TaskName,
    [switch]$ReplaceExisting,
    [switch]$AcknowledgeExistingUpdaterTasks,
    [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$updateBat = Join-Path $projectDir "run_kmem_update.bat"

if (-not (Test-Path -LiteralPath $updateBat -PathType Leaf)) {
    throw "Required updater entrypoint is missing: run_kmem_update.bat"
}
if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
    throw "Python Launcher was not found. Install Python 3 before installing the updater task."
}
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git was not found. Install Git for Windows before installing the updater task."
}

if (-not $TaskName) {
    $TaskName = "KMEM Ops Board - $Role Updater"
}

$updaterTasks = @(
    Get-ScheduledTask | Where-Object {
        $task = $_
        @($task.Actions) | Where-Object {
            $combined = "{0} {1}" -f $_.Execute, $_.Arguments
            $combined -match '(?i)(run_kmem_update\.bat|update_weather_local\.py|kmem_updater\.py)'
        }
    }
)

if ($updaterTasks.Count -gt 0) {
    Write-Host "Existing updater-related scheduled tasks:" -ForegroundColor Yellow
    $updaterTasks | ForEach-Object {
        Write-Host ("  {0} [{1}]" -f $_.TaskName, $_.State) -ForegroundColor Yellow
    }
    $otherTasks = @($updaterTasks | Where-Object { $_.TaskName -ne $TaskName })
    if ($otherTasks.Count -gt 0 -and -not $AcknowledgeExistingUpdaterTasks) {
        throw "Another updater task already exists. Inspect it first, then rerun with -AcknowledgeExistingUpdaterTasks only if coexistence is intentional."
    }
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $ReplaceExisting) {
    throw "Task '$TaskName' already exists. No changes were made. Use -ReplaceExisting only after inspecting it."
}
if ($existing) {
    Write-Warning "Replacing explicitly approved task '$TaskName'."
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)

$arguments = "/d /c `"`"$updateBat`" $Role`""
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $arguments -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 10)
$description = if ($Role -eq "PRIMARY") {
    "Runs the preferred KMEM updater every 10 minutes with safe self-sync and remote lease protection."
} else {
    "Checks PRIMARY health every 10 minutes and runs the KMEM updater only after safe standby takeover."
}

$registration = @{
    TaskName   = $TaskName
    Action     = $action
    Trigger    = $trigger
    Principal  = $principal
    Settings   = $settings
    Description = $description
}
if ($ReplaceExisting) {
    $registration.Force = $true
}
Register-ScheduledTask @registration | Out-Null

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
}

Write-Host "Installed '$TaskName'." -ForegroundColor Green
Write-Host "Role: $Role"
Write-Host "Cadence: 10 minutes"
Write-Host "Overlap policy: IgnoreNew"
Write-Host "Working directory: $projectDir"
