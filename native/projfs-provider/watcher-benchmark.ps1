param(
    [Parameter(Mandatory = $true)]
    [string]$GuardPath,
    [string]$MainLower,
    [ValidateRange(1, 300)]
    [int]$IdleSeconds = 10
)

$ErrorActionPreference = 'Stop'
$guard = (Resolve-Path $GuardPath).Path
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lower-watcher-benchmark-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Measure-Watcher([string]$lower, [string]$label, [bool]$mutate) {
    $private = Join-Path $testRoot $label
    New-Item -ItemType Directory -Path $private -Force | Out-Null
    $state = Join-Path $private 'state.json'
    $quarantine = Join-Path $private 'quarantine.json'
    $stdout = Join-Path $private 'stdout.log'
    $stderr = Join-Path $private 'stderr.log'
    $arguments = @('--lower', $lower, '--state', $state, '--quarantine', $quarantine, '--broker-uuid', [guid]::NewGuid().ToString())
    $startedAt = [System.Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $guard -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ([DateTime]::UtcNow -lt $deadline) {
            $process.Refresh()
            if ((Test-Path $stdout) -and ((Get-Content $stdout -ErrorAction SilentlyContinue) -contains 'LOWER_FREEZE_READY')) { break }
            if ($process.HasExited) { throw "watcher exited: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)" }
            Start-Sleep -Milliseconds 10
        }
        if (-not (Test-Path $stdout) -or -not ((Get-Content $stdout) -contains 'LOWER_FREEZE_READY')) { throw 'watcher readiness timed out' }
        $startupMs = $startedAt.Elapsed.TotalMilliseconds
        $process.Refresh()
        $cpuStart = $process.TotalProcessorTime.TotalMilliseconds
        Start-Sleep -Seconds $IdleSeconds
        $process.Refresh()
        $idleCpuMs = $process.TotalProcessorTime.TotalMilliseconds - $cpuStart
        $workingSetBytes = $process.WorkingSet64
        $eventLatencyMs = $null
        if ($mutate) {
            $timer = [System.Diagnostics.Stopwatch]::StartNew()
            Set-Content -LiteralPath (Join-Path $lower 'latency-event.txt') -Value ([DateTime]::UtcNow.ToString('O'))
            while ($timer.Elapsed.TotalSeconds -lt 10 -and -not (Test-Path $quarantine)) { Start-Sleep -Milliseconds 1 }
            if (-not (Test-Path $quarantine)) { throw 'event latency measurement timed out' }
            $eventLatencyMs = $timer.Elapsed.TotalMilliseconds
            $process.WaitForExit(10000) | Out-Null
        }
        return [pscustomobject]@{
            label = $label
            lower = $lower
            readOnly = -not $mutate
            startupMs = [Math]::Round($startupMs, 3)
            idleIntervalSeconds = $IdleSeconds
            idleCpuMs = [Math]::Round($idleCpuMs, 3)
            workingSetBytes = $workingSetBytes
            eventLatencyMs = if ($null -eq $eventLatencyMs) { $null } else { [Math]::Round($eventLatencyMs, 3) }
        }
    }
    finally {
        try { $process.Refresh(); if (-not $process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit(10000) | Out-Null } } catch {}
    }
}

try {
    $disposableLower = Join-Path $testRoot 'disposable-lower'
    New-Item -ItemType Directory -Path $disposableLower | Out-Null
    $results = @(Measure-Watcher $disposableLower 'disposable' $true)
    if ($MainLower) {
        $resolvedMain = (Resolve-Path $MainLower).Path
        $results += Measure-Watcher $resolvedMain 'main-read-only' $false
    }
    [pscustomobject]@{
        measuredAt = [DateTime]::UtcNow.ToString('O')
        mainWasNeverMutated = $true
        results = $results
    } | ConvertTo-Json -Depth 5
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
