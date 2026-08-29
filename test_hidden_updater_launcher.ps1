$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$wrapperPath = Join-Path $PSScriptRoot "run_kmem_update_hidden.ps1"
$vbsPath = Join-Path $PSScriptRoot "run_kmem_update_hidden.vbs"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $wrapperPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "Hidden wrapper parse failed: $($parseErrors.Message -join ' | ')"
}

foreach ($functionName in @("Stop-HiddenProcessTree", "Invoke-HiddenProcess")) {
    $definition = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $functionName
    }, $true) | Select-Object -First 1
    if (-not $definition) {
        throw "Missing hidden launcher function: $functionName"
    }
    Invoke-Expression $definition.Extent.Text
}

$passed = 0
function Assert-Condition([string]$Name, [bool]$Condition) {
    if (-not $Condition) {
        throw "$Name failed"
    }
    $script:passed += 1
}

$wrapperText = Get-Content -LiteralPath $wrapperPath -Raw
$vbsText = Get-Content -LiteralPath $vbsPath -Raw
Assert-Condition "PowerShell child has no console" ($wrapperText -match '\.CreateNoWindow\s*=\s*\$true')
Assert-Condition "PowerShell child window is hidden" ($wrapperText -match 'ProcessWindowStyle\]::Hidden')
Assert-Condition "stdout is redirected" ($wrapperText -match 'RedirectStandardOutput\s*=\s*\$true')
Assert-Condition "stderr is redirected" ($wrapperText -match 'RedirectStandardError\s*=\s*\$true')
Assert-Condition "PowerShell role is mandatory" ($wrapperText -match 'Parameter\(Mandatory\s*=\s*\$true\)')
Assert-Condition "scheduled Python output is UTF-8" ($wrapperText -match 'PYTHONIOENCODING\s*=\s*"utf-8:backslashreplace"')
Assert-Condition "VBS requires exactly one role" ($vbsText -match 'WScript\.Arguments\.Count\s*<>\s*1')
Assert-Condition "VBS launches invisibly and waits" ($vbsText -match 'shell\.Run\(command,\s*0,\s*True\)')
Assert-Condition "VBS propagates child exit" ($vbsText -match 'WScript\.Quit\s+exitCode')

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("kmem-hidden-launcher-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    $stubPath = Join-Path $temporaryRoot "stub updater.cmd"
    @(
        "@echo off",
        "echo WRAPPER_STDOUT",
        "echo WRAPPER_STDERR 1>&2",
        "exit /b 37"
    ) | Set-Content -LiteralPath $stubPath -Encoding ASCII

    $cmdPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) "cmd.exe"
    $arguments = '/D /S /C ""{0}""' -f $stubPath
    $result = Invoke-HiddenProcess `
        -FileName $cmdPath `
        -Arguments $arguments `
        -WorkingDirectory $temporaryRoot `
        -TimeoutSeconds 10

    Assert-Condition "child exit code propagates" ($result.ExitCode -eq 37)
    Assert-Condition "stdout is captured" ($result.StdOut -match 'WRAPPER_STDOUT')
    Assert-Condition "stderr is captured" ($result.StdErr -match 'WRAPPER_STDERR')
    Assert-Condition "normal child is not timed out" (-not $result.TimedOut)

    $slowPath = Join-Path $temporaryRoot "slow updater.cmd"
    @(
        "@echo off",
        "ping 127.0.0.1 -n 6 >nul",
        "exit /b 0"
    ) | Set-Content -LiteralPath $slowPath -Encoding ASCII
    $slowArguments = '/D /S /C ""{0}""' -f $slowPath
    $timedOut = Invoke-HiddenProcess `
        -FileName $cmdPath `
        -Arguments $slowArguments `
        -WorkingDirectory $temporaryRoot `
        -TimeoutSeconds 1
    Assert-Condition "timeout returns stable code" ($timedOut.ExitCode -eq 124)
    Assert-Condition "timeout is reported" $timedOut.TimedOut

    $wscriptSmokeRoot = Join-Path $temporaryRoot "WScript launcher smoke"
    New-Item -ItemType Directory -Path $wscriptSmokeRoot -Force | Out-Null
    $smokeVbs = Join-Path $wscriptSmokeRoot "run_kmem_update_hidden.vbs"
    $smokePowerShell = Join-Path $wscriptSmokeRoot "run_kmem_update_hidden.ps1"
    $smokeSentinel = Join-Path $wscriptSmokeRoot "launcher-result.txt"
    Copy-Item -LiteralPath $vbsPath -Destination $smokeVbs
    @(
        'param([ValidateSet("PRIMARY", "BACKUP")][string]$Role)',
        '[IO.File]::WriteAllText($env:KMEM_HIDDEN_LAUNCHER_TEST_SENTINEL, $Role, [Text.Encoding]::UTF8)',
        'exit 41'
    ) | Set-Content -LiteralPath $smokePowerShell -Encoding UTF8

    $priorSentinel = $env:KMEM_HIDDEN_LAUNCHER_TEST_SENTINEL
    try {
        $env:KMEM_HIDDEN_LAUNCHER_TEST_SENTINEL = $smokeSentinel
        $wscriptPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) "wscript.exe"
        $wscriptInfo = [Diagnostics.ProcessStartInfo]::new()
        $wscriptInfo.FileName = $wscriptPath
        $wscriptInfo.Arguments = '//B //NoLogo "{0}" PRIMARY' -f $smokeVbs
        $wscriptInfo.WorkingDirectory = $wscriptSmokeRoot
        $wscriptInfo.UseShellExecute = $false
        $wscriptInfo.CreateNoWindow = $true
        $wscriptInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $wscriptProcess = [Diagnostics.Process]::Start($wscriptInfo)
        if (-not $wscriptProcess.WaitForExit(15000)) {
            try { $wscriptProcess.Kill() } catch {}
            throw "WScript launcher smoke timed out"
        }
        $wscriptExitCode = $wscriptProcess.ExitCode
        $wscriptProcess.Dispose()
    } finally {
        $env:KMEM_HIDDEN_LAUNCHER_TEST_SENTINEL = $priorSentinel
    }
    Assert-Condition "WScript chain propagates child exit" ($wscriptExitCode -eq 41)
    Assert-Condition "WScript chain reaches hidden PowerShell child" (
        (Test-Path -LiteralPath $smokeSentinel -PathType Leaf) -and
        (Get-Content -LiteralPath $smokeSentinel -Raw).TrimStart([char]0xFEFF) -eq "PRIMARY"
    )
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

Write-Output "HIDDEN UPDATER LAUNCHER TESTS: $passed passed, 0 failed"
