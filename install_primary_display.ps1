[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$AfterSync,
    [switch]$EnableLocalDisplay
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$supportScript = Join-Path $projectDir "primary_install_support.py"
$displayInstaller = Join-Path $projectDir "install_display_tasks.ps1"
$runUpdate = Join-Path $projectDir "run_kmem_update.bat"
$hiddenUpdateVbs = Join-Path $projectDir "run_kmem_update_hidden.vbs"
$hiddenUpdatePowerShell = Join-Path $projectDir "run_kmem_update_hidden.ps1"
$wscriptPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) "wscript.exe"
$taskPrefix = "KMEM Ops Board"
$managedTaskNames = @(
    "$taskPrefix - Local Server",
    "$taskPrefix - Weather Update",
    "$taskPrefix - Display",
    "$taskPrefix - Display Watchdog"
)
$desiredTaskNames = @("$taskPrefix - Weather Update")
if ($EnableLocalDisplay) {
    $desiredTaskNames += @("$taskPrefix - Local Server", "$taskPrefix - Display")
}

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
Write-Host "KMEM OPS BOARD - PRIMARY UPDATER INSTALL" -ForegroundColor Green
Write-Host "Repository: $projectDir"
Write-Host "Mode: $(if ($CheckOnly) { 'CHECK ONLY' } else { 'INSTALL' })"
Write-Host "Install mode: $(if ($EnableLocalDisplay) { 'LOCAL DISPLAY OPT-IN' } else { 'HOSTED-ONLY PRIMARY UPDATER' })"
Write-Host ""

if (-not $CheckOnly -and -not (Test-IsAdministrator)) {
    throw "Run INSTALL KMEM DISPLAY - PRIMARY.cmd as Administrator."
}

$requiredFiles = @(
    $supportScript,
    $displayInstaller,
    $runUpdate,
    $hiddenUpdateVbs,
    $hiddenUpdatePowerShell,
    (Join-Path $projectDir "kmem_updater.py"),
    (Join-Path $projectDir "updater_git.py"),
    (Join-Path $projectDir "host_status.json"),
    (Join-Path $projectDir "nms_credentials_local.bat")
)
if ($EnableLocalDisplay) {
    $requiredFiles += @(
        (Join-Path $projectDir "run_kmem_server.bat"),
        (Join-Path $projectDir "launch_kmem_display.bat")
    )
}
foreach ($required in $requiredFiles) {
    Require-File $required "Required package file"
}
Require-File $wscriptPath "Windows Script Host"

Write-Step "Checking Python, Git, and GitHub CLI."
Require-Command "py.exe" "Install Python 3 with the Python Launcher, then rerun this installer."
& py.exe -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.9 or newer is required."
}
Require-Command "git.exe" "Install Git for Windows, then rerun this installer."
Require-Command "gh.exe" "Install GitHub CLI, then rerun this installer."
$edgePath = $null
if ($EnableLocalDisplay) {
    Write-Step "Checking Microsoft Edge for the explicit local-display opt-in."
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
        throw "Microsoft Edge was not found in a standard Program Files location. Install Edge or use hosted-only mode."
    }
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
    if ($EnableLocalDisplay) {
        $restartArguments += "-EnableLocalDisplay"
    }
    & powershell.exe @restartArguments
    exit $LASTEXITCODE
}

Write-Step "Validating FAA NMS authentication and a KMEM NOTAM read."
Invoke-Support @("validate-nms", "--repo", $projectDir)

Write-Step "Inventorying existing scheduled tasks without changing them."
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

function Test-ExactEntrypointToken([string]$Text, [string]$Entrypoint) {
    $escaped = [Regex]::Escape($Entrypoint)
    return [Regex]::IsMatch($Text, "(?i)(?<![A-Za-z0-9_.:-])$escaped(?![A-Za-z0-9_.:-])")
}

function Get-ObjectTextProperty($Object, [string]$Name) {
    if ($null -eq $Object) {
        return ""
    }
    try {
        $property = $Object.PSObject.Properties[$Name]
        if ($null -eq $property -or $null -eq $property.Value) {
            return ""
        }
        return [string]$property.Value
    } catch {
        return ""
    }
}

