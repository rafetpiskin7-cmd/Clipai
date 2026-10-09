import fs from "node:fs/promises";
import path from "node:path";
import { run } from "./services/shell.js";
import { fitClip, pickMontages, renderClip, renderMontage } from "./services/clipper.js";
import type {
  AIAnalysisProvider, CaptionStyle, ClipMode, ClipPlan, StorageProvider, Transcript,
  TranscriptionProvider, VideoMeta, VideoSourceProvider,
} from "./providers/types.js";

export const STEP_LABELS = [
  "URL doğrulanıyor ve video bilgileri alınıyor", "Video indiriliyor", "Ses çıkarılıyor",
  "Transkript oluşturuluyor", "İçerik yapay zekâ ile analiz ediliyor",
  "Klipler kesiliyor, 9:16 kırpılıyor, altyazılar işleniyor", "Tamamlanıyor",
];

export interface ClipOut extends ClipPlan { id: number; file: string; duration: number }
export interface Job {
  id: string; url: string; status: "running" | "done" | "error"; error?: string;
  steps: { label: string; state: "waiting" | "active" | "done" }[];
  meta?: VideoMeta; clips: ClipOut[]; style: CaptionStyle;
  dir: string; source?: string; transcript?: Transcript; plans: ClipPlan[]; src?: VideoSourceProvider; mode?: ClipMode;
}
export interface Deps {
  source: VideoSourceProvider; stt: TranscriptionProvider; ai: AIAnalysisProvider; storage: StorageProvider;
}

/** Birbirinin üstüne binen (5 sn'den fazla) klipleri eler; puanı yüksek olan kalır. */
function dropOverlaps(ps: ClipPlan[]): ClipPlan[] {
  const out: ClipPlan[] = [];
  for (const p of ps) if (out.every(q => Math.min(p.end, q.end) - Math.max(p.start, q.start) < 5)) out.push(p);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} ${Math.round(ms / 1000)} saniyede bitmedi (zaman aşımı).`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export function newJob(id: string, url: string, style: CaptionStyle, dir: string): Job {
  return { id, url, status: "running", steps: STEP_LABELS.map(label => ({ label, state: "waiting" })), clips: [], style, dir, plans: [] };
}

const planSeconds = (p: ClipPlan) => p.segments?.length ? p.segments.reduce((a, x) => a + (x.end - x.start), 0) : p.end - p.start;
const toOut = (id: number, p: ClipPlan, file: string): ClipOut => ({ ...p, id, file, duration: Math.round(planSeconds(p)) });

const renderPlan = (job: Job, name: string, plan: ClipPlan, style: CaptionStyle) =>
  (plan.segments?.length ? renderMontage : renderClip)({ source: job.source!, outDir: job.dir, name, plan, transcript: job.transcript!, style });

export async function runPipeline(job: Job, d: Deps) {
  const step = (i: number) => {
    if (i > 0) job.steps[i - 1].state = "done";
    if (job.steps[i]) job.steps[i].state = "active";
    console.log(`[${job.id.slice(0, 8)}] adım ${i + 1}/${STEP_LABELS.length}: ${STEP_LABELS[i]}`);
  };
  try {
    const src = job.src ?? d.source;
    step(0); job.meta = await src.getMetadata(job.url);
    step(1); job.source = await src.download(job.url, job.dir);
    step(2); const audio = path.join(job.dir, "audio.mp3");
    await run("ffmpeg", ["-y", "-i", job.source, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
    step(3); job.transcript = await d.stt.transcribe(audio);
    await fs.writeFile(path.join(job.dir, "transcript.json"), JSON.stringify(job.transcript, null, 1));
    step(4);
    const mode: ClipMode = job.mode ?? (process.env.CLIP_MODE === "single" ? "single" : "montage");
    const raw = await withTimeout(d.ai.findClips(job.transcript, job.meta, mode), Number(process.env.ANALYSIS_TIMEOUT_MS) || 240000, "Klip analizi");
    const dur = job.meta.duration, transcript = job.transcript, count = Number(process.env.MAX_CLIPS) || 3;
    const minS = Number(process.env.CLIP_MIN_SEC) || 40, maxS = Number(process.env.CLIP_MAX_SEC) || 50;
    const singles = () => {
      const fitted = raw.filter(c => Number(c.end) > Number(c.start)).map(c => fitClip(c, transcript, dur))
        .filter(c => c.end - c.start >= Math.min(15, dur * 0.5)).sort((x, y) => y.viralScore - x.viralScore);
      return dropOverlaps(fitted).slice(0, count).map(({ segments, ...rest }) => rest as ClipPlan);
    };
    if (mode === "montage") {
      job.plans = pickMontages(raw, transcript, dur, minS, maxS, count);
      if (!job.plans.length) { console.log(`[${job.id.slice(0, 8)}] özet kurgu çıkmadı, tek anlık klibe geçiliyor`); job.plans = singles(); }
    } else job.plans = singles();
    if (!job.plans.length) throw new Error("Uygun klip bulunamadı.");
    step(5);
    for (let i = 0; i < job.plans.length; i++) {
      const file = await renderPlan(job, `clip${i + 1}`, job.plans[i], job.style);
      job.clips.push(toOut(i + 1, job.plans[i], file));
    }
    step(6); job.steps[6].state = "done"; job.status = "done";
  } catch (e: any) {
    job.status = "error"; job.error = e?.message ?? String(e);
  }
}

/** Editörden gelen kırpma/stil değişikliğiyle tek klibi yeniden üretir. */
export async function rerender(job: Job, n: number, o: { trimStart?: number; trimEnd?: number; style?: CaptionStyle; title?: string; hook?: string }) {
  const base = job.plans[n - 1];
  if (!base || !job.source || !job.transcript) throw new Error("Klip bulunamadı.");
  let plan: ClipPlan = { ...base, start: base.start + (o.trimStart ?? 0), end: base.end - (o.trimEnd ?? 0),
    title: o.title ?? base.title, hook: o.hook ?? base.hook };
  if (base.segments?.length) { // özet kurgu: kırpma ilk parçanın başına ve son parçanın sonuna uygulanır
    const segs = base.segments.map(x => ({ ...x })), last = segs.length - 1;
    segs[0].start = Math.min(segs[0].start + (o.trimStart ?? 0), segs[0].end - 1);
    segs[last].end = Math.max(segs[last].end - (o.trimEnd ?? 0), segs[last].start + 1);
    plan = { ...plan, segments: segs };
  } else if (plan.end - plan.start < 3) throw new Error("Klip çok kısa.");
  const file = await renderPlan(job, `clip${n}`, plan, o.style ?? job.style);
  const out = toOut(n, plan, file);
  job.clips[n - 1] = out;
  return out;
}
