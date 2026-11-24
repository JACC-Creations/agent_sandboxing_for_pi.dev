param([Parameter(Mandatory = $true)][string]$Path)

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User.Value
$allowedSids = @($currentSid, 'S-1-5-18')
$item = Get-Item -LiteralPath $Path
$security = if ($item.PSIsContainer) {
    [System.IO.Directory]::GetAccessControl($Path)
} else {
    [System.IO.File]::GetAccessControl($Path)
}
$rules = $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$actual = @($rules | ForEach-Object { "{0}:{1}:{2}" -f $_.IdentityReference.Value, $_.AccessControlType, $_.FileSystemRights })
$ruleSids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)
$hasCurrentUser = $ruleSids -contains $currentSid
$hasSystem = $ruleSids -contains 'S-1-5-18'
$onlyAllowed = @($ruleSids | Where-Object { $allowedSids -notcontains $_ }).Count -eq 0
$onlyAllowRules = @($rules | Where-Object { $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow }).Count -eq 0
[pscustomobject]@{
    ok = $security.AreAccessRulesProtected -and $hasCurrentUser -and $hasSystem -and $onlyAllowed -and $onlyAllowRules
    actual = "protected=$($security.AreAccessRulesProtected); rules=$($actual -join ', ')"
} | ConvertTo-Json -Compress
