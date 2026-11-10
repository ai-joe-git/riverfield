import {el,icon,toast} from "./util.js";
import {button,safe,field,select,modal,tokens,errorText,providerSettings,modelPicker} from "./agent-controls.js";
import {createTimeline,mediaIndex} from "./agent-timeline.js";
import {projectSettings} from "./agent-project.js";

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
const kind=a=>a.type||(a.mime||"").split("/")[0]||"file";
const verified=a=>{const m=a.metadata||{},parts=[a.app,a.job?`job ${a.job}`:null,m.width&&m.height?`${m.width} × ${m.height}`:null,Number.isFinite(m.duration)&&m.duration>0?`${m.duration.toFixed(1)}s`:null,m.audio?"audio stream present":null].filter(Boolean);return parts.join(" · ");};

export function agentView({home=false}={}){
 let conversations=[],providers=[],tools=[],c=null,stream=null,disposed=false,draft="",pending=[],sending=false,selectedProvider="",selectedModel="",limits=null,limitKey="",sideOpen=!home&&window.innerWidth>850,opening=0;
 let mediaItems=[],drawerOpen=false,drawerFilter="all",headerSignature="",sidebarSignature="",footerSignature="",mediaBadge=null;
 const root=el("div",{class:"ag-workspace"}),sidebar=el("aside",{class:"ag-sidebar","aria-label":"Conversations"}),header=el("header",{class:"ag-header"}),chat=el("section",{class:"ag-chat","aria-label":"Conversation"}),footer=el("footer",{class:"ag-footer"});
 const jump=button(el("span",{},icon("chevD"),"Jump to latest"),()=>timeline.jumpLatest(),"ag-jump",{"aria-label":"Jump to latest message"});
 jump.hidden=true;
 const drawer=el("aside",{class:"ag-drawer",hidden:true,"aria-label":"Conversation media"});
 const main=el("div",{class:"ag-main"},header,el("div",{class:"ag-chat-wrap"},chat,jump,drawer),footer);
 root.append(sidebar,main);
 const busy=()=>c?.status==="running",currentProvider=()=>c?.provider||selectedProvider,currentModel=()=>c?.model||selectedModel;
 const ico=(name,label,fn)=>button(icon(name),fn,"ag-round",{"aria-label":label,title:label});
 const remember=()=>{try{localStorage.setItem("riverfield.agent.provider",currentProvider());if(c)localStorage.setItem("riverfield.agent.conversation",c.id);}catch{}};
 const timeline=createTimeline({
  chat,markdown,welcome:()=>welcome(),jumpButton:jump,
  card:a=>mediaCard(a),
  approve:(tool,allow)=>safe(async()=>{await api(`/conversations/${c.id}/approve`,"POST",{tool,allow});})(),
  refresh:()=>safe(async()=>{c=await api(`/conversations/${c.id}/jobs`,"POST",{});timeline.update(c);})(),
  resume:()=>safe(async()=>{await api(`/conversations/${c.id}/continue`,"POST",{});})(),
  onIndex:items=>{mediaItems=items;if(mediaBadge)mediaBadge.textContent=items.length||"";if(drawerOpen)drawDrawer();},
 });
 async function loadLimits(){const id=currentProvider(),model=currentModel(),key=`${id}:${model}`;limitKey=key;limits=null;if(!id||!model)return;
  try{const data=await api(`/providers/${id}/limits?model=${encodeURIComponent(model)}`);if(!disposed&&limitKey===key){limits=data;drawHeader();drawFooter();}}catch{if(!disposed&&limitKey===key){limits={source:"Limits unavailable"};drawHeader();}}
 }
 async function reloadProviders(){providers=(await api("/providers")).providers;if(!providers.some(p=>p.id===selectedProvider)){selectedProvider=providers[0]?.id||"";selectedModel=providers[0]?.model||"";}await loadLimits();draw();}
 const settings=()=>providerSettings({api,providers,selected:currentProvider(),onSaved:reloadProviders});
 const picker=()=>modelPicker({api,providers,provider:currentProvider(),model:currentModel(),onManage:settings,onSelect:async(provider,model)=>{selectedProvider=provider;selectedModel=model;if(c)c=await api(`/conversations/${c.id}`,"PATCH",{provider,model});remember();await loadLimits();draw();}});
 async function loadList(){conversations=(await api("/conversations")).conversations;drawSidebar();}
 function classes(){root.className=`ag-workspace${home?" is-home":""}${!c?.messages.length?" is-empty":""}${sideOpen?"":" side-closed"}`;}
 function closeDrawer(){drawerOpen=false;drawer.hidden=true;}
 async function open(id){const request=++opening;stream?.close();closeDrawer();const data=await api(`/conversations/${id}`);if(disposed||request!==opening)return;c=data;pending=[];draft="";limits=null;mediaItems=[];if(window.innerWidth<=850)sideOpen=false;remember();draw();connectEvents(id);void loadLimits();}
 async function create(){const request=++opening;stream?.close();closeDrawer();const provider=currentProvider()||providers[0]?.id||"",model=currentModel()||providers.find(p=>p.id===provider)?.model||"";const data=await api("/conversations","POST",{provider,model});if(disposed||request!==opening)return;c=data;pending=[];draft="";mediaItems=[];if(window.innerWidth<=850)sideOpen=false;remember();await loadList();if(disposed||request!==opening)return;draw();connectEvents(c.id);void loadLimits();}
 async function ensure(){if(c)return;const text=draft;await create();draft=text;}
 function connectEvents(id){stream?.close();stream=new EventSource(`/conversations/${id}/events`.replace(/^\//,"/api/agent/"));
  stream.addEventListener("state",e=>{if(disposed||c?.id!==id)return;c=JSON.parse(e.data);classes();drawHeader();timeline.update(c);drawFooter();void loadList();});
  stream.addEventListener("delta",e=>{if(disposed||c?.id!==id)return;const d=JSON.parse(e.data);let m=c.messages.find(m=>m.id===d.id);if(!m){m={id:d.id,role:"assistant",content:"",created:new Date().toISOString()};c.messages.push(m);}m.content+=d.text;classes();timeline.update(c);});
  stream.addEventListener("jobs",e=>{if(disposed||c?.id!==id)return;Object.assign(c,JSON.parse(e.data));timeline.update(c);});
  stream.addEventListener("queue",e=>{if(disposed||c?.id!==id)return;const d=JSON.parse(e.data);header.dataset.queue=d.position==null?"":`Waiting in studio queue · ${d.position}`;});
 }
 async function patch(body){c=await api(`/conversations/${c.id}`,"PATCH",body);draw();}
 function conversationMenu(item){const d=modal("Conversation",item.title);d.append(button("Open conversation",safe(async()=>{await open(item.id);d.close();}),"ag-menu-item"),button("Rename",()=>{d.close();const rename=modal("Rename conversation");let title=item.title;rename.append(field("Title",title,v=>title=v),button("Save",safe(async()=>{await api(`/conversations/${item.id}`,"PATCH",{title});if(c?.id===item.id){c.title=title;drawHeader();}await loadList();rename.close();}),"btn lime"));rename.showModal();},"ag-menu-item"),button("Delete conversation",safe(async()=>{if(!confirm("Delete this conversation? Studio History outputs will be kept."))return;await api(`/conversations/${item.id}`,"DELETE");if(c?.id===item.id){stream?.close();c=null;pending=[];draft="";mediaItems=[];closeDrawer();}await loadList();draw();d.close();}),"ag-menu-item ag-text-danger"));d.showModal();}
 function drawSidebar(){const list=conversations.map(x=>({id:x.id,title:x.title,status:["running","approval"].includes(x.status)?x.status:""})),signature=JSON.stringify([list,c?.id]);if(signature===sidebarSignature)return;sidebarSignature=signature;
  sidebar.replaceChildren(el("div",{class:"ag-side-brand"},el("a",{href:"#/",class:"ag-side-wordmark"},"riverfield",el("span",{},"agent")),ico("menu","Close conversations",()=>{sideOpen=false;classes();drawHeader();})),button(el("span",{},icon("plus")," New conversation"),safe(create),"ag-new-chat"),el("div",{class:"ag-side-label"},"Your conversations"),
   el("div",{class:"ag-history-list"},...conversations.map(x=>el("div",{class:`ag-conversation${x.id===c?.id?" selected":""}`},button(el("span",{},x.title,el("small",{},["running","approval"].includes(x.status)?x.status:"")),safe(()=>open(x.id)),"ag-conversation-title"),button("⋯",()=>conversationMenu(x),"ag-row-menu",{"aria-label":`Conversation actions: ${x.title}`})))),
   el("div",{class:"ag-side-bottom"},button(el("span",{},icon("sliders")," Models & connections"),settings,"ag-side-setting"),el("a",{href:"#/explore"},icon("grid")," Explore the studio")));
 }
 function headerButton(name,label,action,extra={},badge=false){return button(el("span",{},icon(name),el("span",{class:"ag-tool-label"},label),badge?el("span",{class:"ag-media-badge"}):null),action,"ag-header-button",{"aria-label":label,title:label,...extra});}
 function drawHeader(){const p=providers.find(p=>p.id===currentProvider()),mode=c?.mode||"ask",native=p?.tokenMode!=="custom";
  const budget=limits?.outputTokens&&native?`${tokens(limits.outputTokens)} max`:!native&&p?`${tokens(p.maxTokens)} custom`:limits?.source==="configured fallback"?`${tokens(limits.configuredMaxTokens)} fallback`:limits?"Server-native budget":"Native budget";
  const modelLabel=currentModel()||"Choose a model",signature=JSON.stringify([c?.id,c?.title,c?.status,mode,budget,modelLabel,p?.location,p?.name,limits?.source,sideOpen]);
  if(signature===headerSignature)return;headerSignature=signature;
  header.replaceChildren(el("div",{class:"ag-header-left"},!sideOpen?ico("menu","Show conversations",()=>{sideOpen=true;classes();drawHeader();}):null,el("div",{class:"ag-heading"},el("h1",{},"Agent"),el("span",{},c?.title||"Your creative workspace"))),
   el("div",{class:"ag-header-actions"},button(el("span",{class:"ag-model-label"},el("i",{class:`ag-connection-dot ${p?.location||""}`}),el("span",{},modelLabel),el("small",{},budget),icon("chevD")),picker,"ag-model-chip",{"aria-label":"Choose model",title:`${p?.name||"Configure a connection"} · ${limits?.source||"Native maximum"}` ,disabled:busy()}),
    c?select("Autonomy",mode,[["ask","Ask before running"],["auto","Auto"],["read-only","Read-only"]],safe(v=>patch({mode:v}))):el("span",{class:"ag-mode-label"},"Ask before running"),
    c?headerButton("layers","Media",openMedia,{},true):null,
    c?headerButton("ext","Export",exportMenu):null,
    c?ico("sliders","Conversation settings",safe(conversationSettings)):ico("sliders","Provider settings",settings),
    ico("plus","New conversation",safe(create))));
  mediaBadge=header.querySelector('.ag-header-button[aria-label="Media"] .ag-media-badge');
  if(mediaBadge)mediaBadge.textContent=mediaItems.length||"";
  if(busy())header.querySelectorAll("select").forEach(e=>e.disabled=true);
 }
  function conversationSettings(){const d=modal("Conversation controls","Keep the agent focused. You control tools and autonomy.");let instructions=c.instructions,maxSteps=c.maxSteps,autonomy=c.mode;const enabled=new Set(c.enabledTools.length?c.enabledTools:tools.map(t=>t.name));
   d.append(button("Project & consistency",()=>projectSettings(c,project=>patch({project})),"btn lime"));
  d.append(field("Additional instructions",instructions,v=>instructions=v,"textarea"),select("Autonomy",autonomy,[["ask","Ask before running"],["auto","Auto"],["read-only","Read-only"]],v=>autonomy=v),field("Maximum agent steps per turn",maxSteps,v=>maxSteps=v,"number"),el("div",{class:"ag-tool-toggles"},...tools.map(t=>el("label",{class:"ag-tool-toggle"},el("input",{type:"checkbox",checked:enabled.has(t.name),onchange:e=>e.target.checked?enabled.add(t.name):enabled.delete(t.name)}),el("span",{},t.name)))),el("p",{class:"ag-privacy-note"},"The selected model and tool permissions still apply. Local engines are independently managed; Riverfield will not kill or unload them. Other clients can bypass the studio queue."),button("Save controls",safe(async()=>{if(!enabled.size)throw new Error("Enable at least one tool or use read-only mode");await patch({instructions,maxSteps,mode:autonomy,enabledTools:[...enabled]});d.close();}),"btn lime"));d.showModal();}
 function preview(a,inDrawer=false){const type=kind(a);
  if(type==="image"||a.mime?.startsWith("image/"))return el("img",{src:a.url,alt:a.name,loading:"lazy",decoding:"async"});
  if(type==="video"||a.mime?.startsWith("video/"))return inDrawer?el("video",{muted:true,playsinline:true,preload:"none","aria-label":a.name}):el("video",{src:a.url,controls:true,preload:"metadata",playsinline:true});
  if(type==="audio"||a.mime?.startsWith("audio/"))return inDrawer?el("span",{class:"ag-tile-audio"},icon("volume")):el("audio",{src:a.url,controls:true,preload:"metadata"});
  return el("span",{class:"ag-tile-file"},icon("layers"),a.name);
 }
 function useInChat(a){return safe(async()=>{const item=await api(`/conversations/${c.id}/reuse`,"POST",{artifact:a.id});if(!pending.includes(item.id))pending.push(item.id);if(!c.attachments.some(x=>x.id===item.id))c.attachments.push(item);drawFooter(true);toast("Attached to your next message");})();}
 function mediaCard(a){const type=kind(a),media=preview(a),info=el("small",{},verified(a)),node=el("article",{class:"ag-media","data-artifact":a.id},media,info,el("div",{class:"ag-actions"}));
  const actions=node.querySelector(".ag-actions");actions.append(el("a",{href:a.url,download:a.name,class:"ag-text-button"},"Download"),a.job?el("a",{href:a.app?`#/app/${a.app}/history`:"#/library",class:"ag-text-button"},"History"):null,button("Use in chat",()=>useInChat(a),"ag-text-button",{disabled:busy()}));
  return {node,update(next){if(info.textContent!==verified(next))info.textContent=verified(next);const b=busy();const buttonEl=actions.querySelector("button");if(buttonEl&&buttonEl.disabled!==b)buttonEl.disabled=b;}};
 }
 function welcome(){return el("div",{class:"ag-welcome"},el("div",{class:"ag-welcome-orb"},icon("spark")),el("span",{class:"ag-eyebrow"},"YOUR IDEAS. YOUR MODELS. YOUR STUDIO."),el("h2",{},"What will you create",el("br"),el("em",{},"next?")),el("p",{},"Start with an idea. Your agent finds the tools, prepares the work, and brings it to life."),el("div",{class:"ag-starters"},...starters.map(([name,label,text])=>button(el("span",{},icon(name),label),()=>{draft=text;drawFooter(true);footer.querySelector("textarea")?.focus();},"ag-starter"))),el("a",{href:"#/explore",class:"ag-explore-link"},"Or explore the studio ",icon("chevR")));}
 function openMedia(){if(!c)return;drawerOpen=true;drawer.hidden=false;drawDrawer();}
 function drawDrawer(){if(!drawerOpen)return;const counts={all:mediaItems.length,image:mediaItems.filter(a=>kind(a)==="image").length,video:mediaItems.filter(a=>kind(a)==="video").length,audio:mediaItems.filter(a=>kind(a)==="audio").length};
  const filters=el("div",{class:"ag-drawer-filters"},...["all","image","video","audio"].map(k=>button(`${k==="all"?"All":k==="image"?"Images":k==="video"?"Videos":"Audio"}${counts[k]?` ${counts[k]}`:""}`,()=>{drawerFilter=k;drawDrawer();},`ag-filter${drawerFilter===k?" active":""}`,{"aria-pressed":String(drawerFilter===k)})));
  const items=mediaItems.filter(a=>drawerFilter==="all"||kind(a)===drawerFilter),grid=el("div",{class:"ag-drawer-grid"});
  if(!items.length)grid.append(el("p",{class:"ag-drawer-empty"},mediaItems.length?"No media in this filter.":"No media in this conversation yet. Generated images, video and audio appear here as they are produced."));
  for(const a of items)grid.append(mediaTile(a));
  drawer.replaceChildren(el("header",{class:"ag-drawer-head"},el("div",{},el("h2",{},"Conversation media"),el("p",{},`${counts.all} item${counts.all===1?"":"s"} · chronological`)),ico("x","Close media library",closeDrawer)),filters,grid);
  drawer.querySelectorAll("video[data-src]").forEach(v=>videoObserver.observe(v));
 }
 function mediaTile(a){const type=kind(a),visual=preview(a,true);if(type==="video"&&visual.dataset){visual.dataset.src=a.url;visual.addEventListener("mouseenter",()=>{if(!visual.src){visual.preload="metadata";visual.src=`${a.url}#t=0.1`;}},{once:true});}
  const play=button(visual,()=>openViewer(a),`ag-tile-media ${type}`,{"aria-label":`View ${a.name}`});
  const actions=el("div",{class:"ag-tile-actions"},el("a",{href:a.url,download:a.name,class:"ag-icon-link",title:"Download","aria-label":`Download ${a.name}`},icon("download")),button(icon("chevR"),()=>{closeDrawer();timeline.jump(a.messageId);},"ag-icon-link",{title:"Jump to message","aria-label":`Jump to message for ${a.name}`,disabled:!a.messageId}),button(icon("plus"),()=>useInChat(a),"ag-icon-link",{title:"Use in chat","aria-label":`Use ${a.name} in chat`,disabled:busy()}));
  return el("figure",{class:"ag-tile","data-artifact":a.id},play,el("figcaption",{},el("b",{title:a.name},a.name),el("small",{},verified(a)||type),actions));
 }
 function openViewer(a){const d=modal(a.name,verified(a)||kind(a)),body=preview(a);d.append(el("div",{class:"ag-viewer"},body),el("div",{class:"ag-viewer-actions"},el("a",{href:a.url,download:a.name,class:"btn lime"},"Download"),a.job?el("a",{href:a.app?`#/app/${a.app}/history`:"#/library",class:"btn ghost"},"Open in History"):null,button("Use in chat",()=>useInChat(a),"btn ghost"),button("Jump to message",()=>{d.close();closeDrawer();timeline.jump(a.messageId);},"btn ghost",{disabled:!a.messageId})),el("p",{class:"ag-privacy-note"},"Metadata is read from the produced file. An audio stream or duration does not verify spoken words, identity or visual fidelity."));d.showModal();}
 function exportMenu(){const d=modal("Export conversation","Markdown for reading and sharing, JSON for replay or analysis.");let details=true;const links=el("div",{class:"ag-export-links"}),update=()=>{links.replaceChildren(el("a",{class:"btn lime",href:`/api/agent/conversations/${c.id}/export?format=markdown&details=${details?1:0}`,download:`riverfield-${c.id}.md`},"Download Markdown"),el("a",{class:"btn ghost",href:`/api/agent/conversations/${c.id}/export?format=json&details=${details?1:0}`,download:`riverfield-${c.id}.json`},"Download JSON"));};
  d.append(el("div",{class:"ag-export-options"},el("label",{class:"ag-simple-check"},el("input",{type:"checkbox",checked:true,onchange:e=>{details=e.target.checked;update();}}),el("span",{},"Include tool arguments and results")),el("p",{class:"ag-privacy-note"},"Exports include conversations, tool activity, job IDs and media links. API keys, credentials and provider configuration are never included.")),links,el("p",{class:"ag-privacy-note"},"Media links point to this Riverfield instance. A portable ZIP is not generated; use the original files from History for offline archives."));update();d.showModal();}
 const submit=safe(async()=>{if(sending||busy()||c?.status==="approval")return;if(!draft.trim()&&!pending.length)return;if(!currentProvider()){settings();return;}sending=true;
  try{await ensure();await api(`/conversations/${c.id}`,"PATCH",{model:c.model});await api(`/conversations/${c.id}/messages`,"POST",{text:draft,attachments:pending});draft="";pending=[];c=await api(`/conversations/${c.id}`);drawHeader();timeline.update(c);}finally{sending=false;drawFooter(true);}
 });
 function drawFooter(force=false){const p=providers.find(p=>p.id===currentProvider()),signature=JSON.stringify([c?.id,busy(),sending,c?.status,p?.location,p?.tokenMode,limits?.outputTokens,pending]);
  if(!force&&signature===footerSignature){const current=footer.querySelector("textarea");if(current&&current!==document.activeElement&&draft&&current.value!==draft)current.value=draft;return;}footerSignature=signature;
  const old=footer.querySelector("textarea"),focused=old===document.activeElement,start=old?.selectionStart;footer.replaceChildren();
  const composer=el("textarea",{"aria-label":"Message Riverfield Agent",placeholder:"Describe your next idea…",rows:2,value:draft,disabled:busy()||sending||c?.status==="approval"});
  composer.oninput=()=>{draft=composer.value;composer.style.height="auto";composer.style.height=Math.min(220,composer.scrollHeight)+"px";};composer.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();void submit();}};
  const upload=el("input",{type:"file",hidden:true,multiple:true,accept:"image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/*,.txt",onchange:safe(async()=>{await ensure();for(const file of upload.files){const fd=new FormData();fd.set("file",file);const item=await api(`/conversations/${c.id}/upload`,"POST",fd);c.attachments.push(item);pending.push(item.id);}drawFooter(true);})});
  const fileChips=el("div",{class:"ag-attachments"},...pending.map(id=>{const a=c?.attachments.find(a=>a.id===id);return button(`${a?.name||id} ×`,()=>{pending=pending.filter(x=>x!==id);drawFooter(true);},"ag-file-chip");}));
  footer.append(el("div",{class:"ag-composer"},upload,fileChips,composer,el("div",{class:"ag-compose-actions"},ico("plus","Attach files",()=>upload.click()),el("span",{class:`ag-composer-meta ${p?.location||""}`},el("i",{class:"ag-connection-dot"}),p?.location==="remote"?"Remote provider":p?"Local connection":"Choose a model to begin",limits?.outputTokens?` · ${tokens(limits.outputTokens)} ${p?.tokenMode==="custom"?"native cap":"max"}`:""),busy()?button(icon("stop"),safe(()=>api(`/conversations/${c.id}/stop`,"POST",{})),"ag-send is-stop",{"aria-label":"Stop agent and related jobs",title:"Stop agent and related jobs"}):button("↑",submit,"ag-send",{"aria-label":"Send message",disabled:sending||c?.status==="approval"}))),
   el("small",{class:"ag-composer-note"},p?.location==="remote"?"Remote · messages, enabled images and tool results leave this machine.":"Your studio stays in your hands. Review expensive tool calls before running."));
  footer.querySelector('button[aria-label="Attach files"]').disabled=busy()||sending;
  if(focused&&!composer.disabled){composer.focus();composer.setSelectionRange(start??draft.length,start??draft.length);}
 }
 function draw(){if(disposed)return;classes();drawSidebar();drawHeader();timeline.update(c);drawFooter();}
 safe(async()=>{providers=(await api("/providers")).providers;try{selectedProvider=localStorage.getItem("riverfield.agent.provider")||"";}catch{}if(!providers.some(p=>p.id===selectedProvider))selectedProvider=providers[0]?.id||"";selectedModel=providers.find(p=>p.id===selectedProvider)?.model||"";await loadList();
  if(disposed)return;draw();void loadLimits();try{tools=(await api("/tools")).tools;}catch(e){toast(`MCP: ${e.message}`,{error:true});}if(disposed)return;
  if(!home){let saved;try{saved=localStorage.getItem("riverfield.agent.conversation");}catch{}const id=conversations.find(x=>x.id===saved)?.id||conversations[0]?.id;if(id)await open(id);}
 })();
 const videoObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){const v=e.target;if(v.dataset.src&&!v.src){v.preload="metadata";v.src=`${v.dataset.src}#t=0.1`;delete v.dataset.src;}videoObserver.unobserve(v);}},{root:drawer,rootMargin:"80px"});
 const onKey=e=>{if(e.key==="Escape"&&drawerOpen)closeDrawer();};document.addEventListener("keydown",onKey);
 return {node:root,active:home?"home":"agent",dispose(){disposed=true;stream?.close();videoObserver.disconnect();document.removeEventListener("keydown",onKey);timeline.dispose();closeDrawer();document.querySelectorAll("dialog.ag-settings").forEach(d=>d.close());}};
}
