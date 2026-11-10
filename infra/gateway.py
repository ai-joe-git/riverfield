"""The pass: the only door into the backend container.

    client (SDK) ──▶ gateway :8000 ──▶ comfy-api-proxy :8189 ──▶ ComfyUI :8188

- Every request needs `Authorization: Bearer $RIVERFIELD_TOKEN` (the Comfy SDK sends its
  apiKey that way). The header is stripped before forwarding; the proxy has no auth.
- POST /riverfield/prepare {"app", "models"} is the pantry manager: when the requested
  app needs a different set of models than the one that ran last, it asks ComfyUI to
  unload everything (POST /free) so nothing from the previous app stays in VRAM.
- GET /riverfield/status shows the current app and ComfyUI's device stats.
- GET /health is open, for Modal's startup probe.
- The proxy writes absolute links (a job's `urls.self`, `.events`, `.cancel`, an output's
  `url`) from the host *it* sees, http://127.0.0.1:8189; the SDK follows those links
  verbatim, so from outside they went nowhere ("fetch failed", 23 oct). JSON answers are
  rewritten to the address the client reached the gateway on.

Run: python gateway.py  (env: RIVERFIELD_TOKEN, COMFYUI_URL, PROXY_URL, GATEWAY_PORT)
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import time

from aiohttp import ClientSession, ClientTimeout, web

COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
PROXY_URL = os.environ.get("PROXY_URL", "http://127.0.0.1:8189")
TOKEN = os.environ.get("RIVERFIELD_TOKEN", "")
ALLOW_OPEN = os.environ.get("RIVERFIELD_ALLOW_OPEN") == "1"
HOP_HEADERS = {"host", "authorization", "content-length", "transfer-encoding", "connection", "keep-alive"}

log = logging.getLogger("gateway")


class Pantry:
    """Remembers which models are on the GPU and clears it when an app needs others."""

    def __init__(self, session: ClientSession):
        self.session = session
        self.models: str | None = None
        self.app: str | None = None
        self.lock = asyncio.Lock()
        self.frees = 0

    async def prepare(self, app: str, models: str) -> dict:
        async with self.lock:
            # ComfyUI serializes prompts, but /free must not race a running or pending prompt.
            # This also protects clients which submit outside RiverField's web queue.
            while True:
                async with self.session.get(f"{COMFYUI_URL}/queue") as r:
                    r.raise_for_status()
                    queue = await r.json()
                if "queue_running" not in queue or "queue_pending" not in queue:
                    raise RuntimeError("ComfyUI queue state is unavailable; refusing to change models")
                if not queue["queue_running"] and not queue["queue_pending"]:
                    break
                await asyncio.sleep(0.25)
            freed = False
            previous = self.app
            if self.models is not None and models != self.models:
                async with self.session.post(f"{COMFYUI_URL}/free", json={"unload_models": True, "free_memory": True}) as r:
                    r.raise_for_status()
                freed = True
                self.frees += 1
            self.models, self.app = models, app
            return {"freed": freed, "previous": previous, "current": app}

    async def release(self) -> dict:
        async with self.lock:
            # Require the bridge: /free alone acknowledges a request, not released memory.
            async with self.session.get(f"{COMFYUI_URL}/riverfield-memory/status", timeout=ClientTimeout(total=5)) as r:
                if r.status != 200:
                    raise web.HTTPConflict(text="Install Riverfield's memory bridge and restart ComfyUI")
                state = await r.json()
            if state["busy"]:
                raise web.HTTPConflict(text="ComfyUI still has running or queued work")
            async with self.session.post(f"{COMFYUI_URL}/free", json={"unload_models": True, "free_memory": True}, timeout=ClientTimeout(total=5)) as r:
                r.raise_for_status()
            deadline, stable = time.monotonic() + 45, 0
            while time.monotonic() < deadline:
                await asyncio.sleep(0.5)
                async with self.session.get(f"{COMFYUI_URL}/riverfield-memory/status", timeout=ClientTimeout(total=5)) as r:
                    r.raise_for_status()
                    state = await r.json()
                if state["busy"]:
                    raise web.HTTPConflict(text="Another client submitted ComfyUI work during release")
                stable = stable + 1 if not state["pending"] and state["loaded_models"] == 0 and state["reserved_bytes"] == 0 else 0
                if stable >= 4:
                    self.models, self.app = None, None
                    self.frees += 1
                    return {"released": True, "comfyui": state}
            raise web.HTTPConflict(text="ComfyUI did not confirm released models and GPU allocator memory; refusing LLM reload")


def authorized(request: web.Request) -> bool:
    if ALLOW_OPEN:
        return True
    header = request.headers.get("Authorization", "")
    return bool(TOKEN) and hmac.compare_digest(header, f"Bearer {TOKEN}")


@web.middleware
async def auth_mw(request: web.Request, handler):
    if request.path == "/health" or authorized(request):
        return await handler(request)
    return web.json_response({"error": "missing or wrong token"}, status=401)


async def health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def prepare(request: web.Request) -> web.Response:
    body = await request.json()
    if not isinstance(body.get("models"), str) or not isinstance(body.get("app"), str):
        return web.json_response({"error": "expected {app, models}"}, status=400)
    result = await request.app["pantry"].prepare(body["app"], body["models"])
    log.info("prepare %s → %s", body["app"], result)
    return web.json_response(result)


async def status(request: web.Request) -> web.Response:
    pantry: Pantry = request.app["pantry"]
    stats = None
    try:
        async with pantry.session.get(f"{COMFYUI_URL}/system_stats") as r:
            stats = await r.json()
    except Exception as e:  # ComfyUI may still be starting
        stats = {"error": str(e)}
    return web.json_response({"app": pantry.app, "models": pantry.models, "frees": pantry.frees, "comfyui": stats})


async def release(request: web.Request) -> web.Response:
    return web.json_response(await request.app["pantry"].release())


LOCAL_HOSTS = ("127.0.0.1", "localhost", "0.0.0.0", "[::1]")


def external_base(request: web.Request) -> str:
    """Where the client reached us. Modal terminates TLS and talks plain http to the container
    without an X-Forwarded-Proto header (first deploy, 23 oct: links came out as http://…modal.run,
    the SDK saw another origin and sent no token, 401), so a public host is https unless a proxy
    says otherwise; only a local or private address keeps the scheme it was reached on."""
    forwarded = request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip()
    host = request.host
    name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
    private = name in LOCAL_HOSTS or name.startswith(("10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.", "172.2", "172.30.", "172.31."))
    scheme = forwarded or (request.scheme if private else "https")
    return f"{scheme}://{host}"


def relink(body: bytes, request: web.Request) -> bytes:
    """The proxy's own address in a JSON answer becomes the gateway's external one."""
    return body.replace(PROXY_URL.encode(), external_base(request).encode())


async def forward(request: web.Request) -> web.StreamResponse:
    session: ClientSession = request.app["session"]
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}

    async def body():
        async for chunk in request.content.iter_chunked(1 << 16):
            yield chunk

    data = body() if request.can_read_body else None
    async with session.request(request.method, f"{PROXY_URL}{request.rel_url}", headers=headers, data=data,
                               allow_redirects=False) as upstream:
        passthrough = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_HEADERS | {"content-encoding"}}
        if upstream.content_type == "application/json":   # job and asset answers carry links: fix them up whole
            raw = relink(await upstream.read(), request)
            passthrough.pop("Content-Length", None)
            return web.Response(status=upstream.status, body=raw, headers=passthrough)
        resp = web.StreamResponse(status=upstream.status)
        for k, v in passthrough.items():
            resp.headers[k] = v
        await resp.prepare(request)
        async for chunk in upstream.content.iter_any():   # streams SSE events and big files as they come
            await resp.write(chunk)
        await resp.write_eof()
        return resp


async def on_startup(app: web.Application) -> None:
    app["session"] = ClientSession(timeout=ClientTimeout(total=None, sock_connect=30), auto_decompress=False)
    app["pantry"] = Pantry(app["session"])


async def on_cleanup(app: web.Application) -> None:
    await app["session"].close()


def make_app() -> web.Application:
    if not TOKEN and not ALLOW_OPEN:
        raise SystemExit("RIVERFIELD_TOKEN is not set; refusing to start an open gateway")
    app = web.Application(middlewares=[auth_mw], client_max_size=1024 ** 3)
    app.router.add_get("/health", health)
    app.router.add_post("/riverfield/prepare", prepare)
    app.router.add_post("/riverfield/release", release)
    app.router.add_get("/riverfield/status", status)
    app.router.add_route("*", "/{tail:.*}", forward)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


async def wait_for(url: str, timeout_s: float = 600) -> None:
    """Block until url answers 200, so Modal only routes traffic once ComfyUI is up."""
    deadline = time.time() + timeout_s
    async with ClientSession() as s:
        while time.time() < deadline:
            try:
                async with s.get(url) as r:
                    if r.status == 200:
                        return
            except Exception:
                pass
            await asyncio.sleep(1)
    raise TimeoutError(f"{url} did not come up in {timeout_s:.0f}s")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    web.run_app(make_app(), host="0.0.0.0", port=int(os.environ.get("GATEWAY_PORT", "8000")))
