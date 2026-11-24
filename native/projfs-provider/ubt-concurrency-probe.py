#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import traceback


DEFAULT_STATUS_INTERVAL_SECONDS = 5.0
DEFAULT_STOP_TIMEOUT_SECONDS = 15.0


class Worker:
    def __init__(self, label, argv, launcher_log, log_directory):
        self.label = label
        self.argv = argv
        self.launcher_log = launcher_log
        self.log_directory = log_directory
        self.heartbeat_path = log_directory / "heartbeat.json"
        self.summary_path = log_directory / "summary.json"
        self.process = None
        self.log_stream = None
        self.started_monotonic = None
        self.exit_code = None
        self.heartbeat = None
        self.heartbeat_error = None
        self.taskkill = None


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(
        description="Launch and supervise concurrent ubt-probe.py workers.",
        epilog=(
            "Each worker object has label, launcher_log, and argv fields. argv is the "
            "complete argument list after ubt-probe.py, including unique "
            "--log-directory and --horde-token-file values."
        ),
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--spec",
        action="append",
        type=Path,
        help="JSON file containing one worker object; may be repeated.",
    )
    source.add_argument(
        "--spec-file",
        type=Path,
        help="JSON file containing an array of worker objects.",
    )
    parser.add_argument("--summary", required=True, type=Path)
    parser.add_argument("--timeout-seconds", required=True, type=float)
    parser.add_argument(
        "--status-interval-seconds",
        type=float,
        default=DEFAULT_STATUS_INTERVAL_SECONDS,
    )
    parser.add_argument(
        "--stop-timeout-seconds",
        type=float,
        default=DEFAULT_STOP_TIMEOUT_SECONDS,
    )
    return parser.parse_args(argv)


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"JSON file does not exist: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in {path}: {error}") from error


def extract_option(argv, option):
    values = []
    index = 0
    while index < len(argv):
        value = argv[index]
        if value == option:
            if index + 1 >= len(argv):
                raise ValueError(f"{option} requires a value.")
            values.append(argv[index + 1])
            index += 2
            continue
        prefix = option + "="
        if value.startswith(prefix):
            values.append(value[len(prefix) :])
        index += 1
    if len(values) != 1 or not values[0]:
        raise ValueError(f"Worker argv must contain exactly one nonempty {option}.")
    return values[0]


def validate_worker_entry(entry, source_name):
    if not isinstance(entry, dict):
        raise ValueError(f"{source_name} must contain a JSON object.")
    unknown = set(entry) - {"argv", "label", "launcher_log"}
    if unknown:
        raise ValueError(
            f"{source_name} contains unknown fields: {', '.join(sorted(unknown))}."
        )

    label = entry.get("label")
    if not isinstance(label, str) or not label.strip():
        raise ValueError(f"{source_name}.label must be a nonempty string.")
    if label != label.strip():
        raise ValueError(f"{source_name}.label must not have surrounding whitespace.")

    argv = entry.get("argv")
    if (
        not isinstance(argv, list)
        or not argv
        or any(not isinstance(value, str) or not value for value in argv)
    ):
        raise ValueError(
            f"{source_name}.argv must be a nonempty array of nonempty strings."
        )
    extract_option(argv, "--horde-token-file")
    log_directory = Path(extract_option(argv, "--log-directory"))
    if not log_directory.is_absolute():
        raise ValueError(f"{source_name} --log-directory must be absolute.")

    launcher_log_value = entry.get("launcher_log")
    if not isinstance(launcher_log_value, str) or not launcher_log_value:
        raise ValueError(f"{source_name}.launcher_log must be a nonempty string.")
    launcher_log = Path(launcher_log_value)
    if not launcher_log.is_absolute():
        raise ValueError(f"{source_name}.launcher_log must be absolute.")

    return Worker(label, list(argv), launcher_log, log_directory)


