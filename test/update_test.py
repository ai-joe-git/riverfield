"""Updater safety checks in disposable repositories, without network access."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class UpdateTest(unittest.TestCase):
    def run_update(self, dirty=False, branch="main", args=()):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory)
            subprocess.run(["git", "init", "-q", "-b", branch, directory], check=True)
            shutil.copy(ROOT / "update.sh", dest / "update.sh")
            subprocess.run(["git", "add", "update.sh"], cwd=dest, check=True)
            subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], cwd=dest, check=True)
            if dirty:
                (dest / "user-work.txt").write_text("keep me")
            result = subprocess.run(["bash", "update.sh", *args], cwd=dest, capture_output=True, text=True)
            if dirty:
                self.assertEqual((dest / "user-work.txt").read_text(), "keep me")
            return result

    def test_refuses_dirty_tree_before_fetch(self):
        result = self.run_update(dirty=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not clean", result.stderr)

    def test_refuses_other_branches_before_fetch(self):
        result = self.run_update(branch="feature")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Switch to main", result.stderr)

    def test_invalid_option(self):
        result = self.run_update(args=("--merge-upstream",))
        self.assertEqual(result.returncode, 2)
        self.assertIn("Usage:", result.stderr)


if __name__ == "__main__":
    unittest.main()
