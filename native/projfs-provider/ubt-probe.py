#!/usr/bin/env python3

import argparse
import hashlib
import json
import ntpath
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
import traceback
from urllib.parse import urlparse


READY_MARKER = b"PROJFS_READY"
PROVIDER_START_TIMEOUT_SECONDS = 30.0
PROCESS_STOP_TIMEOUT_SECONDS = 15.0
PROCESS_CLEANUP_TIMEOUT_SECONDS = 15.0
FILETIME_CIM_TOLERANCE_TICKS = 10
HEARTBEAT_INTERVAL_SECONDS = 5.0
HASH_RELATIVE_PATHS = (
    Path("Engine/Source/Runtime/VerseCompiler/Private/uLang/SemanticAnalyzer/IRGenerator.cpp"),
    Path("Engine/Restricted/NotForLicensees/Programs/UnrealBuildTool/BuildConfiguration.xml"),
)


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Run a supervised retained-artifact UBT probe through ProjFS."
    )
    parser.add_argument("--provider", required=True)
    parser.add_argument("--p4-client", required=True)
    parser.add_argument("--lower", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--validator", required=True)
    parser.add_argument("--runtime-directory", required=True)
    parser.add_argument("--uba-port", required=True, type=int)
    parser.add_argument("--timeout-seconds", required=True, type=float)
    parser.add_argument("--log-directory", required=True)
    parser.add_argument("--horde-url", required=True)
    parser.add_argument("--horde-token-file", required=True)
    return parser.parse_args()


def require_absolute_path(value, argument_name):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{argument_name} must be an absolute path: {value}")
    return path


def paths_overlap(first, second):
    first_text = os.path.normcase(str(first))
    second_text = os.path.normcase(str(second))
    try:
        common = os.path.commonpath((first_text, second_text))
    except ValueError:
        return False
    return common == first_text or common == second_text


def require_non_overlapping(named_paths):
    items = list(named_paths.items())
    for index, (first_name, first_path) in enumerate(items):
        for second_name, second_path in items[index + 1 :]:
            if paths_overlap(first_path, second_path):
                raise ValueError(f"{first_name} and {second_name} must not overlap.")


def validate_arguments(arguments):
    if os.name != "nt":
        raise RuntimeError("This probe requires Windows.")
    if not arguments.p4_client.strip():
        raise ValueError("--p4-client must not be empty.")
    if arguments.timeout_seconds <= 0:
        raise ValueError("--timeout-seconds must be greater than zero.")
    if arguments.uba_port < 1 or arguments.uba_port > 65535:
        raise ValueError("--uba-port must be between 1 and 65535.")

    inputs = {
        "--provider": require_absolute_path(arguments.provider, "--provider"),
        "--lower": require_absolute_path(arguments.lower, "--lower"),
        "--root": require_absolute_path(arguments.root, "--root"),
        "--validator": require_absolute_path(arguments.validator, "--validator"),
        "--runtime-directory": require_absolute_path(
            arguments.runtime_directory, "--runtime-directory"
        ),
        "--log-directory": require_absolute_path(
            arguments.log_directory, "--log-directory"
        ),
        "--horde-token-file": require_absolute_path(
            arguments.horde_token_file, "--horde-token-file"
        ),
    }
    resolved = {
        name: path.resolve(strict=name in ("--provider", "--lower", "--root", "--validator", "--horde-token-file"))
        for name, path in inputs.items()
    }

    if not resolved["--provider"].is_file():
        raise ValueError(f"--provider is not a file: {resolved['--provider']}")
    if not resolved["--validator"].is_file():
        raise ValueError(f"--validator is not a file: {resolved['--validator']}")
    if resolved["--validator"].suffix.casefold() != ".ps1":
        raise ValueError(f"--validator is not a PowerShell script: {resolved['--validator']}")
    if not resolved["--horde-token-file"].is_file():
        raise ValueError(
            f"--horde-token-file is not a file: {resolved['--horde-token-file']}"
        )
    parsed_horde_url = urlparse(arguments.horde_url)
    if parsed_horde_url.scheme not in ("http", "https") or not parsed_horde_url.netloc:
        raise ValueError("--horde-url must be an absolute HTTP(S) URL.")
    if parsed_horde_url.username is not None or parsed_horde_url.password is not None:
        raise ValueError("--horde-url must not contain credentials.")
    if not resolved["--lower"].is_dir():
        raise ValueError(f"--lower is not a directory: {resolved['--lower']}")
    if not resolved["--root"].is_dir():
        raise ValueError(f"--root must be an existing directory: {resolved['--root']}")

    require_non_overlapping(resolved)
    resolved["--runtime-directory"].mkdir(parents=True, exist_ok=True)
    resolved["--log-directory"].mkdir(parents=True, exist_ok=False)
    resolved["--runtime-directory"] = resolved["--runtime-directory"].resolve(strict=True)
    resolved["--log-directory"] = resolved["--log-directory"].resolve(strict=True)
    require_non_overlapping(resolved)
    return resolved


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                return digest.hexdigest()
            digest.update(block)


def run_command(command, cwd, timeout):
    return subprocess.run(
        command,
        cwd=str(cwd),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def validate_p4_client(lower, p4_client):
    result = run_command(
        ("p4", "-ztag", "-c", p4_client, "client", "-o", p4_client),
        lower,
        timeout=60,
    )
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"p4 -c {p4_client} client -o failed with {result.returncode}: {error}"
        )
    prefix = b"... Root "
    roots = [
        line[len(prefix) :].decode("utf-8", errors="strict")
        for line in result.stdout.splitlines()
        if line.startswith(prefix)
    ]
    if len(roots) != 1:
        raise RuntimeError(f"p4 client {p4_client} did not report exactly one Root.")
    client_root = Path(roots[0]).resolve(strict=True)
    if os.path.normcase(str(client_root)) != os.path.normcase(str(lower)):
        raise RuntimeError(
            f"p4 client {p4_client} root {client_root} does not match lower {lower}."
        )
    return str(client_root)


def capture_opened(lower, log_directory, phase, p4_client):
    result = run_command(("p4", "-c", p4_client, "opened"), lower, timeout=60)
    stdout_path = log_directory / f"p4-opened-{phase}.stdout"
    stderr_path = log_directory / f"p4-opened-{phase}.stderr"
    stdout_path.write_bytes(result.stdout)
    stderr_path.write_bytes(result.stderr)
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"p4 -c {p4_client} opened failed with {result.returncode}: {error}"
        )
    return {
        "return_code": result.returncode,
        "stderr": result.stderr,
        "stderr_path": str(stderr_path),
        "stdout": result.stdout,
        "stdout_path": str(stdout_path),
    }


