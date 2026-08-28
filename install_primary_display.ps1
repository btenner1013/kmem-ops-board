[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$AfterSync
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$supportScript = Join-Path $projectDir "primary_install_support.py"
$displayInstaller = Join-Path $projectDir "install_display_tasks.ps1"
$runUpdate = Join-Path $projectDir "run_kmem_update.bat"
$taskPrefix = "KMEM Ops Board"
$plannedTaskNames = @(
    "$taskPrefix - Local Server",
    "$taskPrefix - Weather Update",
    "$taskPrefix - Display"
)

function Write-Step([string]$Message) {
    Write-Host "[KMEM] $Message" -ForegroundColor Cyan
}

function Require-File([string]$PathValue, [string]$Label) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
        throw "$Label is missing: $PathValue"
    }
}

function Require-Command([string]$Name, [string]$Instruction) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $Instruction"
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Support([string[]]$Arguments) {
    & py.exe -3 -B $supportScript @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Installer validation helper failed."
    }
}

Write-Host ""
Write-Host "KMEM OPS BOARD - PRIMARY DISPLAY INSTALL" -ForegroundColor Green
Write-Host "Repository: $projectDir"
Write-Host "Mode: $(if ($CheckOnly) { 'CHECK ONLY' } else { 'INSTALL' })"
Write-Host ""

if (-not $CheckOnly -and -not (Test-IsAdministrator)) {
    throw "Run INSTALL KMEM DISPLAY - PRIMARY.cmd as Administrator."
}

foreach ($required in @(
    $supportScript,
    $displayInstaller,
    $runUpdate,
    (Join-Path $projectDir "run_kmem_server.bat"),
    (Join-Path $projectDir "launch_kmem_display.bat"),
    (Join-Path $projectDir "kmem_updater.py"),
    (Join-Path $projectDir "updater_git.py"),
    (Join-Path $projectDir "host_status.json"),
    (Join-Path $projectDir "nms_credentials_local.bat")
)) {
    Require-File $required "Required package file"
}

Write-Step "Checking Python, Git, GitHub CLI, and Microsoft Edge."
Require-Command "py.exe" "Install Python 3 with the Python Launcher, then rerun this installer."
& py.exe -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.9 or newer is required."
}
Require-Command "git.exe" "Install Git for Windows, then rerun this installer."
Require-Command "gh.exe" "Install GitHub CLI, then rerun this installer."
$edgeCandidates = @(
    if (${env:ProgramFiles(x86)}) {
        Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
    }
    if ($env:ProgramFiles) {
        Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"
    }
)
$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $edgePath) {
    throw "Microsoft Edge was not found in a standard Program Files location. Install Edge, then rerun this installer."
}

Write-Step "Validating the local credential file and Git checkout."
Invoke-Support @("validate-package", "--repo", $projectDir)

Write-Step "Checking GitHub authentication."
& gh.exe auth status --hostname github.com *> $null
$githubAuthenticated = $LASTEXITCODE -eq 0
if (-not $githubAuthenticated -and $CheckOnly) {
    Write-Warning "GitHub authentication is not configured for this Windows account. The full installer will open the secure GitHub CLI browser login flow."
}
if (-not $githubAuthenticated -and -not $CheckOnly) {
    Write-Host "GitHub authentication is required. GitHub CLI will open its normal secure browser flow." -ForegroundColor Yellow
    & gh.exe auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI authentication did not complete."
    }
    & gh.exe auth status --hostname github.com *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI authentication could not be verified."
    }
    $githubAuthenticated = $true
}
if ($githubAuthenticated) {
    $pushPermissionOutput = @(& gh.exe api repos/btenner1013/kmem-ops-board --jq ".permissions.push" 2>$null)
    $pushPermissionExit = $LASTEXITCODE
    $pushPermission = (($pushPermissionOutput -join "`n").Trim()).ToLowerInvariant()
    if ($pushPermissionExit -ne 0 -or $pushPermission -ne "true") {
        throw "The authenticated GitHub account does not have verified push permission for the KMEM repository."
    }
    if (-not $CheckOnly) {
        & gh.exe auth setup-git
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub CLI could not configure Git credential integration."
        }
    }
}

