"""Model preparation must wait for the ComfyUI queue before requesting /free."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
from gateway import Pantry


class Reply:
    def __init__(self, data):
        self.data = data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    def raise_for_status(self):
        pass

    async def json(self):
        return self.data


class Backend:
    def __init__(self):
        self.running = True
        self.pending = False
        self.inspected = asyncio.Event()
        self.freed = []
        self.unknown = False

    def get(self, url):
        assert url.endswith("/queue")
        self.inspected.set()
        return Reply({} if self.unknown else {"queue_running": [1] if self.running else [], "queue_pending": [2] if self.pending else []})

    def post(self, url, json):
        assert not self.running and not self.pending, "Model unload raced an active prompt"
        self.freed.append((url, json))
        return Reply({})


class GatewayQueueTest(unittest.IsolatedAsyncioTestCase):
    async def test_unload_waits_for_running_job(self):
        backend = Backend()
        pantry = Pantry(backend)
        pantry.models = "H3"
        work = asyncio.create_task(pantry.prepare("relay", "RelayVSR"))
        await backend.inspected.wait()
        self.assertFalse(work.done())
        self.assertEqual(backend.freed, [])
        backend.running = False
        result = await work
        self.assertTrue(result["freed"])
        self.assertEqual(len(backend.freed), 1)

    async def test_pending_jobs_also_block_unloading(self):
        backend = Backend()
        backend.running = False
        backend.pending = True
        pantry = Pantry(backend)
        pantry.models = "image"
        work = asyncio.create_task(pantry.prepare("tts", "speech"))
        await backend.inspected.wait()
        self.assertEqual(backend.freed, [])
        backend.pending = False
        await work
        self.assertEqual(len(backend.freed), 1)

    async def test_unknown_queue_state_fails_closed(self):
        backend = Backend()
        backend.unknown = True
        pantry = Pantry(backend)
        pantry.models = "old"
        with self.assertRaisesRegex(RuntimeError, "refusing to change models"):
            await pantry.prepare("new", "new")
        self.assertEqual(backend.freed, [])


if __name__ == "__main__":
    unittest.main()
