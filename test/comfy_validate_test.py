"""The CPU validator must not create shadow weights in a real model installation."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from comfy_validate import check_placeholder_install


class PlaceholderSafetyTest(unittest.TestCase):
    def test_empty_fixture_is_allowed(self):
        with tempfile.TemporaryDirectory() as root:
            model = Path(root) / "models/unet/stub.safetensors"
            model.parent.mkdir(parents=True)
            model.touch()
            check_placeholder_install(Path(root))

    def test_real_weights_reject_placeholders_without_writing_files(self):
        with tempfile.TemporaryDirectory() as root:
            model = Path(root) / "models/diffusion_models/real.safetensors"
            model.parent.mkdir(parents=True)
            model.write_bytes(b"real weights")
            with self.assertRaisesRegex(ValueError, "empty CPU test installation"):
                check_placeholder_install(Path(root))
            self.assertFalse((Path(root) / "models/unet/real.safetensors").exists())


if __name__ == "__main__":
    unittest.main()
