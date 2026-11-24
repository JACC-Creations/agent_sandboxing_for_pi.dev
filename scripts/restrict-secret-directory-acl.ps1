param([Parameter(Mandatory = $true)][string]$Path)

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentUser = $identity.User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security = [System.Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($currentUser)
$security.SetAccessRuleProtection($true, $false)
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentUser, $rights, $inheritance, $propagation, $allow))
$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $rights, $inheritance, $propagation, $allow))
[System.IO.Directory]::SetAccessControl($Path, $security)
