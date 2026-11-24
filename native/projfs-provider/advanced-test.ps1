[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ProviderPath,
    [string] $LowerParent,
    [string] $RootParent,
    [string] $ArtifactParent = [System.IO.Path]::GetTempPath()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) {
        throw $Message
    }
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class ProjFsTestNative
{
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint CREATE_ALWAYS = 2;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CTRL_BREAK_EVENT = 1;
    private const int STD_INPUT_HANDLE = -10;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    private static string QuoteArgument(string argument)
    {
        if (argument.Length != 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }

        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                ++backslashes;
                continue;
            }

            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }

            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    public static int LaunchProcessGroup(string executable, string[] arguments, string stdoutPath, string stderrPath)
    {
        SECURITY_ATTRIBUTES securityAttributes = new SECURITY_ATTRIBUTES();
        securityAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        securityAttributes.bInheritHandle = true;

        IntPtr stdoutHandle = CreateFileW(stdoutPath, GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref securityAttributes,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (stdoutHandle == new IntPtr(-1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create provider stdout log.");
        }

        IntPtr stderrHandle = CreateFileW(stderrPath, GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref securityAttributes,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (stderrHandle == new IntPtr(-1))
        {
            CloseHandle(stdoutHandle);
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create provider stderr log.");
        }

        try
        {
            StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments)
            {
                commandLine.Append(' ');
                commandLine.Append(QuoteArgument(argument));
            }

            STARTUPINFO startupInfo = new STARTUPINFO();
            startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startupInfo.dwFlags = STARTF_USESTDHANDLES;
            startupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startupInfo.hStdOutput = stdoutHandle;
            startupInfo.hStdError = stderrHandle;

            PROCESS_INFORMATION processInformation;
            if (!CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, null, ref startupInfo, out processInformation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not launch provider process group.");
            }

            CloseHandle(processInformation.hThread);
            CloseHandle(processInformation.hProcess);
            return checked((int)processInformation.dwProcessId);
        }
        finally
        {
            CloseHandle(stderrHandle);
            CloseHandle(stdoutHandle);
        }
    }

    public static void SendCtrlBreak(int processGroupId)
    {
        if (!GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, checked((uint)processGroupId)))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not send CTRL_BREAK to provider process group.");
        }
    }

    private static string Sha256(string path)
    {
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete, 1024 * 1024, FileOptions.SequentialScan))
        using (SHA256 algorithm = SHA256.Create())
        {
            return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "");
        }
    }

    public static string[] HashConcurrently(string firstPath, string secondPath)
    {
        ManualResetEventSlim start = new ManualResetEventSlim(false);
        Task<string> first = Task.Factory.StartNew(delegate { start.Wait(); return Sha256(firstPath); });
        Task<string> second = Task.Factory.StartNew(delegate { start.Wait(); return Sha256(secondPath); });
        start.Set();
        try
        {
            Task.WaitAll(first, second);
            return new string[] { first.Result, second.Result };
        }
        finally
        {
            start.Dispose();
        }
    }

    public static bool PrivateMappedWrite(string path)
    {
        byte replacement;
        using (MemoryMappedFile mapping = MemoryMappedFile.CreateFromFile(
            path, FileMode.Open, null, 0, MemoryMappedFileAccess.ReadWrite))
        using (MemoryMappedViewAccessor view = mapping.CreateViewAccessor(
            0, 4096, MemoryMappedFileAccess.ReadWrite))
        {
            replacement = (byte)(view.ReadByte(0) ^ 0x5a);
            view.Write(0, replacement);
            view.Flush();
        }

        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete))
        {
            return stream.ReadByte() == replacement;
        }
    }
}
'@

function Get-LowerManifest {
    param([string] $Lower)

    return @(Get-ChildItem -LiteralPath $Lower -File -Recurse | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{
            Relative = $_.FullName.Substring($Lower.Length)
            Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    })
}

function Read-LogText {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return ''
    }

    try {
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
        try {
            $reader = [System.IO.StreamReader]::new($stream)
            try {
                return $reader.ReadToEnd()
            }
            finally {
                $reader.Dispose()
            }
        }
        finally {
            $stream.Dispose()
        }
    }
    catch [System.IO.IOException] {
        return ''
    }
}

$script:ProviderLaunchNumber = 0

