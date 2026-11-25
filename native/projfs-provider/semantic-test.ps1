[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ProviderPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Stop-Provider {
    param([System.Diagnostics.Process] $Process)
    if ($null -eq $Process -or $Process.HasExited) {
        return
    }
    $Process.Kill()
    $Process.WaitForExit()
}

function Start-Provider {
    param([string] $Executable, [string] $Lower, [string] $Root, [string] $LogDirectory)

    $stdout = Join-Path $LogDirectory 'provider.stdout.log'
    $stderr = Join-Path $LogDirectory 'provider.stderr.log'
    Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $Executable `
        -ArgumentList @('--lower', $Lower, '--root', $Root) `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

    for ($attempt = 0; $attempt -lt 100; ++$attempt) {
        if ($process.HasExited) {
            $errorText = if (Test-Path $stderr) { Get-Content $stderr -Raw } else { '' }
            throw "Provider exited during startup with $($process.ExitCode): $errorText"
        }
        if ((Test-Path $stdout) -and (Get-Content $stdout -Raw) -match 'PROJFS_READY') {
            return $process
        }
        Start-Sleep -Milliseconds 50
    }

    Stop-Provider $process
    throw 'Provider did not expose the lower tree within five seconds.'
}

$provider = (Resolve-Path -LiteralPath $ProviderPath).Path
Assert-True ([Environment]::Is64BitProcess) 'Run the test from 64-bit PowerShell.'

$testBase = Join-Path ([System.IO.Path]::GetTempPath()) ("projfs-provider-test-{0}" -f [guid]::NewGuid())
$lower = Join-Path $testBase 'lower'
$root = Join-Path $testBase 'root'
$logs = Join-Path $testBase 'logs'
$process = $null

try {
    New-Item -ItemType Directory -Path $lower, $root, $logs | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower 'nested') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower '.Vs\UE\v17\ipch') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower '.UgS\CaChE\metadata') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower '.cache-data\objects') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower 'nested\.vs') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower 'nested\.ugs\cache') | Out-Null
    Set-Content -LiteralPath (Join-Path $lower '.Vs\UE\v17\ipch\mutable.ipch') -Value 'mutable cache' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower '.UgS\CaChE\metadata\mutable.json') -Value 'mutable ugs cache' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower '.cache-data\objects\mutable.bin') -Value 'mutable generic cache' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'nested\.vs\visible.txt') -Value 'nested dot directory visible' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'nested\.ugs\cache\visible.txt') -Value 'nested ugs visible' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower '.editorconfig') -Value 'editor config' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower '.loreignore') -Value 'lore ignore' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower '.p4ignore.txt') -Value 'p4 ignore' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower '.vsconfig') -Value 'vs config' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'MixedCase.native.verse') -Value 'mixed case' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'read.txt') -Value 'lower read' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'overwrite.txt') -Value 'lower overwrite' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'delete.txt') -Value 'lower delete' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'rename.txt') -Value 'lower rename' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'nested\child.txt') -Value 'nested child' -NoNewline

    $before = Get-ChildItem -LiteralPath $lower -File -Recurse | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{ Relative = $_.FullName.Substring($lower.Length); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
    }

    $process = Start-Provider $provider $lower $root $logs

    $rootNames = @(Get-ChildItem -LiteralPath $root -Force | ForEach-Object Name)
    foreach ($hiddenDirectory in @('.vs', '.ugs', '.cache-data')) {
        Assert-True (-not ($rootNames -icontains $hiddenDirectory)) "Root dot-directory $hiddenDirectory was enumerated."
    }
    foreach ($visibleDotFile in @('.editorconfig', '.loreignore', '.p4ignore.txt', '.vsconfig')) {
        Assert-True ($rootNames -icontains $visibleDotFile) "Root dotfile $visibleDotFile was excluded."
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root '.VS\UE\v17\ipch\mutable.ipch'))) 'A case-insensitive direct root dot-directory query succeeded.'
    $directOpenFailed = $false
    try {
        [System.IO.File]::ReadAllText((Join-Path $root '.uGs\cAcHe\metadata\mutable.json')) | Out-Null
    }
    catch {
        $directOpenFailed = $true
    }
    Assert-True $directOpenFailed 'A direct root dot-directory descendant open succeeded.'
    Assert-True ((Get-Content (Join-Path $root '.editorconfig') -Raw) -ceq 'editor config') 'The root .editorconfig dotfile was not projected.'
    Assert-True ((Get-Content (Join-Path $root '.loreignore') -Raw) -ceq 'lore ignore') 'The root .loreignore dotfile was not projected.'
    Assert-True ((Get-Content (Join-Path $root '.p4ignore.txt') -Raw) -ceq 'p4 ignore') 'The root .p4ignore.txt dotfile was not projected.'
    Assert-True ((Get-Content (Join-Path $root '.vsconfig') -Raw) -ceq 'vs config') 'The root .vsconfig dotfile was not projected.'
    Assert-True ((Get-Content (Join-Path $root 'nested\.vs\visible.txt') -Raw) -ceq 'nested dot directory visible') 'A nested .vs directory was excluded.'
    Assert-True ((Get-Content (Join-Path $root 'nested\.ugs\cache\visible.txt') -Raw) -ceq 'nested ugs visible') 'A nested .ugs directory was excluded.'
    New-Item -ItemType Directory -Path (Join-Path $root '.vs') | Out-Null
    Set-Content -LiteralPath (Join-Path $root '.vs\local-cache.txt') -Value 'private cache' -NoNewline
    New-Item -ItemType Directory -Path (Join-Path $root '.ugs') | Out-Null
    Set-Content -LiteralPath (Join-Path $root '.ugs\local-cache.json') -Value 'private ugs cache' -NoNewline
    Assert-True ((Get-Content (Join-Path $root '.vs\local-cache.txt') -Raw) -ceq 'private cache') 'A private projected-root .vs directory could not be created.'
    Assert-True ((Get-Content (Join-Path $root '.ugs\local-cache.json') -Raw) -ceq 'private ugs cache') 'A private projected-root .ugs directory could not be created.'

    Assert-True ((Get-Content (Join-Path $root 'MIXEDCASE.NATIVE.VERSE') -Raw) -ceq 'mixed case') 'Case-insensitive projected read failed.'
    $projectedCase = (Get-ChildItem -LiteralPath $root -File | Where-Object Name -IEq 'MixedCase.native.verse').Name
    Assert-True ($projectedCase -ceq 'MixedCase.native.verse') 'A case-insensitive direct open changed the canonical projected filename.'
    Assert-True ((Get-Content (Join-Path $root 'read.txt') -Raw) -ceq 'lower read') 'Projected read failed.'
    Assert-True ((Get-Content (Join-Path $root 'nested\child.txt') -Raw) -ceq 'nested child') 'Nested projected read failed.'

    Set-Content -LiteralPath (Join-Path $root 'overwrite.txt') -Value 'local overwrite' -NoNewline
    Set-Content -LiteralPath (Join-Path $root 'created.txt') -Value 'local create' -NoNewline
    Remove-Item -LiteralPath (Join-Path $root 'delete.txt')
    Rename-Item -LiteralPath (Join-Path $root 'rename.txt') -NewName 'renamed.txt'

    Assert-True ((Get-Content (Join-Path $root 'overwrite.txt') -Raw) -ceq 'local overwrite') 'Overwrite did not shadow lower content.'
    Assert-True ((Get-Content (Join-Path $root 'created.txt') -Raw) -ceq 'local create') 'Local create failed.'
    Assert-True (-not (Test-Path (Join-Path $root 'delete.txt'))) 'Deleted projected file reappeared.'
    Assert-True ((Get-Content (Join-Path $root 'renamed.txt') -Raw) -ceq 'lower rename') 'Projected rename content failed.'
    Assert-True (-not (Test-Path (Join-Path $root 'rename.txt'))) 'Renamed projected source reappeared.'

    Stop-Provider $process
    $process = $null
    $process = Start-Provider $provider $lower $root $logs

    Assert-True ((Get-Content (Join-Path $root 'overwrite.txt') -Raw) -ceq 'local overwrite') 'Overwrite did not persist after restart.'
    Assert-True ((Get-Content (Join-Path $root 'created.txt') -Raw) -ceq 'local create') 'Local create did not persist after restart.'
    Assert-True (-not (Test-Path (Join-Path $root 'delete.txt'))) 'Delete tombstone did not persist after restart.'
    Assert-True ((Get-Content (Join-Path $root 'renamed.txt') -Raw) -ceq 'lower rename') 'Rename did not persist after restart.'
    Assert-True (-not (Test-Path (Join-Path $root 'rename.txt'))) 'Rename source returned after restart.'
    Assert-True ((Get-Content (Join-Path $root '.vs\local-cache.txt') -Raw) -ceq 'private cache') 'Private projected-root .vs directory did not persist after restart.'
    Assert-True ((Get-Content (Join-Path $root '.ugs\local-cache.json') -Raw) -ceq 'private ugs cache') 'Private projected-root .ugs directory did not persist after restart.'

    $after = Get-ChildItem -LiteralPath $lower -File -Recurse | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{ Relative = $_.FullName.Substring($lower.Length); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
    }
    Assert-True (($before | ConvertTo-Json -Compress) -ceq ($after | ConvertTo-Json -Compress)) 'Lower tree changed.'

    Write-Host 'PASS: ProjFS read-through semantic test'
}
finally {
    Stop-Provider $process
    Write-Host "ARTIFACT_ROOT=$testBase"
}
