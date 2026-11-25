# Minimal ProjFS read-through provider

A dependency-free Windows x64 spike that projects a read-only lower directory into a ProjFS virtualization root. Projected files are hydrated on demand; normal NTFS changes in the root (full files and tombstones) shadow the lower tree without modifying it. In fresh roots, the lower's root `.vs` directory is a built-in case-insensitive exclusion: it and its descendants are never enumerated, queried, or hydrated, while nested `.vs` and names such as `.vs-other` remain visible. Roots previously used by a provider without this policy must be discarded rather than reused.

## Prerequisites

- Windows Projected File System optional feature already enabled. This project never enables it.
- Visual Studio 2022 C++ x64 tools.
- Windows SDK `10.0.26100.0`.
- An NTFS virtualization root on a local fixed volume.

## Build

From a Visual Studio x64 developer PowerShell:

```powershell
cmake -S . -B build -A x64
cmake --build build --config Release
```

CMake pins `CMAKE_SYSTEM_VERSION` to SDK `10.0.26100.0` and applies `/W4 /WX` to `projfs-provider.exe`, `launch-supervisor.exe`, `lower-freeze-guard.exe`, and `generation-supervisor.exe`. The native targets link only Windows system libraries.

## Run

Both directories must already exist and use absolute drive paths. The lower directory and root must not overlap.

```powershell
.\build\Release\projfs-provider.exe --lower C:\data\lower --root C:\data\view
```

The first run marks a normal directory as a ProjFS virtualization root. Later runs reuse that root so local full files and tombstones persist. Press Ctrl+C to stop.

## Disposable semantic test

The core test creates a unique temporary lower/root pair and retains it for inspection. It covers projected reads, the root `.vs` enumeration and direct-open exclusion boundaries, overwrite, local create, delete, rename, crash-style provider restart persistence, and lower-tree immutability. The advanced test adds two-provider isolation, cross-volume roots, concurrent 100 MiB hydration, mapped writes, projected executable and child-process execution, native CMake/MSVC compilation, and graceful restart. Neither test enables the Windows feature.

```powershell
.\semantic-test.ps1 -ProviderPath .\build\Release\projfs-provider.exe
.\advanced-test.ps1 -ProviderPath .\build\Release\projfs-provider.exe
.\advanced-test.ps1 -ProviderPath .\build\Release\projfs-provider.exe `
    -LowerParent D:\PiProjfsSpike -RootParent E:\PiAgentWorkspaces
```

## Disposable lower-watcher test and benchmark

The guard test creates a small `%TEMP%` lower, verifies outside-lower filtering, and independently validates live edit/create/delete/rename detection plus overflow and watcher-error failure. It does not use P4 or external workspace volumes.

```powershell
.\lower-freeze-test.ps1 -GuardPath .\build\Release\lower-freeze-guard.exe
.\watcher-benchmark.ps1 -GuardPath .\build\Release\lower-freeze-guard.exe -IdleSeconds 10
```

The guard registers one bounded asynchronous `ReadDirectoryChangesW` subtree request before readiness and latches durable action/path/time quarantine evidence on the first nonignored event. Events under the lower's root `.vs` directory are ignored case-insensitively; this fixed exclusion does not apply to nested `.vs` or names such as `.vs-other`. Every record in each completed notification buffer is validated, and the alternate buffer is armed before an ignored-only batch is accepted. Detection is continuous-process only: any reboot, watcher gap/death, overflow, malformed notification, root identity/path change, or unverifiable condition quarantines retained roots. A broker restart is adoptable only while watcher continuity survives. `watcher-benchmark.ps1 -MainLower <path>` measures Main startup and idle use read-only while event latency is measured only on a separate disposable lower.

## Supervised UBT probes

`ubt-probe.py` supervises one provider and UBT validator with readiness, heartbeat, timeout, token redaction, exact P4/lower audits, graceful provider shutdown, and an exact-root orphan-process sweep. `--p4-client` is required; its client root must exactly match `--lower`, and the probe pins it in the child environment. Every root, runtime directory, UBA port, and log directory must be private to that worker.

`ubt-concurrency-probe.py` launches several complete `ubt-probe.py` argument vectors from a JSON specification, reports their retained heartbeat/log growth, and requires every worker exit code and summary to pass. It uses targeted process-group cancellation only; it does not delete roots, runtimes, or logs.

```powershell
python .\ubt-concurrency-probe.py `
    --spec-file C:\retained\workers.json `
    --summary C:\retained\summary.json `
    --timeout-seconds 2800
```

## Known limitations

- The provider remains intentionally narrow: it has no standalone recovery policy or security-descriptor/EA/alternate-stream projection. Broker generations provide provider ownership/recovery and lower-freeze monitoring.
- Drive-letter inputs only; UNC and explicit extended (`\\?\`) inputs are rejected. The executable embeds `longPathAware`, and projected read-through was validated with a 331-character cross-volume path.
- Reparse points in the lower tree are intentionally hidden/rejected. This prevents practical path escapes but does not provide race-proof containment against a concurrently mutating hostile lower tree.
- Lower-directory changes are reflected by restarted directory scans, but already-created placeholders retain their metadata/content identity until normal ProjFS/local filesystem state replaces them.
- Synchronous callbacks use ProjFS's worker pool. Cancellation is cooperative during enumeration and each 1 MiB hydration read.
- Case-sensitive-directory semantics are not supported; enumeration uses ProjFS's case-insensitive ordering and wildcard matching.
- The core semantic test force-stops the provider between persistence phases to exercise crash-style restart. The advanced test separately exercises graceful Ctrl+Break shutdown.
