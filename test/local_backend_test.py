"""Upstream backend fixes, without starting ComfyUI or using a GPU."""
import importlib.util
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("local_backend", ROOT / "tools/local_backend.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class LocalBackendTest(unittest.TestCase):
    def test_proxy_beside_python_wins_over_path(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "python"
            proxy = Path(directory) / "comfy-api-proxy"
            proxy.touch()
            with patch.object(sys, "executable", str(executable)), patch.object(backend.shutil, "which") as which:
                self.assertEqual(backend.find_proxy(), str(proxy))
                which.assert_not_called()

    def test_proxy_falls_back_to_path(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(sys, "executable", str(Path(directory) / "python")), patch.object(backend.shutil, "which", return_value="/proxy"):
                self.assertEqual(backend.find_proxy(), "/proxy")

    def test_sigterm_stops_all_three_children(self):
        children = [Mock(), Mock(), Mock()]
        for child in children:
            child.poll.return_value = None
        handlers = {}

        def register(sig, handler):
            handlers[sig] = handler

        def interrupted_health(url, *_):
            if url.endswith("/health"):
                handlers[signal.SIGTERM](signal.SIGTERM, None)

        with patch.object(backend, "env_token", return_value="test"), patch.object(backend, "find_proxy", return_value="proxy"), patch.object(backend.signal, "signal", side_effect=register), patch.object(backend.subprocess, "Popen", side_effect=children), patch.object(backend, "wait_http", side_effect=interrupted_health), patch.object(backend, "wait_port"):
            backend.serve(Path("/unused"), [], 8000)
        for child in children:
            child.terminate.assert_called_once()
            child.wait.assert_called_once_with(timeout=15)


if __name__ == "__main__":
    unittest.main()