$gitAuthorName = ((@(& git.exe -C $projectDir config --get user.name) -join "`n").Trim())
$gitAuthorEmail = ((@(& git.exe -C $projectDir config --get user.email) -join "`n").Trim())
if (-not $gitAuthorName -or -not $gitAuthorEmail) {
    if ($CheckOnly) {
        Write-Warning "Git commit identity is not configured. The full installer will add a repository-local KMEM updater identity."
    } else {
        if (-not $gitAuthorName) {
            & git.exe -C $projectDir config --local user.name "KMEM Ops Board Maintainer"
            if ($LASTEXITCODE -ne 0) {
                throw "The installer could not configure the repository-local Git author name."
            }
        }
        if (-not $gitAuthorEmail) {
            & git.exe -C $projectDir config --local user.email "289993237+btenner1013@users.noreply.github.com"
            if ($LASTEXITCODE -ne 0) {
                throw "The installer could not configure the repository-local Git author email."
            }
        }
    }
}

$priorTerminalPrompt = $env:GIT_TERMINAL_PROMPT
$priorCredentialInteraction = $env:GCM_INTERACTIVE
$priorGhPrompt = $env:GH_PROMPT_DISABLED
try {
    $env:GIT_TERMINAL_PROMPT = "0"
    $env:GCM_INTERACTIVE = "Never"
    $env:GH_PROMPT_DISABLED = "1"
    Write-Step "Performing strict fast-forward-only synchronization."
    $syncOutput = @(& py.exe -3 -B $supportScript sync --repo $projectDir)
    if ($LASTEXITCODE -ne 0) {
        throw "Safe Git synchronization failed."
    }
} finally {
    $env:GIT_TERMINAL_PROMPT = $priorTerminalPrompt
    $env:GCM_INTERACTIVE = $priorCredentialInteraction
    $env:GH_PROMPT_DISABLED = $priorGhPrompt
}
$syncOutput | ForEach-Object { Write-Host $_ }
if ($syncOutput -contains "SYNC STATUS: CODE_FAST_FORWARDED") {
    if ($AfterSync) {
        throw "Installer code changed repeatedly during synchronization. Rerun the installer after origin/main stabilizes."
    }
    Write-Step "New installer code was downloaded; restarting validation from the synchronized checkout."
    $restartArguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-AfterSync"
    )
    if ($CheckOnly) {
        $restartArguments += "-CheckOnly"
    }
    & powershell.exe @restartArguments
    exit $LASTEXITCODE
}

Write-Step "Validating FAA NMS authentication and a KMEM NOTAM read."
Invoke-Support @("validate-nms", "--repo", $projectDir)

Write-Step "Inventorying existing scheduled tasks without changing them."
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
$expectedEntrypointByTaskName = @{
    "$taskPrefix - Local Server" = @("run_kmem_server.bat", "run_kmem_server.ps1")
    "$taskPrefix - Weather Update" = @("run_kmem_update.bat", "run_kmem_update.ps1")
    "$taskPrefix - Display" = @("launch_kmem_display.bat", "run_kmem_display_watchdog.ps1")
}
$protectedTaskPattern = '(?i)(tail[\s_-]*watch|clock|(?<![a-z])obs)'

function Test-ExactEntrypointToken([string]$Text, [string]$Entrypoint) {
    $escaped = [Regex]::Escape($Entrypoint)
    return [Regex]::IsMatch($Text, "(?i)(?<![A-Za-z0-9_.:-])$escaped(?![A-Za-z0-9_.:-])")
}

function Test-CommandStartsWithEntrypoint([string]$CommandText, [string]$Entrypoint) {
    $candidate = $CommandText.Trim()
    while ($candidate.StartsWith('"') -or $candidate.StartsWith("'")) {
        $candidate = $candidate.Substring(1)
    }
    $escaped = [Regex]::Escape($Entrypoint)
    $match = [Regex]::Match(
        $candidate,
        "(?i)(?<![A-Za-z0-9_.:-])$escaped(?=[`"'\s]|$)"
    )
    if (-not $match.Success) {
        return $false
    }
    $prefix = $candidate.Substring(0, $match.Index)
    return -not $prefix -or $prefix -match '^(?:[A-Za-z]:[\\/]|\\\\).*[\\/]$'
}

