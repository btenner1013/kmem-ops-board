$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installerPath = Join-Path $PSScriptRoot "install_updater_task.ps1"
$global:KMEM_TEST_REGISTRATIONS = @()
$global:KMEM_TEST_PASSED = 0

function Assert-Condition([string]$Name, [bool]$Condition) {
    if (-not $Condition) {
        throw "$Name failed"
    }
    $global:KMEM_TEST_PASSED += 1
}

function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    if ($Name -in @("py.exe", "git.exe")) {
        return [pscustomobject]@{ Name = $Name }
    }
    return Microsoft.PowerShell.Core\Get-Command -Name $Name
}

function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    return @()
}

function New-ScheduledTaskPrincipal {
    [CmdletBinding()]
    param([string]$UserId, [string]$LogonType, [string]$RunLevel)
    return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}

function New-ScheduledTaskSettingsSet {
    [CmdletBinding()]
    param(
        [switch]$AllowStartIfOnBatteries,
        [switch]$DontStopIfGoingOnBatteries,
        [switch]$StartWhenAvailable,
        [timespan]$ExecutionTimeLimit,
        [string]$MultipleInstances,
        [int]$RestartCount,
        [timespan]$RestartInterval,
        [bool]$WakeToRun
    )
    return [pscustomobject]@{
        StartWhenAvailable = $StartWhenAvailable.IsPresent
        MultipleInstances = $MultipleInstances
        RestartCount = $RestartCount
        RestartInterval = $RestartInterval
        WakeToRun = $WakeToRun
    }
}

function New-ScheduledTaskAction {
    [CmdletBinding()]
    param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
    return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}

function New-ScheduledTaskTrigger {
    [CmdletBinding()]
    param(
        [switch]$Once,
        [datetime]$At,
        [timespan]$RepetitionInterval,
        [switch]$AtLogOn,
        [string]$User
    )
    return [pscustomobject]@{
        Once = $Once.IsPresent
        RepetitionInterval = $RepetitionInterval
        AtLogOn = $AtLogOn.IsPresent
        User = $User
    }
}

function Register-ScheduledTask {
    [CmdletBinding()]
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$Action,
        [object[]]$Trigger,
        [object]$Principal,
        [object]$Settings,
        [string]$Description,
        [switch]$Force
    )
    $global:KMEM_TEST_REGISTRATIONS += [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Action = $Action
        Triggers = @($Trigger)
        Principal = $Principal
        Settings = $Settings
        Description = $Description
        Force = $Force.IsPresent
    }
}

function Start-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
}

try {
    & $installerPath -Role PRIMARY -TaskName "TEST PRIMARY" | Out-Null
    & $installerPath -Role BACKUP -TaskName "TEST BACKUP" | Out-Null

    $primary = $global:KMEM_TEST_REGISTRATIONS | Where-Object TaskName -eq "TEST PRIMARY" | Select-Object -First 1
    $backup = $global:KMEM_TEST_REGISTRATIONS | Where-Object TaskName -eq "TEST BACKUP" | Select-Object -First 1

    Assert-Condition "PRIMARY registration captured" ($null -ne $primary)
    Assert-Condition "PRIMARY retains ten-minute cadence" ($primary.Triggers.Count -eq 1 -and $primary.Triggers[0].RepetitionInterval.TotalMinutes -eq 10)
    Assert-Condition "PRIMARY does not wake by default" (-not $primary.Settings.WakeToRun)
    Assert-Condition "BACKUP registration captured" ($null -ne $backup)
    Assert-Condition "BACKUP checks every five minutes" ($backup.Triggers[0].RepetitionInterval.TotalMinutes -eq 5)
    Assert-Condition "BACKUP has one repeating and one sign-in trigger" ($backup.Triggers.Count -eq 2)
    Assert-Condition "BACKUP sign-in trigger enabled" ($backup.Triggers[1].AtLogOn)
    Assert-Condition "BACKUP wake-to-run enabled" ($backup.Settings.WakeToRun)
    Assert-Condition "BACKUP preserves IgnoreNew" ($backup.Settings.MultipleInstances -eq "IgnoreNew")
    Assert-Condition "BACKUP preserves restart attempts" ($backup.Settings.RestartCount -eq 2 -and $backup.Settings.RestartInterval.TotalMinutes -eq 2)
    Assert-Condition "BACKUP remains interactive user scoped" ($backup.Principal.LogonType -eq "Interactive")

    Write-Output "UPDATER TASK REGISTRATION TESTS: $global:KMEM_TEST_PASSED passed, 0 failed"
} finally {
    Remove-Variable -Name KMEM_TEST_REGISTRATIONS -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name KMEM_TEST_PASSED -Scope Global -ErrorAction SilentlyContinue
}
