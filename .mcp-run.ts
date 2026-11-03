import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [mode, idArg, minutesArg] = process.argv.slice(2);
const client = new Client({ name: "riverfield-run", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3010/mcp")));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return t; }
};
if (mode === "submit") {
  const payload = JSON.parse(readFileSync("/tmp/opencode/director/payload.json", "utf8"));
  console.log(JSON.stringify(await call("run_app", { app: "studio-director", values: payload.values, files: payload.files })));
} else if (mode === "poll") {
  const deadline = Date.now() + Number(minutesArg || 90) * 60_000;
  while (Date.now() < deadline) {
    const j: any = await call("job", { id: idArg });
    console.log(`${new Date().toISOString().slice(11, 19)} ${j.status} ${j.progress ? Math.round((j.progress.value ?? j.progress) * 100) + "%" : ""}`);
    if (["succeeded", "failed", "canceled", "expired", "lost"].includes(j.status)) {
      console.log(JSON.stringify({ status: j.status, error: j.error, outputs: j.outputs }, null, 1));
      process.exit(j.status === "succeeded" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  process.exit(2);
}
await client.close();