def opened_summary(capture):
    return {
        "return_code": capture["return_code"],
        "stderr_bytes": len(capture["stderr"]),
        "stderr_path": capture["stderr_path"],
        "stderr_sha256": sha256_bytes(capture["stderr"]),
        "stdout_bytes": len(capture["stdout"]),
        "stdout_path": capture["stdout_path"],
        "stdout_sha256": sha256_bytes(capture["stdout"]),
    }


def opened_matches(first, second):
    return (
        first["return_code"] == second["return_code"]
        and first["stdout"] == second["stdout"]
        and first["stderr"] == second["stderr"]
    )


def capture_lower_hashes(lower):
    hashes = {}
    for relative_path in HASH_RELATIVE_PATHS:
        path = lower / relative_path
        if not path.is_file():
            raise FileNotFoundError(f"Selected lower file is missing: {path}")
        hashes[str(relative_path).replace("\\", "/")] = sha256_file(path)
    return hashes


def read_log(path):
    try:
        return path.read_bytes()
    except (FileNotFoundError, PermissionError):
        return b""


def sanitized_environment():
    environment = os.environ.copy()
    for name in list(environment):
        if name.casefold().startswith("ue_horde_"):
            del environment[name]
    return environment


def load_horde_token(path):
    document = json.loads(path.read_text(encoding="utf-8"))
    token = document.get("Token")
    if not isinstance(token, str) or not token:
        raise ValueError("Horde token file does not contain a nonempty Token string.")
    return token


def canonical_windows_path(path):
    return ntpath.normpath(str(path))


