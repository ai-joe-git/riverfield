import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {ToolDefinition} from "./agent-providers.ts";
export interface McpConnection {tools():Promise<ToolDefinition[]>;call(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<any>;close():Promise<void>;}
export class StudioMcp implements McpConnection {
  private client=new Client({name:"riverfield-agent",version:"1.0.0"});
  private ready:Promise<void>;
  constructor(url:string){const u=new URL(url);if(!["127.0.0.1","localhost","[::1]"].includes(u.hostname))throw new Error("Riverfield Agent connects only to the configured local studio MCP server");this.ready=this.client.connect(new StreamableHTTPClientTransport(u));}
  async tools(){await this.ready;const tools:ToolDefinition[]=[];let cursor:string|undefined;do{const page=await this.client.listTools({cursor});tools.push(...page.tools as ToolDefinition[]);cursor=page.nextCursor;}while(cursor);return tools;}
  async call(name:string,args:Record<string,unknown>,signal?:AbortSignal){await this.ready;return this.client.callTool({name,arguments:args},undefined,{signal,timeout:65*60*1000});}
  async close(){await this.ready.catch(()=>{});await this.client.close();}
}
export function resultData(result:any):any{if(result?.structuredContent)return result.structuredContent;const texts=(result?.content||[]).filter((b:any)=>b.type==="text").map((b:any)=>b.text).join("\n");try{return JSON.parse(texts);}catch{return texts||result;}}

/** Stable deterministic failures exclude generated wording and input values. */
export function validationFailure(result:any):{signature:string;message:string}|undefined{
 if(!result?.isError)return;
 const data=resultData(result);
 if(data?.status===400){const issues=Array.isArray(data.issues)?data.issues:[];return {signature:JSON.stringify([data.code||"HTTP_400",[...new Set(issues.map((i:any)=>`${i.code}:${i.field}`))].sort()]),message:String(data.error||"Invalid inputs")};}
 if(typeof data==="string"){const legacy=/^(?:Error:\s*)?400\s+([\s\S]+)$/.exec(data);if(legacy)return {signature:legacy[1],message:legacy[1]};}
}