function Get-SemanticEntrypoints($Action) {
    $executeName = [IO.Path]::GetFileName([string]$Action.Execute)
    $arguments = [string]$Action.Arguments
    if ($arguments -match '[&|<>^!%]') {
        return @()
    }
    # Do not use the name $Matches here: PowerShell's -match operator writes
    # regex captures to that automatic variable (variable names are case-insensitive).
    $semanticMatches = @()
    foreach ($entrypoint in $knownEntrypointNames) {
        $extension = [IO.Path]::GetExtension($entrypoint)
        if ($executeName -ieq $entrypoint) {
            $semanticMatches += $entrypoint
            continue
        }
        if ($executeName -ieq "cmd.exe" -or $executeName -ieq "cmd") {
            if ($extension -ieq ".bat") {
                $commandSwitch = [Regex]::Match($arguments, '(?i)^\s*(?:/d\s+)?/c\s+')
                if (
                    $commandSwitch.Success -and
                    (Test-CommandStartsWithEntrypoint $arguments.Substring($commandSwitch.Length) $entrypoint)
                ) {
                    $semanticMatches += $entrypoint
                }
            }
            continue
        }
        if ($executeName -in @("powershell.exe", "powershell", "pwsh.exe", "pwsh")) {
            if ($extension -ieq ".ps1") {
                if ($arguments -match '(?i)(?:^|\s)-(?:Command|EncodedCommand)\b') {
                    continue
                }
                $fileSwitch = [Regex]::Match(
                    $arguments,
                    '(?i)^\s*(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+|-WindowStyle\s+Hidden\s+|-ExecutionPolicy\s+Bypass\s+)*-File\s+'
                )
                if (
                    $fileSwitch.Success -and
                    (Test-CommandStartsWithEntrypoint $arguments.Substring($fileSwitch.Length) $entrypoint)
                ) {
                    $semanticMatches += $entrypoint
                }
            }
            continue
        }
        if ($executeName -in @("py.exe", "py", "python.exe", "python", "python3.exe", "python3")) {
            if ($extension -ieq ".py") {
                $pythonCommand = [Regex]::Replace($arguments, '^\s*(?:-\d(?:\.\d+)?)?\s*', '')
                if (Test-CommandStartsWithEntrypoint $pythonCommand $entrypoint) {
                    $semanticMatches += $entrypoint
                }
            }
        }
    }
    return @($semanticMatches | Select-Object -Unique)
}

function Get-TaskFacts($Task) {
    $actions = @($Task.Actions)
    $actionText = ($actions | ForEach-Object {
        "{0} {1} {2}" -f $_.Execute, $_.Arguments, $_.WorkingDirectory
    }) -join " "
    $entrypoints = @($actions | ForEach-Object { Get-SemanticEntrypoints $_ } | Select-Object -Unique)
    $identityText = "{0} {1} {2}" -f $Task.TaskName, $Task.TaskPath, $actionText
    foreach ($entrypoint in $knownEntrypointNames) {
        $identityText = [Regex]::Replace(
            $identityText,
            "(?i)(?<![A-Za-z0-9_.:-])$([Regex]::Escape($entrypoint))(?![A-Za-z0-9_.:-])",
            ""
        )
    }
    $workingDirectories = @($actions | ForEach-Object WorkingDirectory | Where-Object { $_ } | Select-Object -Unique)
    return [pscustomobject]@{
        Task = $Task
        ActionCount = $actions.Count
        Entrypoints = $entrypoints
        WorkingDirectories = $workingDirectories
        HasKmemIdentity = $identityText -match '(?i)(?<![a-z0-9])kmem'
        IsProtected = ("{0} {1}" -f $Task.TaskName, $actionText) -match $protectedTaskPattern
    }
}

function Write-TaskFact($Fact, [ConsoleColor]$Color) {
    $taskLocation = "{0}{1}" -f $Fact.Task.TaskPath, $Fact.Task.TaskName
    $entrypoints = if ($Fact.Entrypoints.Count -gt 0) { $Fact.Entrypoints -join ", " } else { "UNRECOGNIZED" }
    $workingDirectories = if ($Fact.WorkingDirectories.Count -gt 0) {
        $Fact.WorkingDirectories -join ", "
    } else {
        "NOT SET"
    }
    Write-Host ("  {0} [{1}] -> {2}; working directory: {3}" -f $taskLocation, $Fact.Task.State, $entrypoints, $workingDirectories) -ForegroundColor $Color
}

