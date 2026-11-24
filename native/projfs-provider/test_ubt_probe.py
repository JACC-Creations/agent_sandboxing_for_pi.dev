import importlib.util
from pathlib import Path
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("ubt-probe.py")
SPEC = importlib.util.spec_from_file_location("ubt_probe", MODULE_PATH)
ubt_probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ubt_probe)


def process(pid, creation_date, executable_path):
    return {
        "creation_date": creation_date,
        "executable_path": executable_path,
        "pid": pid,
    }


class ProcessSelectionTests(unittest.TestCase):
    def test_root_match_requires_separator_boundary(self):
        root = r"E:\Projected\Root"

        self.assertTrue(
            ubt_probe.path_is_beneath_root(
                r"e:\projected\root\Engine\Binaries\dotnet.exe", root
            )
        )
        self.assertFalse(
            ubt_probe.path_is_beneath_root(
                r"E:\Projected\Root-Sibling\dotnet.exe", root
            )
        )
        self.assertFalse(ubt_probe.path_is_beneath_root(root, root))

    def test_selection_excludes_only_exact_baseline_identity(self):
        root = r"E:\Projected\Root"
        preexisting = process(100, "2026-01-01T00:00:00.0000000Z", root + r"\old.exe")
        reused_pid = process(100, "2026-01-01T00:01:00.0000000Z", root + r"\new.exe")
        outside = process(200, "2026-01-01T00:02:00.0000000Z", r"C:\Tools\worker.exe")

        matches = ubt_probe.select_new_root_processes(
            [preexisting, reused_pid, outside],
            root,
            {ubt_probe.process_identity(preexisting)},
        )

        self.assertEqual(matches, [reused_pid])


class ProcessCleanupTests(unittest.TestCase):
    def test_cleanup_terminates_new_identity_and_reports_structured_result(self):
        root = r"E:\Projected\Root"
        preexisting = process(100, "2026-01-01T00:00:00.0000000Z", root + r"\old.exe")
        orphan = process(200, "2026-01-01T00:01:00.0000000Z", root + r"\worker.exe")

        with mock.patch.object(
            ubt_probe,
            "query_processes",
            side_effect=[[preexisting, orphan], [preexisting], [preexisting]],
        ), mock.patch.object(
            ubt_probe,
            "terminate_process_identity",
            return_value={"return_value": 0, "status": "terminated"},
        ) as terminate, mock.patch.object(ubt_probe.time, "sleep"):
            result = ubt_probe.cleanup_projected_root_processes(root, [preexisting])

        terminate.assert_called_once_with(orphan, root, timeout=mock.ANY)
        self.assertEqual(result["baseline"], [ubt_probe.process_summary(preexisting)])
        self.assertEqual(result["matched"], [ubt_probe.process_summary(orphan)])
        self.assertEqual(result["terminated"][0]["pid"], orphan["pid"])
        self.assertEqual(result["surviving"], [])
        self.assertEqual(result["errors"], [])


if __name__ == "__main__":
    unittest.main()
