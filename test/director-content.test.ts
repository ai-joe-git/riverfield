import {test} from "node:test";
import assert from "node:assert/strict";
import {defaultDirectorForm,compileDirectorRun} from "../server/director-form.ts";
import {directorFieldIssues,validateDirectorContent,repairDialogueSound} from "../server/director-content.ts";
const form=()=>{const f=defaultDirectorForm();f.mode="fl2va";f.brief="A one-person quiz-show mockumentary.";f.scenario="Arthur confidently practices winning, then asks the empty room for a lifeline.";f.actors=[{name:"Arthur",description:"An accountant in a navy suit and glasses.",asset:""}];f.environment="An empty blue quiz-show set with blank screens and a physical question-mark sculpture.";f.segments[0].action="Arthur sits in the blue chair, raises his hand and waits. Static medium shot.";return f;};
test("the failed quiz-show script is blocked for labels, unbound people and text-dependent screens",()=>{
 const f=form();for(const value of ["Arthur is in Character 1. The Host stands in Environment.","Existing segment actions 3 brings the climax.","The Host leans in and whispers to the camera crew.","The audience seats are filled with blurred figures.","The first question illuminates on the massive digital screen.","Arthur reads the glowing text on the monitor."]){assert.ok(directorFieldIssues(f,"segments.0.action",value).length,value);}
 f.segments[0].action="The Host leans in to whisper to Arthur.";assert.throws(()=>compileDirectorRun({director:f} as any,"video"),/Unassigned person/);
});
test("empty seating, physical symbols, named cast and explicit exclusions are not extra actors",()=>{
 const f=form();f.environment="Rows of empty audience seats surround the host’s podium. A physical question mark glows above blank screens.";f.segments[0].action='Arthur lifts the "Phone a Friend" receiver and waits in silence. No audience or camera crew. Static medium shot.';assert.doesNotThrow(()=>validateDirectorContent(f));
 f.actors.push({name:"The Host",description:"An elderly woman in a red jacket.",asset:""});f.segments[0].action="The Host watches Arthur press a button. Static medium shot.";assert.doesNotThrow(()=>validateDirectorContent(f));
});
test("a role word in apposition to a configured name is not an extra person",()=>{
 const f=form();f.actors=[{name:"Arthur",description:"A nervous man in a sweater vest.",asset:""},{name:"Beatrice",description:"A woman with a clipboard.",asset:""},{name:"Silas",description:"An elderly janitor.",asset:""}];
 f.scenario="Arthur waits at the table. Their friend, Silas, stands by the fridge. Beatrice, their friend, watches.";
 assert.doesNotThrow(()=>validateDirectorContent(f));
 f.scenario="Arthur waits at the table with his friend.";
 assert.throws(()=>validateDirectorContent(f),/Unassigned person/);
});
test("native beats reject lengthy actions, sound essays and overlong dialogue",()=>{
 const f=form();assert.ok(directorFieldIssues(f,"segments.0.action",Array(71).fill("motion").join(" ")).length);assert.ok(directorFieldIssues(f,"segments.0.sound",Array(46).fill("sound").join(" ")).length);assert.ok(directorFieldIssues(f,"segments.0.dialogue.0","one two three four five six seven eight nine").length);assert.equal(directorFieldIssues(f,"segments.0.dialogue.0","SILENT").length,0);
});
test("compiled video locks person count, set continuity and non-text displays without repeating the action",()=>{
 const f=form(),run=compileDirectorRun({director:f} as any,"video"),prompt=JSON.parse(String(run.values.segment_windows)).windows[0].prompt;assert.match(prompt,/Exactly 1 distinct person: Arthur/);assert.match(prompt,/No other people, audience or camera crew/);assert.match(prompt,/Screens stay blank or abstract/);assert.equal(prompt.split(f.segments[0].action).length-1,1);
});
test("stray native dialogue tags are rejected in visual/sound text before dispatch",()=>{
 const f=form();assert.ok(directorFieldIssues(f,"segments.0.sound","Room tone. <d>[English] Hi.</d>").some(i=>/dialogue tags/.test(i.message)));
 assert.equal(directorFieldIssues(f,"scenario","Arthur says, <d>[English] Hi.</d>").some(i=>/dialogue tags/.test(i.message)),false);
 f.segments[0].sound="Room tone. <d>[English] Hi.</d>";assert.throws(()=>compileDirectorRun({director:f} as any,"video"),/dialogue tags/);
});
test("a silent sound field on a spoken beat is repaired deterministically",()=>{
 const f=form();f.segments[0].dialogue[0]="That was my favorite mug.";
 const repaired=repairDialogueSound(f,"segments.0.sound","A heavy, awkward silence fills the kitchen.");assert.ok(repaired);assert.match(repaired,/Live on-camera speech/);
 assert.equal(repairDialogueSound(f,"segments.0.sound","Quiet kitchen room tone."),null);
 assert.equal(repairDialogueSound(f,"segments.0.action","A heavy, awkward silence."),null);
 f.segments[0].dialogue[0]="";
 assert.equal(repairDialogueSound(f,"segments.0.sound","A heavy, awkward silence fills the kitchen."),null);
});
test("spoken lines cannot hide in the visual action or a silent sound field",()=>{
 const f=form();f.actors[0].name="Clara";f.segments[0].action="[Visual Directions] Static medium shot. Clara stays in the doorway. [Dialogue] Clara: That was my favorite mug.";assert.ok(directorFieldIssues(f,"segments.0.action",f.segments[0].action).some(i=>/dialogue slot|leaked/i.test(i.message)));
 f.segments[0].dialogue[0]="That was my favorite mug.";assert.ok(directorFieldIssues(f,"segments.0.action",f.segments[0].action).some(i=>/dialogue slot/i.test(i.message)));assert.ok(directorFieldIssues(f,"segments.0.sound","A heavy, awkward silence fills the kitchen; only breathing remains.").some(i=>/contradicts the spoken line/i.test(i.message)));
 f.segments[0].action="Clara looks at the camera, holding the broken mug.";f.segments[0].sound="Quiet kitchen room tone.";assert.doesNotThrow(()=>validateDirectorContent(f));
 const prompt=JSON.parse(String(compileDirectorRun({director:f} as any,"video").values.segment_windows)).windows[0].prompt;assert.match(prompt,/<d>\[English\] That was my favorite mug\.<\/d>/);assert.match(prompt,/Clara \(S1\) says/);assert.match(prompt,/on camera with face and mouth clearly visible/);assert.doesNotMatch(prompt,/The spoken line is live on-camera speech/);
});