$allTasks = @(Get-ScheduledTask -ErrorAction Stop)
$unknownPlannedTasks = @()
$protectedConflicts = @()
$ambiguousEntrypointTasks = @()
$knownLegacyTasks = @()
foreach ($task in $allTasks) {
    $fact = Get-TaskFacts $task
    $isPlanned = $task.TaskName -in $plannedTaskNames
    if ($isPlanned) {
        $expectedEntrypoint = $expectedEntrypointByTaskName[$task.TaskName]
        $hasExactPlannedAction = (
            $fact.ActionCount -eq 1 -and
            $fact.Entrypoints.Count -eq 1 -and
            $expectedEntrypoint -icontains $fact.Entrypoints[0]
        )
        if ($fact.IsProtected) {
            $protectedConflicts += $fact
        } elseif (-not $hasExactPlannedAction) {
            $unknownPlannedTasks += $fact
        } else {
            $knownLegacyTasks += $fact
        }
    } elseif ($fact.Entrypoints.Count -gt 0) {
        if ($fact.IsProtected) {
            $protectedConflicts += $fact
        } elseif ($fact.ActionCount -ne 1 -or $fact.Entrypoints.Count -ne 1 -or -not $fact.HasKmemIdentity) {
            $ambiguousEntrypointTasks += $fact
        } else {
            $knownLegacyTasks += $fact
        }
    }
}
if (
    $unknownPlannedTasks.Count -gt 0 -or
    $protectedConflicts.Count -gt 0 -or
    $ambiguousEntrypointTasks.Count -gt 0
) {
    Write-Host "Scheduled-task conflicts require manual inspection; no tasks were changed:" -ForegroundColor Red
    @($unknownPlannedTasks + $protectedConflicts + $ambiguousEntrypointTasks) | ForEach-Object {
        Write-TaskFact $_ Red
    }
    throw "A planned, protected, or ambiguous task action cannot be safely replaced automatically."
}
if ($knownLegacyTasks.Count -gt 0) {
    Write-Host "Known KMEM task actions found:" -ForegroundColor Yellow
    $knownLegacyTasks | ForEach-Object { Write-TaskFact $_ Yellow }
} else {
    Write-Host "Known KMEM task actions found: NONE"
}

if ($CheckOnly) {
    Write-Host ""
    Write-Host "KMEM PRIMARY INSTALL CHECK PASSED - NO SCHEDULED TASKS WERE CHANGED" -ForegroundColor Green
    Write-Host "The full installer may prompt for GitHub login on the display laptop."
    exit 0
}

if ($knownLegacyTasks.Count -gt 0) {
    Write-Host "Only the listed, positively identified KMEM tasks will be replaced or disabled." -ForegroundColor Yellow
    $confirmation = Read-Host "Type REPLACE KMEM TASKS to continue"
    if ($confirmation -cne "REPLACE KMEM TASKS") {
        throw "Task replacement was not confirmed; no tasks were changed."
    }
}

$runStartedUtc = (Get-Date).ToUniversalTime().ToString("o")
Write-Step "Proving updater health with one controlled lease-protected PRIMARY update before changing tasks."
& $runUpdate PRIMARY --require-owned-cycle
if ($LASTEXITCODE -ne 0) {
    throw "The controlled PRIMARY update failed. Review the updater log before retrying."
}

Write-Step "Verifying synchronized Git state and the new PRIMARY heartbeat."
Invoke-Support @("sync", "--repo", $projectDir)
Invoke-Support @("verify-status", "--repo", $projectDir, "--since", $runStartedUtc)

$preexistingPlannedRoot = @{}
foreach ($task in $allTasks) {
    if ($task.TaskName -in $plannedTaskNames -and $task.TaskPath -eq "\") {
        $preexistingPlannedRoot[$task.TaskName] = $true
    }
}
$taskBackups = @()
foreach ($fact in $knownLegacyTasks) {
    $task = $fact.Task
    $taskBackups += [pscustomobject]@{
        TaskName = $task.TaskName
        TaskPath = $task.TaskPath
        Xml = Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
        WasRunning = $task.State -eq "Running"
        MutationAttempted = $false
    }
}

