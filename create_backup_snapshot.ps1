[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [string]$Source,
    [string]$ExpectedSourceSha,
    [switch]$Replace,
    [switch]$DryRun,
    [switch]$AllowVerifiedUsbRecoveryCheckout
)

$ErrorActionPreference = "Stop"
if (-not $Source) {
    $Source = Split-Path -Parent $MyInvocation.MyCommand.Path
}

function Normalize-AbsolutePath([string]$PathValue) {
    return [System.IO.Path]::GetFullPath($PathValue).TrimEnd('\')
}

function Test-IsWithin([string]$Candidate, [string]$Parent) {
    $prefix = $Parent.TrimEnd('\') + '\'
    return $Candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Normalize-GitRemote([string]$RemoteValue) {
    $value = $RemoteValue.Trim()
    if ($value -match '^git@([^:]+):(.+)$') {
        $identity = "$($Matches[1])/$($Matches[2])"
    } else {
        try {
            $uri = [System.Uri]$value
            if (-not $uri.Host) { return "" }
            if ($uri.Scheme -notin @("https", "ssh")) { return "" }
            if ($uri.Query -or $uri.Fragment -or -not $uri.IsDefaultPort) { return "" }
            if ($uri.Scheme -eq "ssh" -and $uri.UserInfo -ne "git") { return "" }
            if ($uri.Scheme -eq "https" -and $uri.UserInfo) { return "" }
            $identity = "$($uri.Host)$($uri.AbsolutePath)"
        } catch {
            return ""
        }
    }
    $identity = $identity.TrimEnd('/')
    if ($identity.EndsWith('.git', [System.StringComparison]::OrdinalIgnoreCase)) {
        $identity = $identity.Substring(0, $identity.Length - 4)
    }
    return $identity.ToLowerInvariant()
}

function Assert-NoReparseAncestor([string]$PathValue, [string]$Label) {
    $cursor = Normalize-AbsolutePath $PathValue
    while (-not (Test-Path -LiteralPath $cursor)) {
        $parent = [System.IO.Directory]::GetParent($cursor)
        if (-not $parent) {
            throw "$Label has no existing ancestor that can be validated."
        }
        $cursor = $parent.FullName
    }
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label uses a reparse-point path component: $cursor"
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if (-not $parent) { break }
        $cursor = $parent.FullName
    }
}

function Get-TreeFingerprint([string]$Root, [string]$ExcludeTopLevelName = "") {
    $rootPath = Normalize-AbsolutePath $Root
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
        throw "Tree fingerprint root does not exist: $rootPath"
    }
    $entries = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force -ErrorAction Stop | Sort-Object FullName)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Tree fingerprint rejected reparse point: $($item.FullName)"
        }
        $relative = $item.FullName.Substring($rootPath.Length).TrimStart('\').Replace('\', '/')
        $topLevel = ($relative -split '/', 2)[0]
        if ($ExcludeTopLevelName -and $topLevel -eq $ExcludeTopLevelName) {
            continue
        }
        if ($item.PSIsContainer) {
            $entries.Add("D|$relative")
        } else {
            $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
            $entries.Add("F|$relative|$($item.Length)|$hash")
        }
    }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $payload = [System.Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
        $digest = ([System.BitConverter]::ToString($sha256.ComputeHash($payload))).Replace('-', '')
    } finally {
        $sha256.Dispose()
    }
    return [pscustomobject]@{
        Digest = $digest
        Count = $entries.Count
        Entries = @($entries)
    }
}

function Assert-TreeFingerprintMatch($Expected, $Actual, [string]$Phase) {
    if ($Expected.Count -ne $Actual.Count -or $Expected.Digest -ne $Actual.Digest) {
        $expectedSet = @($Expected.Entries)
        $actualSet = @($Actual.Entries)
        $difference = Compare-Object -ReferenceObject $expectedSet -DifferenceObject $actualSet |
            Select-Object -First 1
        $detail = if ($difference) { " First difference: $($difference.InputObject) [$($difference.SideIndicator)]" } else { "" }
        throw "$Phase complete-tree verification failed.$detail"
    }
}