def load_workers(arguments):
    entries = []
    if arguments.spec is not None:
        for path in arguments.spec:
            entries.append((read_json(path), str(path)))
    else:
        document = read_json(arguments.spec_file)
        if not isinstance(document, list) or not document:
            raise ValueError("--spec-file must contain a nonempty JSON array.")
        entries.extend(
            (entry, f"{arguments.spec_file}[{index}]")
            for index, entry in enumerate(document)
        )

    workers = [validate_worker_entry(entry, source) for entry, source in entries]
    labels = [worker.label.casefold() for worker in workers]
    if len(labels) != len(set(labels)):
        raise ValueError("Worker labels must be unique (case-insensitive).")

    launcher_logs = [os.path.normcase(str(worker.launcher_log)) for worker in workers]
    if len(launcher_logs) != len(set(launcher_logs)):
        raise ValueError("Worker launcher_log paths must be unique.")

    log_directories = [os.path.normcase(str(worker.log_directory)) for worker in workers]
    if len(log_directories) != len(set(log_directories)):
        raise ValueError("Worker --log-directory paths must be unique.")
    return workers


def validate_arguments(arguments):
    if os.name != "nt":
        raise RuntimeError("This supervisor requires Windows.")
    if arguments.timeout_seconds <= 0:
        raise ValueError("--timeout-seconds must be greater than zero.")
    if arguments.status_interval_seconds <= 0:
        raise ValueError("--status-interval-seconds must be greater than zero.")
    if arguments.stop_timeout_seconds <= 0:
        raise ValueError("--stop-timeout-seconds must be greater than zero.")
    if not arguments.summary.is_absolute():
        raise ValueError("--summary must be an absolute path.")


def normalized_path(path):
    return os.path.normcase(os.path.abspath(path))


def paths_collide(first, second):
    return normalized_path(first) == normalized_path(second)


def path_is_at_or_beneath(path, directory):
    try:
        common = os.path.commonpath(
            (normalized_path(path), normalized_path(directory))
        )
        return common == normalized_path(directory)
    except ValueError:
        return False


def prepare_output_paths(workers, summary_path):
    reserved_paths = [summary_path]
    for worker in workers:
        reserved_paths.extend((worker.heartbeat_path, worker.summary_path))

    normalized_reserved = [normalized_path(path) for path in reserved_paths]
    if len(normalized_reserved) != len(set(normalized_reserved)):
        raise ValueError("Supervisor and worker JSON output paths must be unique.")

    for worker in workers:
        if any(paths_collide(worker.launcher_log, path) for path in reserved_paths):
            raise ValueError(
                f"Worker {worker.label} launcher_log collides with a JSON output path."
            )
        if any(
            path_is_at_or_beneath(worker.launcher_log, other.log_directory)
            for other in workers
        ):
            raise ValueError(
                f"Worker {worker.label} launcher_log must be outside every worker "
                "--log-directory."
            )
        if any(
            path_is_at_or_beneath(summary_path, worker.log_directory)
            for worker in workers
        ):
            raise ValueError("--summary must be outside every worker --log-directory.")
        worker.launcher_log.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)


def atomic_write_json(path, value):
    text = json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    temporary_path = path.with_name(path.name + ".tmp")
    with temporary_path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary_path, path)


def read_heartbeat(worker):
    try:
        document = read_json(worker.heartbeat_path)
        if not isinstance(document, dict):
            raise ValueError("heartbeat root is not an object")
        worker.heartbeat = document
        worker.heartbeat_error = None
    except FileNotFoundError:
        worker.heartbeat = None
        worker.heartbeat_error = None
    except ValueError as error:
        if not worker.heartbeat_path.exists():
            worker.heartbeat = None
            worker.heartbeat_error = None
        else:
            worker.heartbeat_error = str(error)
    except OSError as error:
        worker.heartbeat_error = f"{type(error).__name__}: {error}"


def safe_size(path):
    try:
        return path.stat().st_size
    except OSError:
        return None