def path_is_beneath_root(path, root):
    canonical_path = canonical_windows_path(path)
    canonical_root = canonical_windows_path(root)
    prefix = canonical_root if canonical_root.endswith("\\") else canonical_root + "\\"
    return canonical_path.casefold().startswith(prefix.casefold())


def process_identity(process):
    return process["pid"], process["creation_date"]


def process_summary(process):
    return {
        "creation_date": process["creation_date"],
        "executable_path": process["executable_path"],
        "pid": process["pid"],
    }


def select_new_root_processes(processes, root, baseline_identities):
    matches = []
    for process in processes:
        if process_identity(process) in baseline_identities:
            continue
        if path_is_beneath_root(process["executable_path"], root):
            matches.append(process)
    return matches


def run_powershell_json(script, environment=None, timeout=PROCESS_STOP_TIMEOUT_SECONDS):
    result = subprocess.run(
        (
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=environment,
        timeout=timeout,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        error = result.stderr.strip()
        raise RuntimeError(
            f"PowerShell CIM operation returned {result.returncode}: {error}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("PowerShell CIM operation returned invalid JSON.") from error


def query_processes(timeout=PROCESS_STOP_TIMEOUT_SECONDS):
    script = r"""
$ErrorActionPreference = 'Stop'
$items = @(
    Get-CimInstance -ClassName Win32_Process | ForEach-Object {
        if ($null -ne $_.ExecutablePath -and $null -ne $_.CreationDate) {
            [pscustomobject]@{
                creation_date = $_.CreationDate.ToUniversalTime().ToString('o')
                creation_time = $_.CreationDate.ToUniversalTime().ToFileTimeUtc()
                executable_path = [IO.Path]::GetFullPath($_.ExecutablePath)
                pid = [int]$_.ProcessId
            }
        }
    }
)
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))
"""
    processes = run_powershell_json(script, timeout=timeout)
    if not isinstance(processes, list):
        raise RuntimeError("PowerShell CIM process query did not return a list.")
    return processes


def capture_root_processes(root, timeout=PROCESS_STOP_TIMEOUT_SECONDS):
    return [
        process
        for process in query_processes(timeout=timeout)
        if path_is_beneath_root(process["executable_path"], root)
    ]


def terminate_process_identity(process, root, timeout=PROCESS_STOP_TIMEOUT_SECONDS):
    del timeout
    import ctypes
    from ctypes import wintypes

    class FileTime(ctypes.Structure):
        _fields_ = (("low", wintypes.DWORD), ("high", wintypes.DWORD))

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(FileTime),
        ctypes.POINTER(FileTime),
        ctypes.POINTER(FileTime),
        ctypes.POINTER(FileTime),
    )
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.QueryFullProcessImageNameW.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    )
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL

    process_handle = kernel32.OpenProcess(0x1001, False, process["pid"])
    if not process_handle:
        error_code = ctypes.get_last_error()
        if error_code == 87:
            return {"return_value": None, "status": "gone"}
        raise OSError(error_code, "OpenProcess failed")

    try:
        creation = FileTime()
        exit_time = FileTime()
        kernel_time = FileTime()
        user_time = FileTime()
        if not kernel32.GetProcessTimes(
            process_handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel_time),
            ctypes.byref(user_time),
        ):
            error_code = ctypes.get_last_error()
            raise OSError(error_code, "GetProcessTimes failed")
        creation_time = (creation.high << 32) | creation.low
        if (
            abs(creation_time - process["creation_time"])
            > FILETIME_CIM_TOLERANCE_TICKS
        ):
            return {"return_value": None, "status": "identity_changed"}

        path_capacity = wintypes.DWORD(32768)
        path_buffer = ctypes.create_unicode_buffer(path_capacity.value)
        if not kernel32.QueryFullProcessImageNameW(
            process_handle, 0, path_buffer, ctypes.byref(path_capacity)
        ):
            error_code = ctypes.get_last_error()
            raise OSError(error_code, "QueryFullProcessImageNameW failed")
        if not path_is_beneath_root(path_buffer.value, root):
            return {"return_value": None, "status": "outside_root"}

        if not kernel32.TerminateProcess(process_handle, 1):
            error_code = ctypes.get_last_error()
            raise OSError(error_code, "TerminateProcess failed")
        return {"return_value": 0, "status": "terminated"}
    finally:
        kernel32.CloseHandle(process_handle)


