"""Local-only release acknowledgement for Riverfield's managed LLM handoff.

ComfyUI's /free is asynchronous. Never consume its worker flags here.
"""
import hmac
import os

from aiohttp import web
from server import PromptServer
import comfy.model_management as memory
import torch


owner_token = os.environ.pop("RIVERFIELD_MEMORY_OWNER_TOKEN", "")
retiring = False
active_submissions = 0


@web.middleware
async def protect_retiring_worker(request, handler):
    global active_submissions
    if request.method != "POST" or request.path.rstrip("/") not in ("/prompt", "/api/prompt"):
        return await handler(request)
    if retiring:
        raise web.HTTPServiceUnavailable(text="Riverfield is parking this ComfyUI worker")
    active_submissions += 1
    try:
        return await handler(request)
    finally:
        active_submissions -= 1


if owner_token:
    PromptServer.instance.app.middlewares.append(protect_retiring_worker)


@PromptServer.instance.routes.post("/riverfield-memory/retire")
async def retire(request):
    global retiring
    auth = request.headers.get("Authorization", "")
    if request.remote not in ("127.0.0.1", "::1") or not owner_token or not hmac.compare_digest(auth, "Bearer " + owner_token):
        raise web.HTTPForbidden()
    queue = PromptServer.instance.prompt_queue
    if active_submissions or queue.get_tasks_remaining():
        raise web.HTTPConflict(text="ComfyUI still has active submissions or queued work")
    retiring = True
    return web.json_response({"worker_pid": os.getpid()})


@PromptServer.instance.routes.get("/riverfield-memory/status")
async def status(request):
    if request.remote not in ("127.0.0.1", "::1"):
        raise web.HTTPForbidden()
    queue = PromptServer.instance.prompt_queue
    flags = queue.get_flags(reset=False)
    reserved = sum(torch.cuda.memory_reserved(i) for i in range(torch.cuda.device_count())) if torch.cuda.is_available() else 0
    allocated = sum(torch.cuda.memory_allocated(i) for i in range(torch.cuda.device_count())) if torch.cuda.is_available() else 0
    return web.json_response({
        "pending": bool(flags.get("unload_models") or flags.get("free_memory")),
        "loaded_models": len(memory.current_loaded_models),
        "reserved_bytes": reserved,
        "allocated_bytes": allocated,
        "busy": bool(active_submissions or queue.get_tasks_remaining()),
        "worker_pid": os.getpid(),
    })


NODE_CLASS_MAPPINGS = {}
