import fs from "node:fs/promises";
import path from "node:path";
import { run } from "./services/shell.js";
import { renderClip, snapToWords } from "./services/clipper.js";
import type {
  AIAnalysisProvider, CaptionStyle, ClipPlan, StorageProvider, Transcript,
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
  dir: string; source?: string; transcript?: Transcript; plans: ClipPlan[];
}
export interface Deps {
  source: VideoSourceProvider; stt: TranscriptionProvider; ai: AIAnalysisProvider; storage: StorageProvider;
}

export function newJob(id: string, url: string, style: CaptionStyle, dir: string): Job {
  return { id, url, status: "running", steps: STEP_LABELS.map(label => ({ label, state: "waiting" })), clips: [], style, dir, plans: [] };
}

const toOut = (id: number, p: ClipPlan, file: string): ClipOut => ({ ...p, id, file, duration: Math.round(p.end - p.start) });

export async function runPipeline(job: Job, d: Deps) {
  const step = (i: number) => {
    if (i > 0) job.steps[i - 1].state = "done";
    if (job.steps[i]) job.steps[i].state = "active";
  };
  try {
    step(0); job.meta = await d.source.getMetadata(job.url);
    step(1); job.source = await d.source.download(job.url, job.dir);
    step(2); const audio = path.join(job.dir, "audio.mp3");
    await run("ffmpeg", ["-y", "-i", job.source, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
    step(3); job.transcript = await d.stt.transcribe(audio);
    await fs.writeFile(path.join(job.dir, "transcript.json"), JSON.stringify(job.transcript, null, 1));
    step(4);
    const raw = await d.ai.findClips(job.transcript, job.meta);
    job.plans = raw.filter(p => p.end > p.start).map(p => snapToWords(p, job.transcript!, job.meta!.duration))
      .filter(p => p.end - p.start >= 10 && p.end - p.start <= 90)
      .sort((a, b) => b.viralScore - a.viralScore).slice(0, 10);
    if (!job.plans.length) throw new Error("Uygun klip bulunamadı.");
    step(5);
    for (let i = 0; i < job.plans.length; i++) {
      const file = await renderClip({ source: job.source, outDir: job.dir, name: `clip${i + 1}`, plan: job.plans[i], transcript: job.transcript, style: job.style });
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
  const plan: ClipPlan = { ...base, start: base.start + (o.trimStart ?? 0), end: base.end - (o.trimEnd ?? 0),
    title: o.title ?? base.title, hook: o.hook ?? base.hook };
  if (plan.end - plan.start < 3) throw new Error("Klip çok kısa.");
  const file = await renderClip({ source: job.source, outDir: job.dir, name: `clip${n}`, plan, transcript: job.transcript, style: o.style ?? job.style });
  const out = toOut(n, plan, file);
  job.clips[n - 1] = out;
  return out;
}
