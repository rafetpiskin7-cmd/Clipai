import fs from "node:fs/promises";
import path from "node:path";
import { run } from "./shell.js";
import { AssCaptionRenderer } from "./captions.js";
import type { CaptionStyle, ClipPlan, CropStrategy, Transcript, Word } from "../providers/types.js";

/** Varsayılan strateji: ortadan 9:16 kırpma. Yüz/konuşmacı takibi için bu arayüzü uygula. */
export class CenterCrop implements CropStrategy {
  filter(w: number, h: number): string {
    if (h >= w) return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
    return "crop=trunc(ih*9/16/2)*2:ih,scale=1080:1920";
  }
}

export async function probeSize(file: string): Promise<{ w: number; h: number }> {
  const o = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = o.trim().split(",").map(Number);
  return { w, h };
}

export function snapToWords(plan: ClipPlan, t: Transcript, duration: number): ClipPlan {
  const ws = t.segments.flatMap(s => s.words);
  const near = (x: number, key: "start" | "end") => ws.length ? ws.reduce((a, b) => Math.abs(b[key] - x) < Math.abs(a[key] - x) ? b : a)[key] : x;
  const start = Math.max(0, near(plan.start, "start") - 0.25);
  const end = Math.min(duration, near(plan.end, "end") + 0.4);
  return { ...plan, start, end };
}


/** Klibi kelime sınırlarında, tercihen cümle sonunda, CLIP_MIN_SEC–CLIP_MAX_SEC (varsayılan 40–50 sn) aralığına oturtur. */
export function fitClip(plan: ClipPlan, t: Transcript, duration: number,
  minSec = Number(process.env.CLIP_MIN_SEC) || 40, maxSec = Number(process.env.CLIP_MAX_SEC) || 50): ClipPlan {
  const PAD_S = 0.25, PAD_E = 0.4;
  const ws = t.segments.flatMap(s => s.words);
  if (!ws.length) return { ...plan, end: Math.min(duration, plan.start + maxSec) };
  const first = ws.reduce((a, b) => Math.abs(b.start - plan.start) < Math.abs(a.start - plan.start) ? b : a);
  const s0 = first.start, maxSpan = maxSec - PAD_S - PAD_E, minSpan = minSec - PAD_S - PAD_E;
  const cands = ws.filter(w => w.end > s0 && w.end - s0 <= maxSpan);
  if (!cands.length) return snapToWords(plan, t, duration);
  const segEnds = new Set(t.segments.map(s => s.words[s.words.length - 1]?.end));
  const isEnd = (w: Word) => segEnds.has(w.end) || /[.?!…]["')»]?$/.test(w.text.trim());
  const inRange = cands.filter(w => w.end - s0 >= minSpan);
  let endW: Word;
  if (inRange.length) {
    const sent = inRange.filter(isEnd), pool = sent.length ? sent : inRange;
    endW = pool.reduce((a, b) => Math.abs(b.end - plan.end) < Math.abs(a.end - plan.end) ? b : a);
  } else endW = cands[cands.length - 1];
  let start = Math.max(0, s0 - PAD_S);
  const end = Math.min(duration, endW.end + PAD_E);
  if (end - start < minSec - 0.5) { // videonun sonuna yakın: başlangıcı cümle başına doğru geri çek
    const target = end - (minSec + maxSec) / 2;
    const starts = t.segments.map(s => s.words[0]?.start).filter((x): x is number => x !== undefined && x <= s0 && end - (x - PAD_S) <= maxSec);
    if (starts.length) start = Math.max(0, starts.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a) - PAD_S);
  }
  return { ...plan, start, end };
}

export async function renderClip(opts: {
  source: string; outDir: string; name: string; plan: ClipPlan; transcript: Transcript;
  style: CaptionStyle; crop?: CropStrategy;
}): Promise<string> {
  const { source, outDir, name, plan, transcript, style } = opts;
  const { w, h } = await probeSize(source);
  const words: Word[] = transcript.segments.flatMap(s => s.words)
    .filter(x => x.start >= plan.start - 0.01 && x.end <= plan.end + 0.01)
    .map(x => ({ ...x, start: Math.max(0, x.start - plan.start), end: x.end - plan.start }));
  let vf = (opts.crop ?? new CenterCrop()).filter(w, h, plan.start, plan.end);
  if (style.enabled !== false && words.length) {
    await fs.writeFile(path.join(outDir, `${name}.ass`), new AssCaptionRenderer().toAss(words, style));
    vf += `,ass=${name}.ass`;
  }
  const out = `${name}.mp4`;
  await run("ffmpeg", ["-y", "-ss", plan.start.toFixed(2), "-t", (plan.end - plan.start).toFixed(2), "-i", source,
    "-vf", vf, "-c:v", "libx264", "-preset", process.env.FFMPEG_PRESET || "ultrafast", "-crf", process.env.FFMPEG_CRF || "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out], outDir);
  return out;
}
