import {el,icon,toast} from "./util.js";
import {button,safe,field,select,modal,tokens,errorText,providerSettings,modelPicker} from "./agent-controls.js";

async function api(path="",method="GET",body){const r=await fetch(`/api/agent${path}`,{method,headers:body instanceof FormData?{}:{"content-type":"application/json"},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data;}
/** DOM-only Markdown: raw HTML and remote image embeds are never interpreted. */
export function markdown(text){
 const root=el("div",{class:"ag-markdown"});
 const inline=line=>{const out=el("span",{}),re=/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g;let last=0,m;
  while((m=re.exec(line))){out.append(document.createTextNode(line.slice(last,m.index)));const t=m[0];
   if(t.startsWith("`"))out.append(el("code",{},t.slice(1,-1)));else if(t.startsWith("**"))out.append(el("strong",{},t.slice(2,-2)));else if(t.startsWith("*"))out.append(el("em",{},t.slice(1,-1)));
   else{const a=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);out.append(a&&/^(https?:\/\/|\/api\/|#\/)/i.test(a[2])?el("a",{href:a[2],target:a[2].startsWith("#")?null:"_blank",rel:"noopener noreferrer"},a[1]):document.createTextNode(t));}last=re.lastIndex;
  }out.append(document.createTextNode(line.slice(last)));return out;};
 text.split(/```/).forEach((block,i)=>{if(i%2){const split=block.indexOf("\n"),lang=split<0?"":block.slice(0,split),code=split<0?block:block.slice(split+1);root.append(el("div",{class:"ag-code"},el("header",{},el("small",{},lang||"Code"),button("Copy",safe(()=>navigator.clipboard.writeText(code)),"ag-text-button")),el("pre",{},el("code",{},code))));}
  else for(const line of block.split("\n")){if(!line.trim()){root.append(el("div",{class:"ag-gap"}));continue;}const h=/^(#{1,4})\s+(.+)$/.exec(line),list=/^\s*(?:[-*]|\d+\.)\s/.test(line);root.append(h?el(`h${Math.min(5,h[1].length+1)}`,{},inline(h[2])):el("p",{class:list?"ag-list":null},inline(line.replace(/^\s*[-*]\s/,"• "))));}});return root;
}
const starters=[
 ["image","Build a character","Help me design a consistent character reference sheet. Discover suitable image apps first and ask me about the character before generating."],
 ["film","Direct a scene","Help me plan a cinematic scene. Explore the available video workflows and their reference requirements before running anything."],
 ["layers","Find the right tool","Show me the image, video and audio tools available in my studio and help me choose what to use."],
];
export function agentView({home=false}={}){
 let conversations=[],providers=[],tools=[],c=null,stream=null,disposed=false,draft="",pending=[],sending=false,selectedProvider="",selectedModel="",limits=null,limitKey="",sideOpen=!home,opening=0;
 const root=el("div",{class:"ag-workspace"}),sidebar=el("aside",{class:"ag-sidebar","aria-label":"Conversations"}),header=el("header",{class:"ag-header"}),chat=el("section",{class:"ag-chat","aria-label":"Conversation"}),footer=el("footer",{class:"ag-footer"});
 root.append(sidebar,el("div",{class:"ag-main"},header,chat,footer));
 const busy=()=>c?.status==="running",currentProvider=()=>c?.provider||selectedProvider,currentModel=()=>c?.model||selectedModel;
 const ico=(name,label,fn)=>button(icon(name),fn,"ag-round",{"aria-label":label,title:label});
 const remember=()=>{try{localStorage.setItem("riverfield.agent.provider",currentProvider());if(c)localStorage.setItem("riverfield.agent.conversation",c.id);}catch{}};
 async function loadLimits(){const id=currentProvider(),model=currentModel(),key=`${id}:${model}`;limitKey=key;limits=null;if(!id||!model)return;
  try{const data=await api(`/providers/${id}/limits?model=${encodeURIComponent(model)}`);if(!disposed&&limitKey===key){limits=data;drawHeader();drawFooter();}}catch{if(!disposed&&limitKey===key){limits={source:"Limits unavailable"};drawHeader();}}
 }
 async function reloadProviders(){providers=(await api("/providers")).providers;if(!providers.some(p=>p.id===selectedProvider)){selectedProvider=providers[0]?.id||"";selectedModel=providers[0]?.model||"";}await loadLimits();draw();}
 const settings=()=>providerSettings({api,providers,selected:currentProvider(),onSaved:reloadProviders});
 const picker=()=>modelPicker({api,providers,provider:currentProvider(),model:currentModel(),onManage:settings,onSelect:async(provider,model)=>{selectedProvider=provider;selectedModel=model;if(c)c=await api(`/conversations/${c.id}`,"PATCH",{provider,model});remember();await loadLimits();draw();}});
 async function loadList(){conversations=(await api("/conversations")).conversations;drawSidebar();}
 function classes(){root.className=`ag-workspace${home?" is-home":""}${!c?.messages.length?" is-empty":""}${sideOpen?"":" side-closed"}`;}
 async function open(id){const request=++opening;stream?.close();const data=await api(`/conversations/${id}`);if(disposed||request!==opening)return;c=data;pending=[];draft="";limits=null;remember();draw();connectEvents(id);void loadLimits();}
 async function create(){const request=++opening;stream?.close();const provider=currentProvider()||providers[0]?.id||"",model=currentModel()||providers.find(p=>p.id===provider)?.model||"";const data=await api("/conversations","POST",{provider,model});if(disposed||request!==opening)return;c=data;pending=[];draft="";remember();await loadList();if(disposed||request!==opening)return;draw();connectEvents(c.id);void loadLimits();}
 async function ensure(){if(c)return;const text=draft;await create();draft=text;}
 function connectEvents(id){stream?.close();stream=new EventSource(`/conversations/${id}/events`.replace(/^\//,"/api/agent/"));
  stream.addEventListener("state",e=>{if(disposed||c?.id!==id)return;c=JSON.parse(e.data);classes();drawHeader();drawChat();drawFooter();void loadList();});
  stream.addEventListener("delta",e=>{if(disposed||c?.id!==id)return;const d=JSON.parse(e.data);let m=c.messages.find(m=>m.id===d.id);if(!m){m={id:d.id,role:"assistant",content:"",created:new Date().toISOString()};c.messages.push(m);}m.content+=d.text;classes();drawChat();});
  stream.addEventListener("jobs",e=>{if(c?.id!==id)return;Object.assign(c,JSON.parse(e.data));drawChat();});
  stream.addEventListener("queue",e=>{if(c?.id!==id)return;const d=JSON.parse(e.data);header.dataset.queue=d.position==null?"":`Waiting in studio queue · ${d.position}`;});
 }
 async function patch(body){c=await api(`/conversations/${c.id}`,"PATCH",body);draw();}
 function conversationMenu(item){const d=modal("Conversation",item.title);d.append(button("Open conversation",safe(async()=>{await open(item.id);d.close();}),"ag-menu-item"),button("Rename",()=>{d.close();const rename=modal("Rename conversation");let title=item.title;rename.append(field("Title",title,v=>title=v),button("Save",safe(async()=>{await api(`/conversations/${item.id}`,"PATCH",{title});if(c?.id===item.id){c.title=title;drawHeader();}await loadList();rename.close();}),"btn lime"));rename.showModal();},"ag-menu-item"),button("Delete conversation",safe(async()=>{if(!confirm("Delete this conversation? Studio History outputs will be kept."))return;await api(`/conversations/${item.id}`,"DELETE");if(c?.id===item.id){stream?.close();c=null;pending=[];draft="";}await loadList();draw();d.close();}),"ag-menu-item ag-text-danger"));d.showModal();}
 function drawSidebar(){sidebar.replaceChildren(el("div",{class:"ag-side-brand"},el("a",{href:"#/",class:"ag-side-wordmark"},"riverfield",el("span",{},"agent")),ico("menu","Close conversations",()=>{sideOpen=false;classes();drawHeader();})),button(el("span",{},icon("plus")," New conversation"),safe(create),"ag-new-chat"),el("div",{class:"ag-side-label"},"Your conversations"),
  el("div",{class:"ag-history-list"},...conversations.map(x=>el("div",{class:`ag-conversation${x.id===c?.id?" selected":""}`},button(el("span",{},x.title,el("small",{},["running","approval"].includes(x.status)?x.status:"")),safe(()=>open(x.id)),"ag-conversation-title"),button("⋯",()=>conversationMenu(x),"ag-row-menu",{"aria-label":`Conversation actions: ${x.title}`})))),
  el("div",{class:"ag-side-bottom"},button(el("span",{},icon("sliders")," Models & connections"),settings,"ag-side-setting"),el("a",{href:"#/explore"},icon("grid")," Explore the studio")));
 }
 function drawHeader(){const p=providers.find(p=>p.id===currentProvider()),mode=c?.mode||"ask",native=p?.tokenMode!=="custom";
  const budget=limits?.outputTokens&&native?`${tokens(limits.outputTokens)} max`:!native&&p?`${tokens(p.maxTokens)} custom`:limits?.source==="configured fallback"?`${tokens(limits.configuredMaxTokens)} fallback`:limits?"Server-native budget":"Native budget";
  const modelLabel=currentModel()||"Choose a model";
  header.replaceChildren(el("div",{class:"ag-header-left"},!sideOpen?ico("menu","Show conversations",()=>{sideOpen=true;classes();drawHeader();}):null,el("div",{class:"ag-heading"},el("h1",{},"Agent"),el("span",{},c?.title||"Your creative workspace"))),
   el("div",{class:"ag-header-actions"},button(el("span",{class:"ag-model-label"},el("i",{class:`ag-connection-dot ${p?.location||""}`}),el("span",{},modelLabel),el("small",{},budget),icon("chevD")),picker,"ag-model-chip",{"aria-label":"Choose model",title:`${p?.name||"Configure a connection"} · ${limits?.source||"Native maximum"}` ,disabled:busy()}),
    c?select("Autonomy",mode,[["ask","Ask before running"],["auto","Auto"],["read-only","Read-only"]],safe(v=>patch({mode:v}))):el("span",{class:"ag-mode-label"},"Ask before running"),
    c?ico("sliders","Conversation settings",safe(conversationSettings)):ico("sliders","Provider settings",settings),ico("plus","New conversation",safe(create))));
  if(busy())header.querySelectorAll("select").forEach(e=>e.disabled=true);
 }
 function conversationSettings(){const d=modal("Conversation controls","Keep the agent focused. You control tools and autonomy.");let instructions=c.instructions,maxSteps=c.maxSteps;const enabled=new Set(c.enabledTools.length?c.enabledTools:tools.map(t=>t.name));
  d.append(field("Additional instructions",instructions,v=>instructions=v,"textarea"),field("Maximum agent steps per turn",maxSteps,v=>maxSteps=v,"number"),el("div",{class:"ag-tool-toggles"},...tools.map(t=>el("label",{class:"ag-tool-toggle"},el("input",{type:"checkbox",checked:enabled.has(t.name),onchange:e=>e.target.checked?enabled.add(t.name):enabled.delete(t.name)}),el("span",{},t.name)))),el("p",{class:"ag-privacy-note"},"The selected model and tool permissions still apply. Local engines are independently managed; Riverfield will not kill or unload them. Other clients can bypass the studio queue."),button("Save controls",safe(async()=>{if(!enabled.size)throw new Error("Enable at least one tool or use read-only mode");await patch({instructions,maxSteps,enabledTools:[...enabled]});d.close();}),"btn lime"));d.showModal();}
 function artifact(a){const preview=a.type==="image"||a.mime?.startsWith("image/")?el("img",{src:a.url,alt:a.name,loading:"lazy"}):a.type==="video"||a.mime?.startsWith("video/")?el("video",{src:a.url,controls:true,preload:"metadata",playsinline:true}):a.type==="audio"||a.mime?.startsWith("audio/")?el("audio",{src:a.url,controls:true,preload:"metadata"}):el("code",{},a.name);
  const info=el("small",{},[a.name,a.app,a.seconds!=null?`${a.seconds}s`:null].filter(Boolean).join(" · "));
  const dimensions=()=>{const w=preview.naturalWidth||preview.videoWidth,h=preview.naturalHeight||preview.videoHeight,t=preview.duration;info.textContent=[a.name,a.app,w&&h?`${w} × ${h}`:null,Number.isFinite(t)?`${t.toFixed(1)}s`:null,a.seconds!=null?`${a.seconds}s generation`:null].filter(Boolean).join(" · ");};preview.onload=dimensions;preview.onloadedmetadata=dimensions;
  return el("article",{class:"ag-media"},preview,info,el("div",{class:"ag-actions"},el("a",{href:a.url,download:a.name,class:"ag-text-button"},"Download"),a.job?el("a",{href:a.app?`#/app/${a.app}/history`:"#/library",class:"ag-text-button"},"History"):null,button("Use in chat",safe(async()=>{const item=await api(`/conversations/${c.id}/reuse`,"POST",{artifact:a.id});if(!pending.includes(item.id))pending.push(item.id);if(!c.attachments.some(x=>x.id===item.id))c.attachments.push(item);drawFooter();}),"ag-text-button",{disabled:busy()})));
 }
 function welcome(){return el("div",{class:"ag-welcome"},el("div",{class:"ag-welcome-orb"},icon("spark")),el("span",{class:"ag-eyebrow"},"YOUR IDEAS. YOUR MODELS. YOUR STUDIO."),el("h2",{},"What will you create",el("br"),el("em",{},"next?")),el("p",{},"Start with an idea. Your agent finds the tools, prepares the work, and brings it to life."),el("div",{class:"ag-starters"},...starters.map(([name,label,text])=>button(el("span",{},icon(name),label),()=>{draft=text;drawFooter();footer.querySelector("textarea")?.focus();},"ag-starter"))),el("a",{href:"#/explore",class:"ag-explore-link"},"Or explore the studio ",icon("chevR")));}
 function drawChat(){const scroll=chat.scrollTop,atBottom=chat.scrollHeight-scroll-chat.clientHeight<140,openTools=new Set([...chat.querySelectorAll("details[open][data-call]")].map(n=>n.dataset.call));chat.replaceChildren();
  if(!c?.messages.length){chat.append(welcome());return;}
  for(const m of c.messages){if(m.role==="tool"||m.role==="assistant"&&!m.content?.trim()&&!m.calls?.length)continue;
   const bubble=el("article",{class:`ag-message ${m.role}`},el("div",{class:"ag-message-author"},m.role==="user"?"You":icon("spark"),m.role==="assistant"?"Riverfield":""),m.content?markdown(m.content):null);
   for(const id of m.attachments||[]){const a=c.attachments.find(a=>a.id===id);if(a)bubble.append(el("a",{href:a.url,target:"_blank",rel:"noopener",class:"ag-inline-attachment"},a.mime.startsWith("image/")?el("img",{src:a.url,alt:a.name}):icon("layers"),a.name));}
   for(const call of m.calls||[]){const record=c.tools.find(t=>t.id===call.id),details=el("details",{class:`ag-tool ${record?.status||"pending"}`,"data-call":call.id,open:openTools.has(call.id)||(c.status==="approval"&&record?.status==="proposed")},el("summary",{},el("span",{class:"ag-tool-dot"}),call.name,el("small",{},record?.status||"pending")),el("div",{class:"ag-tool-body"},el("small",{},"Arguments"),el("pre",{},JSON.stringify(call.arguments,null,2)),record?.result?el("details",{},el("summary",{},"Actual MCP result"),el("pre",{},JSON.stringify(record.result,null,2))):null,record?.error?el("p",{class:"ag-error"},record.error):null));
    if(c.status==="approval"&&record?.status==="proposed")details.append(el("div",{class:"ag-actions"},button("Approve execution",safe(()=>api(`/conversations/${c.id}/approve`,"POST",{tool:call.id,allow:true})),"btn lime"),button("Decline",safe(()=>api(`/conversations/${c.id}/approve`,"POST",{tool:call.id,allow:false})),"ag-text-button")));bubble.append(details);
   }chat.append(bubble);
  }
  if(busy())chat.append(el("div",{class:"ag-thinking"},el("i",{}),"Working with your studio…"));
  if(c.error)chat.append(el("div",{class:"ag-error",role:"alert"},icon("info"),el("span",{},errorText(c.error))));
  if(c.jobs.length||c.tools.some(t=>t.status==="uncertain"))chat.append(el("section",{class:"ag-jobs"},el("header",{},el("b",{},"Studio activity"),button("Refresh",safe(async()=>{c=await api(`/conversations/${c.id}/jobs`,"POST",{});drawChat();}),"ag-text-button")),...c.jobs.map(id=>{const j=c.jobStates[id]||{};return el("div",{},el("span",{},j.app||"Studio job"),el("small",{},j.status||"unknown"),j.progress?.value!=null?el("progress",{max:1,value:j.progress.value}):null,el("a",{href:"#/library",title:id},id.slice(-8)),j.error?el("span",{class:"ag-error"},j.error.message||String(j.error)):null);})));
  if(c.artifacts.length)chat.append(el("section",{class:"ag-gallery"},...c.artifacts.map(artifact)));
  if(["failed","interrupted","canceled"].includes(c.status))chat.append(button(el("span",{},icon("redo")," Continue safely"),safe(()=>api(`/conversations/${c.id}/continue`,"POST",{})),"ag-retry",{title:"Continue without repeating completed tools"}));
  chat.scrollTop=atBottom?chat.scrollHeight:scroll;
 }
 const submit=safe(async()=>{if(sending||busy()||c?.status==="approval")return;if(!draft.trim()&&!pending.length)return;if(!currentProvider()){settings();return;}sending=true;
  try{await ensure();await api(`/conversations/${c.id}`,"PATCH",{model:c.model});await api(`/conversations/${c.id}/messages`,"POST",{text:draft,attachments:pending});draft="";pending=[];c=await api(`/conversations/${c.id}`);draw();}finally{sending=false;drawFooter();}
 });
 function drawFooter(){const p=providers.find(p=>p.id===currentProvider()),old=footer.querySelector("textarea"),focused=old===document.activeElement,start=old?.selectionStart;footer.replaceChildren();
  const composer=el("textarea",{"aria-label":"Message Riverfield Agent",placeholder:"Describe your next idea…",rows:2,value:draft,disabled:busy()||sending||c?.status==="approval"});
  composer.oninput=()=>{draft=composer.value;composer.style.height="auto";composer.style.height=Math.min(220,composer.scrollHeight)+"px";};composer.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();void submit();}};
  const upload=el("input",{type:"file",hidden:true,multiple:true,accept:"image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/*,.txt",onchange:safe(async()=>{await ensure();for(const file of upload.files){const fd=new FormData();fd.set("file",file);const item=await api(`/conversations/${c.id}/upload`,"POST",fd);c.attachments.push(item);pending.push(item.id);}drawFooter();})});
  const fileChips=el("div",{class:"ag-attachments"},...pending.map(id=>{const a=c?.attachments.find(a=>a.id===id);return button(`${a?.name||id} ×`,()=>{pending=pending.filter(x=>x!==id);drawFooter();},"ag-file-chip");}));
  footer.append(el("div",{class:"ag-composer"},upload,fileChips,composer,el("div",{class:"ag-compose-actions"},ico("plus","Attach files",()=>upload.click()),el("span",{class:`ag-composer-meta ${p?.location||""}`},el("i",{class:"ag-connection-dot"}),p?.location==="remote"?"Remote provider":p?"Local connection":"Choose a model to begin",limits?.outputTokens?` · ${tokens(limits.outputTokens)} ${p?.tokenMode==="custom"?"native cap":"max"}`:""),busy()?button(icon("stop"),safe(()=>api(`/conversations/${c.id}/stop`,"POST",{})),"ag-send is-stop",{"aria-label":"Stop agent and related jobs",title:"Stop agent and related jobs"}):button("↑",submit,"ag-send",{"aria-label":"Send message",disabled:sending||c?.status==="approval"}))),
   el("small",{class:"ag-composer-note"},p?.location==="remote"?"Remote · messages, enabled images and tool results leave this machine.":"Your studio stays in your hands. Review expensive tool calls before running."));
  footer.querySelector('button[aria-label="Attach files"]').disabled=busy()||sending;
  if(focused&&!composer.disabled){composer.focus();composer.setSelectionRange(start??draft.length,start??draft.length);}
 }
 function draw(){if(disposed)return;classes();drawSidebar();drawHeader();drawChat();drawFooter();}
 safe(async()=>{providers=(await api("/providers")).providers;try{selectedProvider=localStorage.getItem("riverfield.agent.provider")||"";}catch{}if(!providers.some(p=>p.id===selectedProvider))selectedProvider=providers[0]?.id||"";selectedModel=providers.find(p=>p.id===selectedProvider)?.model||"";await loadList();
  if(disposed)return;draw();void loadLimits();try{tools=(await api("/tools")).tools;}catch(e){toast(`MCP: ${e.message}`,{error:true});}if(disposed)return;
  if(!home){let saved;try{saved=localStorage.getItem("riverfield.agent.conversation");}catch{}const id=conversations.find(x=>x.id===saved)?.id||conversations[0]?.id;if(id)await open(id);}
 })();
 return {node:root,active:home?"home":"agent",dispose(){disposed=true;stream?.close();document.querySelectorAll("dialog.ag-settings").forEach(d=>d.close());}};
}
