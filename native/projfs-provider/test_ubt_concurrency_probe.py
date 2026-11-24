import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("ubt-concurrency-probe.py")
SPEC = importlib.util.spec_from_file_location("ubt_concurrency_probe", MODULE_PATH)
ubt_concurrency_probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ubt_concurrency_probe)


class FakeProcess:
    def __init__(self, pid, exit_code):
        self.pid = pid
        self.exit_code = exit_code

    def poll(self):
        return self.exit_code


class SpecValidationTests(unittest.TestCase):
    def worker_entry(self, root, label="first"):
        return {
            "label": label,
            "argv": [
                "--log-directory",
                str(root / label / "probe"),
                "--horde-token-file",
                str(root / "token.json"),
            ],
            "launcher_log": str(root / label / "launcher.log"),
        }

    def test_repeated_specs_load_objects_without_retaining_token_contents(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            first_path = root / "first.json"
            second_path = root / "second.json"
            first_path.write_text(
                json.dumps(self.worker_entry(root, "first")), encoding="utf-8"
            )
            second_path.write_text(
                json.dumps(self.worker_entry(root, "second")), encoding="utf-8"
            )
            arguments = ubt_concurrency_probe.parse_arguments(
                [
                    "--spec",
                    str(first_path),
                    "--spec",
                    str(second_path),
                    "--summary",
                    str(root / "summary.json"),
                    "--timeout-seconds",
                    "10",
                ]
            )

            workers = ubt_concurrency_probe.load_workers(arguments)

            self.assertEqual([worker.label for worker in workers], ["first", "second"])
            self.assertEqual(workers[0].summary_path.name, "summary.json")

    def test_array_spec_rejects_case_insensitive_duplicate_labels(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            spec_path = root / "workers.json"
            spec_path.write_text(
                json.dumps(
                    [
                        self.worker_entry(root, "Worker"),
                        self.worker_entry(root, "worker"),
                    ]
                ),
                encoding="utf-8",
            )
            arguments = ubt_concurrency_probe.parse_arguments(
                [
                    "--spec-file",
                    str(spec_path),
                    "--summary",
                    str(root / "summary.json"),
                    "--timeout-seconds",
                    "10",
                ]
            )

            with self.assertRaisesRegex(ValueError, "labels must be unique"):
                ubt_concurrency_probe.load_workers(arguments)

    def test_worker_rejects_missing_token_file_option(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            entry = self.worker_entry(root)
            entry["argv"] = ["--log-directory", str(root / "probe")]

            with self.assertRaisesRegex(ValueError, "--horde-token-file"):
                ubt_concurrency_probe.validate_worker_entry(entry, "test")

    def test_worker_rejects_unknown_fields(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory).resolve()
            entry = self.worker_entry(root)
            entry["token"] = "must-not-be-accepted"

            with self.assertRaisesRegex(ValueError, "unknown fields: token"):
                ubt_concurrency_probe.validate_worker_entry(entry, "test")


class ResultEvaluationTests(unittest.TestCase):
    def make_worker(self, root, exit_code):
        worker = ubt_concurrency_probe.Worker(
            "worker",
            ["--log-directory", str(root), "--horde-token-file", "token.json"],
            root / "launcher.log",
            root,
        )
        worker.process = FakeProcess(123, exit_code)
        return worker

    def test_result_is_ok_only_for_zero_exit_and_ok_summary(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            worker = self.make_worker(root, 0)
            worker.summary_path.write_text('{"ok":true}\n', encoding="utf-8")

            ok, results = ubt_concurrency_probe.evaluate_results([worker])

            self.assertTrue(ok)
            self.assertTrue(results[0]["ok"])

    def test_nonzero_exit_fails_even_with_ok_summary(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            worker = self.make_worker(root, 7)
            worker.summary_path.write_text('{"ok":true}\n', encoding="utf-8")

            ok, results = ubt_concurrency_probe.evaluate_results([worker])

            self.assertFalse(ok)
            self.assertFalse(results[0]["ok"])

    def test_missing_summary_fails(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            worker = self.make_worker(Path(temporary_directory), 0)

            ok, results = ubt_concurrency_probe.evaluate_results([worker])

            self.assertFalse(ok)
            self.assertEqual(
                results[0]["result_error"], "worker summary.json is missing"
            )


if __name__ == "__main__":
    unittest.main()
