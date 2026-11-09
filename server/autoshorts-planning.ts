// The model needs to SEE the wire format: a sampling grammar alone is not an instruction.
export function planningConstraints(topic:string) {
  const names:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
  const match=topic.match(/\bexactly\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:consecutive|separate|distinct|cinematic|\d+[- ]second)\s+){0,4}(?:shots?|scenes?)\b/i);
  const count=match?(names[match[1].toLowerCase()]||Number(match[1])):undefined;
  return {count:count&&count<=40?count:undefined,
    noNarration:/\bno\s+(?:(?:external|off-screen)\s+)?(?:narrator|narration|voice[- ]?over)\b(?!\s+(?:in|for|during|until|except|unless|on)\b)/i.test(topic),
    noDialogue:/\bno\s+(?:(?:spoken|character)\s+)?(?:dialogue|speech)\b(?!\s+(?:in|for|during|until|except|unless|on)\b)/i.test(topic),
    noMusic:/\bno\s+(?:background\s+)?music\b(?!\s+(?:in|for|during|until|except|unless|on)\b)/i.test(topic)};
}

export function planningExample(imageEngine:string,videoEngine:string,cinema:boolean) {
  const example:any={title:"Film title",hook:"Visual opening beat; not necessarily spoken",narration:"",closing:"Visual closing beat; not necessarily spoken",music:"",scenes:[{
    id:"shot_1",order:1,duration:5,narration:"",visual:"Full independent shot description",prompt:"Full character, vehicle if present, setting, lighting and action descriptions",
    engine:cinema?videoEngine:imageEngine,method:cinema?"video":"image",references:[],instructions:"Camera, action and sound instructions",
  }]};
  if(cinema){
    example.visualBible={style:"The requested visual style",timeOfDay:"night",lighting:"The requested lighting",
      entities:[{id:"character_1",kind:"character",description:"Full canonical appearance, age, wardrobe and distinguishing features",traits:{wardrobe:"Complete wardrobe description"},reference:"",approved:false},
        {id:"vehicle_1",kind:"vehicle",description:"Full canonical body, model, color, wheels and distinguishing features",traits:{color:"red"},reference:"",approved:false},
        {id:"setting_1",kind:"setting",description:"Full canonical location and time description",traits:{},reference:"",approved:false}]};
    Object.assign(example.scenes[0],{continuity:{entityIds:["character_1","vehicle_1","setting_1"],settingId:"setting_1",timeOfDay:"night",lighting:"Same canonical lighting",
      counts:{character_1:1,vehicle_1:1,setting_1:1},transition:false,notes:"Explicit starting state and ending state of this shot"},dialogue:"",dialogueLines:[],speechMode:"native",
      direction:{framing:"Medium shot",camera:"Slow small dolly inward",action:"One manageable action, in causal order",startState:"Exact opening pose and prop ownership",endState:"Exact ending pose and prop ownership",emotion:"Observable emotional reaction",soundscape:"Location ambience and physical sounds, no repeated dialogue",music:""}});
  }
  return example;
}
