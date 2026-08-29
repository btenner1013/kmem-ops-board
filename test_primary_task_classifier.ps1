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
    "Test-CommandStartsWithEntrypoint",
    "Get-SemanticEntrypoints",
    "Get-TaskFacts"
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
$protectedTaskPattern = '(?i)(tail[\s_-]*watch|clock|(?<![a-z])obs)'
$passed = 0
$repoRoot = Split-Path -Parent $installerPath
$system32 = Join-Path $env:SystemRoot "System32"
$cmdPath = Join-Path $system32 "cmd.exe"
$windowsPowerShell = Join-Path $system32 "WindowsPowerShell\v1.0\powershell.exe"

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
Assert-Entrypoints "PowerShell server File" `
    (New-TestAction "powershell.exe" '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\KMEM\run_kmem_server.ps1"') `
    @("run_kmem_server.ps1")
Assert-Entrypoints "PowerShell watchdog File" `
    (New-TestAction "pwsh.exe" '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\KMEM\run_kmem_display_watchdog.ps1"') `
    @("run_kmem_display_watchdog.ps1")
Assert-Entrypoints "cmd c" `
    (New-TestAction $cmdPath ('/d /c "' + (Join-Path $repoRoot "run_kmem_update.bat") + '"')) `
    @("run_kmem_update.bat")
Assert-Entrypoints "Python entrypoint" `
    (New-TestAction "python.exe" ('"' + (Join-Path $repoRoot "kmem_updater.py") + '" --role PRIMARY')) `
    @("kmem_updater.py")
Assert-Entrypoints "empty Execute" (New-TestAction "") @()
Assert-Entrypoints "null Execute" (New-TestAction $null) @()

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

Write-Output "PRIMARY TASK CLASSIFIER TESTS: $passed passed, 0 failed"
