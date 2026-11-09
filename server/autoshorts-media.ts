// CPU editing only. No shell, no network media, no user-supplied FFmpeg filters.
import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export async function command(exe: string, args: string[], signal?: AbortSignal, cwd?:string): Promise<string> {
  return new Promise((resolve, reject) => {
    // A disguised playlist must not turn a local media import into an HTTP request.
    if(exe==="ffmpeg") args=args.flatMap(arg=>arg==="-i"?["-protocol_whitelist","file,pipe","-i"]:[arg]);
    if(exe==="ffprobe") args=["-protocol_whitelist","file,pipe",...args];
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], signal, cwd });
    let out = "", err = "";
    child.stdout.on("data", b => { out = (out + b).slice(-4_000_000); });
    child.stderr.on("data", b => { err = (err + b).slice(-16000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${exe} exited ${code}: ${err}`)));
  });
}
export async function probe(file: string, signal?: AbortSignal) {
  const p = JSON.parse(await command("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], signal));
  const v = p.streams.find((s: any) => s.codec_type === "video");
  const duration = Number(p.format?.duration || 0);
  return { duration, width: v?.width || 0, height: v?.height || 0, audio: p.streams.some((s: any) => s.codec_type === "audio") };
}
export function dimensions(aspect: string, height: number) {
  const ratio = aspect === "9:16" ? 9 / 16 : aspect === "1:1" ? 1 : 16 / 9;
  // height here is the long edge for portraits, the short edge otherwise.
  return { width: Math.round(height * ratio / 2) * 2, height };
}
export function sourceDimensions(mp: number, aspect: string, multiple = 32) {
  const ratio = aspect === "9:16" ? 9 / 16 : aspect === "1:1" ? 1 : 16 / 9;
  return { width: Math.max(multiple, Math.round(Math.sqrt(mp * 1e6 * ratio) / multiple) * multiple),
    height: Math.max(multiple, Math.round(Math.sqrt(mp * 1e6 / ratio) / multiple) * multiple) };
}
export type Word = { word: string; start: number; end: number };
export function approximateWords(text: string, duration: number): Word[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.map((word, i) => ({ word, start: i * duration / words.length, end: (i + 1) * duration / words.length }));
}
const time = (n: number, ass = false) => {
  const ms = Math.round(Math.max(0, n) * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return ass ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(Math.floor(ms % 1000 / 10)).padStart(2,"0")}`
    : `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms % 1000).padStart(3,"0")}`;
};
export function captions(words: Word[], karaoke = false, width = 1080, height = 1920) {
  let srt = "", ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,${Math.round(width * .045)},&H00FFFFFF,&H0000DFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,35,35,${Math.round(height*.09)},1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  for (let i = 0; i < words.length; i += 6) {
    const group = words.slice(i,i+6), a = group[0].start, b = group.at(-1)!.end;
    const clean = (s: string) => s.replace(/[{}\\\r\n]/g, " ").replace(/-->/g,"→");
    srt += `${Math.floor(i/6)+1}\n${time(a)} --> ${time(b)}\n${group.map(w=>clean(w.word)).join(" ")}\n\n`;
    ass += `Dialogue: 0,${time(a,true)},${time(b,true)},Default,,0,0,0,,{\\fad(80,80)}${group.map(w => (karaoke ? `{\\kf${Math.max(1, Math.round((w.end-w.start)*100))}}` : "") + clean(w.word)).join(" ")}\n`;
  }
  return { srt, ass };
}
export const ASSEMBLY_VERSION = 2;
export type EditScene = { media: string; image: boolean; audio?: string; sourceAudio?:string; duration: number; trim: number; keepAudio: boolean };
export type EditOptions = { aspect: string; height: number; fps: number; fit: "crop"|"contain"; transition: number; burn: boolean; music?: string; musicVolume: number };
export function segmentArgs(s: EditScene, o: EditOptions, output: string): string[] {
  const { width:w, height:h } = dimensions(o.aspect,o.height), d = s.duration;
  const fit = o.fit === "crop" ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  const motion = s.image ? `,zoompan=z='min(max(zoom,pzoom)+0.00025,1.06)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${w}x${h}:fps=${o.fps}` : "";
  const fade = Math.min(o.transition,d/4);
  const video = `[0:v]${fit},setsar=1,fps=${o.fps}${motion},tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS,fade=t=in:d=${fade},fade=t=out:st=${d-fade}:d=${fade},format=yuv420p[v]`;
  const inputs=[...(s.audio?["-i",s.audio]:[]),...(s.keepAudio&&s.sourceAudio?["-ss",String(s.trim),"-i",s.sourceAudio]:[])];
  const source=s.sourceAudio?(s.audio?2:1):0, native=s.keepAudio&&!s.image;
  const normalize=`aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${d}`;
  const audio=s.audio&&native
    ? `[1:a]${normalize},asplit=2[n][sc];[${source}:a]${normalize}[src];[src][sc]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=250:makeup=1[duck];[n][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=true[a]`
    : s.audio?`[1:a]${normalize},alimiter=limit=0.95:level=false:latency=true[a]`
    : native?`[${source}:a]${normalize},alimiter=limit=0.95:level=false:latency=true[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a]`;
  return ["-y", "-threads","2", ...(s.image ? ["-loop","1"] : ["-ss",String(s.trim)]), "-i",s.media,...inputs,
    "-filter_complex_threads","1","-filter_complex",`${video};${audio}`,"-map","[v]","-map","[a]","-t",String(d),"-c:v","libx264","-preset","fast","-crf","20","-c:a","aac","-ar","48000","-ac","2","-r",String(o.fps),output];
}
export async function assemble(dir: string, scenes: EditScene[], o: EditOptions, signal?: AbortSignal) {
  if (!scenes.length) throw new Error("No scenes to render");
  for (let i=0;i<scenes.length;i++) {
    const file=join(dir,`segment-${i}.mp4`),marker=join(dir,`segment-${i}.done`);
    // The parent export key includes ASSEMBLY_VERSION and every edit input.
    if(existsSync(file)&&existsSync(marker))continue;
    await command("ffmpeg",segmentArgs(scenes[i],o,file),signal);
    writeFileSync(marker,"encoded");
  }
  writeFileSync(join(dir,"concat.txt"),scenes.map((_,i)=>`file 'segment-${i}.mp4'`).join("\n"));
  await command("ffmpeg",["-y","-f","concat","-safe","1","-i",join(dir,"concat.txt"),"-c","copy",join(dir,"joined.mp4")],signal);
  const duration = scenes.reduce((n,s)=>n+s.duration,0);
  const args = ["-y","-i",join(dir,"joined.mp4")];
  if(o.music) args.push("-stream_loop","-1","-i",o.music);
  const filters:string[]=[];
  if(o.music) filters.push(`[0:a]asplit=2[voice][sc];[1:a]volume=${o.musicVolume},atrim=duration=${duration}[music];[music][sc]sidechaincompress=threshold=0.03:ratio=8[duck];[voice][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=true[a]`);
  // Use a fixed relative name: arbitrary paths never enter the subtitle filter grammar.
  if(o.burn) filters.push("[0:v]ass=filename=captions.ass[v]");
  if(filters.length) args.push("-filter_complex_threads","1","-filter_complex",filters.join(";"));
  args.push("-map",o.burn?"[v]":"0:v","-map",o.music?"[a]":"0:a","-c:v",o.burn?"libx264":"copy");
  if(o.burn) args.push("-preset","fast","-crf","20");
  args.push("-c:a",o.music?"aac":"copy","-t",String(duration),"-movflags","+faststart",join(dir,"final.mp4"));
  await command("ffmpeg",args,signal,dir);
  return join(dir,"final.mp4");
}
