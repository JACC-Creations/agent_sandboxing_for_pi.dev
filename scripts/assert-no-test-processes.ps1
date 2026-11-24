$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Leaks = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -like "*$RepositoryRoot\test\fixtures\*" -or
    $_.CommandLine -like "*$RepositoryRoot\bin\agent-workspace.mjs worker*" -or
    $_.CommandLine -like "*$RepositoryRoot\bin\agent-workspace.mjs generation-supervisor*" -or
    ($_.CommandLine -like "*$RepositoryRoot\src\task-runner.mjs*" -and $_.CommandLine -like '*\Temp\projfs-broker-test-*')
} | Select-Object ProcessId, CreationDate, CommandLine

if (@($Leaks).Count -ne 0) {
    $Leaks | Format-List | Out-String | Write-Error
    throw "$(@($Leaks).Count) agent-workspace test fixture process(es) remain"
}

Write-Output 'fixture-process-leaks=0'
