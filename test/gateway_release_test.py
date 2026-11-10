import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, AsyncMock
from aiohttp import web

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
    return dict(busy=False, pending=False, loaded_models=0, reserved_bytes=0, **changes)


class ReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_requires_four_confirmations_after_pending_flags_and_cached_models(self):
        states = [state(), {**state(), "pending": True}, {**state(), "loaded_models": 1}, {**state(), "reserved_bytes": 100}, state()]
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
        session = Session([{**state(), "reserved_bytes": 10}])
        with patch.object(gateway.asyncio, "sleep", new=AsyncMock()), patch.object(gateway.time, "monotonic", side_effect=[0, 1, 50]):
            with self.assertRaises(web.HTTPConflict):
                await gateway.Pantry(session).release()


if __name__ == "__main__":
    unittest.main()
