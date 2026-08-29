[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("PRIMARY", "BACKUP")]
    [string]$Role
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$updateBat = Join-Path $projectDir "run_kmem_update.bat"
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $localAppData) {
    $localAppData = [IO.Path]::GetTempPath()
}
$logDirectory = Join-Path $localAppData "KMEMOpsBoard\logs"
$logPath = Join-Path $logDirectory "scheduled-updater.log"
$utf8WithoutBom = [Text.UTF8Encoding]::new($false)

function Add-ScheduledUpdaterLog([string[]]$Lines) {
    try {
        [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
        if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and (Get-Item -LiteralPath $logPath).Length -gt 5MB) {
            [IO.File]::Copy($logPath, "$logPath.1", $true)
            [IO.File]::WriteAllText($logPath, "", $utf8WithoutBom)
        }
        [IO.File]::AppendAllLines($logPath, $Lines, $utf8WithoutBom)
    } catch {
        # kmem_updater.py independently writes the primary rotating updater.log.
        # A wrapper-log failure must not create a popup or mask the child result.
    }
}

function Stop-HiddenProcessTree([int]$ProcessId) {
    $taskkill = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) "taskkill.exe"
    $killInfo = [Diagnostics.ProcessStartInfo]::new()
    $killInfo.FileName = $taskkill
    $killInfo.Arguments = "/PID $ProcessId /T /F"
    $killInfo.UseShellExecute = $false
    $killInfo.CreateNoWindow = $true
    $killInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $killer = $null
    try {
        $killer = [Diagnostics.Process]::Start($killInfo)
    } catch {
        # Invoke-HiddenProcess performs a direct Kill fallback after this helper.
    }
    if ($killer) {
        if (-not $killer.WaitForExit(15000)) {
            try { $killer.Kill() } catch {}
        }
        $killer.Dispose()
    }
}

function Invoke-HiddenProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName,
        [Parameter(Mandatory = $true)]
        [string]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [ValidateRange(1, 3600)]
        [int]$TimeoutSeconds = 1680
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "The hidden updater process could not be started."
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
        Stop-HiddenProcessTree $process.Id
        if (-not $process.WaitForExit(15000)) {
            try {
                $process.Kill()
                $process.WaitForExit(5000) | Out-Null
            } catch {
                throw "The timed-out hidden updater process could not be terminated."
            }
        }
    }
    $streamsCompleted = [Threading.Tasks.Task]::WaitAll(
        [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask),
        15000
    )
    $stdout = if ($streamsCompleted) { $stdoutTask.Result } else { "[output capture did not close]" }
    $stderr = if ($streamsCompleted) { $stderrTask.Result } else { "[error capture did not close]" }
    $exitCode = if ($completed) { $process.ExitCode } else { 124 }
    $process.Dispose()

    return [pscustomobject]@{
        ExitCode = $exitCode
        StdOut = [string]$stdout
        StdErr = [string]$stderr
        TimedOut = -not $completed
    }
}

$startedUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
try {
    if (-not (Test-Path -LiteralPath $updateBat -PathType Leaf)) {
        throw "Required updater entrypoint is missing: run_kmem_update.bat"
    }
    Add-ScheduledUpdaterLog @("$startedUtc SCHEDULED START role=$Role")
    $env:PYTHONUTF8 = "1"
    $env:PYTHONIOENCODING = "utf-8:backslashreplace"
    $cmdPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) "cmd.exe"
    $cmdArguments = '/D /S /C ""{0}" {1}"' -f $updateBat, $Role
    $result = Invoke-HiddenProcess `
        -FileName $cmdPath `
        -Arguments $cmdArguments `
        -WorkingDirectory $projectDir
    $logLines = @()
    foreach ($line in @($result.StdOut -split "`r?`n")) {
        if ($line.Trim()) {
            $logLines += "$startedUtc STDOUT $line"
        }
    }
    foreach ($line in @($result.StdErr -split "`r?`n")) {
        if ($line.Trim()) {
            $logLines += "$startedUtc STDERR $line"
        }
    }
    $finishedUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $logLines += "$finishedUtc SCHEDULED END role=$Role exitCode=$($result.ExitCode) timedOut=$($result.TimedOut)"
    Add-ScheduledUpdaterLog $logLines
    exit $result.ExitCode
} catch {
    $failedUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    Add-ScheduledUpdaterLog @("$failedUtc SCHEDULED ERROR role=$Role type=$($_.Exception.GetType().Name) message=$($_.Exception.Message)")
    exit 1
}