function Start-Provider {
    param([string] $Executable, [string] $Lower, [string] $Root, [string] $LogDirectory)

    ++$script:ProviderLaunchNumber
    $launchName = 'provider-{0:D2}' -f $script:ProviderLaunchNumber
    $stdout = Join-Path $LogDirectory "$launchName.stdout.log"
    $stderr = Join-Path $LogDirectory "$launchName.stderr.log"
    $processId = [ProjFsTestNative]::LaunchProcessGroup(
        $Executable, @('--lower', $Lower, '--root', $Root), $stdout, $stderr)
    $process = [System.Diagnostics.Process]::GetProcessById($processId)

    for ($attempt = 0; $attempt -lt 200; ++$attempt) {
        $process.Refresh()
        if ($process.HasExited) {
            $errorText = Read-LogText $stderr
            throw "CRASH_STOP: provider exited during startup with $($process.ExitCode): $errorText"
        }
        if ((Read-LogText $stdout) -match '(?m)^PROJFS_READY\s*$') {
            return [pscustomobject]@{
                Process = $process
                ProcessGroupId = $processId
                Stdout = $stdout
                Stderr = $stderr
            }
        }
        Start-Sleep -Milliseconds 50
    }

    [ProjFsTestNative]::SendCtrlBreak($processId)
    if (-not $process.WaitForExit(10000)) {
        throw "Provider did not report PROJFS_READY and its graceful CTRL_BREAK stop timed out. Process $processId was left running; Process.Kill was not used."
    }
    throw "Provider did not report PROJFS_READY within ten seconds and was stopped gracefully with CTRL_BREAK."
}

function Stop-Provider {
    param([object] $Provider)

    if ($null -eq $Provider) {
        return
    }

    $Provider.Process.Refresh()
    if ($Provider.Process.HasExited) {
        throw "CRASH_STOP: provider $($Provider.ProcessGroupId) exited before CTRL_BREAK with code $($Provider.Process.ExitCode)."
    }

    [ProjFsTestNative]::SendCtrlBreak($Provider.ProcessGroupId)
    if (-not $Provider.Process.WaitForExit(10000)) {
        throw "Graceful CTRL_BREAK stop timed out for provider $($Provider.ProcessGroupId); it was left running and Process.Kill was not used."
    }
    $Provider.Process.WaitForExit()
    $Provider.Process.Refresh()
    Assert-True $Provider.Process.HasExited "Provider $($Provider.ProcessGroupId) remained alive after CTRL_BREAK."
}

$provider = (Resolve-Path -LiteralPath $ProviderPath).Path
Assert-True ([Environment]::Is64BitProcess) 'Run the test from 64-bit PowerShell.'

$testId = [guid]::NewGuid()
$artifactRoot = Join-Path $ArtifactParent "projfs-provider-advanced-$testId"
$lower = if ($LowerParent) { Join-Path $LowerParent "projfs-lower-$testId" } else { Join-Path $artifactRoot "lower-$testId" }
$rootA = if ($RootParent) { Join-Path $RootParent "projfs-root-a-$testId" } else { Join-Path $artifactRoot "root-a-$testId" }
$rootB = if ($RootParent) { Join-Path $RootParent "projfs-root-b-$testId" } else { Join-Path $artifactRoot "root-b-$testId" }
$logsA = Join-Path $artifactRoot "logs-a-$testId"
$logsB = Join-Path $artifactRoot "logs-b-$testId"
$providerA = $null
$providerB = $null
$testPassed = $false

try {
    New-Item -ItemType Directory -Path $lower, $rootA, $rootB, $logsA, $logsB | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $lower 'tools') | Out-Null

    Set-Content -LiteralPath (Join-Path $lower 'shared-overwrite.txt') -Value 'lower shared' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'delete-after-restart.txt') -Value 'lower delete' -NoNewline
    Set-Content -LiteralPath (Join-Path $lower 'rename-after-restart.txt') -Value 'lower rename' -NoNewline
    Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\where.exe') -Destination (Join-Path $lower 'tools\where.exe')

    $nativeProjectLower = Join-Path $lower 'native-build-workload'
    New-Item -ItemType Directory -Path $nativeProjectLower | Out-Null
    Set-Content -LiteralPath (Join-Path $nativeProjectLower 'CMakeLists.txt') -Value @'
cmake_minimum_required(VERSION 3.20)
project(ProjFsNativeBuildWorkload LANGUAGES CXX)
add_executable(projfs-native-workload main.cpp)
target_compile_features(projfs-native-workload PRIVATE cxx_std_17)
'@ -NoNewline
    Set-Content -LiteralPath (Join-Path $nativeProjectLower 'main.cpp') -Value @'
#include <iostream>