function Get-LeadingCommandToken([string]$CommandText) {
    $candidate = $CommandText.TrimStart()
    if ($candidate.StartsWith('""')) {
        # cmd.exe /S /C uses one outer command quote before the quoted path.
        $candidate = $candidate.Substring(1)
    }
    if (-not $candidate) {
        return ""
    }

    $commandToken = ""
    if ($candidate.StartsWith('"') -or $candidate.StartsWith("'")) {
        $quote = $candidate.Substring(0, 1)
        $closingQuote = $candidate.IndexOf($quote, 1)
        if ($closingQuote -le 1) {
            return ""
        }
        $commandToken = $candidate.Substring(1, $closingQuote - 1)
    } else {
        $tokenMatch = [Regex]::Match($candidate, '^\S+')
        if (-not $tokenMatch.Success) {
            return ""
        }
        $commandToken = $tokenMatch.Value
    }

    $isBareName = $commandToken -match '^[A-Za-z0-9._-]+$'
    $isDrivePath = $commandToken -match '^[A-Za-z]:[\\/]'
    if (-not ($isBareName -or $isDrivePath)) {
        return ""
    }
    if ($isDrivePath) {
        if (
            $commandToken -match '[\x00-\x1F"<>|?*&,;^]' -or
            $commandToken.Substring(2).Contains(':')
        ) {
            return ""
        }
    }
    return $commandToken
}

function Test-CommandStartsWithEntrypoint([string]$CommandText, [string]$Entrypoint) {
    $commandToken = Get-LeadingCommandToken $CommandText
    if (-not $commandToken) {
        return $false
    }
    try {
        return [IO.Path]::GetFileName($commandToken) -ieq $Entrypoint
    } catch {
        return $false
    }
}

function Test-PrimaryUpdaterRole($Action) {
    $arguments = Get-ObjectTextProperty $Action "Arguments"
    return (
        $arguments -notmatch '(?i)(?:^|\s)BACKUP(?:["'']?\s*$|\s)' -and
        $arguments -match '(?i)(?:^|\s)PRIMARY["'']?\s*$'
    )
}

