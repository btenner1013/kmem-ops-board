$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installerPath = Join-Path $PSScriptRoot "install_primary_display.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $installerPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "Installer parse failed: $($parseErrors.Message -join ' | ')"
}

foreach ($functionName in @(
    "Test-ExactEntrypointToken",
    "Get-ObjectTextProperty",
    "Get-LeadingCommandToken",
    "Test-CommandStartsWithEntrypoint",
    "Test-PrimaryUpdaterRole",
    "Test-ProjectWorkingDirectory",
    "Test-ActionTargetsProjectEntrypoint",
    "Get-SemanticEntrypoints",
    "Get-TaskFacts",
    "Get-TaskInventory",
    "Assert-SafeTaskInventory",
    "Assert-LosslessTaskBackup",
    "Get-ReconciliationDisposition",
    "Get-SafeTaskInventorySignature"
)) {
    $definition = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $functionName
    }, $true) | Select-Object -First 1
    if (-not $definition) {
        throw "Missing classifier function: $functionName"
    }
    Invoke-Expression $definition.Extent.Text
}

$knownEntrypointNames = @(
    "run_kmem_update_hidden.vbs",
    "run_kmem_update_hidden.ps1",
    "run_kmem_update.bat",
    "update_weather_local.py",
    "kmem_updater.py",
    "run_kmem_server.bat",
    "run_kmem_server.ps1",
    "launch_kmem_display.bat",
    "kmem_display_server.py",
    "run_kmem_update.ps1",
    "run_kmem_display_watchdog.ps1"
)
$taskPrefix = "KMEM Ops Board"
$managedTaskNames = @(
    "$taskPrefix - Local Server",
    "$taskPrefix - Weather Update",
    "$taskPrefix - Display",
    "$taskPrefix - Display Watchdog"
)
$expectedEntrypointByTaskName = @{
    "$taskPrefix - Local Server" = @("run_kmem_server.bat", "run_kmem_server.ps1", "kmem_display_server.py")
    "$taskPrefix - Weather Update" = @("run_kmem_update_hidden.vbs", "run_kmem_update.bat", "run_kmem_update.ps1")
    "$taskPrefix - Display" = @("launch_kmem_display.bat", "run_kmem_display_watchdog.ps1")
    "$taskPrefix - Display Watchdog" = @("run_kmem_display_watchdog.ps1")
}
$localDisplayEntrypointNames = @(
    "run_kmem_server.bat",
    "run_kmem_server.ps1",
    "kmem_display_server.py",
    "launch_kmem_display.bat",
    "run_kmem_display_watchdog.ps1"
)
$protectedTaskPattern = '(?i)(tail[\s_-]*watch|clock|(?<![a-z])obs)'
$passed = 0
$repoRoot = Split-Path -Parent $installerPath
$projectDir = $repoRoot
$system32 = Join-Path $env:SystemRoot "System32"
$cmdPath = Join-Path $system32 "cmd.exe"
$windowsPowerShell = Join-Path $system32 "WindowsPowerShell\v1.0\powershell.exe"
$wscriptPath = Join-Path $system32 "wscript.exe"

function New-TestAction($Execute, [string]$Arguments = "", [string]$WorkingDirectory = "") {
    return [pscustomobject]@{
        Execute = $Execute
        Arguments = $Arguments
        WorkingDirectory = $WorkingDirectory
    }
}

function Assert-Entrypoints([string]$Name, $Action, [string[]]$Expected) {
    try {
        $actual = @(Get-SemanticEntrypoints $Action)
    } catch {
        throw "$Name crashed: $($_.Exception.Message)"
    }
    $actualText = $actual -join "`n"
    $expectedText = @($Expected) -join "`n"
    if ($actualText -cne $expectedText) {
        throw "$Name expected '$expectedText' but got '$actualText'"
    }
    $script:passed += 1
}

function Assert-Protected([string]$Name, $Task) {
    $fact = Get-TaskFacts $Task
    if (-not $fact.IsProtected) {
        throw "$Name was not classified as protected"
    }
    if ($fact.Entrypoints.Count -eq 0) {
        throw "$Name lost its known KMEM entrypoint classification"
    }
    $script:passed += 1
}

function Assert-Condition([string]$Name, [bool]$Condition) {
    if (-not $Condition) {
        throw "$Name failed"
    }
    $script:passed += 1
}

