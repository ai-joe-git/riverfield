# RiverField MCP

An agent can drive the studio the way the web UI does: list apps, read their inputs, start a run,
wait for it, take the files. It is a thin client of RiverField's own API — no ComfyUI knowledge here,
and nothing new to learn about the backend.

`./start.sh` launches it with the app: **http://127.0.0.1:3010/mcp** (HTTP, streamable).
`./run-mcp.sh --stdio` is the same server over stdio, for clients that spawn it (opencode, Claude
Desktop). The app itself must be running: the MCP calls it.

## Tools

| Tool | What it does |
|---|---|
| `list_apps` | every app with section, status and pack (`section: audio`, `3d`, … to filter) |
| `get_app` | one manifest: inputs with `type`, `default`, `options`, `file` (path input) and `panel` (driven by a custom UI, still settable here), presets, outputs, models, notes, example |
| `run_app` | start a run: `values` by input id (numbers, strings, booleans, arrays, **JSON strings**), `files` by absolute path for `image`/`video`/`audio` inputs, optional `preset` → returns the history id |
| `job` | one run: status, progress, queue position, outputs so far (absolute paths) |
| `wait_job` | poll until it finishes (10 min by default) and return the output files |
| `cancel_job` | ask the backend to stop a run |
| `history` | the studio's history: what ran, with what values, where the files are |
| `gpu` | backend warm? which app is loaded, VRAM in use |
| `examples` | the lab example of an app: the exact values and inputs that made it |
| `autoshorts` | persistent local video projects: capabilities, create/edit, storyboard, scene generation/review/upscale, production, render and cancellation; [API and setup](../docs/autoshorts.md) |

Outputs come back as absolute paths (`out/history/<id>/out-01.png`), so an agent can open them
directly.

`get_app` marks each input: `file: true` means it takes an entry in `run_app.files` (absolute
path), `panel: true` means the web UI drives it from a custom panel but the API accepts it like
any other input. Optional pass-through nodes (the ROCm `H3SLAAttentionROCM`) are bypassed by the
runner when the backend does not ship their class, so the same app runs on CUDA or Intel XPU. Complex structures travel as **JSON strings** in `values` — the app's `notes`
field documents them (that is how the Studio Director's Material Planner is driven).

## From opencode

```jsonc
{
  "mcp": {
    "riverfield": {
      "type": "local",
      "command": ["/home/zardoz/freefield/run-mcp.sh", "--stdio"],
      "enabled": true
    }
  }
}
```

Or point a remote-capable client at `http://127.0.0.1:3010/mcp` (no auth; it listens on
127.0.0.1 only — set `RIVERFIELD_MCP_HOST` to open it, at your own risk).

Claude Desktop, stdio:

```json
{
  "mcpServers": {
    "riverfield": { "command": "/home/zardoz/freefield/run-mcp.sh", "args": ["--stdio"] }
  }
}
```

## By hand

```sh
# what the studio can do
curl -s http://127.0.0.1:3010/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_apps","arguments":{"section":"video"}}}'

# one picture
curl -s http://127.0.0.1:3010/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_app","arguments":{"app":"z-image","values":{"prompt":"a red bicycle, studio light"}}}}'
```

## Studio Director (Material Planner) from an agent

`studio-director` exposes the whole Material Planner. Two ways, both through `values`:

```jsonc
// simple: equal windows, every picture/audio on every segment
{ "app": "studio-director",
  "values": { "global_prompt": "a 1990s sitcom set", "duration": 8, "segment_count": 2,
              "segment_prompts": "wide shot\nclose up", "detail": 0.7, "two_stage": false },
  "files": { "image1": "/abs/pilot.png", "image2": "/abs/station.png" } }

// exact: explicit windows, per-segment ordered media, video clip timing
{ "app": "studio-director",
  "values": { "segment_windows": "{\"windows\":[
      {\"start\":0,\"end\":192,\"prompt\":\"shot 1\",\"images\":[0],\"audios\":[]},
      {\"start\":153,\"end\":345,\"prompt\":\"shot 2\",\"images\":[0,1],\"audios\":[0]}],
      \"videos\":[{\"index\":0,\"start\":0,\"duration\":6,\"trimStart\":0,\"referenceMode\":\"guide\"}],
      \"audios\":[{\"index\":0,\"start\":0,\"duration\":6,\"trimStart\":0}]}" },
  "files": { "image1": "/abs/a.png", "image2": "/abs/b.png",
             "audio1": "/abs/voice.wav", "video1": "/abs/clip.mp4" } }
```

Frames are 24 fps, window lengths should be `5 + 17n`, windows may overlap (39-frame seam).
`images`/`audios` are 0-based indices into `image1..image9` / `audio1..audio3`; `videos` are
timeline clips indexed into `video1..video3` and are sliced per segment by their time window.
`get_app` returns the full notes for the app.

`GET /health` answers `{"ok":true,...}` while the app is reachable.

## Environment

| Variable | Default | |
|---|---|---|
| `RIVERFIELD_URL` | `http://127.0.0.1:3000` | where the app listens |
| `RIVERFIELD_MCP_PORT` | `3010` | HTTP port |
| `RIVERFIELD_MCP_HOST` | `127.0.0.1` | HTTP bind address |
| `RIVERFIELD_OUT` | `<repo>/out` | where history lives (for absolute paths) |