def worker_status(worker, now_monotonic):
    read_heartbeat(worker)
    return {
        "elapsed_seconds": (
            round(now_monotonic - worker.started_monotonic, 3)
            if worker.started_monotonic is not None
            else None
        ),
        "heartbeat": worker.heartbeat,
        "heartbeat_error": worker.heartbeat_error,
        "label": worker.label,
        "launcher_log_bytes": safe_size(worker.launcher_log),
        "pid": worker.process.pid if worker.process is not None else None,
        "state": (
            "not_started"
            if worker.process is None
            else "running"
            if worker.process.poll() is None
            else "exited"
        ),
    }


def print_status(workers, started_monotonic):
    now = time.monotonic()
    status = {
        "elapsed_seconds": round(now - started_monotonic, 3),
        "event": "status",
        "workers": [worker_status(worker, now) for worker in workers],
    }
    print(json.dumps(status, sort_keys=True, separators=(",", ":")), flush=True)


def launch_workers(workers, probe_path):
    creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
    for worker in workers:
        worker.log_stream = worker.launcher_log.open("wb")

    for worker in workers:
        worker.started_monotonic = time.monotonic()
        worker.process = subprocess.Popen(
            (sys.executable, str(probe_path), *worker.argv),
            cwd=str(probe_path.parent),
            stdin=subprocess.DEVNULL,
            stdout=worker.log_stream,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
        )


def wait_until(workers, deadline):
    while time.monotonic() < deadline:
        if all(
            worker.process is None or worker.process.poll() is not None
            for worker in workers
        ):
            return
        time.sleep(0.05)


def append_taskkill_output(worker, result):
    if worker.log_stream is None:
        return
    worker.log_stream.write(b"\n[supervisor taskkill stdout]\n")
    worker.log_stream.write(result.stdout)
    worker.log_stream.write(b"\n[supervisor taskkill stderr]\n")
    worker.log_stream.write(result.stderr)
    worker.log_stream.flush()


def stop_workers(workers, stop_timeout_seconds):
    live = [
        worker
        for worker in workers
        if worker.process is not None and worker.process.poll() is None
    ]
    for worker in live:
        try:
            worker.process.send_signal(signal.CTRL_BREAK_EVENT)
        except (OSError, ProcessLookupError):
            pass

    wait_until(live, time.monotonic() + stop_timeout_seconds)
    survivors = [worker for worker in live if worker.process.poll() is None]
    for worker in survivors:
        try:
            result = subprocess.run(
                ("taskkill.exe", "/PID", str(worker.process.pid), "/T"),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=stop_timeout_seconds,
            )
            worker.taskkill = {
                "attempted": True,
                "exit_code": result.returncode,
                "timed_out": False,
            }
            append_taskkill_output(worker, result)
        except subprocess.TimeoutExpired as error:
            worker.taskkill = {
                "attempted": True,
                "error": f"{type(error).__name__}: {error}",
                "exit_code": None,
                "timed_out": True,
            }
            if error.stdout or error.stderr:
                result = subprocess.CompletedProcess(
                    error.cmd,
                    None,
                    stdout=error.stdout or b"",
                    stderr=error.stderr or b"",
                )
                append_taskkill_output(worker, result)
        except OSError as error:
            worker.taskkill = {
                "attempted": True,
                "error": f"{type(error).__name__}: {error}",
                "exit_code": None,
                "timed_out": False,
            }

    wait_until(survivors, time.monotonic() + stop_timeout_seconds)


