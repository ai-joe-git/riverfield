import {el,toast} from "./util.js";
import {modal,button,safe,field,select} from "./agent-controls.js";

export async function runtimeSettings({api,onSaved}){
 const d=modal("Local runtime · llama.cpp Vulkan","Riverfield owns this runtime only. External local and remote API connections remain available.");d.classList.add("ag-native-runtime");
 let data=await api("/runtime"),edited=null,tab="Model",help="",binaries=[],helpOptions=[],helpQuery="",expertError="",extraDraft=null,working=false;
 const head=el("div",{class:"ag-runtime-status",role:"status"}),form=el("div",{class:"ag-dialog-form"}),profiles=el("div"),tabs=el("div",{class:"ag-runtime-tabs"}),pane=el("div",{class:"ag-runtime-pane"}),actions=el("div",{class:"ag-dialog-actions"});
 const fresh=()=>({name:"My GGUF",executable:binaries[0]||"",modelPath:"",options:{...data.defaults},extraArgs:[]});
 const editProfile=p=>({...structuredClone(p),options:{...data.defaults,...p.options}});
 const status=()=>{const s=data.status;head.replaceChildren(el("b",{},s.phase.toUpperCase()),el("span",{},s.model||"No managed model loaded"),s.pid?el("small",{},`PID ${s.pid} · Riverfield-owned`):null,s.error?el("p",{class:"ag-error"},s.error):null);};
 const refresh=async()=>{data=await api("/runtime");status();drawProfiles();};
 const lockControls=()=>{for(const node of [...profiles.querySelectorAll("select"),...form.querySelectorAll("input,select,textarea"),...pane.querySelectorAll("input,select,textarea")])node.disabled=true;for(const node of actions.querySelectorAll("button"))if(node.textContent!=="Unload")node.disabled=true;};
 const action=(label,fn,cls="btn ghost")=>button(label,safe(async()=>{if(working)return;working=true;lockControls();try{await fn();}finally{working=false;draw();}}),cls,{disabled:working});
 const drawProfiles=()=>profiles.replaceChildren(select("GGUF profile",edited?.id||"",[["","New model profile"],...data.profiles.map(p=>[p.id,p.name])],id=>{edited=id?editProfile(data.profiles.find(p=>p.id===id)):fresh();help="";helpOptions=[];extraDraft=null;expertError="";draw();}));
 const drawPane=()=>{pane.replaceChildren();
  if(tab==="Logs"){pane.append(button("Refresh runtime status",safe(async()=>{await refresh();drawPane();})),el("h3",{},"Effective owned child argv"),el("pre",{class:"ag-runtime-log"},JSON.stringify(data.status.effectiveArgs||[],null,2)),el("pre",{class:"ag-runtime-log"},data.status.logs.join("\n")||"No native process logs yet."));return;}
  if(tab==="Expert"){
   const error=el("p",{role:"status"},expertError),rows=el("div",{class:"ag-native-help-options"});
   const renderRows=()=>{rows.replaceChildren(...helpOptions.filter(o=>`${o.signature} ${o.description}`.toLowerCase().includes(helpQuery.toLowerCase())).map(o=>{
    const index=edited.extraArgs.findIndex(a=>a===o.flag||a.startsWith(o.flag+"=")),enabled=index>=0;let value=enabled?(edited.extraArgs[index].includes("=")?edited.extraArgs[index].slice(o.flag.length+1):edited.extraArgs[index+1]||""):"";
    const set=(checked,v)=>{const at=edited.extraArgs.findIndex(a=>a===o.flag||a.startsWith(o.flag+"="));if(at>=0){const count=o.takesValue&&!edited.extraArgs[at].includes("=")&&edited.extraArgs[at+1]&&!/^--?[a-z]/i.test(edited.extraArgs[at+1])?2:1;edited.extraArgs.splice(at,count);}if(checked)edited.extraArgs.push(...(o.takesValue?[`${o.flag}=${v}`]:[o.flag]));extraDraft=null;expertError="";drawPane();};
    return el("label",{class:"ag-native-help-option"},el("input",{type:"checkbox",checked:enabled,disabled:o.managed,onchange:e=>set(e.target.checked,value)}),el("span",{},el("b",{},o.signature),el("small",{},o.description)),o.managed?el("small",{},"Dedicated field / managed"):o.takesValue?el("input",{value,placeholder:"Value",disabled:!enabled,"aria-label":o.flag,onchange:e=>set(true,e.target.value)}):null);
   }));};renderRows();
   pane.append(el("p",{},"All options are read from this executable's --help. Host, port, model, credentials and dedicated fields cannot be overridden. Expert argv is JSON, never a shell command."),field("Expert argv (JSON array)",extraDraft??JSON.stringify(edited.extraArgs),v=>{extraDraft=v;try{const parsed=JSON.parse(v);if(!Array.isArray(parsed)||parsed.some(x=>typeof x!=="string"))throw new Error("Expected an array of strings");edited.extraArgs=parsed;expertError="";error.textContent="";renderRows();}catch(e){expertError=e.message;error.textContent=e.message;}},"textarea"),error,button("Read executable help",safe(async()=>{const result=await api("/runtime/help","POST",{executable:edited.executable});help=result.help;helpOptions=result.options;drawPane();})),field("Search all executable options",helpQuery,q=>{helpQuery=q;renderRows();}),rows,el("details",{},el("summary",{},"Raw executable help"),el("pre",{class:"ag-runtime-log"},help||"Read help to see every supported option.")));return;
  }
  const grid=el("div",{class:"ag-runtime-grid"});for(const o of data.fields.filter(o=>o.group===tab)){
   const value=edited.options[o.key],unsupported=help&&!o.flags.some(flag=>help.includes(flag))&&!(o.off&&help.includes(o.off));let input;
   if(o.type==="boolean")input=el("input",{type:"checkbox",checked:!!value,onchange:e=>edited.options[o.key]=e.target.checked});
   else if(o.choices)input=el("select",{onchange:e=>{if(e.target.value==="")delete edited.options[o.key];else edited.options[o.key]=e.target.value;}},el("option",{value:"",selected:value===undefined},o.default===undefined?"Build default":`Riverfield default (${o.default})`),...o.choices.map(v=>el("option",{value:v,selected:value===v},v)));
   else input=el("input",{type:o.type==="number"?"number":"text",value:value??"",min:o.min,max:o.max,step:"any",placeholder:o.default===undefined?"Build default":`Default: ${o.default}`,oninput:e=>{if(e.target.value==="")delete edited.options[o.key];else edited.options[o.key]=o.type==="number"?Number(e.target.value):e.target.value;}});
   input.setAttribute("aria-label",o.label);grid.append(el("label",{class:`ag-field${unsupported?" ag-option-unsupported":""}`},el("span",{},o.label),input,el("small",{},`${o.flags[0]}${unsupported?" · not advertised by selected build":""}`)));
  }pane.append(grid);
  if(tab==="Model")pane.prepend(el("p",{class:"ag-privacy-note"},"Context allocates KV memory at load time. Default: 32K, one slot, no speculative decoding. An API output limit does not reduce allocated KV memory."));
  if(tab==="Vision"||tab==="MTP / Draft")pane.prepend(el("p",{class:"ag-privacy-note"},"Auxiliary GGUFs are explicit and saved only in this model's profile. No automatic projector or draft inheritance from another model."));
  if(tab==="Sampling")pane.append(el("p",{class:"ag-privacy-note"},"These sampling settings are also sent with managed agent requests. Set output budget and tool protocol in Models & connections."));
 };
 const draw=()=>{
  drawProfiles();
  const chooseFile=f=>{if(edited.modelPath&&edited.modelPath!==f.path){const executable=edited.executable;edited=fresh();edited.executable=executable;extraDraft=null;expertError="";}edited.modelPath=f.path;edited.name=f.name.replace(/\.gguf$/i,"").slice(0,100);draw();};
  form.replaceChildren(
   field("Profile name",edited.name,v=>edited.name=v),
   field("llama-server executable (absolute path)",edited.executable,v=>{edited.executable=v;help="";helpOptions=[];}),
   binaries.length?select("Detected binaries","",[["","Choose a binary…"],...binaries.map(p=>[p,p])],p=>{if(p){edited.executable=p;help="";helpOptions=[];draw();}}):null,
   field("Main GGUF (absolute path)",edited.modelPath,v=>edited.modelPath=v),
   button("Inspect GGUF header & metadata",safe(async()=>{const info=await api("/runtime/inspect","POST",{path:edited.modelPath});const inspector=modal(info.name,"Header/metadata preflight only. Full tensor compatibility is checked by llama.cpp when loading.");inspector.append(el("pre",{class:"ag-runtime-log"},JSON.stringify(info,null,2)));inspector.showModal();})),
   button("Browse GGUF directory",()=>{
    let directory=edited.modelPath?edited.modelPath.slice(0,edited.modelPath.lastIndexOf("/")):"";
    const chooser=modal("Local GGUF library","Read-only scan, up to three subdirectory levels. No model downloads or copies."),results=el("div",{class:"ag-model-results"});
    chooser.append(field("Model directory",directory,v=>directory=v),button("Scan",safe(async()=>{const {files}=await api("/runtime/scan","POST",{directory});results.replaceChildren(...files.map(f=>button(el("span",{},el("b",{},f.name),el("small",{},`${(f.bytes/2**30).toFixed(2)} GiB · ${f.path}`)),()=>{chooseFile(f);chooser.close();},"ag-model-option")));if(!files.length)results.append(el("p",{},"No valid GGUF files found."));})),results);chooser.showModal();
   }),
   el("p",{class:"ag-privacy-note"},"Use an existing Vulkan llama-server binary, including a BlackRiver installation. Riverfield does not take control of BlackRiver's running server or modify its files. Choose New model profile when manually entering a different GGUF.")
  );
  tabs.replaceChildren(...[...new Set(data.fields.map(o=>o.group)),"Expert","Logs"].map(t=>button(t,()=>{tab=t;draw();},`ag-filter${tab===t?" active":""}`,{"aria-pressed":String(tab===t)})));drawPane();
   const save=async()=>{if(expertError)throw new Error("Fix expert argv JSON before saving");edited=await api("/runtime/profiles","POST",edited);await refresh();draw();toast("GGUF profile saved");return edited;};
  actions.replaceChildren(action("Save profile",save,"btn lime"),action("Load / reload",async()=>{const p=await save();head.textContent="Queued / loading model… This can take several minutes.";try{await api("/runtime/load","POST",{profile:p.id});}finally{await refresh();}}),button("Unload",safe(async()=>{head.textContent="Waiting for current GPU work, then unloading…";try{await api("/runtime/unload","POST",{});}finally{await refresh();}})),action("Use for agent",async()=>{const p=await save();const providers=(await api("/providers")).providers,old=providers.find(v=>v.runtimeProfile===p.id);await api("/providers","POST",{...(old||{}),name:p.name,location:"local",kind:"openai",baseURL:"http://127.0.0.1:1/v1",model:`riverfield-${p.id}`,runtimeProfile:p.id,contextTokens:Number(p.options.contextSize||32768),temperature:Number(p.options.temperature??.7),toolMode:old?.toolMode||"native",vision:!!p.options.mmprojPath});await onSaved();toast("Managed connection available in Choose model");}),edited.id?action("Delete profile",async()=>{if(!confirm("Delete this profile? GGUF files are kept."))return;await api(`/runtime/profiles/${edited.id}`,"DELETE");edited=fresh();await refresh();draw();},"ag-text-danger"):null);
  if(working)lockControls();
 };
 d.append(head,profiles,form,tabs,pane,actions,el("p",{class:"ag-privacy-note"},"Automatic handoff: agent unloaded before media generation; ComfyUI release confirmed before agent reload. Only Riverfield-owned processes are stopped. Controls wait for the shared GPU queue."));d.showModal();
 try{binaries=(await api("/runtime/binaries")).binaries;}catch(e){toast(e.message,{error:true});}edited=data.profiles.length?editProfile(data.profiles[0]):fresh();status();draw();
}