int main()
{
    std::cout << "PROJFS_NATIVE_BUILD_OK\n";
    return 0;
}
'@ -NoNewline

    $largeLower = Join-Path $lower 'projected-100mib.bin'
    $largeStream = [System.IO.File]::Open($largeLower, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $largeStream.SetLength(100MB)
    }
    finally {
        $largeStream.Dispose()
    }
    Assert-True ((Get-Item -LiteralPath $largeLower).Length -eq 100MB) 'The projected test file is not exactly 100 MiB.'

    $before = Get-LowerManifest $lower
    $largeExpectedHash = (Get-FileHash -LiteralPath $largeLower -Algorithm SHA256).Hash

    $providerA = Start-Provider $provider $lower $rootA $logsA
    $providerB = Start-Provider $provider $lower $rootB $logsB

    $cmake = (Get-Command cmake.exe -CommandType Application -ErrorAction Stop).Source
    $nativeProjectRootA = Join-Path $rootA 'native-build-workload'
    $nativeBuildRootA = Join-Path $rootA 'native-build-private'
    $nativeConfigureStdout = Join-Path $logsA 'native-configure.stdout.log'
    $nativeConfigureStderr = Join-Path $logsA 'native-configure.stderr.log'
    $nativeConfigureProcess = Start-Process -FilePath $cmake `
        -ArgumentList @('-S', "`"$nativeProjectRootA`"", '-B', "`"$nativeBuildRootA`"", '-G', '"Visual Studio 17 2022"', '-A', 'x64') `
        -RedirectStandardOutput $nativeConfigureStdout -RedirectStandardError $nativeConfigureStderr -PassThru -Wait
    Assert-True ($nativeConfigureProcess.ExitCode -eq 0) "Native CMake configure exited with $($nativeConfigureProcess.ExitCode)."

    $nativeBuildStdout = Join-Path $logsA 'native-build.stdout.log'
    $nativeBuildStderr = Join-Path $logsA 'native-build.stderr.log'
    $nativeBuildProcess = Start-Process -FilePath $cmake `
        -ArgumentList @('--build', "`"$nativeBuildRootA`"", '--config', 'Release', '--parallel') `
        -RedirectStandardOutput $nativeBuildStdout -RedirectStandardError $nativeBuildStderr -PassThru -Wait
    Assert-True ($nativeBuildProcess.ExitCode -eq 0) "Native CMake build exited with $($nativeBuildProcess.ExitCode)."

    $nativeExecutable = Join-Path $nativeBuildRootA 'Release\projfs-native-workload.exe'
    Assert-True (Test-Path -LiteralPath $nativeExecutable -PathType Leaf) 'The native build did not produce its executable in root A.'
    $nativeRunStdout = Join-Path $logsA 'native-run.stdout.log'
    $nativeRunStderr = Join-Path $logsA 'native-run.stderr.log'
    $nativeRunProcess = Start-Process -FilePath $nativeExecutable `
        -RedirectStandardOutput $nativeRunStdout -RedirectStandardError $nativeRunStderr -PassThru -Wait
    Assert-True ($nativeRunProcess.ExitCode -eq 0) "Native workload exited with $($nativeRunProcess.ExitCode)."
    Assert-True ((Get-Content -LiteralPath $nativeRunStdout -Raw).Trim() -ceq 'PROJFS_NATIVE_BUILD_OK') 'Native workload stdout marker differed.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $lower 'native-build-private'))) 'Root A native build output appeared in the lower tree.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $rootB 'native-build-private'))) 'Root A native build output appeared in root B.'

    Set-Content -LiteralPath (Join-Path $rootA 'shared-overwrite.txt') -Value 'root A overwrite' -NoNewline
    Set-Content -LiteralPath (Join-Path $rootB 'shared-overwrite.txt') -Value 'root B overwrite' -NoNewline
    Set-Content -LiteralPath (Join-Path $rootA 'private-create.txt') -Value 'root A create' -NoNewline
    Set-Content -LiteralPath (Join-Path $rootB 'private-create.txt') -Value 'root B create' -NoNewline

    Assert-True ((Get-Content -LiteralPath (Join-Path $rootA 'shared-overwrite.txt') -Raw) -ceq 'root A overwrite') 'Root A overwrite failed.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rootB 'shared-overwrite.txt') -Raw) -ceq 'root B overwrite') 'Root B overwrite failed.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rootA 'private-create.txt') -Raw) -ceq 'root A create') 'Root A create failed.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rootB 'private-create.txt') -Raw) -ceq 'root B create') 'Root B create failed.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $lower 'shared-overwrite.txt') -Raw) -ceq 'lower shared') 'An overwrite changed the lower file.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $lower 'private-create.txt'))) 'A private create appeared in the lower tree.'

    $concurrentHashes = [ProjFsTestNative]::HashConcurrently(
        (Join-Path $rootA 'projected-100mib.bin'), (Join-Path $rootB 'projected-100mib.bin'))
    Assert-True ($concurrentHashes[0] -ceq $largeExpectedHash) 'Root A concurrent hydration hash differed from the lower file.'
    Assert-True ($concurrentHashes[1] -ceq $largeExpectedHash) 'Root B concurrent hydration hash differed from the lower file.'

    $largeRootA = Join-Path $rootA 'projected-100mib.bin'
    Assert-True ([ProjFsTestNative]::PrivateMappedWrite($largeRootA)) 'The private memory-mapped write did not persist in root A.'
    Assert-True (((Get-FileHash -LiteralPath $largeRootA -Algorithm SHA256).Hash) -cne $largeExpectedHash) 'The private memory-mapped write did not change root A.'
    Assert-True (((Get-FileHash -LiteralPath $largeLower -Algorithm SHA256).Hash) -ceq $largeExpectedHash) 'A private memory-mapped write changed the lower file.'
    Assert-True (((Get-FileHash -LiteralPath (Join-Path $rootB 'projected-100mib.bin') -Algorithm SHA256).Hash) -ceq $largeExpectedHash) 'A private memory-mapped write in root A affected root B.'

    $whereStdout = Join-Path $logsA 'projected-where.stdout.log'
    $whereStderr = Join-Path $logsA 'projected-where.stderr.log'
    $whereProcess = Start-Process -FilePath (Join-Path $rootA 'tools\where.exe') `
        -ArgumentList @('cmd.exe') -RedirectStandardOutput $whereStdout -RedirectStandardError $whereStderr -PassThru -Wait
    Assert-True ($whereProcess.ExitCode -eq 0) "Projected where.exe exited with $($whereProcess.ExitCode)."
    Assert-True ((Get-Content -LiteralPath $whereStdout -Raw) -match '(?i)\\cmd\.exe\s*$') 'Projected where.exe did not locate cmd.exe.'

    $childPrivate = Join-Path $rootA 'child-private.txt'
    $childProcess = Start-Process -FilePath $env:ComSpec `
        -ArgumentList @('/d', '/c', "echo child-private> `"$childPrivate`"") -PassThru -Wait
    Assert-True ($childProcess.ExitCode -eq 0) "Child cmd.exe exited with $($childProcess.ExitCode)."
    Assert-True ((Get-Content -LiteralPath $childPrivate -Raw).Trim() -ceq 'child-private') 'Child cmd.exe did not create the private file.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $rootB 'child-private.txt'))) 'The child private file appeared in root B.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $lower 'child-private.txt'))) 'The child private file appeared in the lower tree.'

    Remove-Item -LiteralPath (Join-Path $rootA 'delete-after-restart.txt')
    Rename-Item -LiteralPath (Join-Path $rootA 'rename-after-restart.txt') -NewName 'renamed-after-restart.txt'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $rootA 'delete-after-restart.txt'))) 'Projected delete did not take effect.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $rootA 'rename-after-restart.txt'))) 'Projected rename source remained visible.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rootA 'renamed-after-restart.txt') -Raw) -ceq 'lower rename') 'Projected rename content failed.'

    Stop-Provider $providerA
    $providerA = $null
    $providerA = Start-Provider $provider $lower $rootA $logsA

    Assert-True (-not (Test-Path -LiteralPath (Join-Path $rootA 'delete-after-restart.txt'))) 'Projected delete did not persist after graceful restart.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $rootA 'rename-after-restart.txt'))) 'Projected rename source returned after graceful restart.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rootA 'renamed-after-restart.txt') -Raw) -ceq 'lower rename') 'Projected rename did not persist after graceful restart.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rootA 'shared-overwrite.txt') -Raw) -ceq 'root A overwrite') 'Root A overwrite did not persist after graceful restart.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rootB 'shared-overwrite.txt') -Raw) -ceq 'root B overwrite') 'Root B changed while root A restarted.'

    $after = Get-LowerManifest $lower
    Assert-True (($before | ConvertTo-Json -Compress) -ceq ($after | ConvertTo-Json -Compress)) 'Lower tree paths or hashes changed.'
    $testPassed = $true
}
finally {
    $stopErrors = @()
    try {
        Stop-Provider $providerA
    }
    catch {
        $stopErrors += "Provider A: $($_.Exception.Message)"
    }
    try {
        Stop-Provider $providerB
    }
    catch {
        $stopErrors += "Provider B: $($_.Exception.Message)"
    }

    Write-Host "ARTIFACT_ROOT=$artifactRoot"
    Write-Host "LOWER_ROOT=$lower"
    Write-Host "VIRTUALIZATION_ROOT_A=$rootA"
    Write-Host "VIRTUALIZATION_ROOT_B=$rootB"
    if ($stopErrors.Count -ne 0) {
        $message = "Provider shutdown failure(s): $($stopErrors -join '; ')"
        if ($testPassed) {
            throw $message
        }
        Write-Warning $message
    }
    if ($testPassed) {
        Write-Host 'PASS: ProjFS advanced retained-artifact integration test'
    }
}