def cleanup_projected_root_processes(root, baseline):
    cleanup = {
        "baseline": [process_summary(process) for process in baseline],
        "errors": [],
        "matched": [],
        "surviving": [],
        "terminated": [],
    }
    baseline_identities = {process_identity(process) for process in baseline}
    matched_identities = set()
    attempted_identities = set()
    deadline = time.monotonic() + PROCESS_CLEANUP_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            processes = query_processes(timeout=remaining)
        except BaseException as error:
            cleanup["errors"].append(
                {"message": f"{type(error).__name__}: {error}", "stage": "scan"}
            )
            break

        matches = select_new_root_processes(processes, root, baseline_identities)
        for process in matches:
            identity = process_identity(process)
            if identity not in matched_identities:
                cleanup["matched"].append(process_summary(process))
                matched_identities.add(identity)
            if identity in attempted_identities:
                continue
            attempted_identities.add(identity)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                result = terminate_process_identity(process, root, timeout=remaining)
            except BaseException as error:
                cleanup["errors"].append(
                    {
                        "message": f"{type(error).__name__}: {error}",
                        "process": process_summary(process),
                        "stage": "terminate",
                    }
                )
                continue
            if result.get("status") == "terminated":
                terminated = process_summary(process)
                terminated["return_value"] = result.get("return_value")
                cleanup["terminated"].append(terminated)
            elif result.get("status") not in ("gone", "identity_changed", "outside_root"):
                cleanup["errors"].append(
                    {
                        "message": f"CIM termination status: {result.get('status')}",
                        "process": process_summary(process),
                        "return_value": result.get("return_value"),
                        "stage": "terminate",
                    }
                )

        if not matches:
            break
        time.sleep(0.1)

    remaining = max(0.1, deadline - time.monotonic())
    try:
        final_processes = query_processes(timeout=remaining)
        surviving = select_new_root_processes(
            final_processes, root, baseline_identities
        )
        cleanup["surviving"] = [
            process_summary(process) for process in surviving
        ]
        if surviving:
            cleanup["errors"].append(
                {
                    "message": "New projected-root processes survived bounded cleanup.",
                    "stage": "rescan",
                }
            )
    except BaseException as error:
        cleanup["errors"].append(
            {"message": f"{type(error).__name__}: {error}", "stage": "rescan"}
        )
    return cleanup


