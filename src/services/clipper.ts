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
    "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out], outDir);
  return out;
}
