param(
	[Parameter(Mandatory = $true)]
	[string]$Workspace,

	[Parameter(Mandatory = $true)]
	[string]$RuntimeDirectory,

	[Parameter(Mandatory = $true)]
	[int]$UbaPort
)

$env:TEMP = Join-Path $RuntimeDirectory "Temp"
$env:TMP = $env:TEMP
$UbaDirectory = Join-Path $RuntimeDirectory "UBA"
New-Item -ItemType Directory -Path $env:TEMP, $UbaDirectory -Force | Out-Null

Push-Location $Workspace
try
{
	& "$Workspace\Engine\Build\BatchFiles\RunUBT.bat" `
		'-Target=VerseTestScriptCmd Win64 Development' `
		'-Target=VerseTestScriptCmdVM Win64 Development' `
		-WaitMutex `
		"-UBARootDir=$UbaDirectory" `
		"-UBAPort=$UbaPort"
	$Result = $LASTEXITCODE
}
finally
{
	Pop-Location
}

exit $Result
