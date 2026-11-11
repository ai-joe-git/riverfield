import {test} from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Browser modules are plain JavaScript, tested here without a DOM.
import {parseChoiceQuestions,choiceReply} from "../web/js/agent-questions.js";
import {parseQuestions} from "../server/production.ts";

const questionnaire=`Here are your production choices:

**1. Format / Platform**
- Vertical micro-drama (9:16, ~1 min per episode)
- Horizontal short (16:9, YouTube)

**2. Genre / Style**
- Gritty drama (think *Black Mirror*)
- Comedy / satire
- Other (you describe)

**3. Video Engine**
- **Pika Studio Director** — native video and sound
- **Another engine** — an existing alternative

Reply with your picks for each numbered item (e.g. "1b, 2a, 3a"), or add free text.`;

test("an explicit prose questionnaire becomes the same interactive question shape as ask_user",()=>{
 const questions=parseChoiceQuestions(questionnaire);
 assert.equal(questions.length,3);assert.doesNotThrow(()=>parseQuestions({questions}));
 assert.equal(questions[0].header,"Format / Platform");assert.equal(questions[1].options[0].label,"Gritty drama (think Black Mirror)");
 assert.deepEqual(questions[2].options[0],{label:"Pika Studio Director",description:"native video and sound"});
});
test("ordinary lists, scripts and incomplete or ambiguous questionnaires remain text",()=>{
 for(const text of ["1. Tasks\n- Generate references\n- Review output",questionnaire.replace("Reply with your picks","The plan is ready"),questionnaire+"\n```sh\nrun_app\n```",questionnaire.replace("- Comedy / satire\n- Other (you describe)",""),questionnaire.replace("**2. Genre / Style**","**1. Genre / Style**")])assert.deepEqual(parseChoiceQuestions(text),[]);
});
test("selected labels and free text are sent as answers, never as generation permission",()=>{
 const questions=parseChoiceQuestions(questionnaire),reply=choiceReply(questions,{answers:{"choice-1":[questions[0].options[1].label],"choice-2":["Comedy / satire"]},notes:"Language: French"});
 assert.match(reply,/Format \/ Platform: Horizontal short/);assert.match(reply,/Genre \/ Style: Comedy \/ satire/);assert.match(reply,/Language: French/);assert.match(reply,/do not authorize generation/);assert.doesNotMatch(reply,/1b/);
 assert.match(choiceReply(questions,{skip:true}),/do not generate anything yet/);
});
test("French numbered choices and custom-answer options are preserved",()=>{
 const questions=parseChoiceQuestions("### 1. Langue\n- Français\n- Autre (à préciser)\nRépondez avec vos choix.");
 assert.equal(questions.length,1);assert.equal(questions[0].options[0].label,"Français");assert.equal(questions[0].options[1].label,"Autre (à préciser)");
});
