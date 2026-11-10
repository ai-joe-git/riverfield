"""Local-only release acknowledgement for Riverfield's managed LLM handoff.

ComfyUI's /free is asynchronous. Never consume its worker flags here.
"""
from aiohttp import web
from server import PromptServer
import comfy.model_management as memory
import torch


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
        "busy": queue.get_tasks_remaining() != 0,
    })


NODE_CLASS_MAPPINGS = {}