def stop_provider(process):
    if process is None:
        return None
    if process.poll() is not None:
        raise RuntimeError(
            f"Provider exited before graceful CTRL_BREAK stop with {process.returncode}."
        )
    process.send_signal(signal.CTRL_BREAK_EVENT)
    try:
        return_code = process.wait(timeout=PROCESS_STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        raise TimeoutError(
            f"Provider {process.pid} did not stop after CTRL_BREAK within "
            f"{PROCESS_STOP_TIMEOUT_SECONDS:.0f} seconds; it was left running."
        ) from error
    if return_code != 0:
        raise RuntimeError(f"Provider graceful stop returned {return_code}.")
    return return_code


def start_provider(provider, lower, root, log_directory):
    stdout_path = log_directory / "provider.stdout.log"
    stderr_path = log_directory / "provider.stderr.log"
    with stdout_path.open("wb") as stdout_stream, stderr_path.open("wb") as stderr_stream:
        process = subprocess.Popen(
            (str(provider), "--lower", str(lower), "--root", str(root)),
            stdin=subprocess.DEVNULL,
            stdout=stdout_stream,
            stderr=stderr_stream,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            env=sanitized_environment(),
        )

    try:
        deadline = time.monotonic() + PROVIDER_START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            return_code = process.poll()
            if return_code is not None:
                error = read_log(stderr_path).decode("utf-8", errors="replace").strip()
                raise RuntimeError(
                    f"Provider exited before PROJFS_READY with {return_code}: {error}"
                )
            if READY_MARKER in read_log(stdout_path):
                return process, stdout_path, stderr_path
            time.sleep(0.05)
        raise TimeoutError(
            "Provider did not report PROJFS_READY within "
            f"{PROVIDER_START_TIMEOUT_SECONDS:.0f} seconds."
        )
    except BaseException:
        stop_provider(process)
        raise


def write_json(path, value):
    text = json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    temporary_path = path.with_name(path.name + ".tmp")
    temporary_path.write_text(text, encoding="utf-8")
    os.replace(temporary_path, path)


def write_heartbeat(path, status, process, started_monotonic, ubt_log_path):
    now = time.time()
    heartbeat = {
        "elapsed_seconds": round(time.monotonic() - started_monotonic, 3),
        "pid": process.pid,
        "status": status,
        "timestamp_unix_seconds": now,
        "ubt_log_bytes": ubt_log_path.stat().st_size if ubt_log_path.exists() else 0,
    }
    write_json(path, heartbeat)


def stream_output(stream, log_path, output_queue, secret):
    pending = b""
    secret_bytes = secret.encode("utf-8")
    retained_bytes = max(0, len(secret_bytes) - 1)

    def write_redacted(destination, value):
        if not value:
            return
        redacted = value.replace(secret_bytes, b"[REDACTED]")
        destination.write(redacted)
        destination.flush()
        console = getattr(sys.stdout, "buffer", sys.stdout)
        console.write(redacted)
        console.flush()

    try:
        with log_path.open("wb") as log_stream:
            while True:
                block = stream.read(64 * 1024)
                if not block:
                    break
                pending = (pending + block).replace(secret_bytes, b"[REDACTED]")
                if len(pending) <= retained_bytes:
                    continue
                split = len(pending) - retained_bytes
                write_redacted(log_stream, pending[:split])
                pending = pending[split:]
            write_redacted(log_stream, pending)
    except BaseException as error:
        output_queue.put(error)
    finally:
        stream.close()
        output_queue.put(None)


def wait_for_process(process, timeout_seconds, heartbeat):
    deadline = time.monotonic() + timeout_seconds
    while process.poll() is None and time.monotonic() < deadline:
        heartbeat()
        time.sleep(0.1)
    return process.poll()


def cancel_process_group(process, label, log_directory, heartbeat):
    if process.poll() is not None:
        return process.returncode

    process.send_signal(signal.CTRL_BREAK_EVENT)
    return_code = wait_for_process(process, PROCESS_STOP_TIMEOUT_SECONDS, heartbeat)
    if return_code is not None:
        return return_code

    taskkill_stdout = log_directory / "ubt-taskkill.stdout.log"
    taskkill_stderr = log_directory / "ubt-taskkill.stderr.log"
    with taskkill_stdout.open("wb") as stdout_stream, taskkill_stderr.open(
        "wb"
    ) as stderr_stream:
        taskkill_process = subprocess.Popen(
            ("taskkill.exe", "/PID", str(process.pid), "/T"),
            cwd=str(log_directory),
            stdin=subprocess.DEVNULL,
            stdout=stdout_stream,
            stderr=stderr_stream,
        )
        taskkill_return_code = wait_for_process(
            taskkill_process, PROCESS_STOP_TIMEOUT_SECONDS, heartbeat
        )
    if taskkill_return_code is None:
        taskkill_process.terminate()
        try:
            taskkill_process.wait(timeout=PROCESS_STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        raise TimeoutError(
            f"taskkill /T for {label} process group {process.pid} did not finish within "
            f"{PROCESS_STOP_TIMEOUT_SECONDS:.0f} seconds; no forced UBT termination was used."
        )

    return_code = wait_for_process(process, PROCESS_STOP_TIMEOUT_SECONDS, heartbeat)
    if return_code is None:
        raise TimeoutError(
            f"{label} process group {process.pid} remained live after CTRL_BREAK and "
            "taskkill /T without /F; it was left running."
        )
    return return_code


def run_validator(
    validator,
    root,
    runtime_directory,
    uba_port,
    timeout_seconds,
    log_directory,
    horde_url,
    horde_token,
    p4_client,
):
    command = (
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(validator),
        "-Workspace",
        str(root),
        "-RuntimeDirectory",
        str(runtime_directory),
        "-UbaPort",
        str(uba_port),
    )
    ubt_log_path = log_directory / "ubt.log"
    heartbeat_path = log_directory / "heartbeat.json"
    child_environment = sanitized_environment()
    child_environment["MSBUILDDISABLENODEREUSE"] = "1"
    child_environment["P4CLIENT"] = p4_client
    child_environment["UE_HORDE_URL"] = horde_url
    child_environment["UE_HORDE_TOKEN"] = horde_token
    process = subprocess.Popen(
        command,
        cwd=str(root),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        bufsize=0,
        env=child_environment,
    )
    output_queue = queue.Queue()
    output_thread = threading.Thread(
        target=stream_output,
        args=(process.stdout, ubt_log_path, output_queue, horde_token),
        name="ubt-output",
        daemon=True,
    )
    output_thread.start()

    started_monotonic = time.monotonic()
    next_heartbeat = started_monotonic
    timed_out = False
    monitoring_error = None

    def update_heartbeat(status):
        nonlocal next_heartbeat
        now = time.monotonic()
        if now < next_heartbeat:
            return
        write_heartbeat(
            heartbeat_path, status, process, started_monotonic, ubt_log_path
        )
        next_heartbeat = now + HEARTBEAT_INTERVAL_SECONDS

    def update_shutdown_heartbeat():
        try:
            update_heartbeat("stopping")
        except OSError:
            pass

    try:
        while process.poll() is None:
            now = time.monotonic()
            update_heartbeat("running")
            if now - started_monotonic >= timeout_seconds:
                timed_out = True
                break
            try:
                output_error = output_queue.get_nowait()
            except queue.Empty:
                output_error = None
            if output_error is not None:
                monitoring_error = output_error
                break
            time.sleep(0.1)
    except BaseException as error:
        monitoring_error = error

    cancellation_error = None
    if process.poll() is None and (timed_out or monitoring_error is not None):
        try:
            cancel_process_group(
                process,
                "UBT",
                log_directory,
                update_shutdown_heartbeat,
            )
        except BaseException as error:
            cancellation_error = error

    return_code = process.poll()
    if return_code is not None:
        output_thread.join(timeout=PROCESS_STOP_TIMEOUT_SECONDS)
    if output_thread.is_alive() and cancellation_error is None:
        cancellation_error = RuntimeError(
            "UBT output stream did not close after the process exited."
        )
    while not output_queue.empty():
        output_error = output_queue.get_nowait()
        if output_error is not None and monitoring_error is None:
            monitoring_error = output_error

    status = "timed_out" if timed_out else "failed" if return_code != 0 else "completed"
    write_heartbeat(heartbeat_path, status, process, started_monotonic, ubt_log_path)
    result = {
        "elapsed_seconds": round(time.monotonic() - started_monotonic, 3),
        "exit_code": return_code,
        "heartbeat": str(heartbeat_path),
        "log": str(ubt_log_path),
        "pid": process.pid,
        "timed_out": timed_out,
    }
    if cancellation_error is not None:
        raise RuntimeError(f"UBT cancellation failed: {cancellation_error}")
    if monitoring_error is not None:
        raise RuntimeError(f"UBT supervision failed: {monitoring_error}")
    if timed_out:
        raise TimeoutError(f"UBT exceeded the {timeout_seconds:g}-second timeout.")
    if return_code != 0:
        raise RuntimeError(f"UBT validator returned {return_code}.")
    return result


def write_summary(summary, log_directory):
    text = json.dumps(summary, sort_keys=True, separators=(",", ":"))
    if log_directory is not None:
        try:
            (log_directory / "summary.json").write_text(text + "\n", encoding="utf-8")
        except OSError:
            pass
    print(text, flush=True)


def main():
    arguments = parse_arguments()
    summary = {
        "ok": False,
        "process_cleanup": {
            "baseline": [],
            "errors": [],
            "matched": [],
            "surviving": [],
            "terminated": [],
        },
    }
    paths = None
    log_directory = None
    provider_process = None
    opened_before = None
    hashes_before = None
    process_baseline = None
    errors = []

    try:
        paths = validate_arguments(arguments)
        lower = paths["--lower"]
        root = paths["--root"]
        log_directory = paths["--log-directory"]
        summary.update(
            {
                "log_directory": str(log_directory),
                "lower": str(lower),
                "p4_client": arguments.p4_client,
                "root": str(root),
                "runtime_directory": str(paths["--runtime-directory"]),
            }
        )

        summary["p4_client_root"] = validate_p4_client(
            lower, arguments.p4_client
        )
        opened_before = capture_opened(
            lower, log_directory, "before", arguments.p4_client
        )
        summary["p4_opened_before"] = opened_summary(opened_before)
        hashes_before = capture_lower_hashes(lower)
        summary["lower_hashes_before"] = hashes_before
        horde_token = load_horde_token(paths["--horde-token-file"])

        try:
            process_baseline = capture_root_processes(root)
        except BaseException as error:
            summary["process_cleanup"]["errors"].append(
                {
                    "message": f"{type(error).__name__}: {error}",
                    "stage": "baseline",
                }
            )
            raise
        summary["process_cleanup"]["baseline"] = [
            process_summary(process) for process in process_baseline
        ]
        provider_process, provider_stdout, provider_stderr = start_provider(
            paths["--provider"], lower, root, log_directory
        )
        summary["provider"] = {
            "pid": provider_process.pid,
            "stderr": str(provider_stderr),
            "stdout": str(provider_stdout),
        }
        summary["ubt"] = run_validator(
            paths["--validator"],
            root,
            paths["--runtime-directory"],
            arguments.uba_port,
            arguments.timeout_seconds,
            log_directory,
            arguments.horde_url,
            horde_token,
            arguments.p4_client,
        )
    except BaseException as error:
        errors.append(f"{type(error).__name__}: {error}")
        if log_directory is not None:
            try:
                (log_directory / "probe-error.log").write_text(
                    traceback.format_exc(), encoding="utf-8"
                )
            except OSError:
                pass
    finally:
        if process_baseline is not None and paths is not None:
            try:
                summary["process_cleanup"] = cleanup_projected_root_processes(
                    paths["--root"], process_baseline
                )
                if summary["process_cleanup"]["errors"]:
                    errors.append(
                        "Projected-root process cleanup failed; see process_cleanup.errors."
                    )
            except BaseException as error:
                errors.append(f"{type(error).__name__}: {error}")
                summary.setdefault("process_cleanup", {}).setdefault(
                    "errors", []
                ).append(
                    {
                        "message": f"{type(error).__name__}: {error}",
                        "stage": "cleanup",
                    }
                )

        try:
            if provider_process is not None:
                summary.setdefault("provider", {})["exit_code"] = stop_provider(
                    provider_process
                )
        except Exception as error:
            errors.append(f"{type(error).__name__}: {error}")

        if paths is not None and log_directory is not None and opened_before is not None:
            try:
                opened_after = capture_opened(
                    paths["--lower"], log_directory, "after", arguments.p4_client
                )
                summary["p4_opened_after"] = opened_summary(opened_after)
                summary["p4_opened_exact_match"] = opened_matches(
                    opened_before, opened_after
                )
                if not summary["p4_opened_exact_match"]:
                    errors.append(
                        f"p4 -c {arguments.p4_client} opened changed during the probe."
                    )
            except Exception as error:
                errors.append(f"{type(error).__name__}: {error}")

        if paths is not None and hashes_before is not None:
            try:
                hashes_after = capture_lower_hashes(paths["--lower"])
                summary["lower_hashes_after"] = hashes_after
                summary["lower_hashes_exact_match"] = hashes_after == hashes_before
                if hashes_after != hashes_before:
                    errors.append("Selected lower file hashes changed during the probe.")
            except Exception as error:
                errors.append(f"{type(error).__name__}: {error}")

    if errors:
        summary["errors"] = errors
        write_summary(summary, log_directory)
        return 1

    summary["ok"] = True
    write_summary(summary, log_directory)
    return 0


if __name__ == "__main__":
    sys.exit(main())