function Get-BackupMutexName([string]$PathValue) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $payload = [System.Text.Encoding]::UTF8.GetBytes((Normalize-AbsolutePath $PathValue).ToLowerInvariant())
        $digest = ([System.BitConverter]::ToString($sha256.ComputeHash($payload))).Replace('-', '')
    } finally {
        $sha256.Dispose()
    }
    return "Global\KMEMBackup-$digest"
}

function Write-TransactionJournal([string]$PathValue, $Journal) {
    $Journal["UpdatedUtc"] = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $Journal | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PathValue -Encoding UTF8 -ErrorAction Stop
}

$sourcePath = Normalize-AbsolutePath $Source
$destinationPath = Normalize-AbsolutePath $Destination
$desktopTarget = Normalize-AbsolutePath (Join-Path $env:USERPROFILE "Desktop\KMEM Ops Board Portable")
$usbTarget = Normalize-AbsolutePath "E:\KMEM-Ops-Board-Shop-Display"
$approvedTargets = @($desktopTarget, $usbTarget)

if ($destinationPath -notin $approvedTargets) {
    throw "Destination is not one of the two approved KMEM backup targets."
}
if ($destinationPath -eq (Normalize-AbsolutePath ([System.IO.Path]::GetPathRoot($destinationPath)))) {
    throw "A drive root can never be used as a backup target."
}
if ($destinationPath -eq (Normalize-AbsolutePath (Join-Path $env:USERPROFILE "Desktop"))) {
    throw "The Desktop root can never be used as a backup target."
}
if ($sourcePath -eq $destinationPath -or (Test-IsWithin $destinationPath $sourcePath)) {
    throw "Source and destination overlap; refusing to replace a development checkout."
}
if (Test-IsWithin $sourcePath $destinationPath) {
    throw "The approved target contains the active source checkout; this copy operation is blocked."
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
    throw "Authoritative source directory does not exist."
}
Assert-NoReparseAncestor $sourcePath "Source"

$repoRoot = (& git -C $sourcePath rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or (Normalize-AbsolutePath $repoRoot) -ne $sourcePath) {
    throw "Source is not the root of the authoritative Git checkout."
}
$branch = (& git -C $sourcePath symbolic-ref --quiet --short HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
    throw "Source checkout must be on main."
}
$dirty = @(& git -C $sourcePath status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Source checkout is not clean; no backup will be created."
}
$canonicalRemote = "github.com/btenner1013/kmem-ops-board"
$fetchRemote = ([string](& git -C $sourcePath remote get-url origin 2>$null)).Trim()
$fetchRemoteExit = $LASTEXITCODE
$pushRemote = ([string](& git -C $sourcePath remote get-url --push origin 2>$null)).Trim()
$pushRemoteExit = $LASTEXITCODE
if (
    $fetchRemoteExit -ne 0 -or
    $pushRemoteExit -ne 0 -or
    (Normalize-GitRemote $fetchRemote) -ne $canonicalRemote -or
    (Normalize-GitRemote $pushRemote) -ne $canonicalRemote
) {
    throw "Source origin does not match the canonical KMEM repository."
}

$priorTerminalPrompt = $env:GIT_TERMINAL_PROMPT
$priorCredentialInteraction = $env:GCM_INTERACTIVE
try {
    $env:GIT_TERMINAL_PROMPT = "0"
    $env:GCM_INTERACTIVE = "Never"
    & git -C $sourcePath fetch --no-tags origin main
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to fetch authoritative origin/main; no backup will be created."
    }
} finally {
    $env:GIT_TERMINAL_PROMPT = $priorTerminalPrompt
    $env:GCM_INTERACTIVE = $priorCredentialInteraction
}

$sourceSha = (& git -C $sourcePath rev-parse HEAD).Trim()
$originSha = (& git -C $sourcePath rev-parse origin/main).Trim()
if ($sourceSha -ne $originSha) {
    throw "Source HEAD is not synchronized with origin/main."
}
if ($ExpectedSourceSha -and $sourceSha -ne $ExpectedSourceSha) {
    throw "Source SHA does not match -ExpectedSourceSha."
}
if (-not $DryRun -and -not $ExpectedSourceSha) {
    throw "Replacement requires -ExpectedSourceSha pinned to the validated pushed release."
}