function New-TestTask(
    [string]$TaskName,
    $Action,
    [string]$TaskPath = "\",
    [string]$State = "Ready",
    [string]$LogonType = "InteractiveToken"
) {
    return [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        State = $State
        Actions = @($Action)
        Triggers = @()
        Principal = [pscustomobject]@{
            UserId = "TEST\KMEM"
            LogonType = $LogonType
            RunLevel = "Limited"
        }
        Settings = [pscustomobject]@{
            MultipleInstances = "IgnoreNew"
            ExecutionTimeLimit = "PT30M"
            Enabled = $true
        }
    }
}

Assert-Entrypoints "normal full path" `
    (New-TestAction (Join-Path $repoRoot "run_kmem_update.bat")) `
    @("run_kmem_update.bat")
Assert-Entrypoints "UNC path is fail closed without probing" `
    (New-TestAction "\\kmem-server\display\run_kmem_update.bat") `
    @()
Assert-Entrypoints "quoted normal path" `
    (New-TestAction ('"' + (Join-Path $repoRoot "run_kmem_server.bat") + '"')) `
    @("run_kmem_server.bat")
Assert-Entrypoints "direct Python entrypoint" `
    (New-TestAction (Join-Path $repoRoot "kmem_updater.py")) `
    @("kmem_updater.py")
Assert-Entrypoints "direct PowerShell entrypoint name" `
    (New-TestAction "run_kmem_update.ps1") `
    @("run_kmem_update.ps1")
Assert-Entrypoints "PowerShell update File" `
    (New-TestAction $windowsPowerShell ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $repoRoot "run_kmem_update.ps1") + '"')) `
    @("run_kmem_update.ps1")
Assert-Entrypoints "hidden PowerShell is recognized as a conflicting updater" `
    (New-TestAction (Join-Path $repoRoot "run_kmem_update_hidden.ps1")) `
    @("run_kmem_update_hidden.ps1")
Assert-Entrypoints "PowerShell server File" `
    (New-TestAction "powershell.exe" '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\KMEM\run_kmem_server.ps1"') `
    @("run_kmem_server.ps1")
Assert-Entrypoints "PowerShell watchdog File" `
    (New-TestAction "pwsh.exe" '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\KMEM\run_kmem_display_watchdog.ps1"') `
    @("run_kmem_display_watchdog.ps1")
Assert-Entrypoints "cmd c" `
    (New-TestAction $cmdPath ('/d /c "' + (Join-Path $repoRoot "run_kmem_update.bat") + '"')) `
    @("run_kmem_update.bat")
Assert-Entrypoints "hidden WScript PRIMARY launcher" `
    (New-TestAction $wscriptPath ('//B //NoLogo "' + (Join-Path $repoRoot "run_kmem_update_hidden.vbs") + '" PRIMARY')) `
    @("run_kmem_update_hidden.vbs")
Assert-Entrypoints "Python entrypoint" `
    (New-TestAction "python.exe" ('"' + (Join-Path $repoRoot "kmem_updater.py") + '" --role PRIMARY')) `
    @("kmem_updater.py")
Assert-Entrypoints "empty Execute" (New-TestAction "") @()
Assert-Entrypoints "null Execute" (New-TestAction $null) @()
Assert-Entrypoints "non-Exec COM handler action" `
    ([pscustomobject]@{ ClassId = "{D8F6B1A0-0000-0000-0000-000000000000}"; Data = "vendor" }) `
    @()

