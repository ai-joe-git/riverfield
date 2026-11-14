import {el} from "./util.js";
import {button} from "./agent-controls.js";

const finishedJobs=new Set(["succeeded","failed","canceled","expired","lost"]);
/** A completed submission tool is not a completed GPU job. Unknown outcomes stay locked. */
export function directorJobState(c,target){
 const run=c.tools.findLast(t=>t.guidedTarget===target);
 if(!run)return {pending:false,status:"",job:null};
 const status=run.job?(c.jobStates[run.job]?.status||"submitted"):run.status;
 return {pending:run.status==="uncertain"||Boolean(run.job&&!finishedJobs.has(status))||["running","approved","proposed"].includes(run.status),status,job:run.job||null};
}

/** Inline chat choices. No dialog, settings panel, selectors, or AI-generated controls. */
export function directorChat(c,{act,markdown,busy=false}){
 const f=c.director,step=f.chatStep||"duration",root=el("section",{class:"ag-questions ag-director-chat","aria-label":"Pika chat"});
 const send=payload=>act(payload),choose=(key,value="",target="")=>send({action:"choose",key,value:String(value),target});
 const title=text=>root.append(el("h3",{},text)),note=text=>root.append(el("p",{},text));
 const choices=(key,options)=>root.append(el("div",{class:"ag-choices"},...options.map(([value,label])=>button(label,()=>choose(key,value),"ag-choice",{disabled:busy}))));
 const referenceTargets=[...f.actors.map((_,i)=>`actor:${i}`),"environment"],referencesPending=referenceTargets.some(t=>directorJobState(c,t).pending);
 const action=(label,payload,primary=false)=>{
  const target=payload.action==="run"?(payload.kind==="edit"?payload.index<0?"environment":`actor:${payload.index}`:payload.kind==="actor"?`actor:${payload.index||0}`:payload.kind):null;
  const pending=target?directorJobState(c,target).pending:payload.action==="references"&&f.mode==="ref2va"&&referencesPending;
  root.append(button(pending?target==="video"?"Video in progress…":target==="relay"?"Upscale in progress…":"References in progress…":label,()=>{if(!pending&&!busy)send(payload);},primary?"btn lime":"ag-text-button",{disabled:busy||pending,"aria-busy":pending||undefined}));
 };
 const settings=()=>action("Change settings",{action:"choose",key:"settings"});
 const asset=(target,explicit)=>{if(explicit)return [...c.artifacts,...c.attachments].find(a=>a.id===explicit);if(f.staleTargets?.includes(target))return null;const run=c.tools.findLast(t=>t.guidedTarget===target);return run?.job&&c.jobStates[run.job]?.status==="succeeded"?c.artifacts.find(a=>a.job===run.job&&a.type===(target==="video"||target==="relay"?"video":"image")):null;};
 const video=asset("video"),relayRun=c.tools.findLast(t=>t.guidedTarget==="relay"),relayCandidate=asset("relay"),relay=video&&relayRun?.arguments?.files?.video===video.path&&String(relayRun?.arguments?.values?.unet_name||"").includes(`_${f.relay}_`)?relayCandidate:null;
 const timing=n=>((175+(n-1)*136)/24).toFixed(2);
 const key=s=>s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
 const duplicate=f.actors.some((a,i)=>f.actors.slice(0,i).some(b=>{const aw=new Set(key(a.description).split(" ").filter(Boolean)),bw=new Set(key(b.description).split(" ").filter(Boolean));return key(a.name)===key(b.name)||a.description.trim()&&b.description.trim()&&(key(a.description)===key(b.description)||Math.min(aw.size,bw.size)>=12&&[...aw].filter(w=>bw.has(w)).length/Math.max(aw.size,bw.size)>.85);}));
 if(duplicate&&step!=="edit"&&step!=="settings"){
  title("The character assignments need correction");note("Duplicate names or near-identical descriptions were found. Reference and video generation are blocked until the cast is corrected. Existing images remain in History.");
  f.actors.forEach((a,i)=>root.append(el("p",{},`Character ${i+1}: ${a.name} — ${a.description}`),button(`Edit character ${i+1} name`,()=>choose("edit",`actors.${i}.name`),"ag-text-button",{disabled:busy}),button(`Edit character ${i+1} appearance`,()=>choose("edit",`actors.${i}.description`),"ag-text-button",{disabled:busy})));
  action("Repair cast and shot prompts",{action:"prepare"},true);note("Writing only. This does not regenerate images or video. Ask questions in the chat; messages do not silently rewrite the story.");return root;
 }
 if(f.promptsStale&&["draft","references","render"].includes(step)){
  title("The shot prompts need updating");note("The story or cast changed. Old images remain in History, but outdated shot prompts cannot be rendered.");action("Prepare updated shot prompts",{action:"prepare"},true);action("Revise story",{action:"choose",key:"edit",value:"scenario"});note("Writing only; no image or video generation.");return root;
 }
 if(step==="duration"){title("How long should the video be?");choices("duration",[1,2,3,5,8].map(n=>[n,`${timing(n)} s · ${n} ${n===1?"segment":"segments"}`]));note("Native 7.29-second segments; overlaps are already included.");}
 else if(step==="resolution"){title("Choose the generation resolution");choices("resolution",[[.4,"0.4 MP · economical"],[.8,"0.8 MP"]]);}
 else if(step==="relay"){title("Use RelayVSR after Pika?");choices("relay",[["x2","x2 · default"],["x4","x4"],["off","No upscale"]]);note("x2 doubles width and height: about 1.6 MP from a 0.4 MP source. It is a separate GPU step.");}
 else if(step==="cast"){title("How many main characters?");choices("cast",[[1,"One"],[2,"Two"],[3,"Three"]]);}
 else if(step==="aspect"){title("Choose the frame format");choices("aspect",[["9:16 (Portrait Widescreen)","9:16 · vertical"],["16:9 (Widescreen)","16:9 · landscape"],["1:1 (Square)","1:1 · square"]]);}
 else if(step==="mode"){title("Use visual references?");choices("mode",[["ref2va","Ref2VA · with references"],["fl2va","FL2VA · text only, empty bin"]]);}
 else if(step==="language"){title("Choose the spoken language");choices("language",["English","French","Spanish","Japanese","Chinese"].map(x=>[x,x]));}
 else if(step==="settings"){title("What would you like to change?");choices("setting",[["duration","Duration"],["resolution","Resolution"],["relay","Upscale"],["cast","Cast size"],["aspect","Format"],["mode","Reference mode"],["language","Spoken language"]]);action("Back",{action:"choose",key:"back"});}
 else if(step==="brief"||step==="story"&&!f.scenario.trim()){title(f.brief?"The story has not been written yet":"What is your story about?");note("Type your idea in the chat. The writer will draft the story only — it cannot change the settings or launch tools.");if(f.brief){note(`Your idea is preserved: ${f.brief}`);action("Retry writing story",{action:"say",text:f.brief},true);}settings();}
 else if(step==="story"){title("Use this story?");note("Ask questions in the chat. To change the story, choose Revise story. Writing does not generate images or video.");root.append(el("details",{},el("summary",{},"Review story"),markdown(f.scenario)));action("Use story and prepare shot prompts",{action:"prepare"},true);action("Revise story",{action:"choose",key:"edit",value:"scenario"});settings();}
 else if(step==="edit"){title(`Revise ${f.chatField||"the selected text"}`);note("Type the change in the chat. Only this text will be rewritten.");action("Cancel",{action:"choose",key:"back"});}
 else if(step==="editReference"){title("What should change in this reference?");note("Describe the correction in the chat. It will wait for your confirmation before using Qwen Turbo.");action("Cancel",{action:"choose",key:"back"});}
 else if(step==="confirmEdit"){title("Apply this image correction?");note(f.chatCorrection||"");action("Apply correction · GPU",{action:"run",kind:"edit",index:f.chatTarget==="environment"?-1:Number(f.chatTarget?.split(":")[1]||0),instruction:f.chatCorrection},true);action("Cancel",{action:"choose",key:"back"});}
 else if(step==="pickReference"){title("Choose an existing image");const images=[...c.artifacts,...c.attachments].filter(a=>a.mime?.startsWith("image/"));for(const a of images)root.append(el("div",{class:"ag-chat-reference"},el("img",{src:a.url,alt:a.name,loading:"lazy"}),button("Use this image",()=>choose("bind",a.id,f.chatTarget),"ag-text-button",{disabled:busy})));if(!images.length)note("Attach an image with the + button in the chat, or generate the references.");action("Back",{action:"choose",key:"back"});}
 else if(step==="draft"){
  title("The shot prompts are ready");note(`${f.count} native segments · ${timing(f.count)} s · ${f.megapixels} MP · ${f.language} dialogue. The code owns all Pika settings and bindings.`);
  note(`Cast: ${f.actors.map(a=>a.name).join(" · ")}`);if(f.staleTargets?.some(t=>t.startsWith("actor:")))note("Changed characters need new references or an explicit image selection. Old images stay in History; they are not silently reused or regenerated.");
  const review=el("details",{},el("summary",{},"Review or edit the creative text"));f.actors.forEach((a,i)=>review.append(el("p",{},`${a.name}: ${a.description}`),button(`Rename ${a.name}`,()=>choose("edit",`actors.${i}.name`),"ag-text-button",{disabled:busy}),button(`Edit ${a.name}`,()=>choose("edit",`actors.${i}.description`),"ag-text-button",{disabled:busy})));review.append(el("p",{},`Environment: ${f.environment}`),button("Edit environment",()=>choose("edit","environment"),"ag-text-button",{disabled:busy}));
  f.segments.forEach((s,i)=>{review.append(el("h4",{},`Shot ${i+1}`),el("p",{},s.action),button("Edit visual prompt",()=>choose("edit",`segments.${i}.action`),"ag-text-button",{disabled:busy}));f.actors.forEach((a,j)=>review.append(el("p",{},`${a.name}: ${s.dialogue[j]||"(no dialogue)"}`),button(`Edit ${a.name}'s line`,()=>choose("edit",`segments.${i}.dialogue.${j}`),"ag-text-button",{disabled:busy})));for(const [key,label]of [["sound","Sound"],["music","Music"]])review.append(el("p",{},`${label}: ${s[key]}`),button(`Edit ${label.toLowerCase()}`,()=>choose("edit",`segments.${i}.${key}`),"ag-text-button",{disabled:busy}));});root.append(review);
  const referencesReady=f.actors.every((a,i)=>asset(`actor:${i}`,a.asset))&&asset("environment",f.environmentAsset);
  action(f.mode==="ref2va"?referencesReady?"Review existing references":"Generate missing references · GPU":"Continue to video",{action:"references"},true);if(f.mode==="ref2va")action("Use existing images",{action:"choose",key:"reviewReferences"});action("Revise story",{action:"choose",key:"edit",value:"scenario"});settings();
 }else if(step==="references"){
  title("Review the references");let ready=true;for(const [target,name,explicit]of [...f.actors.map((a,i)=>[`actor:${i}`,a.name,a.asset]),["environment","Empty environment",f.environmentAsset]]){const a=asset(target,explicit);if(!a)ready=false;const box=el("div",{class:"ag-chat-reference"},el("b",{},name));if(a)box.append(el("img",{src:a.url,alt:name,loading:"lazy"}),button("Correct this image",()=>choose("referenceEdit",target),"ag-text-button",{disabled:busy}));else box.append(el("p",{},"Waiting for this reference. Existing successful images will not be regenerated."));box.append(button("Use an existing image",()=>choose("pickReference","",target),"ag-text-button",{disabled:busy}));root.append(box);}
  root.append(button("Approve references",()=>choose("approveReferences"),"btn lime",{disabled:busy||!ready||referencesPending}));if(!ready||referencesPending)action("Generate missing references · GPU",{action:"references"});
 }else if(step==="render"){
  const videoJob=directorJobState(c,"video"),relayJob=directorJobState(c,"relay");
  title(videoJob.pending?"Your Pika video is in progress":video?"Your Pika video is ready":"Ready to generate the video");note(`${f.count} native segments · ${timing(f.count)} s · ${f.megapixels} MP. LCM, six Pika steps, sparsity 0.85.`);
  if(videoJob.pending)note(`Current video job: ${videoJob.status}${videoJob.job?` · ${videoJob.job}`:""}. No need to submit again; the existing job continues.`);
  if(relayJob.pending)note(`RelayVSR job: ${relayJob.status}${relayJob.job?` · ${relayJob.job}`:""}. The existing upscale continues.`);
  action(video?"Generate a new video · GPU":"Generate video · GPU",{action:"run",kind:"video"},!video);if(video){root.append(el("a",{href:video.url,target:"_blank",rel:"noopener",class:"btn lime"},"Open latest Pika video"));note("This is the latest completed render; text changes do not update an existing video.");if(f.relay!=="off"&&!relay)action(`Apply RelayVSR ${f.relay} · GPU`,{action:"run",kind:"relay"});if(relay)root.append(el("a",{href:relay.url,target:"_blank",rel:"noopener",class:"btn lime"},"Open upscaled video"));}
  action("Review prompts",{action:"choose",key:"reviewDraft"});action("Rewrite shot prompts · writing only",{action:"prepare"});settings();
 }
 if(["duration","resolution","relay","cast"].includes(step)&&!f.chatReturn)action("Use remaining defaults",{action:"choose",key:"defaults"});
 if(busy)note("Working on the requested step… No tool choices are being delegated to the model.");
 return root;
}