def read_worker_result(worker):
    result = {
        "exit_code": worker.process.poll() if worker.process is not None else None,
        "heartbeat": worker.heartbeat,
        "heartbeat_error": worker.heartbeat_error,
        "heartbeat_path": str(worker.heartbeat_path),
        "label": worker.label,
        "launcher_log": str(worker.launcher_log),
        "launcher_log_bytes": safe_size(worker.launcher_log),
        "pid": worker.process.pid if worker.process is not None else None,
        "summary_path": str(worker.summary_path),
        "taskkill": worker.taskkill,
    }
    if not worker.summary_path.is_file():
        result["ok"] = False
        result["result_error"] = "worker summary.json is missing"
        return result
    try:
        summary = read_json(worker.summary_path)
    except ValueError as error:
        result["ok"] = False
        result["result_error"] = str(error)
        return result
    if not isinstance(summary, dict):
        result["ok"] = False
        result["result_error"] = "worker summary.json root is not an object"
        return result
    result["worker_summary_ok"] = summary.get("ok")
    result["ok"] = result["exit_code"] == 0 and summary.get("ok") is True
    if result["exit_code"] != 0:
        result["result_error"] = "worker exit code is nonzero or unavailable"
    elif summary.get("ok") is not True:
        result["result_error"] = "worker summary.json is not ok"
    return result


def evaluate_results(workers):
    results = [read_worker_result(worker) for worker in workers]
    return all(result["ok"] for result in results), results


def close_worker_logs(workers):
    for worker in workers:
        if worker.process is not None:
            worker.exit_code = worker.process.poll()
        if worker.log_stream is not None:
            worker.log_stream.close()
            worker.log_stream = None


def main(argv=None):
    arguments = parse_arguments(argv)
    started_monotonic = time.monotonic()
    workers = []
    errors = []
    timed_out = False
    interrupted = False
    probe_path = Path(__file__).with_name("ubt-probe.py").resolve()

    try:
        validate_arguments(arguments)
        workers = load_workers(arguments)
        prepare_output_paths(workers, arguments.summary)
        if not probe_path.is_file():
            raise FileNotFoundError(f"ubt-probe.py is missing: {probe_path}")

        launch_workers(workers, probe_path)
        deadline = started_monotonic + arguments.timeout_seconds
        next_status = started_monotonic
        while any(worker.process.poll() is None for worker in workers):
            now = time.monotonic()
            if now >= next_status:
                print_status(workers, started_monotonic)
                next_status = now + arguments.status_interval_seconds
            if now >= deadline:
                timed_out = True
                raise TimeoutError(
                    f"Overall timeout exceeded {arguments.timeout_seconds:g} seconds."
                )
            time.sleep(min(0.1, max(0.0, deadline - now)))
    except KeyboardInterrupt:
        interrupted = True
        errors.append("KeyboardInterrupt: supervisor interrupted")
    except BaseException as error:
        errors.append(f"{type(error).__name__}: {error}")
        if arguments.summary.parent.exists():
            try:
                traceback_path = arguments.summary.with_name(
                    arguments.summary.name + ".error.log"
                )
                traceback_path.write_text(traceback.format_exc(), encoding="utf-8")
            except OSError:
                pass
    finally:
        if any(
            worker.process is not None and worker.process.poll() is None
            for worker in workers
        ):
            try:
                stop_workers(workers, arguments.stop_timeout_seconds)
            except BaseException as error:
                errors.append(f"Shutdown {type(error).__name__}: {error}")
        for worker in workers:
            if worker.process is not None:
                try:
                    worker.process.wait(timeout=0)
                except subprocess.TimeoutExpired:
                    errors.append(
                        f"Worker {worker.label} remained live after bounded shutdown."
                    )
        if workers:
            try:
                print_status(workers, started_monotonic)
            except OSError as error:
                errors.append(f"Status output {type(error).__name__}: {error}")
        close_worker_logs(workers)

    workers_ok, worker_results = evaluate_results(workers)
    ok = not errors and not timed_out and not interrupted and workers_ok
    summary = {
        "elapsed_seconds": round(time.monotonic() - started_monotonic, 3),
        "errors": errors,
        "interrupted": interrupted,
        "ok": ok,
        "timed_out": timed_out,
        "workers": worker_results,
    }
    try:
        arguments.summary.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(arguments.summary, summary)
    except OSError as error:
        print(f"Failed to write supervisor summary: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, sort_keys=True, separators=(",", ":")), flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