function Test-ProjectWorkingDirectory([string]$PathValue) {
    if (
        [string]::IsNullOrWhiteSpace($PathValue) -or
        -not [IO.Path]::IsPathRooted($PathValue) -or
        $PathValue -notmatch '^[A-Za-z]:[\\/]'
    ) {
        return $false
    }
    try {
        $candidate = [IO.Path]::GetFullPath($PathValue).TrimEnd('\', '/')
        $expected = [IO.Path]::GetFullPath($projectDir).TrimEnd('\', '/')
        return $candidate.Equals($expected, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-ActionTargetsProjectEntrypoint($Action, [string]$Entrypoint) {
    try {
        $expectedPath = [IO.Path]::GetFullPath((Join-Path $projectDir $Entrypoint))
        $executeText = (Get-ObjectTextProperty $Action "Execute").Trim()
        if (
            $executeText.Length -ge 2 -and
            (($executeText.StartsWith('"') -and $executeText.EndsWith('"')) -or
             ($executeText.StartsWith("'") -and $executeText.EndsWith("'")))
        ) {
            $executeText = $executeText.Substring(1, $executeText.Length - 2)
        }
        if ([IO.Path]::IsPathRooted($executeText)) {
            if (
                [IO.Path]::GetFullPath($executeText).Equals(
                    $expectedPath,
                    [StringComparison]::OrdinalIgnoreCase
                )
            ) {
                return $true
            }
        } elseif (
            $executeText -ieq $Entrypoint -and
            (Test-ProjectWorkingDirectory (Get-ObjectTextProperty $Action "WorkingDirectory"))
        ) {
            return $true
        }

        $arguments = Get-ObjectTextProperty $Action "Arguments"
        $executeName = [IO.Path]::GetFileName($executeText)
        $extension = [IO.Path]::GetExtension($Entrypoint)
        $commandText = ""

        if ($executeName -ieq "cmd.exe" -or $executeName -ieq "cmd") {
            if ($extension -ine ".bat") {
                return $false
            }
            $commandSwitch = [Regex]::Match($arguments, '(?i)^\s*(?:/d\s+)?/c\s+')
            if (-not $commandSwitch.Success) {
                return $false
            }
            $commandText = $arguments.Substring($commandSwitch.Length)
        } elseif ($executeName -ieq "wscript.exe" -or $executeName -ieq "wscript") {
            if ($extension -ine ".vbs") {
                return $false
            }
            $commandText = [Regex]::Replace(
                $arguments,
                '(?i)^\s*(?:(?://B|//NoLogo)\s+)*',
                ''
            )
        } elseif ($executeName -in @("powershell.exe", "powershell", "pwsh.exe", "pwsh")) {
            if (
                $extension -ine ".ps1" -or
                $arguments -match '(?i)(?:^|\s)-(?:Command|EncodedCommand)\b'
            ) {
                return $false
            }
            $fileSwitch = [Regex]::Match(
                $arguments,
                '(?i)^\s*(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+|-WindowStyle\s+Hidden\s+|-ExecutionPolicy\s+Bypass\s+)*-File\s+'
            )
            if (-not $fileSwitch.Success) {
                return $false
            }
            $commandText = $arguments.Substring($fileSwitch.Length)
        } elseif ($executeName -in @("py.exe", "py", "python.exe", "python", "python3.exe", "python3")) {
            if ($extension -ine ".py") {
                return $false
            }
            $commandText = [Regex]::Replace($arguments, '^\s*(?:-\d(?:\.\d+)?)?\s*', '')
        } else {
            return $false
        }

        $commandToken = Get-LeadingCommandToken $commandText
        if (-not $commandToken) {
            return $false
        }
        if ([IO.Path]::IsPathRooted($commandToken)) {
            return [IO.Path]::GetFullPath($commandToken).Equals(
                $expectedPath,
                [StringComparison]::OrdinalIgnoreCase
            )
        }
        return (
            $commandToken -ieq $Entrypoint -and
            (Test-ProjectWorkingDirectory (Get-ObjectTextProperty $Action "WorkingDirectory"))
        )
    } catch {
        return $false
    }
}

function Get-SemanticEntrypoints($Action) {
    try {
        $executeText = Get-ObjectTextProperty $Action "Execute"
        if ([string]::IsNullOrWhiteSpace($executeText)) {
            return @()
        }
        if ($executeText.Length -ge 2 -and $executeText.StartsWith('"') -and $executeText.EndsWith('"')) {
            $executeText = $executeText.Substring(1, $executeText.Length - 2)
        }
        $isBareName = $executeText -match '^[A-Za-z0-9._-]+$'
        $isDrivePath = $executeText -match '^[A-Za-z]:[\\/]'
        $isUncPath = $executeText -match '^\\\\[^\\/]+[\\/][^\\/]+[\\/]'
        $isDevicePath = $executeText -match '^\\\\[.?][\\/]'
        if ($isDevicePath -or $isUncPath -or -not ($isBareName -or $isDrivePath)) {
            return @()
        }
        if (
            -not $isBareName -and (
                $executeText -match '[\x00-\x1F"<>|?*&,;^]' -or
                $executeText -match '\s[\\/]' -or
                $executeText -match '\s[-/][A-Za-z]' -or
                $executeText.Substring(2).Contains(':')
            )
        ) {
            return @()
        }
        $executeName = [IO.Path]::GetFileName($executeText)
        if ($executeName -notmatch '^[A-Za-z0-9._-]+$') {
            return @()
        }
        $isSemanticExecuteName = (
            $knownEntrypointNames -icontains $executeName -or
            $executeName -in @(
                "cmd.exe", "cmd",
                "powershell.exe", "powershell", "pwsh.exe", "pwsh",
                "py.exe", "py", "python.exe", "python", "python3.exe", "python3",
                "wscript.exe", "wscript"
            )
        )
        if (-not $isSemanticExecuteName) {
            return @()
        }
        if (-not $isBareName) {
            # A rooted Execute value can still be arbitrary command text. Only
            # an existing leaf on a non-network drive is accepted as a direct
            # filesystem action; unrelated paths never cause filesystem I/O.
            $driveRoot = [IO.Path]::GetPathRoot($executeText)
            $driveInfo = [IO.DriveInfo]::new($driveRoot)
            if ($driveInfo.DriveType -eq [IO.DriveType]::Network -or -not [IO.File]::Exists($executeText)) {
                return @()
            }
        }
    } catch {
        # Unrelated system/vendor tasks can expose non-filesystem Execute data.
        # Treat it as unrecognized instead of aborting the all-task inventory.
        return @()
    }
    $arguments = Get-ObjectTextProperty $Action "Arguments"
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
        if ($executeName -ieq "wscript.exe" -or $executeName -ieq "wscript") {
            if ($extension -ieq ".vbs") {
                $scriptCommand = [Regex]::Replace(
                    $arguments,
                    '(?i)^\s*(?:(?://B|//NoLogo)\s+)*',
                    ''
                )
                if (Test-CommandStartsWithEntrypoint $scriptCommand $entrypoint) {
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
        "{0} {1} {2}" -f `
            (Get-ObjectTextProperty $_ "Execute"), `
            (Get-ObjectTextProperty $_ "Arguments"), `
            (Get-ObjectTextProperty $_ "WorkingDirectory")
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
    $workingDirectories = @($actions | ForEach-Object {
        Get-ObjectTextProperty $_ "WorkingDirectory"
    } | Where-Object { $_ } | Select-Object -Unique)
    return [pscustomobject]@{
        Task = $Task
        ActionCount = $actions.Count
        Entrypoints = $entrypoints
        WorkingDirectories = $workingDirectories
        HasKmemIdentity = $identityText -match '(?i)(?<![a-z0-9])kmem'
        IsProtected = ("{0} {1} {2}" -f $Task.TaskName, $Task.TaskPath, $actionText) -match $protectedTaskPattern
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

function Get-TaskInventory([object[]]$Tasks) {
    $unknownManagedTasks = @()
    $protectedConflicts = @()
    $ambiguousEntrypointTasks = @()
    $safeKmemTasks = @()
    foreach ($task in $Tasks) {
        $fact = Get-TaskFacts $task
        $hasManagedName = $task.TaskName -in $managedTaskNames
        if ($hasManagedName) {
            $expectedEntrypoint = $expectedEntrypointByTaskName[$task.TaskName]
            $hasExactManagedAction = (
                $task.TaskPath -eq "\" -and
                $fact.ActionCount -eq 1 -and
                $fact.Entrypoints.Count -eq 1 -and
                $expectedEntrypoint -icontains $fact.Entrypoints[0] -and
                (Test-ActionTargetsProjectEntrypoint $task.Actions[0] $fact.Entrypoints[0]) -and
                (
                    $task.TaskName -ne "$taskPrefix - Weather Update" -or
                    (Test-PrimaryUpdaterRole $task.Actions[0])
                )
            )
            if ($fact.IsProtected) {
                $protectedConflicts += $fact
            } elseif (-not $hasExactManagedAction) {
                $unknownManagedTasks += $fact
            } else {
                $safeKmemTasks += $fact
            }
            continue
        }
        if ($fact.Entrypoints.Count -eq 0) {
            if (
                $fact.HasKmemIdentity -and
                $task.TaskName -match '(?i)(?:display|server|watchdog|updater|weather)'
            ) {
                $ambiguousEntrypointTasks += $fact
            }
            continue
        }
        $isExactLegacyDisplayTask = (
            $task.TaskPath -eq "\" -and
            $fact.ActionCount -eq 1 -and
            $fact.Entrypoints.Count -eq 1 -and
            $task.TaskName -match '(?i)(?<![a-z0-9])kmem.*(?:display|server|watchdog)' -and
            $localDisplayEntrypointNames -icontains $fact.Entrypoints[0] -and
            (Test-ActionTargetsProjectEntrypoint $task.Actions[0] $fact.Entrypoints[0]) -and
            $fact.WorkingDirectories.Count -eq 1 -and
            (Test-ProjectWorkingDirectory $fact.WorkingDirectories[0])
        )
        if ($fact.IsProtected) {
            $protectedConflicts += $fact
        } elseif ($isExactLegacyDisplayTask) {
            $safeKmemTasks += $fact
        } else {
            $ambiguousEntrypointTasks += $fact
        }
    }
    return [pscustomobject]@{
        SafeKmemTasks = @($safeKmemTasks)
        UnknownManagedTasks = @($unknownManagedTasks)
        ProtectedConflicts = @($protectedConflicts)
        AmbiguousEntrypointTasks = @($ambiguousEntrypointTasks)
    }
}

function Assert-LosslessTaskBackup([object[]]$Facts) {
    foreach ($fact in $Facts) {
        $principalProperty = $fact.Task.PSObject.Properties["Principal"]
        $principal = if ($null -ne $principalProperty) { $principalProperty.Value } else { $null }
        $logonType = Get-ObjectTextProperty $principal "LogonType"
        if ($logonType -notin @("Interactive", "InteractiveToken", "S4U", "Group", "ServiceAccount")) {
            throw "Task '$($fact.Task.TaskPath)$($fact.Task.TaskName)' uses logon type '$logonType', which cannot be guaranteed to restore without credentials. No tasks were changed."
        }
    }
}

function Assert-SafeTaskInventory($Inventory) {
    $conflicts = @(
        $Inventory.UnknownManagedTasks +
        $Inventory.ProtectedConflicts +
        $Inventory.AmbiguousEntrypointTasks
    )
    if ($conflicts.Count -gt 0) {
        Write-Host "Scheduled-task conflicts require manual inspection; no tasks were changed:" -ForegroundColor Red
        $conflicts | ForEach-Object { Write-TaskFact $_ Red }
        throw "A planned, protected, or ambiguous task action cannot be safely replaced automatically."
    }
}

function Get-ReconciliationDisposition($Fact, [string[]]$DesiredNames) {
    if ($Fact.Task.TaskPath -eq "\" -and $DesiredNames -icontains $Fact.Task.TaskName) {
        return "KEEP"
    }
    return "REMOVE"
}

function Get-SafeTaskInventorySignature($Inventory) {
    $rows = @($Inventory.SafeKmemTasks | ForEach-Object {
        $actionText = @($_.Task.Actions | ForEach-Object {
            "{0}|{1}|{2}" -f `
                (Get-ObjectTextProperty $_ "Execute"), `
                (Get-ObjectTextProperty $_ "Arguments"), `
                (Get-ObjectTextProperty $_ "WorkingDirectory")
        }) -join ";"
        $triggerText = @($_.Task.Triggers | ForEach-Object {
            $repetitionProperty = $_.PSObject.Properties["Repetition"]
            $repetition = if ($null -ne $repetitionProperty) { $repetitionProperty.Value } else { $null }
            "{0}|{1}|{2}" -f `
                (Get-ObjectTextProperty $_ "StartBoundary"), `
                (Get-ObjectTextProperty $_ "Delay"), `
                (Get-ObjectTextProperty $repetition "Interval")
        }) -join ";"
        $principalProperty = $_.Task.PSObject.Properties["Principal"]
        $principal = if ($null -ne $principalProperty) { $principalProperty.Value } else { $null }
        $settingsProperty = $_.Task.PSObject.Properties["Settings"]
        $settings = if ($null -ne $settingsProperty) { $settingsProperty.Value } else { $null }
        $principalText = "{0}|{1}|{2}" -f `
            (Get-ObjectTextProperty $principal "UserId"), `
            (Get-ObjectTextProperty $principal "LogonType"), `
            (Get-ObjectTextProperty $principal "RunLevel")
        $settingsText = "{0}|{1}|{2}" -f `
            (Get-ObjectTextProperty $settings "MultipleInstances"), `
            (Get-ObjectTextProperty $settings "ExecutionTimeLimit"), `
            (Get-ObjectTextProperty $settings "Enabled")
        "{0}|{1}|{2}|{3}|{4}|{5}" -f $_.Task.TaskPath, $_.Task.TaskName, $actionText, $triggerText, $principalText, $settingsText
    } | Sort-Object)
    return $rows -join "`n"
}

function Write-TaskInventory($Inventory) {
    if ($Inventory.SafeKmemTasks.Count -eq 0) {
        Write-Host "Known KMEM task actions found: NONE"
        return
    }
    Write-Host "Positively identified KMEM task actions:" -ForegroundColor Yellow
    foreach ($fact in $Inventory.SafeKmemTasks) {
        $disposition = Get-ReconciliationDisposition $fact $desiredTaskNames
        Write-TaskFact $fact Yellow
        Write-Host "    RECONCILIATION ACTION: $disposition" -ForegroundColor Yellow
    }
}

$allTasks = @(Get-ScheduledTask -ErrorAction Stop)
$taskInventory = Get-TaskInventory $allTasks
Assert-SafeTaskInventory $taskInventory
Assert-LosslessTaskBackup $taskInventory.SafeKmemTasks
Write-TaskInventory $taskInventory

if ($CheckOnly) {
    Write-Host ""
    Write-Host "KMEM PRIMARY INSTALL CHECK PASSED - NO SCHEDULED TASKS WERE CHANGED" -ForegroundColor Green
    Write-Host "Default full install will keep only the Weather Update task with its hidden launcher."
    Write-Host "The full installer may prompt for GitHub login on the PRIMARY updater laptop."
    exit 0
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

$allTasks = @(Get-ScheduledTask -ErrorAction Stop)
$taskInventory = Get-TaskInventory $allTasks
Assert-SafeTaskInventory $taskInventory
Assert-LosslessTaskBackup $taskInventory.SafeKmemTasks
Write-Step "Revalidated scheduled-task inventory immediately before reconciliation."
Write-TaskInventory $taskInventory
$approvedInventorySignature = Get-SafeTaskInventorySignature $taskInventory
if ($taskInventory.SafeKmemTasks.Count -gt 0) {
    Write-Host "Only the listed, positively identified KMEM tasks will be reconciled or removed." -ForegroundColor Yellow
    $confirmation = Read-Host "Type REPLACE KMEM TASKS to continue"
    if ($confirmation -cne "REPLACE KMEM TASKS") {
        throw "Task replacement was not confirmed; no tasks were changed."
    }
}

$allTasks = @(Get-ScheduledTask -ErrorAction Stop)
$taskInventory = Get-TaskInventory $allTasks
Assert-SafeTaskInventory $taskInventory
Assert-LosslessTaskBackup $taskInventory.SafeKmemTasks
if ((Get-SafeTaskInventorySignature $taskInventory) -cne $approvedInventorySignature) {
    throw "The KMEM scheduled-task inventory changed before reconciliation; no tasks were changed."
}
$safeKmemTasks = @($taskInventory.SafeKmemTasks)
$obsoleteTaskFacts = @($safeKmemTasks | Where-Object {
    (Get-ReconciliationDisposition $_ $desiredTaskNames) -eq "REMOVE"
})

$preexistingDesiredRoot = @{}
foreach ($task in $allTasks) {
    if ($task.TaskName -in $desiredTaskNames -and $task.TaskPath -eq "\") {
        $preexistingDesiredRoot[$task.TaskName] = $true
    }
}
$taskBackups = @()
foreach ($fact in $safeKmemTasks) {
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
    Write-Step "Installing the PRIMARY Weather Update task with its hidden launcher."
    & $displayInstaller `
        -TaskPrefix $taskPrefix `
        -ReplaceExisting `
        -AcknowledgeExistingUpdaterTasks `
        -SkipInitialStart `
        -EnableLocalDisplay:$EnableLocalDisplay `
        -InitialUpdaterDelayMinutes 10

    $weatherTask = Get-ScheduledTask -TaskName "$taskPrefix - Weather Update" -TaskPath "\" -ErrorAction Stop
    $weatherFact = Get-TaskFacts $weatherTask
    $weatherAction = $weatherTask.Actions[0]
    $expectedWeatherArguments = "//B //NoLogo `"$hiddenUpdateVbs`" PRIMARY"
    $hasExactWeatherAction = (
        [IO.Path]::GetFullPath([string]$weatherAction.Execute).Equals(
            [IO.Path]::GetFullPath($wscriptPath),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string]$weatherAction.Arguments -ceq $expectedWeatherArguments -and
        (Test-ProjectWorkingDirectory ([string]$weatherAction.WorkingDirectory))
    )
    $hasExactWeatherPolicy = (
        @($weatherTask.Triggers).Count -eq 1 -and
        [string]$weatherTask.Triggers[0].Repetition.Interval -eq "PT10M" -and
        [string]$weatherTask.Settings.MultipleInstances -eq "IgnoreNew" -and
        [string]$weatherTask.Settings.ExecutionTimeLimit -eq "PT30M"
    )
    if (
        $weatherFact.ActionCount -ne 1 -or
        $weatherFact.Entrypoints.Count -ne 1 -or
        $weatherFact.Entrypoints[0] -ine "run_kmem_update_hidden.vbs" -or
        -not (Test-PrimaryUpdaterRole $weatherTask.Actions[0]) -or
        -not $hasExactWeatherAction -or
        -not $hasExactWeatherPolicy -or
        $weatherTask.State -eq "Disabled"
    ) {
        throw "The installed Weather Update task did not match the required hidden PRIMARY action."
    }

    if ($obsoleteTaskFacts.Count -gt 0) {
        Write-Step "Removing only positively identified obsolete KMEM local-server/display tasks."
        foreach ($fact in $obsoleteTaskFacts) {
            Unregister-ScheduledTask `
                -TaskName $fact.Task.TaskName `
                -TaskPath $fact.Task.TaskPath `
                -Confirm:$false `
                -ErrorAction Stop
        }
    }

    $finalInventory = Get-TaskInventory @(Get-ScheduledTask -ErrorAction Stop)
    Assert-SafeTaskInventory $finalInventory
    if ($finalInventory.SafeKmemTasks.Count -ne $desiredTaskNames.Count) {
        throw "The final KMEM scheduled-task inventory did not match the requested install mode."
    }
    foreach ($taskName in $desiredTaskNames) {
        $matching = @($finalInventory.SafeKmemTasks | Where-Object {
            $_.Task.TaskName -eq $taskName -and $_.Task.TaskPath -eq "\"
        })
        if ($matching.Count -ne 1) {
            throw "The final KMEM scheduled-task inventory is missing the exact task '$taskName'."
        }
    }

    if ($EnableLocalDisplay) {
        Start-ScheduledTask -TaskName "$taskPrefix - Local Server" -TaskPath "\" -ErrorAction Stop
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
            throw "The opt-in local board server did not become ready at http://127.0.0.1:8765/."
        }
        Start-ScheduledTask -TaskName "$taskPrefix - Display" -TaskPath "\" -ErrorAction Stop
    }
} catch {
    $installFailure = $_.Exception.Message
    $rollbackFailures = @()
    if ($registrationStarted) {
        foreach ($taskName in $desiredTaskNames) {
            try {
                $currentPlannedTask = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue
                if ($currentPlannedTask -and $currentPlannedTask.State -eq "Running") {
                    Stop-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction Stop
                }
            } catch {
                $rollbackFailures += "stop $taskName"
            }
            if (-not $preexistingDesiredRoot.ContainsKey($taskName)) {
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
Write-Host "KMEM PRIMARY UPDATER INSTALL COMPLETE" -ForegroundColor Green
Write-Host "Hosted board: https://btenner1013.github.io/kmem-ops-board/"
Write-Host "Local server/display tasks: $(if ($EnableLocalDisplay) { 'INSTALLED BY EXPLICIT OPT-IN' } else { 'NOT INSTALLED' })"
Write-Host "Updater cadence: 10 minutes"
Write-Host "Scheduled task: $taskPrefix - Weather Update"
