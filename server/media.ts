// Generic, bounded CPU utilities. No scene/storyboard/project orchestration or raw shell/filters.
import {spawn} from "node:child_process";
import {mkdirSync,readFileSync,existsSync} from "node:fs";
import {join,resolve,extname,relative} from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {within,atomic,identifier} from "./agent-store.ts";
export async function command(exe:string,args:string[],signal?:AbortSignal){return new Promise<string>((yes,no)=>{
  const child=spawn(exe,args,{stdio:["ignore","pipe","pipe"],signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});let out="",error="";
  child.stdout.on("data",b=>out=(out+b).slice(-1000000));child.stderr.on("data",b=>error=(error+b).slice(-4000));child.on("error",no);child.on("close",code=>code===0?yes(out):no(new Error(`${exe} failed: ${error}`)));
});}
const FORMATS="mov,matroska,webm,mp3,wav,flac,ogg,png_pipe,jpeg_pipe,webp_pipe";
const input=(path:string)=>["-protocol_whitelist","file,pipe","-format_whitelist",FORMATS,"-i",path];
export async function probe(path:string){const d=JSON.parse(await command("ffprobe",["-v","error",...input(path),"-show_streams","-show_format","-of","json"]));const v=d.streams?.find((s:any)=>s.codec_type==="video");return {width:v?.width||0,height:v?.height||0,duration:Number(d.format?.duration)||0,audio:!!d.streams?.some((s:any)=>s.codec_type==="audio"),format:d.format?.format_name};}
export const mediaSchema=z.object({operation:z.enum(["probe","frame","audio","concat","mix"]),path:z.string().optional(),paths:z.array(z.string()).max(8).optional(),seconds:z.number().min(0).max(36000).default(0),volumes:z.array(z.number().min(0).max(2)).max(4).optional()});
export class MediaTools {
  out:string;root:string;
  constructor(out:string,root:string){this.out=out;this.root=root;}
  permitted(path:string){
    if(!/\.(png|jpe?g|webp|mp4|webm|mov|mkv|wav|mp3|flac|ogg|m4a)$/i.test(path))throw new Error("Unsupported media format");
    for(const base of [join(this.out,"history"),join(this.out,"media"),join(this.root,"web/examples")])try{const actual=within(base,path);if(base.endsWith("examples"))return actual;
      const parts=relative(base,actual).split(/[\\/]/),m=JSON.parse(readFileSync(join(base,parts[0],"meta.json"),"utf8"));if(parts.length===2&&[...(m.inputs||[]),...(m.outputs||[])].some((v:any)=>v.file===parts[1]))return actual;
    }catch{}
    try{const actual=within(join(this.out,"agent/conversations"),path),parts=relative(join(this.out,"agent/conversations"),actual).split(/[\\/]/);if(parts.length===3&&parts[1]==="uploads")return actual;}catch{}
    throw new Error("Media path is outside permitted uploads, History, examples or generated media");
  }
  file(id:string,name:string){const dir=join(this.out,"media",identifier(id)),meta=JSON.parse(readFileSync(join(dir,"meta.json"),"utf8"));if(!meta.outputs.some((o:any)=>o.file===name))throw new Error("Unknown media output");return within(dir,name);}
  async run(raw:unknown){const v=mediaSchema.parse(raw),paths=(v.paths||[v.path]).filter((x):x is string=>!!x).map(p=>this.permitted(p));if(!paths.length)throw new Error("Provide path or paths");
    const measured=await Promise.all(paths.map(probe));if(v.operation==="probe")return {path:paths[0],metadata:measured[0]};
    if(measured.some(m=>m.duration>120||v.operation!=="audio"&&m.width*m.height>4200000))throw new Error("Generic CPU editing is limited to 120-second inputs and 4.2 MP; use a dedicated app/external editor for larger files");
    const id=randomUUID(),dir=join(this.out,"media",id);mkdirSync(dir,{recursive:true});const name=v.operation==="frame"?"frame.png":v.operation==="audio"?"soundtrack.wav":v.operation==="mix"?"mix.wav":"export.mp4",file=join(dir,name);
    if(v.operation==="audio"){
      if(paths.length!==1||!measured[0].audio)throw new Error("Choose one video or audio file containing an audio stream");
      await command("ffmpeg",["-y",...input(paths[0]),"-map","0:a:0","-vn","-ac","1","-ar","24000","-c:a","pcm_s16le","-threads","1",file]);
    }else if(v.operation==="frame"){
      if(!measured[0].width||v.seconds>=measured[0].duration)throw new Error("Frame timestamp is outside the video");
      await command("ffmpeg",["-y","-ss",String(v.seconds),...input(paths[0]),"-frames:v","1","-threads","1",file]);
    }else if(v.operation==="concat"){
      if(measured.some(m=>!m.width)||measured.reduce((n,m)=>n+m.duration,0)>120)throw new Error("Concat needs video inputs totaling at most 120 seconds");
      const {width,height}=measured[0],filters=measured.flatMap((m,i)=>[`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,setpts=PTS-STARTPTS[v${i}]`,m.audio?`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${m.duration},asetpts=PTS-STARTPTS[a${i}]`:`anullsrc=r=48000:cl=stereo,atrim=duration=${m.duration}[a${i}]`]);
      filters.push(`${paths.map((_,i)=>`[v${i}][a${i}]`).join("")}concat=n=${paths.length}:v=1:a=1[v][a]`);
      await command("ffmpeg",["-y",...paths.flatMap(input),"-filter_complex_threads","1","-filter_complex",filters.join(";"),"-map","[v]","-map","[a]","-c:v","libx264","-threads","2","-preset","fast","-crf","20","-c:a","aac","-movflags","+faststart",file]);
    }else{
      if(paths.length>4||measured.some(m=>!m.audio))throw new Error("Mix needs 1–4 inputs with audio");const filters=paths.map((_,i)=>`[${i}:a]volume=${v.volumes?.[i]??1},aresample=48000[a${i}]`);filters.push(`${paths.map((_,i)=>`[a${i}]`).join("")}amix=inputs=${paths.length}:duration=longest:normalize=0,alimiter=limit=0.95[a]`);
      await command("ffmpeg",["-y",...paths.flatMap(input),"-filter_complex_threads","1","-filter_complex",filters.join(";"),"-map","[a]","-t","120",file]);
    }
    const output={file:name,path:resolve(file),type:v.operation==="frame"?"image":["mix","audio"].includes(v.operation)?"audio":"video",metadata:await probe(file),url:`/api/media/${id}/files/${name}`};atomic(join(dir,"meta.json"),{id,operation:v.operation,inputs:[],outputs:[output]});return {id,outputs:[output]};
  }
}
