import {el,icon} from "./util.js";
import {button,errorText} from "./agent-controls.js";
import {parseChoiceQuestions,choiceReply,createQuestionForm} from "./agent-questions.js";
import {directorChat} from "./agent-director-chat.js";

/** Reconcile without moving nodes already in order (moving a video can interrupt playback). */
export function reconcile(parent,nodes){let cursor=parent.firstChild;for(const node of nodes){if(node===cursor)cursor=cursor.nextSibling;else parent.insertBefore(node,cursor);}const keep=new Set(nodes);for(const child of [...parent.childNodes])if(!keep.has(child))child.remove();}
export function mediaIndex(c){
 const unique=new Map(),positions=new Map(c.messages.map((m,i)=>[m.id,i]));
 for(const a of [...c.artifacts,...c.attachments]){
  const key=a.path||a.id;if(unique.has(key))continue;
  const attached=c.messages.find(m=>m.attachments?.includes(a.id));
  unique.set(key,{...a,type:a.type||a.mime?.split("/")[0]||"file",messageId:a.origin?.messageId||attached?.id,order:positions.get(a.origin?.messageId||attached?.id)??Infinity});
 }
 return [...unique.values()].sort((a,b)=>a.order-b.order||(a.created||"").localeCompare(b.created||""));
}
const clock=n=>{const m=Math.floor(n/60),s=Math.round(n%60);return m?`${m}:${String(s).padStart(2,"0")}`:`${Math.round(n*10)/10}s`;};
export function createTimeline({chat,markdown,card,welcome,approve,refresh,resume,jumpButton,onIndex,answer,production,pilot,start,directorAction,directorBusy=()=>false}){
 let conversation="",entries=new Map(),cards=new Map(),toolNodes=new Map(),frame=0,next=null,follow=true,anchor=null,lastIndex="";
 let questionNode=null,questionKey="",shownQuestion="",lastStatus="";
 const tail=el("div",{class:"ag-timeline-tail"}),jobs=el("section",{class:"ag-jobs"}),jobNodes=new Map();let tailSignature="";
 const bottom=()=>chat.scrollHeight-chat.scrollTop-chat.clientHeight<140;
 const capture=()=>{const first=[...entries.values()].find(e=>e.node.getBoundingClientRect().bottom>chat.getBoundingClientRect().top);return first?{node:first.node,offset:first.node.getBoundingClientRect().top-chat.getBoundingClientRect().top}:null;};
 const scroll=()=>{follow=bottom();anchor=follow?null:capture();jumpButton.hidden=follow;};
 chat.addEventListener("scroll",scroll,{passive:true});
 jumpButton.onclick=()=>{follow=true;anchor=null;chat.scrollTop=chat.scrollHeight;jumpButton.hidden=true;};
 const resize=new ResizeObserver(()=>{if(follow)chat.scrollTop=chat.scrollHeight;else if(anchor?.node.isConnected){const offset=anchor.node.getBoundingClientRect().top-chat.getBoundingClientRect().top;chat.scrollTop+=offset-anchor.offset;}});
 const getCard=a=>{let entry=cards.get(a.id);if(!entry){entry=card(a);cards.set(a.id,entry);}entry.update(a);return entry.node;};
 function tool(call,c,records){
  const record=records.get(call.id),status=record?.status||"pending";let e=toolNodes.get(call.id);
  if(!e){const label=el("small",{}),body=el("div",{class:"ag-tool-body"}),actions=el("div",{class:"ag-actions"}),node=el("details",{"data-call":call.id},el("summary",{},el("span",{class:"ag-tool-dot"}),call.name,label),body,actions);e={node,label,body,actions};toolNodes.set(call.id,e);}
  e.node.className=`ag-tool ${status}`;e.label.textContent=status;
  const sig=JSON.stringify([call.arguments,record?.result,record?.error]);
  if(e.signature!==sig){e.signature=sig;e.body.replaceChildren(el("small",{},"Arguments"),el("pre",{},JSON.stringify(call.arguments,null,2)));if(record?.result){const details=el("details",{},el("summary",{},"Actual MCP result"));details.addEventListener("toggle",()=>{if(details.open&&!details.querySelector("pre"))details.append(el("pre",{},JSON.stringify(record.result,null,2)));});e.body.append(details);}if(record?.error)e.body.append(el("p",{class:"ag-error"},record.error));}
  const approval=c.status==="approval"&&status==="proposed";
  if(e.approval!==approval){e.approval=approval;e.actions.replaceChildren();if(approval){e.node.open=true;e.actions.append(button("Approve execution",()=>approve(call.id,true),"btn lime"),button("Decline",()=>approve(call.id,false),"ag-text-button"));}}
  return e.node;
 }
  function questionCard(pending){
   const key=JSON.stringify(pending);if(key===questionKey&&questionNode)return questionNode;questionKey=key;
   questionNode=createQuestionForm(pending.questions,answer);return questionNode;
 }
 function productionCard(c){
  const p=c.production,draft=p.status!=="approved";
  const generated=p.scenes.filter(s=>s.status==="generated"),produced=generated.reduce((sum,s)=>sum+s.seconds,0);
  const pilotScene=p.scenes.find(s=>s.job),video=pilotScene?c.artifacts.find(a=>a.job===pilotScene.job):undefined;
  const actions=el("div",{class:"ag-actions"}),complete=produced+0.5>=p.durationSeconds;
   if(draft)actions.append(button("Review saved notes",()=>production(c),"ag-text-button"));
  else{
   actions.append(button("Review production",()=>production(c),"ag-text-button"));
   if(!p.pilot?.approved){
    if(video){
      actions.append(el("span",{class:"ag-pilot-note"},"Pilot clip ready for review. Further generation needs separate authorization."),button("Record pilot approval",()=>pilot(video.id),"btn lime"));
    }else if(p.scenes.some(s=>s.status==="failed")){
     actions.append(el("span",{class:"ag-pilot-note"},"The pilot clip failed. Retry it or revise the plan before continuing."),
      button("Retry the pilot clip",()=>start("The pilot clip failed. Retry the first approved scene once with its exact prompt and dialogue, then stop for my pilot review."),"btn lime"));
    }else if(p.scenes.some(s=>s.status==="generating"||s.job)){
     actions.append(el("span",{class:"ag-pilot-note"},"The pilot clip is rendering. Approve it here when it is ready."));
    }else{
      actions.append(el("span",{class:"ag-pilot-note"},"These are saved notes, not permission to launch inference."),
       button("Prepare a pilot proposal",()=>start("Use the saved notes as context. Show the existing references and exact intended arguments for ONE pilot for my review. Do not generate anything yet."),"btn lime"));
    }
   }else{
    actions.append(el("span",{class:"ag-production-ok"},"Pilot approved"));
     if(!complete)actions.append(button("Prepare the next scene",()=>start("The pilot has been reviewed. Propose the next scene and exact intended arguments for my approval. Do not generate anything yet."),"ag-text-button"));
   }
  }
  return el("section",{class:`ag-production${draft?" draft":""}`,"aria-label":"Production plan"},
    el("header",{},el("div",{},el("small",{},"SAVED PRODUCTION NOTES"),el("h3",{},`${p.format} · ${p.style}`),el("p",{},`${p.platform} · ${p.language} · ${p.aspect} · ${clock(p.durationSeconds)} requested · ${p.sound}`)),
     el("span",{class:`ag-production-status${draft?"":" approved"}`},draft?"Draft notes":"Reviewed notes")),
   el("div",{class:"ag-production-progress"},el("progress",{max:Math.max(0.1,p.durationSeconds),value:Math.min(produced,p.durationSeconds)}),el("span",{},`${generated.length}/${p.scenes.length} scenes · ${clock(produced)} of ${clock(p.durationSeconds)}`)),
   el("div",{class:"ag-production-facts"},el("span",{},`Video ${p.engine}`),p.imageEngine?el("span",{},`Images ${p.imageEngine}`):null,p.model?el("span",{},`Model ${p.model}`):null),
   actions);
 }
 function render(c){
  const id=c?.id||"welcome";if(id!==conversation){conversation=id;entries.clear();cards.clear();toolNodes.clear();jobNodes.clear();tailSignature="";lastIndex="";follow=true;anchor=null;questionNode=null;questionKey="";shownQuestion="";lastStatus="";chat.replaceChildren();}
  const wasBottom=follow&&bottom();if(!wasBottom&&!anchor)anchor=capture();
   if(!c?.messages.length&&!c?.director){const mode="general",shown=chat.querySelector(".ag-welcome");if(!shown||shown.dataset.mode!==mode){const node=welcome();node.dataset.mode=mode;chat.replaceChildren(node);}return;}
  const records=new Map(c.tools.map(t=>[t.id,t])),grouped=new Map(),seen=new Set();
  for(const a of c.artifacts){if(seen.has(a.path||a.id))continue;seen.add(a.path||a.id);const id=a.origin?.messageId||c.messages.find(m=>m.calls?.some(x=>x.id===a.origin?.toolCallId))?.id||c.messages.find(m=>m.role==="assistant")?.id||c.messages[0]?.id;if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(a);}
  const nodes=[];
  for(const m of c.messages){const media=grouped.get(m.id)||[];if(m.role==="tool"&&!media.length)continue;if(m.role==="assistant"&&!m.content?.trim()&&!m.calls?.length&&!media.length)continue;
   let e=entries.get(m.id);if(!e){const body=el("div",{}),attachments=el("div",{class:"ag-message-attachments"}),tools=el("div",{}),outputs=el("div",{class:"ag-inline-media"}),studio=m.kind==="studio",node=el("article",{class:`ag-message ${m.role}${studio?" studio":""}`,"data-message":m.id},el("div",{class:"ag-message-author"},studio?icon("info"):m.role==="user"?"You":icon("spark"),studio?"Studio check":m.role==="assistant"?"Riverfield":m.role==="tool"?"Studio output":""),body,attachments,tools,outputs);e={node,body,attachments,tools,outputs};entries.set(m.id,e);resize.observe(node);}
    const interactive=m.role==="assistant"&&m===c.messages.at(-1)&&c.status==="idle"&&!m.calls?.length;
    const contentKey=JSON.stringify([m.content,interactive]);
    if(e.contentKey!==contentKey){e.contentKey=contentKey;const questions=interactive?parseChoiceQuestions(m.content||""):[];
     if(questions.length){const original=el("details",{class:"ag-question-original"},el("summary",{},"Original message"),markdown(m.content));e.body.replaceChildren(createQuestionForm(questions,payload=>start(choiceReply(questions,payload))),original);}
     else e.body.replaceChildren(...(m.content?[markdown(m.content)]:[]));
    }
   const attachmentSignature=JSON.stringify(m.attachments||[]);if(e.attachmentSignature!==attachmentSignature){e.attachmentSignature=attachmentSignature;e.attachments.replaceChildren(...(m.attachments||[]).map(id=>{const a=c.attachments.find(a=>a.id===id);return a?el("a",{href:a.url,target:"_blank",rel:"noopener",class:"ag-inline-attachment"},a.mime.startsWith("image/")?el("img",{src:a.url,alt:a.name,loading:"lazy"}):icon("layers"),a.name):null;}).filter(Boolean));}
   reconcile(e.tools,(m.calls||[]).map(call=>tool(call,c,records)));
   reconcile(e.outputs,media.map(getCard));nodes.push(e.node);
  }
  const planSignature=c.production?[c.production.status,c.production.approvedAt,c.production.pilot?.approved,c.production.scenes.map(s=>`${s.id}:${s.status}`).join(",")]:null;
   const signature=JSON.stringify([c.status,c.error,c.jobStates,c.tools.some(t=>t.status==="uncertain"),c.questions,planSignature,c.director,c.artifacts.map(a=>a.id),c.attachments.map(a=>a.id),directorBusy(),(c.warnings||[]).slice(-3)]);
  if(tailSignature!==signature){tailSignature=signature;const items=[];
   if(c.status==="running")items.push(el("div",{class:"ag-thinking"},el("i",{}),"Working with your studio…"));
   if(c.error)items.push(el("div",{class:"ag-error",role:"alert"},icon("info"),el("span",{},errorText(c.error))));
    if(c.status==="question"&&c.questions)items.push(questionCard(c.questions));
    if(c.director)items.push(directorChat(c,{act:directorAction,markdown,busy:c.status==="running"||directorBusy()}));
   if(c.production)items.push(productionCard(c));
   if(c.jobs.length||c.tools.some(t=>t.status==="uncertain")){
    const head=jobs.querySelector("header")||el("header",{},el("b",{},"Studio activity"),button("Refresh",refresh,"ag-text-button")),rows=[head];
    for(const id of c.jobs){const j=c.jobStates[id]||{};let row=jobNodes.get(id);if(!row){row=el("div",{"data-job":id});jobNodes.set(id,row);}const sig=JSON.stringify(j);if(row.dataset.signature!==sig){row.dataset.signature=sig;row.replaceChildren(el("span",{},j.app||"Studio job"),el("small",{},j.status||"unknown"),...(["succeeded","failed","canceled","expired","lost"].includes(j.status)||j.progress?.value==null?[]:[el("progress",{max:1,value:j.progress.value})]),el("a",{href:"#/library",title:id},id.slice(-8)),...(j.error?[el("span",{class:"ag-error"},j.error.message||String(j.error))]:[]));}rows.push(row);}reconcile(jobs,rows);items.push(jobs);
   }
   if(c.warnings?.length)items.push(el("section",{class:"ag-warning"},...c.warnings.slice(-3).map(w=>el("p",{},w))));
    const validationBlocked=c.error?.includes("deterministic input validation")||c.error?.startsWith("Stopped recovery:");
    if(["failed","interrupted","canceled"].includes(c.status)&&!validationBlocked&&!c.director)items.push(button(el("span",{},icon("redo")," Continue safely"),resume,"ag-retry",{title:"Continue without repeating completed tools"}));
   reconcile(tail,items);
  }
  nodes.push(tail);reconcile(chat,nodes);
  if(wasBottom){chat.scrollTop=chat.scrollHeight;follow=true;anchor=null;}else if(anchor?.node.isConnected){chat.scrollTop+=anchor.node.getBoundingClientRect().top-chat.getBoundingClientRect().top-anchor.offset;}
  if(c.status==="question"&&c.questions){
   if(shownQuestion!==questionKey){shownQuestion=questionKey;follow=false;anchor=null;
    const reveal=()=>{if(!questionNode?.isConnected)return;chat.scrollTop=Math.max(0,questionNode.getBoundingClientRect().top-chat.getBoundingClientRect().top+chat.scrollTop-14);};
    reveal();requestAnimationFrame(()=>{reveal();anchor=capture();jumpButton.hidden=bottom();});}
  }else if(lastStatus==="question"){shownQuestion="";follow=true;anchor=null;chat.scrollTop=chat.scrollHeight;jumpButton.hidden=true;}
  lastStatus=c.status;
  jumpButton.hidden=bottom();
  const index=mediaIndex(c),indexSignature=JSON.stringify(index);if(indexSignature!==lastIndex){lastIndex=indexSignature;onIndex(index);}
 }
 return {update(c){next=c;if(!frame)frame=requestAnimationFrame(()=>{frame=0;render(next);});},jumpLatest(){follow=true;anchor=null;chat.scrollTop=chat.scrollHeight;jumpButton.hidden=true;},jump(messageId){const entry=entries.get(messageId);if(!entry)return;follow=false;entry.node.scrollIntoView({block:"start",behavior:"instant"});anchor=capture();entry.node.classList.remove("ag-highlight");requestAnimationFrame(()=>entry.node.classList.add("ag-highlight"));jumpButton.hidden=bottom();},dispose(){cancelAnimationFrame(frame);resize.disconnect();chat.removeEventListener("scroll",scroll);}};
}
