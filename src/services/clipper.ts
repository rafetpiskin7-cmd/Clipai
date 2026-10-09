import fs from "node:fs/promises";
import path from "node:path";
import { run } from "./shell.js";
import { AssCaptionRenderer } from "./captions.js";
import type { CaptionStyle, ClipPart, ClipPlan, CropStrategy, Transcript, Word } from "../providers/types.js";

/** Varsayılan strateji: ortadan 9:16 kırpma. Yüz/konuşmacı takibi için bu arayüzü uygula. */
export class CenterCrop implements CropStrategy {
  filter(w: number, h: number): string {
    const H = Number(process.env.OUTPUT_HEIGHT) || 1280, W = Math.round(H * 9 / 16 / 2) * 2; // varsayılan 720x1280 (hızlı); 1080x1920 için OUTPUT_HEIGHT=1920
    if (h >= w) return `scale=${W}:${H}:flags=fast_bilinear:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    return `crop=trunc(ih*9/16/2)*2:ih,scale=${W}:${H}:flags=fast_bilinear`;
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

const sumParts = (ps: ClipPart[]) => ps.reduce((a, p) => a + (p.end - p.start), 0);

/** Montaj parçalarını kelime sınırlarına oturtur, uzun/kısa olanları düzeltir, toplamı max saniyeye sığdırır. */
export function fitMontage(plan: ClipPlan, t: Transcript, duration: number, min: number, max: number): ClipPlan | null {
  const PMIN = 2, PMAX = 10;
  let parts: ClipPart[] = (plan.segments ?? []).map(p => {
    const sn = snapToWords({ ...plan, start: p.start, end: p.end }, t, duration);
    return { start: sn.start, end: Math.min(sn.end, sn.start + PMAX), label: p.label };
  }).filter(p => p.end - p.start >= PMIN);
  const kept: ClipPart[] = [];
  for (const p of parts) if (kept.every(k => Math.min(k.end, p.end) - Math.max(k.start, p.start) < 0.5)) kept.push(p);
  parts = kept;
  if (sumParts(parts) > max) {
    const f = max / sumParts(parts);
    parts = parts.map(p => ({ ...p, end: p.start + Math.max(PMIN, (p.end - p.start) * f) }));
    while (parts.length > 2 && sumParts(parts) > max + 1) parts.pop();
  }
  if (parts.length < 2 || sumParts(parts) < Math.min(min * 0.6, 20)) return null;
  return { ...plan, segments: parts, start: Math.min(...parts.map(p => p.start)), end: Math.max(...parts.map(p => p.end)) };
}

/** Özet kurgularını hazırlar: parçaları oturtur, örtüşen kurguları eler, en yüksek puanlı `count` tanesini döndürür. */
export function pickMontages(plans: ClipPlan[], t: Transcript, duration: number, min: number, max: number, count: number): ClipPlan[] {
  const fitted = plans.map(p => fitMontage(p, t, duration, min, max)).filter((p): p is ClipPlan => !!p)
    .sort((a, b) => b.viralScore - a.viralScore);
  const shared = (a: ClipPlan, b: ClipPlan) => (a.segments ?? []).reduce((s, x) =>
    s + (b.segments ?? []).reduce((q, y) => q + Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start)), 0), 0);
  const used: ClipPlan[] = [];
  for (const p of fitted) {
    if (used.every(u => shared(p, u) < 0.4 * Math.min(sumParts(p.segments!), sumParts(u.segments!)))) used.push(p);
    if (used.length >= count) break;
  }
  return used;
}

const THR = () => process.env.FFMPEG_THREADS || "2"; // konteynerde ffmpeg host'un tüm çekirdeklerini görür; bellek için sınırla

/** Parçaları art arda birleştirip tek 9:16 video yapar; altyazıyı ve parça numaralarını (#10, #9...) videoya yakar.
 *  Her parça sırayla ayrı üretilir (aynı anda tek ffmpeg, düşük bellek), sonra yeniden kodlamadan birleştirilir. */
export async function renderMontage(opts: {
  source: string; outDir: string; name: string; plan: ClipPlan; transcript: Transcript;
  style: CaptionStyle; crop?: CropStrategy;
}): Promise<string> {
  const { source, outDir, name, plan, transcript, style } = opts;
  const parts = plan.segments!;
  const { w, h } = await probeSize(source);
  const crop = (opts.crop ?? new CenterCrop()).filter(w, h, plan.start, plan.end);
  const all = transcript.segments.flatMap(s => s.words);
  const showNum = style.numbers !== false && process.env.SHOW_NUMBERS !== "false";
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], d = p.end - p.start, pn = `${name}_p${i}`;
    const words: Word[] = all.filter(x => x.start >= p.start - 0.01 && x.end <= p.end + 0.01)
      .map(x => ({ text: x.text, start: Math.max(0, x.start - p.start), end: x.end - p.start }));
    const caps = style.enabled !== false && words.length > 0;
    const labels = showNum ? [{ start: 0, end: d, text: p.label ?? String(i + 1) }] : [];
    let vf = `${crop},setsar=1,fps=30`;
    if (caps || labels.length) {
      await fs.writeFile(path.join(outDir, `${pn}.ass`), new AssCaptionRenderer().toAss(caps ? words : [], style, labels));
      vf += `,ass=${pn}.ass`;
    }
    await run("ffmpeg", ["-y", "-threads", THR(), "-ss", p.start.toFixed(2), "-t", d.toFixed(2), "-i", source,
      "-vf", vf, "-threads", THR(), "-c:v", "libx264", "-preset", process.env.FFMPEG_PRESET || "ultrafast", "-crf", process.env.FFMPEG_CRF || "23",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k", `${pn}.mp4`], outDir);
    files.push(`${pn}.mp4`);
  }
  await fs.writeFile(path.join(outDir, `${name}_list.txt`), files.map(f => `file '${f}'`).join("\n"));
  const out = `${name}.mp4`;
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", `${name}_list.txt`, "-c", "copy", "-movflags", "+faststart", out], outDir);
  for (const f of files) { await fs.rm(path.join(outDir, f), { force: true }); await fs.rm(path.join(outDir, f.replace(".mp4", ".ass")), { force: true }); }
  await fs.rm(path.join(outDir, `${name}_list.txt`), { force: true });
  return out;
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
  await run("ffmpeg", ["-y", "-threads", THR(), "-ss", plan.start.toFixed(2), "-t", (plan.end - plan.start).toFixed(2), "-i", source,
    "-vf", vf, "-threads", THR(), "-c:v", "libx264", "-preset", process.env.FFMPEG_PRESET || "ultrafast", "-crf", process.env.FFMPEG_CRF || "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out], outDir);
  return out;
}