$backupMutex = [System.Threading.Mutex]::new($false, (Get-BackupMutexName $destinationPath))
$backupMutexAcquired = $false
try {
    try {
        $backupMutexAcquired = $backupMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $backupMutexAcquired = $true
    }
    if (-not $backupMutexAcquired) {
        throw "Another backup operation is already validating or replacing this exact target."
    }

Assert-NoReparseAncestor $destinationPath "Destination"
$gitCheckoutMarkers = @()
if (Test-Path -LiteralPath $destinationPath) {
    $destinationRootItem = Get-Item -LiteralPath $destinationPath -Force
    if (($destinationRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Destination is a reparse point; refusing recursive replacement."
    }
    $pendingTransaction = Get-ChildItem -LiteralPath $destinationPath -Force -ErrorAction Stop |
        Where-Object { $_.Name -like ".kmem-backup-transaction-*" } |
        Select-Object -First 1
    if ($pendingTransaction) {
        throw "Destination contains an unfinished backup transaction; inspect it before retrying."
    }
    $gitCheckoutMarkers = @(
        if (Test-Path -LiteralPath (Join-Path $destinationPath ".git")) {
            Get-Item -LiteralPath (Join-Path $destinationPath ".git") -Force -ErrorAction Stop
        }
        Get-ChildItem -LiteralPath $destinationPath -Recurse -Force -ErrorAction Stop |
            Where-Object { $_.Name -eq ".git" }
    ) | Sort-Object FullName -Unique
    $reparsePoint = Get-ChildItem -LiteralPath $destinationPath -Recurse -Force -ErrorAction Stop |
        Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } |
        Select-Object -First 1
    if ($reparsePoint) {
        throw "Destination contains a reparse point; refusing recursive replacement."
    }
}

if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $referencingTasks = @(
        Get-ScheduledTask | Where-Object {
            $taskText = (@($_.Actions) | ForEach-Object { "{0} {1} {2}" -f $_.Execute, $_.Arguments, $_.WorkingDirectory }) -join " "
            $taskText.IndexOf($destinationPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
    )
    if ($referencingTasks.Count -gt 0) {
        $taskNames = ($referencingTasks | ForEach-Object TaskName) -join ", "
        throw "Destination is referenced by scheduled task(s): $taskNames"
    }
}

if ($AllowVerifiedUsbRecoveryCheckout -and ($destinationPath -ne $usbTarget -or -not $Replace)) {
    throw "The recovery-checkout override is valid only with -Replace for the exact approved USB target."
}

if ($gitCheckoutMarkers.Count -gt 0) {
    if (-not $AllowVerifiedUsbRecoveryCheckout) {
        throw "Destination contains a Git checkout; refusing to replace a possible active updater checkout."
    }
    if ($gitCheckoutMarkers.Count -ne 1) {
        throw "The USB target contains more than one Git checkout; recovery identity is ambiguous."
    }

    $driveId = [System.IO.Path]::GetPathRoot($destinationPath).TrimEnd('\')
    $drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$driveId'" -ErrorAction Stop
    if (-not $drive -or [int]$drive.DriveType -ne 2) {
        throw "The recovery-checkout override requires the exact target to be on removable media."
    }

    $referencingProcesses = @(
        Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -and
            $_.CommandLine.IndexOf($destinationPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
    )
    if ($referencingProcesses.Count -gt 0) {
        throw "The USB target is referenced by a running process; refusing recovery replacement."
    }

    $recoveryRepo = Normalize-AbsolutePath (Split-Path -Parent $gitCheckoutMarkers[0].FullName)
    $safeRecoveryRepo = $recoveryRepo.Replace('\', '/')
    $recoveryRemote = ([string](& git -c "safe.directory=$safeRecoveryRepo" -C $recoveryRepo remote get-url origin 2>$null)).Trim()
    if ($LASTEXITCODE -ne 0 -or (Normalize-GitRemote $recoveryRemote) -ne $canonicalRemote) {
        throw "The USB checkout does not match the canonical KMEM repository."
    }
    $recoveryBranch = ([string](& git -c "safe.directory=$safeRecoveryRepo" -C $recoveryRepo symbolic-ref --quiet --short HEAD 2>$null)).Trim()
    if ($LASTEXITCODE -ne 0 -or $recoveryBranch -ne "main") {
        throw "The USB recovery checkout must be on main."
    }
    $recoveryDirty = @(& git -c "safe.directory=$safeRecoveryRepo" -C $recoveryRepo status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0 -or $recoveryDirty.Count -ne 0) {
        throw "The USB recovery checkout is dirty; refusing to delete possible local work."
    }
    $recoverySha = ([string](& git -c "safe.directory=$safeRecoveryRepo" -C $recoveryRepo rev-parse HEAD 2>$null)).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to resolve the USB recovery checkout SHA."
    }
    & git -C $sourcePath merge-base --is-ancestor $recoverySha $sourceSha
    if ($LASTEXITCODE -ne 0) {
        throw "The USB recovery checkout is not an ancestor of the validated release."
    }
    Write-Host "Verified inactive USB recovery checkout at $recoverySha; replacement is authorized."
}

if (-not $Replace -and -not $DryRun) {
    throw "Replacement requires the explicit -Replace switch."
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("kmem-backup-" + [guid]::NewGuid().ToString("N"))
$stagingPath = Join-Path $temporaryRoot "snapshot"
$archivePath = Join-Path $temporaryRoot "snapshot.zip"
New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null

try {
    & git -C $sourcePath archive --format=zip --output=$archivePath $sourceSha
    if ($LASTEXITCODE -ne 0) {
        throw "git archive failed."
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingPath -Force

    $manifest = @(
        "KMEM Ops Board Backup",
        "Source SHA: $sourceSha",
        "Created UTC: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))",
        "Branch: main",
        "Purpose: Recovery / portable backup",
        "Self-sync active in source release: YES"
    )
    Set-Content -LiteralPath (Join-Path $stagingPath "KMEM_BACKUP_VERSION.txt") -Value $manifest -Encoding UTF8

    $requiredFiles = @(
        "index.html",
        "weather.json",
        "radar.gif",
        "atis_history.json",
        "taf_current.json",
        "host_status.json",
        "updater_lease.json",
        "update_weather_local.py",
        "kmem_updater.py",
        "updater_git.py",
        "run_kmem_update.bat",
        "run_kmem_daemon.bat",
        "run_kmem_server.bat",
        "launch_kmem_display.bat",
        "install_display_tasks.ps1",
        "install_updater_task.ps1",
        "Install Primary Updater Task.cmd",
        "Install Backup Updater Task.cmd",
        "KMEM Backup Update Now.cmd",
        "KMEM_BACKUP_VERSION.txt"
    )
    foreach ($relative in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagingPath $relative) -PathType Leaf)) {
            throw "Snapshot verification failed; missing $relative"
        }
    }

    $forbidden = Get-ChildItem -LiteralPath $stagingPath -Recurse -Force | Where-Object {
        $_.Name -eq ".git" -or
        $_.Name -eq "__pycache__" -or
        $_.Name -eq ".pytest_cache" -or
        $_.Name -eq "node_modules" -or
        $_.Name -eq ".venv" -or
        $_.Name -eq "venv" -or
        $_.Name -eq ".env" -or
        $_.Name -like ".env.*" -or
        $_.Name -like "*.log" -or
        $_.Name -like "*.pdf" -or
        $_.Name -like "*.pem" -or
        $_.Name -like "*.key" -or
        $_.Name -like "*.pfx" -or
        $_.Name -like "*.p12" -or
        $_.Name -like "id_rsa*" -or
        $_.Name -like "id_ed25519*" -or
        (($_.Name -like "*credentials*" -or $_.Name -like "*secret*" -or $_.Name -like "*token*") -and $_.Name -notlike "*.example.*")
    } | Select-Object -First 1
    if ($forbidden) {
        throw "Snapshot contains forbidden development/runtime content: $($forbidden.Name)"
    }

    Write-Host "Validated backup target: $destinationPath"
    Write-Host "BACKUP SOURCE SHA: $sourceSha"
    if ($DryRun) {
        Write-Host "Dry run complete; destination was not changed." -ForegroundColor Green
        return
    }

    $stagedFingerprint = Get-TreeFingerprint $stagingPath
    $destinationCreated = -not (Test-Path -LiteralPath $destinationPath)
    if ($destinationCreated) {
        New-Item -ItemType Directory -Path $destinationPath | Out-Null
    }

    $transactionName = ".kmem-backup-transaction-$([guid]::NewGuid().ToString('N'))"
    $transactionPath = Join-Path $destinationPath $transactionName
    $incomingPath = Join-Path $transactionPath "incoming"
    $previousPath = Join-Path $transactionPath "previous"
    $journalPath = Join-Path $transactionPath "journal.json"
    $movedOriginalNames = [System.Collections.Generic.List[string]]::new()
    $installedNames = [System.Collections.Generic.List[string]]::new()
    $rollbackErrors = [System.Collections.Generic.List[string]]::new()
    $replacementCommitted = $false
    $originalFingerprint = $null
    $journal = $null
    try {
        New-Item -ItemType Directory -Path $incomingPath -Force | Out-Null
        New-Item -ItemType Directory -Path $previousPath -Force | Out-Null

        $originalFingerprint = Get-TreeFingerprint $destinationPath $transactionName
        $originalItems = @(
            Get-ChildItem -LiteralPath $destinationPath -Force -ErrorAction Stop |
                Where-Object { $_.Name -ne $transactionName }
        )
        $newTopLevelNames = @(
            Get-ChildItem -LiteralPath $stagingPath -Force -ErrorAction Stop |
                ForEach-Object Name
        )

        Get-ChildItem -LiteralPath $stagingPath -Force -ErrorAction Stop |
            Copy-Item -Destination $incomingPath -Recurse -Force -ErrorAction Stop
        $incomingFingerprint = Get-TreeFingerprint $incomingPath
        Assert-TreeFingerprintMatch $stagedFingerprint $incomingFingerprint "Incoming backup"

        $journal = [ordered]@{
            FormatVersion = 1
            SourceSha = $sourceSha
            Phase = "PREPARED"
            StagedTreeDigest = $stagedFingerprint.Digest
            OriginalTreeDigest = $originalFingerprint.Digest
            OriginalTopLevelNames = @($originalItems | ForEach-Object Name)
            NewTopLevelNames = @($newTopLevelNames)
            StartedUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            UpdatedUtc = ""
            Errors = @()
        }
        Write-TransactionJournal $journalPath $journal

        foreach ($item in $originalItems) {
            Move-Item -LiteralPath $item.FullName -Destination $previousPath -ErrorAction Stop
            [void]$movedOriginalNames.Add($item.Name)
        }
        $journal["Phase"] = "ORIGINAL_MOVED"
        Write-TransactionJournal $journalPath $journal

        foreach ($item in @(Get-ChildItem -LiteralPath $incomingPath -Force -ErrorAction Stop)) {
            Move-Item -LiteralPath $item.FullName -Destination $destinationPath -ErrorAction Stop
            [void]$installedNames.Add($item.Name)
        }

        $finalFingerprint = Get-TreeFingerprint $destinationPath $transactionName
        Assert-TreeFingerprintMatch $stagedFingerprint $finalFingerprint "Final backup"
        foreach ($relative in $requiredFiles) {
            if (-not (Test-Path -LiteralPath (Join-Path $destinationPath $relative) -PathType Leaf)) {
                throw "Final backup verification failed; missing $relative"
            }
        }
        $copiedManifest = Get-Content -LiteralPath (Join-Path $destinationPath "KMEM_BACKUP_VERSION.txt") -Raw -ErrorAction Stop
        if ($copiedManifest -notmatch [regex]::Escape($sourceSha)) {
            throw "Final backup manifest does not contain the authoritative source SHA."
        }
        $journal["Phase"] = "COMMITTED"
        Write-TransactionJournal $journalPath $journal
        $replacementCommitted = $true
    } catch {
        $originalFailure = $_
        if ($journal -and (Test-Path -LiteralPath $transactionPath)) {
            try {
                $journal["Phase"] = "ROLLING_BACK"
                Write-TransactionJournal $journalPath $journal
            } catch {
                [void]$rollbackErrors.Add("Could not update rollback journal: $($_.Exception.Message)")
            }
        }

        foreach ($name in @($installedNames)) {
            try {
                $installedPath = Join-Path $destinationPath $name
                if (Test-Path -LiteralPath $installedPath) {
                    Remove-Item -LiteralPath $installedPath -Recurse -Force -ErrorAction Stop
                }
            } catch {
                [void]$rollbackErrors.Add("Could not remove installed item '$name': $($_.Exception.Message)")
            }
        }
        foreach ($name in @($movedOriginalNames)) {
            try {
                $previousItem = Join-Path $previousPath $name
                $restoredItem = Join-Path $destinationPath $name
                if (-not (Test-Path -LiteralPath $previousItem)) {
                    if (-not (Test-Path -LiteralPath $restoredItem)) {
                        throw "Original item is absent from both previous and destination."
                    }
                    continue
                }
                if (Test-Path -LiteralPath $restoredItem) {
                    throw "Restore destination already exists."
                }
                Move-Item -LiteralPath $previousItem -Destination $destinationPath -ErrorAction Stop
            } catch {
                [void]$rollbackErrors.Add("Could not restore original item '$name': $($_.Exception.Message)")
            }
        }

        if ($originalFingerprint) {
            try {
                $restoredFingerprint = Get-TreeFingerprint $destinationPath $transactionName
                Assert-TreeFingerprintMatch $originalFingerprint $restoredFingerprint "Rollback"
            } catch {
                [void]$rollbackErrors.Add($_.Exception.Message)
            }
        }
        try {
            if (Test-Path -LiteralPath $previousPath) {
                $remainingPrevious = @(Get-ChildItem -LiteralPath $previousPath -Force -ErrorAction Stop)
                if ($remainingPrevious.Count -ne 0) {
                    throw "Previous snapshot area still contains $($remainingPrevious.Count) item(s)."
                }
            }
        } catch {
            [void]$rollbackErrors.Add($_.Exception.Message)
        }

        if ($rollbackErrors.Count -eq 0 -and (Test-Path -LiteralPath $transactionPath)) {
            try {
                if ($journal) {
                    $journal["Phase"] = "ROLLED_BACK"
                    Write-TransactionJournal $journalPath $journal
                }
                Remove-Item -LiteralPath $transactionPath -Recurse -Force -ErrorAction Stop
            } catch {
                [void]$rollbackErrors.Add("Could not remove completed rollback transaction: $($_.Exception.Message)")
            }
        }
        if ($rollbackErrors.Count -eq 0 -and $destinationCreated) {
            try {
                $remainingDestination = @(Get-ChildItem -LiteralPath $destinationPath -Force -ErrorAction Stop)
                if ($remainingDestination.Count -ne 0) {
                    throw "New destination is not empty after rollback."
                }
                Remove-Item -LiteralPath $destinationPath -Force -ErrorAction Stop
            } catch {
                [void]$rollbackErrors.Add("Could not remove new empty destination: $($_.Exception.Message)")
            }
        }
        if ($rollbackErrors.Count -ne 0) {
            if ($journal -and (Test-Path -LiteralPath $transactionPath)) {
                try {
                    $journal["Phase"] = "ROLLBACK_INCOMPLETE"
                    $journal["Errors"] = @($rollbackErrors)
                    Write-TransactionJournal $journalPath $journal
                } catch {
                    [void]$rollbackErrors.Add("Could not record incomplete rollback: $($_.Exception.Message)")
                }
            }
            $rollbackDetail = @($rollbackErrors) -join " | "
            throw "Backup replacement failed and rollback is incomplete. Inspect '$transactionPath'. Original error: $($originalFailure.Exception.Message). Rollback errors: $rollbackDetail"
        }
        throw $originalFailure
    }

    if ($replacementCommitted) {
        try {
            Remove-Item -LiteralPath $transactionPath -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Warning "Backup is valid, but the internal previous-snapshot transaction could not be removed. Inspect $transactionPath before the next replacement."
        }
    }
    Write-Host "Backup snapshot replaced transactionally and verified." -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
} finally {
    if ($backupMutexAcquired) {
        $backupMutex.ReleaseMutex()
    }
    $backupMutex.Dispose()
}
