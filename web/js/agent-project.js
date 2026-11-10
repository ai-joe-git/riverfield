import {el} from "./util.js";
import {modal,field,select,button,safe} from "./agent-controls.js";

export function projectSettings(c,onSave){
 const p=structuredClone(c.project||{brief:"",summary:"",references:[],scenes:[],activeScene:"",lock:{section:"video",app:"",values:{}}});
 const d=modal("Project & consistency","Durable creative brief, canonical references and explicit engine locks. The agent cannot change your locks.");
 let lockedValues=JSON.stringify(p.lock.values,null,2);const refs=el("div",{class:"ag-dialog-form"}),scenes=el("div");
 const assets=[...new Map([...c.attachments,...c.artifacts].map(a=>[a.id,a])).values()];
 const drawRefs=()=>refs.replaceChildren(...p.references.map((r,i)=>el("div",{class:"ag-form-row"},field("Reference name",r.label,v=>r.label=v),select("Role",r.kind,[["character","Character"],["location","Location"],["prop","Prop"]],v=>r.kind=v),select("Canonical asset",r.assetId,assets.map(a=>[a.id,`${a.name} · ${a.id.slice(0,8)}`]),v=>r.assetId=v),button("Remove",()=>{p.references.splice(i,1);drawRefs();},"ag-text-danger"))));
 drawRefs();for(const s of p.scenes)scenes.append(el("p",{},`${s.title} · ${s.status} · refs: ${s.requiredReferences.join(", ")||"none"}`));
 d.append(
  field("Creative brief / user constraints",p.brief,v=>p.brief=v,"textarea"),
  field("Working summary",p.summary,v=>p.summary=v,"textarea"),el("h3",{},"User engine lock"),
  select("Apply lock to studio",p.lock.section,[["video","Video"],["image","Image"],["audio","Audio"],["3d","3D"],["utility","Utility"]],v=>p.lock.section=v),
  field("Required app ID (blank = free choice)",p.lock.app,v=>p.lock.app=v),
  field("Locked input values (JSON object)",lockedValues,v=>lockedValues=v,"textarea"),
  el("p",{class:"ag-privacy-note"},"Example: app pika-studio-director, values {\"flex_mode\":\"ref2va\"}. Use the exact input names/values from the app. Other studios remain available for preparing references."),
  el("h3",{},"Canonical characters, locations & props"),refs,
  button("Add canonical reference",safe(()=>{if(!assets.length)throw new Error("Attach or generate a reference first");p.references.push({label:`Reference ${p.references.length+1}`,kind:"character",assetId:assets[0].id});drawRefs();})),
  el("h3",{},"Scene plan"),scenes,
  select("Active scene",p.activeScene,[["","None"],...p.scenes.map(s=>[s.id,s.title])],v=>p.activeScene=v),
  el("p",{class:"ag-privacy-note"},"Ask the agent to maintain its scene plan with project_state. Video generation is blocked if a required canonical reference for the active scene is missing. Generated does not mean identity/dialogue was verified."),
  button("Save project",safe(async()=>{p.lock.values=JSON.parse(lockedValues);await onSave(p);d.close();}),"btn lime")
 );d.showModal();
}