$registrationStarted = $false
try {
    Write-Step "Disabling only the positively identified KMEM tasks before replacement."
    foreach ($backup in $taskBackups) {
        $backup.MutationAttempted = $true
        if ($backup.WasRunning) {
            Stop-ScheduledTask -TaskName $backup.TaskName -TaskPath $backup.TaskPath -ErrorAction Stop
        }
        Disable-ScheduledTask -TaskName $backup.TaskName -TaskPath $backup.TaskPath -ErrorAction Stop | Out-Null
    }

    $registrationStarted = $true
    Write-Step "Installing current PRIMARY server, updater, and display tasks."
    & $displayInstaller `
        -TaskPrefix $taskPrefix `
        -ReplaceExisting `
        -AcknowledgeExistingUpdaterTasks `
        -SkipInitialStart `
        -InitialUpdaterDelayMinutes 10
    if ($LASTEXITCODE -ne 0) {
        throw "Current KMEM display tasks could not be installed."
    }

    Start-ScheduledTask -TaskName "$taskPrefix - Local Server" -ErrorAction Stop
    $serverDeadline = (Get-Date).AddSeconds(30)
    $serverReady = $false
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/" -TimeoutSec 3
            $serverTask = Get-ScheduledTask -TaskName "$taskPrefix - Local Server" -TaskPath "\" -ErrorAction Stop
            $serverReady = (
                $response.StatusCode -eq 200 -and
                $response.Content -match '(?i)<title>\s*KMEM Ops Board\s*</title>' -and
                $serverTask.State -eq "Running"
            )
        } catch {
            $serverReady = $false
        }
        if (-not $serverReady) {
            Start-Sleep -Seconds 1
        }
    } while (-not $serverReady -and (Get-Date) -lt $serverDeadline)
    if (-not $serverReady) {
        throw "The scheduled tasks were installed, but the local board server did not become ready at http://127.0.0.1:8765/."
    }
    Start-ScheduledTask -TaskName "$taskPrefix - Display" -ErrorAction Stop
} catch {
    $installFailure = $_.Exception.Message
    $rollbackFailures = @()
    if ($registrationStarted) {
        foreach ($taskName in $plannedTaskNames) {
            try {
                $currentPlannedTask = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue
                if ($currentPlannedTask) {
                    Stop-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction Stop
                }
            } catch {
                $rollbackFailures += "stop $taskName"
            }
            if (-not $preexistingPlannedRoot.ContainsKey($taskName)) {
                try {
                    $createdTask = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue
                    if ($createdTask) {
                        Unregister-ScheduledTask -TaskName $taskName -TaskPath "\" -Confirm:$false -ErrorAction Stop
                    }
                } catch {
                    $rollbackFailures += "remove $taskName"
                }
            }
        }
    }
    foreach ($backup in @($taskBackups | Where-Object MutationAttempted)) {
        try {
            Register-ScheduledTask `
                -TaskName $backup.TaskName `
                -TaskPath $backup.TaskPath `
                -Xml $backup.Xml `
                -Force `
                -ErrorAction Stop | Out-Null
            if ($backup.WasRunning) {
                Start-ScheduledTask -TaskName $backup.TaskName -TaskPath $backup.TaskPath -ErrorAction Stop
            }
        } catch {
            $rollbackFailures += "restore $($backup.TaskPath)$($backup.TaskName)"
        }
    }
    if ($rollbackFailures.Count -gt 0) {
        throw "PRIMARY installation failed and scheduled-task rollback was incomplete ($($rollbackFailures -join ', ')). Manual task inspection is required. Original failure: $installFailure"
    }
    throw "PRIMARY installation failed; the previous scheduled-task configuration was restored. Original failure: $installFailure"
}

Write-Host ""
Write-Host "KMEM PRIMARY INSTALL COMPLETE" -ForegroundColor Green
Write-Host "Local board: http://localhost:8765/"
Write-Host "Updater cadence: 10 minutes"
Write-Host "Restart or sign out/in if the kiosk display does not open automatically."
