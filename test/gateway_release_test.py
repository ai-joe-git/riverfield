import importlib.util
import os
from pathlib import Path
import socket
from tempfile import TemporaryDirectory
from textwrap import dedent
import unittest
from unittest.mock import patch, AsyncMock
from aiohttp import ClientSession, web

spec = importlib.util.spec_from_file_location("riverfield_gateway", Path(__file__).parents[1] / "infra/gateway.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class Response:
    def __init__(self, data, status=200):
        self.data, self.status = data, status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def json(self):
        return self.data

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError("upstream unavailable")


class Session:
    def __init__(self, states, status=200):
        self.states, self.status, self.polls, self.posts = states, status, 0, []

    def get(self, _, **_options):
        state = self.states[min(self.polls, len(self.states) - 1)]
        self.polls += 1
        return Response(state, self.status)

    def post(self, url, json, **_options):
        self.posts.append((url, json))
        return Response({})


def state(**changes):
    return dict(busy=False, pending=False, loaded_models=0, reserved_bytes=0, allocated_bytes=0, **changes)


class ReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_requires_four_confirmations_after_pending_flags_and_cached_models(self):
        states = [state(), {**state(), "pending": True}, {**state(), "loaded_models": 1}, {**state(), "reserved_bytes": gateway.IDLE_GPU_BYTES + 1}, state()]
        session = Session(states)
        pantry = gateway.Pantry(session)
        pantry.models, pantry.app = "video", "pika"
        with patch.object(gateway.asyncio, "sleep", new=AsyncMock()):
            result = await pantry.release()
        self.assertTrue(result["released"])
        self.assertGreaterEqual(session.polls, 8)
        self.assertEqual(session.posts[0][1], {"unload_models": True, "free_memory": True})
        self.assertIsNone(pantry.models)

    async def test_missing_bridge_and_busy_queue_never_release(self):
        for session in (Session([state()], status=404), Session([{**state(), "busy": True}])):
            with self.assertRaises(web.HTTPConflict):
                await gateway.Pantry(session).release()
            self.assertEqual(session.posts, [])

    async def test_external_work_during_release_fails_closed(self):
        session = Session([state(), {**state(), "busy": True}])
        with patch.object(gateway.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(web.HTTPConflict):
                await gateway.Pantry(session).release()

    async def test_allocator_release_timeout_never_claims_success(self):
        session = Session([{**state(), "reserved_bytes": gateway.IDLE_GPU_BYTES + 1}])
        with patch.object(gateway.asyncio, "sleep", new=AsyncMock()), patch.object(gateway.time, "monotonic", side_effect=[0, 1, 50]):
            with self.assertRaises(web.HTTPConflict):
                await gateway.Pantry(session).release()

    async def test_small_permanent_rocm_buffers_are_reported_and_accepted_only_after_stability(self):
        steady = {**state(), "reserved_bytes": 80 * 1024 ** 2, "allocated_bytes": 79 * 1024 ** 2}
        session = Session([state(), {**steady, "allocated_bytes": 78 * 1024 ** 2}, steady])
        with patch.object(gateway.asyncio, "sleep", new=AsyncMock()):
            result = await gateway.Pantry(session).release()
        self.assertTrue(result["released"])
        self.assertEqual(result["retained_gpu_bytes"], steady["reserved_bytes"])
        self.assertGreaterEqual(session.polls, 6)


class ManagedWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_managed_worker_starts_on_demand_and_exits_only_after_idle_acknowledgement(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "main.py").write_text(dedent("""
                import argparse
                import runpy
                import sys
                from pathlib import Path
                from types import SimpleNamespace
                from aiohttp import web

                args = argparse.ArgumentParser()
                args.add_argument("--port", type=int, required=True)
                parsed, _ = args.parse_known_args()
                app = web.Application()
                routes = web.RouteTableDef()
                queue = SimpleNamespace(get_tasks_remaining=lambda: int(Path("busy").exists()), get_flags=lambda **_: {})
                instance = SimpleNamespace(app=app, routes=routes, prompt_queue=queue)
                sys.modules["server"] = SimpleNamespace(PromptServer=SimpleNamespace(instance=instance))
                sys.modules["comfy"] = SimpleNamespace(model_management=SimpleNamespace(current_loaded_models=[]))
                sys.modules["comfy.model_management"] = sys.modules["comfy"].model_management
                sys.modules["torch"] = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
                runpy.run_path(Path("bridge.py"))

                async def queue_status(request):
                    return web.json_response({"queue_running": [], "queue_pending": []})

                async def submit(request):
                    return web.json_response({"accepted": True})

                app.add_routes(routes)
                app.router.add_get("/queue", queue_status)
                app.router.add_post("/prompt", submit)
                web.run_app(app, host="127.0.0.1", port=parsed.port, print=None)
            """))
            (root / "bridge.py").write_bytes((Path(__file__).parents[1] / "local/riverfield-memory-bridge/__init__.py").read_bytes())
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            with patch.object(gateway, "COMFYUI_URL", f"http://127.0.0.1:{port}"):
                async with ClientSession() as session:
                    worker = gateway.ComfyWorker(session, folder, str(root / "worker.pid"))
                    pantry = gateway.Pantry(session, worker)
                    try:
                        self.assertEqual(await pantry.workspace(False), {"managed": True, "state": "parked"})
                        self.assertEqual((await pantry.release())["retained_gpu_bytes"], 0)
                        await pantry.prepare("first", "models")
                        pid = (await pantry.workspace(False))["comfyui"]["worker_pid"]
                        async with session.post(f"http://127.0.0.1:{port}/riverfield-memory/retire") as response:
                            self.assertEqual(response.status, 403)
                        (root / "busy").touch()
                        with self.assertRaises(web.HTTPConflict):
                            await pantry.workspace(True)
                        self.assertEqual((await pantry.workspace(False))["comfyui"]["worker_pid"], pid)
                        (root / "busy").unlink()
                        # An authorized retirement prevents direct submissions on the old worker.
                        async with session.post(f"http://127.0.0.1:{port}/riverfield-memory/retire",
                                                headers={"Authorization": f"Bearer {worker.token}"}) as response:
                            self.assertEqual(response.status, 200)
                        async with session.post(f"http://127.0.0.1:{port}/prompt") as response:
                            self.assertEqual(response.status, 503)
                        self.assertEqual(await pantry.workspace(True), {"managed": True, "state": "parked"})
                        with self.assertRaises(ProcessLookupError):
                            os.kill(pid, 0)
                        self.assertFalse((root / "worker.pid").exists())
                        self.assertEqual(await pantry.workspace(True), {"managed": True, "state": "parked"})
                        await pantry.prepare("second", "models")
                        self.assertNotEqual((await pantry.workspace(False))["comfyui"]["worker_pid"], pid)
                    finally:
                        await worker.stop()


if __name__ == "__main__":
    unittest.main()
