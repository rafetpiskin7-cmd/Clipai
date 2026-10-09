import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { run } from "../services/shell.js";
import type { AIAnalysisProvider, ClipMode, ClipPlan, Segment, Transcript, TranscriptionProvider, VideoMeta, Word } from "./types.js";

const CHUNK_SEC = 1200; // kelime zaman damgası açıkken ses başına limit 30 dk; 20 dk'lık parçalara böleriz

export const llmTimeout = () => Number(process.env.LLM_TIMEOUT_MS) || 60000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const transient = (e: any) => /503|429|UNAVAILABLE|KULLANILAMAZ|overload|high demand|yüksek talep|RESOURCE_EXHAUSTED|fetch failed/i.test(String(e?.message ?? e));
/** Geçici hatalarda (503/429/aşırı yük) artan bekleme ile yeniden dener. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  const base = Number(process.env.RETRY_BASE_MS) || 4000;
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (!transient(e) || i === tries - 1) break; await sleep(base * 2 ** i); }
  }
  throw last;
}

const sec = (v: unknown) => parseFloat(String(v ?? "0").replace("s", "")) || 0;

/** Kelime listesini cümle/duraklama sınırlarında segmentlere böler. Saf fonksiyon, test edilebilir. */
export function wordsToSegments(words: Word[]): Segment[] {
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map(w => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const gap = words[i + 1] ? words[i + 1].start - w.end : 0;
    if (/[.?!…]$/.test(w.text) || gap > 0.8 || w.end - cur[0].start > 12) flush();
  });
  flush();
  return out;
}

/** API cevabındaki kelime anotasyonlarını çıkarır (parts[].audioTranscription.words). */
export function extractWords(resp: any, offset: number): Word[] {
  const words: Word[] = [];
  for (const c of resp?.candidates ?? [])
    for (const part of c?.content?.parts ?? [])
      for (const w of part?.audioTranscription?.words ?? [])
        if (w?.word) words.push({ text: String(w.word).trim(), start: offset + sec(w.startOffset), end: offset + sec(w.endOffset) });
  return words;
}

async function uploadAudio(ai: GoogleGenAI, file: string) {
  let f = await ai.files.upload({ file, config: { mimeType: "audio/mp3" } });
  while (f.state === "PROCESSING" && f.name) {
    await new Promise(r => setTimeout(r, 2000));
    f = await ai.files.get({ name: f.name });
  }
  if (f.state === "FAILED") throw new Error("Gemini ses dosyasını işleyemedi.");
  return f;
}

/** SDK yeni alanları (audioTranscriptionConfig) silebildiği için isteği doğrudan REST ile atıyoruz. */
export async function callTranscribe(fileUri: string, mimeType: string): Promise<any> {
  const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const model = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-transcribe";
  const r = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST", signal: AbortSignal.timeout(Number(process.env.STT_TIMEOUT_MS) || 300000),
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY || "", "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ fileData: { fileUri, mimeType } }] }],
      generationConfig: { audioTranscriptionConfig: { wordTimestamp: true } },
    }),
  });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export class GeminiTranscription implements TranscriptionProvider {
  private ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  async transcribe(audioPath: string): Promise<Transcript> {
    const dir = path.dirname(audioPath);
    await run("ffmpeg", ["-y", "-i", audioPath, "-f", "segment", "-segment_time", String(CHUNK_SEC), "-c", "copy", path.join(dir, "chunk%03d.mp3")]);
    const chunks = (await fs.readdir(dir)).filter(f => /^chunk\d+\.mp3$/.test(f)).sort();
    const all: Word[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const up = await withRetry(() => uploadAudio(this.ai, path.join(dir, chunks[i])));
      const resp = await withRetry(() => callTranscribe(up.uri!, up.mimeType!));
      const got = extractWords(resp, i * CHUNK_SEC);
      if (!got.length) throw new Error("Gemini kelime zaman damgası döndürmedi. Cevap: " + JSON.stringify(resp).slice(0, 400));
      all.push(...got);
      if (up.name) await this.ai.files.delete({ name: up.name }).catch(() => {});
    }
    if (!all.length) throw new Error("Gemini kelime zaman damgası döndürmedi.");
    return { language: "auto", segments: wordsToSegments(all) };
  }
}

