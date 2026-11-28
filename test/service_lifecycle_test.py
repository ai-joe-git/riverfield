"""Exercise the desktop launchers on private test ports without GPU inference."""
from pathlib import Path
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def ports(count):
    reservations = [socket.socket() for _ in range(count)]
    try:
        for sock in reservations:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in reservations]
    finally:
        for sock in reservations:
            sock.close()


@unittest.skipUnless(sys.platform.startswith("linux") and all(shutil.which(cmd) for cmd in
                     ("ss", "flock", "curl", "node")), "Linux studio launcher tools required")
class LocalLifecycleTest(unittest.TestCase):
    def test_adopts_live_listeners_and_stops_them_with_stale_pid_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "logs"
            for folder in ("local", "infra", "server", "mcp"):
                (root / folder).mkdir()
            for name in ("start.sh", "stop.sh", "run-web.sh", "run-mcp.sh", "local/service-lifecycle.sh"):
                shutil.copy2(ROOT / name, root / name)
            backend, web, mcp = ports(3)
            (root / ".env").write_text(
                f"GATEWAY_PORT={backend}\nPORT={web}\nRIVERFIELD_MCP_PORT={mcp}\nRIVERFIELD_TOKEN=test-key\n")
            (root / "infra/gateway.py").write_text(
                "import json, os\n"
                "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
                "class Handler(BaseHTTPRequestHandler):\n"
                " def reply(self, code, data):\n"
                "  self.send_response(code); self.end_headers(); self.wfile.write(json.dumps(data).encode())\n"
                " def do_GET(self): self.reply(200, {'ok': True})\n"
                " def do_POST(self):\n"
                "  ready = self.path == '/riverfield/workspace-comfy/wake' and self.headers.get('Authorization') == 'Bearer test-key'\n"
                "  self.reply(200 if ready else 403, {'state': 'running', 'port': 8189})\n"
                "HTTPServer(('127.0.0.1', int(os.environ['GATEWAY_PORT'])), Handler).serve_forever()\n"
            )
            launcher = root / "run-backend.sh"
            launcher.write_text("#!/usr/bin/env bash\nexec python3 infra/gateway.py\n")
            launcher.chmod(0o755)
            for name, variable in (("server/server.ts", "PORT"), ("mcp/server.ts", "RIVERFIELD_MCP_PORT")):
                (root / name).write_text(
                    "import http from 'node:http';\n"
                    f"http.createServer((req, res) => res.end('ok')).listen(Number(process.env.{variable}), '127.0.0.1');\n"
                )
            env = {**os.environ, "RIVERFIELD_LOG": str(log), "DISPLAY": "", "WAYLAND_DISPLAY": ""}
            def run(name, *args, check=True):
                return subprocess.run([root / name, *args], cwd=root, env=env, check=check, timeout=20,
                                      text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

            def pid(name):
                return int((log / f"{name}.pid").read_text())

            try:
                started = run("start.sh")
                self.assertIn("ComfyUI prêt : http://127.0.0.1:8189/", started.stdout)
                active = {name: pid(name) for name in ("backend", "web", "mcp")}
                for name in active:
                    (log / f"{name}.pid").write_text(str(os.getpid()))
                reused = run("start.sh", "--on-demand")
                self.assertIn("ComfyUI démarre à la demande", reused.stdout)
                self.assertEqual({name: pid(name) for name in active}, active)
                for name in active:
                    (log / f"{name}.pid").write_text("99999999")
                run("stop.sh")
                for port in (backend, web, mcp):
                    with socket.socket() as sock:
                        self.assertNotEqual(sock.connect_ex(("127.0.0.1", port)), 0)
                self.assertFalse(any((log / f"{name}.pid").exists() for name in active))
                self.assertTrue((log / "start.log").exists())
            finally:
                run("stop.sh", check=False)


if __name__ == "__main__":
    unittest.main()
