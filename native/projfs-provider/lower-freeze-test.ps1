param(
    [Parameter(Mandatory = $true)]
    [string]$GuardPath
)

$ErrorActionPreference = 'Stop'
$guard = (Resolve-Path $GuardPath).Path
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lower-watcher-native-" + [guid]::NewGuid().ToString('N'))
$lower = Join-Path $testRoot 'lower'
$private = Join-Path $testRoot 'private'
$brokerUuid = [guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $lower, $private | Out-Null

function Start-Watcher([string]$label, [string]$testFailure = '') {
    $state = Join-Path $private "$label-state.json"
    $quarantine = Join-Path $private "$label-quarantine.json"
    $stdout = Join-Path $private "$label-stdout.log"
    $stderr = Join-Path $private "$label-stderr.log"
    $arguments = @('--lower', $lower, '--state', $state, '--quarantine', $quarantine, '--broker-uuid', $brokerUuid)
    if ($testFailure) { $arguments += @('--test-mode', '--test-failure', $testFailure) }
    $process = Start-Process -FilePath $guard -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ((Test-Path $stdout) -and ((Get-Content $stdout -ErrorAction SilentlyContinue) -contains 'LOWER_FREEZE_READY')) {
            return [pscustomobject]@{ Process = $process; State = $state; Quarantine = $quarantine; Stdout = $stdout; Stderr = $stderr }
        }
        if ($process.HasExited) { throw "watcher exited before readiness: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)" }
        Start-Sleep -Milliseconds 20
    }
    throw 'watcher readiness timed out'
}

function Wait-Quarantine($watch, [string]$expectedAction, [string]$expectedName = '') {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path $watch.Quarantine)) { Start-Sleep -Milliseconds 20 }
    if (-not (Test-Path $watch.Quarantine)) { throw "watcher did not quarantine $expectedAction" }
    $details = Get-Content $watch.Quarantine -Raw | ConvertFrom-Json
    $actionMatches = $details.action -eq $expectedAction -or ($expectedAction -eq 'renamed' -and $details.action -like 'renamed_*')
    if ($details.state -ne 'quarantined' -or -not $actionMatches) {
        throw "unexpected quarantine: $($details | ConvertTo-Json -Compress)"
    }
    if ($expectedName -and ([string]$details.path -notlike "*$expectedName*")) {
        throw "expected path $expectedName, got $($details.path)"
    }
    $watch.Process.WaitForExit(10000) | Out-Null
}