$invalidExecute = "C:\Vendor$([char]0)\run_kmem_update.bat"
Assert-Entrypoints "invalid path character" (New-TestAction $invalidExecute) @()
Assert-Entrypoints "shell switch in Execute" `
    (New-TestAction "cmd.exe /c C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "shell operator in Execute" `
    (New-TestAction "C:\Vendor\runner.exe & C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "URI Execute" `
    (New-TestAction "https://vendor.example/run_kmem_update.bat") `
    @()
Assert-Entrypoints "vendor malformed Execute" `
    (New-TestAction "Vendor::{D8F6B1A0-0000-0000-0000-000000000000}|run_kmem_update.bat") `
    @()
Assert-Entrypoints "unbalanced quote" `
    (New-TestAction '"C:\KMEM\run_kmem_update.bat') `
    @()
Assert-Entrypoints "shell provider Execute" `
    (New-TestAction "shell:AppsFolder\run_kmem_update.bat") `
    @()
Assert-Entrypoints "file provider Execute" `
    (New-TestAction "file:C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "generic command line Execute" `
    (New-TestAction "notepad.exe C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "absolute command line Execute" `
    (New-TestAction "C:\Windows\notepad.exe C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "comma command Execute" `
    (New-TestAction "rundll32.exe,C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "absolute comma command Execute" `
    (New-TestAction "C:\Windows\rundll32.exe,C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "semicolon command Execute" `
    (New-TestAction "powershell.exe;C:\KMEM\run_kmem_update.ps1") `
    @()
Assert-Entrypoints "unbalanced single quote" `
    (New-TestAction "'C:\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "Python command line in Execute" `
    (New-TestAction "C:\Python311\python.exe C:\KMEM\kmem_updater.py") `
    @()
Assert-Entrypoints "drive command with relative entrypoint" `
    (New-TestAction "C:\Windows\notepad.exe folder\run_kmem_update.bat") `
    @()
Assert-Entrypoints "drive command with dot-relative entrypoint" `
    (New-TestAction "C:\Windows\notepad.exe .\run_kmem_update.bat") `
    @()
Assert-Entrypoints "drive command with parent-relative entrypoint" `
    (New-TestAction "C:\Windows\notepad.exe ..\KMEM\run_kmem_update.bat") `
    @()
Assert-Entrypoints "drive command with forward relative entrypoint" `
    (New-TestAction "C:/Windows/notepad.exe folder/run_kmem_update.bat") `
    @()
Assert-Entrypoints "quoted unrelated executable before KMEM path" `
    (New-TestAction $cmdPath ('/d /c "C:\Windows\notepad.exe ' + (Join-Path $repoRoot "run_kmem_server.bat") + '"')) `
    @()
Assert-Entrypoints "UNC command with relative entrypoint" `
    (New-TestAction "\\server\share\notepad.exe folder\run_kmem_update.bat") `
    @()
Assert-Entrypoints "unbalanced shell quote with relative entrypoint" `
    (New-TestAction "C:\Windows\powershell.exe 'folder\run_kmem_update.ps1") `
    @()
Assert-Entrypoints "device namespace path" `
    (New-TestAction "\\.\pipe\run_kmem_update.bat") `
    @()

foreach ($protectedName in @("Tail Watch Updater", "ClockDisplay", "OBSUpdater")) {
    $task = [pscustomobject]@{
        TaskName = $protectedName
        TaskPath = "\"
        State = "Ready"
        Actions = @(
            New-TestAction (Join-Path $repoRoot "run_kmem_update.bat") "" $repoRoot
        )
    }
    Assert-Protected "$protectedName protection" $task
}

foreach ($protectedCase in @(
    @{ Name = "Tail Watch action protection"; Path = "C:\Tail Watch" },
    @{ Name = "clock action protection"; Path = "C:\ClockDisplay" },
    @{ Name = "OBS action protection"; Path = "C:\OBSUpdater" }
)) {
    $task = [pscustomobject]@{
        TaskName = "Unrelated Updater"
        TaskPath = "\"
        State = "Ready"
        Actions = @(
            New-TestAction (Join-Path $repoRoot "run_kmem_update.bat") "" $protectedCase.Path
        )
    }
    Assert-Protected $protectedCase.Name $task
}

$taskPathProtected = New-TestTask `
    "Unrelated Updater" `
    (New-TestAction (Join-Path $repoRoot "run_kmem_update.bat") "PRIMARY" $repoRoot) `
    "\Vendor\OBS\"
Assert-Protected "OBS TaskPath protection" $taskPathProtected

$weatherPrimaryAction = New-TestAction `
    $wscriptPath `
    ('//B //NoLogo "' + (Join-Path $repoRoot "run_kmem_update_hidden.vbs") + '" PRIMARY') `
    $repoRoot
$weatherBackupAction = New-TestAction `
    $wscriptPath `
    ('//B //NoLogo "' + (Join-Path $repoRoot "run_kmem_update_hidden.vbs") + '" BACKUP') `
    $repoRoot
$serverAction = New-TestAction `
    $cmdPath `
    ('/d /c "' + (Join-Path $repoRoot "run_kmem_server.bat") + '"') `
    $repoRoot
$displayAction = New-TestAction `
    $cmdPath `
    ('/d /c "' + (Join-Path $repoRoot "launch_kmem_display.bat") + '"') `
    $repoRoot
$watchdogAction = New-TestAction `
    $windowsPowerShell `
    ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $repoRoot "run_kmem_display_watchdog.ps1") + '"') `
    $repoRoot

$existingInstall = @(
    (New-TestTask "$taskPrefix - Weather Update" $weatherPrimaryAction),
    (New-TestTask "$taskPrefix - Local Server" $serverAction),
    (New-TestTask "$taskPrefix - Display" $displayAction),
    (New-TestTask "$taskPrefix - Display Watchdog" $watchdogAction)
)
$inventory = Get-TaskInventory $existingInstall
Assert-SafeTaskInventory $inventory
Assert-Condition "existing installation is fully and positively identified" ($inventory.SafeKmemTasks.Count -eq 4)
Assert-LosslessTaskBackup $inventory.SafeKmemTasks
Assert-Condition "interactive task XML is accepted as restorable" $true

$passwordTask = New-TestTask "$taskPrefix - Local Server" $serverAction "\" "Ready" "Password"
$passwordFact = Get-TaskFacts $passwordTask
$passwordBlocked = $false
try {
    Assert-LosslessTaskBackup @($passwordFact)
} catch {
    $passwordBlocked = $true
}
Assert-Condition "password-principal task blocks mutation before backup" $passwordBlocked

$hostedDesired = @("$taskPrefix - Weather Update")
$hostedDisposition = @($inventory.SafeKmemTasks | ForEach-Object {
    "{0}:{1}" -f $_.Task.TaskName, (Get-ReconciliationDisposition $_ $hostedDesired)
})
Assert-Condition "hosted mode keeps Weather Update" ($hostedDisposition -contains "$taskPrefix - Weather Update`:KEEP")
Assert-Condition "hosted mode removes Local Server" ($hostedDisposition -contains "$taskPrefix - Local Server`:REMOVE")
Assert-Condition "hosted mode removes Display" ($hostedDisposition -contains "$taskPrefix - Display`:REMOVE")
Assert-Condition "hosted mode removes Display Watchdog" ($hostedDisposition -contains "$taskPrefix - Display Watchdog`:REMOVE")

$localDesired = @(
    "$taskPrefix - Weather Update",
    "$taskPrefix - Local Server",
    "$taskPrefix - Display"
)
Assert-Condition "local-display opt-in keeps exactly three canonical tasks" (
    @($inventory.SafeKmemTasks | Where-Object {
        (Get-ReconciliationDisposition $_ $localDesired) -eq "KEEP"
    }).Count -eq 3
)

$backupInventory = Get-TaskInventory @(
    (New-TestTask "$taskPrefix - Weather Update" $weatherBackupAction)
)
Assert-Condition "BACKUP role is unsafe for PRIMARY Weather task" (
    $backupInventory.UnknownManagedTasks.Count -eq 1 -and
    $backupInventory.SafeKmemTasks.Count -eq 0
)

$nonRootInventory = Get-TaskInventory @(
    (New-TestTask "$taskPrefix - Display" $displayAction "\Vendor\")
)
Assert-Condition "non-root managed task is ambiguous and untouched" (
    $nonRootInventory.UnknownManagedTasks.Count -eq 1 -and
    $nonRootInventory.SafeKmemTasks.Count -eq 0
)

$multiActionTask = New-TestTask "$taskPrefix - Local Server" $serverAction
$multiActionTask.Actions = @($serverAction, $displayAction)
$multiInventory = Get-TaskInventory @($multiActionTask)
Assert-Condition "multi-action managed task is ambiguous and untouched" (
    $multiInventory.UnknownManagedTasks.Count -eq 1 -and
    $multiInventory.SafeKmemTasks.Count -eq 0
)

$legacyDisplayInventory = Get-TaskInventory @(
    (New-TestTask "Legacy KMEM Display Watchdog" $watchdogAction)
)
Assert-Condition "exact legacy display action is removable" (
    $legacyDisplayInventory.SafeKmemTasks.Count -eq 1 -and
    (Get-ReconciliationDisposition $legacyDisplayInventory.SafeKmemTasks[0] $hostedDesired) -eq "REMOVE"
)

$wrongDirectoryInventory = Get-TaskInventory @(
    (New-TestTask "Legacy KMEM Display Watchdog" (New-TestAction $windowsPowerShell $watchdogAction.Arguments "C:\Vendor"))
)
Assert-Condition "custom legacy action outside project is ambiguous" (
    $wrongDirectoryInventory.AmbiguousEntrypointTasks.Count -eq 1 -and
    $wrongDirectoryInventory.SafeKmemTasks.Count -eq 0
)

$relativeDirectoryInventory = Get-TaskInventory @(
    (New-TestTask "Legacy KMEM Display Watchdog" (New-TestAction $windowsPowerShell $watchdogAction.Arguments "."))
)
Assert-Condition "relative working directory cannot authorize deletion" (
    $relativeDirectoryInventory.AmbiguousEntrypointTasks.Count -eq 1 -and
    $relativeDirectoryInventory.SafeKmemTasks.Count -eq 0
)

$vendorDisplayArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Vendor\run_kmem_display_watchdog.ps1"'
$vendorTargetInventory = Get-TaskInventory @(
    (New-TestTask "Legacy KMEM Display Watchdog" (New-TestAction $windowsPowerShell $vendorDisplayArguments $repoRoot))
)
Assert-Condition "same basename outside project cannot authorize deletion" (
    $vendorTargetInventory.AmbiguousEntrypointTasks.Count -eq 1 -and
    $vendorTargetInventory.SafeKmemTasks.Count -eq 0
)

$mentionedProjectTargetArguments = '/d /c "C:\Vendor\launch_kmem_display.bat" "' +
    (Join-Path $repoRoot "launch_kmem_display.bat") + '"'
$mentionedProjectTargetInventory = Get-TaskInventory @(
    (New-TestTask "$taskPrefix - Display" (New-TestAction $cmdPath $mentionedProjectTargetArguments $repoRoot))
)
Assert-Condition "project launcher mentioned only as data cannot authorize deletion" (
    $mentionedProjectTargetInventory.UnknownManagedTasks.Count -eq 1 -and
    $mentionedProjectTargetInventory.SafeKmemTasks.Count -eq 0
)

$hiddenPowerShellInventory = Get-TaskInventory @(
    (New-TestTask "Other PRIMARY Updater" (New-TestAction (Join-Path $repoRoot "run_kmem_update_hidden.ps1") "-Role PRIMARY" $repoRoot))
)
Assert-Condition "other hidden updater blocks reconciliation" (
    $hiddenPowerShellInventory.AmbiguousEntrypointTasks.Count -eq 1
)
$blocked = $false
try {
    Assert-SafeTaskInventory $hiddenPowerShellInventory
} catch {
    $blocked = $true
}
Assert-Condition "ambiguous updater fails closed" $blocked

$unrelatedInventory = Get-TaskInventory @(
    (New-TestTask "Vendor Maintenance" (New-TestAction "Vendor::{D8F6B1A0}|unusual" "" "C:\Vendor"))
)
Assert-Condition "unrelated task remains unaffected" (
    $unrelatedInventory.SafeKmemTasks.Count -eq 0 -and
    $unrelatedInventory.UnknownManagedTasks.Count -eq 0 -and
    $unrelatedInventory.AmbiguousEntrypointTasks.Count -eq 0
)

$comHandlerInventory = Get-TaskInventory @(
    (New-TestTask "Vendor COM Maintenance" ([pscustomobject]@{
        ClassId = "{D8F6B1A0-0000-0000-0000-000000000000}"
        Data = "vendor"
    }))
)
Assert-Condition "unrelated COM handler does not crash inventory" (
    $comHandlerInventory.SafeKmemTasks.Count -eq 0 -and
    $comHandlerInventory.AmbiguousEntrypointTasks.Count -eq 0
)

$unknownKmemDisplay = Get-TaskInventory @(
    (New-TestTask "KMEM Old Display Helper" (New-TestAction "vendor-display.exe" "--start" $repoRoot))
)
Assert-Condition "unknown KMEM display task fails closed" (
    $unknownKmemDisplay.AmbiguousEntrypointTasks.Count -eq 1 -and
    $unknownKmemDisplay.SafeKmemTasks.Count -eq 0
)

Write-Output "PRIMARY TASK CLASSIFIER TESTS: $passed passed, 0 failed"
