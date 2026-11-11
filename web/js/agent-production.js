import {el,toast} from "./util.js";
import {modal,field,select,button,safe} from "./agent-controls.js";

const clock=n=>{const m=Math.floor(n/60),s=Math.round(n%60);return m?`${m}:${String(s).padStart(2,"0")}`:`${Math.round(n*10)/10}s`;};
const engineOptions=(p,key,apps,label)=>{const options=apps.map(a=>[a.id,`${a.name}${a.status==="draft"?" · draft":""}`]);if(p[key]&&!apps.some(a=>a.id===p[key]))options.unshift([p[key],`${p[key]} · not installed`]);if(!p[key])options.unshift(["",`Choose ${label} app (optional notes)`]);return options;};

/** Review dialog: the plan cannot be approved by the model, only here. */
export async function productionSettings({api,id,onSaved}){
 const view=await api(`/conversations/${id}/production`);
 if(!view.production){toast("No production plan yet. Ask the agent to prepare one.");return;}
 const p=structuredClone(view.production),apps=view.apps||[];
 const video=apps.filter(a=>a.section==="video"),image=apps.filter(a=>a.section==="image");
  const d=modal("Production plan","Optional script and runtime notes. Generation authorization is separate; review exact tool arguments before running.");
 const issues=el("section",{class:"ag-production-issues"}),facts=el("div",{class:"ag-plan-facts"}),scenes=el("div",{class:"ag-plan-scenes"}),dialogueNote=el("p",{class:"ag-privacy-note"});
 let locked=JSON.stringify(p.lockedValues||{},null,2);
 const drawIssues=v=>{const list=v?.issues||[];issues.className=`ag-production-issues${list.length?" bad":" good"}`;issues.replaceChildren(el("b",{},list.length?"Not ready for approval":"Ready for approval"),...list.map(x=>el("p",{},x)));};
 const draw=()=>{
  const total=p.scenes.reduce((sum,s)=>sum+s.seconds,0),generated=p.scenes.filter(s=>s.status==="generated").length;
  facts.replaceChildren(el("span",{},`Requested ${clock(p.durationSeconds)}`),el("span",{},`Plan ${clock(total)} · ${p.scenes.length} scenes`),el("span",{},`${generated} produced`),
   el("span",{},p.status==="approved"?`Approved ${p.approvedAt?.slice(0,10)||""}`:"Draft"),el("span",{},p.pilot?.approved?"Pilot approved":"Pilot pending"));
  scenes.replaceChildren(...p.scenes.map(s=>{
   const parts=[el("header",{},el("b",{},s.title),el("span",{},clock(s.seconds))),
    el("small",{},`${s.id} · ${s.references.join(", ")||"no canonical reference"} · ${s.status}`),
    el("p",{},s.prompt)];
   if(s.dialogue.length)parts.push(el("div",{class:"ag-plan-dialogue"},...s.dialogue.map(x=>el("p",{},`${x.speaker?`${x.speaker}: `:""}${x.line}`))));
   else parts.push(el("small",{},"No dialogue"));
   return el("article",{class:"ag-plan-scene"},...parts);
  }));
   dialogueNote.textContent=p.sound==="dialogue"?"Dialogue notes: keep spoken lines in the native video prompt. File metadata alone cannot verify speech.":"Non-dialogue sound plan.";
 };
 const body=()=>{try{p.lockedValues=JSON.parse(locked||"{}");}catch{throw new Error("Locked input values must be valid JSON");}return p;};
 const save=button("Save draft",safe(async()=>{const v=await api(`/conversations/${id}/production`,"POST",{plan:body()});Object.assign(p,v.production||{});dialogueNote.textContent="Draft saved. Review the checks below, then approve.";drawIssues(v);draw();await onSaved?.();}),"ag-text-button");
  const approve=button("Approve notes",safe(async()=>{
  await api(`/conversations/${id}/production`,"POST",{plan:body()});
  const v=await api(`/conversations/${id}/production`,"POST",{approve:true});
  drawIssues(v);await onSaved?.();toast("Production plan approved");d.close();
 }),"btn lime");
 d.append(
  facts,issues,
  el("div",{class:"ag-dialog-form"},
   el("div",{class:"ag-form-row"},field("Format",p.format,v=>p.format=v),field("Platform",p.platform,v=>p.platform=v)),
   el("div",{class:"ag-form-row"},field("Genre / style",p.style,v=>p.style=v),field("Language",p.language,v=>p.language=v)),
   el("div",{class:"ag-form-row"},field("Aspect",p.aspect,v=>p.aspect=v),select("Sound",p.sound,[["dialogue","Dialogue"],["music","Music only"],["ambient","Ambient"],["silent","Silent"]],v=>p.sound=v)),
   el("div",{class:"ag-form-row"},field("Requested runtime (seconds)",p.durationSeconds,v=>p.durationSeconds=Number(v),"number"),field("Model note (optional)",p.model,v=>p.model=v)),
   select("Video engine",p.engine,engineOptions(p,"engine",video,"video"),v=>p.engine=v),
   select("Reference image engine",p.imageEngine,engineOptions(p,"imageEngine",image,"image"),v=>p.imageEngine=v),
   el("details",{class:"ag-advanced"},el("summary",{},"Locked engine values (JSON)"),field("Locked input values",locked,v=>locked=v,"textarea"),
     el("p",{class:"ag-privacy-note"},"Recipe notes only; these do not authorize jobs or block separately approved utilities. Use actual app input names and values.")),
   field("Treatment / arc",p.treatment,v=>p.treatment=v,"textarea"),
   dialogueNote),
  el("h3",{},"Approved script"),scenes,
   el("p",{class:"ag-privacy-note"},"The agent cannot approve these notes. Editing resets their review status, not job permissions. To rewrite scenes, ask in chat."),
  el("div",{class:"ag-dialog-actions ag-plan-actions"},button("Ask the agent for changes",()=>{d.close();toast("Describe the changes you want in the chat.");},"ag-text-button"),save,approve));
 drawIssues(view);draw();d.showModal();
}