$processes = @()
try {
    Set-Content -LiteralPath (Join-Path $lower 'edit.txt') -Value 'baseline'
    New-Item -ItemType Directory -Path (Join-Path $lower '.Vs\UE\v17\ipch') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower '.UgS\CaChE') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower '.cache-data\objects') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower 'nested') | Out-Null
    Set-Content -LiteralPath (Join-Path $lower '.editorconfig') -Value 'editor config'
    Set-Content -LiteralPath (Join-Path $lower '.loreignore') -Value 'lore ignore'
    Set-Content -LiteralPath (Join-Path $lower '.p4ignore.txt') -Value 'p4 ignore'
    Set-Content -LiteralPath (Join-Path $lower '.vsconfig') -Value 'vs config'

    $outside = Start-Watcher 'outside'
    $processes += $outside.Process
    Set-Content -LiteralPath (Join-Path $testRoot 'outside-lower.txt') -Value 'outside'
    Start-Sleep -Milliseconds 500
    $outside.Process.Refresh()
    if ($outside.Process.HasExited -or (Test-Path $outside.Quarantine)) { throw 'outside-lower event was not ignored' }
    Stop-Process -Id $outside.Process.Id
    $outside.Process.WaitForExit(10000) | Out-Null

    foreach ($case in @(
        @{ Label = 'vs-ignore'; Path = '.Vs\UE\v17\ipch\mutable.ipch' },
        @{ Label = 'ugs-ignore'; Path = '.UgS\CaChE\mutable.json' },
        @{ Label = 'generic-ignore'; Path = '.cache-data\objects\mutable.bin' }
    )) {
        $watch = Start-Watcher $case.Label; $processes += $watch.Process
        Set-Content -LiteralPath (Join-Path $lower $case.Path) -Value 'cache write'
        Add-Content -LiteralPath (Join-Path $lower $case.Path) -Value 'cache rewrite'
        Start-Sleep -Milliseconds 300
        $watch.Process.Refresh()
        if ($watch.Process.HasExited -or (Test-Path $watch.Quarantine)) { throw "root dot-directory mutation was not ignored: $($case.Path)" }
        $protectedName = "protected-after-$($case.Label).txt"
        Set-Content -LiteralPath (Join-Path $lower $protectedName) -Value 'source mutation'
        Wait-Quarantine $watch 'added' $protectedName
    }

    foreach ($dotFile in @('.editorconfig', '.loreignore', '.p4ignore.txt', '.vsconfig')) {
        $label = 'dotfile-' + $dotFile.TrimStart('.').Replace('.', '-')
        $watch = Start-Watcher $label; $processes += $watch.Process
        Add-Content -LiteralPath (Join-Path $lower $dotFile) -Value 'protected mutation'
        Wait-Quarantine $watch 'modified' $dotFile
    }

    $nestedDotDirectory = Start-Watcher 'nested-dot-directory'; $processes += $nestedDotDirectory.Process
    New-Item -ItemType Directory -Path (Join-Path $lower 'nested\.vs') | Out-Null
    Wait-Quarantine $nestedDotDirectory 'added' 'nested\.vs'

    $newRootDotDirectory = Start-Watcher 'new-root-dot-directory'; $processes += $newRootDotDirectory.Process
    New-Item -ItemType Directory -Path (Join-Path $lower '.new-cache') | Out-Null
    Set-Content -LiteralPath (Join-Path $lower '.new-cache\private.bin') -Value 'new cache'
    Start-Sleep -Milliseconds 300
    $newRootDotDirectory.Process.Refresh()
    if ($newRootDotDirectory.Process.HasExited -or (Test-Path $newRootDotDirectory.Quarantine)) { throw 'new root dot-directory was not safely recognized' }
    Set-Content -LiteralPath (Join-Path $lower 'protected-after-new-cache.txt') -Value 'source mutation'
    Wait-Quarantine $newRootDotDirectory 'added' 'protected-after-new-cache.txt'

    $newRootDotFile = Start-Watcher 'new-root-dotfile'; $processes += $newRootDotFile.Process
    Set-Content -LiteralPath (Join-Path $lower '.new-dotfile') -Value 'protected dotfile'
    Wait-Quarantine $newRootDotFile 'added' '.new-dotfile'

    New-Item -ItemType Directory -Path (Join-Path $lower '.delete-cache\child') | Out-Null
    Set-Content -LiteralPath (Join-Path $lower '.delete-cache\child\entry.bin') -Value 'delete cache'
    $deleteRootDotDirectory = Start-Watcher 'delete-root-dot-directory'; $processes += $deleteRootDotDirectory.Process
    Remove-Item -LiteralPath (Join-Path $lower '.delete-cache') -Recurse
    Start-Sleep -Milliseconds 300
    $deleteRootDotDirectory.Process.Refresh()
    if ($deleteRootDotDirectory.Process.HasExited -or (Test-Path $deleteRootDotDirectory.Quarantine)) { throw 'exact root dot-directory deletion was not ignored' }
    Set-Content -LiteralPath (Join-Path $lower 'protected-after-delete-cache.txt') -Value 'source mutation'
    Wait-Quarantine $deleteRootDotDirectory 'added' 'protected-after-delete-cache.txt'

    New-Item -ItemType Directory -Path (Join-Path $lower '.rename-cache') | Out-Null
    $renameWithinPolicy = Start-Watcher 'rename-within-policy'; $processes += $renameWithinPolicy.Process
    Rename-Item -LiteralPath (Join-Path $lower '.rename-cache') -NewName '.renamed-cache'
    Set-Content -LiteralPath (Join-Path $lower '.renamed-cache\entry.bin') -Value 'renamed cache'
    Start-Sleep -Milliseconds 300
    $renameWithinPolicy.Process.Refresh()
    if ($renameWithinPolicy.Process.HasExited -or (Test-Path $renameWithinPolicy.Quarantine)) { throw 'root dot-directory rename within policy was not ignored' }
    Set-Content -LiteralPath (Join-Path $lower 'protected-after-dot-rename.txt') -Value 'source mutation'
    Wait-Quarantine $renameWithinPolicy 'added' 'protected-after-dot-rename.txt'

    $renameAcrossBoundary = Start-Watcher 'rename-across-boundary'; $processes += $renameAcrossBoundary.Process
    Rename-Item -LiteralPath (Join-Path $lower '.renamed-cache') -NewName 'renamed-cache'
    Wait-Quarantine $renameAcrossBoundary 'renamed' 'renamed-cache'

    $renameIntoPolicy = Start-Watcher 'rename-into-policy'; $processes += $renameIntoPolicy.Process
    Rename-Item -LiteralPath (Join-Path $lower 'renamed-cache') -NewName '.renamed-cache-again'
    Wait-Quarantine $renameIntoPolicy 'renamed' 'renamed-cache'

    for ($index = 0; $index -lt 8; ++$index) {
        $burst = Start-Watcher "burst-$index"; $processes += $burst.Process
        Set-Content -LiteralPath (Join-Path $lower ".Vs\UE\v17\ipch\burst-$index.ipch") -Value 'cache burst'
        Set-Content -LiteralPath (Join-Path $lower "protected-burst-$index.txt") -Value 'protected burst'
        Wait-Quarantine $burst 'added' "protected-burst-$index.txt"
    }

    $edit = Start-Watcher 'edit'; $processes += $edit.Process
    Add-Content -LiteralPath (Join-Path $lower 'edit.txt') -Value 'changed'
    Wait-Quarantine $edit 'modified' 'edit.txt'

    $create = Start-Watcher 'create'; $processes += $create.Process
    Set-Content -LiteralPath (Join-Path $lower 'create.txt') -Value 'created'
    Wait-Quarantine $create 'added' 'create.txt'

    Set-Content -LiteralPath (Join-Path $lower 'delete.txt') -Value 'delete'
    $delete = Start-Watcher 'delete'; $processes += $delete.Process
    Remove-Item -LiteralPath (Join-Path $lower 'delete.txt')
    Wait-Quarantine $delete 'removed' 'delete.txt'

    Set-Content -LiteralPath (Join-Path $lower 'rename-old.txt') -Value 'rename'
    $rename = Start-Watcher 'rename'; $processes += $rename.Process
    Rename-Item -LiteralPath (Join-Path $lower 'rename-old.txt') -NewName 'rename-new.txt'
    Wait-Quarantine $rename 'renamed'

    $overflow = Start-Watcher 'overflow' 'overflow'; $processes += $overflow.Process
    Wait-Quarantine $overflow 'buffer_overflow'
    $errorWatch = Start-Watcher 'error' 'error'; $processes += $errorWatch.Process
    Wait-Quarantine $errorWatch 'watcher_error'

    [pscustomobject]@{
        ok = $true
        lower = $lower
        events = @('edit', 'create', 'delete', 'rename')
        outsideLowerIgnored = $true
        existingRootDotDirectoriesIgnored = $true
        newRootDotDirectoryRecognized = $true
        rootDotfilesProtected = $true
        nestedDotDirectoriesProtected = $true
        exactDeleteAndRenameHandled = $true
        renameBoundaryProtected = $true
        postIgnoreSourceMutationDetected = $true
        ignoredBurstContinuityIterations = 8
        overflowFailsClosed = $true
        watcherErrorFailsClosed = $true
    } | ConvertTo-Json -Depth 4
}
finally {
    foreach ($process in $processes) {
        try { $process.Refresh(); if (-not $process.HasExited) { Stop-Process -Id $process.Id } } catch {}
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
