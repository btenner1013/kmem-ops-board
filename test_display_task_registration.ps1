$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installerPath = Join-Path $PSScriptRoot "install_display_tasks.ps1"
$global:KmemTestRegisteredTasks = @()
$global:KmemTestInventoryTasks = @()
$script:passed = 0

function Assert-Condition([string]$Name, [bool]$Condition) {
    if (-not $Condition) {
        throw "$Name failed"
    }
    $script:passed += 1
}

function Get-Command {
    param([string]$Name, $ErrorAction)
    return [pscustomobject]@{ Name = $Name }
}

function Get-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath, $ErrorAction)
    if ($TaskName) {
        return @($global:KmemTestInventoryTasks | Where-Object {
            $_.TaskName -eq $TaskName -and (-not $TaskPath -or $_.TaskPath -eq $TaskPath)
        })
    }
    return @($global:KmemTestInventoryTasks)
}

function New-ScheduledTaskPrincipal {
    param([string]$UserId, [string]$LogonType, [string]$RunLevel)
    return [pscustomobject]@{
        UserId = $UserId
        LogonType = $LogonType
        RunLevel = $RunLevel
    }
}

function New-ScheduledTaskSettingsSet {
    param(
        [switch]$AllowStartIfOnBatteries,
        [switch]$DontStopIfGoingOnBatteries,
        [switch]$StartWhenAvailable,
        [TimeSpan]$ExecutionTimeLimit,
        [string]$MultipleInstances,
        [int]$RestartCount,
        [TimeSpan]$RestartInterval
    )
    return [pscustomobject]@{
        ExecutionTimeLimit = $ExecutionTimeLimit
        MultipleInstances = $MultipleInstances
        RestartCount = $RestartCount
        RestartInterval = $RestartInterval
    }
}

function New-ScheduledTaskAction {
    param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
    return [pscustomobject]@{
        Execute = $Execute
        Arguments = $Argument
        WorkingDirectory = $WorkingDirectory
    }
}

function New-ScheduledTaskTrigger {
    param(
        [switch]$Once,
        [datetime]$At,
        [TimeSpan]$RepetitionInterval,
        [switch]$AtLogOn,
        [string]$User
    )
    return [pscustomobject]@{
        Once = $Once.IsPresent
        At = $At
        RepetitionInterval = $RepetitionInterval
        AtLogOn = $AtLogOn.IsPresent
        User = $User
        Delay = $null
    }
}

function Register-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        $Action,
        $Trigger,
        $Principal,
        $Settings,
        [string]$Description,
        [switch]$Force
    )
    $global:KmemTestRegisteredTasks += [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Action = $Action
        Trigger = $Trigger
        Principal = $Principal
        Settings = $Settings
        Description = $Description
        Force = $Force.IsPresent
    }
}

function Start-ScheduledTask {
    throw "Task start was not expected in the registration contract test."
}

function Invoke-Registration([switch]$EnableLocalDisplay, [switch]$LegacyServerOnly) {
    $global:KmemTestRegisteredTasks = @()
    $global:KmemTestInventoryTasks = @(
        [pscustomobject]@{
            TaskName = "Vendor COM Maintenance"
            TaskPath = "\Vendor\"
            Actions = @([pscustomobject]@{
                ClassId = "{D8F6B1A0-0000-0000-0000-000000000000}"
                Data = "vendor"
            })
        }
    )
    if ($EnableLocalDisplay) {
        & $installerPath `
            -SkipInitialStart `
            -ReplaceExisting `
            -AcknowledgeExistingUpdaterTasks `
            -EnableLocalDisplay | Out-Null
    } elseif ($LegacyServerOnly) {
        & $installerPath `
            -SkipInitialStart `
            -ReplaceExisting `
            -AcknowledgeExistingUpdaterTasks `
            -SkipDisplayLaunch | Out-Null
    } else {
        & $installerPath `
            -SkipInitialStart `
            -ReplaceExisting `
            -AcknowledgeExistingUpdaterTasks | Out-Null
    }
    return @($global:KmemTestRegisteredTasks)
}

$hostedTasks = @(Invoke-Registration)
Assert-Condition "hosted default registers one task" ($hostedTasks.Count -eq 1)
Assert-Condition "hosted default registers Weather Update" ($hostedTasks[0].TaskName -eq "KMEM Ops Board - Weather Update")
Assert-Condition "hosted default uses root TaskPath" ($hostedTasks[0].TaskPath -eq "\")
Assert-Condition "hosted default uses WScript" ([IO.Path]::GetFileName($hostedTasks[0].Action.Execute) -ieq "wscript.exe")
Assert-Condition "hosted default invokes hidden PRIMARY wrapper" (
    $hostedTasks[0].Action.Arguments -match '(?i)//B\s+//NoLogo\s+.*run_kmem_update_hidden\.vbs.*\sPRIMARY$'
)
Assert-Condition "hosted cadence is ten minutes" ($hostedTasks[0].Trigger.RepetitionInterval.TotalMinutes -eq 10)
Assert-Condition "hosted overlap policy is IgnoreNew" ($hostedTasks[0].Settings.MultipleInstances -eq "IgnoreNew")
Assert-Condition "hosted principal remains the signed-in user" ($hostedTasks[0].Principal.LogonType -eq "Interactive")

$localTasks = @(Invoke-Registration -EnableLocalDisplay)
$localNames = @($localTasks | ForEach-Object TaskName)
Assert-Condition "local-display opt-in registers three tasks" ($localTasks.Count -eq 3)
Assert-Condition "local-display opt-in includes Weather" ($localNames -contains "KMEM Ops Board - Weather Update")
Assert-Condition "local-display opt-in includes Local Server" ($localNames -contains "KMEM Ops Board - Local Server")
Assert-Condition "local-display opt-in includes Display" ($localNames -contains "KMEM Ops Board - Display")
Assert-Condition "local-display opt-in never creates Watchdog" ($localNames -notcontains "KMEM Ops Board - Display Watchdog")

$legacyTasks = @(Invoke-Registration -LegacyServerOnly)
$legacyNames = @($legacyTasks | ForEach-Object TaskName)
Assert-Condition "legacy server-only switch remains compatible" (
    $legacyTasks.Count -eq 2 -and
    $legacyNames -contains "KMEM Ops Board - Weather Update" -and
    $legacyNames -contains "KMEM Ops Board - Local Server" -and
    $legacyNames -notcontains "KMEM Ops Board - Display"
)

Write-Output "DISPLAY TASK REGISTRATION TESTS: $passed passed, 0 failed"
Remove-Variable -Name KmemTestRegisteredTasks -Scope Global -ErrorAction SilentlyContinue
Remove-Variable -Name KmemTestInventoryTasks -Scope Global -ErrorAction SilentlyContinue
