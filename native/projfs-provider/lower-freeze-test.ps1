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
    $outside = Start-Watcher 'outside'
    $processes += $outside.Process
    Set-Content -LiteralPath (Join-Path $testRoot 'outside-lower.txt') -Value 'outside'
    Start-Sleep -Milliseconds 500
    $outside.Process.Refresh()
    if ($outside.Process.HasExited -or (Test-Path $outside.Quarantine)) { throw 'outside-lower event was not ignored' }
    Stop-Process -Id $outside.Process.Id
    $outside.Process.WaitForExit(10000) | Out-Null

    $vsIgnore = Start-Watcher 'vs-ignore'; $processes += $vsIgnore.Process
    Set-Content -LiteralPath (Join-Path $lower '.Vs\UE\v17\ipch\mutable.ipch') -Value 'cache write'
    Add-Content -LiteralPath (Join-Path $lower '.Vs\UE\v17\ipch\mutable.ipch') -Value 'cache rewrite'
    Start-Sleep -Milliseconds 500
    $vsIgnore.Process.Refresh()
    if ($vsIgnore.Process.HasExited -or (Test-Path $vsIgnore.Quarantine)) { throw 'root .vs mutation was not ignored' }
    Set-Content -LiteralPath (Join-Path $lower 'source-after-vs.txt') -Value 'source mutation'
    Wait-Quarantine $vsIgnore 'added' 'source-after-vs.txt'

    $vsPrefix = Start-Watcher 'vs-prefix'; $processes += $vsPrefix.Process
    New-Item -ItemType Directory -Path (Join-Path $lower '.vs-other') | Out-Null
    Wait-Quarantine $vsPrefix 'added' '.vs-other'

    New-Item -ItemType Directory -Path (Join-Path $lower 'nested') | Out-Null
    $nestedVs = Start-Watcher 'nested-vs'; $processes += $nestedVs.Process
    New-Item -ItemType Directory -Path (Join-Path $lower 'nested\.vs') | Out-Null
    Wait-Quarantine $nestedVs 'added' 'nested\.vs'

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
        rootVsIgnored = $true
        postIgnoreSourceMutationDetected = $true
        nonExactVsNamesDetected = $true
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
