import {el} from "./util.js";
import {button,safe} from "./agent-controls.js";

/** Recover explicit numbered questionnaires, never ordinary lists, code or tool instructions. */
export function parseChoiceQuestions(text){
 if(!/reply with|respond with|choose your|pick your|répondez|réponds|vos choix/i.test(text)||text.includes("```"))return [];
 const clean=s=>s.replace(/\*\*|`|(?<!\*)\*(?!\*)/g,"").trim(),questions=[];let current=null;
 for(const line of text.split(/\r?\n/)){
  const heading=/^(?:#{1,6}\s*)?(?:\*\*)?(\d{1,2})[.)]\s+(.+?)(?:\*\*)?\s*$/.exec(line.trim());
  if(heading){current={id:`choice-${heading[1]}`,header:clean(heading[2]),question:clean(heading[2]),multiple:false,options:[]};questions.push(current);continue;}
  const option=/^\s*[-*•]\s+(.+)$/.exec(line);
  if(option&&current){const [label,...description]=clean(option[1]).split(/\s+[—–]\s+/);current.options.push({label,description:description.join(" — ")});}
 }
 if(!questions.length||questions.length>6||new Set(questions.map(q=>q.id)).size!==questions.length)return [];
 if(questions.some(q=>!q.header||q.header.length>60||q.options.length<2||q.options.length>8||new Set(q.options.map(o=>o.label)).size!==q.options.length||q.options.some(o=>!o.label||o.label.length>80||o.description.length>300)))return [];
 return questions;
}

export function choiceReply(questions,payload){
 if(payload.skip)return "Choose sensible defaults for these questions. Present the proposal for my review; do not generate anything yet.";
 return ["Here are my choices:",...questions.map(q=>{const picks=payload.answers[q.id]||[];return picks.length?`${q.header}: ${picks.join(", ")}`:"";}).filter(Boolean),payload.notes||"","Prepare the proposal for my review. These answers do not authorize generation."].filter(Boolean).join("\n");
}

export function createQuestionForm(questions,onAnswer){
 const chosen=new Map(questions.map(q=>[q.id,new Set()])),others=new Map(),groups=[];let sending=false,step=0;
 const root=el("section",{class:"ag-questions","aria-label":"Interactive choices"},el("header",{},el("small",{},"YOUR CHOICES"),el("h2",{},"Choose what works for you"),el("p",{},"Click an option or add your own answer. This does not start generation.")));
 const position=el("span",{"aria-live":"polite"}),progress=el("progress",{max:questions.length,value:1,"aria-label":"Question progress"});
 root.append(el("div",{class:"ag-question-progress"},position,progress));
 const hasAnswer=()=>[...chosen.values()].some(set=>set.size)||[...others.values()].some(input=>input.value.trim());
 const send=safe(async skip=>{
  if(sending||(!skip&&!hasAnswer()))return;
  const notes=questions.map(q=>{const value=others.get(q.id).value.trim();return value?`${q.header}: ${value}`:"";}).filter(Boolean).join("\n");
  sending=true;root.querySelectorAll("button,input").forEach(e=>e.disabled=true);
  try{await onAnswer(skip?{skip:true}:{answers:Object.fromEntries([...chosen].map(([id,set])=>[id,[...set]])),notes});}
  finally{sending=false;root.querySelectorAll("button,input").forEach(e=>e.disabled=false);submit.disabled=!hasAnswer();}
 });
 const submit=button("Continue with these choices",()=>send(false),"btn lime",{disabled:true});
 for(const q of questions){
  const group=el("div",{class:"ag-question"},el("b",{},q.header),q.question!==q.header?el("p",{},q.question):null),chips=el("div",{class:"ag-choices",role:"group","aria-label":q.header});
  for(const o of q.options){
   const chip=button(el("span",{},o.label,o.description?el("small",{},o.description):null),()=>{
    const set=chosen.get(q.id);if(q.multiple){set.has(o.label)?set.delete(o.label):set.add(o.label);}else{set.clear();set.add(o.label);}
    for(const other of chips.children)other.setAttribute("aria-pressed",String(set.has(other.dataset.label)));
    submit.disabled=!hasAnswer();
   },"ag-choice",{"aria-pressed":"false"});chip.dataset.label=o.label;chips.append(chip);
  }
  const other=el("input",{class:"ag-other",placeholder:"Your own answer / details (optional)",autocomplete:"off","aria-label":`${q.header}: other answer`,oninput:()=>{submit.disabled=!hasAnswer();}});
  others.set(q.id,other);group.append(chips,other);groups.push(group);root.append(group);
 }
 const drawStep=()=>{
  groups.forEach((group,i)=>group.hidden=i!==step);position.textContent=`Question ${step+1} of ${questions.length}`;progress.value=step+1;
  previous.hidden=step===0;next.hidden=step===questions.length-1;submit.hidden=step!==questions.length-1;
 };
 const navigate=delta=>{step+=delta;drawStep();groups[step].querySelector("button,input")?.focus({preventScroll:true});};
 const previous=button("Back",()=>navigate(-1),"ag-text-button"),next=button("Next",()=>navigate(1),"btn lime");
 root.append(el("div",{class:"ag-question-actions"},previous,next,submit,button("You decide",()=>send(true),"ag-text-button")));
 drawStep();
 return root;
}