function montagePrompt(title: string, lines: string, minS: number, maxS: number, maxClips: number): string {
  return `Aşağıda "${title}" videosunun zaman damgalı transkripti var (saniye cinsinden). Transkript sadece konuşmadır; sessiz görsel anlar görünmez, bu yüzden yorumcunun heyecanlandığı yerleri (bağırma, "inanılmaz", sıra/numara duyurusu, vurgu, tepki) ipucu say.
Amaç: videonun EN ÖNEMLİ ve EN ETKİLİ anlarını seçip tek bir kısa videoda art arda birleştirmek (özet / highlight kurgusu). Tek bir yerden uzun parça KESME.
En fazla ${maxClips} kısa video öner. Her kısa video 4-10 PARÇADAN oluşsun; her parça 3-8 saniye; parçaların TOPLAM süresi ${minS}-${maxS} saniye olsun.
Her parça kendi içinde anlaşılır olsun, cümle veya an ortasında kesilmesin. Parçaları videodaki sırayla ver (start artan sırada).
Her parçaya kısa bir "label" yaz: videoda sıralama/numara varsa (ör. "en iyi 10": 10, 9, 8...) o numarayı, yoksa 1, 2, 3... sırasını yaz.
Başlık/hook/açıklama transkriptin dilinde olsun.
SADECE JSON dizisi döndür:
[{"title":"","viralScore":0-100,"hook":"","reason":"","description":"","hashtags":["#..."],"segments":[{"start":0,"end":0,"label":"1"}]}]

TRANSKRİPT:
${lines}`;
}

export function analysisPrompt(t: Transcript, meta: VideoMeta, mode: ClipMode = "single"): string {
  const minS = Number(process.env.CLIP_MIN_SEC) || 40, maxS = Number(process.env.CLIP_MAX_SEC) || 50, maxClips = Number(process.env.MAX_CLIPS) || 5;
  const lines = t.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
  if (mode === "montage") return montagePrompt(meta.title, lines, minS, maxS, maxClips);
  return `Aşağıda "${meta.title}" videosunun zaman damgalı transkripti var (saniye cinsinden).
Videoyu sabit aralıklarla bölme. Kendi başına anlamlı, en fazla ${maxClips} klip seç. HER KLİP ${minS} ile ${maxS} saniye arasında olmalı (end - start en az ${minS}, en fazla ${maxS}); daha kısa veya daha uzun klip verme. Cümle ortasında kesme.
Ölçütler: güçlü giriş, şaşırtıcı bilgi, duygusal an, tartışmalı ifade, faydalı bilgi, komik an, hikaye doruğu, merak, güçlü son.
Klip kancadan hemen önce başlasın, sonuçtan sonra bitsin. Başlık/hook/açıklama transkriptin dilinde olsun.
SADECE JSON dizisi döndür:
[{"title":"","start":0,"end":0,"viralScore":0-100,"hook":"","reason":"","description":"","hashtags":["#..."]}]

TRANSKRİPT:
${lines}`;
}

const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-2.5-flash"];

export class GeminiAnalysis implements AIAnalysisProvider {
  private ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  /** Önce GEMINI_ANALYSIS_MODEL (virgülle birden fazla olabilir), sonra yedek modeller. */
  async findClips(t: Transcript, meta: VideoMeta, mode: ClipMode = "single"): Promise<ClipPlan[]> {
    const wanted = (process.env.GEMINI_ANALYSIS_MODEL || "").split(",").map(x => x.trim()).filter(Boolean);
    const models = [...new Set([...wanted, ...FALLBACK_MODELS])];
    let last: any;
    const deadline = Date.now() + (Number(process.env.ANALYSIS_BUDGET_MS) || 120000);
    for (const model of models) {
      if (Date.now() > deadline) break;
      try {
        const res = await withRetry(() => this.ai.models.generateContent({
          model, contents: analysisPrompt(t, meta, mode), config: { responseMimeType: "application/json", httpOptions: { timeout: llmTimeout() } },
        }), 2);
        const m = (res.text ?? "").match(/\[[\s\S]*\]/);
        if (!m) throw new Error("Gemini geçerli JSON döndürmedi.");
        return JSON.parse(m[0]) as ClipPlan[];
      } catch (e) { last = e; }
    }
    throw new Error(`Gemini analiz başarısız (denenen: ${models.join(", ")}): ${String((last as any)?.message ?? last).slice(0, 300)}`);
  }
}
