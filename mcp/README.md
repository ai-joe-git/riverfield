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
| `list_apps` | every app with section, status and pack (`section: audio` to filter) |
| `get_app` | one manifest: inputs, types, defaults, options, presets, outputs, models, notes, example |
| `run_app` | start a run: `values` by input id, `files` by absolute path, optional `preset` → returns the history id |
| `job` | one run: status, progress, queue position, outputs so far (absolute paths) |
| `wait_job` | poll until it finishes (10 min by default) and return the output files |
| `cancel_job` | ask the backend to stop a run |
| `history` | the studio's history: what ran, with what values, where the files are |
| `gpu` | backend warm? which app is loaded, VRAM in use |
| `examples` | the lab example of an app: the exact values and inputs that made it |

Outputs come back as absolute paths (`out/history/<id>/out-01.png`), so an agent can open them
directly.

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

`GET /health` answers `{"ok":true,...}` while the app is reachable.

## Environment

| Variable | Default | |
|---|---|---|
| `RIVERFIELD_URL` | `http://127.0.0.1:3000` | where the app listens |
| `RIVERFIELD_MCP_PORT` | `3010` | HTTP port |
| `RIVERFIELD_MCP_HOST` | `127.0.0.1` | HTTP bind address |
| `RIVERFIELD_OUT` | `<repo>/out` | where history lives (for absolute paths) |
